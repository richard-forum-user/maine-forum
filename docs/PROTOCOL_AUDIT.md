# Protocol Audit

> Phase 0.2 + 0.3 deliverable. Evaluates the current codebase against the
> Human-First Protocol requirements that back the pivot's exclusion list.
> Verdicts: **pass** / **partial** / **fail** / **absent**. Zero code was
> changed to produce this. Line references are pointers as of the audit date.

## Summary scorecard

| # | Requirement | Verdict |
|---|---|---|
| 1 | Full self-serve account/data export | **absent** |
| 2 | Hard account deletion with cascade | **fail** (remove = access revocation; orphans remain) |
| 3 | Analytics minimization / inventory | **partial** (no product analytics; 3 minor telemetry surfaces) |
| 4 | PII inventory & retention | **partial** (E2E for content; plaintext metadata + local keys; retention undocumented) |
| 5 | Access control across group boundaries | **partial** (strong for non-members; two gaps) |
| 6 | Dependency & license scan | **pass** (permissive deps) with **one flag**: project is AGPL-3.0, not MIT |

---

## Architecture tension (read this first)

The current app is **end-to-end encrypted**: the server stores only ciphertext and
public keys and **cannot read any human-readable content** (`family-do.js:1-7`;
see `ARCHITECTURE.md` §5). Several civic-platform requirements assume
server-readable or publicly-readable content and therefore **conflict directly**
with the existing design:

| Pivot requirement | Conflict with E2E today |
|---|---|
| `public_read` group visibility (Phase 1.2) | Non-members hold no FCK → cannot decrypt anything |
| Public transparency / position pages (2.4, 4.2) | Server has only ciphertext; nothing to render publicly |
| Poll tallies public, ballots hidden (2.5) | Tally requires the server (or someone) to count plaintext votes |
| Moderation queue: review reported content (3.2) | Moderator would need to decrypt content authored by others |
| Rationale posts with structured public fields (3.5) | Structured server-side fields imply server-readable content |
| District routing on membership (4.3) | Feasible; district codes are non-sensitive derived metadata |

**This is a Phase 0 → Phase 1 decision that needs a human.** Broad options:

- **A. Drop E2E for `public`/`issue` groups**; keep E2E as an opt-in mode for
  private `community` groups. Civic features live in server-readable groups.
- **B. Per-group encryption policy**: `community` groups stay E2E; `issue`
  (lobby) groups are plaintext-on-server by design. Config-driven.
- **C. Keep strict E2E everywhere** and re-scope the civic features to what E2E
  can support (e.g. member-only tallies, no public pages). Likely guts the
  data-cooperative/lobby value proposition.

Recommendation to discuss: **Option B** aligns best with the exclusion list
(data minimization, no tracking) while making the lobby features buildable.
No code should be written for Phase 1 until this is chosen.

---

## 1. Full self-serve export — ABSENT

- No export UI, no server `/export` verb, no archive/zip generation in the family
  path. App entry is family-only (`forum-pod/src/app.jsx:1-6`).
- Legacy `forum-pod/src/local-data-export.js:25-60` exports **cooperative-era
  Personal Pod** data (civic/journal), not family feed/albums/events, and is not
  imported anywhere.
- Device-key export is explicitly disabled (`member-store.js:98-106`).
- Partial: individual encrypted media can be fetched by `r2_key`
  (`secure-worker.js:164-171`); client holds decrypt keys in `localStorage`
  (`family-crypto.js:28-29`) but nothing bundles them.

**Gap for Phase 2.1:** need a schema-versioned JSON + media export covering every
user-owned table. Under E2E, the export must be assembled **client-side** (only
the client can decrypt) unless the encryption decision above changes.

## 2. Hard account deletion with cascade — FAIL

- Member `remove` is **access revocation, not deletion**: it deletes the
  `members` row + that member's `family_keys` + pending `join_requests`, then
  rotates the epoch (`family-do.js:399-425`). UI copy confirms intent
  (`Members.jsx:72-73`). E2E test asserts lock-out, not erasure
  (`family-e2e-test.mjs:159-173`).
- **Orphans remain**: the removed member's posts, comments, reactions, RSVPs,
  albums, photo rows, and **R2 photo bytes** are never deleted (no DELETE path in
  `/remove`; no photo-delete route in `dispatch()`). A removed member may also
  retain an old-epoch FCK locally and decrypt historical content offline.
- No account/family wipe route exists; no tombstone pattern in family code.
- Item deletes that do exist: `deletePost` / `deleteEvent` (author or admin,
  `family-do.js:500-546`), `deny` pending joiner (`392-397`).

**Gap for Phase 2.2:** need cascade delete + tombstoning (author → "deleted
member", body removed or retained-redacted per group policy), including R2 object
deletion.

## 3. Analytics inventory — PARTIAL

No product-analytics SDKs found (no GA/gtag, Segment, Mixpanel, Posthog, Sentry,
fbq, Plausible in application source). Telemetry surfaces that DO exist:

| Surface | Location | Nature |
|---|---|---|
| Google Fonts CSS | `forum-pod/src/forum-theme.css:3` | external request to `fonts.googleapis.com` on load |
| Cloudflare Workers observability | `wrangler.toml:52-54` | 10% head-sampled request traces (platform) |
| Client IP in rate-limit bucket key | `rate-limit.js:53-58`, `secure-worker.js:103-106` | IP stored in D1 `edge_rate_limits.bucket`, pruned after ~4 windows |
| CSP allows jsDelivr | `secure-worker.js:34` | policy only; no active import |

No worker/DO `console.log` of user data. Client logging is limited to a
service-worker registration warning (`main.jsx:16`).

**Gap for Phase 2.3:** self-host fonts (remove the Google Fonts request);
decide/​document the observability sampling and IP-in-rate-limit retention as
first-party aggregate only; write retention windows into `DATA_POLICY.md`.

## 4. PII inventory & retention — PARTIAL

### Server (FamilyDO) — human-readable fields are ciphertext

Post/comment/event/album bodies (`*.ct`), member & family names (`enc_name`,
`enc_family_name`, `sealed_name`), photo bytes (R2) + captions — **all encrypted
client-side**. Plaintext on server: public keys, structural metadata, reaction
emoji, RSVP status, invite tokens (public keys + signature only).

### Edge (D1)

Client IP embedded in `edge_rate_limits.bucket` (`rate-limit.js`), pruned after a
few windows. `pod_owner` handle→pod routing (`inbox-routes.js:62-78`) — legacy
messaging, likely inert in family-only deploys.

### Client device (`localStorage`, plaintext)

X25519 private key (`podlink.family.xkey`), per-epoch FCK (`podlink.family.fck`),
Ed25519 signing key, and a plaintext profile cache (`podlink.family.profile`) —
`family-crypto.js:28-29,58-66`, `member-store.js:4-11`, `family-store.js:5-6`.

### Legacy PersonalPodDO (not in family UI)

`email_hash`/`claimed_email` (`email_proof`), `zip_code`/`comment`
(`civic_submissions`), plaintext `journal_entries.raw_text` — `pod-do.js`. These
are out of the family scope and should be marked out-of-scope or removed.

**Gaps:** retention is documented only in stale cooperative-era docs
(`docs/DPIA.md`, `docs/PRIVACY-POLICY.md`). Phase 2/4 must: (a) document retention
per field in `DATA_POLICY.md`; (b) for district routing (4.3), store **only
district codes** on membership and never persist street addresses.

## 5. Access control — PARTIAL

Pipeline: `signBundle` → worker `assertSessionBinding` → DO `verifySignedBundle` →
replay guard → membership gate → dispatch (`ARCHITECTURE.md` §4).

Strong points: non-members get 403 `not_a_member` (`family-do.js:281-282`);
removed members are locked out (test `family-e2e-test.mjs:171-172`); writes require
`active` status; admin verbs gated by `requireAdmin()`.

**Two gaps:**

1. **Pending members can `LIST`/`GET` ciphertext via the API.** The write gate
   covers only POST/PUT/DELETE (`family-do.js:294`); read verbs like `LIST /posts`
   (`463-466`) have no `status` check. The UI hides this (`FamilyApp.jsx:100-101`),
   but a direct API caller in `pending` state can pull ciphertext blobs (they
   still lack the FCK to decrypt).
2. **Media `GET` is unauthenticated** (`secure-worker.js:164-171`): security rests
   entirely on an unguessable `r2_key` + client-side encryption. Uploads are gated;
   downloads are not.

Tenancy: one family per worker deployment (fixed DO name `family-space-v2`), so
there is no in-deployment cross-family leakage — but also **no multi-group model
yet**, which Phase 1 must introduce (and which reopens cross-group access-control
questions).

## 6. Dependency & license scan — PASS (with one flag)

- **Project license is AGPL-3.0** (`LICENSE`), **not MIT**. The pivot instructions'
  Phase 0.3 assumes MIT and asks to flag MIT-incompatibilities — but the project
  itself is copyleft. **This needs a human decision** on the intended license
  before Phase 5 README/relicensing work.
- All production dependencies are permissively licensed (MIT / Apache-2.0):
  `@noble/ciphers|curves|hashes`, `@scure/bip39`, `react`, `react-dom`, `jsqr`,
  `qrcode`, `@simplewebauthn/server`, `@capacitor-community/sqlite`.
- No dependency-level product telemetry. Phone-home surfaces are the three in §3
  plus dev/deploy CLIs (`wrangler`).
- `@duckdb/duckdb-wasm` (`forum-pod/package.json`) is a large legacy dep with no
  import in the family client — candidate for removal.

---

## Recommended order of remediation (feeds later phases)

1. **Resolve the encryption-vs-civic decision** (top of this doc) — blocks Phase 1.
2. **Resolve the license question** (AGPL vs MIT) — blocks Phase 5, informs
   contribution terms now.
3. Phase 2.1 export (client-assembled under E2E), Phase 2.2 cascade delete +
   tombstones + R2 cleanup, Phase 2.3 self-host fonts + document retention.
4. Close the two access-control gaps (§5) — gate read verbs by status; decide
   whether media GET needs membership auth.
5. Mark or remove legacy cooperative/messaging code so audits stop tripping on it.
