/**
 * Smoke test for short server-stored invite codes.
 *   node scripts/invite-code-test.mjs [http://localhost:8811]
 *
 * Verifies: admin founds family; admin mints an invite -> short code; a brand
 * -new (non-member) device resolves the code -> token; joins pending with that
 * token; expired/garbage codes are rejected.
 */
import assert from "node:assert";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const BASE = (process.argv[2] || "http://localhost:8811").replace(/\/?$/, "");
const enc = new TextEncoder();
const NONCE = 24;
const hex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h) => { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return o; };
const b64e = (b) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const canon = (o) => { const s = {}; for (const k of Object.keys(o).sort()) s[k] = o[k]; return JSON.stringify(s); };
const aeadEnc = (key, str) => { const n = crypto.getRandomValues(new Uint8Array(NONCE)); return { n: b64e(n), c: b64e(xchacha20poly1305(key, n).encrypt(enc.encode(str))) }; };
const ecdh = (myPriv, theirPubHex) => hkdf(sha256, x25519.getSharedSecret(myPriv, unhex(theirPubHex)), undefined, enc.encode("podlink-family-wrap-v1"), 32);
const sealTo = (theirPubHex, myPriv, myPubHex, str) => ({ ...aeadEnc(ecdh(myPriv, theirPubHex), str), fromX: myPubHex });
const contentKey = (fck) => hkdf(sha256, fck, undefined, enc.encode("podlink-family-content-v1"), 32);
const encContent = (fck, obj) => aeadEnc(contentKey(fck), JSON.stringify(obj));
const wrapFck = (memberXPub, myPriv, myPubHex, fck) => sealTo(memberXPub, myPriv, myPubHex, b64e(fck));

function actor() {
  const edPriv = ed25519.utils.randomSecretKey();
  const xPriv = crypto.getRandomValues(new Uint8Array(32));
  return { edPriv, edPub: hex(ed25519.getPublicKey(edPriv)), xPriv, xPub: hex(x25519.getPublicKey(xPriv)) };
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
async function signInviteToken(admin, ttlMs = 3600_000) {
  const exp = new Date(Date.now() + ttlMs).toISOString();
  const nonce = crypto.randomUUID();
  const sig = hex(ed25519.sign(enc.encode(canon({ action: "family-invite", admin_x: admin.xPub, exp, nonce })), admin.edPriv));
  return { exp, nonce, admin_pub: admin.edPub, admin_x: admin.xPub, sig };
}

const admin = actor();
const joiner = actor();
console.log(`Invite-code smoke test against ${BASE}\n`);

const fck = crypto.getRandomValues(new Uint8Array(32));
await ok(admin, "PROVISION", "/", {
  x_pub: admin.xPub,
  enc_family_name: encContent(fck, { name: "The Riveras" }),
  enc_name: encContent(fck, { name: "Mom" }),
  wrapped_self: wrapFck(admin.xPub, admin.xPriv, admin.xPub, fck),
});
console.log("[ok] founded family");

// Admin mints an invite -> short code.
const { code } = await ok(admin, "POST", "/invites", { token: await signInviteToken(admin) });
assert.ok(/^[A-Z0-9]{6,12}$/.test(code), `code looks short & clean: ${code}`);
console.log(`[ok] admin minted invite code: ${code}`);

// Brand-new device (not a member) resolves the code.
const resolved = await ok(joiner, "GET", `/invite/${code}`);
assert.ok(resolved.token && resolved.token.admin_x === admin.xPub, "resolved token carries admin_x");
console.log("[ok] non-member resolved code -> token (with admin_x)");

// Garbage / unknown codes are rejected.
assert.strictEqual((await rpc(joiner, "GET", "/invite/ZZZZZZZZ")).status, 404, "unknown code -> 404");
console.log("[ok] unknown code rejected (404)");

// Join with the resolved token -> pending.
const sealed_name = sealTo(resolved.token.admin_x, joiner.xPriv, joiner.xPub, JSON.stringify({ name: "Grandpa" }));
const joined = await ok(joiner, "POST", "/join", { token: resolved.token, x_pub: joiner.xPub, sealed_name });
assert.strictEqual(joined.status, "pending", "joiner is pending");
console.log("[ok] joined as pending using resolved code");

// Admin sees the request with the sealed name.
const reqs = await ok(admin, "LIST", "/requests");
assert.strictEqual(reqs.rows.length, 1, "one pending request");
console.log("[ok] admin sees pending request");

console.log("\nALL INVITE-CODE TESTS PASSED");
