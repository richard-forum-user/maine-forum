/**
 * Timing-safe comparison for shared secrets (Workers Web Crypto).
 */

async function digestSecret(value) {
  const bytes = new TextEncoder().encode(String(value ?? ''));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(hash);
}

/**
 * @param {string|undefined|null} provided
 * @param {string|undefined|null} expected
 * @returns {Promise<boolean>}
 */
export async function secretsEqual(provided, expected) {
  if (!provided || !expected) return false;
  const a = await digestSecret(provided);
  const b = await digestSecret(expected);
  if (a.length !== b.length) return false;
  // Workers provide timingSafeEqual. Node's Web Crypto (used by local tests)
  // does not, so fall back to a fixed-length XOR of the hashes.
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
