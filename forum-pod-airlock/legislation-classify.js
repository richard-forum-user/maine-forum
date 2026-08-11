/**
 * Maine history-table emit / silent rules (Phase 3).
 * Introduction, referral, and amendment-filed never create a post.
 */

export const EMIT_KINDS = [
  "work_session",
  "floor_vote",
  "ought_to_pass",
  "enacted",
  "vetoed",
  "failed",
  "indefinitely_postponed",
];

export const SESSION_LABEL =
  "132nd Legislature (2025–2026) — session concluded. Data: 2026-04-29.";

export const LEGISCAN_ATTRIBUTION =
  "Bill data © LegiScan LLC, used under CC BY 4.0. This site is not endorsed by LegiScan.";

export const SNAPSHOT_DATE = "2026-04-29";
export const SNAPSHOT_KEY = "20260429";

const OTP = /\bought to pass\b|\bvoted:\s*otp(?:-am)?\b|\breported out:\s*otp(?:-am)?\b/;
const ONTP = /\bought not to pass\b|\bontp\b/;

export function classifyHistoryAction(action) {
  const a = String(action || "").trim();
  const al = a.toLowerCase();
  if (!al) return { emit: false, kind: "empty" };

  if (/\bwork session\b/.test(al)) {
    return { emit: true, kind: "work_session" };
  }

  if (
    /\bvetoed\b|\bgovernor'?s veto\b|\bveto override/.test(al) ||
    /returned by the governor.*objections|not become a law/.test(al)
  ) {
    return { emit: true, kind: "vetoed" };
  }

  if (/passed to be enacted|finally passed|became law/.test(al)) {
    return { emit: true, kind: "enacted" };
  }

  if (
    /failed passage to be enacted|failed final passage|failed enactment|passage to be enacted failed/.test(al)
  ) {
    return { emit: true, kind: "failed" };
  }
  if (/placed in (?:the )?legislative files\.? \(dead\)|died in possession|joint rule 310/.test(al)) {
    return { emit: true, kind: "failed" };
  }

  if (/indefinitely postpon|indefinite postponement/.test(al)) {
    if (/\bfailed\b/.test(al)) return { emit: false, kind: "silent" };
    if (/\bamendment\b/.test(al) && !/bill and accompanying/.test(al)) {
      return { emit: false, kind: "silent" };
    }
    if (
      /bill and accompanying|the bill was indefinitely|indefinitely postponed bill|indefinite postponement of bill/.test(
        al
      )
    ) {
      return { emit: true, kind: "indefinitely_postponed" };
    }
    return { emit: false, kind: "silent" };
  }

  // Ought-to-pass is the affirmative committee report. Emit it.
  // Silence only OTP *motion-failed* lines (accept/report motion failed), not OTP itself.
  if (OTP.test(al) && !ONTP.test(al)) {
    if (/\bfailed\b/.test(al)) return { emit: false, kind: "silent" };
    return { emit: true, kind: "ought_to_pass" };
  }

  // Failed floor/committee *motions* are not bill failure.
  if (/\bfailed\b/.test(al) && !/failed passage to be enacted|failed final passage|failed enactment/.test(al)) {
    return { emit: false, kind: "silent" };
  }

  if (/consent calendar|unfinished business|passed to be engrossed/.test(al)) {
    return { emit: true, kind: "floor_vote" };
  }

  if (/public hearing|hearing scheduled/.test(al)) {
    return { emit: true, kind: "work_session" };
  }

  if (/referred to the committee|referred to the joint|committed to the committee/.test(al)) {
    return { emit: false, kind: "referral" };
  }
  if (/\bamendment\b/.test(al)) return { emit: false, kind: "amendment" };
  if (/committee on reference|received by the (?:clerk|secretary)/.test(al)) {
    return { emit: false, kind: "introduction" };
  }

  return { emit: false, kind: "other" };
}

/** Terminal bill.status_desc is itself an emit when history never matched. */
export function classifyBillStatus(statusDesc) {
  const d = String(statusDesc || "").trim().toLowerCase();
  if (d === "passed") return { emit: true, kind: "enacted" };
  if (d === "failed") return { emit: true, kind: "failed" };
  if (d === "vetoed") return { emit: true, kind: "vetoed" };
  if (d === "engrossed") return { emit: true, kind: "floor_vote" };
  return { emit: false, kind: d || "unknown" };
}

export function latestEmit(historyRows) {
  let best = null;
  for (const row of historyRows || []) {
    const c = classifyHistoryAction(row.action);
    if (!c.emit) continue;
    const seq = Number(row.sequence) || 0;
    const date = row.date || "";
    if (
      !best ||
      date > best.date ||
      (date === best.date && seq >= best.sequence)
    ) {
      best = { kind: c.kind, date, sequence: seq, action: row.action, chamber: row.chamber || "" };
    }
  }
  return best;
}

export function formatBillNumber(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^(LD|HP|SP|IB|HP|LD)\s*[-]?(\d+)$/i);
  if (m) return `${m[1].toUpperCase()} ${m[2]}`;
  return s;
}

export function parseSnapshotFromZipName(name) {
  const m = String(name || "").match(/_CSV_(\d{8})_/);
  return m ? m[1] : null;
}

export function snapshotIso(key) {
  const k = String(key || "");
  if (!/^\d{8}$/.test(k)) return SNAPSHOT_DATE;
  return `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`;
}
