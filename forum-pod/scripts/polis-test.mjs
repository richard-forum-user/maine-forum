/**
 * Pol.is-style opinion mapping test (lobby posts + like/dislike).
 * Run against a FRESH local wrangler dev:
 *   node scripts/polis-test.mjs [http://localhost:8821]
 *
 * A lobby's posts are the deliberation "statements"; like (+1) / dislike (-1)
 * on them is the agree/disagree signal. Four members vote in two clear patterns;
 * we assert the opinion map finds two opinion groups, flags the divisive posts,
 * and surfaces the two consensus posts. Also checks E2E groups reject posts.
 */
import assert from "node:assert";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const BASE = (process.argv[2] || "http://localhost:8821").replace(/\/+$/, "");
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
const A = actor(), B = actor(), C = actor(), D = actor(); // A,B vs C,D

console.log(`Pol.is opinion mapping against ${BASE}\n`);

// Found instance (open signup) + a county board + a lobby (open join, public_read).
const fck = crypto.getRandomValues(new Uint8Array(32));
await ok(founder, "PROVISION", "/", {
  x_pub: founder.xPub, enc_family_name: encContent(fck, { name: "Maine Forum" }),
  enc_name: encContent(fck, { name: "Founder" }), wrapped_self: wrapFck(founder.xPub, founder.xPriv, founder.xPub, fck),
  instance_join_policy: "open",
});
await ok(founder, "POST", "/counties/seed", { counties: ["Cumberland"] });
const county = (await ok(founder, "LIST", "/groups", { type: "county" })).rows[0];
const lobby = (await ok(founder, "POST", "/groups", {
  type: "issue", name: "Waterfront Plan", parent_group_id: county.id, visibility: "public_read", join_policy: "open",
})).group;
console.log("[ok] lobby created under county");

// Four members sign up publicly and join the lobby.
for (const [m, h] of [[A, "Ana"], [B, "Ben"], [C, "Cara"], [D, "Dan"]]) {
  await ok(m, "POST", "/register", { handle: h, x_pub: m.xPub });
  const j = await ok(m, "POST", `/groups/${lobby.id}/join`, {});
  assert.strictEqual(j.status, "active", "open lobby join is active");
}
console.log("[ok] four members signed up and joined the lobby");

// Founder (lobby steward) posts four "statements".
const S = {};
for (const key of ["consensusAgree", "consensusDisagree", "divisive1", "divisive2"]) {
  S[key] = (await ok(founder, "POST", `/groups/${lobby.id}/posts`, { text: `Statement: ${key}` })).id;
}
console.log("[ok] four posts created (the deliberation statements)");

// Vote patterns: like=+1, dislike=-1.
async function vote(m, item_id, v) { await ok(m, "POST", `/groups/${lobby.id}/vote`, { item_type: "post", item_id, vote: v }); }
for (const m of [A, B, C, D]) { await vote(m, S.consensusAgree, 1); await vote(m, S.consensusDisagree, -1); }
await vote(A, S.divisive1, 1); await vote(B, S.divisive1, 1); await vote(C, S.divisive1, -1); await vote(D, S.divisive1, -1);
await vote(A, S.divisive2, -1); await vote(B, S.divisive2, -1); await vote(C, S.divisive2, 1); await vote(D, S.divisive2, 1);
console.log("[ok] members voted in two opposing patterns");

// Tally is visible on the post list.
const posts = (await ok(A, "LIST", `/groups/${lobby.id}/posts`)).rows;
const agreePost = posts.find((p) => p.id === S.consensusAgree);
assert.strictEqual(agreePost.likes, 4, "consensus-agree post has 4 likes");
assert.strictEqual(agreePost.my_vote, 1, "caller's own vote reflected");
console.log("[ok] like/dislike tallies + caller vote surfaced on posts");

// The opinion map (as member A).
const map = (await ok(A, "GET", `/groups/${lobby.id}/opinion-map`));
assert.strictEqual(map.participant_count, 4, "4 participants in the map");
assert.strictEqual(map.item_count, 4, "4 statements in the map");
assert.strictEqual(map.opinion_groups.length, 2, "two opinion groups detected");
assert.ok(map.my_cluster !== null, "caller placed in an opinion group");
assert.strictEqual(map.points.filter((p) => p.is_me).length, 1, "caller's point marked, others anonymous");
console.log(`[ok] opinion map: ${map.opinion_groups.length} groups, sizes ${map.opinion_groups.map((g) => g.size).join("/")}`);

const byId = Object.fromEntries(map.statements.map((s) => [s.item_id, s]));
assert.ok(byId[S.divisive1].divisive && byId[S.divisive2].divisive, "opposing posts flagged divisive");
assert.ok(!byId[S.consensusAgree].divisive && !byId[S.consensusDisagree].divisive, "unanimous posts not divisive");
const consensusIds = map.consensus.map((s) => s.item_id);
assert.ok(consensusIds.includes(S.consensusAgree) && consensusIds.includes(S.consensusDisagree), "both consensus posts surfaced");
assert.ok(map.consensus[0].text, "consensus items carry their text");
console.log("[ok] divisive posts flagged; consensus posts surfaced with text");

// A non-voter viewer (founder) still gets the map; their cluster is null.
const fmap = await ok(founder, "GET", `/groups/${lobby.id}/opinion-map`);
assert.strictEqual(fmap.my_cluster, null, "non-voter has no cluster");

// E2E founding/community group refuses server-mode posts + opinion map.
const founding = (await ok(founder, "LIST", "/groups", { type: "community" })).rows.find((g) => g.founding);
assert.strictEqual((await rpc(founder, "POST", `/groups/${founding.id}/posts`, { text: "x" })).status, 400, "E2E group rejects server posts");
assert.strictEqual((await rpc(founder, "GET", `/groups/${founding.id}/opinion-map`)).status, 400, "E2E group has no opinion map");
console.log("[ok] E2E community group rejects server-mode posts + opinion map");

console.log("\nALL POL.IS OPINION-MAP TESTS PASSED");
