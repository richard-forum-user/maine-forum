/**
 * Family end-to-end crypto.
 *
 * Model: the family shares one symmetric Family Content Key (FCK) per epoch.
 * All human-readable content (post/comment/event bodies, names, captions,
 * photo bytes) is encrypted with the current-epoch FCK using XChaCha20-Poly1305.
 * The server/DO only ever stores ciphertext + public keys — never the FCK.
 *
 * Distribution: the FCK is never sent in the clear. An admin "wraps" it to a
 * member's X25519 public key (static ECDH -> HKDF -> AEAD). Only that member,
 * with their X private key, can unwrap it. Removing a member rotates to a new
 * epoch that is wrapped only to the remaining members.
 *
 * Identity: each device holds an Ed25519 signing key (RPC auth, see
 * pod-signing.js) and an X25519 key (this file, for key-wrapping). Keys live on
 * the device; losing a device means an admin re-admits the new device key.
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const NONCE = 24;

const X_STORE = "podlink.family.xkey";     // device X25519 private key (b64)
const FCK_STORE = "podlink.family.fck";     // { [epoch]: b64(key) }

// ---- encoding ------------------------------------------------------------

export function bytesToHex(b) {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
export function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("Expected a hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export function b64encode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function b64decode(b64) {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ---- device X25519 key ---------------------------------------------------

export function getDeviceX() {
  let b64 = localStorage.getItem(X_STORE);
  let priv;
  if (b64) {
    priv = b64decode(b64);
  } else {
    priv = crypto.getRandomValues(new Uint8Array(32));
    localStorage.setItem(X_STORE, b64encode(priv));
  }
  return { privateKey: priv, publicKeyHex: bytesToHex(x25519.getPublicKey(priv)) };
}

// ---- low-level AEAD ------------------------------------------------------

function aeadEncrypt(key32, plaintextStr) {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE));
  const ct = xchacha20poly1305(key32, nonce).encrypt(enc.encode(plaintextStr));
  return { n: b64encode(nonce), c: b64encode(ct) };
}
function aeadDecrypt(key32, blob) {
  const pt = xchacha20poly1305(key32, b64decode(blob.n)).decrypt(b64decode(blob.c));
  return dec.decode(pt);
}
function aeadEncryptBytes(key32, bytes) {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE));
  const ct = xchacha20poly1305(key32, nonce).encrypt(bytes);
  const out = new Uint8Array(NONCE + ct.length);
  out.set(nonce, 0);
  out.set(ct, NONCE);
  return out;
}
function aeadDecryptBytes(key32, buf) {
  const bytes = new Uint8Array(buf);
  const nonce = bytes.slice(0, NONCE);
  const ct = bytes.slice(NONCE);
  return xchacha20poly1305(key32, nonce).decrypt(ct);
}

// ---- ECDH seal (used for FCK wrapping + pending-name delivery) ------------

function ecdhKey(myXPriv, theirXPubHex) {
  const shared = x25519.getSharedSecret(myXPriv, hexToBytes(theirXPubHex));
  return hkdf(sha256, shared, undefined, enc.encode("podlink-family-wrap-v1"), 32);
}

/** Encrypt a string to a recipient's X pubkey. Returns { n, c, fromX }. */
export function sealTo(theirXPubHex, myX, plaintextStr) {
  const k = ecdhKey(myX.privateKey, theirXPubHex);
  return { ...aeadEncrypt(k, plaintextStr), fromX: myX.publicKeyHex };
}
/** Decrypt a sealed blob addressed to me. */
export function openSealed(myX, sealed) {
  const k = ecdhKey(myX.privateKey, sealed.fromX);
  return aeadDecrypt(k, sealed);
}

// ---- FCK (family content key) --------------------------------------------

export function newFck() {
  return crypto.getRandomValues(new Uint8Array(32));
}
function contentKey(fck32) {
  return hkdf(sha256, fck32, undefined, enc.encode("podlink-family-content-v1"), 32);
}

/** Wrap an FCK to a member's X pubkey (admin action). Returns sealed blob. */
export function wrapFck(memberXPubHex, myX, fck32) {
  return sealTo(memberXPubHex, myX, b64encode(fck32));
}
/** Unwrap a wrapped FCK addressed to me. Returns raw 32-byte key. */
export function unwrapFck(myX, wrapped) {
  return b64decode(openSealed(myX, wrapped));
}

// ---- local FCK cache (by epoch) ------------------------------------------

export function loadFckCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(FCK_STORE) || "{}");
    const out = {};
    for (const [ep, b64] of Object.entries(raw)) out[ep] = b64decode(b64);
    return out;
  } catch {
    return {};
  }
}
export function saveFckToCache(epoch, fck32) {
  const raw = JSON.parse(localStorage.getItem(FCK_STORE) || "{}");
  raw[String(epoch)] = b64encode(fck32);
  localStorage.setItem(FCK_STORE, JSON.stringify(raw));
}
export function clearFckCache() {
  localStorage.removeItem(FCK_STORE);
}

// ---- content encrypt/decrypt (JSON) --------------------------------------

/** Encrypt a JSON-serialisable object with an epoch's FCK. */
export function encryptContent(fck32, obj) {
  return aeadEncrypt(contentKey(fck32), JSON.stringify(obj));
}
/** Decrypt a content blob with an epoch's FCK. Returns parsed object or null. */
export function decryptContent(fck32, blob) {
  if (!fck32 || !blob) return null;
  try {
    return JSON.parse(aeadDecrypt(contentKey(fck32), blob));
  } catch {
    return null;
  }
}

// ---- photo bytes ---------------------------------------------------------

export function encryptBytes(fck32, bytes) {
  return aeadEncryptBytes(contentKey(fck32), bytes);
}
export function decryptBytes(fck32, buf) {
  return aeadDecryptBytes(contentKey(fck32), buf);
}
