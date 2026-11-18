/**
 * podlink Pod Worker — UI assets, PersonalPodDO RPC, and the public E2E
 * message inbox. The user's own Pod; no cooperative, no AI.
 */

export { PersonalPodDO } from './pod-do.js';
import { sessionIdMatchesPubkey } from './session-binding.js';
import { checkRateLimit, clientIp, purgeStaleRateLimits } from './rate-limit.js';
import {
  MAX_POD_WRITES_PER_MINUTE,
  checkPodWriteBudget,
  podBodyTooLarge,
  podWriteCount,
  purgeStalePodUsage,
} from './do-guards.js';
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
    "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; script-src-elem 'self'; worker-src 'self' blob:; child-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
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
    headers: {
      'Content-Type': 'application/json',
      ...CORS,
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
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

async function applyIngressRateLimit(request, env, bucketSuffix, limit, windowMs) {
  if (!env.DB) return null;
  const ip = clientIp(request);
  // Without CF-Connecting-IP there is no trustworthy client address. Do not
  // fall back to X-Forwarded-For or a shared "unknown" bucket.
  if (!ip) return null;
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

function pinnedPodId(env) {
  return typeof env?.OWNER_POD_ID === 'string' ? env.OWNER_POD_ID.trim() : '';
}

function podWriteBucket(env) {
  const pinned = pinnedPodId(env);
  return pinned ? `pod:${pinned}` : '';
}

function audienceFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Pod origin bound into signed bundles. Configured URL wins over the request host. */
function expectedAudience(env, request) {
  const configured = audienceFromUrl(env?.PUBLIC_POD_URL || '');
  if (configured) return configured;
  try {
    return new URL(request.url).origin;
  } catch {
    return '';
  }
}

async function forwardPodRpc(request, env, bodyText, bundle) {
  // One owner, one Durable Object. Client-supplied pod ids are not routing keys.
  const pinned = pinnedPodId(env);
  if (!pinned) {
    return jsonResponse({ error: 'pod_not_pinned' }, 500);
  }
  if (bundle.podId != null && bundle.podId !== '' && bundle.podId !== pinned) {
    return jsonResponse({ error: 'wrong_pod' }, 403);
  }
  const aud = expectedAudience(env, request);
  if (!bundle.aud || bundle.aud !== aud) {
    return jsonResponse(
      { error: 'auth_failed', reason: bundle.aud ? 'aud_mismatch' : 'missing_aud' },
      401
    );
  }
  const id = env.POD.idFromName(pinned);
  const stub = env.POD.get(id);
  const upstream = await stub.fetch(
    new Request('https://pod-do/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pod-Aud': aud },
      body: bodyText,
    })
  );
  const text = await upstream.text();
  const headers = { 'Content-Type': 'application/json', ...CORS, ...SECURITY_HEADERS };
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
      return new Response(null, { status: 204, headers: { ...CORS, ...SECURITY_HEADERS } });
    }

    if (url.pathname === '/' && request.method === 'GET') {
      return Response.redirect(`${url.origin}/pod`, 302);
    }

    if (url.pathname === '/.well-known/security.txt' && request.method === 'GET') {
      return new Response(SECURITY_TXT, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS, ...SECURITY_HEADERS },
      });
    }

    if (url.pathname === '/api/webauthn' || url.pathname.startsWith('/api/webauthn/')) {
      return jsonResponse({ error: 'route_not_found' }, 404);
    }

    // Public inbox: peers deliver E2E ciphertext envelopes here. The handler
    // accepts ciphertext-only envelopes addressed to this pod's owner; it
    // never sees plaintext and stores nothing readable.
    if (url.pathname === INBOX_PREFIX || url.pathname.startsWith(INBOX_PREFIX + '/')) {
      const rl = await applyIngressRateLimit(request, env, 'inbox', 240, 60_000);
      if (rl) return rl;
      const inboxRes = await handleInboxRoute(request, env, url);
      return withSecurityHeaders(inboxRes);
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
      // Device auth is the Ed25519 signed bundle (verified above and in the
      // DO) plus the DO device allowlist.
      const writeBucket = podWriteBucket(env);
      if (env.DB && writeBucket) {
        const used = await podWriteCount(env.DB, writeBucket);
        if (used >= MAX_POD_WRITES_PER_MINUTE) {
          return jsonResponse({ error: 'pod_write_rate_exceeded' }, 429);
        }
      }
      // Routing is recorded only after the DO accepts PROVISION, and only
      // with the handle and pinned pod id the DO returns — never the request body.
      const pl = bundle.payload;
      const upstream = await forwardPodRpc(request, env, bodyText, bundle);
      if (
        pl &&
        pl.verb === 'PROVISION' &&
        upstream.status >= 200 &&
        upstream.status < 300 &&
        env.DB
      ) {
        try {
          const accepted = JSON.parse(await upstream.clone().text());
          const handle = accepted?.handle;
          const podId = accepted?.pod_id;
          if (handle && podId && podId === pinnedPodId(env)) {
            await recordPodOwner(env, handle, podId);
          }
        } catch {
          /* non-fatal: a later successful PROVISION can register routing */
        }
      }
      // Count the write only after the DO has accepted the device. The bucket
      // is the pinned pod, so a caller cannot mint a fresh budget by rotating
      // sessionId. Unauthorized attempts do not consume the owner's budget.
      const authorized = upstream.status !== 401 && upstream.status !== 403 && upstream.status < 500;
      if (authorized && env.DB && writeBucket) {
        const budget = await checkPodWriteBudget(env.DB, writeBucket);
        if (!budget.ok) {
          return jsonResponse({ error: budget.reason || 'pod_rate_limited' }, 429);
        }
      }
      return withSecurityHeaders(upstream);
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
          { status: 404, headers: SECURITY_HEADERS }
        );
      }
    }

    return jsonResponse(
      { error: 'route_not_found', path: url.pathname, method: request.method },
      404
    );
  },

  async scheduled(_event, env) {
    await purgeStaleRateLimits(env?.DB);
    await purgeStalePodUsage(env?.DB);
  },
};
