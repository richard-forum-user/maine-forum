# Architecture

> Phase 0.1 deliverable. Read-only map of the stack as it exists today
> (family-scoped, end-to-end-encrypted app), written to ground the civic-platform
> pivot. Line references are accurate as of this audit; treat them as pointers,
> not contracts.

## 1. Stack at a glance

| Layer | Technology | Location |
|---|---|---|
| Backend runtime | Cloudflare Workers | `forum-pod-airlock/secure-worker.js` |
| Stateful core | Durable Objects (`FamilyDO`, `PersonalPodDO`) | `forum-pod-airlock/family-do.js`, `pod-do.js` |
| Domain database | **Durable Object SQLite** (`state.storage.sql`) inside `FamilyDO` | `forum-pod-airlock/family-do.js` |
| Edge database | Cloudflare **D1** (`DB` → `podlink-db`) — infra only (rate limits, WebAuthn, inbox routing) | `wrangler.toml:19-23` |
| Media store | Cloudflare **R2** (`MEDIA` → `podlink-media`) — encrypted bytes | `wrangler.toml:33-37` |
| Client | React 19 + Vite 8 PWA, served at `/pod` | `forum-pod/src/**` |
| Native wrappers | Capacitor (Android), Tauri (desktop) | `forum-pod/android`, `desktop/` |
| Deploy tooling | `node scripts/deploy-pods.mjs <name>` | `scripts/deploy-pods.mjs` |

**Languages:** JavaScript / JSX throughout (ESM). No TypeScript.

**Important:** the family domain model lives in **Durable Object SQLite**, *not* D1.
D1 is used only for edge concerns (`rate-limit.js`, `webauthn-server.js`,
`inbox-routes.js`). Any civic-platform schema work targets the DO SQLite in
`family-do.js` (or a successor DO), not D1.

## 2. Runtime & deploy target

- **Worker entry:** `forum-pod-airlock/secure-worker.js`; exports DO classes
  `PersonalPodDO` and `FamilyDO` (`secure-worker.js:6-7`).
- **Config:** single `forum-pod-airlock/wrangler.toml`. `scripts/deploy-pods.mjs`
  patches it per instance (worker name `podlink-{name}`, D1 id, routes, WebAuthn
  origins), deploys, then restores the template. Custom-domain map lives at
  `deploy-pods.mjs:25-27` (`family` → `family.yourcommunity.forum`).
- **DO instance name is frozen** at `family-space-v2` (`secure-worker.js:135-141`).
  Bumping it orphans the whole space; schema must evolve via `createTables()` +
  `migrate()` + guarded `reconcileLegacySchema()` instead (see §6).
- **Live deployment (per HANDOFF):** `https://family.yourcommunity.forum`
  (redirects `/` → `/pod`); also reachable at the `workers.dev` URL. Identity is
  **origin-scoped** — the two URLs are different member namespaces.

## 3. HTTP surface (Worker)

| Method | Path | Handler | File |
|---|---|---|---|
| `GET` | `/` | redirect → `/pod` | `secure-worker.js:223-225` |
| `*` | `/api/webauthn/*` | `handleWebAuthnRoute` (legacy, unused for family) | `secure-worker.js:233-236` |
| `*` | `/api/inbox/*` | `handleInboxRoute` (legacy messaging) | `secure-worker.js:241-246` |
| `GET/POST` | `/api/family/media[/*]` | `handleFamilyMedia` (R2) | `secure-worker.js:160-207` |
| `POST` | `/api/family[/*]` | `forwardFamilyRpc` → `FamilyDO` | `secure-worker.js:254-283` |
| `POST` | `/api/pod[/*]` | `forwardPodRpc` → `PersonalPodDO` (legacy) | `secure-worker.js:285-334` |
| `GET` | non-API | SPA assets via `env.ASSETS` | `secure-worker.js:339-361` |

All family RPC is tunneled through `POST /api/family` with a signed JSON bundle;
the logical verb/path lives inside `payload.verb` / `payload.path` and is
dispatched by `FamilyDO.dispatch()`.

### FamilyDO logical verbs (`family-do.js`)

`GET /invite/:code` (pre-membership, `256-264`) · `PROVISION /` (found, `318-337`) ·
`GET /family` · `POST /join` · `GET /keys` · `LIST /members` ·
`LIST /requests` (admin) · `POST /admit` (admin) · `POST /deny` (admin) ·
`POST /remove` (admin) · `POST /invites` (admin) · posts (`POST/LIST/GET/DELETE`,
`+ /comments`, `/react`) · events (`POST/LIST/DELETE`, `/rsvp`) · albums
(`POST/LIST/GET`) · `POST /photos` · `POST /media/authorize`.

## 4. Auth model

Ed25519 signed-bundle RPC. There are **no passwords and no server-side accounts**;
identity is a device keypair.

1. Client signs `{ payload, sessionId, timestamp }` with a persisted Ed25519 key
   (`forum-pod/src/pod-signing.js:165-182`). `sessionId = pubkey:sha256(pub)`.
2. Worker asserts `sessionId` binds to the public key
   (`secure-worker.js:60-68, 278-281`) and forwards to the DO.
3. DO verifies the signature (`pod-signing-web.js:59-109`), enforces a 5-minute
   replay guard (`family-do.js:199-205, 249-251`), then applies the membership
   gate (`family-do.js:267-298`).
4. **`member_pub` = the device's Ed25519 public key** — the primary key of
   `members`. One device/browser-origin = one member.

Gating: founder (first `PROVISION` on an empty DO) becomes `admin`/`active`;
joiners are `pending`; writes require `status === 'active'`; admit/deny/remove/
invites require `requireAdmin()` (`family-do.js:308-310`).

## 5. End-to-end encryption (the defining constraint)

- Per-device **X25519** key for ECDH; per-epoch **FCK** (Family Content Key),
  **XChaCha20-Poly1305** for all content and photo bytes
  (`forum-pod/src/family/family-crypto.js`).
- The FCK is **wrapped** (static ECDH → HKDF `podlink-family-wrap-v1` → AEAD) to
  each member's X25519 pubkey; the server never sees it in clear.
- **Member removal rotates the epoch**: admin mints a new FCK, wraps to remaining
  members, bumps `current_epoch` (`family-client.js:192-216`,
  `family-do.js:399-425`).

### What the server can and cannot read

| Server stores in clear | Server stores as ciphertext only |
|---|---|
| Public keys (`member_pub`, `x_pub`, `author_pub`) | Post / comment / event / album bodies (`*.ct`) |
| Structural metadata (ids, timestamps, `epoch`, `r2_key`) | Member & family names (`enc_name`, `enc_family_name`, `sealed_name`) |
| Roles, membership status | Photo bytes (R2) and captions (`photos.ct`) |
| Reaction emoji, RSVP status (`yes`/`no`/`maybe`) | The FCK (only ever `family_keys.wrapped`) |
| Invite tokens (public keys + signature only) | |

This is the single most important fact for the pivot: **the server cannot read
human-readable content.** See `PROTOCOL_AUDIT.md` §"Architecture tension" for why
this collides with civic features (public pages, tallies, moderation of content).

## 6. Data model (Durable Object SQLite, `family-do.js`)

Schema lifecycle: `initSchema()` → `reconcileLegacySchema()` (guarded rebuild,
empty-family only) → `createTables()` (`CREATE TABLE IF NOT EXISTS`) → `migrate()`
(additive `ALTER TABLE ADD COLUMN`) — `family-do.js:32-169`.

| Table | Key columns | Notes |
|---|---|---|
| `family_meta` | `key`, `value` | holds `created_at`, `current_epoch`, `enc_family_name` |
| `members` | `member_pub` (PK), `x_pub`, `role`, `status`, `enc_name`, `name_epoch`, `joined_at` | role ∈ {`admin`,`member`}; status ∈ {`pending`,`active`} |
| `join_requests` | `member_pub` (PK), `x_pub`, `sealed_name`, `created_at` | name sealed to admin |
| `family_keys` | (`member_pub`,`epoch`) PK, `wrapped`, `created_at` | wrapped FCK per member per epoch |
| `posts` | `id` (PK), `author_pub`, `epoch`, `ct`, `created_at` | body encrypted |
| `comments` | `id` (PK), `post_id`, `author_pub`, `epoch`, `ct`, `created_at` | body encrypted |
| `reactions` | (`post_id`,`member_pub`,`emoji`) PK, `created_at` | emoji plaintext |
| `events` | `id` (PK), `created_by`, `epoch`, `ct`, `created_at` | body encrypted |
| `rsvps` | (`event_id`,`member_pub`) PK, `status`, `updated_at` | status plaintext |
| `albums` | `id` (PK), `epoch`, `ct`, `created_by`, `created_at` | title encrypted |
| `photos` | `id` (PK), `album_id`, `r2_key`, `epoch`, `ct`, `author_pub`, `created_at` | bytes+caption encrypted |
| `replay_guard` | `signature` (PK), `public_key`, `seen_at_ms` | anti-replay |
| `invites` | `code` (PK), `token`, `created_by`, `created_at`, `exp_ms` | token = public keys + sig |

### Group model (Phase 1 — implemented, backend)

`Family → Group` is generalized additively. The DO = one **instance** (the Maine
Forum). Groups are first-class rows; each has a `type`, `parent_group_id`,
`visibility`, `join_policy`, and an `encryption_mode`. There are three types,
arranged geographically (see `docs/ROADMAP.md`):

- **county** — the **base civic tier**: one board per Maine county, **server-readable**
  (`encryption_mode = server`), `public_read`, open-join, top-level
  (`parent_group_id = NULL`). Seeded from config, not created ad hoc.
- **issue** (civilian **lobby**) — **server-readable**, **nested under a county board**
  (`parent_group_id` → a `county`). Positions, tallies, and moderation can be
  public. Members create these.
- **community** — private + **E2E** (`encryption_mode = e2e`); server stores
  ciphertext only; cannot be `public_read` (non-members hold no key).

**Membership tiers.** `members` = instance accounts. **Public signup (pilot):**
when `family_meta.instance_join_policy = 'open'`, any device may `POST /register`
with a **pseudonymous `handle`** (no invite, no real name, no ID) and becomes an
active instance member. Instance membership is decoupled from the private E2E
**founding community group** (`groups.founding = 1`): a founding-group member
must hold a wrapped key (`family_keys` row), so public-signup accounts are *not*
auto-joined to it. The founding group still reuses the original `members` /
`family_keys` / content tables, so the existing E2E family flow and its test are
unchanged.

| Table | Key columns |
|---|---|
| `groups` | `id` (PK), `type` (`county`\|`issue`\|`community`), `parent_group_id`, `slug`, `enc_name` (e2e) / `name` (server), `visibility`, `join_policy`, `encryption_mode`, `current_epoch`, `founding`, `created_by`, `created_at` |
| `group_members` | (`group_id`,`member_pub`) PK, `role` (`member`\|`moderator`\|`steward`), `status` (`pending`\|`active`), `joined_at` — one membership/vote per group |
| `members` (+`handle`) | plaintext pseudonymous handle for the public civic layer (never `display_name` — that name triggers the legacy self-heal) |

New RPC verbs (`family-do.js`): `POST /register` (open signup),
`GET /instance` (join policy + counts), `POST /counties/seed` (steward,
idempotent, county list from config), `POST /groups` (county = steward-only;
issue = requires a valid county parent), `LIST /groups` (filter by `type` /
`parent_group_id`), `GET /groups/:id`, `POST /groups/:id/join`,
`LIST /groups/:id/members`, `LIST /groups/:id/requests`,
`POST /groups/:id/admit`, `POST /groups/:id/role`, `POST /groups/:id/remove`.
Role gates: steward manages membership/roles; moderator reviews requests; a
last-steward guard prevents orphaning a group.

Instance-level naming, branding, county list (`COUNTIES`), signup policy, and all
policy defaults live in `forum-pod/src/config/instance.js` (ground rule #5). The
DO mirrors the type/visibility/role enums locally (separate package) and points
back to that file as the source of truth.

### Server-mode content + Pol.is opinion mapping (implemented, backend)

Server-mode groups (county boards + lobbies) hold **plaintext** content in
`group_posts` / `group_comments`; E2E community groups keep using the ciphertext
`posts`/`comments`/`reactions` tables instead. **Like/dislike is the Pol.is
signal:** a `group_votes` row (`item_type`,`item_id`,`member_pub` → `vote` ∈
{`+1` like/agree, `-1` dislike/disagree}; no row = pass) is what drives the
opinion map — there is no separate "statement" concept, posts/comments *are* the
statements.

| Table | Key columns |
|---|---|
| `group_posts` | `id` (PK), `group_id`, `author_pub`, `text`, `status`, `created_at` |
| `group_comments` | `id` (PK), `post_id`, `group_id`, `author_pub`, `text`, `status`, `created_at` |
| `group_votes` | (`item_type`,`item_id`,`member_pub`) PK, `group_id`, `vote` (±1), `created_at` |

Verbs (server-mode only; E2E groups get `400`): `POST`/`LIST /groups/:id/posts`,
`POST`/`LIST /groups/:id/posts/:pid/comments`, `POST /groups/:id/vote`
(`item_type`,`item_id`,`vote`; `0` clears), and `GET /groups/:id/opinion-map`.
Viewing follows `public_read`; posting/commenting/voting requires active group
membership. `computeOpinionMap()` is a pure function: it column-centers the
member×item like/dislike matrix, projects members to 2D (PCA via power iteration
+ deflation), clusters them (k-means, k∈1..3 chosen by silhouette), and reports
**opinion groups** (size + centroid), the caller's own point/cluster, and per-item
**consensus/divisive** classification. Output is **aggregate-only** (plus the
caller's own point) — individual vote vectors are never returned (Protocol:
aggregate views, no behavioral export).

**Still open in Phase 1:** client/UI generalization (config strings, county-board
browser, create-lobby UI, public-signup screen, opinion-map visualization).
**Roadmap (not built):** zk/verified-human (ID.me/Login.gov); civic.ai (blocked
pending Protocol review). Pol.is is now **implemented first-party** (above).
**Not yet built (later phases):** Proposal, Poll, Report, Position, District
codes, transparency page.

Tests (all pass against a fresh local `wrangler dev`):
`forum-pod/scripts/polis-test.mjs` (opinion mapping via like/dislike),
`forum-pod/scripts/civic-boards-test.mjs` (county boards + public signup +
lobbies), `forum-pod/scripts/group-model-test.mjs` (Phase 1 group model), and the
unchanged `forum-pod/scripts/family-e2e-test.mjs` (E2E regression).

### Legacy / unwired (forum-stack + cooperative remnants)

`PersonalPodDO` (`pod-do.js`) with civic/journal/messaging tables, `local-data-export.js`,
`messaging/Messenger.jsx`, WebAuthn server, inbox routing. Present in the repo but
not reachable from the family UI (`app.jsx` renders `FamilyApp` only). Candidates
for either revival (some civic tables) or removal during the pivot — decide per phase.

## 7. Client (React/Vite PWA)

- Entry: `main.jsx` → `app.jsx` → `FamilyApp.jsx` (single-page, no router;
  tab state + hash-based invites `#i=CODE`).
- Screens: `Feed.jsx`, `Albums.jsx`, `Calendar.jsx`, `Members.jsx`,
  `FamilyWizard.jsx`, `EncryptedImage.jsx`, `InstallAppButton.jsx`.
- Crypto/RPC: `family-client.js` (RPC + encrypt/decrypt orchestration),
  `family-crypto.js` (primitives), `pod-signing.js` (signing).
- All user-facing strings are currently hard-coded in components — Phase 1
  requires routing them through a config file.

## 8. Dependencies & license

- **Project license: AGPL-3.0** (`LICENSE`). Note: the pivot instructions assume
  MIT compatibility in the dependency scan — this is a discrepancy to resolve
  (see `PROTOCOL_AUDIT.md` §6).
- Production deps are permissive (MIT/Apache-2.0): `@noble/*` crypto, `react`,
  `jsqr`, `qrcode`, `@simplewebauthn/server`. `@duckdb/duckdb-wasm` is a heavy
  legacy dep with no import in the family client.
- Phone-home surfaces: Google Fonts (`forum-theme.css:3`), Cloudflare Workers
  observability (10% sampling, `wrangler.toml:52-54`), `wrangler`/`gcloud` dev
  tooling. No product-analytics SDKs.

## 9. Testing & deploy

- E2E backend+crypto: `forum-pod/scripts/family-e2e-test.mjs`; short-invite smoke:
  `forum-pod/scripts/invite-code-test.mjs`; crypto self-test:
  `forum-pod/scripts/crypto-selftest.mjs`.
- Local dev is Miniflare-flaky: use a fresh `--persist-to` dir and kill stray
  `workerd` between runs (see HANDOFF §6).
- Deploy: `node scripts/deploy-pods.mjs family` (builds PWA, deploys worker,
  re-asserts custom domain).
