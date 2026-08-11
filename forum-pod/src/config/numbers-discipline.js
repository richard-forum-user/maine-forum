/**
 * Numbers discipline (Tier 0 / Commons Constraint 3 + 5).
 *
 * While a deliberation window is open: show arguments and reasons only.
 * Tallies, counts, and percentages appear only on frozen artifacts.
 * Wherever a percentage renders, raw N is at equal or greater visual weight.
 * Until Tier 2 residency verification exists, every aggregate carries the
 * consultative label.
 *
 * Public/gated boundaries live elsewhere (access module). Gate copy lives
 * in civic/gate-copy.js when Phase 2 lands. This file is the single source
 * for count-visibility and labeling strings.
 */

export const IDENTITY_TIER = {
  anonymous: 0,
  emailZip: 1,
  verifiedResident: 2,
  namedSigner: 3,
};

/** Highest identity tier that currently exists in product. */
export const CURRENT_IDENTITY_TIER = IDENTITY_TIER.emailZip;

export const DELIBERATION_STATUS = {
  open: "open",
  frozen: "frozen",
};

/**
 * Challenge / report statuses that are still an open window (hide tallies).
 * Frozen / terminal statuses may show N + % with the consultative stamp.
 */
export const OPEN_GOVERNANCE_STATUSES = new Set([
  "collecting",
  "review",
  "voting",
]);

export const FROZEN_GOVERNANCE_STATUSES = new Set([
  "passed",
  "failed",
  "expired",
  "published",
  "invalidated",
  "cleared",
  "settled",
  "decided",
  "frozen",
]);

export const LABELS = {
  consultative:
    "Consultative — participants not yet residency-verified. N = {n}.",
  windowOpen:
    "This window is open. Arguments and reasons are visible; tallies stay hidden until it freezes.",
  stanceRecorded: "Your stance is recorded. Distribution is hidden until freeze.",
  endorseRecorded: "You endorsed. Endorsement totals are hidden until this window closes.",
  contestRecorded: "You contested. Contest totals are hidden until this window closes.",
  opinionMapOpen:
    "Opinion structure and vote volume are published only in a frozen deliberation report. While the board is open, read the arguments — not the scoreboard.",
};

export function consultativeLine(n) {
  const raw = n == null || Number.isNaN(Number(n)) ? "—" : String(Number(n));
  return LABELS.consultative.replace("{n}", raw);
}

/** True when live tallies must be hidden. */
export function hideTallies(status) {
  if (status == null || status === DELIBERATION_STATUS.open) return true;
  if (status === DELIBERATION_STATUS.frozen) return false;
  if (OPEN_GOVERNANCE_STATUSES.has(status)) return true;
  if (FROZEN_GOVERNANCE_STATUSES.has(status)) return false;
  return true;
}

/**
 * Format a share for a frozen artifact. Percentage never appears without N,
 * and N is listed first (equal or greater visual weight).
 */
export function formatShare({ n, total, label = "" }) {
  const N = Number(n) || 0;
  const T = Number(total) || 0;
  if (T <= 0) {
    return { n: N, total: T, pct: null, text: label ? `${label}: N = ${N}` : `N = ${N}` };
  }
  const pct = Math.round((N / T) * 100);
  const body = `${label ? `${label}: ` : ""}N = ${N} of ${T} (${pct}%)`;
  return { n: N, total: T, pct, text: body };
}

export function isConsultativeTier(tier = CURRENT_IDENTITY_TIER) {
  return tier < IDENTITY_TIER.verifiedResident;
}
