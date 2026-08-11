/**
 * Public / gated boundary for unsigned Worker HTML (Phase 1).
 * Single module — do not scatter public_read checks in page templates.
 *
 * React (/pod) remains the member surface. These rules apply only to
 * unsigned GET HTML served by secure-worker.js.
 */

/** Geographic civic boards that may appear on the public read path. */
export const PUBLIC_BOARD_TYPES = new Set(["state", "county", "place"]);

/** Frozen deliberation-report statuses that may be published as artifacts. */
export const PUBLIC_ARTIFACT_STATUSES = new Set(["published", "invalidated"]);

/** Pack ids allowed to expose board indexes on the public path. */
export const PUBLIC_BOARD_PACKS = new Set(["me"]);

export const COMMONS_HONESTY_HEADER =
  "Advisory vote. Participants are not yet residency-verified — that gap is what this question exists to close. The nonprofit's board makes the final decision and will publish a written response to this outcome within 30 days of freeze.";

export function publicBoardsEnabled(packId) {
  return PUBLIC_BOARD_PACKS.has(String(packId || "").toLowerCase());
}

export function isHubHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "yourcommunity.forum" || h === "www.yourcommunity.forum";
}

/** A group row is listable on unsigned HTML. */
export function isPublicReadGroup(group) {
  if (!group) return false;
  if (group.encryption_mode !== "server") return false;
  if (group.visibility !== "public_read") return false;
  return PUBLIC_BOARD_TYPES.has(group.type);
}

export function isPublicArtifactStatus(status) {
  return PUBLIC_ARTIFACT_STATUSES.has(String(status || ""));
}

/** Mirror of forum-pod numbers-discipline consultativeLine (Worker cannot import Vite app). */
export function consultativeLine(n) {
  const raw = n == null || Number.isNaN(Number(n)) ? "—" : String(Number(n));
  return `Consultative — participants not yet residency-verified. N = ${raw}.`;
}

const OPEN_GOVERNANCE_STATUSES = new Set(["collecting", "review", "voting"]);
const FROZEN_GOVERNANCE_STATUSES = new Set([
  "passed", "failed", "expired", "published", "invalidated",
  "cleared", "settled", "decided", "frozen",
]);

export function hideTallies(status) {
  if (status == null || status === "open") return true;
  if (status === "frozen") return false;
  if (OPEN_GOVERNANCE_STATUSES.has(status)) return true;
  if (FROZEN_GOVERNANCE_STATUSES.has(status)) return false;
  return true;
}

/**
 * Pathname → public route key, or null (fall through to SPA / other handlers).
 * Hub About/Charter stay on /pod/* and are not claimed here.
 */
export function matchPublicRoute(pathname) {
  let p = String(pathname || "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (p === "/privacy") return { name: "privacy" };
  if (p === "/methodology") return { name: "methodology" };
  if (p === "/error-log") return { name: "error-log" };
  if (p === "/how-we-verify") return { name: "how-we-verify" };
  if (p === "/commons") return { name: "commons" };
  if (p === "/robots.txt") return { name: "robots" };
  if (p === "/boards") return { name: "state" };
  if (p === "/boards/counties") return { name: "counties" };
  const county = p.match(/^\/boards\/counties\/([^/]+)$/);
  if (county) return { name: "county", slug: decodeURIComponent(county[1]) };
  if (p === "/boards/places") return { name: "places" };
  const place = p.match(/^\/boards\/places\/([^/]+)$/);
  if (place) return { name: "place", slug: decodeURIComponent(place[1]) };
  if (p === "/bills") return { name: "bills" };
  const bill = p.match(/^\/bills\/([^/]+)$/);
  if (bill) return { name: "bill", id: decodeURIComponent(bill[1]) };
  if (p === "/artifacts") return { name: "artifacts" };
  const art = p.match(/^\/artifacts\/([^/]+)$/);
  if (art) return { name: "artifact", id: decodeURIComponent(art[1]) };
  return null;
}
