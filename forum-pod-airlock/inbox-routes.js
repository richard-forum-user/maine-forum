/**
 * Public message inbox. Peers POST E2E-sealed envelopes here. This handler:
 *   1. verifies the envelope's Ed25519 signature (tamper-evidence),
 *   2. checks the message is addressed to this pod's owner,
 *   3. forwards the SEALED envelope to the owner's PersonalPodDO.
 *
 * It never sees plaintext and stores nothing readable itself.
 */

import { declaredBodyTooLarge, podBodyTooLarge } from "./do-guards.js";

const SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

// Identity handles and pod ids are derived, not user-typed. Reject anything
// else before it is written into the inbox routing table.
const HANDLE_RE = /^pk-[0-9a-f]{16}$/;
const POD_ID_RE = /^pod-[0-9a-f]{32}$/;

function validHandle(handle) {
  return typeof handle === "string" && HANDLE_RE.test(handle);
}

function validPodId(podId) {
  return typeof podId === "string" && POD_ID_RE.test(podId);
}

function canonical(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0) throw new Error("hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function verifyEnvelopeSig(envelope) {
  const { sig, ...core } = envelope;
  if (!sig || !core.fromEd) return false;
  let raw;
  try {
    raw = hexToBytes(core.fromEd);
  } catch {
    return false;
  }
  if (raw.length !== 32) return false;
  const der = new Uint8Array(SPKI_PREFIX.length + raw.length);
  der.set(SPKI_PREFIX, 0);
  der.set(raw, SPKI_PREFIX.length);
  let key;
  try {
    key = await crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return false;
  }
  let sigBytes;
  try {
    sigBytes = hexToBytes(sig);
  } catch {
    return false;
  }
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    sigBytes,
    new TextEncoder().encode(canonical(core))
  );
}

async function ensureOwnerTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS pod_owner (
       handle TEXT PRIMARY KEY,
       pod_id TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`
  ).run();
  // One deployment, one owner pod. The first accepted PROVISION locks the
  // pod id; a later caller cannot point this inbox at a different pod.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS pod_owner_pod (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       pod_id TEXT NOT NULL
     )`
  ).run();
}

async function distinctPodIds(env) {
  const prior = await env.DB.prepare(`SELECT DISTINCT pod_id FROM pod_owner`).all();
  return (prior?.results || []).map((r) => r.pod_id).filter(Boolean);
}

/**
 * Record handle -> pod id only for the single owner pod of this deployment.
 * Returns ok:false when the caller tries to retarget a pod that is already
 * locked, or when existing rows disagree and there is nothing safe to pick.
 */
export async function recordPodOwner(env, handle, podId) {
  if (!env?.DB || !validHandle(handle) || !validPodId(podId)) {
    return { ok: false, reason: "invalid_owner_record" };
  }
  await ensureOwnerTable(env);
  let locked = await env.DB.prepare(`SELECT pod_id FROM pod_owner_pod WHERE id = 1`).first();
  if (!locked) {
    const ids = await distinctPodIds(env);
    if (ids.length > 1) return { ok: false, reason: "owner_pod_ambiguous" };
    if (ids.length === 1 && ids[0] !== podId) return { ok: false, reason: "owner_pod_mismatch" };
    await env.DB.prepare(
      `INSERT INTO pod_owner_pod (id, pod_id) VALUES (1, ?)
       ON CONFLICT(id) DO NOTHING`
    )
      .bind(podId)
      .run();
    locked = await env.DB.prepare(`SELECT pod_id FROM pod_owner_pod WHERE id = 1`).first();
  }
  if (!locked || locked.pod_id !== podId) {
    return { ok: false, reason: "owner_pod_mismatch" };
  }
  await env.DB.prepare(
    `INSERT INTO pod_owner (handle, pod_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(handle) DO UPDATE SET
       pod_id = excluded.pod_id,
       updated_at = excluded.updated_at
     WHERE pod_owner.pod_id = excluded.pod_id`
  )
    .bind(handle, podId, new Date().toISOString())
    .run();
  const row = await env.DB.prepare(`SELECT pod_id FROM pod_owner WHERE handle = ?`).bind(handle).first();
  if (!row || row.pod_id !== podId) return { ok: false, reason: "owner_pod_mismatch" };
  return { ok: true };
}

export async function lookupOwner(env, handle) {
  if (!env?.DB) return null;
  await ensureOwnerTable(env);
  const locked = await env.DB.prepare(`SELECT pod_id FROM pod_owner_pod WHERE id = 1`).first();
  const lockedId = locked?.pod_id || null;
  if (!lockedId) {
    const ids = await distinctPodIds(env);
    // More than one pod id and no lock: do not guess. Newest-row fallback
    // delivered group mail to whoever provisioned last.
    if (ids.length !== 1) return null;
  }
  const onlyId = lockedId || (await distinctPodIds(env))[0];
  if (handle) {
    const row = await env.DB.prepare(
      `SELECT handle, pod_id FROM pod_owner WHERE handle = ?`
    )
      .bind(handle)
      .first();
    if (row && row.pod_id === onlyId) return row;
    if (row) return null;
  }
  const any = await env.DB.prepare(
    `SELECT handle, pod_id FROM pod_owner WHERE pod_id = ? ORDER BY updated_at DESC LIMIT 1`
  )
    .bind(onlyId)
    .first();
  return any || null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function handleInboxRoute(request, env, url) {
  if (request.method !== "POST") {
    return json({ error: "use_post" }, 405);
  }
  if (!env.POD) return json({ error: "pod_do_not_bound" }, 500);
  if (declaredBodyTooLarge(request)) return json({ error: "payload_too_large" }, 413);

  let bodyText;
  try {
    bodyText = await request.text();
  } catch {
    return json({ error: "unreadable_body" }, 400);
  }
  if (podBodyTooLarge(bodyText)) return json({ error: "payload_too_large" }, 413);

  let envelope;
  try {
    envelope = JSON.parse(bodyText);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  // Structural validation — ciphertext-only envelopes.
  const required = ["v", "alg", "kind", "from", "fromEd", "nonce", "ct", "sig"];
  for (const f of required) {
    if (envelope[f] == null) return json({ error: "invalid_envelope", missing: f }, 400);
  }
  if (envelope.kind === "dm" && !envelope.to) {
    return json({ error: "invalid_envelope", missing: "to" }, 400);
  }
  if (envelope.kind === "group" && !envelope.groupId) {
    return json({ error: "invalid_envelope", missing: "groupId" }, 400);
  }

  const sigOk = await verifyEnvelopeSig(envelope);
  if (!sigOk) return json({ error: "bad_signature" }, 401);

  const owner = await lookupOwner(env, envelope.kind === "dm" ? envelope.to : null);
  if (!owner) return json({ error: "pod_not_provisioned" }, 503);
  if (envelope.kind === "dm" && envelope.to !== owner.handle) {
    return json({ error: "not_for_this_pod" }, 404);
  }

  const id = env.POD.idFromName(owner.pod_id);
  const stub = env.POD.get(id);
  const res = await stub.fetch(
    new Request("https://pod-do/inbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    })
  );
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
