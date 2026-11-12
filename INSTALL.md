# Installing podlink

You need two things: a **Pod** (your hub) and the **app** (the family space
served by that Pod). The `podlink setup` CLI stands up the Pod. Open the Pod
URL and create a family or join with an invite.

## Prerequisites

- Node.js 20+
- For the **cloud** hub: a Cloudflare account and `wrangler`
  (`npm i -g wrangler`, then `wrangler login`).
- For the **home** hub: `cloudflared`
  (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

Check everything at once:

```bash
cd cli && node podlink.mjs doctor
```

## Option A — host on your Cloudflare account (recommended)

Always-on, easiest to reach. The CLI creates a D1 database, builds the Pod UI,
and deploys the worker to `*.workers.dev`.

```bash
cd cli
node podlink.mjs setup --cloud --name podlink-pod
# → prints your Pod URL, e.g. https://podlink-pod.<account>.workers.dev
# → writes ../podlink.config.json
```

What it does:
1. Confirms `wrangler whoami`.
2. Ensures a D1 database (`<name>-db`) and patches `forum-pod-airlock/wrangler.toml`.
3. `npm run build:pod` (builds the PWA into the worker).
4. `wrangler deploy`, then re-deploys with `PUBLIC_POD_URL` set so your invite is addressable.

The worker creates its own D1 tables on first use; no manual migrations needed.

## Option B — host at home (Cloudflare Tunnel)

Keep your data on your own machine; reach it over an outbound tunnel with no
open inbound port.

```bash
# Run the pod locally on http://127.0.0.1:8787 (the desktop app boots workerd
# automatically; otherwise run the workerd sidecar).
cd cli && node podlink.mjs setup --home
# Watch for the https://<random>.trycloudflare.com URL, then:
node podlink.mjs config --url https://<your>.trycloudflare.com
```

The desktop process can start a tunnel, but the mounted family app has no
**Settings → Home tunnel** screen. Use the CLI above. For a stable hostname,
create a named tunnel + DNS route (see `docs/PIPELINE.md`).

## Connect the app

1. Open the Pod URL in a browser (the worker serves the PWA), or run
   `cd forum-pod && npm run dev`.
2. **Create a family** (family name and your name) or open an invite link and
   **join**.
3. An admin admits joiners. Until then the app shows a waiting screen and the
   Pod does not return the feed, albums, or roster.
4. Share a new invite from the Family tab when you want another person.

## Add another device

A new device needs its own invite and a fresh admission. The mounted app has
no 12-word restore screen and no **Settings → Paired devices** page. The
messaging library can re-pair a device with a recovery phrase, but that screen
is not what the app opens.

## Tear down test deploys

```bash
cd forum-pod-airlock
npx wrangler delete --name podlink-pod-a
npx wrangler delete --name podlink-pod-b
npx wrangler d1 delete podlink-pod-a-db
npx wrangler d1 delete podlink-pod-b-db
```
