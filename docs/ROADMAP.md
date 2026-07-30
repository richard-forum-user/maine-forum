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

### 2. Pol.is opinion mapping
- **Goal:** import Pol.is-style opinion mapping / clustering into lobby
  deliberation, so groups can see areas of consensus and division before voting.
- **Approach:** prefer **self-hosting Pol.is** (open source) so member statements
  and votes stay in-house rather than flowing to a third party. Embed or
  re-implement the consensus-map view; feed results into Phase 2 governance.
- **Protocol fit:** deliberation data is member content; keep it first-party,
  aggregate views only, no per-user behavioral export.
- **Status:** design only. No dependency or endpoint added yet.

### 3. civic.ai data analysis — ⚠️ PENDING PROTOCOL REVIEW
- **Goal (as proposed):** use civic.ai for data analysis of civic sentiment.
- **Concern:** routing member data to a third-party analysis service brushes
  against multiple Protocol exclusions/commitments: data minimization, no
  third-party analytics/sharing, no behavioral/psychographic profiling, and
  "member data is never sold." The Forum's own model is aggregate-only,
  first-party analysis.
- **Required before any work:** an explicit decision on (a) what data (if any)
  leaves the instance, (b) whether analysis can be done on **aggregate,
  anonymized** data only, and (c) whether civic.ai can be self-hosted or run
  against opt-in aggregates. Until then this is **not** on the build path and no
  dependency/code will be added.
- **Status:** flagged; blocked pending human decision.

## Relationship to the pivot phases

- County boards + lobbies + public signup extend **Phase 1** (group model) and
  set up **Phase 4** (civilian lobby toolkit: district routing, positions,
  action tools).
- Governance primitives (proposals, polls, audit log) are **Phase 2**.
- verified-human sits in **Phase 3.4** (identity), promoted from this roadmap
  when ready.
- Pol.is and civic.ai are integrations layered on Phase 2/4 once their
  Protocol posture is settled.
