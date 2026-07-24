/**
 * Public message inbox. Peers POST E2E-sealed envelopes here. This handler:
 *   1. verifies the envelope's Ed25519 signature (tamper-evidence),
 *   2. checks the message is addressed to this pod's owner,
 *   3. forwards the SEALED envelope to the owner's PersonalPodDO.
 *
 * It never sees plaintext and stores nothing readable itself.
 */

const SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

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
}

export async function recordPodOwner(env, handle, podId) {
  if (!env?.DB || !handle || !podId) return;
  await ensureOwnerTable(env);
  await env.DB.prepare(
    `INSERT INTO pod_owner (handle, pod_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(handle) DO UPDATE SET pod_id = excluded.pod_id, updated_at = excluded.updated_at`
  )
    .bind(handle, podId, new Date().toISOString())
    .run();
}

async function lookupOwner(env, handle) {
  if (!env?.DB) return null;
  await ensureOwnerTable(env);
  if (handle) {
    const row = await env.DB.prepare(
      `SELECT handle, pod_id FROM pod_owner WHERE handle = ?`
    )
      .bind(handle)
      .first();
    if (row) return row;
  }
  // Group messages have no recipient handle; fall back to the (single) owner.
  const any = await env.DB.prepare(
    `SELECT handle, pod_id FROM pod_owner ORDER BY updated_at DESC LIMIT 1`
  ).first();
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

  let envelope;
  try {
    envelope = await request.json();
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
