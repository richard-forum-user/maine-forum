/**
 * PersonalPodDO — one Durable Object per device credential. Holds the
 * user's private Pod data (notes/journal, behaviors, traits, contacts,
 * and E2E message threads) in SQLite. The Worker authenticates each
 * request against the Ed25519 device key registered on first use (TOFU).
 *
 * Wire model: every request is a signed bundle (see pod-signing-web.js).
 * The payload is `{ verb, path, data }`. The DO dispatches on verb+path
 * and returns JSON. This pod is the user's own; no cooperative, no AI.
 */

import { verifySignedBundle } from "./pod-signing-web.js";
import { clampForumFeedbackComment } from "./feedback-limits.js";

const META_KEY_PUBKEY = "registered_public_key";
const META_LAMPORT = "lamport_clock";
const META_KEY_SESSION = "session_id";
const META_KEY_CREATED = "created_at";
const META_KEY_WEBID = "web_id";
const META_KEY_LAST_TOUCH = "last_touch";

// Replay window enforced by verifySignedBundle. Matches the value passed
// to that function (5 min) plus a small grace so the cleanup query never
// races a still-valid request.
const REPLAY_WINDOW_MS = 5 * 60 * 1000;
const REPLAY_CLEANUP_GRACE_MS = 60 * 1000;

export class PersonalPodDO {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
    this.sql = state.storage.sql;
    this._ready = state.blockConcurrencyWhile(() => this.initSchema());
  }

  initSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pod_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS civic_submissions (
        receipt_id TEXT PRIMARY KEY,
        zip_code TEXT,
        kind TEXT,
        category_code TEXT,
        category_id INTEGER,
        category_label TEXT,
        comment TEXT,
        egress_status TEXT DEFAULT 'pending',
        vault_status TEXT,
        sync_attempts INTEGER DEFAULT 0,
        last_error TEXT,
        submitted_at TEXT,
        share_status TEXT,
        consent_at TEXT,
        policy_version TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS journal_entries (
        submission_id TEXT PRIMARY KEY,
        submitted_at TEXT,
        raw_text TEXT,
        source_context TEXT,
        user_category_id TEXT,
        user_category_label TEXT,
        processing_status TEXT,
        lexicon_version TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS behaviors (
        behavior_id TEXT PRIMARY KEY,
        submission_id TEXT,
        category TEXT,
        action TEXT,
        entity TEXT,
        metadata_json TEXT,
        source TEXT,
        confidence REAL,
        reviewed INTEGER,
        created_at TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS traits (
        psycho_id TEXT PRIMARY KEY,
        submission_id TEXT,
        category TEXT,
        attribute TEXT,
        sentiment REAL,
        source TEXT,
        confidence REAL,
        reviewed INTEGER,
        created_at TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS email_proof (
        id INTEGER PRIMARY KEY,
        kind TEXT,
        email_hash TEXT,
        domain_hash TEXT,
        proof_receipt TEXT,
        claimed_email TEXT,
        claimed_domain TEXT,
        saved_at TEXT
      );

      -- Replay-protection cache keyed on the signature hex. The DO
      -- accepts a signed bundle at most once within the timestamp
      -- window; older entries are pruned on every write.
      CREATE TABLE IF NOT EXISTS replay_cache (
        signature TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        seen_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_replay_seen_at
        ON replay_cache(seen_at_ms);

      CREATE TABLE IF NOT EXISTS pod_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        sig TEXT NOT NULL,
        sync_status INTEGER NOT NULL DEFAULT 0,
        lamport_clock INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pod_events_sync ON pod_events(sync_status, id);
      CREATE INDEX IF NOT EXISTS idx_pod_events_type ON pod_events(event_type);

      CREATE TABLE IF NOT EXISTS pod_local_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        lamport_clock INTEGER NOT NULL
      );

      -- Authorized device signing keys (Ed25519, hex). The first device to
      -- reach a fresh pod is enrolled (TOFU) as the owner; further devices
      -- are added via the paired-device flow (PUT /devices/authorize, signed
      -- by an already-authorized device).
      CREATE TABLE IF NOT EXISTS authorized_devices (
        ed_pub_hex TEXT PRIMARY KEY,
        label TEXT,
        added_at TEXT NOT NULL
      );

      -- Pseudonymous contacts (public keys + pod URL; no PII).
      CREATE TABLE IF NOT EXISTS contacts (
        handle TEXT PRIMARY KEY,
        display_name TEXT,
        pod_url TEXT NOT NULL,
        ed TEXT NOT NULL,
        x TEXT NOT NULL,
        added_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Group channels. The raw group key is stored sealed-to-self (ciphertext)
      -- so a cloud-hosted pod cannot read group message contents.
      CREATE TABLE IF NOT EXISTS groups (
        group_id TEXT PRIMARY KEY,
        title TEXT,
        sealed_key TEXT NOT NULL,
        roster_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Message store. envelope_json is ALWAYS an E2E-sealed envelope
      -- (ciphertext). The pod never holds plaintext.
      CREATE TABLE IF NOT EXISTS messages (
        msg_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        direction TEXT NOT NULL,
        peer_handle TEXT,
        group_id TEXT,
        envelope_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);

      -- Sender-side store-and-forward queue. The pod delivers the sealed
      -- envelope to the recipient pod's /api/inbox and retries with backoff,
      -- so delivery survives a briefly-offline recipient even if this device
      -- goes offline after queueing.
      CREATE TABLE IF NOT EXISTS outbox (
        out_id TEXT PRIMARY KEY,
        to_pod_url TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, next_attempt_at_ms);
    `);
    this.sql.exec(`DROP TABLE IF EXISTS assistant_messages`);
  }

  bumpClock() {
    const cur = Number(this.getMeta(META_LAMPORT) || 0) + 1;
    this.setMeta(META_LAMPORT, String(cur));
    return cur;
  }

  /**
   * Returns true when this signature has been seen within the replay
   * window, false otherwise. Uses `INSERT OR IGNORE` so the PRIMARY KEY
   * constraint is the source of truth — concurrent requests cannot both
   * insert the same signature. Also opportunistically prunes entries
   * older than the window on every call.
   */
  checkAndRecordReplay(signature, sessionId) {
    if (!signature) return false;
    const nowMs = Date.now();
    const cutoff = nowMs - (REPLAY_WINDOW_MS + REPLAY_CLEANUP_GRACE_MS);
    this.sql.exec(`DELETE FROM replay_cache WHERE seen_at_ms < ?`, cutoff);
    const cursor = this.sql.exec(
      `INSERT OR IGNORE INTO replay_cache (signature, session_id, seen_at_ms)
       VALUES (?, ?, ?)`,
      signature,
      sessionId || "",
      nowMs
    );
    // rowsWritten === 1: inserted (fresh signature, not a replay)
    // rowsWritten === 0: PRIMARY KEY conflict (signature already seen)
    const written = typeof cursor?.rowsWritten === "number" ? cursor.rowsWritten : 1;
    return written === 0;
  }

  getMeta(key) {
    const rows = this.sql
      .exec(`SELECT value FROM pod_meta WHERE key = ?`, key)
      .toArray();
    return rows.length > 0 ? rows[0].value : null;
  }

  setMeta(key, value) {
    this.sql.exec(
      `INSERT OR REPLACE INTO pod_meta (key, value) VALUES (?, ?)`,
      key,
      value == null ? "" : String(value)
    );
  }

  deviceCount() {
    return Number(
      this.sql.exec(`SELECT COUNT(*) AS n FROM authorized_devices`).one().n
    );
  }

  isAuthorizedDevice(edPubHex) {
    if (!edPubHex) return false;
    const rows = this.sql
      .exec(`SELECT 1 FROM authorized_devices WHERE ed_pub_hex = ?`, edPubHex)
      .toArray();
    return rows.length > 0;
  }

  enrollDevice(edPubHex, label) {
    this.sql.exec(
      `INSERT OR IGNORE INTO authorized_devices (ed_pub_hex, label, added_at)
       VALUES (?, ?, ?)`,
      edPubHex,
      label || "",
      new Date().toISOString()
    );
  }

  /**
   * Recovery-signed device rebind. The caller proves possession of the
   * recovery key (the phrase-derived identity Ed25519 key enrolled at setup)
   * by signing a statement that authorizes its new device key.
   */
  async tryRecoverDevice(payload, devicePubHex) {
    if (!payload || payload.verb !== "PUT" || payload.path !== "/devices/recover") {
      return false;
    }
    const data = payload.data || {};
    const recoveryPub = this.getMeta("recovery_pub");
    if (!recoveryPub || !data.recovery_sig || !data.ts) return false;
    const tsMs = Date.parse(data.ts);
    if (Number.isNaN(tsMs) || Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) return false;
    const message = canonicalObj({ action: "recover-device", ed_pub: devicePubHex, ts: data.ts });
    const ok = await verifyEd25519(recoveryPub, data.recovery_sig, message);
    if (!ok) return false;
    this.enrollDevice(devicePubHex, "recovered");
    return true;
  }

  async fetch(request) {
    await this._ready;
    if (request.method !== "POST") {
      return jsonResp(405, { error: "use_post" });
    }

    // Internal inbound delivery from the pod worker's public /api/inbox.
    // The worker has already verified the envelope signature; this path is
    // only reachable Worker->DO (DOs are not publicly addressable). It never
    // sees plaintext — it stores the sealed envelope as received.
    const _url = new URL(request.url);
    if (_url.pathname === "/inbox") {
      let envelope;
      try {
        envelope = await request.json();
      } catch {
        return jsonResp(400, { error: "invalid_json" });
      }
      return this.handleInternalInbox(envelope);
    }

    let bundle;
    try {
      bundle = await request.json();
    } catch {
      return jsonResp(400, { error: "invalid_json" });
    }

    // Verify the Ed25519 signature is valid for the bundle's own key.
    const verdict = await verifySignedBundle(bundle, null);
    if (!verdict.valid) {
      return jsonResp(401, { error: "auth_failed", reason: verdict.reason });
    }

    const { payload, sessionId, publicKeyHex } = verdict;

    // Replay defense. The timestamp window is necessary but not
    // sufficient: an attacker who captures a single valid bundle can
    // replay it inside the 5-min window. Reject the second use.
    if (this.checkAndRecordReplay(bundle.signature, publicKeyHex)) {
      return jsonResp(401, { error: "auth_failed", reason: "replay_detected" });
    }

    // Device allowlist. The first device to reach a fresh pod is enrolled
    // as the owner (TOFU). Every later device must already be authorized
    // (added via the paired-device flow by an existing device).
    if (!this.isAuthorizedDevice(publicKeyHex)) {
      if (this.deviceCount() === 0) {
        this.enrollDevice(publicKeyHex, "owner");
        this.setMeta(META_KEY_PUBKEY, publicKeyHex);
        this.setMeta(META_KEY_SESSION, sessionId);
        this.setMeta(META_KEY_CREATED, new Date().toISOString());
      } else {
        // Allow a recovery-signed device rebind: prove possession of the
        // recovery key (the phrase-derived identity key) to enroll this
        // device after losing the original.
        const recovered = await this.tryRecoverDevice(payload, publicKeyHex);
        if (!recovered) {
          return jsonResp(401, { error: "auth_failed", reason: "device_not_authorized" });
        }
      }
    }
    this.setMeta(META_KEY_LAST_TOUCH, new Date().toISOString());
    this._device = publicKeyHex;

    if (!payload || typeof payload !== "object") {
      return jsonResp(400, { error: "invalid_payload" });
    }
    const verb = String(payload.verb || "").toUpperCase();
    const path = String(payload.path || "");
    const data = payload.data || {};
    if (!verb || !path) {
      return jsonResp(400, { error: "missing_verb_or_path" });
    }

    try {
      const result = await this.dispatch(verb, path, data);
      return jsonResp(result.status || 200, result.body ?? {});
    } catch (e) {
      return jsonResp(500, {
        error: "handler_failed",
        reason: e?.message || String(e),
      });
    }
  }

  async dispatch(verb, path, data) {
    const now = new Date().toISOString();

    if (verb === "PROVISION") {
      if (data.webId) this.setMeta(META_KEY_WEBID, data.webId);
      if (data.handle) this.setMeta("owner_handle", data.handle);
      if (data.pod_id) this.setMeta("pod_id", data.pod_id);
      // Enroll the recovery public key (the phrase-derived identity Ed25519
      // key) so a fresh device can re-pair after device loss.
      if (data.recovery_pub && /^[0-9a-f]{64}$/.test(data.recovery_pub)) {
        this.setMeta("recovery_pub", data.recovery_pub);
      }
      return {
        status: 200,
        body: {
          ok: true,
          webId: data.webId || this.getMeta(META_KEY_WEBID) || null,
          handle: this.getMeta("owner_handle"),
          podRoot: data.podRoot || null,
          createdAt: this.getMeta(META_KEY_CREATED),
        },
      };
    }

    // ---- device pairing ----------------------------------------------------
    if (verb === "PUT" && path === "/devices/authorize") {
      const edPub = String(data.ed_pub || "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(edPub)) {
        return { status: 400, body: { error: "invalid_ed_pub" } };
      }
      this.enrollDevice(edPub, data.label || "paired device");
      return { status: 200, body: { ok: true, ed_pub: edPub } };
    }
    if (verb === "LIST" && path === "/devices") {
      const rows = this.sql
        .exec(`SELECT ed_pub_hex, label, added_at FROM authorized_devices ORDER BY added_at`)
        .toArray();
      return { status: 200, body: { rows } };
    }
    if (verb === "PUT" && path === "/devices/recover") {
      // Enrollment already happened in the recovery gate (tryRecoverDevice)
      // before dispatch; just acknowledge.
      return { status: 200, body: { ok: true, recovered: true } };
    }

    // ---- contacts ----------------------------------------------------------
    if (verb === "PUT" && path.startsWith("/contacts/")) {
      const handle = decodeURIComponent(path.slice("/contacts/".length));
      if (!handle) return { status: 400, body: { error: "missing_handle" } };
      this.sql.exec(
        `INSERT INTO contacts (handle, display_name, pod_url, ed, x, added_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(handle) DO UPDATE SET
           display_name = excluded.display_name,
           pod_url = excluded.pod_url,
           ed = excluded.ed,
           x = excluded.x,
           updated_at = excluded.updated_at`,
        handle,
        data.display_name || "",
        data.pod_url || "",
        data.ed || "",
        data.x || "",
        data.added_at || now,
        now
      );
      return { status: 200, body: { ok: true, handle } };
    }
    if (verb === "LIST" && path === "/contacts") {
      const rows = this.sql.exec(`SELECT * FROM contacts ORDER BY display_name, handle`).toArray();
      return { status: 200, body: { rows } };
    }
    if (verb === "DELETE" && path.startsWith("/contacts/")) {
      const handle = decodeURIComponent(path.slice("/contacts/".length));
      this.sql.exec(`DELETE FROM contacts WHERE handle = ?`, handle);
      return { status: 200, body: { ok: true, handle } };
    }

    // ---- groups ------------------------------------------------------------
    if (verb === "PUT" && path.startsWith("/groups/")) {
      const groupId = decodeURIComponent(path.slice("/groups/".length));
      if (!groupId) return { status: 400, body: { error: "missing_group_id" } };
      this.sql.exec(
        `INSERT INTO groups (group_id, title, sealed_key, roster_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET
           title = excluded.title,
           sealed_key = excluded.sealed_key,
           roster_json = excluded.roster_json,
           updated_at = excluded.updated_at`,
        groupId,
        data.title || "",
        data.sealed_key || "",
        data.roster_json || "[]",
        data.created_at || now,
        now
      );
      return { status: 200, body: { ok: true, group_id: groupId } };
    }
    if (verb === "LIST" && path === "/groups") {
      const rows = this.sql.exec(`SELECT * FROM groups ORDER BY updated_at DESC`).toArray();
      return { status: 200, body: { rows } };
    }
    if (verb === "GET" && path.startsWith("/groups/")) {
      const groupId = decodeURIComponent(path.slice("/groups/".length));
      const rows = this.sql.exec(`SELECT * FROM groups WHERE group_id = ?`, groupId).toArray();
      return { status: 200, body: rows[0] || null };
    }

    // ---- messages ----------------------------------------------------------
    if (verb === "PUT" && path.startsWith("/messages/")) {
      const msgId = decodeURIComponent(path.slice("/messages/".length));
      if (!msgId) return { status: 400, body: { error: "missing_msg_id" } };
      const envelopeJson =
        typeof data.envelope === "string" ? data.envelope : JSON.stringify(data.envelope || {});
      this.sql.exec(
        `INSERT OR IGNORE INTO messages
         (msg_id, thread_id, kind, direction, peer_handle, group_id, envelope_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        msgId,
        data.thread_id || "",
        data.kind || "dm",
        data.direction || "out",
        data.peer_handle || null,
        data.group_id || null,
        envelopeJson,
        data.created_at || now
      );
      return { status: 200, body: { ok: true, msg_id: msgId } };
    }
    if (verb === "LIST" && path === "/messages") {
      const threadId = data.thread_id || "";
      const afterId = data.after || "";
      let rows;
      if (threadId) {
        rows = this.sql
          .exec(
            `SELECT * FROM messages WHERE thread_id = ? AND created_at > ?
             ORDER BY created_at ASC LIMIT 500`,
            threadId,
            afterId
          )
          .toArray();
      } else {
        rows = this.sql
          .exec(`SELECT * FROM messages WHERE created_at > ? ORDER BY created_at ASC LIMIT 500`, afterId)
          .toArray();
      }
      return { status: 200, body: { rows } };
    }
    if (verb === "LIST" && path === "/threads") {
      const rows = this.sql
        .exec(
          `SELECT thread_id, kind, peer_handle, group_id,
                  MAX(created_at) AS last_at, COUNT(*) AS n
           FROM messages GROUP BY thread_id ORDER BY last_at DESC`
        )
        .toArray();
      return { status: 200, body: { rows } };
    }

    // ---- outbox (store-and-forward) ---------------------------------------
    if (verb === "PUT" && path.startsWith("/outbox/")) {
      const outId = decodeURIComponent(path.slice("/outbox/".length));
      if (!outId) return { status: 400, body: { error: "missing_out_id" } };
      const toPodUrl = String(data.to_pod_url || "").replace(/\/$/, "");
      if (!toPodUrl) return { status: 400, body: { error: "missing_to_pod_url" } };
      const envelopeJson =
        typeof data.envelope === "string" ? data.envelope : JSON.stringify(data.envelope || {});
      this.sql.exec(
        `INSERT OR REPLACE INTO outbox
         (out_id, to_pod_url, envelope_json, status, attempts, next_attempt_at_ms, last_error, created_at)
         VALUES (?, ?, ?, 'pending', 0, 0, NULL, ?)`,
        outId,
        toPodUrl,
        envelopeJson,
        now
      );
      await this.scheduleDelivery(0);
      return { status: 200, body: { ok: true, out_id: outId } };
    }
    if (verb === "LIST" && path === "/outbox") {
      const rows = this.sql
        .exec(
          `SELECT out_id, to_pod_url, status, attempts, next_attempt_at_ms, last_error, created_at
           FROM outbox ORDER BY created_at DESC LIMIT 200`
        )
        .toArray();
      return { status: 200, body: { rows } };
    }
    if (verb === "POST" && path === "/outbox/flush") {
      const result = await this.deliverOutbox();
      return { status: 200, body: result };
    }

    // civic_submissions
    if (verb === "PUT" && path.startsWith("/civic/submissions/")) {
      const id = path.slice("/civic/submissions/".length);
      if (!id) return { status: 400, body: { error: "missing_id" } };
      this.sql.exec(
        `INSERT OR REPLACE INTO civic_submissions
         (receipt_id, zip_code, kind, category_code, category_id, category_label,
          comment, egress_status, vault_status, sync_attempts, last_error,
          submitted_at, share_status, consent_at, policy_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        data.zip_code || null,
        data.kind || null,
        data.category_code || null,
        data.category_id != null ? Number(data.category_id) : null,
        data.category_label || "",
        clampForumFeedbackComment(data.comment || ""),
        data.egress_status || "pending",
        data.vault_status || null,
        Number(data.sync_attempts || 0),
        data.last_error || null,
        data.submitted_at || now,
        data.share_status || "private",
        data.consent_at || null,
        data.policy_version || null,
        now
      );
      return { status: 200, body: { ok: true, id } };
    }

    if (verb === "LIST" && path === "/civic/submissions") {
      const rows = this.sql
        .exec(
          `SELECT * FROM civic_submissions ORDER BY COALESCE(submitted_at, '') DESC`
        )
        .toArray();
      return { status: 200, body: { rows } };
    }

    // journal_entries
    if (verb === "PUT" && path.startsWith("/journal/raw/")) {
      const id = path.slice("/journal/raw/".length);
      if (!id) return { status: 400, body: { error: "missing_id" } };
      this.sql.exec(
        `INSERT OR REPLACE INTO journal_entries
         (submission_id, submitted_at, raw_text, source_context, user_category_id,
          user_category_label, processing_status, lexicon_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        data.submitted_at || now,
        data.raw_text || "",
        data.source_context || "journal",
        data.user_category_id || null,
        data.user_category_label || null,
        data.processing_status || "unprocessed",
        data.lexicon_version || null,
        now
      );
      return { status: 200, body: { ok: true, id } };
    }

    if (verb === "LIST" && path === "/journal/raw") {
      const rows = this.sql
        .exec(
          `SELECT * FROM journal_entries ORDER BY COALESCE(submitted_at, '') DESC`
        )
        .toArray();
      return { status: 200, body: { rows } };
    }

    // behaviors
    if (verb === "PUT" && path.startsWith("/journal/behaviors/")) {
      const id = path.slice("/journal/behaviors/".length);
      if (!id) return { status: 400, body: { error: "missing_id" } };
      this.sql.exec(
        `INSERT OR REPLACE INTO behaviors
         (behavior_id, submission_id, category, action, entity, metadata_json,
          source, confidence, reviewed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        data.submission_id || null,
        data.category || "",
        data.action || null,
        data.entity || null,
        data.metadata_json || null,
        data.source || "rule:v1",
        Number(data.confidence ?? 0),
        data.reviewed ? 1 : 0,
        data.created_at || now,
        now
      );
      return { status: 200, body: { ok: true, id } };
    }

    if (verb === "LIST" && path === "/journal/behaviors") {
      const rows = this.sql
        .exec(
          `SELECT * FROM behaviors ORDER BY COALESCE(created_at, '') DESC`
        )
        .toArray()
        .map((r) => ({ ...r, reviewed: !!r.reviewed }));
      return { status: 200, body: { rows } };
    }

    // traits
    if (verb === "PUT" && path.startsWith("/journal/traits/")) {
      const id = path.slice("/journal/traits/".length);
      if (!id) return { status: 400, body: { error: "missing_id" } };
      this.sql.exec(
        `INSERT OR REPLACE INTO traits
         (psycho_id, submission_id, category, attribute, sentiment, source,
          confidence, reviewed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        data.submission_id || null,
        data.category || "",
        data.attribute || "",
        data.sentiment != null ? Number(data.sentiment) : null,
        data.source || "rule:v1",
        Number(data.confidence ?? 0),
        data.reviewed ? 1 : 0,
        data.created_at || now,
        now
      );
      return { status: 200, body: { ok: true, id } };
    }

    if (verb === "LIST" && path === "/journal/traits") {
      const rows = this.sql
        .exec(`SELECT * FROM traits ORDER BY COALESCE(created_at, '') DESC`)
        .toArray()
        .map((r) => ({ ...r, reviewed: !!r.reviewed }));
      return { status: 200, body: { rows } };
    }

    // email_proof (single-row table)
    if (verb === "PUT" && path === "/identity/email-proof") {
      this.sql.exec(`DELETE FROM email_proof`);
      this.sql.exec(
        `INSERT INTO email_proof
         (id, kind, email_hash, domain_hash, proof_receipt, claimed_email, claimed_domain, saved_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
        data.kind || "zk-email-dkim-v1",
        data.email_hash || "",
        data.domain_hash || null,
        data.proof_receipt || null,
        data.claimed_email || null,
        data.claimed_domain || null,
        data.saved_at || now
      );
      return { status: 200, body: { ok: true } };
    }

    if (verb === "GET" && path === "/identity/email-proof") {
      const rows = this.sql
        .exec(`SELECT * FROM email_proof WHERE id = 1`)
        .toArray();
      return { status: 200, body: rows[0] || null };
    }

    // pod_events — append-only audit log (device-signed payloads)
    if (verb === "PUT" && path === "/events/append") {
      const eventType = String(data.event_type || "");
      const payloadStr =
        typeof data.payload === "string"
          ? data.payload
          : JSON.stringify(data.payload || {});
      const sig = String(data.sig || "");
      if (!eventType || !sig) {
        return { status: 400, body: { error: "missing_event_type_or_sig" } };
      }
      const clock = this.bumpClock();
      const inserted = this.sql
        .exec(
          `INSERT INTO pod_events (event_type, payload, sig, sync_status, lamport_clock, created_at)
           VALUES (?, ?, ?, 0, ?, ?) RETURNING id`,
          eventType,
          payloadStr,
          sig,
          clock,
          now
        )
        .one();
      const id = inserted?.id;
      if (data.projection_key) {
        this.sql.exec(
          `INSERT OR REPLACE INTO pod_local_state (key, value, updated_at, lamport_clock)
           VALUES (?, ?, ?, ?)`,
          String(data.projection_key),
          payloadStr,
          now,
          clock
        );
      }
      return { status: 200, body: { ok: true, id, lamport_clock: clock } };
    }

    if (verb === "LIST" && path.startsWith("/events")) {
      const statusFilter = data.status || "all";
      let q = `SELECT id, event_type, payload, sig, sync_status, lamport_clock, created_at
                 FROM pod_events`;
      if (statusFilter === "pending") q += ` WHERE sync_status = 0`;
      else if (statusFilter === "synced") q += ` WHERE sync_status = 1`;
      q += ` ORDER BY id ASC LIMIT 200`;
      const rows = this.sql.exec(q).toArray();
      return { status: 200, body: { rows } };
    }

    if (verb === "PUT" && path.startsWith("/events/") && path.endsWith("/ack")) {
      const idPart = path.slice("/events/".length, -"/ack".length);
      const id = Number(idPart);
      if (!id) return { status: 400, body: { error: "invalid_id" } };
      this.sql.exec(`UPDATE pod_events SET sync_status = 1 WHERE id = ?`, id);
      return { status: 200, body: { ok: true, id } };
    }

    if (verb === "LIST" && path === "/local-state") {
      const rows = this.sql.exec(`SELECT * FROM pod_local_state ORDER BY key`).toArray();
      return { status: 200, body: { rows } };
    }

    if (verb === "GET" && path.startsWith("/local-state/")) {
      const key = decodeURIComponent(path.slice("/local-state/".length));
      const rows = this.sql
        .exec(`SELECT * FROM pod_local_state WHERE key = ?`, key)
        .toArray();
      return { status: 200, body: rows[0] || null };
    }

    return { status: 404, body: { error: "route_not_found", verb, path } };
  }

  /**
   * Store an inbound sealed envelope (called Worker->DO from /api/inbox).
   * Plaintext is never present; we persist the ciphertext envelope as-is.
   */
  handleInternalInbox(envelope) {
    if (!envelope || typeof envelope !== "object" || !envelope.sig || !envelope.ct) {
      return jsonResp(400, { error: "invalid_envelope" });
    }
    const ownerHandle = this.getMeta("owner_handle");
    if (envelope.kind === "dm") {
      if (ownerHandle && envelope.to && envelope.to !== ownerHandle) {
        return jsonResp(404, { error: "not_for_this_pod" });
      }
    }
    const now = new Date().toISOString();
    const kind = envelope.kind === "group" ? "group" : "dm";
    const threadId =
      kind === "group" ? `g:${envelope.groupId}` : `dm:${envelope.from}`;
    const msgId = envelope.sig.slice(0, 48);
    this.sql.exec(
      `INSERT OR IGNORE INTO messages
       (msg_id, thread_id, kind, direction, peer_handle, group_id, envelope_json, created_at)
       VALUES (?, ?, ?, 'in', ?, ?, ?, ?)`,
      msgId,
      threadId,
      kind,
      kind === "dm" ? envelope.from || null : null,
      kind === "group" ? envelope.groupId || null : null,
      JSON.stringify(envelope),
      now
    );
    return jsonResp(200, { ok: true, stored: true, thread_id: threadId });
  }

  /** Set an alarm to run outbox delivery after `delayMs` (if sooner than current). */
  async scheduleDelivery(delayMs = 0) {
    const at = Date.now() + Math.max(0, delayMs);
    try {
      const existing = await this.state.storage.getAlarm();
      if (existing == null || at < existing) {
        await this.state.storage.setAlarm(at);
      }
    } catch {
      // Alarms unavailable in some runtimes: deliver inline as a fallback.
      await this.deliverOutbox();
    }
  }

  /**
   * Deliver pending outbox envelopes to recipient pods' /api/inbox with
   * exponential backoff. Returns a small summary. The DO holds only the
   * sealed envelope, so this never exposes plaintext.
   */
  async deliverOutbox() {
    const nowMs = Date.now();
    const pending = this.sql
      .exec(
        `SELECT out_id, to_pod_url, envelope_json, attempts FROM outbox
         WHERE status = 'pending' AND next_attempt_at_ms <= ?
         ORDER BY next_attempt_at_ms ASC LIMIT 25`,
        nowMs
      )
      .toArray();
    let delivered = 0;
    let failed = 0;
    for (const row of pending) {
      let ok = false;
      let errText = null;
      try {
        const res = await fetch(`${row.to_pod_url}/api/inbox`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: row.envelope_json,
        });
        ok = res.ok;
        if (!ok) errText = `http_${res.status}`;
      } catch (e) {
        errText = e?.message || "network_error";
      }
      if (ok) {
        this.sql.exec(`UPDATE outbox SET status = 'sent', last_error = NULL WHERE out_id = ?`, row.out_id);
        delivered++;
      } else {
        const attempts = Number(row.attempts) + 1;
        const maxAttempts = 10;
        const backoffMs = Math.min(60 * 60 * 1000, 2000 * 2 ** Math.min(attempts, 12));
        const status = attempts >= maxAttempts ? "failed" : "pending";
        this.sql.exec(
          `UPDATE outbox SET attempts = ?, status = ?, last_error = ?, next_attempt_at_ms = ? WHERE out_id = ?`,
          attempts,
          status,
          errText,
          nowMs + backoffMs,
          row.out_id
        );
        failed++;
      }
    }
    // Reschedule if anything is still pending.
    const next = this.sql
      .exec(
        `SELECT MIN(next_attempt_at_ms) AS next_at FROM outbox WHERE status = 'pending'`
      )
      .one().next_at;
    if (next != null) {
      try {
        await this.state.storage.setAlarm(Math.max(Number(next), Date.now() + 1000));
      } catch {
        /* ignore */
      }
    }
    return { ok: true, delivered, failed, processed: pending.length };
  }

  async alarm() {
    await this._ready;
    await this.deliverOutbox();
  }
}

function jsonResp(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function canonicalObj(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

const ED_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

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
