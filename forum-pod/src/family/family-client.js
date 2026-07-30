/**
 * family-client — talks to the shared FamilyDO over signed RPC and handles the
 * end-to-end encryption layer on the client. The DO only ever sees ciphertext
 * and public keys; plaintext exists only on member devices.
 *
 * Identity: device Ed25519 key (RPC auth, pod-signing.js) + device X25519 key
 * (key-wrapping, family-crypto.js). Membership is admin-gated: join -> pending
 * -> an admin admits you (wraps the Family Content Key to your X key).
 */

import { signBundle, signMessageWithDeviceKey } from "../pod-signing.js";
import { enrichSignedEnvelope } from "../signing-envelope.js";
import {
  getDeviceX,
  newFck,
  wrapFck,
  unwrapFck,
  sealTo,
  openSealed,
  encryptContent,
  decryptContent,
  encryptBytes,
  decryptBytes,
  loadFckCache,
  saveFckToCache,
} from "./family-crypto.js";

export function familyRoot() {
  const override = (localStorage.getItem("podlink.familyRoot") || "").trim();
  const base = override || window.location.origin;
  return base.replace(/\/+$/, "").replace(/\/(family|pod)$/i, "").replace(/\/+$/, "");
}

async function rpc(verb, path, data = null) {
  const signed = enrichSignedEnvelope(await signBundle({ verb, path, data }));
  const url = `${familyRoot()}/api/family${path === "/" ? "" : path}`;
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signed) });
  } catch (e) {
    throw new Error(`Network error (${url}): ${e.message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${verb} ${path} failed (${res.status}): ${body?.reason || body?.error || res.statusText}`);
  return body;
}
export const familyRpc = rpc;

// ---- key management ------------------------------------------------------

let _fck = loadFckCache(); // { [epoch]: Uint8Array }
let _currentEpoch = 1;

export function currentEpoch() {
  return _currentEpoch;
}
export function currentFck() {
  return _fck[_currentEpoch] || null;
}
export function hasKey() {
  return !!currentFck();
}

/** Fetch wrapped keys addressed to us and unwrap them into the local cache. */
export async function syncKeys() {
  const myX = getDeviceX();
  const r = await rpc("GET", "/keys");
  _currentEpoch = r.current_epoch || 1;
  for (const { epoch, wrapped } of r.rows || []) {
    if (_fck[epoch]) continue;
    try {
      const fck = unwrapFck(myX, wrapped);
      _fck[epoch] = fck;
      saveFckToCache(epoch, fck);
    } catch {
      /* not addressed to us / stale wrap */
    }
  }
  return { currentEpoch: _currentEpoch, haveCurrent: !!_fck[_currentEpoch] };
}

// ---- create / join -------------------------------------------------------

/** Found a new family: mint the FCK, wrap to self, encrypt name + family name. */
export async function createFamily({ familyName, displayName }) {
  const myX = getDeviceX();
  const fck = newFck();
  _fck[1] = fck;
  _currentEpoch = 1;
  saveFckToCache(1, fck);
  const body = await rpc("PROVISION", "/", {
    x_pub: myX.publicKeyHex,
    enc_family_name: encryptContent(fck, { name: familyName }),
    enc_name: encryptContent(fck, { name: displayName }),
    wrapped_self: wrapFck(myX.publicKeyHex, myX, fck),
  });
  return body;
}

/** Join an existing family: attach our X key + a name sealed to the admin. */
export async function joinFamily({ token, displayName }) {
  if (!isValidInvite(token)) {
    throw new Error("This invite link is invalid or was made by an older version. Ask the family admin for a fresh link.");
  }
  const myX = getDeviceX();
  const sealed_name = sealTo(token.admin_x, myX, JSON.stringify({ name: displayName }));
  return rpc("POST", "/join", { token, x_pub: myX.publicKeyHex, sealed_name });
}

/** A usable invite must carry the admin's signing + key-wrap public keys. */
export function isValidInvite(token) {
  return !!(
    token &&
    typeof token.admin_x === "string" && /^[0-9a-fA-F]{64}$/.test(token.admin_x) &&
    typeof token.admin_pub === "string" &&
    typeof token.sig === "string" &&
    typeof token.exp === "string" && Date.parse(token.exp) > Date.now()
  );
}

export function getFamilyRaw() {
  return rpc("GET", "/family");
}

/** Family info with the family name decrypted (if we hold the key). */
export async function getFamily() {
  const r = await getFamilyRaw();
  await syncKeys().catch(() => {});
  const key = currentFck();
  const name = r.family?.enc_family_name && key ? decryptContent(key, r.family.enc_family_name)?.name : null;
  return { ...r, familyName: name || null };
}

export async function listMembers() {
  const r = await rpc("LIST", "/members");
  return (r.rows || []).map((m) => ({ ...m, name: resolveMemberName(m) }));
}

function resolveMemberName(m) {
  if (!m.enc_name) return null;
  const key = _fck[m.name_epoch] || currentFck();
  return key ? decryptContent(key, m.enc_name)?.name || null : null;
}

/** Map of member_pub -> display name, for attributing posts/comments. */
export async function memberNameMap() {
  const members = await rpc("LIST", "/members");
  const map = {};
  for (const m of members.rows || []) map[m.member_pub] = resolveMemberName(m) || "Member";
  return map;
}

// ---- admin: admission ----------------------------------------------------

export function listRequests() {
  return rpc("LIST", "/requests").then((r) => (r.rows || []).map((req) => ({
    member_pub: req.member_pub,
    x_pub: req.x_pub,
    created_at: req.created_at,
    name: openSealedName(req.sealed_name),
  })));
}
function openSealedName(sealed) {
  try {
    return JSON.parse(openSealed(getDeviceX(), sealed))?.name || null;
  } catch {
    return null;
  }
}

/** Admit a pending member: wrap every epoch key to them + set their name. */
export async function admitMember({ member_pub, x_pub, name }) {
  const myX = getDeviceX();
  await syncKeys();
  const keys = [];
  for (const [epoch, fck] of Object.entries(_fck)) {
    keys.push({ epoch: Number(epoch), wrapped: wrapFck(x_pub, myX, fck) });
  }
  const key = currentFck();
  return rpc("POST", "/admit", {
    member_pub,
    enc_name: name && key ? encryptContent(key, { name }) : null,
    name_epoch: _currentEpoch,
    keys,
  });
}

export function denyMember(member_pub) {
  return rpc("POST", "/deny", { member_pub });
}

/** Remove a member: rotate to a new epoch wrapped only to remaining members. */
export async function removeMember(member_pub) {
  const myX = getDeviceX();
  await syncKeys();
  const newEpoch = _currentEpoch + 1;
  const newFckBytes = newFck();
  const members = (await rpc("LIST", "/members")).rows || [];
  const keys = [];
  for (const m of members) {
    if (m.member_pub === member_pub || !m.x_pub || m.status !== "active") continue;
    keys.push({ member_pub: m.member_pub, wrapped: wrapFck(m.x_pub, myX, newFckBytes) });
  }
  // Re-encrypt the family name under the new epoch so it stays readable.
  const fam = await getFamilyRaw();
  const oldName = fam.family?.enc_family_name && currentFck() ? decryptContent(currentFck(), fam.family.enc_family_name)?.name : null;
  const res = await rpc("POST", "/remove", {
    member_pub,
    new_epoch: newEpoch,
    keys,
    enc_family_name: oldName ? encryptContent(newFckBytes, { name: oldName }) : null,
  });
  _fck[newEpoch] = newFckBytes;
  _currentEpoch = newEpoch;
  saveFckToCache(newEpoch, newFckBytes);
  return res;
}

// ---- invites -------------------------------------------------------------

const INVITE_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function makeInvite({ ttlMs = INVITE_DEFAULT_TTL_MS } = {}) {
  const myX = getDeviceX();
  const exp = new Date(Date.now() + ttlMs).toISOString();
  const nonce = crypto.randomUUID();
  const message = canonicalObj({ action: "family-invite", admin_x: myX.publicKeyHex, exp, nonce });
  const { signatureHex, publicKeyHex } = await signMessageWithDeviceKey(message);
  return { exp, nonce, admin_pub: publicKeyHex, admin_x: myX.publicKeyHex, sig: signatureHex };
}

/**
 * Create a shareable invite: sign a token, store it in the DO, and get back a
 * short code. The link carries only the code (e.g. #i=K7Q2M9XT) so it stays
 * short and survives being pasted into chat apps.
 */
export async function createInvite(opts = {}) {
  const token = await makeInvite(opts);
  const { code } = await rpc("POST", "/invites", { token });
  return { code, link: inviteLink(code), exp: token.exp };
}

export function inviteLink(code, origin = window.location.origin) {
  return `${origin.replace(/\/+$/, "")}/pod#i=${encodeURIComponent(code)}`;
}

/** Read an invite reference from the URL hash (short code or legacy inline). */
export function readInviteRef() {
  const hash = window.location.hash || "";
  const code = hash.match(/[#&]i=([^&]+)/);
  if (code) return { type: "code", value: decodeURIComponent(code[1]) };
  const inline = hash.match(/[#&]join=([^&]+)/);
  if (inline) return { type: "inline", value: inline[1] };
  return null;
}
export function hasInviteInUrl() {
  return !!readInviteRef();
}

/** Resolve an invite reference to a validated token, or null if bad/expired. */
export async function loadInvite(ref = readInviteRef()) {
  if (!ref) return null;
  try {
    let token;
    if (ref.type === "inline") {
      token = JSON.parse(b64urlDecode(ref.value));
    } else {
      const r = await rpc("GET", `/invite/${ref.value}`);
      token = r?.token;
    }
    return isValidInvite(token) ? token : null;
  } catch {
    return null;
  }
}

/** Back-compat: synchronous parse of a legacy inline invite (no server call). */
export function parseInviteFromLocation() {
  const ref = readInviteRef();
  if (!ref || ref.type !== "inline") return null;
  try {
    const token = JSON.parse(b64urlDecode(ref.value));
    return isValidInvite(token) ? token : null;
  } catch {
    return null;
  }
}

// ---- feed ----------------------------------------------------------------

export async function createPost({ body, media = [] }) {
  const key = requireKey();
  return rpc("POST", "/posts", { epoch: _currentEpoch, ct: encryptContent(key, { body, media }) });
}
export async function listPosts({ limit = 50 } = {}) {
  const r = await rpc("LIST", "/posts", { limit });
  return (r.rows || []).map((p) => decoratePost(p));
}
export async function getPost(id) {
  const r = await rpc("GET", `/posts/${id}`);
  return {
    post: decoratePost(r.post),
    comments: (r.comments || []).map((c) => ({
      id: c.id, author_pub: c.author_pub, created_at: c.created_at,
      ...(decryptContent(_fck[c.epoch], c.ct) || { body: "\uD83D\uDD12 (locked)" }),
    })),
  };
}
export function addComment(postId, body) {
  const key = requireKey();
  return rpc("POST", `/posts/${postId}/comments`, { epoch: _currentEpoch, ct: encryptContent(key, { body }) });
}
export function reactToPost(postId, emoji = "\u2764\ufe0f") {
  return rpc("POST", `/posts/${postId}/react`, { emoji });
}
export function deletePost(id) {
  return rpc("DELETE", `/posts/${id}`);
}

function decoratePost(p) {
  const plain = decryptContent(_fck[p.epoch], p.ct);
  return {
    id: p.id, author_pub: p.author_pub, epoch: p.epoch, created_at: p.created_at,
    reactions: p.reactions, my_reactions: p.my_reactions, comment_count: p.comment_count,
    body: plain?.body ?? null, media: plain?.media || [], locked: !plain,
  };
}

// ---- events --------------------------------------------------------------

export async function createEvent(evt) {
  const key = requireKey();
  return rpc("POST", "/events", { epoch: _currentEpoch, ct: encryptContent(key, evt) });
}
export async function listEvents() {
  const r = await rpc("LIST", "/events");
  return (r.rows || []).map((e) => ({
    id: e.id, created_by: e.created_by, created_at: e.created_at, rsvps: e.rsvps,
    ...(decryptContent(_fck[e.epoch], e.ct) || { title: "\uD83D\uDD12 (locked)", locked: true }),
  }));
}
export function rsvpEvent(eventId, status) {
  return rpc("POST", `/events/${eventId}/rsvp`, { status });
}
export function deleteEvent(id) {
  return rpc("DELETE", `/events/${id}`);
}

// ---- albums / photos -----------------------------------------------------

export async function createAlbum(title) {
  const key = requireKey();
  return rpc("POST", "/albums", { epoch: _currentEpoch, ct: encryptContent(key, { title }) });
}
export async function listAlbums() {
  const r = await rpc("LIST", "/albums");
  return (r.rows || []).map((a) => ({
    id: a.id, n: a.n, cover: a.cover, cover_epoch: a.cover_epoch, created_at: a.created_at,
    ...(decryptContent(_fck[a.epoch], a.ct) || { title: "\uD83D\uDD12 (locked)" }),
  }));
}
export async function getAlbum(id) {
  const r = await rpc("GET", `/albums/${id}`);
  return {
    album: { id: r.album.id, ...(decryptContent(_fck[r.album.epoch], r.album.ct) || { title: "Album" }) },
    photos: (r.photos || []).map((p) => ({
      id: p.id, r2_key: p.r2_key, epoch: p.epoch, author_pub: p.author_pub, created_at: p.created_at,
      ...(p.ct ? decryptContent(_fck[p.epoch], p.ct) || {} : {}),
    })),
  };
}

/** Encrypt bytes with the current FCK, upload ciphertext to R2, record photo. */
export async function uploadPhoto({ albumId, file, caption = "" }) {
  const key = requireKey();
  const plainBytes = new Uint8Array(await file.arrayBuffer());
  const cipherBytes = encryptBytes(key, plainBytes);
  const authBundle = enrichSignedEnvelope(await signBundle({ verb: "POST", path: "/media/authorize", data: {} }));
  const authHeader = b64encodeUtf8(JSON.stringify(authBundle));
  const res = await fetch(`${familyRoot()}/api/family/media`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Podlink-Auth": authHeader },
    body: cipherBytes,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`upload failed (${res.status}): ${body?.reason || body?.error}`);
  await rpc("POST", "/photos", { album_id: albumId, r2_key: body.r2_key, epoch: _currentEpoch, ct: encryptContent(key, { caption }) });
  return { r2_key: body.r2_key };
}

/** Fetch encrypted photo bytes and decrypt to an object URL for display. */
export async function photoObjectUrl(r2Key, epoch) {
  const key = _fck[epoch] || currentFck();
  if (!key) return null;
  const res = await fetch(`${familyRoot()}/api/family/media/${r2Key}`);
  if (!res.ok) return null;
  try {
    const plain = decryptBytes(key, await res.arrayBuffer());
    return URL.createObjectURL(new Blob([plain]));
  } catch {
    return null;
  }
}

// ---- helpers -------------------------------------------------------------

function requireKey() {
  const k = currentFck();
  if (!k) throw new Error("Waiting to be admitted to the family (no key yet).");
  return k;
}
function canonicalObj(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}
function b64encodeUtf8(str) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}
function b64urlEncode(str) {
  return b64encodeUtf8(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
