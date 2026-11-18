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

import { audienceFromPodUrl, signBundle, ensurePodSigningKey } from "../pod-signing.js";
import { enrichSignedEnvelope } from "../signing-envelope.js";
import { httpProviderUrl } from "../pod-adapter-http.js";
import { loadSigningMeta } from "../member-store.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { loadIdentity, selfForCrypto } from "./identity.js";
import {
  sealEnvelope,
  openDmEnvelope,
  previewUnverifiedDm,
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
  const root = podRoot(identity, opts.base);
  const signed = enrichSignedEnvelope(
    await signBundle({ verb, path, data }, null, audienceFromPodUrl(root))
  );
  if (opts.setupToken) signed.setupToken = opts.setupToken;
  const url = `${root}/api/pod${path === "/" ? "" : path}`;
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
      // The phrase-derived identity key doubles as the pod-local recovery key.
      // The pod id is the deployment pin; the client does not choose a route.
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
  const aud = audienceFromPodUrl(podRoot(identity, opts.base));
  const message = canonical({ action: "recover-device", ed_pub: devicePub, ts, aud });
  const recovery_sig = bytesToHex(ed25519.sign(new TextEncoder().encode(message), identity.edPrivateKey));
  return rpc("PUT", "/devices/recover", { ed_pub: devicePub, ts, recovery_sig }, opts);
}

/** Drop every authorized device except this one. Requires the recovery key. */
export async function resetDevices(opts = {}) {
  const identity = opts.identity || loadIdentity();
  await ensurePodSigningKey();
  const devicePub = loadSigningMeta()?.publicKeyHex;
  if (!devicePub) throw new Error("no device signing key");
  const ts = new Date().toISOString();
  const aud = audienceFromPodUrl(podRoot(identity, opts.base));
  const message = canonical({ action: "reset-devices", ed_pub: devicePub, ts, aud });
  const recovery_sig = bytesToHex(ed25519.sign(new TextEncoder().encode(message), identity.edPrivateKey));
  return rpc("PUT", "/devices/reset", { ed_pub: devicePub, ts, recovery_sig }, opts);
}

export async function revokeDevice(edPubHex, opts = {}) {
  const ed = String(edPubHex || "").toLowerCase();
  return rpc("DELETE", `/devices/${encodeURIComponent(ed)}`, null, opts);
}

export async function listDevices(opts = {}) {
  return (await rpc("LIST", "/devices", null, opts)).rows || [];
}

// ---- contacts -------------------------------------------------------------

export function contactKeysChanged(existing, card) {
  if (!existing || !card) return false;
  return existing.ed !== card.ed || existing.x !== card.x;
}

export async function addContact(card, opts = {}) {
  if (!opts.confirmKeyChange) {
    const existing = (await listContacts(opts)).find((r) => r.handle === card.handle);
    if (contactKeysChanged(existing, card)) {
      const err = new Error("Safety number changed. Confirm before accepting this contact's new keys.");
      err.code = "safety_number_changed";
      throw err;
    }
  }
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

function loadGroupRecords() {
  let all;
  try {
    all = JSON.parse(localStorage.getItem(GROUP_KEYS_STORE) || "{}");
  } catch {
    all = {};
  }
  const out = {};
  for (const [id, value] of Object.entries(all || {})) {
    if (typeof value === "string") {
      out[id] = { key: value, epoch: 1, roster: [], creator: null };
    } else if (value && typeof value === "object" && value.key) {
      out[id] = {
        key: value.key,
        epoch: Number(value.epoch || 1),
        roster: Array.isArray(value.roster) ? value.roster : [],
        creator: value.creator || null,
      };
    }
  }
  return out;
}

function writeGroupRecord(groupId, record) {
  const all = JSON.parse(localStorage.getItem(GROUP_KEYS_STORE) || "{}");
  all[groupId] = record;
  localStorage.setItem(GROUP_KEYS_STORE, JSON.stringify(all));
}

export function getGroupRecord(groupId) {
  return loadGroupRecords()[groupId] || null;
}

export function getGroupRawKey(groupId) {
  const rec = getGroupRecord(groupId);
  return rec?.key ? b64decode(rec.key) : null;
}

function rosterHandles(roster) {
  return rosterMembers(roster).map((member) => member.handle);
}

/** Roster entries keep a handle and, when known, that member's Ed25519 key. */
function rosterMembers(roster) {
  if (!Array.isArray(roster)) return [];
  const members = [];
  for (const entry of roster) {
    if (typeof entry === "string" && entry) members.push({ handle: entry, ed: null });
    else if (entry && typeof entry.handle === "string" && entry.handle) {
      members.push({ handle: entry.handle, ed: entry.ed || null });
    }
  }
  return members;
}

function rosterForStorage(roster) {
  return rosterMembers(roster).map((member) =>
    member.ed ? { handle: member.handle, ed: member.ed } : member.handle
  );
}

/**
 * A group message is shown as that member's only when `fromEd` is the Ed25519
 * key stored for that handle. A group key alone is not permission to speak
 * as someone else.
 */
export function groupSenderDecision(record, envelope, { self, contactsByHandle } = {}) {
  if (!envelope?.from || !envelope?.fromEd) return { ok: false, reason: "not_on_roster" };
  const members = rosterMembers(record?.roster);
  const member = members.find((item) => item.handle === envelope.from);
  const selfMatch =
    !!self?.handle &&
    !!self?.edPublicKeyHex &&
    envelope.from === self.handle &&
    envelope.fromEd === self.edPublicKeyHex;
  if (!member && !selfMatch) return { ok: false, reason: "not_on_roster" };
  if (selfMatch) return { ok: true, self: true };
  const expectedEd = member.ed || contactsByHandle?.[envelope.from]?.ed || null;
  if (!expectedEd) return { ok: false, reason: "sender_key_unknown" };
  if (expectedEd !== envelope.fromEd) return { ok: false, reason: "sender_key_mismatch" };
  return { ok: true };
}

/**
 * Decide whether a group-key control message may change the stored key.
 * A non-roster sender never changes it. A real rotation sets `prompt` and
 * leaves the stored key in place until the user accepts.
 */
export function groupKeyDecision(stored, incoming) {
  const epoch = Number.isFinite(Number(incoming.epoch)) ? Number(incoming.epoch) : 1;
  if (!incoming.senderVerified) {
    return { accept: false, prompt: false, reason: "unverified_sender", next: null };
  }
  if (stored && rosterHandles(stored.roster).length > 0) {
    const allowed = new Set(rosterHandles(stored.roster));
    if (stored.creator) allowed.add(stored.creator);
    if (!allowed.has(incoming.senderHandle)) {
      return { accept: false, prompt: false, reason: "not_on_roster", next: null };
    }
  } else if (stored?.creator && stored.creator !== incoming.senderHandle) {
    return { accept: false, prompt: false, reason: "not_on_roster", next: null };
  }
  if (stored && stored.epoch != null && epoch < Number(stored.epoch)) {
    return { accept: false, prompt: false, reason: "epoch_downgrade", next: null };
  }
  if (stored?.key && incoming.key && stored.key !== incoming.key) {
    return {
      accept: false,
      prompt: true,
      reason: "key_change",
      next: null,
      pending: {
        key: incoming.key,
        epoch,
        roster: rosterForStorage(incoming.roster).length
          ? rosterForStorage(incoming.roster)
          : rosterForStorage(stored?.roster),
        creator: stored.creator || incoming.senderHandle,
      },
    };
  }
  if (!stored) {
    return {
      accept: true,
      prompt: false,
      reason: "new",
      next: {
        key: incoming.key,
        epoch,
        roster: rosterForStorage(incoming.roster).length
          ? rosterForStorage(incoming.roster)
          : [incoming.senderHandle],
        creator: incoming.senderHandle,
      },
    };
  }
  return {
    accept: true,
    prompt: false,
    reason: "unchanged",
    next: { ...stored, epoch: Math.max(Number(stored.epoch || 1), epoch) },
  };
}

/** Write a group key the user explicitly accepted. */
export function acceptGroupKeyChange(groupId, pending) {
  if (!groupId || !pending?.key) throw new Error("missing_group_key");
  writeGroupRecord(groupId, {
    key: pending.key,
    epoch: Number(pending.epoch || 1),
    roster: rosterForStorage(pending.roster),
    creator: pending.creator || null,
  });
}

/** Must match `requestThreadId` in forum-pod-airlock/pod-do.js. */
export function requestThreadId(from, fromEd) {
  return `req:${from || "unknown"}:${fromEd || "unknown"}`;
}

/**
 * A DM is verified only when `from` is us, or a stored contact whose ed and x
 * match the envelope. Anything else is an unverified request.
 */
export function classifyDmSender(identity, envelope, contactsByHandle) {
  if (
    envelope.from === identity.handle &&
    envelope.fromEd === identity.edPublicKeyHex &&
    (!envelope.fromX || envelope.fromX === identity.xPublicKeyHex)
  ) {
    return { ok: true, self: true, peer: null };
  }
  const contact = contactsByHandle?.[envelope.from];
  if (!contact || contact.ed !== envelope.fromEd || (envelope.fromX && contact.x !== envelope.fromX)) {
    return { ok: false, reason: contact ? "sender_key_mismatch" : "unknown_sender" };
  }
  return {
    ok: true,
    self: false,
    peer: { handle: contact.handle, ed: contact.ed, x: contact.x },
  };
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
    { handle: identity.handle, ed: identity.edPublicKeyHex, x: identity.xPublicKeyHex, podUrl: identity.podUrl },
    ...members.map((m) => ({
      handle: m.handle,
      ed: m.ed,
      x: m.x,
      podUrl: m.podUrl || m.pod_url,
    })),
  ];
  writeGroupRecord(groupId, {
    key: rawKeyB64,
    epoch: 1,
    roster: rosterForStorage(roster),
    creator: identity.handle,
  });

  // Sealed-to-self copy of the key for our other devices.
  const sealedKey = sealEnvelope(
    self,
    { kind: "dm", toHandle: identity.handle, xPublicKeyHex: identity.xPublicKeyHex, threadId: `g:${groupId}` },
    { type: "group-key", groupId, title, key: rawKeyB64, epoch: 1, roster }
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
      { type: "group-key", groupId, title, key: rawKeyB64, epoch: 1, roster },
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
 * body, control } or null if it can't be decrypted.
 *
 * A sender whose handle matches a contact but whose keys do not is returned
 * with `unverified` and a request thread id. It is never a message in that
 * contact's thread. Group-key control messages update the stored key only
 * when `groupKeyDecision` accepts them.
 */
export function decryptRow(identity, row, contactsByHandle = {}) {
  let envelope;
  try {
    envelope = JSON.parse(row.envelope_json);
  } catch {
    return null;
  }
  const self = selfForCrypto(identity);
  let plaintext;
  let classified = null;
  try {
    if (envelope.kind === "group") {
      const rawKey = getGroupRawKey(envelope.groupId);
      if (!rawKey) return { direction: row.direction, from: envelope.from, ts: envelope.ts, body: null, locked: true };
      const sender = groupSenderDecision(getGroupRecord(envelope.groupId), envelope, {
        self: identity,
        contactsByHandle,
      });
      if (!sender.ok) {
        return {
          direction: row.direction,
          from: envelope.from,
          ts: envelope.ts,
          body: null,
          unverified: true,
          reason: sender.reason,
          threadId: `g:${envelope.groupId}`,
        };
      }
      plaintext = openGroupEnvelope(rawKey, envelope);
    } else {
      classified = classifyDmSender(identity, envelope, contactsByHandle);
      if (!classified.ok) {
        let body = null;
        try {
          body = previewUnverifiedDm(self, envelope)?.body ?? null;
        } catch {
          body = null;
        }
        return {
          direction: row.direction,
          from: envelope.from,
          ts: envelope.ts,
          body,
          unverified: true,
          bucket: "requests",
          reason: classified.reason,
          threadId: requestThreadId(envelope.from, envelope.fromEd),
        };
      }
      plaintext = openDmEnvelope(self, envelope, classified.peer);
    }
  } catch {
    return { direction: row.direction, from: envelope.from, ts: envelope.ts, body: null, error: true };
  }
  if (plaintext && plaintext.type === "group-key") {
    const stored = getGroupRecord(plaintext.groupId);
    const decision = groupKeyDecision(stored, {
      senderHandle: envelope.from,
      senderVerified: !!classified?.ok,
      key: plaintext.key,
      epoch: plaintext.epoch,
      roster: plaintext.roster,
    });
    if (decision.accept && decision.next) {
      writeGroupRecord(plaintext.groupId, decision.next);
    }
    return {
      direction: row.direction,
      from: envelope.from,
      ts: envelope.ts,
      control: plaintext,
      groupKeyAccepted: decision.accept,
      groupKeyIgnored: !decision.accept && !decision.prompt,
      groupKeyPrompt: decision.prompt
        ? { groupId: plaintext.groupId, title: plaintext.title || "", from: envelope.from, ...decision.pending }
        : null,
      reason: decision.reason,
      threadId: `dm:${envelope.from}`,
    };
  }
  return {
    direction: row.direction,
    from: envelope.from,
    ts: envelope.ts,
    body: plaintext?.body ?? null,
    threadId: envelope.kind === "group" ? `g:${envelope.groupId}` : `dm:${envelope.from}`,
  };
}
