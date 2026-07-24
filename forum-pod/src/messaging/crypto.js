/**
 * podlink E2E message crypto.
 *
 * Threat model: the plaintext of a message exists ONLY on the sender's and
 * recipient's devices. Pods (sender's and recipient's) and the transport
 * only ever handle the sealed envelope. PII lives in the plaintext, so PII
 * never leaves the device.
 *
 * Primitives:
 *   - X25519 (static-static ECDH) -> HKDF-SHA256 -> XChaCha20-Poly1305 AEAD
 *     for 1:1 direct messages.
 *   - A random 32-byte group key + XChaCha20-Poly1305 for group channels;
 *     the group key itself is delivered to each member as a 1:1 message.
 *   - Ed25519 detached signature over the canonical envelope core for sender
 *     authenticity and tamper-evidence (also verified by the receiving pod).
 */

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const DM_KDF_INFO = "podlink-dm-v1";
const GROUP_KDF_INFO = "podlink-group-v1";
const NONCE_BYTES = 24;
export const ENVELOPE_VERSION = 1;
export const ENVELOPE_ALG = "x25519-xchacha20poly1305-ed25519";

// ---- encoding helpers -----------------------------------------------------

export function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0) {
    throw new Error("hex string expected");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
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

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Deterministic JSON (sorted keys) — must match the worker verifier. */
export function canonical(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

// ---- keys -----------------------------------------------------------------

/** Derive an X25519 encryption keypair from 32 bytes of seed material. */
export function x25519KeyPairFromSeed(seed32) {
  const priv = hkdf(sha256, seed32, undefined, enc.encode("podlink-x25519-v1"), 32);
  const pub = x25519.getPublicKey(priv);
  return { privateKey: priv, publicKeyHex: bytesToHex(pub) };
}

/** Derive an Ed25519 signing keypair from 32 bytes of seed material. */
export function ed25519KeyPairFromSeed(seed32) {
  const priv = hkdf(sha256, seed32, undefined, enc.encode("podlink-ed25519-v1"), 32);
  const pub = ed25519.getPublicKey(priv);
  return { privateKey: priv, publicKeyHex: bytesToHex(pub) };
}

function dmKey(myXPriv, theirXPubHex) {
  const shared = x25519.getSharedSecret(myXPriv, hexToBytes(theirXPubHex));
  return hkdf(sha256, shared, undefined, enc.encode(DM_KDF_INFO), 32);
}

function groupKey(rawGroupKey32) {
  return hkdf(sha256, rawGroupKey32, undefined, enc.encode(GROUP_KDF_INFO), 32);
}

export function randomGroupKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}

// ---- envelope sealing -----------------------------------------------------

function seal(aeadKey, plaintextStr) {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ct = xchacha20poly1305(aeadKey, nonce).encrypt(enc.encode(plaintextStr));
  return { nonceB64: b64encode(nonce), ctB64: b64encode(ct) };
}

function open(aeadKey, nonceB64, ctB64) {
  const nonce = b64decode(nonceB64);
  const ct = b64decode(ctB64);
  const pt = xchacha20poly1305(aeadKey, nonce).decrypt(ct);
  return dec.decode(pt);
}

/**
 * Build a signed, sealed envelope.
 *
 * @param {object} self     { edPrivateKey, edPublicKeyHex, xPrivateKey, handle }
 * @param {object} target   for dm: { kind:'dm', toHandle, xPublicKeyHex }
 *                          for group: { kind:'group', groupId, rawGroupKey }
 * @param {object} message  arbitrary JSON-serialisable plaintext (body, etc.)
 */
export function sealEnvelope(self, target, message) {
  const plaintext = JSON.stringify(message);
  let aeadKey;
  const core = {
    v: ENVELOPE_VERSION,
    alg: ENVELOPE_ALG,
    kind: target.kind,
    from: self.handle,
    fromEd: self.edPublicKeyHex,
    fromX: self.xPublicKeyHex,
    threadId: target.threadId || (target.kind === "group" ? `g:${target.groupId}` : null),
    ts: new Date().toISOString(),
  };
  if (target.kind === "dm") {
    aeadKey = dmKey(self.xPrivateKey, target.xPublicKeyHex);
    core.to = target.toHandle;
  } else if (target.kind === "group") {
    aeadKey = groupKey(target.rawGroupKey);
    core.groupId = target.groupId;
  } else {
    throw new Error(`unknown target kind: ${target.kind}`);
  }
  const sealed = seal(aeadKey, plaintext);
  core.nonce = sealed.nonceB64;
  core.ct = sealed.ctB64;
  const sig = ed25519.sign(enc.encode(canonical(core)), self.edPrivateKey);
  return { ...core, sig: bytesToHex(sig) };
}

/** Verify the envelope signature against its claimed sender Ed25519 key. */
export function verifyEnvelopeSig(envelope) {
  const { sig, ...core } = envelope;
  if (!sig || !core.fromEd) return false;
  try {
    return ed25519.verify(hexToBytes(sig), enc.encode(canonical(core)), hexToBytes(core.fromEd));
  } catch {
    return false;
  }
}

/** Decrypt a 1:1 envelope addressed to us, using the sender X key in the envelope. */
export function openDmEnvelope(self, envelope) {
  if (!verifyEnvelopeSig(envelope)) throw new Error("bad_signature");
  if (!envelope.fromX) throw new Error("missing_sender_x_key");
  const aeadKey = dmKey(self.xPrivateKey, envelope.fromX);
  return JSON.parse(open(aeadKey, envelope.nonce, envelope.ct));
}

/** Decrypt a group envelope using a known group key. */
export function openGroupEnvelope(rawGroupKey, envelope) {
  if (!verifyEnvelopeSig(envelope)) throw new Error("bad_signature");
  const aeadKey = groupKey(rawGroupKey);
  return JSON.parse(open(aeadKey, envelope.nonce, envelope.ct));
}
