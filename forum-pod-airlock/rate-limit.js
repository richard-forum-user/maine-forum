/**
 * D1-backed fixed-window rate limits at the Worker edge.
 * One atomic upsert increments and returns the count. Stale rows are
 * removed by the Cron Trigger, not on the request path.
 */

export async function ensureRateLimitSchema(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS edge_rate_limits (
        bucket TEXT NOT NULL,
        window_start_ms INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket, window_start_ms)
      )`
    )
    .run();
}

/**
 * @returns {{ ok: boolean, retryAfterSec?: number }}
 */
export async function checkRateLimit(db, bucket, limit, windowMs) {
  if (!db || !bucket) return { ok: true };
  await ensureRateLimitSchema(db);
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db
    .prepare(
      `INSERT INTO edge_rate_limits (bucket, window_start_ms, count)
       VALUES (?, ?, 1)
       ON CONFLICT(bucket, window_start_ms) DO UPDATE SET count = count + 1
       RETURNING count`
    )
    .bind(bucket, windowStart)
    .first();
  const count = Number(row?.count || 0);
  if (count > limit) {
    const retryAfterSec = Math.ceil((windowStart + windowMs - now) / 1000);
    return { ok: false, retryAfterSec };
  }
  return { ok: true };
}

/** Drop windows older than an hour. Invoked from the scheduled handler. */
export async function purgeStaleRateLimits(db, now = Date.now()) {
  if (!db) return;
  await ensureRateLimitSchema(db);
  const cutoff = now - 60 * 60 * 1000;
  await db.prepare(`DELETE FROM edge_rate_limits WHERE window_start_ms < ?`).bind(cutoff).run();
}

/** Cloudflare's client IP. No X-Forwarded-For and no shared "unknown" bucket. */
export function clientIp(request) {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return null;
  const trimmed = ip.trim();
  return trimmed || null;
}
