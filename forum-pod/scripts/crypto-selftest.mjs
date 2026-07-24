// Standalone self-test for the podlink E2E crypto + identity modules.
// Run: node scripts/crypto-selftest.mjs
import assert from "node:assert";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  ed25519KeyPairFromSeed,
  x25519KeyPairFromSeed,
  sealEnvelope,
  openDmEnvelope,
  verifyEnvelopeSig,
  openGroupEnvelope,
  randomGroupKey,
  bytesToHex,
} from "../src/messaging/crypto.js";
import { mnemonicToSeedSync } from "@scure/bip39";

function identityFrom(phrase, podUrl) {
  const seed = mnemonicToSeedSync(phrase).slice(0, 32);
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

const alice = identityFrom(generateMnemonic(wordlist, 128), "https://alice.example");
const bob = identityFrom(generateMnemonic(wordlist, 128), "https://bob.example");

// --- 1:1 DM round trip -----------------------------------------------------
const env = sealEnvelope(
  alice,
  { kind: "dm", toHandle: bob.handle, xPublicKeyHex: bob.xPublicKeyHex, threadId: `dm:${bob.handle}` },
  { body: "hello bob, this is private" }
);
assert.ok(verifyEnvelopeSig(env), "signature should verify");
const opened = openDmEnvelope(bob, env);
assert.strictEqual(opened.body, "hello bob, this is private", "bob decrypts plaintext");
console.log("[ok] 1:1 DM seal/verify/open round trip");

// --- sender self-copy decrypts (sealed to self) ----------------------------
const selfEnv = sealEnvelope(
  alice,
  { kind: "dm", toHandle: alice.handle, xPublicKeyHex: alice.xPublicKeyHex, threadId: `dm:${bob.handle}` },
  { body: "my own copy" }
);
assert.strictEqual(openDmEnvelope(alice, selfEnv).body, "my own copy", "alice opens her self-copy");
console.log("[ok] sender self-copy decrypts");

// --- tamper detection ------------------------------------------------------
const tampered = { ...env, ct: env.ct.slice(0, -2) + (env.ct.endsWith("A") ? "B" : "A") };
assert.strictEqual(verifyEnvelopeSig(tampered), false, "tampered ciphertext fails signature");
console.log("[ok] tamper detection (sig)");

// --- wrong recipient cannot read -------------------------------------------
let failed = false;
try {
  openDmEnvelope(alice, env); // alice is not the recipient and not sender-self
} catch {
  failed = true;
}
assert.ok(failed, "non-recipient cannot decrypt");
console.log("[ok] non-recipient cannot decrypt");

// --- group round trip ------------------------------------------------------
const gkey = randomGroupKey();
const genv = sealEnvelope(alice, { kind: "group", groupId: "g-test", rawGroupKey: gkey }, { body: "group hi" });
assert.ok(verifyEnvelopeSig(genv));
assert.strictEqual(openGroupEnvelope(gkey, genv).body, "group hi", "group member decrypts");
console.log("[ok] group seal/open round trip");

console.log("\nALL CRYPTO SELF-TESTS PASSED");
