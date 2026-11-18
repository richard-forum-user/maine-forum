// P0-4 and P0-5. A forged sender must not land in a contact's thread, and a
// group-key control message from someone off the roster must not replace the key.
import test from "node:test";
import assert from "node:assert/strict";
import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

const { ed25519KeyPairFromSeed, x25519KeyPairFromSeed, sealEnvelope, b64encode, randomGroupKey } =
  await import("../src/messaging/crypto.js");
const {
  decryptRow,
  requestThreadId,
  getGroupRawKey,
  acceptGroupKeyChange,
  groupKeyDecision,
  contactKeysChanged,
} = await import("../src/messaging/client.js");
const { signBundle } = await import("../src/pod-signing.js");
const { verifySignedBundle } = await import("../../forum-pod-airlock/pod-signing-web.js");

function person(podUrl) {
  const seed = mnemonicToSeedSync(generateMnemonic(wordlist, 128)).slice(0, 32);
  const ed = ed25519KeyPairFromSeed(seed);
  const x = x25519KeyPairFromSeed(seed);
  return {
    handle: "pk-" + ed.publicKeyHex.slice(0, 16),
    edPrivateKey: ed.privateKey,
    edPublicKeyHex: ed.publicKeyHex,
    xPrivateKey: x.privateKey,
    xPublicKeyHex: x.publicKeyHex,
    podUrl,
  };
}

function rowFrom(envelope) {
  return { direction: "in", envelope_json: JSON.stringify(envelope) };
}

test("P0-2 client bundles are bound to the pod audience", async () => {
  const audA = "https://pod-a.example";
  const signed = await signBundle({ verb: "LIST", path: "/devices", data: null }, null, audA);
  const ok = await verifySignedBundle(signed, null, 5 * 60 * 1000, audA);
  assert.equal(ok.valid, true);
  const other = await verifySignedBundle(signed, null, 5 * 60 * 1000, "https://pod-b.example");
  assert.equal(other.valid, false);
  assert.equal(other.reason, "aud_mismatch");
  const tampered = { ...signed, aud: "https://pod-b.example" };
  const flipped = await verifySignedBundle(tampered, null, 5 * 60 * 1000, "https://pod-b.example");
  assert.equal(flipped.valid, false);
  assert.equal(flipped.reason, "signature_invalid");
});

test("P0-4 a different key does not render in the contact thread", () => {
  const alice = person("https://alice.example");
  const bob = person("https://bob.example");
  const mallory = person("https://mallory.example");
  const contacts = {
    [alice.handle]: { handle: alice.handle, ed: alice.edPublicKeyHex, x: alice.xPublicKeyHex },
  };

  const real = sealEnvelope(
    alice,
    { kind: "dm", toHandle: bob.handle, xPublicKeyHex: bob.xPublicKeyHex },
    { body: "hello from alice" }
  );
  const good = decryptRow(bob, rowFrom(real), contacts);
  assert.equal(good.body, "hello from alice");
  assert.equal(good.unverified, undefined);
  assert.equal(good.threadId, `dm:${alice.handle}`);

  const forged = sealEnvelope(
    { ...mallory, handle: alice.handle },
    { kind: "dm", toHandle: bob.handle, xPublicKeyHex: bob.xPublicKeyHex },
    { body: "I am alice" }
  );
  const bad = decryptRow(bob, rowFrom(forged), contacts);
  assert.equal(bad.unverified, true);
  assert.equal(bad.bucket, "requests");
  assert.equal(bad.threadId, requestThreadId(alice.handle, mallory.edPublicKeyHex));
  assert.notEqual(bad.threadId, `dm:${alice.handle}`);
  assert.ok(String(bad.threadId).startsWith("req:"));
});

test("P0-5 a group-key from a non-roster sender leaves the stored key", () => {
  const alice = person("https://alice.example");
  const bob = person("https://bob.example");
  const mallory = person("https://mallory.example");
  const groupId = "g-family";
  const current = b64encode(randomGroupKey());
  const stolen = b64encode(randomGroupKey());
  localStorage.setItem(
    "podlink.groupKeys",
    JSON.stringify({
      [groupId]: { key: current, epoch: 2, roster: [alice.handle, bob.handle], creator: alice.handle },
    })
  );

  const forged = sealEnvelope(
    mallory,
    { kind: "dm", toHandle: bob.handle, xPublicKeyHex: bob.xPublicKeyHex },
    { type: "group-key", groupId, title: "Family", key: stolen, epoch: 3, roster: [mallory.handle, bob.handle] }
  );
  const contacts = {
    [mallory.handle]: { handle: mallory.handle, ed: mallory.edPublicKeyHex, x: mallory.xPublicKeyHex },
  };
  const dec = decryptRow(bob, rowFrom(forged), contacts);
  assert.equal(dec.groupKeyIgnored, true);
  assert.equal(dec.reason, "not_on_roster");
  assert.equal(dec.groupKeyPrompt, null);
  assert.equal(b64encode(getGroupRawKey(groupId)), current);

  const stranger = sealEnvelope(
    { ...mallory, handle: alice.handle },
    { kind: "dm", toHandle: bob.handle, xPublicKeyHex: bob.xPublicKeyHex },
    { type: "group-key", groupId, title: "Family", key: stolen, epoch: 4, roster: [alice.handle] }
  );
  const asAlice = decryptRow(bob, rowFrom(stranger), {
    [alice.handle]: { handle: alice.handle, ed: alice.edPublicKeyHex, x: alice.xPublicKeyHex },
  });
  assert.equal(asAlice.unverified, true);
  assert.notEqual(asAlice.threadId, `dm:${alice.handle}`);
  assert.equal(b64encode(getGroupRawKey(groupId)), current);
});

test("P0-5 a roster member cannot overwrite a group key without a prompt", () => {
  const alice = person("https://alice.example");
  const bob = person("https://bob.example");
  const groupId = "g-family";
  const current = b64encode(randomGroupKey());
  const rotated = b64encode(randomGroupKey());
  localStorage.setItem(
    "podlink.groupKeys",
    JSON.stringify({
      [groupId]: { key: current, epoch: 1, roster: [alice.handle, bob.handle], creator: alice.handle },
    })
  );
  const decision = groupKeyDecision(
    { key: current, epoch: 1, roster: [alice.handle, bob.handle], creator: alice.handle },
    { senderHandle: alice.handle, senderVerified: true, key: rotated, epoch: 2, roster: [alice.handle, bob.handle] }
  );
  assert.equal(decision.prompt, true);
  assert.equal(decision.accept, false);

  const env = sealEnvelope(
    alice,
    { kind: "dm", toHandle: bob.handle, xPublicKeyHex: bob.xPublicKeyHex },
    { type: "group-key", groupId, title: "Family", key: rotated, epoch: 2, roster: [{ handle: alice.handle }, { handle: bob.handle }] }
  );
  const dec = decryptRow(bob, rowFrom(env), {
    [alice.handle]: { handle: alice.handle, ed: alice.edPublicKeyHex, x: alice.xPublicKeyHex },
  });
  assert.equal(dec.groupKeyPrompt?.groupId, groupId);
  assert.equal(b64encode(getGroupRawKey(groupId)), current);
  acceptGroupKeyChange(groupId, dec.groupKeyPrompt);
  assert.equal(b64encode(getGroupRawKey(groupId)), rotated);

  const stored = {
    key: rotated,
    epoch: 2,
    roster: [alice.handle, bob.handle],
    creator: alice.handle,
  };
  const downgrade = groupKeyDecision(stored, {
    senderHandle: alice.handle,
    senderVerified: true,
    key: current,
    epoch: 1,
    roster: [alice.handle, bob.handle],
  });
  assert.equal(downgrade.reason, "epoch_downgrade");
  assert.equal(downgrade.accept, false);
});

test("contact key replacement is visible before it is accepted", () => {
  const existing = { handle: "pk-a", ed: "aa", x: "bb" };
  assert.equal(contactKeysChanged(existing, { handle: "pk-a", ed: "aa", x: "bb" }), false);
  assert.equal(contactKeysChanged(existing, { handle: "pk-a", ed: "cc", x: "bb" }), true);
  assert.equal(contactKeysChanged(null, { handle: "pk-a", ed: "aa", x: "bb" }), false);
});
