/**
 * Sender-trust self-test (no network). Covers:
 *   - impersonation: attacker labels envelope with a contact's handle
 *   - unknown sender is hidden, not displayed
 *   - group-key injection from a non-contact / conflicting key is rejected
 *   - group message from someone not on the roster is rejected
 * Run: node scripts/trust-selftest.mjs
 */
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const { generateMnemonic } = await import("@scure/bip39");
const { wordlist } = await import("@scure/bip39/wordlists/english.js");
const { sealEnvelope, deriveHandle, b64encode, randomGroupKey } = await import("../src/messaging/crypto.js");
const { createIdentity, selfForCrypto, contactCard, decodeInvite, encodeInvite } = await import("../src/messaging/identity.js");

// decryptRow lives in client.js, which imports browser-only modules.
// Load it with those modules stubbed.
const { register } = await import("node:module");
const { pathToFileURL } = await import("node:url");
register(
  "data:text/javascript," +
    encodeURIComponent(`
const stubs = ["pod-signing.js","signing-envelope.js","pod-adapter-http.js","member-store.js"];
export async function resolve(spec, ctx, next) {
  if (stubs.some((s) => spec.endsWith("/" + s))) return { url: "stub:" + spec, shortCircuit: true };
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (url.startsWith("stub:")) return { format: "module", shortCircuit: true,
    source: "export const signBundle=()=>{};export const ensurePodSigningKey=()=>{};export const enrichSignedEnvelope=(x)=>x;export const httpProviderUrl=()=>'';export const loadSigningMeta=()=>null;" };
  return next(url, ctx);
}`),
  pathToFileURL("./")
);
const { decryptRow, getGroupRecord } = await import("../src/messaging/client.js");

function mk(name) {
  mem.clear();
  const id = createIdentity(generateMnemonic(wordlist), { displayName: name, podUrl: `https://${name}.example` });
  return { ...id };
}
const alice = mk("alice");
const bob = mk("bob");
const mallory = mk("mallory");
mem.clear();

const row = (env, direction = "in") => ({ direction, envelope_json: JSON.stringify(env) });
const asContact = (id) => ({ handle: id.handle, display_name: id.displayName, ed: id.edPublicKeyHex, x: id.xPublicKeyHex });
const bobContacts = { [alice.handle]: asContact(alice) };

let fails = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "[ok]" : "[FAIL]"} ${name}${cond ? "" : " " + detail}`);
  if (!cond) fails++;
}

// 1. legit DM from contact
const legit = sealEnvelope(selfForCrypto(alice), { kind: "dm", toHandle: bob.handle, xPublicKeyHex: bob.xPublicKeyHex }, { body: "hi" });
let d = decryptRow(bob, row(legit), { contacts: bobContacts });
check("legit DM from pinned contact decrypts", d.body === "hi" && !d.untrusted, JSON.stringify(d));

// 2. impersonation: Mallory claims Alice's handle
const spoof = sealEnvelope({ ...selfForCrypto(mallory), handle: alice.handle }, { kind: "dm", toHandle: bob.handle, xPublicKeyHex: bob.xPublicKeyHex }, { body: "send money" });
d = decryptRow(bob, row(spoof), { contacts: bobContacts });
check("impersonation (handle spoof) rejected", d.untrusted && d.body === null, JSON.stringify(d));

// 3. unknown sender with honest handle
const stranger = sealEnvelope(selfForCrypto(mallory), { kind: "dm", toHandle: bob.handle, xPublicKeyHex: bob.xPublicKeyHex }, { body: "hello" });
d = decryptRow(bob, row(stranger), { contacts: bobContacts });
check("unknown sender hidden", d.untrusted && d.reason === "unknown_sender", JSON.stringify(d));

// 4. contact's stored key differs from envelope key
const swapped = { [alice.handle]: { ...asContact(alice), ed: mallory.edPublicKeyHex } };
d = decryptRow(bob, row(legit), { contacts: swapped });
check("key mismatch vs stored contact rejected", d.untrusted && d.reason !== "unknown_sender", JSON.stringify(d));

// 5. group key from legit contact imported
const gid = "g-test";
const gk = b64encode(randomGroupKey());
const roster = [alice, bob].map((p) => ({ handle: p.handle, x: p.xPublicKeyHex, podUrl: p.podUrl }));
const keyMsg = sealEnvelope(selfForCrypto(alice), { kind: "dm", toHandle: bob.handle, xPublicKeyHex: bob.xPublicKeyHex }, { type: "group-key", groupId: gid, title: "t", key: gk, roster });
d = decryptRow(bob, row(keyMsg), { contacts: bobContacts });
check("group key from contact on roster imported", d.groupKeyImport === "imported" && getGroupRecord(gid)?.key === gk, JSON.stringify(d));

// 6. Mallory (non-contact) tries to replace that key
const evilKey = b64encode(randomGroupKey());
const inject = sealEnvelope(selfForCrypto(mallory), { kind: "dm", toHandle: bob.handle, xPublicKeyHex: bob.xPublicKeyHex },
  { type: "group-key", groupId: gid, title: "t", key: evilKey, roster: [...roster, { handle: mallory.handle }] });
d = decryptRow(bob, row(inject), { contacts: bobContacts });
check("group key injection from non-contact rejected", d.untrusted && getGroupRecord(gid).key === gk, JSON.stringify(d));

// 7. Even a contact cannot silently replace an existing key
const replace = sealEnvelope(selfForCrypto(alice), { kind: "dm", toHandle: bob.handle, xPublicKeyHex: bob.xPublicKeyHex }, { type: "group-key", groupId: gid, title: "t", key: evilKey, roster });
d = decryptRow(bob, row(replace), { contacts: bobContacts });
check("conflicting key from contact not overwritten", d.groupKeyImport === "rejected:conflicting_key" && getGroupRecord(gid).key === gk, JSON.stringify(d));

// 8. group message from a contact who is NOT on the roster
const carol = mk("carol"); // mk() clears storage, so re-import Alice's key
mem.clear();
decryptRow(bob, row(keyMsg), { contacts: bobContacts });
const { b64decode } = await import("../src/messaging/crypto.js");
const offRoster = sealEnvelope(selfForCrypto(carol), { kind: "group", groupId: gid, rawGroupKey: b64decode(gk) }, { body: "I'm in your group" });
d = decryptRow(bob, row(offRoster), { contacts: { ...bobContacts, [carol.handle]: asContact(carol) } });
check("group message from non-roster sender rejected", d.untrusted && d.reason === "not_in_roster", JSON.stringify(d));

// 9. group message from roster member
const okGroup = sealEnvelope(selfForCrypto(alice), { kind: "group", groupId: gid, rawGroupKey: b64decode(gk) }, { body: "team" });
d = decryptRow(bob, row(okGroup), { contacts: bobContacts });
check("group message from roster member decrypts", d.body === "team", JSON.stringify(d));

// 10. own self-copy still readable
const selfCopy = sealEnvelope(selfForCrypto(bob), { kind: "dm", toHandle: bob.handle, xPublicKeyHex: bob.xPublicKeyHex }, { body: "mine" });
d = decryptRow(bob, row(selfCopy, "out"), { contacts: bobContacts });
check("own self-copy decrypts", d.body === "mine", JSON.stringify(d));

// 11. forged invite rejected
const forged = encodeInvite({ ...contactCard(mallory), handle: alice.handle });
let threw = false;
try { decodeInvite(forged); } catch { threw = true; }
check("invite with mismatched handle rejected", threw);
check("genuine invite accepted", decodeInvite(encodeInvite(contactCard(alice))).handle === alice.handle);
check("handle derivation stable", deriveHandle(alice.edPublicKeyHex) === alice.handle);

console.log(fails ? `\n${fails} TRUST TEST(S) FAILED` : "\nALL TRUST SELF-TESTS PASSED");
process.exit(fails ? 1 : 0);
