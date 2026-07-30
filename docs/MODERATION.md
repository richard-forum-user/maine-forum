# Moderation

Maine Forum adopts a **First Amendment–aligned** speech standard as community
policy (this is a private network — the First Amendment does not legally bind
us; we choose its protections as our ground rules):

> **If it is legal to say under U.S. law, it can be said here.**

## What that means

- Authors may **edit** their own discussion posts and comments at any time.
- Stewards and moderators **do not** remove or rewrite lawful speech for
  viewpoint, offense, disagreement, or contested claims of “misinformation.”
- Content may be **hidden** only under narrow illegal categories:
  - true threat
  - incitement to imminent lawless action
  - child sexual abuse material
  - fraud / criminal impersonation
  - a binding court order

Config source of truth: `forum-pod/src/config/instance.js` → `MODERATION`.
Hide API: `POST /groups/:id/hide` with `{ item_type, item_id, reason }` where
`reason` must be one of the categories above.
