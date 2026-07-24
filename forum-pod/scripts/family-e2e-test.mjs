/**
 * End-to-end backend + crypto test for the E2E-encrypted FamilyDO.
 * Run against local `wrangler dev` (default) or a deployed URL:
 *   node scripts/family-e2e-test.mjs [http://localhost:8811]
 *
 * Verifies: founder mints FCK + wraps to self; invitee joins pending with name
 * sealed to admin; admin reads the sealed name, admits (wraps FCK); member
 * unwraps + decrypts family name/roster; encrypted post/comment/event
 * round-trip; server stores ciphertext only; remove rotates the epoch and
 * locks the removed member out of new content.
 */
import assert from "node:assert";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const BASE = (process.argv[2] || "http://localhost:8811").replace(/\/+$/, "");
const enc = new TextEncoder();
const dec = new TextDecoder();
const NONCE = 24;

const hex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h) => { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return o; };
const b64e = (b) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const b64d = (s) => { const r = atob(s); const o = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) o[i] = r.charCodeAt(i); return o; };
const canon = (o) => { const s = {}; for (const k of Object.keys(o).sort()) s[k] = o[k]; return JSON.stringify(s); };

function aeadEnc(key, str) { const n = crypto.getRandomValues(new Uint8Array(NONCE)); return { n: b64e(n), c: b64e(xchacha20poly1305(key, n).encrypt(enc.encode(str))) }; }
function aeadDec(key, blob) { return dec.decode(xchacha20poly1305(key, b64d(blob.n)).decrypt(b64d(blob.c))); }
function ecdh(myPriv, theirPubHex) { return hkdf(sha256, x25519.getSharedSecret(myPriv, unhex(theirPubHex)), undefined, enc.encode("podlink-family-wrap-v1"), 32); }
function sealTo(theirPubHex, myPriv, myPubHex, str) { return { ...aeadEnc(ecdh(myPriv, theirPubHex), str), fromX: myPubHex }; }
function openSealed(myPriv, sealed) { return aeadDec(ecdh(myPriv, sealed.fromX), sealed); }
function contentKey(fck) { return hkdf(sha256, fck, undefined, enc.encode("podlink-family-content-v1"), 32); }
const encContent = (fck, obj) => aeadEnc(contentKey(fck), JSON.stringify(obj));
const decContent = (fck, blob) => JSON.parse(aeadDec(contentKey(fck), blob));
const wrapFck = (memberXPub, myPriv, myPubHex, fck) => sealTo(memberXPub, myPriv, myPubHex, b64e(fck));
const unwrapFck = (myPriv, wrapped) => b64d(openSealed(myPriv, wrapped));

function actor(name) {
  const edPriv = ed25519.utils.randomSecretKey();
  const edPub = hex(ed25519.getPublicKey(edPriv));
  const xPriv = crypto.getRandomValues(new Uint8Array(32));
  const xPub = hex(x25519.getPublicKey(xPriv));
  return { name, edPriv, edPub, xPriv, xPub, fck: {} };
}
async function sid(pub) { return "pubkey:" + hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(pub)))); }
async function rpc(a, verb, path, data = null) {
  const payload = { verb, path, data };
  const sessionId = await sid(a.edPub);
  const timestamp = new Date().toISOString();
  const signature = hex(ed25519.sign(enc.encode(canon({ payload, sessionId, timestamp })), a.edPriv));
  const res = await fetch(`${BASE}/api/family${path === "/" ? "" : path}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload, sessionId, timestamp, signature, publicKeyHex: a.edPub, deviceCredentialId: null }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function ok(a, verb, path, data) {
  const r = await rpc(a, verb, path, data);
  if (r.status !== 200) throw new Error(`${verb} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
function makeInvite(admin, ttl = 3600_000) {
  const exp = new Date(Date.now() + ttl).toISOString();
  const nonce = crypto.randomUUID();
  const sig = hex(ed25519.sign(enc.encode(canon({ action: "family-invite", admin_x: admin.xPub, exp, nonce })), admin.edPriv));
  return { exp, nonce, admin_pub: admin.edPub, admin_x: admin.xPub, sig };
}
async function syncKeys(a) {
  const r = await ok(a, "GET", "/keys");
  for (const { epoch, wrapped } of r.rows) { try { a.fck[epoch] = unwrapFck(a.xPriv, wrapped); } catch {} }
  a.currentEpoch = r.current_epoch;
  return r;
}

const admin = actor("Mom");
const member = actor("Grandpa");
const stranger = actor("Stranger");

console.log(`Family E2E (encrypted) against ${BASE}\n`);

// 1. No auto-create on GET.
assert.strictEqual((await rpc(admin, "GET", "/family")).status, 404, "empty family: 404");
console.log("[ok] fresh family not auto-created");

// 2. Founder mints FCK, wraps to self, encrypts names.
const fck1 = crypto.getRandomValues(new Uint8Array(32));
admin.fck[1] = fck1; admin.currentEpoch = 1;
await ok(admin, "PROVISION", "/", {
  x_pub: admin.xPub,
  enc_family_name: encContent(fck1, { name: "The Riveras" }),
  enc_name: encContent(fck1, { name: "Mom" }),
  wrapped_self: wrapFck(admin.xPub, admin.xPriv, admin.xPub, fck1),
});
const fam = await ok(admin, "GET", "/family");
assert.strictEqual(decContent(fck1, fam.family.enc_family_name).name, "The Riveras");
assert.strictEqual(fam.me.role, "admin");
console.log("[ok] founder created encrypted family; admin can decrypt family name");

// 3. Stranger rejected.
assert.strictEqual((await rpc(stranger, "LIST", "/members")).status, 403, "stranger rejected");
console.log("[ok] stranger without invite rejected");

// 4. Member joins pending with name sealed to admin.
const token = makeInvite(admin);
const sealed_name = sealTo(admin.xPub, member.xPriv, member.xPub, JSON.stringify({ name: "Grandpa" }));
const joined = await ok(member, "POST", "/join", { token, x_pub: member.xPub, sealed_name });
assert.strictEqual(joined.status, "pending", "joiner is pending");
console.log("[ok] member joined as pending (sealed name)");

// 4b. Pending member cannot post.
assert.strictEqual((await rpc(member, "POST", "/posts", { epoch: 1, ct: encContent(fck1, { body: "hi" }) })).status, 403, "pending cannot post");
console.log("[ok] pending member blocked from posting");

// 5. Admin reads sealed name and admits (wraps FCK).
const reqs = await ok(admin, "LIST", "/requests");
assert.strictEqual(reqs.rows.length, 1);
const req = reqs.rows[0];
const revealed = JSON.parse(openSealed(admin.xPriv, req.sealed_name)).name;
assert.strictEqual(revealed, "Grandpa", "admin reads sealed pending name");
await ok(admin, "POST", "/admit", {
  member_pub: req.member_pub,
  enc_name: encContent(fck1, { name: "Grandpa" }),
  name_epoch: 1,
  keys: [{ epoch: 1, wrapped: wrapFck(req.x_pub, admin.xPriv, admin.xPub, fck1) }],
});
console.log("[ok] admin verified sealed name + admitted (wrapped FCK)");

// 6. Member syncs keys and decrypts family + roster.
const ks = await syncKeys(member);
assert.ok(member.fck[1], "member unwrapped epoch-1 FCK");
const mFam = await ok(member, "GET", "/family");
assert.strictEqual(decContent(member.fck[1], mFam.family.enc_family_name).name, "The Riveras", "member decrypts family name");
const roster = await ok(member, "LIST", "/members");
const names = roster.rows.map((m) => (m.enc_name ? decContent(member.fck[m.name_epoch], m.enc_name).name : null));
assert.ok(names.includes("Mom") && names.includes("Grandpa"), "member decrypts roster names");
console.log("[ok] member unwrapped key; decrypted family + roster:", names.join(", "));

// 7. Encrypted post round-trip; verify server stores ciphertext only.
const post = await ok(member, "POST", "/posts", { epoch: 1, ct: encContent(member.fck[1], { body: "Hello family!", media: [] }) });
const feed = await ok(admin, "LIST", "/posts");
const stored = feed.rows[0];
assert.ok(stored.ct && stored.ct.c && !JSON.stringify(stored.ct).includes("Hello"), "server stored ciphertext only");
assert.strictEqual(decContent(admin.fck[1], stored.ct).body, "Hello family!", "admin decrypts member's post");
console.log("[ok] encrypted post round-trip; server holds ciphertext only");

// 8. Comment + event + rsvp.
await ok(admin, "POST", `/posts/${post.id}/comments`, { epoch: 1, ct: encContent(fck1, { body: "Welcome!" }) });
const detail = await ok(member, "GET", `/posts/${post.id}`);
assert.strictEqual(decContent(member.fck[1], detail.comments[0].ct).body, "Welcome!", "member decrypts comment");
const evt = await ok(admin, "POST", "/events", { epoch: 1, ct: encContent(fck1, { title: "Dinner", start_at: new Date(Date.now() + 86400_000).toISOString() }) });
await ok(member, "POST", `/events/${evt.id}/rsvp`, { status: "yes" });
const events = await ok(member, "LIST", "/events");
assert.strictEqual(decContent(member.fck[1], events.rows[0].ct).title, "Dinner", "member decrypts event");
assert.ok(events.rows[0].rsvps.find((r) => r.status === "yes"), "rsvp recorded");
console.log("[ok] encrypted comment + event + rsvp round-trip");

// 9. Remove member -> rotate epoch; removed member locked out.
const newFck = crypto.getRandomValues(new Uint8Array(32));
await ok(admin, "POST", "/remove", {
  member_pub: req.member_pub,
  new_epoch: 2,
  keys: [{ member_pub: admin.edPub, wrapped: wrapFck(admin.xPub, admin.xPriv, admin.xPub, newFck) }],
  enc_family_name: encContent(newFck, { name: "The Riveras" }),
});
admin.fck[2] = newFck; admin.currentEpoch = 2;
// New post at epoch 2.
await ok(admin, "POST", "/posts", { epoch: 2, ct: encContent(newFck, { body: "post-removal secret" }) });
// Removed member is no longer a member at all.
const removedTry = await rpc(member, "GET", "/keys");
assert.strictEqual(removedTry.status, 403, "removed member rejected");
console.log("[ok] remove rotated to epoch 2; removed member locked out (403)");

console.log("\nALL FAMILY E2E-ENCRYPTION TESTS PASSED");
