# Installing podlink

You need two things: a **Pod** (your hub) and the **app** (where you read and
write messages). The `podlink setup` CLI stands up the Pod; the app's first-run
wizard connects you to it.

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

On the **desktop app** you don't need a terminal: open **Settings → Home tunnel**,
press **Start tunnel**, then **Use as my Pod URL**. For a stable hostname, create
a named tunnel + DNS route (see `docs/PIPELINE.md`).

## Connect the app

1. Start the app (or open your Pod URL in a browser; the PWA is served by the Pod).
   - Dev: `cd forum-pod && npm run dev`
2. **Create your identity** — save the 12-word recovery phrase.
3. **Connect your Pod** — paste the URL the CLI printed (auto-detected on desktop),
   then *Connect & provision*.
4. **Share your invite** (QR or code). Add a contact's invite under **Contacts**;
   both sides must add each other.
5. Start messaging. Create **group channels** from Contacts.

## Add another device / restore after loss

On the new device choose **"Restoring on a new device? Enter your recovery
phrase"** in the wizard. podlink re-derives your identity and, when you connect
your Pod, proves your recovery key to re-pair this device automatically. You can
also authorize a device's signing key directly under **Settings → Paired devices**.

## Tear down test deploys

```bash
cd forum-pod-airlock
npx wrangler delete --name podlink-pod-a
npx wrangler delete --name podlink-pod-b
npx wrangler d1 delete podlink-pod-a-db
npx wrangler d1 delete podlink-pod-b-db
```
