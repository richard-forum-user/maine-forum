/**
 * PersonalPodDO — the owner's single pinned Durable Object. Holds the
 * user's private Pod data (contacts and E2E message threads) in SQLite.
 * The Worker authenticates each request against the Ed25519 device key
 * registered on first use (TOFU), optionally gated by a one-time setup token.
 *
 * Wire model: every request is a signed bundle (see pod-signing-web.js).
 * The payload is `{ verb, path, data }`. The DO dispatches on verb+path
 * and returns JSON. This pod is the user's own; no cooperative, no AI.
 */

import { canonicalise as canonicalObj } from "./canonical-json.js";
import { audienceFromUrl, verifySignedBundle } from "./pod-signing-web.js";
import {
  MAX_ENVELOPE_BYTES,
  envelopeByteLength,
  isDeliverablePodUrl,
} from "./pod-url.js";

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
const MAX_UNKNOWN_PER_SENDER = 100;
const MAX_UNKNOWN_TOTAL = 1000;

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
    this.sql.exec(`DROP TABLE IF EXISTS civic_submissions`);
    this.sql.exec(`DROP TABLE IF EXISTS email_proof`);
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

  pinnedId() {
    return typeof this.env?.OWNER_POD_ID === "string" ? this.env.OWNER_POD_ID.trim() : "";
  }

  /**
   * Audience for this request. The configured pod origin wins. A header that
   * disagrees with it is rejected so a bundle signed for another pod cannot
   * be replayed here.
   */
  resolveAud(request) {
    const configured = audienceFromUrl(this.env?.PUBLIC_POD_URL || "");
    const header = String(request.headers.get("X-Pod-Aud") || "").trim();
    if (configured && header && header !== configured) {
      this._audError = "aud_mismatch";
      return "";
    }
    this._audError = null;
    return configured || header || "";
  }

  /** First enrollment requires SETUP_TOKEN when that secret is configured. */
  async tofuAllowed(bundle) {
    const expected = this.env?.SETUP_TOKEN;
    if (expected == null || expected === "") return true;
    return secretsEqual(bundle?.setupToken, expected);
  }

  /**
   * Verify a statement signed by the current recovery key and remember the
   * signature so it cannot be replayed inside the timestamp window.
   * `fields` is bound to this pod's audience.
   */
  async verifyRecoveryStatement(data, fields) {
    const recoveryPub = this.getMeta("recovery_pub");
    if (!recoveryPub || !data?.recovery_sig || !data?.ts) return false;
    const tsMs = Date.parse(data.ts);
    if (Number.isNaN(tsMs) || Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) return false;
    const message = canonicalObj({ ...fields, ts: data.ts, aud: this._aud || "" });
    const ok = await verifyEd25519(recoveryPub, data.recovery_sig, message);
    if (!ok) return false;
    if (this.checkAndRecordReplay(data.recovery_sig, "recovery")) return false;
    return true;
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
    const ok = await this.verifyRecoveryStatement(data, {
      action: "recover-device",
      ed_pub: devicePubHex,
    });
    if (!ok) return false;
    this.enrollDevice(devicePubHex, "recovered");
    return true;
  }

  /**
   * "I lost my phone": a recovery signature wipes the device allowlist and
   * enrolls only the calling device.
   */
  async tryResetDevices(payload, devicePubHex) {
    if (!payload || payload.verb !== "PUT" || payload.path !== "/devices/reset") {
      return false;
    }
    const data = payload.data || {};
    const ok = await this.verifyRecoveryStatement(data, {
      action: "reset-devices",
      ed_pub: devicePubHex,
    });
    if (!ok) return false;
    this.sql.exec(`DELETE FROM authorized_devices`);
    this.enrollDevice(devicePubHex, "owner");
    this.setMeta(META_KEY_PUBKEY, devicePubHex);
    return true;
  }

  deviceRows() {
    return this.sql
      .exec(`SELECT ed_pub_hex, label, added_at FROM authorized_devices ORDER BY added_at`)
      .toArray();
  }

  contactFor(handle) {
    if (!handle) return null;
    const rows = this.sql
      .exec(`SELECT handle, ed, x FROM contacts WHERE handle = ?`, handle)
      .toArray();
    return rows[0] || null;
  }

  /**
   * First PROVISION pins the owner handle, the deployment pod id, and the
   * recovery key. Later calls cannot change them unless the current recovery
   * key signs the change. The pod id is always the pinned id, never a
   * client-chosen route.
   */
  async provision(data) {
    const pinned = this.pinnedId();
    if (!pinned) return { status: 500, body: { error: "pod_not_pinned" } };
    if (data.webId && !this.getMeta(META_KEY_WEBID)) this.setMeta(META_KEY_WEBID, data.webId);

    const existingHandle = this.getMeta("owner_handle");
    const nextHandle = data.handle ? String(data.handle) : "";
    if (!existingHandle && nextHandle) {
      this.setMeta("owner_handle", nextHandle);
    } else if (existingHandle && nextHandle && nextHandle !== existingHandle) {
      const ok = await this.verifyRecoveryStatement(data, {
        action: "rebind-owner",
        handle: nextHandle,
      });
      if (ok) this.setMeta("owner_handle", nextHandle);
    }

    // Always the deployment pin. A client-supplied pod_id is ignored.
    this.setMeta("pod_id", pinned);

    const wantsRecovery =
      data.recovery_pub && /^[0-9a-f]{64}$/i.test(String(data.recovery_pub))
        ? String(data.recovery_pub).toLowerCase()
        : "";
    const existingRecovery = this.getMeta("recovery_pub");
    if (!existingRecovery && wantsRecovery) {
      this.setMeta("recovery_pub", wantsRecovery);
    } else if (existingRecovery && wantsRecovery && wantsRecovery !== existingRecovery) {
      const ok = await this.verifyRecoveryStatement(data, {
        action: "rotate-recovery",
        recovery_pub: wantsRecovery,
      });
      if (ok) this.setMeta("recovery_pub", wantsRecovery);
    }

    return {
      status: 200,
      body: {
        ok: true,
        webId: this.getMeta(META_KEY_WEBID) || null,
        handle: this.getMeta("owner_handle"),
        pod_id: this.getMeta("pod_id"),
        podRoot: data.podRoot || null,
        createdAt: this.getMeta(META_KEY_CREATED),
      },
    };
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

    // The bundle signature covers `aud` (this pod's origin). A bundle signed
    // for another pod fails here even if the device key is valid.
    this._aud = this.resolveAud(request);
    if (this._audError) {
      return jsonResp(401, { error: "auth_failed", reason: this._audError });
    }
    const verdict = await verifySignedBundle(bundle, null, REPLAY_WINDOW_MS, this._aud || null);
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
    // as the owner (TOFU), and only while SETUP_TOKEN matches when that
    // secret is set. Every later device must already be authorized, or must
    // present a recovery signature to re-pair or reset the allowlist.
    this._recoveryAction = null;
    if (!this.isAuthorizedDevice(publicKeyHex)) {
      if (this.deviceCount() === 0) {
        if (!(await this.tofuAllowed(bundle))) {
          return jsonResp(401, { error: "auth_failed", reason: "setup_required" });
        }
        this.enrollDevice(publicKeyHex, "owner");
        this.setMeta(META_KEY_PUBKEY, publicKeyHex);
        this.setMeta(META_KEY_SESSION, sessionId);
        this.setMeta(META_KEY_CREATED, new Date().toISOString());
      } else if (await this.tryRecoverDevice(payload, publicKeyHex)) {
        this._recoveryAction = "recover";
      } else if (await this.tryResetDevices(payload, publicKeyHex)) {
        this._recoveryAction = "reset";
      } else {
        return jsonResp(401, { error: "auth_failed", reason: "device_not_authorized" });
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
      console.error("pod handler failed", e?.message || e);
      return jsonResp(500, { error: "handler_failed" });
    }
  }

  async dispatch(verb, path, data) {
    const now = new Date().toISOString();

    if (verb === "PROVISION") {
      return this.provision(data);
    }

    // ---- device pairing ----------------------------------------------------
    if (verb === "PUT" && path === "/devices/authorize") {
      const edPub = String(data.ed_pub || "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(edPub)) {
        return { status: 400, body: { error: "invalid_ed_pub" } };
      }
      // Signed by a device already on the allowlist: that device is the
      // confirmation. The full list is returned so the UI can warn.
      this.enrollDevice(edPub, data.label || "paired device");
      return { status: 200, body: { ok: true, ed_pub: edPub, rows: this.deviceRows() } };
    }
    if (verb === "DELETE" && path.startsWith("/devices/")) {
      const edPub = decodeURIComponent(path.slice("/devices/".length)).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(edPub)) {
        return { status: 400, body: { error: "invalid_ed_pub" } };
      }
      if (!this.isAuthorizedDevice(edPub)) {
        return { status: 404, body: { error: "device_not_found" } };
      }
      if (this.deviceCount() <= 1) {
        return { status: 409, body: { error: "last_device" } };
      }
      this.sql.exec(`DELETE FROM authorized_devices WHERE ed_pub_hex = ?`, edPub);
      return { status: 200, body: { ok: true, rows: this.deviceRows() } };
    }
    if (verb === "PUT" && path === "/devices/reset") {
      if (this._recoveryAction !== "reset") {
        const ok = await this.tryResetDevices({ verb, path, data }, this._device);
        if (!ok) {
          return { status: 401, body: { error: "auth_failed", reason: "recovery_required" } };
        }
      }
      return { status: 200, body: { ok: true, reset: true, rows: this.deviceRows() } };
    }
    if (verb === "LIST" && path === "/devices") {
      return { status: 200, body: { rows: this.deviceRows() } };
    }
    if (verb === "PUT" && path === "/devices/recover") {
      // Enrollment already happened in the recovery gate (tryRecoverDevice)
      // before dispatch; just acknowledge.
      return { status: 200, body: { ok: true, recovered: true, rows: this.deviceRows() } };
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
      if (!isDeliverablePodUrl(toPodUrl)) {
        return { status: 400, body: { error: "undeliverable_pod_url" } };
      }
      if (!this.destinationIsContact(toPodUrl)) {
        return { status: 403, body: { error: "peer_not_a_contact" } };
      }
      const envelopeJson =
        typeof data.envelope === "string" ? data.envelope : JSON.stringify(data.envelope || {});
      if (envelopeByteLength(envelopeJson) > MAX_ENVELOPE_BYTES) {
        return { status: 413, body: { error: "payload_too_large" } };
      }
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

    console.error("pod route not found", verb, path);
    return { status: 404, body: { error: "route_not_found" } };
  }

  /** True when the destination origin is one of this pod's stored contacts. */
  destinationIsContact(toPodUrl) {
    let target;
    try {
      target = new URL(toPodUrl);
    } catch {
      return false;
    }
    const rows = this.sql.exec(`SELECT pod_url FROM contacts`).toArray();
    return rows.some((row) => {
      try {
        return new URL(row.pod_url).origin === target.origin;
      } catch {
        return false;
      }
    });
  }

  /**
   * Keep unverified (message-request) mail bounded. Drop the oldest rows so
   * one unknown sender cannot fill the pod, and so the pending set stays
   * under the total cap.
   */
  trimUnknownSender(sender) {
    const rows = this.sql
      .exec(
        `SELECT msg_id, peer_handle FROM messages WHERE thread_id LIKE 'req:%' ORDER BY rowid ASC`
      )
      .toArray();
    const drop = new Set();
    const fromSender = rows.filter((row) => row.peer_handle === sender);
    const senderExcess = fromSender.length - (MAX_UNKNOWN_PER_SENDER - 1);
    if (senderExcess > 0) {
      for (const row of fromSender.slice(0, senderExcess)) drop.add(row.msg_id);
    }
    const remaining = rows.filter((row) => !drop.has(row.msg_id));
    const totalExcess = remaining.length - (MAX_UNKNOWN_TOTAL - 1);
    if (totalExcess > 0) {
      for (const row of remaining.slice(0, totalExcess)) drop.add(row.msg_id);
    }
    for (const msgId of drop) {
      this.sql.exec(`DELETE FROM messages WHERE msg_id = ?`, msgId);
    }
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
    if (kind === "group") {
      const groupId = String(envelope.groupId || "");
      const known = this.sql
        .exec(`SELECT group_id FROM groups WHERE group_id = ?`, groupId)
        .toArray();
      if (!known.length) return jsonResp(404, { error: "unknown_group" });
    }
    let unverified = false;
    if (kind === "dm") {
      const contact = this.contactFor(envelope.from);
      const keysMatch =
        contact &&
        contact.ed &&
        contact.ed === envelope.fromEd &&
        (!envelope.fromX || !contact.x || contact.x === envelope.fromX);
      // Unknown handles and key mismatches stay out of dm:<handle>.
      unverified = !keysMatch;
    }
    const threadId =
      kind === "group"
        ? `g:${envelope.groupId}`
        : unverified
          ? requestThreadId(envelope.from, envelope.fromEd)
          : `dm:${envelope.from}`;
    const msgId = envelope.sig.slice(0, 48);
    if (unverified) this.trimUnknownSender(envelope.from);
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
    return jsonResp(200, { ok: true, stored: true, thread_id: threadId, unverified });
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
      if (
        !isDeliverablePodUrl(row.to_pod_url) ||
        !this.destinationIsContact(row.to_pod_url) ||
        envelopeByteLength(row.envelope_json) > MAX_ENVELOPE_BYTES
      ) {
        this.sql.exec(
          `UPDATE outbox SET status = 'failed', last_error = ? WHERE out_id = ?`,
          "undeliverable_pod_url",
          row.out_id
        );
        failed++;
        continue;
      }
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

async function digestSecret(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(hash);
}

/** Timing-safe compare for the one-time setup token. Empty input never matches. */
async function secretsEqual(provided, expected) {
  if (!provided || !expected) return false;
  const a = await digestSecret(provided);
  const b = await digestSecret(expected);
  if (a.length !== b.length) return false;
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function jsonResp(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

/** Must match `requestThreadId` in forum-pod/src/messaging/client.js. */
function requestThreadId(from, fromEd) {
  return `req:${from || "unknown"}:${fromEd || "unknown"}`;
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
