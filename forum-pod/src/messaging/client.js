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

function saveGroupKey(groupId, rawKeyB64) {
  const all = loadGroupKeys();
  all[groupId] = rawKeyB64;
  localStorage.setItem(GROUP_KEYS_STORE, JSON.stringify(all));
}

export function getGroupRawKey(groupId) {
  const b64 = loadGroupKeys()[groupId];
  return b64 ? b64decode(b64) : null;
}

/** Create a group, store its key locally + sealed-to-self in the pod, and
 * distribute the key to each member via a 1:1 control message. */
export async function createGroup(title, members, opts = {}) {
  const identity = opts.identity || loadIdentity();
  const self = selfForCrypto(identity);
  const groupId = "g-" + bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
  const rawKey = randomGroupKey();
  const rawKeyB64 = b64encode(rawKey);
  saveGroupKey(groupId, rawKeyB64);

  const roster = [
    { handle: identity.handle, x: identity.xPublicKeyHex, podUrl: identity.podUrl },
    ...members.map((m) => ({ handle: m.handle, x: m.x, podUrl: m.podUrl || m.pod_url })),
  ];

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
 * Decrypt a stored message row for display. Returns { direction, from, ts,
 * body, control } or null if it can't be decrypted. Also auto-imports group
 * keys delivered as 1:1 control messages.
 */
export function decryptRow(identity, row) {
  let envelope;
  try {
    envelope = JSON.parse(row.envelope_json);
  } catch {
    return null;
  }
  const self = selfForCrypto(identity);
  let plaintext;
  try {
    if (envelope.kind === "group") {
      const rawKey = getGroupRawKey(envelope.groupId);
      if (!rawKey) return { direction: row.direction, from: envelope.from, ts: envelope.ts, body: null, locked: true };
      plaintext = openGroupEnvelope(rawKey, envelope);
    } else {
      // Both inbound messages and our own self-copies are sealed to us.
      plaintext = openDmEnvelope(self, envelope);
    }
  } catch {
    return { direction: row.direction, from: envelope.from, ts: envelope.ts, body: null, error: true };
  }
  if (plaintext && plaintext.type === "group-key") {
    saveGroupKey(plaintext.groupId, plaintext.key);
    return { direction: row.direction, from: envelope.from, ts: envelope.ts, control: plaintext };
  }
  return {
    direction: row.direction,
    from: envelope.from,
    ts: envelope.ts,
    body: plaintext?.body ?? null,
  };
}
