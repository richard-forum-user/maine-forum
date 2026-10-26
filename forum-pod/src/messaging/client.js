/**
 * podlink messaging client. Talks to the user's own pod over signed RPC and
 * implements the send path:
 *   - seal plaintext to the recipient (E2E),
 *   - store a sealed self-copy in our own pod (ciphertext),
 *   - hand the sealed envelope to our pod's outbox for store-and-forward
 *     delivery to the recipient pod's /api/inbox.
 *
 * Plaintext exists only in memory on this device. The pod, the transport and
 * the recipient pod only ever handle sealed envelopes.
 */

import { signBundle, ensurePodSigningKey } from "../pod-signing.js";
import { enrichSignedEnvelope } from "../signing-envelope.js";
import { httpProviderUrl } from "../pod-adapter-http.js";
import { loadSigningMeta } from "../member-store.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { loadIdentity, selfForCrypto } from "./identity.js";
import {
  sealEnvelope,
  openDmEnvelope,
  openGroupEnvelope,
  senderHandleBound,
  randomGroupKey,
  canonical,
  bytesToHex,
  hexToBytes,
  b64encode,
  b64decode,
} from "./crypto.js";

const GROUP_KEYS_STORE = "podlink.groupKeys";

/** Stable pod id derived from the messaging identity; shared across devices. */
export function podIdFor(identity) {
  return "pod-" + bytesToHex(sha256(hexToBytes(identity.edPublicKeyHex))).slice(0, 32);
}

function podRoot(identity, base) {
  // The Pod API is at <origin>/api/pod; strip any trailing slash or `/pod`
  // (the served app path) that may have leaked into the stored URL.
  const root = (base || httpProviderUrl() || identity.podUrl || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/pod$/i, "")
    .replace(/\/+$/, "");
  if (!root) throw new Error("No pod URL configured. Finish setup first.");
  return root;
}

async function rpc(verb, path, data = null, opts = {}) {
  const identity = opts.identity || loadIdentity();
  if (!identity) throw new Error("Create your identity first.");
  const signed = enrichSignedEnvelope(await signBundle({ verb, path, data }));
  signed.podId = podIdFor(identity);
  const url = `${podRoot(identity, opts.base)}/api/pod${path === "/" ? "" : path}`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signed),
    });
  } catch (e) {
    throw new Error(`Pod network error (${url}): ${e.message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${verb} ${path} failed (${res.status}): ${body?.reason || body?.error || res.statusText}`);
  }
  return body;
}

export const podRpc = rpc;

// ---- provisioning / identity registration --------------------------------

export async function provisionPod(opts = {}) {
  const identity = opts.identity || loadIdentity();
  return rpc(
    "PROVISION",
    "/",
    {
      handle: identity.handle,
      pod_id: podIdFor(identity),
      // The phrase-derived identity key doubles as the pod-local recovery key.
      recovery_pub: identity.edPublicKeyHex,
    },
    opts
  );
}

export async function authorizeDevice(edPubHex, label, opts = {}) {
  return rpc("PUT", "/devices/authorize", { ed_pub: edPubHex, label }, opts);
}

/**
 * Re-pair THIS device on a pod we no longer have an authorized device for,
 * by proving possession of the recovery key (the phrase-derived identity key).
 * Used after device loss / when restoring from a recovery phrase.
 */
export async function recoverDevice(opts = {}) {
  const identity = opts.identity || loadIdentity();
  await ensurePodSigningKey();
  const devicePub = loadSigningMeta()?.publicKeyHex;
  if (!devicePub) throw new Error("no device signing key");
  const ts = new Date().toISOString();
  const message = canonical({ action: "recover-device", ed_pub: devicePub, ts });
  const recovery_sig = bytesToHex(ed25519.sign(new TextEncoder().encode(message), identity.edPrivateKey));
  return rpc("PUT", "/devices/recover", { ed_pub: devicePub, ts, recovery_sig }, opts);
}

export async function listDevices(opts = {}) {
  return (await rpc("LIST", "/devices", null, opts)).rows || [];
}

// ---- contacts -------------------------------------------------------------

export async function addContact(card, opts = {}) {
  await rpc(
    "PUT",
    `/contacts/${encodeURIComponent(card.handle)}`,
    { display_name: card.displayName || "", pod_url: card.podUrl, ed: card.ed, x: card.x },
    opts
  );
  return card;
}

export async function listContacts(opts = {}) {
  return (await rpc("LIST", "/contacts", null, opts)).rows || [];
}

export async function deleteContact(handle, opts = {}) {
  return rpc("DELETE", `/contacts/${encodeURIComponent(handle)}`, null, opts);
}

async function contactsByHandle(opts = {}) {
  const rows = await listContacts(opts);
  const map = {};
  for (const r of rows) map[r.handle] = r;
  return map;
}

// ---- threads / messages ---------------------------------------------------

export async function listThreads(opts = {}) {
  return (await rpc("LIST", "/threads", null, opts)).rows || [];
}

export async function listMessages(threadId, after = "", opts = {}) {
  return (await rpc("LIST", "/messages", { thread_id: threadId, after }, opts)).rows || [];
}

// ---- send (1:1) -----------------------------------------------------------

export async function sendDm(contact, message, opts = {}) {
  const identity = opts.identity || loadIdentity();
  const self = selfForCrypto(identity);
  const threadId = `dm:${contact.handle}`;
  // Sealed to the recipient — this is what gets delivered.
  const recipientEnvelope = sealEnvelope(
    self,
    { kind: "dm", toHandle: contact.handle, xPublicKeyHex: contact.x, threadId },
    message
  );
  // Sealed to ourselves — our own pod history copy, readable by our devices.
  const selfEnvelope = sealEnvelope(
    self,
    { kind: "dm", toHandle: identity.handle, xPublicKeyHex: identity.xPublicKeyHex, threadId },
    message
  );
  const msgId = recipientEnvelope.sig.slice(0, 48);
  await rpc(
    "PUT",
    `/messages/${msgId}`,
    { thread_id: threadId, kind: "dm", direction: "out", peer_handle: contact.handle, envelope: selfEnvelope },
    opts
  );
  await rpc(
    "PUT",
    `/outbox/${msgId}`,
    { to_pod_url: contact.podUrl || contact.pod_url, envelope: recipientEnvelope },
    opts
  );
  return { msgId, threadId };
}

// ---- groups ---------------------------------------------------------------

function loadGroupKeys() {
  try {
    return JSON.parse(localStorage.getItem(GROUP_KEYS_STORE) || "{}");
  } catch {
    return {};
  }
}

/**
 * Group key records. Legacy entries are a bare base64 string; new entries are
 * { key, roster, from } so the client can check group senders against the
 * roster and know who distributed the key.
 */
function normalizeGroupRecord(value) {
  if (!value) return null;
  if (typeof value === "string") return { key: value, roster: null, from: null };
  if (typeof value === "object" && typeof value.key === "string") return value;
  return null;
}

export function getGroupRecord(groupId) {
  return normalizeGroupRecord(loadGroupKeys()[groupId]);
}

function saveGroupKey(groupId, rawKeyB64, meta = {}) {
  const all = loadGroupKeys();
  all[groupId] = {
    key: rawKeyB64,
    roster: Array.isArray(meta.roster) ? meta.roster : null,
    from: meta.from || null,
  };
  localStorage.setItem(GROUP_KEYS_STORE, JSON.stringify(all));
}

export function getGroupRawKey(groupId) {
  const rec = getGroupRecord(groupId);
  return rec ? b64decode(rec.key) : null;
}

/** Create a group, store its key locally + sealed-to-self in the pod, and
 * distribute the key to each member via a 1:1 control message. */
export async function createGroup(title, members, opts = {}) {
  const identity = opts.identity || loadIdentity();
  const self = selfForCrypto(identity);
  const groupId = "g-" + bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
  const rawKey = randomGroupKey();
  const rawKeyB64 = b64encode(rawKey);
  const roster = [
    { handle: identity.handle, x: identity.xPublicKeyHex, podUrl: identity.podUrl },
    ...members.map((m) => ({ handle: m.handle, x: m.x, podUrl: m.podUrl || m.pod_url })),
  ];
  saveGroupKey(groupId, rawKeyB64, { roster, from: identity.handle });

  // Sealed-to-self copy of the key for our other devices.
  const sealedKey = sealEnvelope(
    self,
    { kind: "dm", toHandle: identity.handle, xPublicKeyHex: identity.xPublicKeyHex, threadId: `g:${groupId}` },
    { type: "group-key", groupId, title, key: rawKeyB64, roster }
  );
  await rpc(
    "PUT",
    `/groups/${groupId}`,
    { title, sealed_key: JSON.stringify(sealedKey), roster_json: JSON.stringify(roster) },
    opts
  );

  // Distribute the group key to each member as a 1:1 control message.
  for (const m of members) {
    await sendDm(
      { handle: m.handle, x: m.x, podUrl: m.podUrl || m.pod_url },
      { type: "group-key", groupId, title, key: rawKeyB64, roster },
      opts
    );
  }
  return { groupId, title, roster };
}

export async function listGroups(opts = {}) {
  return (await rpc("LIST", "/groups", null, opts)).rows || [];
}

export async function sendGroup(group, message, opts = {}) {
  const identity = opts.identity || loadIdentity();
  const self = selfForCrypto(identity);
  const rawKey = getGroupRawKey(group.group_id || group.groupId);
  if (!rawKey) throw new Error("Missing group key for this group.");
  const groupId = group.group_id || group.groupId;
  const roster = JSON.parse(group.roster_json || JSON.stringify(group.roster || []));
  const envelope = sealEnvelope(
    self,
    { kind: "group", groupId, rawGroupKey: rawKey },
    message
  );
  const msgId = envelope.sig.slice(0, 48);
  await rpc(
    "PUT",
    `/messages/${msgId}`,
    { thread_id: `g:${groupId}`, kind: "group", direction: "out", group_id: groupId, envelope },
    opts
  );
  for (const m of roster) {
    if (m.handle === identity.handle) continue;
    await rpc("PUT", `/outbox/${msgId}-${m.handle}`, { to_pod_url: m.podUrl || m.pod_url, envelope }, opts);
  }
  return { msgId, envelope };
}

// ---- decryption (render-time, on device) ----------------------------------

/**
 * Check the envelope's sender against what we already trust.
 *   - The claimed handle must hash from the claimed signing key.
 *   - Our own messages must carry our own keys.
 *   - Anyone else must be a saved contact whose stored keys match the envelope.
 * Returns null when trusted, or a short reason string when not.
 */
function senderProblem(identity, envelope, contacts) {
  if (!senderHandleBound(envelope)) return "sender_handle_mismatch";
  if (envelope.from === identity.handle) {
    if (envelope.fromEd !== identity.edPublicKeyHex) return "self_key_mismatch";
    if (envelope.kind === "dm" && envelope.fromX !== identity.xPublicKeyHex) return "self_key_mismatch";
    return null;
  }
  const c = contacts?.[envelope.from];
  if (!c) return "unknown_sender";
  if (c.ed !== envelope.fromEd) return "contact_key_mismatch";
  if (envelope.kind === "dm" && c.x !== envelope.fromX) return "contact_key_mismatch";
  return null;
}

function rosterHas(roster, handle) {
  return Array.isArray(roster) && roster.some((m) => m && m.handle === handle);
}

/**
 * Decrypt a stored message row for display. Returns { direction, from, ts,
 * body, control } or a row marked error/untrusted/locked. Also imports group
 * keys delivered as 1:1 control messages, but only from a verified contact
 * who is on the roster they sent, and never silently replaces an existing key.
 *
 * @param {object} identity
 * @param {object} row
 * @param {object} ctx  { contacts: { [handle]: contactRow } }  REQUIRED for
 *                      inbound messages; without it every non-self sender is
 *                      treated as unknown.
 */
export function decryptRow(identity, row, ctx = {}) {
  let envelope;
  try {
    envelope = JSON.parse(row.envelope_json);
  } catch {
    return null;
  }
  const base = { direction: row.direction, from: envelope.from, ts: envelope.ts };

  const problem = senderProblem(identity, envelope, ctx.contacts || {});
  if (problem) {
    return { ...base, body: null, untrusted: true, reason: problem };
  }

  const self = selfForCrypto(identity);
  let plaintext;
  try {
    if (envelope.kind === "group") {
      const rec = getGroupRecord(envelope.groupId);
      if (!rec) return { ...base, body: null, locked: true };
      // Legacy records have no roster; new ones must list the sender.
      if (rec.roster && !rosterHas(rec.roster, envelope.from)) {
        return { ...base, body: null, untrusted: true, reason: "not_in_roster" };
      }
      plaintext = openGroupEnvelope(b64decode(rec.key), envelope);
    } else {
      // Both inbound messages and our own self-copies are sealed to us.
      plaintext = openDmEnvelope(self, envelope);
    }
  } catch {
    return { ...base, body: null, error: true };
  }

  if (plaintext && plaintext.type === "group-key") {
    const result = importGroupKey(identity, envelope, plaintext);
    return { ...base, control: plaintext, groupKeyImport: result };
  }
  return { ...base, body: plaintext?.body ?? null };
}

/**
 * Accept a delivered group key only if:
 *   - the sender (already verified as self or a pinned contact) is on the
 *     roster they sent, and we are on it too;
 *   - we do not already hold a DIFFERENT key for that group.
 * Returns "imported" | "unchanged" | "rejected:<reason>".
 */
function importGroupKey(identity, envelope, plaintext) {
  const { groupId, key, roster } = plaintext;
  if (typeof groupId !== "string" || typeof key !== "string") return "rejected:malformed";
  if (!rosterHas(roster, envelope.from)) return "rejected:sender_not_in_roster";
  if (!rosterHas(roster, identity.handle)) return "rejected:self_not_in_roster";
  const existing = getGroupRecord(groupId);
  if (existing) {
    if (existing.key === key) return "unchanged";
    return "rejected:conflicting_key";
  }
  saveGroupKey(groupId, key, { roster, from: envelope.from });
  return "imported";
}
