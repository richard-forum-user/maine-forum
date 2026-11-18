/**
 * Pre-Durable-Object ingress guards: payload size and a single write budget
 * for the pinned pod. The budget is not keyed on a caller-supplied session id.
 */

export const MAX_POD_BODY_BYTES = 256 * 1024;
export const MAX_POD_WRITES_PER_MINUTE = 60;

export function podBodyTooLarge(bodyText) {
  if (!bodyText) return false;
  return new TextEncoder().encode(bodyText).length > MAX_POD_BODY_BYTES;
}

export async function ensurePodUsageSchema(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS pod_usage_windows (
        session_id TEXT NOT NULL,
        window_start_ms INTEGER NOT NULL,
        write_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, window_start_ms)
      )`
    )
    .run();
}

function currentWindowStart(now = Date.now()) {
  const windowMs = 60_000;
  return Math.floor(now / windowMs) * windowMs;
}

/** Current authorized-write count for this pod in the open minute. */
export async function podWriteCount(db, bucket) {
  if (!db || !bucket) return 0;
  await ensurePodUsageSchema(db);
  const row = await db
    .prepare(
      `SELECT write_count FROM pod_usage_windows
       WHERE session_id = ? AND window_start_ms = ?`
    )
    .bind(bucket, currentWindowStart())
    .first();
  return Number(row?.write_count || 0);
}

/**
 * Count one authorized write against the pinned pod. Atomic upsert so two
 * overlapping requests cannot both observe a stale count.
 * @returns {{ ok: boolean, reason?: string }}
 */
export async function checkPodWriteBudget(db, bucket) {
  if (!db || !bucket) return { ok: true };
  await ensurePodUsageSchema(db);
  const row = await db
    .prepare(
      `INSERT INTO pod_usage_windows (session_id, window_start_ms, write_count)
       VALUES (?, ?, 1)
       ON CONFLICT(session_id, window_start_ms) DO UPDATE SET write_count = write_count + 1
       RETURNING write_count`
    )
    .bind(bucket, currentWindowStart())
    .first();
  const count = Number(row?.write_count || 0);
  if (count > MAX_POD_WRITES_PER_MINUTE) {
    return { ok: false, reason: "pod_write_rate_exceeded" };
  }
  return { ok: true };
}

export async function purgeStalePodUsage(db, now = Date.now()) {
  if (!db) return;
  await ensurePodUsageSchema(db);
  const cutoff = now - 60 * 60 * 1000;
  await db.prepare(`DELETE FROM pod_usage_windows WHERE window_start_ms < ?`).bind(cutoff).run();
}
