/**
 * Live end-to-end test against two CF-hosted podlink pods.
 * Run: node scripts/cf-e2e-test.mjs   (from forum-pod/)
 *
 * Simulates Alice (pod A) and Bob (pod B): provision, exchange contacts,
 * send a 1:1 message A->B with store-and-forward delivery, confirm Bob can
 * decrypt, confirm the pod stored ciphertext only, exercise a group message,
 * and verify outbox retry against an unreachable pod.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { mnemonicToSeedSync, generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  ed25519KeyPairFromSeed,
  x25519KeyPairFromSeed,
  sealEnvelope,
  openDmEnvelope,
  openGroupEnvelope,
  randomGroupKey,
  bytesToHex,
  hexToBytes,
  canonical,
  b64encode,
} from "../src/messaging/crypto.js";

const pods = JSON.parse(readFileSync(new URL("../../scripts/.test-pods.json", import.meta.url)));
const A = pods["podlink-pod-a"];
const B = pods["podlink-pod-b"];
assert.ok(A && B, "need both pod URLs in scripts/.test-pods.json");

const enc = new TextEncoder();

function makeActor(podUrl, displayName) {
  // device signing key (for RPC auth)
  const devPriv = ed25519.utils.randomSecretKey();
  const devPubHex = bytesToHex(ed25519.getPublicKey(devPriv));
  // messaging identity (from a phrase)
  const seed = mnemonicToSeedSync(generateMnemonic(wordlist, 128)).slice(0, 32);
  const ed = ed25519KeyPairFromSeed(seed);
  const x = x25519KeyPairFromSeed(seed);
  const handle = "pk-" + bytesToHex(sha256(hexToBytes(ed.publicKeyHex))).slice(0, 16);
  const podId = "pod-" + bytesToHex(sha256(hexToBytes(ed.publicKeyHex))).slice(0, 32);
  return {
    podUrl,
    displayName,
    devPriv,
    devPubHex,
    handle,
    podId,
    self: {
      handle,
      edPrivateKey: ed.privateKey,
      edPublicKeyHex: ed.publicKeyHex,
      xPrivateKey: x.privateKey,
      xPublicKeyHex: x.publicKeyHex,
    },
    card: { handle, displayName, podUrl, ed: ed.publicKeyHex, x: x.publicKeyHex },
  };
}

async function sessionIdFor(devPubHex) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(devPubHex));
  return "pubkey:" + bytesToHex(new Uint8Array(digest));
}

async function rpc(actor, verb, path, data = null) {
  const payload = { verb, path, data };
  const sessionId = await sessionIdFor(actor.devPubHex);
  const timestamp = new Date().toISOString();
  const message = canonical({ payload, sessionId, timestamp });
  const signature = bytesToHex(ed25519.sign(enc.encode(message), actor.devPriv));
  const bundle = {
    payload,
    sessionId,
    timestamp,
    signature,
    publicKeyHex: actor.devPubHex,
    podId: actor.podId,
    deviceCredentialId: null,
  };
  const res = await fetch(`${actor.podUrl}/api/pod${path === "/" ? "" : path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bundle),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${verb} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForMessages(actor, threadId, n, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await rpc(actor, "LIST", "/messages", { thread_id: threadId });
    if (res.rows.length >= n) return res.rows;
    await sleep(1000);
  }
  const res = await rpc(actor, "LIST", "/messages", { thread_id: threadId });
  return res.rows;
}

async function postInboxDirect(podUrl, envelope) {
  const res = await fetch(`${podUrl}/api/inbox`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const alice = makeActor(A, "Alice");
const bob = makeActor(B, "Bob");

console.log("Alice handle:", alice.handle, "\nBob handle:  ", bob.handle, "\n");

// 1. provision both pods (enroll recovery key = identity Ed25519 pubkey)
await rpc(alice, "PROVISION", "/", { handle: alice.handle, pod_id: alice.podId, recovery_pub: alice.self.edPublicKeyHex });
await rpc(bob, "PROVISION", "/", { handle: bob.handle, pod_id: bob.podId, recovery_pub: bob.self.edPublicKeyHex });
console.log("[ok] both pods provisioned");

// 2. exchange contacts (each stores the other in their own pod)
await rpc(alice, "PUT", `/contacts/${bob.handle}`, {
  display_name: bob.displayName, pod_url: bob.card.podUrl, ed: bob.card.ed, x: bob.card.x,
});
await rpc(bob, "PUT", `/contacts/${alice.handle}`, {
  display_name: alice.displayName, pod_url: alice.card.podUrl, ed: alice.card.ed, x: alice.card.x,
});
const aliceContacts = await rpc(alice, "LIST", "/contacts");
assert.ok(aliceContacts.rows.find((r) => r.handle === bob.handle), "Alice has Bob");
console.log("[ok] contacts exchanged");

// 3. Alice -> Bob 1:1 with store-and-forward
const threadId = `dm:${bob.handle}`;
const recipientEnv = sealEnvelope(alice.self, { kind: "dm", toHandle: bob.handle, xPublicKeyHex: bob.card.x, threadId }, { body: "hello bob — e2e over CF" });
const selfEnv = sealEnvelope(alice.self, { kind: "dm", toHandle: alice.handle, xPublicKeyHex: alice.self.xPublicKeyHex, threadId }, { body: "hello bob — e2e over CF" });
const msgId = recipientEnv.sig.slice(0, 48);
await rpc(alice, "PUT", `/messages/${msgId}`, { thread_id: threadId, kind: "dm", direction: "out", peer_handle: bob.handle, envelope: selfEnv });
await rpc(alice, "PUT", `/outbox/${msgId}`, { to_pod_url: bob.podUrl, envelope: recipientEnv });
await rpc(alice, "POST", "/outbox/flush");
console.log("[ok] Alice queued + flushed outbox");

// 4. Bob reads + decrypts (store-and-forward; poll for arrival)
const bobThread = `dm:${alice.handle}`;
const bobMsgs = await waitForMessages(bob, bobThread, 1);
assert.strictEqual(bobMsgs.length, 1, "Bob has 1 inbound message");
const inbound = JSON.parse(bobMsgs[0].envelope_json);
// ciphertext-only check: no plaintext present in stored envelope
assert.ok(inbound.ct && !("body" in inbound) && !inbound.plaintext, "stored envelope is ciphertext-only");
const opened = openDmEnvelope(bob.self, inbound);
assert.strictEqual(opened.body, "hello bob — e2e over CF", "Bob decrypts Alice's message");
console.log("[ok] Bob decrypted 1:1 message; pod stored ciphertext only");

// 5. group message (shared key) A -> B
const groupId = "g-" + bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
const gkey = randomGroupKey();
const genv = sealEnvelope(alice.self, { kind: "group", groupId, rawGroupKey: gkey }, { body: "group hello" });
const gmsgId = genv.sig.slice(0, 48);
await rpc(alice, "PUT", `/outbox/${gmsgId}-${bob.handle}`, { to_pod_url: bob.podUrl, envelope: genv });
await rpc(alice, "POST", "/outbox/flush");
const bobGroupMsgs = await waitForMessages(bob, `g:${groupId}`, 1);
assert.strictEqual(bobGroupMsgs.length, 1, "Bob has group message");
const gOpened = openGroupEnvelope(gkey, JSON.parse(bobGroupMsgs[0].envelope_json));
assert.strictEqual(gOpened.body, "group hello", "Bob decrypts group message");
console.log("[ok] group message delivered + decrypted");

// 6. inbox rejects tampered ciphertext (bad signature)
const tampered = { ...recipientEnv, ct: recipientEnv.ct.slice(0, -2) + "AA" };
const rej = await postInboxDirect(bob.podUrl, tampered);
assert.strictEqual(rej.status, 401, "tampered envelope rejected by inbox");
console.log("[ok] inbox rejects tampered envelope:", rej.status, rej.body?.error);

// 7. outbox retry against an unreachable pod
const badEnv = sealEnvelope(alice.self, { kind: "dm", toHandle: bob.handle, xPublicKeyHex: bob.card.x, threadId }, { body: "to nowhere" });
const badId = badEnv.sig.slice(0, 48);
await rpc(alice, "PUT", `/outbox/${badId}`, { to_pod_url: "https://podlink-nonexistent-xyz.workers.dev", envelope: badEnv });
await rpc(alice, "POST", "/outbox/flush");
const outbox = await rpc(alice, "LIST", "/outbox");
const failing = outbox.rows.find((r) => r.out_id === badId);
assert.ok(failing && failing.attempts >= 1 && failing.status === "pending", "failed delivery is pending with retry scheduled");
console.log("[ok] outbox retry/backoff engaged for unreachable pod (attempts:", failing.attempts, ")");

// 8. pod-local recovery: a fresh device re-pairs using the recovery key
const newDevPriv = ed25519.utils.randomSecretKey();
const newDevPubHex = bytesToHex(ed25519.getPublicKey(newDevPriv));
const bobNewDevice = { ...bob, devPriv: newDevPriv, devPubHex: newDevPubHex };
let rejectedBeforeRecovery = false;
try {
  await rpc(bobNewDevice, "LIST", "/contacts");
} catch (e) {
  rejectedBeforeRecovery = /device_not_authorized|401/.test(e.message);
}
assert.ok(rejectedBeforeRecovery, "fresh device rejected before recovery");
const rts = new Date().toISOString();
const rsig = bytesToHex(
  ed25519.sign(enc.encode(canonical({ action: "recover-device", ed_pub: newDevPubHex, ts: rts })), bob.self.edPrivateKey)
);
await rpc(bobNewDevice, "PUT", "/devices/recover", { ed_pub: newDevPubHex, ts: rts, recovery_sig: rsig });
const recoveredList = await rpc(bobNewDevice, "LIST", "/contacts");
assert.ok(Array.isArray(recoveredList.rows), "recovered device can use the pod");
console.log("[ok] pod-local recovery: fresh device re-paired via recovery key");

console.log("\nALL CF END-TO-END TESTS PASSED");
