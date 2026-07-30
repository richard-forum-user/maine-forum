/**
 * Civic-layer backend test (county boards + public signup + lobbies).
 * Run against a FRESH local wrangler dev:
 *   node scripts/civic-boards-test.mjs [http://localhost:8815]
 *
 * Verifies: instance founds with open signup; a steward seeds county boards
 * (idempotent); a brand-new device self-registers with a pseudonymous handle
 * (no invite); a public member lists county boards and creates a lobby nested
 * under a county; lobbies require a valid county parent; only a steward can
 * create a county board; open county boards accept joins.
 */
import assert from "node:assert";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const BASE = (process.argv[2] || "http://localhost:8815").replace(/\/+$/, "");
const enc = new TextEncoder();
const NONCE = 24;
const hex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h) => { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return o; };
const b64e = (b) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const canon = (o) => { const s = {}; for (const k of Object.keys(o).sort()) s[k] = o[k]; return JSON.stringify(s); };
function aeadEnc(key, str) { const n = crypto.getRandomValues(new Uint8Array(NONCE)); return { n: b64e(n), c: b64e(xchacha20poly1305(key, n).encrypt(enc.encode(str))) }; }
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

const COUNTIES = ["Cumberland", "Kennebec", "Penobscot", "York"]; // subset for the test

const founder = actor();
const citizen = actor();
const citizen2 = actor();

console.log(`Civic boards (county + signup + lobbies) against ${BASE}\n`);

// 1. Found the instance with OPEN public signup.
const fck1 = crypto.getRandomValues(new Uint8Array(32));
await ok(founder, "PROVISION", "/", {
  x_pub: founder.xPub,
  enc_family_name: encContent(fck1, { name: "Maine Forum" }),
  enc_name: encContent(fck1, { name: "Founder" }),
  wrapped_self: wrapFck(founder.xPub, founder.xPriv, founder.xPub, fck1),
  instance_join_policy: "open",
});
const inst = await ok(founder, "GET", "/instance");
assert.strictEqual(inst.join_policy, "open", "instance signup is open");
console.log("[ok] instance founded with open public signup");

// 2. Steward seeds county boards (idempotent).
const seed1 = await ok(founder, "POST", "/counties/seed", { counties: COUNTIES });
assert.strictEqual(seed1.created, COUNTIES.length, "all county boards created");
const seed2 = await ok(founder, "POST", "/counties/seed", { counties: COUNTIES });
assert.strictEqual(seed2.created, 0, "re-seed is idempotent");
assert.strictEqual(seed2.total, COUNTIES.length, "county board count stable");
console.log(`[ok] seeded ${seed1.created} county boards; re-seed created 0 (idempotent)`);

// 2b. Pre-signup bootstrap tells a not-yet-member device the instance is open.
const boot = await ok(citizen, "GET", "/bootstrap");
assert.strictEqual(boot.founded, true, "bootstrap reports founded");
assert.strictEqual(boot.join_policy, "open", "bootstrap reports open signup");
assert.strictEqual(boot.already_member, false, "bootstrap knows caller is not yet a member");
console.log("[ok] pre-signup bootstrap: founded + open, caller not yet a member");

// 3. Brand-new device self-registers with a pseudonymous handle (no invite).
const reg = await ok(citizen, "POST", "/register", { handle: "PortlandVoter", x_pub: citizen.xPub });
assert.strictEqual(reg.me.status, "active", "public signup is immediately active");
assert.strictEqual(reg.me.handle, "PortlandVoter", "handle stored");
console.log("[ok] public device self-registered as active member (pseudonymous)");

// 3b. A different device cannot claim the same handle (case-insensitive).
assert.strictEqual((await rpc(actor(), "POST", "/register", { handle: "portlandVOTER" })).status, 409, "duplicate handle rejected");
console.log("[ok] duplicate handle (case-insensitive) rejected with 409");

// 4. Public member lists county boards.
const counties = (await ok(citizen, "LIST", "/groups", { type: "county" })).rows;
assert.strictEqual(counties.length, COUNTIES.length, "member sees all county boards");
assert.ok(counties.every((c) => c.type === "county" && c.encryption_mode === "server" && c.visibility === "public_read"), "county boards are server-mode public_read");
const cumberland = counties.find((c) => c.name === "Cumberland");
assert.ok(cumberland, "Cumberland board present");
console.log("[ok] member listed county boards:", counties.map((c) => c.name).join(", "));

// 5. Member creates a LOBBY nested under a county board.
const lobby = (await ok(citizen, "POST", "/groups", {
  type: "issue", name: "Portland Zoning Reform", parent_group_id: cumberland.id, visibility: "public_read", join_policy: "request",
})).group;
assert.strictEqual(lobby.type, "issue");
assert.strictEqual(lobby.parent_group_id, cumberland.id, "lobby nests under its county");
assert.strictEqual(lobby.my_role, "steward", "lobby creator is its steward");
console.log("[ok] member created a lobby nested under Cumberland");

// 6. A lobby with no/invalid county parent is rejected.
assert.strictEqual((await rpc(citizen, "POST", "/groups", { type: "issue", name: "Orphan" })).status, 400, "lobby needs a county parent");
assert.strictEqual((await rpc(citizen, "POST", "/groups", { type: "issue", name: "Orphan", parent_group_id: lobby.id })).status, 400, "parent must be a county, not a lobby");
console.log("[ok] lobby without a valid county parent is refused");

// 7. A non-steward member cannot create a county board.
assert.strictEqual((await rpc(citizen, "POST", "/groups", { type: "county", name: "Rogue County" })).status, 403, "member cannot create a county board");
console.log("[ok] county-board creation is steward-only");

// 8. A second public member joins the open county board.
await ok(citizen2, "POST", "/register", { handle: "BangorNeighbor", x_pub: citizen2.xPub });
const j = await ok(citizen2, "POST", `/groups/${cumberland.id}/join`, {});
assert.strictEqual(j.status, "active", "open county board join is immediately active");
console.log("[ok] second member signed up and joined an open county board");

console.log("\nALL CIVIC-LAYER TESTS PASSED");
