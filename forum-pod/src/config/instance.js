/**
 * INSTANCE CONFIG — single source of truth for instance-specific naming,
 * branding, and policy defaults (ground rule #5: "config over fork").
 *
 * This is the ONE file to edit when standing up a new instance. Nothing in the
 * app should hard-code the instance name, region, group labels, or policy
 * defaults — import from here instead. The single-instance vs. deployable-
 * template decision is deferred; keeping everything here keeps both open.
 *
 * Values may be overridden at build time via Vite env vars (VITE_INSTANCE_*)
 * so the same code can serve multiple instances without editing this file.
 *
 * NOTE ON EXCLUSIONS: there are deliberately NO monetization, payment, ad, or
 * third-party-analytics settings in this file. Those capabilities are excluded
 * by the Human-First Protocol (see docs/PROTOCOL.md) and must not be added.
 */

const env = (typeof import.meta !== "undefined" && import.meta.env) || {};
const pick = (key, fallback) => {
  const v = env[key];
  return v === undefined || v === "" ? fallback : v;
};

export const instance = {
  // ---- identity / branding ------------------------------------------------
  id: pick("VITE_INSTANCE_ID", "maine-forum"),
  name: pick("VITE_INSTANCE_NAME", "Maine Forum"),
  shortName: pick("VITE_INSTANCE_SHORT_NAME", "Forum"),
  tagline: pick(
    "VITE_INSTANCE_TAGLINE",
    "A member-owned network for Maine political discourse."
  ),
  // Civic jurisdiction this instance operates in. Drives district routing
  // and officials lookup (Phase 4). Maine is the initial testing ground.
  region: {
    country: "US",
    state: pick("VITE_INSTANCE_STATE", "ME"),
    stateName: pick("VITE_INSTANCE_STATE_NAME", "Maine"),
  },
  locale: pick("VITE_INSTANCE_LOCALE", "en-US"),

  // ---- protocol surface ---------------------------------------------------
  // The binding constraint behind the exclusion list. Rendered on the public
  // transparency page (Phase 2.4) and linked in-app.
  protocol: {
    name: "Human-First Protocol",
    version: "v1",
    docPath: "docs/PROTOCOL.md",
    // Mirrored here so the UI can state the guarantees; the authoritative
    // list lives in docs/PROTOCOL.md and the pivot instructions.
    exclusions: [
      "No payments, payouts, bank linking, or crypto/tokens",
      "No ad serving or ad marketplace",
      "No third-party analytics, trackers, pixels, or fingerprinting",
      "No behavioral or psychographic profiling",
      "No automated form submission to government websites",
      "No server-side storage of street addresses",
      "Member data is never sold",
    ],
  },
};

// ---- group model (Phase 1) -------------------------------------------------
// A Group replaces the old family-scoped "Family". Every group has a `type`.
// Community groups stay end-to-end encrypted (server sees ciphertext only).
// Issue groups (civilian lobbies) are server-readable by design so they can
// support public position pages, tallies, and moderation (per the encryption
// decision on 2026-07-30).

export const GROUP_TYPES = {
  community: {
    id: "community",
    label: "Community",
    plural: "Communities",
    description:
      "A private, invite-only space. End-to-end encrypted — the server only ever stores ciphertext.",
    encryptionMode: "e2e", // 'e2e' | 'server'
    defaults: {
      visibility: "private", // 'private' | 'members' | 'public_read'
      joinPolicy: "invite", // 'invite' | 'request' | 'open'
    },
    // Community groups cannot go public: E2E means non-members hold no key.
    allowedVisibilities: ["private", "members"],
  },
  issue: {
    id: "issue",
    label: "Lobby",
    plural: "Lobbies",
    description:
      "A civilian lobby: deliberate, adopt positions by vote, and route members to their representatives. Server-readable so positions and tallies can be public.",
    encryptionMode: "server",
    defaults: {
      visibility: "members",
      joinPolicy: "request",
    },
    allowedVisibilities: ["private", "members", "public_read"],
  },
};

export const DEFAULT_GROUP_TYPE = "community";

export const VISIBILITIES = {
  private: { id: "private", label: "Private", description: "Only members can find or read this group." },
  members: { id: "members", label: "Members-only", description: "Members read and post; not publicly visible." },
  public_read: { id: "public_read", label: "Public read", description: "Anyone can read; only members can post." },
};

export const JOIN_POLICIES = {
  invite: { id: "invite", label: "Invite only", description: "A steward must send an invite." },
  request: { id: "request", label: "Request to join", description: "Anyone can request; a steward admits." },
  open: { id: "open", label: "Open", description: "Anyone can join immediately." },
};

// ---- roles (Phase 1.3) -----------------------------------------------------
// One account = one membership = one vote per group. Roles are per-group.
export const ROLES = {
  member: {
    id: "member",
    label: "Member",
    rank: 1,
    can: ["read", "post", "comment", "react", "rsvp", "vote", "self_log_action"],
  },
  moderator: {
    id: "moderator",
    label: "Moderator",
    rank: 2,
    can: ["read", "post", "comment", "react", "rsvp", "vote", "self_log_action", "moderate_content", "review_reports"],
  },
  steward: {
    id: "steward",
    label: "Steward",
    rank: 3,
    can: [
      "read", "post", "comment", "react", "rsvp", "vote", "self_log_action",
      "moderate_content", "review_reports", "admit_members", "remove_members",
      "manage_group", "open_polls", "record_outcomes", "grant_roles",
    ],
  },
};

export const FOUNDER_ROLE = "steward";
// Back-compat: the E2E family code minted the founder as 'admin'. Treat that as
// steward-equivalent until the migration retires the old role name.
export const LEGACY_ADMIN_ROLE = "admin";
export const STEWARD_ROLES = new Set([ROLES.steward.id, LEGACY_ADMIN_ROLE]);

// ---- governance defaults (used from Phase 2) -------------------------------
export const GOVERNANCE_DEFAULTS = {
  quorum: Number(pick("VITE_GOV_QUORUM", "0.2")), // fraction of active members
  adoptionThreshold: Number(pick("VITE_GOV_THRESHOLD", "0.5")), // fraction of votes cast
  ballotSecrecy: "hidden_tally_public", // ballots hidden, tallies public
};

// ---- data policy defaults (used from Phase 2) ------------------------------
export const DATA_DEFAULTS = {
  // Deletion of shared content: 'redact' keeps the row with author→"deleted
  // member" and body removed; 'retain_redacted' keeps a redacted body if group
  // policy requires it. Configurable per group (Phase 2.2).
  deletionMode: pick("VITE_DELETION_MODE", "redact"),
  // District codes stored on membership are derived, non-PII. Street addresses
  // are NEVER persisted (Protocol exclusion; Phase 4.3 transient lookup).
  storeStreetAddress: false,
};

export function groupTypeMeta(type) {
  return GROUP_TYPES[type] || GROUP_TYPES[DEFAULT_GROUP_TYPE];
}

export function encryptionModeFor(type) {
  return groupTypeMeta(type).encryptionMode;
}

export function isStewardRole(role) {
  return STEWARD_ROLES.has(role);
}

export default instance;
