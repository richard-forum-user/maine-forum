/**
 * Short-lived HMAC tokens issued after WebAuthn. Pod RPC does not require
 * them: device auth is the Ed25519 allowlist on the Durable Object. Nothing
 * in this worker verifies these tokens.
 */

const UNLOCK_TTL_MS = 5 * 60 * 1000;

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function importHmacKey(secret) {
  const raw = new TextEncoder().encode(secret);
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

export async function issueUnlockToken(env, credentialId) {
  const secret = env.UNLOCK_TOKEN_KEY;
  if (!secret || !credentialId) {
    return null;
  }
  const expiresAtMs = Date.now() + UNLOCK_TTL_MS;
  const jti = crypto.randomUUID();
  const payload = `${credentialId}:${expiresAtMs}:${jti}`;
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return {
    credentialId,
    expiresAtMs,
    jti,
    mac: bytesToHex(new Uint8Array(sig)),
  };
}
