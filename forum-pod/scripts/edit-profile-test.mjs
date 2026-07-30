/**
 * Edit + profile test. Fresh wrangler:
 *   node scripts/edit-profile-test.mjs [http://localhost:8828]
 */
import assert from "node:assert";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const BASE = (process.argv[2] || "http://localhost:8828").replace(/\/+$/, "");
const enc = new TextEncoder();
const hex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h) => { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return o; };
const b64e = (b) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const canon = (o) => { const s = {}; for (const k of Object.keys(o).sort()) s[k] = o[k]; return JSON.stringify(s); };
function aeadEnc(key, str) { const n = crypto.getRandomValues(new Uint8Array(24)); return { n: b64e(n), c: b64e(xchacha20poly1305(key, n).encrypt(enc.encode(str))) }; }
function ecdh(myPriv, theirPubHex) { return hkdf(sha256, x25519.getSharedSecret(myPriv, unhex(theirPubHex)), undefined, enc.encode("podlink-family-wrap-v1"), 32); }
function sealTo(theirPubHex, myPriv, myPubHex, str) { return { ...aeadEnc(ecdh(myPriv, theirPubHex), str), fromX: myPubHex }; }
function contentKey(fck) { return hkdf(sha256, fck, undefined, enc.encode("podlink-family-content-v1"), 32); }
const encContent = (fck, obj) => aeadEnc(contentKey(fck), JSON.stringify(obj));
const wrapFck = (memberXPub, myPriv, myPubHex, fck) => sealTo(memberXPub, myPriv, myPubHex, b64e(fck));

function actor() {
  const edPriv = ed25519.utils.randomSecretKey();
  const edPub = hex(ed25519.getPublicKey(edPriv));
  const xPriv = crypto.getRandomValues(new Uint8Array(32));
  const xPub = hex(x25519.getPublicKey(xPriv));
  return { edPriv, edPub, xPriv, xPub };
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

const founder = actor();
const other = actor();
console.log(`Edit + profile against ${BASE}\n`);

const fck = crypto.getRandomValues(new Uint8Array(32));
await ok(founder, "PROVISION", "/", {
  x_pub: founder.xPub, enc_family_name: encContent(fck, { name: "Maine Forum" }),
  enc_name: encContent(fck, { name: "Founder" }), wrapped_self: wrapFck(founder.xPub, founder.xPriv, founder.xPub, fck),
  instance_join_policy: "open", handle: "FounderME",
});
await ok(founder, "POST", "/counties/seed", { counties: ["Cumberland"] });
const county = (await ok(founder, "LIST", "/groups", { type: "county" })).rows[0];
const lobby = (await ok(founder, "POST", "/groups", {
  type: "issue", name: "Housing", parent_group_id: county.id, visibility: "public_read", join_policy: "open",
})).group;
await ok(other, "POST", "/register", { handle: "Neighbor", x_pub: other.xPub });
await ok(other, "POST", `/groups/${lobby.id}/join`, {});

const pid = (await ok(other, "POST", `/groups/${lobby.id}/posts`, { text: "Draft topic" })).id;
await ok(other, "PUT", `/groups/${lobby.id}/posts/${pid}`, { text: "Edited topic about zoning" });
const posts = (await ok(founder, "LIST", `/groups/${lobby.id}/posts`)).rows;
const edited = posts.find((p) => p.id === pid);
assert.strictEqual(edited.text, "Edited topic about zoning");
assert.ok(edited.edited_at, "edited_at set");
console.log("[ok] author edited discussion post");

assert.strictEqual((await rpc(founder, "PUT", `/groups/${lobby.id}/posts/${pid}`, { text: "hijack" })).status, 403, "non-author cannot edit");
console.log("[ok] non-author edit refused");

await ok(other, "POST", `/groups/${lobby.id}/vote`, { item_type: "post", item_id: pid, vote: 1 });

const badHide = await rpc(founder, "POST", `/groups/${lobby.id}/hide`, { item_type: "post", item_id: pid, reason: "disagreeable" });
assert.strictEqual(badHide.status, 400, "viewpoint hide refused");
console.log("[ok] hide without illegal category refused");

const prof = await ok(other, "GET", "/me/profile");
assert.strictEqual(prof.handle, "Neighbor");
assert.ok(prof.posts.some((p) => p.id === pid));
assert.ok(prof.votes.some((v) => v.item_id === pid && v.vote === 1));
assert.ok(prof.groups.some((g) => g.id === lobby.id));
console.log("[ok] profile lists posts, votes, and lobby membership");

const viewed = await ok(founder, "GET", `/profiles/${other.edPub}`);
assert.strictEqual(viewed.handle, "Neighbor");
assert.strictEqual(viewed.is_me, false);
console.log("[ok] other members can view a profile");

console.log("\nALL EDIT + PROFILE TESTS PASSED");
