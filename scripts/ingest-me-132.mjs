#!/usr/bin/env node
/**
 * Maine 132nd archive ingest.
 *
 *   node scripts/ingest-me-132.mjs --dry-run
 *   node scripts/ingest-me-132.mjs --apply --url https://maine.yourcommunity.forum
 *
 * --dry-run (default): print the report, write nothing.
 * --apply: upsert posts via FamilyDO (requires INGEST_TOKEN on the Worker).
 * --zip PATH: override archive. --limit N: first N emit posts (apply/debug).
 * --summaries: ask the Worker to generate AI summaries (fail-open).
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { planIngest, dryRunReport } from "../forum-pod-airlock/legislation-ingest.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const DEFAULT_DIR = "/home/forum-user1/Downloads";
const apply = flag("--apply");
const dryRun = !apply || flag("--dry-run");
const limit = opt("--limit") ? Number(opt("--limit")) : null;
const summaries = flag("--summaries");
const url = (opt("--url") || process.env.INGEST_URL || "").replace(/\/+$/, "");
const token = process.env.INGEST_TOKEN || "";

async function findZip(explicit) {
  if (explicit) return explicit;
  const names = await readdir(DEFAULT_DIR);
  const matches = names
    .filter((n) => /^ME_2025-2026_132nd_Legislature_CSV_20260429_.*\.zip$/i.test(n))
    .sort();
  if (!matches.length) {
    throw new Error(`No ME 132nd 20260429 zip in ${DEFAULT_DIR}`);
  }
  return join(DEFAULT_DIR, matches[matches.length - 1]);
}

async function applyPosts(plan) {
  if (!url) throw new Error("--apply requires --url or INGEST_URL");
  if (!token) throw new Error("--apply requires INGEST_TOKEN");
  let written = 0;
  let summaryFail = 0;
  const errors = [];
  const batchSize = 25;
  const posts = limit ? plan.posts.slice(0, limit) : plan.posts;
  for (let i = 0; i < posts.length; i += batchSize) {
    const batch = posts.slice(i, i + batchSize);
    const res = await fetch(`${url}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        snapshot_key: plan.snapshot_key,
        snapshot_date: plan.snapshot_date,
        row_counts: plan.row_counts,
        generate_summaries: summaries,
        posts: batch,
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      errors.push({ batch: i, status: res.status, error: body?.error || res.statusText });
      continue;
    }
    written += body.count ?? body.upserted ?? 0;
    summaryFail += body.summaries_failed || 0;
    errors.push(...(body.errors || []));
    process.stderr.write(`applied ${Math.min(i + batch.length, posts.length)}/${posts.length}\n`);
  }
  return { written, summaryFail, errors };
}

const zip = await findZip(opt("--zip"));
process.stderr.write(`archive ${zip}\n`);
const plan = await planIngest(zip);
if (limit) plan.posts = plan.posts.slice(0, limit);

if (dryRun && !apply) {
  const report = dryRunReport(plan);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const applied = await applyPosts(plan);
const report = {
  snapshot_key: plan.snapshot_key,
  snapshot_date: plan.snapshot_date,
  bills_processed: plan.bills_processed,
  posts_written: applied.written,
  summaries_failed: applied.summaryFail,
  skipped_intro_only: plan.skipped_intro_only,
  errors: applied.errors,
  row_counts: plan.row_counts,
  last_run: new Date().toISOString(),
  dry_run: false,
};
console.log(JSON.stringify(report, null, 2));
if (applied.errors.length) process.exit(2);
