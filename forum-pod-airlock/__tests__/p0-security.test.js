// P0-1, P0-2, and P0-3 against the worker and Durable Object.
import test from "node:test";
import assert from "node:assert/strict";
import { verifySignedBundle, canonicalise } from "../pod-signing-web.js";
import {
  PIN,
  AUD_A,
  AUD_B,
  makeEnv,
  makeDevice,
  postPod,
  signBundle,
  signEnvelope,
  postInbox,
  signBytes,
  testNonce,
  testCt,
} from "./harness.js";

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
  await postPod(env, owner, {
    verb: "PUT",
    path: "/groups/g-family",
    data: { title: "Family", sealed_key: "c2VhbGVk", roster_json: "[]" },
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
    nonce: testNonce(1),
    ct: testCt(1),
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
    nonce: testNonce(2),
    ct: testCt(2),
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
    nonce: testNonce(3),
    ct: testCt(3),
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
    nonce: testNonce(4),
    ct: testCt(4),
  });
  const ok = await postInbox(env, genuine);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.unverified, false);
  assert.equal(ok.body.thread_id, "dm:pk-alice");
});
