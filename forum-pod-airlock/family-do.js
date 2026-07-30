/**
 * FamilyDO — one Durable Object per family space, END-TO-END ENCRYPTED.
 *
 * The DO stores only ciphertext + public keys. All human-readable content
 * (post/comment/event bodies, member names, captions) is encrypted on the
 * client with a shared Family Content Key (FCK) it never sees. The FCK is
 * distributed by wrapping it to each admitted member's X25519 public key.
 *
 * Membership is admin-gated (trust-on-first-use founder = admin):
 *   - invitees join as `pending` and attach their X pubkey + a name sealed to
 *     the admin's X key (so the admin can vet them);
 *   - an admin `admits` them, which uploads the FCK wrapped to their key;
 *   - `remove` rotates to a new epoch wrapped only to the remaining members.
 *
 * Auth remains an Ed25519-signed bundle per device (see pod-signing-web.js).
 */

import { verifySignedBundle } from "./pod-signing-web.js";

const REPLAY_WINDOW_MS = 5 * 60 * 1000;
const REPLAY_CLEANUP_GRACE_MS = 60 * 1000;
const INVITE_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Group-model constants. These MIRROR forum-pod/src/config/instance.js — that
// file is the source of truth; keep these in sync. The worker is a separate
// package and cannot import the client config directly.
const LEGACY_ADMIN_ROLE = "admin"; // founder role in the founding group == steward
const GROUP_ROLES = new Set(["member", "moderator", "steward"]);
const GROUP_TYPE_RULES = {
  // county boards are the base civic tier: server-readable, top-level (no parent).
  county: { encryption_mode: "server", visibilities: new Set(["members", "public_read"]), tier: "base", parentType: null },
  // issue lobbies nest inside a county board.
  issue: { encryption_mode: "server", visibilities: new Set(["private", "members", "public_read"]), tier: "lobby", parentType: "county" },
  // community groups are private + end-to-end encrypted (family-style).
  community: { encryption_mode: "e2e", visibilities: new Set(["private", "members"]), tier: "group", parentType: null },
};
const JOIN_POLICIES = new Set(["invite", "request", "open"]);
const INSTANCE_JOIN_POLICIES = new Set(["invite", "open"]);

export class FamilyDO {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
    this.sql = state.storage.sql;
    this._ready = state.blockConcurrencyWhile(() => this.initSchema());
  }

  initSchema() {
    this.reconcileLegacySchema();
    this.createTables();
    this.migrate();
  }

  createTables() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS family_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- Phase 1 group model. A Group generalizes the original single "family".
      -- The founding community group's membership + content continue to live in
      -- the members / family_keys / posts ... tables below (back-compat, E2E).
      -- Additional groups (issue lobbies, extra communities) live here + in
      -- group_members. See forum-pod/src/config/instance.js for the source of
      -- truth on types, visibilities, join policies, and encryption modes.
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'community',        -- 'county' | 'issue' | 'community'
        parent_group_id TEXT,                          -- lobbies nest under a county board
        slug TEXT,
        enc_name TEXT,                                 -- e2e groups: encrypted name
        name TEXT,                                     -- server-mode groups: plaintext name
        visibility TEXT NOT NULL DEFAULT 'private',    -- 'private' | 'members' | 'public_read'
        join_policy TEXT NOT NULL DEFAULT 'invite',    -- 'invite' | 'request' | 'open'
        encryption_mode TEXT NOT NULL DEFAULT 'e2e',   -- 'e2e' | 'server'
        current_epoch INTEGER NOT NULL DEFAULT 1,
        founding INTEGER NOT NULL DEFAULT 0,           -- 1 = the instance's founding community group
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      -- Per-group membership. One row per (group, account) => one membership and
      -- one vote per group. Roles: member | moderator | steward.
      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL,
        member_pub TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        status TEXT NOT NULL DEFAULT 'pending',        -- 'pending' | 'active'
        joined_at TEXT NOT NULL,
        PRIMARY KEY (group_id, member_pub)
      );
      CREATE TABLE IF NOT EXISTS members (
        member_pub TEXT PRIMARY KEY,
        x_pub TEXT,
        role TEXT NOT NULL DEFAULT 'member',
        status TEXT NOT NULL DEFAULT 'pending',
        enc_name TEXT,
        name_epoch INTEGER,
        joined_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS join_requests (
        member_pub TEXT PRIMARY KEY,
        x_pub TEXT NOT NULL,
        sealed_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS family_keys (
        member_pub TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        wrapped TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (member_pub, epoch)
      );
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY, author_pub TEXT NOT NULL, epoch INTEGER NOT NULL,
        ct TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY, post_id TEXT NOT NULL, author_pub TEXT NOT NULL,
        epoch INTEGER NOT NULL, ct TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reactions (
        post_id TEXT NOT NULL, member_pub TEXT NOT NULL, emoji TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY (post_id, member_pub, emoji)
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, created_by TEXT NOT NULL, epoch INTEGER NOT NULL,
        ct TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rsvps (
        event_id TEXT NOT NULL, member_pub TEXT NOT NULL, status TEXT NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY (event_id, member_pub)
      );
      CREATE TABLE IF NOT EXISTS albums (
        id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, ct TEXT NOT NULL,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY, album_id TEXT NOT NULL, r2_key TEXT NOT NULL,
        epoch INTEGER NOT NULL, ct TEXT, author_pub TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS replay_guard (
        signature TEXT PRIMARY KEY, public_key TEXT NOT NULL, seen_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invites (
        code TEXT PRIMARY KEY, token TEXT NOT NULL, created_by TEXT NOT NULL,
        created_at TEXT NOT NULL, exp_ms INTEGER NOT NULL
      );
    `);
  }

  /**
   * Self-heal instances created under a pre-E2E schema. Early builds gave
   * `members` a `display_name TEXT NOT NULL` column (and posts/events a `body`
   * column); because CREATE TABLE IF NOT EXISTS never rebuilds an existing
   * table, those stale NOT NULL columns stick around and break inserts.
   *
   * If we detect that legacy shape AND the family has no real data yet, we drop
   * the content tables so createTables() can rebuild them cleanly. This is
   * strictly guarded by emptiness so a live family's data is never touched, and
   * it lets us keep a STABLE instance name instead of ever bumping it.
   */
  reconcileLegacySchema() {
    let legacy = false;
    try {
      const cols = this.sql.exec(`PRAGMA table_info(members)`).toArray().map((c) => c.name);
      // Pre-E2E members carried a `display_name` column (NOT NULL) that the
      // current schema dropped. Its presence marks a stale instance.
      legacy = cols.includes("display_name");
    } catch {
      legacy = false;
    }
    if (!legacy) return;

    let hasData = false;
    try {
      const founded = this.sql.exec(`SELECT 1 FROM family_meta WHERE key = 'created_at'`).toArray()[0];
      const nMembers = this.sql.exec(`SELECT COUNT(*) AS n FROM members`).toArray()[0]?.n || 0;
      hasData = !!founded || nMembers > 0;
    } catch {
      hasData = false;
    }
    if (hasData) return; // never destroy a live family's data

    for (const tbl of [
      "family_meta", "members", "join_requests", "family_keys", "posts", "comments",
      "reactions", "events", "rsvps", "albums", "photos", "replay_guard", "invites",
      "groups", "group_members",
    ]) {
      try {
        this.sql.exec(`DROP TABLE IF EXISTS ${tbl}`);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * In-place, additive schema migrations. The DO instance name is STABLE and
   * must never be versioned/bumped (doing so orphans the family's data). When
   * a future update needs a new column, add it to CREATE TABLE above (for fresh
   * instances) AND to this list (for existing instances). Duplicate-column
   * errors are expected and ignored, so this is safe to run on every boot.
   */
  migrate() {
    const additions = [
      ["members", "x_pub", "TEXT"],
      ["members", "status", "TEXT NOT NULL DEFAULT 'pending'"],
      ["members", "enc_name", "TEXT"],
      ["members", "name_epoch", "INTEGER"],
      ["members", "handle", "TEXT"], // plaintext pseudonymous handle (public civic layer)
      ["photos", "ct", "TEXT"],
      ["groups", "parent_group_id", "TEXT"], // lobbies nest under a county board
      // Future columns go here as ["table", "column", "TYPE ...DEFAULT..."].
    ];
    for (const [table, column, type] of additions) {
      try {
        this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      } catch {
        /* column already exists — expected on fresh/already-migrated schemas */
      }
    }
  }

  // ---- meta / members ----------------------------------------------------

  getMeta(k) {
    const r = this.sql.exec(`SELECT value FROM family_meta WHERE key = ?`, k).toArray()[0];
    return r ? r.value : null;
  }
  setMeta(k, v) {
    this.sql.exec(
      `INSERT INTO family_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      k, String(v)
    );
  }
  currentEpoch() {
    return Number(this.getMeta("current_epoch") || "1");
  }
  memberCount() {
    return this.sql.exec(`SELECT COUNT(*) AS n FROM members`).toArray()[0].n;
  }
  activeAdminXPubs() {
    return this.sql
      .exec(`SELECT x_pub FROM members WHERE role = 'admin' AND status = 'active' AND x_pub IS NOT NULL`)
      .toArray()
      .map((r) => r.x_pub);
  }
  getMember(pub) {
    return this.sql.exec(`SELECT * FROM members WHERE member_pub = ?`, pub).toArray()[0] || null;
  }

  // ---- groups (Phase 1) --------------------------------------------------

  foundingGroupId() {
    return this.getMeta("founding_group_id");
  }
  getGroup(id) {
    return this.sql.exec(`SELECT * FROM groups WHERE id = ?`, id).toArray()[0] || null;
  }
  getGroupMembership(groupId, pub) {
    return this.sql
      .exec(`SELECT * FROM group_members WHERE group_id = ? AND member_pub = ?`, groupId, pub)
      .toArray()[0] || null;
  }
  /** A member's effective role in a group. Founding-group membership lives in the
   *  legacy `members` table (admin => steward); other groups use group_members. */
  groupRole(group, pub) {
    if (!group) return null;
    if (group.founding) {
      const m = this.getMember(pub);
      if (!m || m.status !== "active") return null;
      // A public-signup instance account is NOT a member of the private E2E
      // founding group unless it holds a wrapped key (was admitted into it).
      const hasKey = this.sql.exec(`SELECT 1 FROM family_keys WHERE member_pub = ? LIMIT 1`, pub).toArray()[0];
      if (!hasKey) return null;
      return m.role === LEGACY_ADMIN_ROLE ? "steward" : m.role;
    }
    const gm = this.getGroupMembership(group.id, pub);
    return gm && gm.status === "active" ? gm.role : null;
  }
  isSteward(group, pub) {
    return this.groupRole(group, pub) === "steward";
  }
  isModeratorOrAbove(group, pub) {
    const r = this.groupRole(group, pub);
    return r === "steward" || r === "moderator";
  }
  /** Public view of a group (never leaks encrypted names to non-members). */
  groupInfo(group, viewerPub) {
    const role = this.groupRole(group, viewerPub);
    const isMember = !!role;
    const activeMembers = group.founding
      ? this.sql.exec(`SELECT COUNT(*) AS n FROM members WHERE status = 'active'`).toArray()[0].n
      : this.sql.exec(`SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND status = 'active'`, group.id).toArray()[0].n;
    return {
      id: group.id,
      type: group.type,
      parent_group_id: group.parent_group_id || null,
      slug: group.slug || null,
      visibility: group.visibility,
      join_policy: group.join_policy,
      encryption_mode: group.encryption_mode,
      founding: !!group.founding,
      current_epoch: group.current_epoch,
      created_at: group.created_at,
      member_count: activeMembers,
      my_role: role,
      is_member: isMember,
      // Names: server-mode groups expose plaintext; e2e groups expose ciphertext
      // (only members holding the key can read it client-side).
      name: group.encryption_mode === "server" ? group.name : null,
      enc_name: group.encryption_mode === "e2e" && group.enc_name ? JSON.parse(group.enc_name) : null,
    };
  }
  /** Ensure the instance's founding community group exists (called on PROVISION). */
  ensureFoundingGroup(founderPub, encFamilyName) {
    let gid = this.foundingGroupId();
    if (gid && this.getGroup(gid)) return gid;
    gid = uid("g");
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO groups (id, type, slug, enc_name, name, visibility, join_policy, encryption_mode, current_epoch, founding, created_by, created_at)
       VALUES (?, 'community', 'home', ?, NULL, 'private', 'invite', 'e2e', ?, 1, ?, ?)`,
      gid, encFamilyName ? JSON.stringify(encFamilyName) : null, this.currentEpoch(), founderPub, now
    );
    this.setMeta("founding_group_id", gid);
    return gid;
  }

  checkAndRecordReplay(signature, pub) {
    const now = Date.now();
    this.sql.exec(`DELETE FROM replay_guard WHERE seen_at_ms < ?`, now - REPLAY_WINDOW_MS - REPLAY_CLEANUP_GRACE_MS);
    if (this.sql.exec(`SELECT 1 FROM replay_guard WHERE signature = ?`, signature).toArray()[0]) return true;
    this.sql.exec(`INSERT INTO replay_guard (signature, public_key, seen_at_ms) VALUES (?, ?, ?)`, signature, pub, now);
    return false;
  }

  async tryJoinWithInvite(payload, joinerPub) {
    if (!payload || payload.verb !== "POST" || payload.path !== "/join") return false;
    const data = payload.data || {};
    const token = data.token;
    if (!token || !token.sig || !token.exp || !token.nonce || !token.admin_pub || !token.admin_x) return false;
    if (!data.x_pub || !data.sealed_name) return false;
    const admin = this.getMember(token.admin_pub);
    if (!admin || admin.role !== "admin") return false;
    const expMs = Date.parse(token.exp);
    if (Number.isNaN(expMs) || expMs < Date.now() || expMs - Date.now() > INVITE_MAX_TTL_MS) return false;
    const message = canonicalObj({ action: "family-invite", admin_x: token.admin_x, exp: token.exp, nonce: token.nonce });
    if (!(await verifyEd25519(token.admin_pub, token.sig, message))) return false;
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO members (member_pub, x_pub, role, status, joined_at) VALUES (?, ?, 'member', 'pending', ?)
       ON CONFLICT(member_pub) DO UPDATE SET x_pub = excluded.x_pub`,
      joinerPub, data.x_pub, now
    );
    this.sql.exec(
      `INSERT INTO join_requests (member_pub, x_pub, sealed_name, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(member_pub) DO UPDATE SET x_pub = excluded.x_pub, sealed_name = excluded.sealed_name`,
      joinerPub, data.x_pub, JSON.stringify(data.sealed_name), now
    );
    return true;
  }

  instanceJoinPolicy() {
    return this.getMeta("instance_join_policy") || "invite";
  }

  /**
   * Public signup (pilot): when the instance join policy is `open`, any device
   * may self-register as an active instance member with a PSEUDONYMOUS handle.
   * No real name, no invite, no ID. Server-readable civic layer only — this does
   * NOT grant membership in the private E2E founding group (that needs a key).
   */
  async tryRegister(payload, pub) {
    if (!payload || payload.verb !== "POST" || payload.path !== "/register") return false;
    if (this.memberCount() === 0) return false; // instance must be founded first
    if (this.instanceJoinPolicy() !== "open") return false;
    const data = payload.data || {};
    const handle = sanitizeHandle(data.handle);
    if (!handle) return false;
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO members (member_pub, x_pub, role, status, handle, joined_at) VALUES (?, ?, 'member', 'active', ?, ?)
       ON CONFLICT(member_pub) DO UPDATE SET handle = excluded.handle`,
      pub, data.x_pub || null, handle, now
    );
    return true;
  }

  // ---- fetch / auth ------------------------------------------------------

  async fetch(request) {
    await this._ready;
    if (request.method !== "POST") return jsonResp(405, { error: "use_post" });

    let bundle;
    try {
      bundle = await request.json();
    } catch {
      return jsonResp(400, { error: "invalid_json" });
    }
    const verdict = await verifySignedBundle(bundle, null);
    if (!verdict.valid) return jsonResp(401, { error: "auth_failed", reason: verdict.reason });
    const { payload, publicKeyHex } = verdict;

    if (this.checkAndRecordReplay(bundle.signature, publicKeyHex)) {
      return jsonResp(401, { error: "auth_failed", reason: "replay_detected" });
    }

    // Public: resolve a short invite code -> full token. A brand-new device is
    // not yet a member, so this must be reachable before the membership gate.
    // The token holds only public keys + a signature, never any secret.
    if (verbOf(payload) === "GET" && pathOf(payload).startsWith("/invite/")) {
      const code = normalizeCode(pathOf(payload).slice("/invite/".length));
      const row = this.sql.exec(`SELECT token, exp_ms FROM invites WHERE code = ?`, code).toArray()[0];
      if (!row) return jsonResp(404, { error: "invite_not_found" });
      if (row.exp_ms < Date.now()) {
        this.sql.exec(`DELETE FROM invites WHERE code = ?`, code);
        return jsonResp(410, { error: "invite_expired" });
      }
      return jsonResp(200, { token: JSON.parse(row.token) });
    }

    if (!this.getMember(publicKeyHex)) {
      const isFounding = this.memberCount() === 0;
      if (isFounding && payload?.verb === "PROVISION") {
        const now = new Date().toISOString();
        this.sql.exec(
          `INSERT INTO members (member_pub, x_pub, role, status, joined_at) VALUES (?, ?, 'admin', 'active', ?)`,
          publicKeyHex, (payload.data && payload.data.x_pub) || null, now
        );
        this.setMeta("created_at", now);
        this.setMeta("current_epoch", "1");
      } else if (await this.tryRegister(payload, publicKeyHex)) {
        // self-registered as an active instance member (open signup)
      } else if (await this.tryJoinWithInvite(payload, publicKeyHex)) {
        // enrolled as pending
      } else if (isFounding) {
        return jsonResp(404, { error: "family_not_created" });
      } else {
        return jsonResp(403, { error: "not_a_member" });
      }
    }
    this._me = this.getMember(publicKeyHex);

    if (!payload || typeof payload !== "object") return jsonResp(400, { error: "invalid_payload" });
    const verb = String(payload.verb || "").toUpperCase();
    const path = String(payload.path || "");
    const data = payload.data || {};
    if (!verb || !path) return jsonResp(400, { error: "missing_verb_or_path" });

    // Writes (other than joining) require an admitted, active member.
    const isWrite = verb === "POST" || verb === "PUT" || verb === "DELETE";
    const joinPaths = new Set(["/join"]);
    if (isWrite && !joinPaths.has(path) && this._me.status !== "active") {
      return jsonResp(403, { error: "not_admitted" });
    }

    try {
      const result = await this.dispatch(verb, path, data);
      return jsonResp(result.status || 200, result.body ?? {});
    } catch (e) {
      return jsonResp(500, { error: "handler_failed", reason: e?.message || String(e) });
    }
  }

  requireAdmin() {
    return this._me && this._me.role === "admin" && this._me.status === "active";
  }

  // ---- dispatch ----------------------------------------------------------

  async dispatch(verb, path, data) {
    const me = this._me;

    // ---- family / identity ----
    if (verb === "PROVISION" && path === "/") {
      const epoch = this.currentEpoch();
      if (data.enc_family_name) this.setMeta("enc_family_name", JSON.stringify(data.enc_family_name));
      if (data.x_pub) this.sql.exec(`UPDATE members SET x_pub = ? WHERE member_pub = ?`, data.x_pub, me.member_pub);
      if (data.enc_name) {
        this.sql.exec(
          `UPDATE members SET enc_name = ?, name_epoch = ? WHERE member_pub = ?`,
          JSON.stringify(data.enc_name), epoch, me.member_pub
        );
      }
      // Founder seeds the epoch-1 key wrapped to themselves.
      if (data.wrapped_self) {
        this.sql.exec(
          `INSERT INTO family_keys (member_pub, epoch, wrapped, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(member_pub, epoch) DO NOTHING`,
          me.member_pub, epoch, JSON.stringify(data.wrapped_self), new Date().toISOString()
        );
      }
      // Establish the instance's founding community group (E2E). Its membership
      // continues to be tracked by the legacy `members` table for back-compat.
      this.ensureFoundingGroup(me.member_pub, data.enc_family_name || null);
      // Instance signup policy (pilot passes 'open' for public signup).
      if (INSTANCE_JOIN_POLICIES.has(data.instance_join_policy)) {
        this.setMeta("instance_join_policy", data.instance_join_policy);
      }
      if (data.handle) this.sql.exec(`UPDATE members SET handle = ? WHERE member_pub = ?`, sanitizeHandle(data.handle), me.member_pub);
      return { status: 200, body: { ok: true, family: this.familyInfo(), me: this.getMember(me.member_pub) } };
    }
    if (verb === "GET" && path === "/family") {
      return { status: 200, body: { family: this.familyInfo(), me } };
    }
    if (verb === "GET" && path === "/instance") {
      return { status: 200, body: {
        join_policy: this.instanceJoinPolicy(),
        member_count: this.sql.exec(`SELECT COUNT(*) AS n FROM members WHERE status = 'active'`).toArray()[0].n,
        me: { member_pub: me.member_pub, role: me.role, status: me.status, handle: me.handle || null },
      } };
    }
    if (verb === "POST" && path === "/register") {
      // Reached when an already-registered member re-posts; update handle.
      if (data.handle) this.sql.exec(`UPDATE members SET handle = ? WHERE member_pub = ?`, sanitizeHandle(data.handle), me.member_pub);
      return { status: 200, body: { ok: true, me: { member_pub: me.member_pub, role: me.role, status: me.status, handle: this.getMember(me.member_pub).handle || null } } };
    }
    if (verb === "POST" && path === "/join") {
      return { status: 200, body: { ok: true, status: me.status } };
    }
    // Wrapped FCK(s) addressed to the caller.
    if (verb === "GET" && path === "/keys") {
      const rows = this.sql
        .exec(`SELECT epoch, wrapped FROM family_keys WHERE member_pub = ? ORDER BY epoch`, me.member_pub)
        .toArray()
        .map((r) => ({ epoch: r.epoch, wrapped: JSON.parse(r.wrapped) }));
      return { status: 200, body: { rows, current_epoch: this.currentEpoch() } };
    }
    if (verb === "LIST" && path === "/members") {
      const rows = this.sql
        .exec(`SELECT member_pub, x_pub, role, status, enc_name, name_epoch, joined_at FROM members ORDER BY joined_at`)
        .toArray()
        .map((m) => ({ ...m, enc_name: m.enc_name ? JSON.parse(m.enc_name) : null }));
      return { status: 200, body: { rows } };
    }

    // ---- admin: admission ----
    if (verb === "LIST" && path === "/requests") {
      if (!this.requireAdmin()) return { status: 403, body: { error: "admin_only" } };
      const rows = this.sql
        .exec(`SELECT member_pub, x_pub, sealed_name, created_at FROM join_requests ORDER BY created_at`)
        .toArray()
        .map((r) => ({ ...r, sealed_name: JSON.parse(r.sealed_name) }));
      return { status: 200, body: { rows } };
    }
    if (verb === "POST" && path === "/admit") {
      if (!this.requireAdmin()) return { status: 403, body: { error: "admin_only" } };
      const target = this.getMember(data.member_pub);
      if (!target) return { status: 404, body: { error: "no_such_member" } };
      const keys = Array.isArray(data.keys) ? data.keys : [];
      const now = new Date().toISOString();
      for (const k of keys) {
        if (!k || typeof k.epoch !== "number" || !k.wrapped) continue;
        this.sql.exec(
          `INSERT INTO family_keys (member_pub, epoch, wrapped, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(member_pub, epoch) DO UPDATE SET wrapped = excluded.wrapped`,
          data.member_pub, k.epoch, JSON.stringify(k.wrapped), now
        );
      }
      this.sql.exec(
        `UPDATE members SET status = 'active', enc_name = ?, name_epoch = ? WHERE member_pub = ?`,
        data.enc_name ? JSON.stringify(data.enc_name) : null,
        typeof data.name_epoch === "number" ? data.name_epoch : this.currentEpoch(),
        data.member_pub
      );
      this.sql.exec(`DELETE FROM join_requests WHERE member_pub = ?`, data.member_pub);
      return { status: 200, body: { ok: true } };
    }
    if (verb === "POST" && path === "/deny") {
      if (!this.requireAdmin()) return { status: 403, body: { error: "admin_only" } };
      const target = this.getMember(data.member_pub);
      if (target && target.status === "pending") this.sql.exec(`DELETE FROM members WHERE member_pub = ?`, data.member_pub);
      this.sql.exec(`DELETE FROM join_requests WHERE member_pub = ?`, data.member_pub);
      return { status: 200, body: { ok: true } };
    }
    if (verb === "POST" && path === "/remove") {
      if (!this.requireAdmin()) return { status: 403, body: { error: "admin_only" } };
      if (data.member_pub === me.member_pub) return { status: 400, body: { error: "cannot_remove_self" } };
      const newEpoch = Number(data.new_epoch);
      if (!Number.isInteger(newEpoch) || newEpoch <= this.currentEpoch()) {
        return { status: 400, body: { error: "bad_new_epoch" } };
      }
      // Drop the removed member and all their wrapped keys.
      this.sql.exec(`DELETE FROM members WHERE member_pub = ?`, data.member_pub);
      this.sql.exec(`DELETE FROM family_keys WHERE member_pub = ?`, data.member_pub);
      this.sql.exec(`DELETE FROM join_requests WHERE member_pub = ?`, data.member_pub);
      // Install the new epoch key wrapped to each remaining member.
      const now = new Date().toISOString();
      const keys = Array.isArray(data.keys) ? data.keys : [];
      for (const k of keys) {
        if (!k || !k.member_pub || !k.wrapped) continue;
        if (!this.getMember(k.member_pub)) continue;
        this.sql.exec(
          `INSERT INTO family_keys (member_pub, epoch, wrapped, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(member_pub, epoch) DO UPDATE SET wrapped = excluded.wrapped`,
          k.member_pub, newEpoch, JSON.stringify(k.wrapped), now
        );
      }
      this.setMeta("current_epoch", String(newEpoch));
      if (data.enc_family_name) this.setMeta("enc_family_name", JSON.stringify(data.enc_family_name));
      return { status: 200, body: { ok: true, current_epoch: newEpoch } };
    }

    // ---- invites (admin stores a token; joiners fetch it by short code) ----
    if (verb === "POST" && path === "/invites") {
      if (!this.requireAdmin()) return { status: 403, body: { error: "admin_only" } };
      const token = data.token;
      if (!token || !token.sig || !token.exp || !token.admin_pub || !token.admin_x) {
        return { status: 400, body: { error: "bad_token" } };
      }
      const expMs = Date.parse(token.exp);
      if (Number.isNaN(expMs) || expMs < Date.now() || expMs - Date.now() > INVITE_MAX_TTL_MS) {
        return { status: 400, body: { error: "bad_expiry" } };
      }
      // Prune expired codes opportunistically, then mint a unique short code.
      this.sql.exec(`DELETE FROM invites WHERE exp_ms < ?`, Date.now());
      let code;
      for (let i = 0; i < 5; i++) {
        code = makeInviteCode();
        if (!this.sql.exec(`SELECT 1 FROM invites WHERE code = ?`, code).toArray()[0]) break;
      }
      this.sql.exec(
        `INSERT INTO invites (code, token, created_by, created_at, exp_ms) VALUES (?, ?, ?, ?, ?)`,
        code, JSON.stringify(token), me.member_pub, new Date().toISOString(), expMs
      );
      return { status: 200, body: { code, exp: token.exp } };
    }

    // ---- feed ----
    if (verb === "POST" && path === "/posts") {
      if (!data.ct || typeof data.epoch !== "number") return { status: 400, body: { error: "missing_ct_or_epoch" } };
      const id = uid("p");
      const now = new Date().toISOString();
      this.sql.exec(
        `INSERT INTO posts (id, author_pub, epoch, ct, created_at) VALUES (?, ?, ?, ?, ?)`,
        id, me.member_pub, data.epoch, JSON.stringify(data.ct), now
      );
      return { status: 200, body: { id, created_at: now } };
    }
    if (verb === "LIST" && path === "/posts") {
      const limit = Math.min(Number(data.limit) || 50, 100);
      const rows = this.sql.exec(`SELECT * FROM posts ORDER BY created_at DESC LIMIT ?`, limit).toArray();
      return { status: 200, body: { rows: rows.map((p) => this.decoratePost(p)) } };
    }
    if (verb === "GET" && path.startsWith("/posts/")) {
      const id = path.slice("/posts/".length);
      const p = this.sql.exec(`SELECT * FROM posts WHERE id = ?`, id).toArray()[0];
      if (!p) return { status: 404, body: { error: "not_found" } };
      const comments = this.sql
        .exec(`SELECT id, author_pub, epoch, ct, created_at FROM comments WHERE post_id = ? ORDER BY created_at`, id)
        .toArray()
        .map((c) => ({ ...c, ct: JSON.parse(c.ct) }));
      return { status: 200, body: { post: this.decoratePost(p), comments } };
    }
    if (verb === "POST" && path.match(/^\/posts\/[^/]+\/comments$/)) {
      const postId = path.split("/")[2];
      if (!data.ct || typeof data.epoch !== "number") return { status: 400, body: { error: "missing_ct_or_epoch" } };
      const id = uid("c");
      const now = new Date().toISOString();
      this.sql.exec(
        `INSERT INTO comments (id, post_id, author_pub, epoch, ct, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        id, postId, me.member_pub, data.epoch, JSON.stringify(data.ct), now
      );
      return { status: 200, body: { id, created_at: now } };
    }
    if (verb === "POST" && path.match(/^\/posts\/[^/]+\/react$/)) {
      const postId = path.split("/")[2];
      const emoji = String(data.emoji || "\u2764\ufe0f").slice(0, 8);
      const has = this.sql.exec(`SELECT 1 FROM reactions WHERE post_id=? AND member_pub=? AND emoji=?`, postId, me.member_pub, emoji).toArray()[0];
      if (has) {
        this.sql.exec(`DELETE FROM reactions WHERE post_id=? AND member_pub=? AND emoji=?`, postId, me.member_pub, emoji);
        return { status: 200, body: { reacted: false } };
      }
      this.sql.exec(`INSERT INTO reactions (post_id, member_pub, emoji, created_at) VALUES (?, ?, ?, ?)`, postId, me.member_pub, emoji, new Date().toISOString());
      return { status: 200, body: { reacted: true } };
    }
    if (verb === "DELETE" && path.startsWith("/posts/")) {
      const id = path.slice("/posts/".length);
      const p = this.sql.exec(`SELECT author_pub FROM posts WHERE id = ?`, id).toArray()[0];
      if (!p) return { status: 404, body: { error: "not_found" } };
      if (p.author_pub !== me.member_pub && me.role !== "admin") return { status: 403, body: { error: "not_allowed" } };
      this.sql.exec(`DELETE FROM posts WHERE id = ?`, id);
      this.sql.exec(`DELETE FROM comments WHERE post_id = ?`, id);
      this.sql.exec(`DELETE FROM reactions WHERE post_id = ?`, id);
      return { status: 200, body: { ok: true } };
    }

    // ---- events ----
    if (verb === "POST" && path === "/events") {
      if (!data.ct || typeof data.epoch !== "number") return { status: 400, body: { error: "missing_ct_or_epoch" } };
      const id = uid("e");
      this.sql.exec(
        `INSERT INTO events (id, created_by, epoch, ct, created_at) VALUES (?, ?, ?, ?, ?)`,
        id, me.member_pub, data.epoch, JSON.stringify(data.ct), new Date().toISOString()
      );
      return { status: 200, body: { id } };
    }
    if (verb === "LIST" && path === "/events") {
      const rows = this.sql.exec(`SELECT * FROM events ORDER BY created_at DESC`).toArray().map((e) => ({
        id: e.id, created_by: e.created_by, epoch: e.epoch, ct: JSON.parse(e.ct), created_at: e.created_at,
        rsvps: this.sql.exec(`SELECT member_pub, status FROM rsvps WHERE event_id = ?`, e.id).toArray(),
      }));
      return { status: 200, body: { rows } };
    }
    if (verb === "POST" && path.match(/^\/events\/[^/]+\/rsvp$/)) {
      const eventId = path.split("/")[2];
      const status = ["yes", "no", "maybe"].includes(data.status) ? data.status : "yes";
      this.sql.exec(
        `INSERT INTO rsvps (event_id, member_pub, status, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(event_id, member_pub) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
        eventId, me.member_pub, status, new Date().toISOString()
      );
      return { status: 200, body: { ok: true, status } };
    }
    if (verb === "DELETE" && path.startsWith("/events/")) {
      const id = path.slice("/events/".length);
      const e = this.sql.exec(`SELECT created_by FROM events WHERE id = ?`, id).toArray()[0];
      if (!e) return { status: 404, body: { error: "not_found" } };
      if (e.created_by !== me.member_pub && me.role !== "admin") return { status: 403, body: { error: "not_allowed" } };
      this.sql.exec(`DELETE FROM events WHERE id = ?`, id);
      this.sql.exec(`DELETE FROM rsvps WHERE event_id = ?`, id);
      return { status: 200, body: { ok: true } };
    }

    // ---- albums / photos ----
    if (verb === "POST" && path === "/albums") {
      if (!data.ct || typeof data.epoch !== "number") return { status: 400, body: { error: "missing_ct_or_epoch" } };
      const id = uid("a");
      this.sql.exec(
        `INSERT INTO albums (id, epoch, ct, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
        id, data.epoch, JSON.stringify(data.ct), me.member_pub, new Date().toISOString()
      );
      return { status: 200, body: { id } };
    }
    if (verb === "LIST" && path === "/albums") {
      const rows = this.sql.exec(`SELECT * FROM albums ORDER BY created_at DESC`).toArray().map((a) => {
        const cover = this.sql.exec(`SELECT r2_key, epoch FROM photos WHERE album_id = ? ORDER BY created_at DESC LIMIT 1`, a.id).toArray()[0];
        const n = this.sql.exec(`SELECT COUNT(*) AS n FROM photos WHERE album_id = ?`, a.id).toArray()[0].n;
        return { id: a.id, epoch: a.epoch, ct: JSON.parse(a.ct), created_at: a.created_at, n, cover: cover?.r2_key || null, cover_epoch: cover?.epoch ?? null };
      });
      return { status: 200, body: { rows } };
    }
    if (verb === "GET" && path.startsWith("/albums/")) {
      const albumId = path.slice("/albums/".length);
      const a = this.sql.exec(`SELECT * FROM albums WHERE id = ?`, albumId).toArray()[0];
      if (!a) return { status: 404, body: { error: "not_found" } };
      const photos = this.sql.exec(`SELECT * FROM photos WHERE album_id = ? ORDER BY created_at`, albumId).toArray().map((p) => ({
        id: p.id, r2_key: p.r2_key, epoch: p.epoch, ct: p.ct ? JSON.parse(p.ct) : null, author_pub: p.author_pub, created_at: p.created_at,
      }));
      return { status: 200, body: { album: { id: a.id, epoch: a.epoch, ct: JSON.parse(a.ct), created_at: a.created_at }, photos } };
    }
    if (verb === "POST" && path === "/photos") {
      if (!data.album_id || !data.r2_key || typeof data.epoch !== "number") return { status: 400, body: { error: "missing_fields" } };
      const id = uid("ph");
      this.sql.exec(
        `INSERT INTO photos (id, album_id, r2_key, epoch, ct, author_pub, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id, data.album_id, data.r2_key, data.epoch, data.ct ? JSON.stringify(data.ct) : null, me.member_pub, new Date().toISOString()
      );
      return { status: 200, body: { id } };
    }
    // Membership check used by the worker media upload route (active only).
    if (verb === "POST" && path === "/media/authorize") {
      if (me.status !== "active") return { status: 403, body: { error: "not_admitted" } };
      return { status: 200, body: { ok: true, member: me.member_pub } };
    }

    // ---- groups (Phase 1) --------------------------------------------------
    if (verb === "POST" && path === "/groups") {
      const type = String(data.type || "");
      const rules = GROUP_TYPE_RULES[type];
      if (!rules) return { status: 400, body: { error: "bad_group_type" } };
      // County boards are the base civic tier and are seeded by an instance
      // steward, not created ad hoc by members.
      if (type === "county" && !this.requireAdmin()) return { status: 403, body: { error: "steward_only" } };
      // Parent hierarchy: lobbies must nest inside an existing county board;
      // base/group tiers must not have a parent.
      let parentId = null;
      if (rules.parentType) {
        const parent = this.getGroup(data.parent_group_id);
        if (!parent || parent.type !== rules.parentType) return { status: 400, body: { error: "bad_parent" } };
        parentId = parent.id;
      }
      const encryption_mode = rules.encryption_mode;
      const visibility = rules.visibilities.has(data.visibility) ? data.visibility : [...rules.visibilities][0];
      const join_policy = JOIN_POLICIES.has(data.join_policy)
        ? data.join_policy
        : (type === "county" ? "open" : type === "issue" ? "request" : "invite");
      // Name: server-mode groups carry plaintext; e2e groups carry ciphertext.
      const plainName = encryption_mode === "server" ? String(data.name || "").trim() : null;
      const encName = encryption_mode === "e2e" ? data.enc_name || null : null;
      if (encryption_mode === "server" && !plainName) return { status: 400, body: { error: "name_required" } };
      const id = uid("g");
      const now = new Date().toISOString();
      this.sql.exec(
        `INSERT INTO groups (id, type, parent_group_id, slug, enc_name, name, visibility, join_policy, encryption_mode, current_epoch, founding, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
        id, type, parentId, slugify(data.slug || plainName || type), encName ? JSON.stringify(encName) : null,
        plainName, visibility, join_policy, encryption_mode, me.member_pub, now
      );
      // Creator becomes the group's steward.
      this.sql.exec(
        `INSERT INTO group_members (group_id, member_pub, role, status, joined_at) VALUES (?, ?, 'steward', 'active', ?)`,
        id, me.member_pub, now
      );
      return { status: 200, body: { ok: true, group: this.groupInfo(this.getGroup(id), me.member_pub) } };
    }
    // Seed the base county boards from a config-supplied list (idempotent by
    // slug). Instance-steward only. The county names come from instance.js.
    if (verb === "POST" && path === "/counties/seed") {
      if (!this.requireAdmin()) return { status: 403, body: { error: "steward_only" } };
      const names = Array.isArray(data.counties) ? data.counties : [];
      const now = new Date().toISOString();
      let created = 0;
      for (const raw of names) {
        const nm = String(raw || "").trim();
        if (!nm) continue;
        const slug = slugify(nm);
        const exists = this.sql.exec(`SELECT 1 FROM groups WHERE type = 'county' AND slug = ?`, slug).toArray()[0];
        if (exists) continue;
        const gid = uid("g");
        this.sql.exec(
          `INSERT INTO groups (id, type, parent_group_id, slug, enc_name, name, visibility, join_policy, encryption_mode, current_epoch, founding, created_by, created_at)
           VALUES (?, 'county', NULL, ?, NULL, ?, 'public_read', 'open', 'server', 1, 0, ?, ?)`,
          gid, slug, nm, me.member_pub, now
        );
        // The seeding steward is the initial steward of each county board.
        this.sql.exec(
          `INSERT INTO group_members (group_id, member_pub, role, status, joined_at) VALUES (?, ?, 'steward', 'active', ?)`,
          gid, me.member_pub, now
        );
        created++;
      }
      const total = this.sql.exec(`SELECT COUNT(*) AS n FROM groups WHERE type = 'county'`).toArray()[0].n;
      return { status: 200, body: { ok: true, created, total } };
    }
    if (verb === "LIST" && path === "/groups") {
      let rows = this.sql.exec(`SELECT * FROM groups ORDER BY founding DESC, type, created_at`).toArray();
      if (data.type && GROUP_TYPE_RULES[data.type]) rows = rows.filter((g) => g.type === data.type);
      if (data.parent_group_id) rows = rows.filter((g) => g.parent_group_id === data.parent_group_id);
      return { status: 200, body: { rows: rows.map((g) => this.groupInfo(g, me.member_pub)) } };
    }
    if (verb === "GET" && path.startsWith("/groups/") && !path.includes("/", "/groups/".length)) {
      const g = this.getGroup(path.slice("/groups/".length));
      if (!g) return { status: 404, body: { error: "group_not_found" } };
      return { status: 200, body: { group: this.groupInfo(g, me.member_pub) } };
    }
    if (verb === "POST" && path.match(/^\/groups\/[^/]+\/join$/)) {
      const g = this.getGroup(path.split("/")[2]);
      if (!g) return { status: 404, body: { error: "group_not_found" } };
      if (g.founding) return { status: 400, body: { error: "use_family_join" } };
      const existing = this.getGroupMembership(g.id, me.member_pub);
      if (existing) return { status: 200, body: { ok: true, status: existing.status, role: existing.role } };
      if (g.join_policy === "invite") return { status: 403, body: { error: "invite_required" } };
      const status = g.join_policy === "open" ? "active" : "pending";
      this.sql.exec(
        `INSERT INTO group_members (group_id, member_pub, role, status, joined_at) VALUES (?, ?, 'member', ?, ?)`,
        g.id, me.member_pub, status, new Date().toISOString()
      );
      return { status: 200, body: { ok: true, status } };
    }
    if (verb === "LIST" && path.match(/^\/groups\/[^/]+\/members$/)) {
      const g = this.getGroup(path.split("/")[2]);
      if (!g) return { status: 404, body: { error: "group_not_found" } };
      if (!this.groupRole(g, me.member_pub)) return { status: 403, body: { error: "not_a_member" } };
      const rows = g.founding
        ? this.sql.exec(`SELECT member_pub, role, status, joined_at FROM members ORDER BY joined_at`).toArray()
            .map((m) => ({ ...m, role: m.role === LEGACY_ADMIN_ROLE ? "steward" : m.role }))
        : this.sql.exec(`SELECT member_pub, role, status, joined_at FROM group_members WHERE group_id = ? ORDER BY joined_at`, g.id).toArray();
      return { status: 200, body: { rows } };
    }
    if (verb === "LIST" && path.match(/^\/groups\/[^/]+\/requests$/)) {
      const g = this.getGroup(path.split("/")[2]);
      if (!g) return { status: 404, body: { error: "group_not_found" } };
      if (!this.isModeratorOrAbove(g, me.member_pub)) return { status: 403, body: { error: "steward_only" } };
      const rows = this.sql.exec(`SELECT member_pub, joined_at FROM group_members WHERE group_id = ? AND status = 'pending' ORDER BY joined_at`, g.id).toArray();
      return { status: 200, body: { rows } };
    }
    if (verb === "POST" && path.match(/^\/groups\/[^/]+\/admit$/)) {
      const g = this.getGroup(path.split("/")[2]);
      if (!g) return { status: 404, body: { error: "group_not_found" } };
      if (!this.isSteward(g, me.member_pub)) return { status: 403, body: { error: "steward_only" } };
      const gm = this.getGroupMembership(g.id, data.member_pub);
      if (!gm) return { status: 404, body: { error: "no_such_member" } };
      this.sql.exec(`UPDATE group_members SET status = 'active' WHERE group_id = ? AND member_pub = ?`, g.id, data.member_pub);
      return { status: 200, body: { ok: true } };
    }
    if (verb === "POST" && path.match(/^\/groups\/[^/]+\/role$/)) {
      const g = this.getGroup(path.split("/")[2]);
      if (!g) return { status: 404, body: { error: "group_not_found" } };
      if (g.founding) return { status: 400, body: { error: "founding_roles_via_family" } };
      if (!this.isSteward(g, me.member_pub)) return { status: 403, body: { error: "steward_only" } };
      if (!GROUP_ROLES.has(data.role)) return { status: 400, body: { error: "bad_role" } };
      const gm = this.getGroupMembership(g.id, data.member_pub);
      if (!gm) return { status: 404, body: { error: "no_such_member" } };
      // Never orphan a group: keep at least one active steward.
      if (gm.role === "steward" && data.role !== "steward") {
        const stewards = this.sql.exec(`SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND role = 'steward' AND status = 'active'`, g.id).toArray()[0].n;
        if (stewards <= 1) return { status: 400, body: { error: "last_steward" } };
      }
      this.sql.exec(`UPDATE group_members SET role = ? WHERE group_id = ? AND member_pub = ?`, data.role, g.id, data.member_pub);
      return { status: 200, body: { ok: true } };
    }
    if (verb === "POST" && path.match(/^\/groups\/[^/]+\/remove$/)) {
      const g = this.getGroup(path.split("/")[2]);
      if (!g) return { status: 404, body: { error: "group_not_found" } };
      if (g.founding) return { status: 400, body: { error: "founding_remove_via_family" } };
      const self = data.member_pub === me.member_pub;
      if (!self && !this.isSteward(g, me.member_pub)) return { status: 403, body: { error: "steward_only" } };
      const gm = this.getGroupMembership(g.id, data.member_pub);
      if (gm && gm.role === "steward") {
        const stewards = this.sql.exec(`SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND role = 'steward' AND status = 'active'`, g.id).toArray()[0].n;
        if (stewards <= 1) return { status: 400, body: { error: "last_steward" } };
      }
      this.sql.exec(`DELETE FROM group_members WHERE group_id = ? AND member_pub = ?`, g.id, data.member_pub);
      return { status: 200, body: { ok: true } };
    }

    return { status: 404, body: { error: "route_not_found", path } };
  }

  familyInfo() {
    const encName = this.getMeta("enc_family_name");
    return {
      enc_family_name: encName ? JSON.parse(encName) : null,
      current_epoch: this.currentEpoch(),
      created_at: this.getMeta("created_at"),
      members: this.sql.exec(`SELECT COUNT(*) AS n FROM members WHERE status = 'active'`).toArray()[0].n,
      pending: this.sql.exec(`SELECT COUNT(*) AS n FROM join_requests`).toArray()[0].n,
    };
  }

  decoratePost(p) {
    const reactions = this.sql.exec(`SELECT emoji, COUNT(*) AS n FROM reactions WHERE post_id = ? GROUP BY emoji`, p.id).toArray();
    const mine = this._me
      ? this.sql.exec(`SELECT emoji FROM reactions WHERE post_id = ? AND member_pub = ?`, p.id, this._me.member_pub).toArray().map((r) => r.emoji)
      : [];
    const commentCount = this.sql.exec(`SELECT COUNT(*) AS n FROM comments WHERE post_id = ?`, p.id).toArray()[0].n;
    return {
      id: p.id, author_pub: p.author_pub, epoch: p.epoch, ct: JSON.parse(p.ct), created_at: p.created_at,
      reactions, my_reactions: mine, comment_count: commentCount,
    };
  }
}

// ---- helpers ---------------------------------------------------------------

function uid(prefix) {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || null;
}
// Pseudonymous public handle: letters/digits/_/-/space, trimmed, length-capped.
// Deliberately permissive but never a real-name requirement.
function sanitizeHandle(s) {
  const h = String(s || "").trim().replace(/\s+/g, " ").replace(/[^\w \-]/g, "").slice(0, 40);
  return h.length >= 2 ? h : null;
}
function verbOf(payload) {
  return String(payload?.verb || "").toUpperCase();
}
function pathOf(payload) {
  return String(payload?.path || "");
}
// Crockford-ish base32, no ambiguous chars (0/O, 1/I/L). Case-insensitive.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function makeInviteCode(len = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}
function normalizeCode(raw) {
  return String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function jsonResp(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extraHeaders } });
}
function canonicalObj(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

const ED_SPKI_PREFIX = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
function hexToBytesLocal(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0) throw new Error("hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
async function verifyEd25519(pubHex, sigHex, messageStr) {
  let raw;
  try {
    raw = hexToBytesLocal(pubHex);
  } catch {
    return false;
  }
  if (raw.length !== 32) return false;
  const der = new Uint8Array(ED_SPKI_PREFIX.length + raw.length);
  der.set(ED_SPKI_PREFIX, 0);
  der.set(raw, ED_SPKI_PREFIX.length);
  let key;
  try {
    key = await crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return false;
  }
  let sig;
  try {
    sig = hexToBytesLocal(sigHex);
  } catch {
    return false;
  }
  return crypto.subtle.verify({ name: "Ed25519" }, key, sig, new TextEncoder().encode(messageStr));
}
