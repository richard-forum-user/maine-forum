/**
 * Maine legislation feed — platform-authored posts that members engage.
 * Mirror of forum-pod/src/config/legislation.js (Worker cannot import Vite app).
 *
 * Posts are written by ingest (Phase 3 CSV), never by members.
 * Agree/disagree on those posts is the opinion-map signal.
 */

export const PLATFORM_AUTHOR_PUB = "platform:legislature";
export const PLATFORM_AUTHOR_HANDLE = "Maine Legislature";

export const LEGISLATION_PACKS = new Set(["me"]);

export const ME_132_SESSION = {
  packId: "me",
  sessionKey: "me-132",
  sessionLabel: "132nd Legislature (2025–2026) — session concluded. Data: 2026-04-29.",
  boardName: "132nd Legislature",
  boardSlug: "legislature-132",
};

export const LEGISLATION_EVENT_TYPES = new Set([
  "work_session",
  "floor_vote",
  "ought_to_pass",
  "enacted",
  "vetoed",
  "failed",
  "indefinitely_postponed",
]);

export const LEGISLATION_EVENT_LABELS = {
  work_session: "Work session",
  floor_vote: "Floor vote",
  ought_to_pass: "Ought to pass",
  enacted: "Enacted",
  vetoed: "Vetoed",
  failed: "Failed",
  indefinitely_postponed: "Indefinitely postponed",
};

export function legislationEnabled(packId) {
  return LEGISLATION_PACKS.has(String(packId || "").toLowerCase());
}

export function sessionForPack(packId) {
  return legislationEnabled(packId) ? ME_132_SESSION : null;
}

export function isPlatformAuthor(pub) {
  return String(pub || "") === PLATFORM_AUTHOR_PUB;
}

export function eventLabel(type) {
  return LEGISLATION_EVENT_LABELS[type] || String(type || "");
}
