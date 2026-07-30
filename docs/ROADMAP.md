# Roadmap

> Living document. Captures the intended shape of the Maine Forum and the items
> deliberately deferred. "Roadmap only" items must NOT be built until promoted;
> anything touching the Human-First Protocol exclusion list requires an explicit
> human decision first (see `docs/PROTOCOL_AUDIT.md`).

## Network shape (the civic layer)

A member-owned network for Maine political discourse, organized geographically:

```
Maine Forum (instance)
├── County boards            ← base layer: one per Maine county (16)
│   ├── Lobby: <issue A>      ← civilian lobbies, created by members
│   ├── Lobby: <issue B>
│   └── ...
├── County boards ...
└── Private community groups  ← optional, end-to-end encrypted (family-style)
```

- **County boards** are the base tier: top-level, **server-readable**,
  `public_read`, open-join. This is where general county-level discussion lives.
- **Lobbies** are `issue` groups nested inside a county (`parent_group_id`).
  Members create them for specific items; they carry the Phase 4 lobby toolkit
  (deliberation → position → action → outcome).
- **Private community groups** remain **end-to-end encrypted** for private
  organizing; they are not part of the public civic layer.

### Membership & signup

- **Pilot: public signup.** Instance join policy is `open` — anyone can register
  with a **pseudonymous handle** (no real name required, no ID). This is set in
  `forum-pod/src/config/instance.js` and can be tightened later.
- One account = one membership = one vote **per group** (enforced by
  `group_members`).
- A registered member can browse/join county boards (open) and create or join
  lobbies within a county.

## Roadmap — deferred, do not build until promoted

### 1. zk / verified-human authentication (e.g. ID.me, Login.gov)
- **Goal:** an optional `verified_human` attestation to raise trust for votes and
  official actions, without collecting identity documents.
- **Approach:** delegate verification to an external identity provider
  (ID.me / Login.gov style). We receive only a **proof/attestation** (and ideally
  a zero-knowledge proof of eligibility), never ID documents.
- **Protocol fit:** consistent with the exclusion list — this is NOT the
  "ID-document upload" feature that Phase 3.4 puts out of scope, because no
  documents are uploaded to or stored by us. Store only a boolean/attestation on
  the membership; never the underlying identity.
- **Status:** design only. Current auth is device Ed25519 keys + (optional)
  WebAuthn passkeys.

### 2. Pol.is opinion mapping — ✅ IMPLEMENTED (first-party)
- **What shipped:** a Pol.is-style opinion map built into server-mode groups
  (county boards + lobbies). A lobby's **posts and comments are the statements**;
  **like/dislike is the agree/disagree signal**. The server clusters members from
  their like/dislike matrix (PCA → k-means, 1–3 opinion groups chosen by
  silhouette) and surfaces **consensus** (cross-cluster agreement) and
  **divisive** items. Endpoint: `GET /groups/:id/opinion-map`.
- **Protocol fit:** fully first-party — no external Pol.is service, no data
  leaves the instance. The map returns **aggregates only** (opinion-group sizes,
  centroids, per-item consensus) plus the caller's own point; individual vote
  vectors are never exported.
- **Next:** client visualization (scatter of opinion groups + consensus list);
  feed consensus into Phase 2 governance (proposals/polls).

### 3. AI constitutional gate + Civic AI stewardship — ROADMAP
- **Goal:** automate the only content decisions we allow — whether a
  post/comment is **outside** First Amendment protection — with **no human
  viewpoint moderators**. Stewards manage groups; speech adjudication is AI.
- **Standard:** same narrow categories as `docs/MODERATION.md` (true threat,
  incitement, CSAM, fraud, court order). Lawful speech stays up.
- **Civic.AI (Audrey Tang):** use as the **governance frame** for a bounded
  local steward (inspectable, correctable, switchable) — *not* as a third-party
  SaaS that receives member corpora for “data analysis.” See
  [civic.ai](https://civic.ai/) / 6-Pack of Care (speech vs. amplification,
  alignment by process).
- **Implementation bias (Protocol-clean):**
  1. First-party classifier on post/comment create (and edit), with published
     policy prompt + model id/version.
  2. Append-only **moderation audit log** (reason, model, content id, time).
  3. Optional member appeal that re-runs the gate or queues a *process*
     review — not open-ended human censorship.
- **Explicitly out of scope:** sentiment profiling, psychographics, selling or
  exporting feeds to an external “civic analysis” cloud.
- **Status:** design promoted from earlier “blocked civic.ai data analysis”
  note; build path is **local constitutional gate first**, Civic AI governance
  patterns layered on.

## Relationship to the pivot phases

- County boards + lobbies + public signup extend **Phase 1** (group model) and
  set up **Phase 4** (civilian lobby toolkit: district routing, positions,
  action tools).
- Governance primitives (proposals, polls, audit log) are **Phase 2**.
- verified-human sits in **Phase 3.4** (identity), promoted from this roadmap
  when ready.
- Pol.is opinion mapping is **implemented first-party** on server-mode groups;
  its consensus output feeds Phase 2 governance. Moderation adjudication is an
  **AI constitutional gate** (Civic AI–shaped local steward); not third-party
  sentiment export.
