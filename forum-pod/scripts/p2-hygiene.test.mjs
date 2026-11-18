// P2 canonical JSON and group-roster checks. No live Cloudflare credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { canonicalise } from "../../forum-pod-airlock/canonical-json.js";
import { canonicalise as workerCanonical } from "../../forum-pod-airlock/pod-signing-web.js";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

const { canonical, sealEnvelope, b64encode, randomGroupKey, ed25519KeyPairFromSeed, x25519KeyPairFromSeed } =
  await import("../src/messaging/crypto.js");
const { canonicalise: recoveryCanonical } = await import("../src/recovery-phrase.js");
const { decryptRow, groupSenderDecision } = await import("../src/messaging/client.js");

const NESTED = { z: 1, a: { d: true, b: { y: "n", x: 2 } }, list: [1, { b: 1, a: 2 }] };
const EXPECTED =
  '{"a":{"b":{"x":2,"y":"n"},"d":true},"list":[1,{"a":2,"b":1}],"z":1}';

test("P2-1 one recursive canonicalizer is shared by the client and the worker", () => {
  assert.equal(canonicalise(NESTED), EXPECTED);
  assert.equal(canonical(NESTED), EXPECTED);
  assert.equal(workerCanonical({ a: NESTED.a, list: NESTED.list, z: 1 }), EXPECTED);
  assert.equal(recoveryCanonical(NESTED), EXPECTED);
  for (const rel of [
    "forum-pod/src/messaging/crypto.js",
    "forum-pod/src/pod-signing.js",
    "forum-pod/src/recovery-phrase.js",
    "forum-pod-airlock/inbox-routes.js",
    "forum-pod-airlock/pod-do.js",
    "forum-pod-airlock/pod-signing-web.js",
  ]) {
    const src = readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
    assert.match(src, /canonical-json\.js/, rel);
  }
});

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

test("P2-4 a group member cannot speak as another member", () => {
  const alice = person("https://alice.example");
  const bob = person("https://bob.example");
  const mallory = person("https://mallory.example");
  const groupId = "g-family";
  const raw = randomGroupKey();
  localStorage.setItem(
    "podlink.groupKeys",
    JSON.stringify({
      [groupId]: {
        key: b64encode(raw),
        epoch: 1,
        roster: [
          { handle: alice.handle, ed: alice.edPublicKeyHex },
          { handle: bob.handle, ed: bob.edPublicKeyHex },
        ],
        creator: alice.handle,
      },
    })
  );

  const real = sealEnvelope(alice, { kind: "group", groupId, rawGroupKey: raw }, { body: "hello group" });
  const shown = decryptRow(bob, { direction: "in", envelope_json: JSON.stringify(real) }, {});
  assert.equal(shown.body, "hello group");
  assert.equal(shown.unverified, undefined);

  const spoof = sealEnvelope(
    { ...mallory, handle: alice.handle },
    { kind: "group", groupId, rawGroupKey: raw },
    { body: "I am alice" }
  );
  const hidden = decryptRow(bob, { direction: "in", envelope_json: JSON.stringify(spoof) }, {});
  assert.equal(hidden.unverified, true);
  assert.equal(hidden.reason, "sender_key_mismatch");
  assert.equal(hidden.body, null);
  assert.equal(hidden.threadId, `g:${groupId}`);

  const outsider = sealEnvelope(
    mallory,
    { kind: "group", groupId, rawGroupKey: raw },
    { body: "not a member" }
  );
  const rejected = decryptRow(bob, { direction: "in", envelope_json: JSON.stringify(outsider) }, {});
  assert.equal(rejected.reason, "not_on_roster");
  assert.equal(rejected.body, null);

  const legacy = groupSenderDecision(
    { roster: [alice.handle] },
    { from: alice.handle, fromEd: alice.edPublicKeyHex },
    { contactsByHandle: { [alice.handle]: { ed: alice.edPublicKeyHex } } }
  );
  assert.equal(legacy.ok, true);
});
