/**
 * podlink Pod Worker — UI assets, WebAuthn, PersonalPodDO RPC, and the
 * public E2E message inbox. The user's own Pod; no cooperative, no AI.
 */

export { PersonalPodDO } from './pod-do.js';
import { sessionIdMatchesPubkey } from './session-binding.js';
import {
  issueUnlockToken,
  isLocalDeviceCredentialId,
  isPilotCredentialId,
  verifyUnlockToken,
} from './unlock-token.js';
import { checkRateLimit, clientIp } from './rate-limit.js';
import { checkPodWriteBudget, podBodyTooLarge } from './do-guards.js';
import { handleWebAuthnRoute } from './webauthn-server.js';
import { handleInboxRoute, recordPodOwner } from './inbox-routes.js';

const POD_API_PREFIX = '/api/pod';
const INBOX_PREFIX = '/api/inbox';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' blob: https://cdn.jsdelivr.net 'wasm-unsafe-eval'; script-src-elem 'self' https://cdn.jsdelivr.net; worker-src 'self' blob:; child-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https: blob:; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extraHeaders },
  });
}

async function assertSessionBinding(bundle) {
  if (!bundle?.publicKeyHex || !bundle?.sessionId) {
    return { ok: false, reason: 'missing_session_or_pubkey' };
  }
  const matches = await sessionIdMatchesPubkey(bundle.sessionId, bundle.publicKeyHex);
  if (!matches) {
    return { ok: false, reason: 'session_id_binding_mismatch' };
  }
  return { ok: true };
}

async function assertUnlocked(env, bundle) {
  if (!env.UNLOCK_TOKEN_KEY) {
    return { ok: true, skipped: true };
  }
  const deviceCredentialId = bundle.deviceCredentialId || null;
  if (isPilotCredentialId(deviceCredentialId)) {
    if (env.ALLOW_PILOT_BUNDLES === '1') {
      return { ok: true, pilot: true };
    }
    return { ok: false, reason: 'pilot_bundles_disabled' };
  }
  if (isLocalDeviceCredentialId(deviceCredentialId)) {
    return { ok: true, local: true };
  }
  if (!deviceCredentialId) {
    return { ok: false, reason: 'missing_device_credential_id' };
  }
  const verdict = await verifyUnlockToken(
    env,
    bundle.unlockToken,
    bundle.signature,
    env.DB
  );
  if (!verdict.ok) {
    return verdict;
  }
  if (deviceCredentialId && deviceCredentialId !== verdict.credentialId) {
    return { ok: false, reason: 'credential_mismatch' };
  }
  return { ok: true };
}

async function applyIngressRateLimit(request, env, bucketSuffix, limit, windowMs) {
  if (!env.DB) return null;
  const ip = clientIp(request);
  const verdict = await checkRateLimit(env.DB, `${bucketSuffix}:${ip}`, limit, windowMs);
  if (!verdict.ok) {
    return jsonResponse(
      { error: 'rate_limited', retry_after_sec: verdict.retryAfterSec },
      429,
      { 'Retry-After': String(verdict.retryAfterSec || 60) }
    );
  }
  return null;
}

async function forwardPodRpc(request, env, bodyText, bundle) {
  // Route by stable pod id (shared across the owner's devices) when present,
  // falling back to the device session id for single-device use.
  const routeName = bundle.podId || bundle.sessionId;
  const id = env.POD.idFromName(routeName);
  const stub = env.POD.get(id);
  const upstream = await stub.fetch(
    new Request('https://pod-do/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyText,
    })
  );
  const text = await upstream.text();
  const headers = { 'Content-Type': 'application/json', ...CORS };
  return new Response(text, { status: upstream.status, headers });
}

const SECURITY_TXT = `Contact: mailto:security@yourcommunity.forum
Expires: 2027-05-26T00:00:00.000Z
Preferred-Languages: en
Canonical: https://pod.yourcommunity.forum/.well-known/security.txt
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/' && request.method === 'GET') {
      return Response.redirect(`${url.origin}/pod`, 302);
    }

    if (url.pathname === '/.well-known/security.txt' && request.method === 'GET') {
      return new Response(SECURITY_TXT, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS },
      });
    }

    if (url.pathname.startsWith('/api/webauthn/')) {
      const webauthnRes = await handleWebAuthnRoute(request, env, url, issueUnlockToken);
      if (webauthnRes) return webauthnRes;
    }

    // Public inbox: peers deliver E2E ciphertext envelopes here. The handler
    // accepts ciphertext-only envelopes addressed to this pod's owner; it
    // never sees plaintext and stores nothing readable.
    if (url.pathname === INBOX_PREFIX || url.pathname.startsWith(INBOX_PREFIX + '/')) {
      const rl = await applyIngressRateLimit(request, env, 'inbox', 240, 60_000);
      if (rl) return rl;
      const inboxRes = await handleInboxRoute(request, env, url);
      return inboxRes;
    }

    if (url.pathname.startsWith(POD_API_PREFIX + '/') || url.pathname === POD_API_PREFIX) {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'use_post' }, 405);
      }
      const rl = await applyIngressRateLimit(request, env, 'pod_rpc', 120, 60_000);
      if (rl) return rl;
      if (!env.POD) {
        return jsonResponse({ error: 'pod_do_not_bound' }, 500);
      }
      let bodyText;
      try {
        bodyText = await request.text();
      } catch {
        return jsonResponse({ error: 'unreadable_body' }, 400);
      }
      if (podBodyTooLarge(bodyText)) {
        return jsonResponse({ error: 'payload_too_large' }, 413);
      }
      let bundle;
      try {
        bundle = JSON.parse(bodyText);
      } catch {
        return jsonResponse({ error: 'invalid_json' }, 400);
      }
      const binding = await assertSessionBinding(bundle);
      if (!binding.ok) {
        return jsonResponse({ error: 'auth_failed', reason: binding.reason }, 401);
      }
      // podlink has no passkey/unlock-token layer: device auth is the Ed25519
      // signed bundle (verified above + in the DO) plus the DO device
      // allowlist. The legacy WebAuthn unlock gate is intentionally not used.
      const sessionId = bundle.sessionId;
      if (env.DB) {
        const budget = await checkPodWriteBudget(env.DB, sessionId);
        if (!budget.ok) {
          return jsonResponse({ error: budget.reason || 'pod_rate_limited' }, 429);
        }
      }
      // Record handle -> pod-id routing so the public inbox can deliver mail
      // to this owner's Durable Object across all their devices.
      const pl = bundle.payload;
      if (pl && pl.verb === 'PROVISION' && pl.data && pl.data.handle && pl.data.pod_id && env.DB) {
        try {
          await recordPodOwner(env, pl.data.handle, pl.data.pod_id);
        } catch {
          /* non-fatal: inbox routing can be re-registered later */
        }
      }
      return forwardPodRpc(request, env, bodyText, bundle);
    }

    // Any non-API GET maps to the static asset bundle. Unmatched paths
    // fall through to the SPA shell so deep-links / PWA refreshes don't
    // return raw `route_not_found` JSON to the user.
    if (request.method === 'GET') {
      try {
        const assetUrl = new URL(request.url);
        if (assetUrl.pathname === '/pod' || assetUrl.pathname === '/pod/') {
          assetUrl.pathname = '/';
        } else if (assetUrl.pathname.startsWith('/pod/')) {
          assetUrl.pathname = assetUrl.pathname.replace(/^\/pod/, '') || '/index.html';
        }
        const assetRes = await env.ASSETS.fetch(new Request(assetUrl, request));
        if (assetRes.status === 404) {
          // SPA fallback: serve the bundle shell for unknown paths.
          const fallback = new URL(request.url);
          fallback.pathname = '/';
          const shell = await env.ASSETS.fetch(new Request(fallback, request));
          return withSecurityHeaders(shell);
        }
        return withSecurityHeaders(assetRes);
      } catch {
        return new Response(
          'Pod UI not found. Run: cd forum-pod-airlock && npm run build:pod',
          { status: 404 }
        );
      }
    }

    return jsonResponse(
      { error: 'route_not_found', path: url.pathname, method: request.method },
      404
    );
  },
};
