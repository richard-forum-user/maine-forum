# Moderation

Maine Forum adopts a **First Amendment–aligned** speech standard as community
policy (this is a private network — the First Amendment does not legally bind
us; we choose its protections as our ground rules):

> **If it is legal to say under U.S. law, it can be said here.**

## Who decides

**There are no human content moderators for viewpoint.** Stewards manage
membership and group structure; they do **not** sit in judgment of lawful
speech. Adjudication of whether a post/comment falls *outside* First Amendment
protection is reserved for an **AI constitutional gate** — a bounded, inspectable
policy engine whose only job is the narrow unprotected-speech categories below.

Inspiration: Audrey Tang / Caroline Green’s **Civic AI** frame
([civic.ai](https://civic.ai/) — *6-Pack of Care*): many small, **local** AI
stewards a community can own, inspect, correct, and switch off — not one opaque
cloud that governs everyone. That matches the Human-First Protocol better than
routing member text to a third-party analysis SaaS.

## Protected vs. unprotected (the only hideable classes)

Content may be **hidden** only when the constitutional gate classifies it as:

| Reason id | Category (U.S. doctrine, simplified) |
|---|---|
| `true_threat` | True threat |
| `incitement` | Incitement to imminent lawless action (*Brandenburg*) |
| `csam` | Child sexual abuse material |
| `fraud` | Fraud / criminal impersonation |
| `court_order` | Binding court order |

**Not hideable:** offense, disagreement, “misinformation,” unpopular politics,
harsh criticism of officials, satire, or anything else that remains lawful speech.

Authors may still **edit** their own posts/comments at any time.

## Protocol posture for the AI gate

- Prefer a **first-party / self-hosted** model (e.g. Workers AI or an open
  policy model with a published system prompt + audit log).
- **Do not** send member posts to an external vendor for profiling or training
  without an explicit Protocol exception.
- Every hide decision must be **logged** (reason id, model/version, timestamp,
  content id) and reviewable — alignment by **process**, not a black box.
- Tang’s Civic.AI *framework* guides how we govern that local steward; it is
  **not** itself a drop-in hosted moderator we call over the public internet.

## Status

| Piece | Status |
|---|---|
| FA policy + reason enum in API | ✅ Implemented (`MODERATION` in `instance.js`; `POST /groups/:id/hide`) |
| Author edit of posts/comments | ✅ Implemented |
| Human steward hide UI (illegal categories only) | ⚠️ Interim only — to be replaced by the AI gate |
| AI constitutional gate | 🚧 Roadmap (see `docs/ROADMAP.md`) |
| Civic.AI-shaped local steward (Kami) | 🚧 Roadmap — governance design, not third-party data export |

Config source of truth: `forum-pod/src/config/instance.js` → `MODERATION`.
