// In-memory stand-ins for D1 and Durable Object SQL. No live Cloudflare credentials.
import worker, { PersonalPodDO } from "../secure-worker.js";
import { canonicalise } from "../pod-signing-web.js";
import { expectedSessionIdFromPubkey } from "../session-binding.js";

export const PIN = "0123456789abcdeffedcba9876543210";
export const AUD_A = "https://pod-a.example";
export const AUD_B = "https://pod-b.example";

export function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64urlToBytes(s) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(pad);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function b64FromBytes(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

export function testNonce(fill = 9) {
  return b64FromBytes(new Uint8Array(24).fill(fill & 255));
}

export function testCt(fill = 3) {
  return b64FromBytes(new Uint8Array(16).fill(fill & 255));
}

function cursor(rows, rowsWritten = 0) {
  return {
    rowsWritten,
    toArray() {
      return rows;
    },
    one() {
      return rows[0];
    },
  };
}

class MemorySql {
  constructor() {
    this.meta = new Map();
    this.devices = [];
    this.replay = new Map();
    this.contacts = [];
    this.groups = [];
    this.messages = [];
    this.outbox = [];
    this.nextRow = 1;
  }

  exec(sql, ...params) {
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm.startsWith("CREATE") || norm.startsWith("DROP")) return cursor([]);
    if (norm.startsWith("SELECT value FROM pod_meta")) {
      const value = this.meta.get(params[0]);
      return cursor(value == null ? [] : [{ value }]);
    }
    if (norm.startsWith("INSERT OR REPLACE INTO pod_meta")) {
      this.meta.set(params[0], params[1]);
      return cursor([], 1);
    }
    if (norm.startsWith("SELECT COUNT(*) AS n FROM authorized_devices")) {
      return cursor([{ n: this.devices.length }]);
    }
    if (norm.startsWith("SELECT 1 FROM authorized_devices")) {
      const hit = this.devices.some((d) => d.ed_pub_hex === params[0]);
      return cursor(hit ? [{ ok: 1 }] : []);
    }
    if (norm.startsWith("INSERT OR IGNORE INTO authorized_devices")) {
      const [ed_pub_hex, label, added_at] = params;
      if (this.devices.some((d) => d.ed_pub_hex === ed_pub_hex)) return cursor([], 0);
      this.devices.push({ ed_pub_hex, label, added_at });
      return cursor([], 1);
    }
    if (norm.startsWith("SELECT ed_pub_hex, label, added_at FROM authorized_devices")) {
      return cursor(this.devices.map((d) => ({ ...d })));
    }
    if (norm.startsWith("DELETE FROM authorized_devices WHERE")) {
      const before = this.devices.length;
      this.devices = this.devices.filter((d) => d.ed_pub_hex !== params[0]);
      return cursor([], before === this.devices.length ? 0 : 1);
    }
    if (norm === "DELETE FROM authorized_devices") {
      this.devices = [];
      return cursor([]);
    }
    if (norm.startsWith("DELETE FROM replay_cache")) {
      for (const [sig, row] of this.replay) {
        if (row.seen_at_ms < params[0]) this.replay.delete(sig);
      }
      return cursor([]);
    }
    if (norm.startsWith("INSERT OR IGNORE INTO replay_cache")) {
      const [signature, session_id, seen_at_ms] = params;
      if (this.replay.has(signature)) return cursor([], 0);
      this.replay.set(signature, { session_id, seen_at_ms });
      return cursor([], 1);
    }
    if (norm.startsWith("INSERT INTO contacts")) {
      const [handle, display_name, pod_url, ed, x, added_at, updated_at] = params;
      const row = { handle, display_name, pod_url, ed, x, added_at, updated_at };
      const i = this.contacts.findIndex((c) => c.handle === handle);
      if (i >= 0) this.contacts[i] = row;
      else this.contacts.push(row);
      return cursor([], 1);
    }
    if (norm === "SELECT pod_url FROM contacts") {
      return cursor(this.contacts.map((c) => ({ pod_url: c.pod_url })));
    }
    if (norm.includes("FROM contacts WHERE handle")) {
      const row = this.contacts.find((c) => c.handle === params[0]);
      return cursor(row ? [row] : []);
    }
    if (norm.startsWith("INSERT INTO groups")) {
      const [group_id, title, sealed_key, roster_json, created_at, updated_at] = params;
      const row = { group_id, title, sealed_key, roster_json, created_at, updated_at };
      const i = this.groups.findIndex((g) => g.group_id === group_id);
      if (i >= 0) this.groups[i] = row;
      else this.groups.push(row);
      return cursor([], 1);
    }
    if (norm.includes("FROM groups WHERE group_id")) {
      const row = this.groups.find((g) => g.group_id === params[0]);
      return cursor(row ? [row] : []);
    }
    if (norm.startsWith("INSERT OR REPLACE INTO outbox")) {
      const [out_id, to_pod_url, envelope_json, created_at] = params;
      const row = {
        out_id,
        to_pod_url,
        envelope_json,
        status: "pending",
        attempts: 0,
        next_attempt_at_ms: 0,
        last_error: null,
        created_at,
      };
      const i = this.outbox.findIndex((o) => o.out_id === out_id);
      if (i >= 0) this.outbox[i] = row;
      else this.outbox.push(row);
      return cursor([], 1);
    }
    if (norm.startsWith("INSERT OR IGNORE INTO messages")) {
      const [msg_id, thread_id, kind, peer_handle, group_id, envelope_json, created_at] = params;
      if (!this.messages.some((m) => m.msg_id === msg_id)) {
        this.messages.push({
          msg_id,
          thread_id,
          kind,
          direction: "in",
          peer_handle,
          group_id,
          envelope_json,
          created_at,
          rowid: this.nextRow++,
        });
      }
      return cursor([], 1);
    }
    if (norm.startsWith("DELETE FROM messages WHERE msg_id")) {
      this.messages = this.messages.filter((m) => m.msg_id !== params[0]);
      return cursor([]);
    }
    if (norm.includes("thread_id LIKE")) {
      const rows = this.messages
        .filter((m) => String(m.thread_id).startsWith("req:"))
        .sort((a, b) => a.rowid - b.rowid)
        .map((m) => ({ msg_id: m.msg_id, peer_handle: m.peer_handle }));
      return cursor(rows);
    }
    if (norm.includes("FROM messages WHERE thread_id")) {
      const [threadId, after] = params;
      return cursor(this.messages.filter((m) => m.thread_id === threadId && m.created_at > after));
    }
    if (norm.includes("FROM messages WHERE created_at")) {
      return cursor(this.messages.filter((m) => m.created_at > params[0]));
    }
    throw new Error(`unhandled DO SQL: ${norm}`);
  }
}

export class MemoryD1 {
  constructor() {
    this.podOwner = [];
    this.rates = [];
    this.usage = [];
  }

  prepare(sql) {
    const text = sql.replace(/\s+/g, " ").trim();
    const run = async (...args) => {
      this.#apply(text, args);
      return { success: true };
    };
    return {
      run,
      bind: (...args) => ({
        run: async () => run(...args),
        first: async () => this.#apply(text, args),
      }),
    };
  }

  #apply(sql, args) {
    if (sql.startsWith("CREATE TABLE")) return null;
    if (sql.startsWith("INSERT INTO pod_owner")) {
      const [handle, pod_id, updated_at] = args;
      const i = this.podOwner.findIndex((r) => r.handle === handle);
      const row = { handle, pod_id, updated_at };
      if (i >= 0) this.podOwner[i] = row;
      else this.podOwner.push(row);
      return null;
    }
    if (sql.startsWith("INSERT INTO edge_rate_limits")) {
      const [bucket, window_start_ms] = args;
      let row = this.rates.find((r) => r.bucket === bucket && r.window_start_ms === window_start_ms);
      if (row) row.count += 1;
      else {
        row = { bucket, window_start_ms, count: 1 };
        this.rates.push(row);
      }
      return { count: row.count };
    }
    if (sql.startsWith("DELETE FROM edge_rate_limits")) {
      const cutoff = args[0];
      this.rates = this.rates.filter((r) => r.window_start_ms >= cutoff);
      return null;
    }
    if (sql.startsWith("INSERT INTO pod_usage_windows")) {
      const [session_id, window_start_ms] = args;
      let row = this.usage.find((r) => r.session_id === session_id && r.window_start_ms === window_start_ms);
      if (row) row.write_count += 1;
      else {
        row = { session_id, window_start_ms, write_count: 1 };
        this.usage.push(row);
      }
      return { write_count: row.write_count };
    }
    if (sql.startsWith("DELETE FROM pod_usage_windows")) {
      const cutoff = args[0];
      this.usage = this.usage.filter((r) => r.window_start_ms >= cutoff);
      return null;
    }
    if (sql.startsWith("SELECT handle, pod_id FROM pod_owner WHERE handle")) {
      return this.podOwner.find((r) => r.handle === args[0]) || null;
    }
    if (sql.includes("ORDER BY updated_at")) {
      throw new Error("most-recent owner fallback must not run");
    }
    if (sql.startsWith("SELECT count FROM edge_rate_limits")) {
      const row = this.rates.find((r) => r.bucket === args[0] && r.window_start_ms === args[1]);
      return row ? { count: row.count } : null;
    }
    if (sql.startsWith("SELECT write_count FROM pod_usage_windows")) {
      const row = this.usage.find((r) => r.session_id === args[0] && r.window_start_ms === args[1]);
      return row ? { write_count: row.write_count } : null;
    }
    throw new Error(`unhandled D1: ${sql}`);
  }
}

function createNamespace(env) {
  const byName = new Map();
  const names = [];
  return {
    names,
    idFromName(name) {
      const id = String(name);
      names.push(id);
      return { name: id, toString: () => id };
    },
    get(id) {
      const name = id.name || String(id);
      if (!byName.has(name)) {
        const state = {
          blockConcurrencyWhile: (fn) => Promise.resolve().then(fn),
          storage: {
            sql: new MemorySql(),
            getAlarm: async () => null,
            setAlarm: async () => {},
          },
        };
        byName.set(name, new PersonalPodDO(state, env));
      }
      return { fetch: (req) => byName.get(name).fetch(req) };
    },
  };
}

export function makeEnv({ setupToken = "" } = {}) {
  const env = {
    OWNER_POD_ID: PIN,
    PUBLIC_POD_URL: AUD_A,
    SETUP_TOKEN: setupToken,
    DB: new MemoryD1(),
  };
  env.POD = createNamespace(env);
  return env;
}

export async function makeDevice() {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const publicKeyHex = bytesToHex(b64urlToBytes(jwk.x));
  const sessionId = await expectedSessionIdFromPubkey(publicKeyHex);
  return { keyPair, publicKeyHex, sessionId };
}

export async function signBytes(privateKey, text) {
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(text));
  return bytesToHex(sig);
}

export async function signBundle(device, payload, aud) {
  const timestamp = new Date().toISOString();
  const { sessionId, publicKeyHex } = device;
  const message = canonicalise({ payload, sessionId, timestamp, aud });
  const signature = await signBytes(device.keyPair.privateKey, message);
  return { payload, sessionId, timestamp, aud, signature, publicKeyHex };
}

export async function postPod(env, device, payload, { aud = AUD_A, podId, setupToken, ip = "203.0.113.10" } = {}) {
  const bundle = await signBundle(device, payload, aud);
  if (podId !== undefined) bundle.podId = podId;
  if (setupToken) bundle.setupToken = setupToken;
  const headers = { "Content-Type": "application/json" };
  if (ip) headers["CF-Connecting-IP"] = ip;
  const res = await worker.fetch(
    new Request(`${AUD_A}/api/pod`, {
      method: "POST",
      headers,
      body: JSON.stringify(bundle),
    }),
    env
  );
  return { status: res.status, body: await res.json(), headers: res.headers };
}

export async function signEnvelope(device, fields) {
  const core = { ts: new Date().toISOString(), ...fields, fromEd: device.publicKeyHex };
  const sig = await signBytes(device.keyPair.privateKey, canonicalise(core));
  return { ...core, sig };
}

export async function postInbox(env, envelope, ip = "203.0.113.20") {
  const headers = { "Content-Type": "application/json" };
  if (ip) headers["CF-Connecting-IP"] = ip;
  const body = typeof envelope === "string" ? envelope : JSON.stringify(envelope);
  const res = await worker.fetch(
    new Request(`${AUD_A}/api/inbox`, {
      method: "POST",
      headers,
      body,
    }),
    env
  );
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

export { worker };
