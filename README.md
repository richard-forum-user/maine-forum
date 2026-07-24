# podlink

**A personal, device-to-device encrypted pipeline.** podlink sets up your own
Pod (a tiny server you control) and an end-to-end encrypted messaging layer so
you can talk to people you trust — with no company in the middle, no
aggregation, and no AI.

- **Your own hub.** Host your Pod on your Cloudflare account or on your home
  machine reached over a Cloudflare Tunnel (no open ports).
- **End-to-end encrypted.** Messages are sealed on your device (X25519 +
  XChaCha20-Poly1305, signed with Ed25519). Your Pod and the network only ever
  see ciphertext.
- **Pseudonymous by design.** Your identity is a random handle plus keys and a
  Pod URL — no name, email, or phone required. PII never leaves your device.
- **Direct, pod-to-pod.** Messages go straight from your Pod to your contact's
  Pod, with sender-side store-and-forward retry for pods that are briefly
  offline. 1:1 and group channels.
- **Yours to recover.** A 12-word recovery phrase deterministically re-derives
  your identity and re-pairs new devices against your own Pod.

This project is a clean fork of the Forum Stack Pod core with the data
cooperative removed, **all AI removed**, a friendly setup wizard added, and the
new messaging layer. See `.cursor/rules/00-sovereignty-boundary.mdc` for the
non-negotiable invariants.

## Repository layout

| Path | What it is |
| --- | --- |
| `forum-pod/` | The PWA (React) — first-run wizard + messenger. Entry: `src/app.jsx`. |
| `forum-pod/src/messaging/` | E2E crypto (`crypto.js`), identity (`identity.js`), client (`client.js`), UI (`Messenger.jsx`). |
| `forum-pod-airlock/` | The Pod worker: `secure-worker.js` + `PersonalPodDO` (`pod-do.js`) + public `inbox-routes.js`. |
| `cli/` | `podlink setup` — the guided installer (cloud or home hub). |
| `desktop/` | Tauri desktop app (boots `workerd` locally, controls the home tunnel). |
| `scripts/` | Deploy + live end-to-end test helpers. |
| `docs/PIPELINE.md` | How the pipeline, the two hub modes, and the crypto fit together. |

## Quick start

```bash
# 1. Stand up your Pod (interactive: choose cloud or home)
cd cli && node podlink.mjs setup

# 2. Open the app, create your identity, point it at your Pod URL,
#    share your invite, and start messaging.
```

See [`INSTALL.md`](INSTALL.md) for full setup and [`docs/PIPELINE.md`](docs/PIPELINE.md)
for the architecture and security model.

## Development

```bash
# Client (PWA)
cd forum-pod && npm install && npm run dev      # vite dev server
cd forum-pod && npm run build                   # production build

# Crypto self-test (no network)
cd forum-pod && node scripts/crypto-selftest.mjs

# Live end-to-end test against two CF-hosted pods
node scripts/deploy-test-pods.mjs               # deploys podlink-pod-a / -b
cd forum-pod && node scripts/cf-e2e-test.mjs    # provision → message → recover
```

## What podlink is NOT

No cooperative, no membership, no shared relay, no aggregation, **no AI**. If a
change would add any of those, it is out of scope by design.
