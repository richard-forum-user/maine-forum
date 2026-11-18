/**
 * Delivery-target and envelope limits for the ciphertext inbox and outbox.
 * The pod never opens the envelope; these checks are structural only.
 */

export const MAX_ENVELOPE_BYTES = 64 * 1024;
export const MAX_CIPHERTEXT_CHARS = 48 * 1024;
export const NONCE_BYTES = 24;
export const ENVELOPE_VERSION = 1;
export const ENVELOPE_ALG = "x25519-xchacha20poly1305-ed25519";
export const MAX_ENVELOPE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_ENVELOPE_FUTURE_MS = 5 * 60 * 1000;

const FROM_ED_HEX = /^[0-9a-fA-F]{64}$/;
const SIG_HEX = /^[0-9a-fA-F]{128}$/;

export function envelopeByteLength(text) {
  return new TextEncoder().encode(text || "").length;
}

/**
 * https URLs only. IP literals (including private, loopback, and link-local
 * ranges), localhost, and URLs with embedded credentials are not deliverable.
 */
export function isDeliverablePodUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost")) return false;
  if (isIpLiteral(host)) return false;
  return true;
}

function isIpLiteral(host) {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!bare) return false;
  if (bare.includes(":")) return true;
  if (/^\d+$/.test(bare)) return true;
  if (/^0x[0-9a-f]+$/i.test(bare)) return true;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function decodeBase64(value) {
  if (typeof value !== "string" || !value || value.length > MAX_CIPHERTEXT_CHARS) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  if (value.length % 4 === 1) return null;
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const raw = atob(padded);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Structural envelope check. Returns a reason string, or null when the
 * fields are the shape this pod accepts. Signature verification is separate.
 */
export function envelopeFieldError(envelope) {
  if (!envelope || typeof envelope !== "object") return "invalid_envelope";
  for (const field of ["v", "alg", "kind", "from", "fromEd", "nonce", "ct", "sig", "ts"]) {
    if (envelope[field] == null || envelope[field] === "") return `missing_${field}`;
  }
  if (envelope.v !== ENVELOPE_VERSION) return "bad_version";
  if (envelope.alg !== ENVELOPE_ALG) return "bad_alg";
  if (envelope.kind !== "dm" && envelope.kind !== "group") return "bad_kind";
  if (typeof envelope.from !== "string") return "bad_from";
  if (typeof envelope.fromEd !== "string" || !FROM_ED_HEX.test(envelope.fromEd)) return "bad_from_ed";
  if (typeof envelope.sig !== "string" || !SIG_HEX.test(envelope.sig)) return "bad_sig";
  const nonce = decodeBase64(envelope.nonce);
  if (!nonce || nonce.length !== NONCE_BYTES) return "bad_nonce";
  if (typeof envelope.ct !== "string" || envelope.ct.length > MAX_CIPHERTEXT_CHARS) return "ciphertext_too_large";
  const ct = decodeBase64(envelope.ct);
  if (!ct || ct.length === 0) return "bad_ciphertext";
  if (envelope.kind === "dm" && !envelope.to) return "missing_to";
  if (envelope.kind === "group" && (typeof envelope.groupId !== "string" || !envelope.groupId)) {
    return "missing_group";
  }
  const ts = Date.parse(envelope.ts);
  if (Number.isNaN(ts)) return "bad_ts";
  const skew = Date.now() - ts;
  if (skew > MAX_ENVELOPE_AGE_MS) return "ts_too_old";
  if (skew < -MAX_ENVELOPE_FUTURE_MS) return "ts_too_new";
  return null;
}
