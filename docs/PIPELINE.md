# The podlink pipeline

podlink is a personal, end-to-end encrypted pipeline with two flows over the
same hub:

1. **Your devices ↔ your own Pod** — signed RPC over TLS.
2. **You ↔ a contact** — E2E-encrypted messages delivered **directly pod-to-pod**.

There is no cooperative, no aggregation operator, no shared relay, and no AI.

```mermaid
flowchart LR
  subgraph meDevices [Your devices]
    Phone[Phone / PWA]
    Laptop[Laptop / Desktop]
  end
  subgraph myHub [Your Pod hub: your Cloudflare OR home + tunnel]
    MyWorker[secure-worker]
    MyDO[PersonalPodDO + inbox/outbox + SQLite]
  end
  subgraph peerHub [A contact's Pod hub]
    PeerWorker[secure-worker]
    PeerDO[PersonalPodDO inbox]
  end
  Phone -->|"signed RPC / TLS"| MyWorker
  Laptop -->|"signed RPC / TLS"| MyWorker
  MyWorker --> MyDO
  MyDO -->|"E2E ciphertext to /api/inbox (store-and-forward)"| PeerWorker --> PeerDO
```

## Hub modes

| | Cloud | Home |
| --- | --- | --- |
| Where | Your Cloudflare account (`*.workers.dev`) | Your machine (`workerd`) |
| Reachability | Native Workers TLS, always-on | Cloudflare Tunnel, no open inbound port |
| Setup | `podlink setup --cloud` | `podlink setup --home` (or desktop Settings → Home tunnel) |
| Best for | Most people; easy store-and-forward | Maximum on-device data control |

Both modes run the **same** worker (`forum-pod-airlock`) and the **same** PWA.

## Identity (pseudonymous)

Your identity is derived deterministically from a 12-word BIP39 recovery phrase:

- **Ed25519** signing key — message signatures, session binding, and the
  pod-local **recovery key**.
- **X25519** box key — ECDH key agreement for encryption.
- **Handle** — `pk-<first 16 hex of sha256(ed25519 pubkey)>`.
- **Pod URL** — where your Pod lives.

A **contact card** = `{ handle, displayName?, podUrl, ed, x }`, shared
out-of-band as a `podlink://contact/…` invite (QR or text). No real-world PII.

## Message crypto (`forum-pod/src/messaging/crypto.js`)

- **1:1:** `X25519 static-static ECDH → HKDF-SHA256 → XChaCha20-Poly1305` AEAD.
  The sender's X25519 public key travels in the envelope so the recipient can
  derive the shared key.
- **Group:** a random 32-byte group key + XChaCha20-Poly1305; the group key is
  delivered to each member as a 1:1 message (no server-side group state).
- **Authenticity:** every envelope carries an **Ed25519 detached signature** over
  its canonical core. The recipient Pod verifies this signature on `/api/inbox`
  before storing; the recipient device verifies it again before decrypting.
- Plaintext exists only on the sender's and recipient's devices. Pods and the
  transport handle ciphertext only.

The sender keeps a **self-copy** sealed to their own key so message history is
readable across their own devices.

## Transport (`pod-do.js` + `inbox-routes.js`)

- **Device → own Pod:** `POST /api/pod` with an Ed25519-signed bundle bound to
  the device key (`sessionId = pubkey:sha256(publicKeyHex)`) and to this pod's
  origin (`aud`). The worker routes every device to one pinned Durable Object
  (`OWNER_POD_ID`). A client-supplied pod id is not a routing key.
- **Inbound mail:** public `POST /api/inbox` accepts **only** valid signed E2E
  envelopes. Direct messages are delivered only when the recipient handle is
  the pinned owner. Group mail goes to that same pinned pod. The worker records
  `handle → pod id` only after the Durable Object accepts `PROVISION`.
- **Store-and-forward:** the sender's DO holds an **outbox**; on PUT it schedules
  delivery (alarm) and retries with exponential backoff until the recipient Pod
  acks — covering briefly-offline home pods.

DO tables: `authorized_devices`, `contacts`, `groups`, `messages`, `outbox`,
`pod_meta`. The worker's D1 holds `pod_owner` (handle → pinned pod id) plus
rate-limit tables, all created at runtime.

## Multi-device & recovery

- The first device to reach a fresh Pod TOFU-enrolls as **owner**. When a
  one-time `SETUP_TOKEN` secret is set, that first enrollment must present it.
  The **recovery public key** (your identity Ed25519 key) is stored once in
  `pod_meta`. A later `PROVISION` cannot replace it unless the current recovery
  key signs the change.
- A new device re-derives your identity from the phrase, then calls
  `PUT /devices/recover`. The statement is signed by the recovery key, bound to
  this pod's origin (`aud`), and accepted once. The DO checks it against the
  enrolled `recovery_pub` and enrolls the new device.
- `PUT /devices/reset` (same recovery signature, action `reset-devices`) removes
  every device and enrolls only the caller. `DELETE /devices/:ed_pub` revokes
  one device and cannot remove the last one.
- An already-authorized device can authorize another (`PUT /devices/authorize`).
  `LIST /devices` returns the full list so the UI can warn about a new device.

## Security posture summary

- No open inbound port at home (outbound tunnel only).
- Ciphertext-only at the Pod and in transit; PII never leaves the device.
- Pseudonymous identity; user-controlled display name.
- Allowlisted, signed device access; signature-verified inbound mail.
- No third party, no aggregation, **no AI**.
