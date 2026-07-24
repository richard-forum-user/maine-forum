/**
 * podlink messaging identity.
 *
 * The identity is PSEUDONYMOUS: a random-looking handle plus two public keys
 * and a pod URL. No real-world PII (name, email, phone) is part of it; the
 * display name is user-chosen and entirely optional.
 *
 * Keys are derived deterministically from the BIP39 recovery phrase so the
 * same identity can be restored on a new device or paired to a second device
 * by transferring the phrase. Derived secrets are cached locally (device-owned
 * model, same as the Ed25519 signing key); the phrase itself is never stored.
 */

import { mnemonicToSeedSync } from "@scure/bip39";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  ed25519KeyPairFromSeed,
  x25519KeyPairFromSeed,
  bytesToHex,
  hexToBytes,
  b64encode,
  b64decode,
} from "./crypto.js";

const IDENTITY_PUBLIC_KEY = "podlink.identity";
const IDENTITY_SECRET_KEY = "podlink.identity.secret";
export const INVITE_PREFIX = "podlink://contact/";

function deriveHandle(edPublicKeyHex) {
  const digest = sha256(hexToBytes(edPublicKeyHex));
  return `pk-${bytesToHex(digest).slice(0, 16)}`;
}

function rootSeed(phrase) {
  return mnemonicToSeedSync(phrase).slice(0, 32);
}

/** Create (or re-derive) the identity from a recovery phrase and persist it. */
export function createIdentity(phrase, { displayName = "", podUrl = "" } = {}) {
  const seed = rootSeed(phrase);
  const ed = ed25519KeyPairFromSeed(seed);
  const x = x25519KeyPairFromSeed(seed);
  const handle = deriveHandle(ed.publicKeyHex);
  const pub = {
    handle,
    displayName: displayName || "",
    podUrl: (podUrl || "").replace(/\/$/, ""),
    edPublicKeyHex: ed.publicKeyHex,
    xPublicKeyHex: x.publicKeyHex,
    createdAt: Date.now(),
  };
  const secret = {
    edPrivateKey: bytesToHex(ed.privateKey),
    xPrivateKey: bytesToHex(x.privateKey),
  };
  localStorage.setItem(IDENTITY_PUBLIC_KEY, JSON.stringify(pub));
  localStorage.setItem(IDENTITY_SECRET_KEY, JSON.stringify(secret));
  return loadIdentity();
}

/** Load the full identity (public fields + in-memory secret keys), or null. */
export function loadIdentity() {
  let pub;
  let secret;
  try {
    pub = JSON.parse(localStorage.getItem(IDENTITY_PUBLIC_KEY) || "null");
    secret = JSON.parse(localStorage.getItem(IDENTITY_SECRET_KEY) || "null");
  } catch {
    return null;
  }
  if (!pub || !secret) return null;
  return {
    ...pub,
    edPrivateKey: hexToBytes(secret.edPrivateKey),
    xPrivateKey: hexToBytes(secret.xPrivateKey),
  };
}

export function hasIdentity() {
  return !!localStorage.getItem(IDENTITY_PUBLIC_KEY);
}

export function clearIdentity() {
  localStorage.removeItem(IDENTITY_PUBLIC_KEY);
  localStorage.removeItem(IDENTITY_SECRET_KEY);
}

export function updateIdentityFields(fields) {
  const raw = JSON.parse(localStorage.getItem(IDENTITY_PUBLIC_KEY) || "null");
  if (!raw) return null;
  const next = { ...raw, ...fields };
  if (next.podUrl) next.podUrl = String(next.podUrl).replace(/\/$/, "");
  localStorage.setItem(IDENTITY_PUBLIC_KEY, JSON.stringify(next));
  return loadIdentity();
}

/** The shape passed to crypto.sealEnvelope as `self`. */
export function selfForCrypto(identity) {
  return {
    handle: identity.handle,
    edPrivateKey: identity.edPrivateKey,
    edPublicKeyHex: identity.edPublicKeyHex,
    xPrivateKey: identity.xPrivateKey,
    xPublicKeyHex: identity.xPublicKeyHex,
  };
}

/** Public contact card — safe to share. */
export function contactCard(identity) {
  return {
    handle: identity.handle,
    displayName: identity.displayName || "",
    podUrl: identity.podUrl || "",
    ed: identity.edPublicKeyHex,
    x: identity.xPublicKeyHex,
  };
}

export function encodeInvite(card) {
  const json = JSON.stringify(card);
  return INVITE_PREFIX + b64encode(new TextEncoder().encode(json));
}

export function decodeInvite(text) {
  const trimmed = String(text || "").trim();
  const body = trimmed.startsWith(INVITE_PREFIX)
    ? trimmed.slice(INVITE_PREFIX.length)
    : trimmed;
  let card;
  try {
    card = JSON.parse(new TextDecoder().decode(b64decode(body)));
  } catch {
    throw new Error("That invite code is not valid.");
  }
  if (!card?.handle || !card?.ed || !card?.x) {
    throw new Error("Invite is missing required identity fields.");
  }
  if (!card.podUrl) {
    throw new Error("Invite is missing the contact's pod URL.");
  }
  return card;
}
