/**
 * Phase 1 group-model backend test. Run against a FRESH local wrangler dev:
 *   node scripts/group-model-test.mjs [http://localhost:8815]
 *
 * Verifies: founding community group is auto-created on PROVISION (lossless
 * migration of the family into the group model); both group types are
 * creatable; community groups cannot be public_read (E2E); issue groups are
 * server-mode and can be public_read/open; per-group roles gate management
 * (member cannot admit/assign roles, steward can); one membership per group.
 */
import assert from "node:assert";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const BASE = (process.argv[2] || "http://localhost:8815").replace(/\/+$/, "");
const enc = new TextEncoder();
const dec = new TextDecoder();
const NONCE = 24;
const hex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h) => { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return o; };
const b64e = (b) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const b64d = (s) => { const r = atob(s); const o = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) o[i] = r.charCodeAt(i); return o; };
const canon = (o) => { const s = {}; for (const k of Object.keys(o).sort()) s[k] = o[k]; return JSON.stringify(s); };
function aeadEnc(key, str) { const n = crypto.getRandomValues(new Uint8Array(NONCE)); return { n: b64e(n), c: b64e(xchacha20poly1305(key, n).encrypt(enc.encode(str))) }; }
function ecdh(myPriv, theirPubHex) { return hkdf(sha256, x25519.getSharedSecret(myPriv, unhex(theirPubHex)), undefined, enc.encode("podlink-family-wrap-v1"), 32); }
function sealTo(theirPubHex, myPriv, myPubHex, str) { return { ...aeadEnc(ecdh(myPriv, theirPubHex), str), fromX: myPubHex }; }
function contentKey(fck) { return hkdf(sha256, fck, undefined, enc.encode("podlink-family-content-v1"), 32); }
const encContent = (fck, obj) => aeadEnc(contentKey(fck), JSON.stringify(obj));
const wrapFck = (memberXPub, myPriv, myPubHex, fck) => sealTo(memberXPub, myPriv, myPubHex, b64e(fck));

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

const founder = actor("Founder");
const member = actor("Member");

console.log(`Group-model (Phase 1) against ${BASE}\n`);

// 1. Found the instance (creates founding community group).
const fck1 = crypto.getRandomValues(new Uint8Array(32));
founder.fck[1] = fck1;
await ok(founder, "PROVISION", "/", {
  x_pub: founder.xPub,
  enc_family_name: encContent(fck1, { name: "Maine Forum Home" }),
  enc_name: encContent(fck1, { name: "Founder" }),
  wrapped_self: wrapFck(founder.xPub, founder.xPriv, founder.xPub, fck1),
});
let groups = (await ok(founder, "LIST", "/groups")).rows;
const home = groups.find((g) => g.founding);
assert.ok(home, "founding community group auto-created");
assert.strictEqual(home.type, "community");
assert.strictEqual(home.encryption_mode, "e2e");
assert.strictEqual(home.my_role, "steward", "founder is steward of founding group");
console.log("[ok] founding community group created; founder is its steward");

// 2. Seed a county board (base tier), then create an issue lobby nested in it.
await ok(founder, "POST", "/counties/seed", { counties: ["Cumberland"] });
const county = (await ok(founder, "LIST", "/groups", { type: "county" })).rows[0];
assert.strictEqual(county.type, "county", "county board seeded");
const lobby = (await ok(founder, "POST", "/groups", {
  type: "issue", name: "Ranked-Choice Voting", parent_group_id: county.id, visibility: "public_read", join_policy: "open",
})).group;
assert.strictEqual(lobby.type, "issue");
assert.strictEqual(lobby.encryption_mode, "server", "issue groups are server-readable");
assert.strictEqual(lobby.visibility, "public_read", "issue groups may be public_read");
assert.strictEqual(lobby.parent_group_id, county.id, "lobby nests under its county");
assert.strictEqual(lobby.name, "Ranked-Choice Voting", "server-mode group exposes plaintext name");
assert.strictEqual(lobby.my_role, "steward", "creator is steward");
console.log("[ok] county board seeded; issue lobby nested under it (server-mode, public_read)");

// 3. Create a community group requesting public_read — must be refused/coerced.
const priv = (await ok(founder, "POST", "/groups", {
  type: "community", enc_name: encContent(fck1, { name: "Cabinet" }), visibility: "public_read",
})).group;
assert.strictEqual(priv.encryption_mode, "e2e");
assert.notStrictEqual(priv.visibility, "public_read", "community groups cannot be public_read (E2E)");
assert.strictEqual(priv.name, null, "e2e group does not expose a plaintext name");
console.log("[ok] community group stayed E2E; public_read coerced to", priv.visibility);

// 4. Bad group type rejected.
assert.strictEqual((await rpc(founder, "POST", "/groups", { type: "nonsense" })).status, 400, "bad type rejected");
console.log("[ok] unknown group type rejected");

// 5. Admit a second instance member via the family flow, then join the lobby.
const token = makeInvite(founder);
const sealed_name = sealTo(founder.xPub, member.xPriv, member.xPub, JSON.stringify({ name: "Member" }));
await ok(member, "POST", "/join", { token, x_pub: member.xPub, sealed_name });
await ok(founder, "POST", "/admit", {
  member_pub: member.edPub, enc_name: encContent(fck1, { name: "Member" }), name_epoch: 1,
  keys: [{ epoch: 1, wrapped: wrapFck(member.xPub, founder.xPriv, founder.xPub, fck1) }],
});
const j1 = await ok(member, "POST", `/groups/${lobby.id}/join`, {});
assert.strictEqual(j1.status, "active", "open lobby join is immediately active");
const j2 = await ok(member, "POST", `/groups/${lobby.id}/join`, {});
assert.strictEqual(j2.status, "active", "re-join is idempotent (one membership per group)");
console.log("[ok] member joined open lobby; membership is idempotent");

// 6. Role gate: a plain member cannot assign roles; a steward can.
assert.strictEqual((await rpc(member, "POST", `/groups/${lobby.id}/role`, { member_pub: member.edPub, role: "steward" })).status, 403, "member cannot self-promote");
await ok(founder, "POST", `/groups/${lobby.id}/role`, { member_pub: member.edPub, role: "moderator" });
const roster = (await ok(founder, "LIST", `/groups/${lobby.id}/members`)).rows;
assert.strictEqual(roster.find((m) => m.member_pub === member.edPub)?.role, "moderator", "steward promoted member to moderator");
console.log("[ok] role gate enforced; steward promoted member -> moderator");

// 7. Last-steward guard.
assert.strictEqual((await rpc(founder, "POST", `/groups/${lobby.id}/role`, { member_pub: founder.edPub, role: "member" })).status, 400, "cannot demote the last steward");
console.log("[ok] last-steward demotion refused");

console.log("\nALL PHASE-1 GROUP-MODEL TESTS PASSED");
