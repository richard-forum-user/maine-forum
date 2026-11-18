// P0-1, P0-2, and P0-3 against the worker and Durable Object, with in-memory
// stand-ins for D1 and DO SQL. No live Cloudflare credentials.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { PersonalPodDO } from "../secure-worker.js";
import { canonicalise, verifySignedBundle } from "../pod-signing-web.js";
import { expectedSessionIdFromPubkey } from "../session-binding.js";

const PIN = "0123456789abcdeffedcba9876543210";
const AUD_A = "https://pod-a.example";
const AUD_B = "https://pod-b.example";

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64urlToBytes(s) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(pad);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
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
    this.messages = [];
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
    if (norm.includes("FROM contacts WHERE handle")) {
      const row = this.contacts.find((c) => c.handle === params[0]);
      return cursor(row ? [row] : []);
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
        });
      }
      return cursor([], 1);
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

class MemoryD1 {
  constructor() {
    this.podOwner = [];
    this.rates = [];
    this.usage = [];
  }

  prepare(sql) {
    const text = sql.replace(/\s+/g, " ").trim();
    const run = async (...args) => {
      this.#run(text, args);
      return { success: true };
    };
    return {
      run,
      bind: (...args) => ({
        run: async () => run(...args),
        first: async () => this.#first(text, args),
      }),
    };
  }

  #run(sql, args) {
    if (sql.startsWith("CREATE TABLE")) return;
    if (sql.startsWith("INSERT INTO pod_owner")) {
      const [handle, pod_id, updated_at] = args;
      const i = this.podOwner.findIndex((r) => r.handle === handle);
      const row = { handle, pod_id, updated_at };
      if (i >= 0) this.podOwner[i] = row;
      else this.podOwner.push(row);
      return;
    }
    if (sql.startsWith("INSERT INTO edge_rate_limits")) {
      const [bucket, window_start_ms] = args;
      const row = this.rates.find((r) => r.bucket === bucket && r.window_start_ms === window_start_ms);
      if (row) row.count += 1;
      else this.rates.push({ bucket, window_start_ms, count: 1 });
      return;
    }
    if (sql.startsWith("DELETE FROM edge_rate_limits")) return;
    if (sql.startsWith("INSERT INTO pod_usage_windows")) {
      const [session_id, window_start_ms] = args;
      const row = this.usage.find((r) => r.session_id === session_id && r.window_start_ms === window_start_ms);
      if (row) row.write_count += 1;
      else this.usage.push({ session_id, window_start_ms, write_count: 1 });
      return;
    }
    throw new Error(`unhandled D1 run: ${sql}`);
  }

  #first(sql, args) {
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
    throw new Error(`unhandled D1 first: ${sql}`);
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

function makeEnv({ setupToken = "" } = {}) {
  const env = {
    OWNER_POD_ID: PIN,
    PUBLIC_POD_URL: AUD_A,
    SETUP_TOKEN: setupToken,
    DB: new MemoryD1(),
  };
  env.POD = createNamespace(env);
  return env;
}

async function makeDevice() {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const publicKeyHex = bytesToHex(b64urlToBytes(jwk.x));
  const sessionId = await expectedSessionIdFromPubkey(publicKeyHex);
  return { keyPair, publicKeyHex, sessionId };
}

async function signBytes(privateKey, text) {
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(text));
  return bytesToHex(sig);
}

async function signBundle(device, payload, aud) {
  const timestamp = new Date().toISOString();
  const { sessionId, publicKeyHex } = device;
  const message = canonicalise({ payload, sessionId, timestamp, aud });
  const signature = await signBytes(device.keyPair.privateKey, message);
  return { payload, sessionId, timestamp, aud, signature, publicKeyHex };
}

async function postPod(env, device, payload, { aud = AUD_A, podId, setupToken, ip = "203.0.113.10" } = {}) {
  const bundle = await signBundle(device, payload, aud);
  if (podId !== undefined) bundle.podId = podId;
  if (setupToken) bundle.setupToken = setupToken;
  const res = await worker.fetch(
    new Request(`${AUD_A}/api/pod`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify(bundle),
    }),
    env
  );
  return { status: res.status, body: await res.json() };
}

async function signEnvelope(device, fields) {
  const core = { ...fields, fromEd: device.publicKeyHex };
  const sig = await signBytes(device.keyPair.privateKey, canonicalise(core));
  return { ...core, sig };
}

async function postInbox(env, envelope, ip = "203.0.113.20") {
  const res = await worker.fetch(
    new Request(`${AUD_A}/api/inbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify(envelope),
    }),
    env
  );
  return { status: res.status, body: await res.json() };
}

test("P0-2 a random podId does not create a second DO, and aud is bound to the pod", async () => {
  const env = makeEnv();
  const owner = await makeDevice();
  const namesAtStart = [...env.POD.names];

  const wrongPod = await postPod(
    env,
    owner,
    { verb: "LIST", path: "/devices", data: null },
    { podId: "attacker-chosen-pod" }
  );
  assert.equal(wrongPod.status, 403);
  assert.equal(wrongPod.body.error, "wrong_pod");
  assert.deepEqual(env.POD.names, namesAtStart);

  const wrongAud = await postPod(
    env,
    owner,
    { verb: "LIST", path: "/devices", data: null },
    { aud: AUD_B }
  );
  assert.equal(wrongAud.status, 401);
  assert.equal(wrongAud.body.reason, "aud_mismatch");
  assert.deepEqual(env.POD.names, namesAtStart);

  const signedForA = await signBundle(owner, { verb: "LIST", path: "/devices", data: null }, AUD_A);
  assert.equal((await verifySignedBundle(signedForA, null, 60_000, AUD_A)).valid, true);
  const onB = await verifySignedBundle(signedForA, null, 60_000, AUD_B);
  assert.equal(onB.valid, false);
  assert.equal(onB.reason, "aud_mismatch");
  const flipped = { ...signedForA, aud: AUD_B };
  assert.equal((await verifySignedBundle(flipped, null, 60_000, AUD_B)).reason, "signature_invalid");

  const ok = await postPod(env, owner, { verb: "LIST", path: "/devices", data: null });
  assert.equal(ok.status, 200);
  assert.deepEqual([...new Set(env.POD.names)], [PIN]);
});

test("P0-2 SETUP_TOKEN is required for the first enrollment when it is set", async () => {
  const env = makeEnv({ setupToken: "one-time-token" });
  const owner = await makeDevice();
  const denied = await postPod(env, owner, {
    verb: "PROVISION",
    path: "/",
    data: { handle: "pk-owner", recovery_pub: owner.publicKeyHex },
  });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.reason, "setup_required");
  assert.equal(env.DB.podOwner.length, 0);

  const allowed = await postPod(
    env,
    owner,
    { verb: "PROVISION", path: "/", data: { handle: "pk-owner", recovery_pub: owner.publicKeyHex } },
    { setupToken: "one-time-token" }
  );
  assert.equal(allowed.status, 200);
  assert.equal(env.DB.podOwner[0].pod_id, PIN);
  assert.deepEqual([...new Set(env.POD.names)], [PIN]);
});

test("P0-1 an unenrolled key cannot overwrite pod_owner", async () => {
  const env = makeEnv();
  const owner = await makeDevice();
  const recovery = await makeDevice();
  const provisioned = await postPod(env, owner, {
    verb: "PROVISION",
    path: "/",
    data: { handle: "pk-owner", pod_id: "client-picked-pod", recovery_pub: recovery.publicKeyHex },
  });
  assert.equal(provisioned.status, 200);
  assert.equal(provisioned.body.pod_id, PIN);
  assert.equal(provisioned.body.handle, "pk-owner");
  assert.equal(env.DB.podOwner.length, 1);
  assert.equal(env.DB.podOwner[0].pod_id, PIN);
  const before = env.DB.podOwner.map((r) => ({ ...r }));

  const attacker = await makeDevice();
  const hijack = await postPod(env, attacker, {
    verb: "PROVISION",
    path: "/",
    data: { handle: "pk-owner", pod_id: "attacker-do", recovery_pub: attacker.publicKeyHex },
  });
  assert.equal(hijack.status, 401);
  assert.equal(hijack.body.reason, "device_not_authorized");
  assert.deepEqual(env.DB.podOwner, before);
  assert.deepEqual([...new Set(env.POD.names)], [PIN]);
});

test("P0-1 group mail uses the pinned pod and ignores a newer foreign owner row", async () => {
  const env = makeEnv();
  const owner = await makeDevice();
  await postPod(env, owner, {
    verb: "PROVISION",
    path: "/",
    data: { handle: "pk-owner", recovery_pub: owner.publicKeyHex },
  });
  env.DB.podOwner.push({
    handle: "pk-attacker",
    pod_id: "attacker-do",
    updated_at: "2999-01-01T00:00:00.000Z",
  });
  env.POD.names.length = 0;

  const sender = await makeDevice();
  const envelope = await signEnvelope(sender, {
    v: 1,
    alg: "x25519-xchacha20poly1305-ed25519",
    kind: "group",
    from: "pk-stranger",
    nonce: "bm9uY2U",
    ct: "Y2lwaGVydGV4dA",
    groupId: "g-family",
  });
  const res = await postInbox(env, envelope);
  assert.equal(res.status, 200);
  assert.equal(res.body.thread_id, "g:g-family");
  assert.deepEqual([...new Set(env.POD.names)], [PIN]);

  env.DB.podOwner[0].pod_id = "attacker-do";
  const dm = await signEnvelope(sender, {
    v: 1,
    alg: "x25519-xchacha20poly1305-ed25519",
    kind: "dm",
    from: "pk-stranger",
    to: "pk-owner",
    nonce: "bm9uY2U",
    ct: "Y2lwaGVydGV4dA",
  });
  const missed = await postInbox(env, dm);
  assert.equal(missed.status, 503);
  assert.ok(!env.POD.names.includes("attacker-do"));
});

test("P0-3 recovery_pub is write-once and reset removes the old device", async () => {
  const env = makeEnv();
  const owner = await makeDevice();
  const recovery = await makeDevice();
  const otherRecovery = await makeDevice();
  await postPod(env, owner, {
    verb: "PROVISION",
    path: "/",
    data: { handle: "pk-owner", recovery_pub: recovery.publicKeyHex },
  });

  const renamed = await postPod(env, owner, {
    verb: "PROVISION",
    path: "/",
    data: { handle: "pk-attacker", recovery_pub: otherRecovery.publicKeyHex },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.handle, "pk-owner");
  assert.equal(env.DB.podOwner[0].handle, "pk-owner");
  assert.equal(env.DB.podOwner[0].pod_id, PIN);

  const again = await postPod(env, owner, {
    verb: "PROVISION",
    path: "/",
    data: { handle: "pk-owner", recovery_pub: otherRecovery.publicKeyHex },
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.handle, "pk-owner");
  assert.equal(again.body.pod_id, PIN);

  const fresh = await makeDevice();
  const ts = new Date().toISOString();
  const badSig = await signBytes(
    otherRecovery.keyPair.privateKey,
    canonicalise({ action: "recover-device", ed_pub: fresh.publicKeyHex, ts, aud: AUD_A })
  );
  const rejected = await postPod(env, fresh, {
    verb: "PUT",
    path: "/devices/recover",
    data: { ed_pub: fresh.publicKeyHex, ts, recovery_sig: badSig },
  });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.body.reason, "device_not_authorized");

  const ts2 = new Date().toISOString();
  const goodSig = await signBytes(
    recovery.keyPair.privateKey,
    canonicalise({ action: "recover-device", ed_pub: fresh.publicKeyHex, ts: ts2, aud: AUD_A })
  );
  const recovered = await postPod(env, fresh, {
    verb: "PUT",
    path: "/devices/recover",
    data: { ed_pub: fresh.publicKeyHex, ts: ts2, recovery_sig: goodSig },
  });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.recovered, true);

  const resetEnv = makeEnv();
  const deviceA = await makeDevice();
  const recovery2 = await makeDevice();
  await postPod(resetEnv, deviceA, {
    verb: "PROVISION",
    path: "/",
    data: { handle: "pk-owner", recovery_pub: recovery2.publicKeyHex },
  });
  const deviceB = await makeDevice();
  const resetTs = new Date().toISOString();
  const resetSig = await signBytes(
    recovery2.keyPair.privateKey,
    canonicalise({ action: "reset-devices", ed_pub: deviceB.publicKeyHex, ts: resetTs, aud: AUD_A })
  );
  const reset = await postPod(resetEnv, deviceB, {
    verb: "PUT",
    path: "/devices/reset",
    data: { ed_pub: deviceB.publicKeyHex, ts: resetTs, recovery_sig: resetSig },
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.reset, true);
  assert.equal(reset.body.rows.length, 1);
  assert.equal(reset.body.rows[0].ed_pub_hex, deviceB.publicKeyHex);

  const lockedOut = await postPod(resetEnv, deviceA, { verb: "LIST", path: "/devices", data: null });
  assert.equal(lockedOut.status, 401);
  assert.equal(lockedOut.body.reason, "device_not_authorized");
  const stillIn = await postPod(resetEnv, deviceB, { verb: "LIST", path: "/devices", data: null });
  assert.equal(stillIn.status, 200);
  assert.equal(stillIn.body.rows.length, 1);
});

test("P0-3 revoke cannot remove the last device", async () => {
  const env = makeEnv();
  const owner = await makeDevice();
  const recovery = await makeDevice();
  await postPod(env, owner, {
    verb: "PROVISION",
    path: "/",
    data: { handle: "pk-owner", recovery_pub: recovery.publicKeyHex },
  });
  const last = await postPod(env, owner, {
    verb: "DELETE",
    path: `/devices/${owner.publicKeyHex}`,
    data: null,
  });
  assert.equal(last.status, 409);
  assert.equal(last.body.error, "last_device");

  const second = await makeDevice();
  const authorized = await postPod(env, owner, {
    verb: "PUT",
    path: "/devices/authorize",
    data: { ed_pub: second.publicKeyHex, label: "laptop" },
  });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.body.rows.length, 2);

  const removed = await postPod(env, owner, {
    verb: "DELETE",
    path: `/devices/${second.publicKeyHex}`,
    data: null,
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.rows.length, 1);
  const gone = await postPod(env, second, { verb: "LIST", path: "/devices", data: null });
  assert.equal(gone.status, 401);
  assert.equal(gone.body.reason, "device_not_authorized");
});

test("P0-4 inbox files a mismatched sender outside the contact thread", async () => {
  const env = makeEnv();
  const owner = await makeDevice();
  const alice = await makeDevice();
  const mallory = await makeDevice();
  await postPod(env, owner, {
    verb: "PROVISION",
    path: "/",
    data: { handle: "pk-owner", recovery_pub: owner.publicKeyHex },
  });
  await postPod(env, owner, {
    verb: "PUT",
    path: "/contacts/pk-alice",
    data: { display_name: "Alice", pod_url: "https://alice.example", ed: alice.publicKeyHex, x: "ab".repeat(32) },
  });

  const forged = await signEnvelope(mallory, {
    v: 1,
    alg: "x25519-xchacha20poly1305-ed25519",
    kind: "dm",
    from: "pk-alice",
    to: "pk-owner",
    nonce: "bm9uY2U",
    ct: "Y2lwaGVydGV4dA",
  });
  const stored = await postInbox(env, forged);
  assert.equal(stored.status, 200);
  assert.equal(stored.body.unverified, true);
  assert.equal(stored.body.thread_id, `req:pk-alice:${mallory.publicKeyHex}`);
  assert.notEqual(stored.body.thread_id, "dm:pk-alice");

  const listed = await postPod(env, owner, {
    verb: "LIST",
    path: "/messages",
    data: { thread_id: stored.body.thread_id },
  });
  assert.equal(listed.body.rows.length, 1);
  assert.equal(listed.body.rows[0].thread_id, stored.body.thread_id);
  const contactThread = await postPod(env, owner, {
    verb: "LIST",
    path: "/messages",
    data: { thread_id: "dm:pk-alice" },
  });
  assert.equal(contactThread.body.rows.length, 0);

  const genuine = await signEnvelope(alice, {
    v: 1,
    alg: "x25519-xchacha20poly1305-ed25519",
    kind: "dm",
    from: "pk-alice",
    to: "pk-owner",
    fromX: "ab".repeat(32),
    nonce: "bm9uY2Uy",
    ct: "Y2lwaGVydGV4dDI",
  });
  const ok = await postInbox(env, genuine);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.unverified, false);
  assert.equal(ok.body.thread_id, "dm:pk-alice");
});
