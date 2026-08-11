/**
 * One-shot Maine 132nd CSV → legislation post payloads.
 * Pure. Does not write to FamilyDO. Idempotent key: bill_id + snapshot.
 */
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  classifyBillStatus,
  latestEmit,
  formatBillNumber,
  parseSnapshotFromZipName,
  snapshotIso,
  SESSION_LABEL,
  LEGISCAN_ATTRIBUTION,
  SNAPSHOT_KEY,
} from "./legislation-classify.js";

const execFileAsync = promisify(execFile);

async function readCsv(path) {
  const rows = [];
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!header) {
      header = parseCsvLine(line);
      continue;
    }
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cols[i] ?? ""; });
    rows.push(row);
  }
  return rows;
}

/** Minimal CSV parser (quoted fields). */
export function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function findCsvDir(root) {
  // zip unpacks to ME/2025-2026_132nd_Legislature/csv/
  const candidates = [
    join(root, "ME/2025-2026_132nd_Legislature/csv"),
    join(root, "csv"),
    root,
  ];
  return candidates;
}

async function unzipTo(zipPath, dest) {
  await mkdir(dest, { recursive: true });
  await execFileAsync("unzip", ["-o", "-q", zipPath, "-d", dest]);
}

function pickPeople(peopleRows) {
  const map = new Map();
  for (const p of peopleRows) map.set(String(p.people_id), p);
  return map;
}

function sponsorsFor(billId, sponsorRows, peopleById) {
  const rows = sponsorRows
    .filter((s) => String(s.bill_id) === String(billId))
    .sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
  return rows.map((s) => {
    const p = peopleById.get(String(s.people_id));
    const name = p ? String(p.name || "").trim() : "";
    const party = p ? String(p.party || "").trim() : "";
    const role = p ? String(p.role || "").trim() : "";
    const bits = [name || `people_id ${s.people_id}`];
    const attr = [role, party].filter(Boolean).join(", ");
    if (attr) bits.push(`(${attr})`);
    return {
      people_id: s.people_id,
      position: Number(s.position || 0),
      name: name || null,
      party: party || null,
      role: role || null,
      label: bits.join(" "),
    };
  });
}

function timelineFor(historyRows) {
  return [...historyRows]
    .sort((a, b) => {
      const d = String(a.date).localeCompare(String(b.date));
      if (d) return d;
      return (Number(a.sequence) || 0) - (Number(b.sequence) || 0);
    })
    .map((h) => ({
      date: h.date || "",
      chamber: h.chamber || "",
      sequence: Number(h.sequence) || 0,
      action: String(h.action || "").trim(),
    }));
}

function bestDocument(docs) {
  if (!docs.length) return null;
  const rank = (d) => {
    const desc = String(d.document_desc || "").toLowerCase();
    if (desc === "chaptered") return 0;
    if (desc === "introduced") return 1;
    if (d.document_type === "text") return 2;
    return 9;
  };
  return [...docs].sort((a, b) => rank(a) - rank(b))[0];
}

export function buildPost({ bill, history, sponsors, document, snapshotKey }) {
  const billId = String(bill.bill_id);
  const number = formatBillNumber(bill.bill_number);
  const title = String(bill.title || "").trim();
  const histEmit = latestEmit(history);
  const statusEmit = classifyBillStatus(bill.status_desc);
  if (!histEmit && !statusEmit.emit) {
    return { skip: true, reason: "intro_only", bill_id: billId, bill_number: number };
  }
  const kind = histEmit?.kind || statusEmit.kind;
  const eventDate = histEmit?.date || bill.status_date || bill.last_action_date || "";
  const disposition = String(bill.status_desc || "").trim() || kind;
  const dispositionDate = bill.status_date || eventDate;
  const statement = title ? `${number} — ${title}` : number;
  const stateLink = bill.state_link || document?.state_link || "";
  const legiscanUrl = bill.url || "";
  return {
    skip: false,
    bill_id: billId,
    bill_number: number,
    bill_title: title,
    event_type: kind,
    event_date: eventDate,
    disposition,
    disposition_date: dispositionDate,
    last_action: bill.last_action || "",
    description: String(bill.description || "").trim(),
    sponsors,
    timeline: timelineFor(history),
    source_url: stateLink,
    legiscan_url: legiscanUrl,
    document_url: document?.state_link || document?.url || "",
    snapshot_key: snapshotKey,
    snapshot_date: snapshotIso(snapshotKey),
    session_key: "me-132",
    session_label: SESSION_LABEL.replace(/Data: \d{4}-\d{2}-\d{2}\.$/, `Data: ${snapshotIso(snapshotKey)}.`),
    attribution: LEGISCAN_ATTRIBUTION,
    text: statement,
    window_status: "frozen",
    summary: null,
    summary_model: null,
    summary_version: null,
    summary_error: null,
  };
}

export async function planIngest(zipPath) {
  const snap = parseSnapshotFromZipName(basename(zipPath)) || SNAPSHOT_KEY;
  const dest = await mkdtemp(join(tmpdir(), "me132-"));
  try {
    await unzipTo(zipPath, dest);
    const csvDir = join(dest, "ME/2025-2026_132nd_Legislature/csv");
    const [bills, history, sponsors, documents, people] = await Promise.all([
      readCsv(join(csvDir, "bills.csv")),
      readCsv(join(csvDir, "history.csv")),
      readCsv(join(csvDir, "sponsors.csv")),
      readCsv(join(csvDir, "documents.csv")),
      readCsv(join(csvDir, "people.csv")).catch(() => []),
    ]);
    const peopleById = pickPeople(people);
    const histBy = new Map();
    for (const h of history) {
      const k = String(h.bill_id);
      if (!histBy.has(k)) histBy.set(k, []);
      histBy.get(k).push(h);
    }
    const sponBy = new Map();
    for (const s of sponsors) {
      const k = String(s.bill_id);
      if (!sponBy.has(k)) sponBy.set(k, []);
      sponBy.get(k).push(s);
    }
    const docBy = new Map();
    for (const d of documents) {
      const k = String(d.bill_id);
      if (!docBy.has(k)) docBy.set(k, []);
      docBy.get(k).push(d);
    }

    const posts = [];
    const skipped = [];
    for (const bill of bills) {
      const id = String(bill.bill_id);
      const post = buildPost({
        bill,
        history: histBy.get(id) || [],
        sponsors: sponsorsFor(id, sponBy.get(id) || [], peopleById),
        document: bestDocument(docBy.get(id) || []),
        snapshotKey: snap,
      });
      if (post.skip) skipped.push(post);
      else posts.push(post);
    }
    return {
      snapshot_key: snap,
      snapshot_date: snapshotIso(snap),
      row_counts: {
        bills: bills.length,
        history: history.length,
        sponsors: sponsors.length,
        documents: documents.length,
        people: people.length,
      },
      bills_processed: bills.length,
      posts_planned: posts.length,
      skipped_intro_only: skipped.length,
      posts,
      skipped,
    };
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
}

export function dryRunReport(plan) {
  const byKind = {};
  for (const p of plan.posts) {
    byKind[p.event_type] = (byKind[p.event_type] || 0) + 1;
  }
  return {
    snapshot_key: plan.snapshot_key,
    snapshot_date: plan.snapshot_date,
    bills_processed: plan.bills_processed,
    posts_written: 0,
    posts_would_write: plan.posts_planned,
    summaries_failed: 0,
    skipped_intro_only: plan.skipped_intro_only,
    errors: [],
    by_event_type: byKind,
    row_counts: plan.row_counts,
    dry_run: true,
  };
}
