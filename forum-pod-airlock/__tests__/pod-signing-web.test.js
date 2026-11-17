import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySignedBundle } from '../pod-signing-web.js';

function hex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function canonicalise(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

async function signedBundle(offsetMs) {
  const key = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', key.publicKey));
  const publicKeyHex = hex(spki.slice(12));
  const sessionId = 'pubkey:test';
  const payload = { verb: 'GET', path: '/bootstrap', data: null };
  const timestamp = new Date(Date.now() + offsetMs).toISOString();
  const message = canonicalise({ payload, sessionId, timestamp });
  const signature = hex(
    await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, new TextEncoder().encode(message))
  );
  return { payload, sessionId, timestamp, signature, publicKeyHex };
}

test('a timestamp 90 seconds ahead is accepted', async () => {
  const verdict = await verifySignedBundle(await signedBundle(90 * 1000));
  assert.equal(verdict.valid, true, verdict.reason);
});

test('a timestamp 6 minutes ahead is rejected', async () => {
  const verdict = await verifySignedBundle(await signedBundle(6 * 60 * 1000));
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, 'timestamp_expired');
});

test('a timestamp 6 minutes behind is still rejected', async () => {
  const verdict = await verifySignedBundle(await signedBundle(-6 * 60 * 1000));
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, 'timestamp_expired');
});
