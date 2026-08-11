/**
 * Phase 1 — public/gated boundary + static Worker HTML (no Durable Object).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  matchPublicRoute,
  isPublicReadGroup,
  isPublicArtifactStatus,
  publicBoardsEnabled,
  isHubHost,
  COMMONS_HONESTY_HEADER,
} from "./public-access.js";
import { legislationEnabled, isPlatformAuthor, eventLabel } from "./legislation.js";
import { handlePublicHtml } from "./public-read.js";

test("matchPublicRoute claims Phase 1 paths and leaves hub docs alone", () => {
  assert.equal(matchPublicRoute("/privacy").name, "privacy");
  assert.equal(matchPublicRoute("/commons").name, "commons");
  assert.equal(matchPublicRoute("/boards/counties/knox").slug, "knox");
  assert.equal(matchPublicRoute("/bills/LD-1").id, "LD-1");
  assert.equal(matchPublicRoute("/artifacts/abc").id, "abc");
  assert.equal(matchPublicRoute("/pod/about"), null);
  assert.equal(matchPublicRoute("/pod/charter"), null);
  assert.equal(matchPublicRoute("/api/family"), null);
});

test("public boards are Maine-only; hub host is not a board host", () => {
  assert.equal(publicBoardsEnabled("me"), true);
  assert.equal(publicBoardsEnabled("nh"), false);
  assert.equal(publicBoardsEnabled("vt"), false);
  assert.equal(isHubHost("yourcommunity.forum"), true);
  assert.equal(isHubHost("maine.yourcommunity.forum"), false);
});

test("only public_read server-mode geo boards list", () => {
  assert.equal(isPublicReadGroup({ type: "county", visibility: "public_read", encryption_mode: "server" }), true);
  assert.equal(isPublicReadGroup({ type: "issue", visibility: "public_read", encryption_mode: "server" }), false);
  assert.equal(isPublicReadGroup({ type: "legislation", visibility: "public_read", encryption_mode: "server" }), false);
  assert.equal(isPublicReadGroup({ type: "county", visibility: "members", encryption_mode: "server" }), false);
  assert.equal(isPublicArtifactStatus("published"), true);
  assert.equal(isPublicArtifactStatus("review"), false);
});

test("commons honesty header is the locked verbatim sentence", () => {
  assert.equal(
    COMMONS_HONESTY_HEADER,
    "Advisory vote. Participants are not yet residency-verified — that gap is what this question exists to close. The nonprofit's board makes the final decision and will publish a written response to this outcome within 30 days of freeze."
  );
});

const emptyEnv = {
  INSTANCE_PACK: "me",
  INSTANCE_NAME: "Maine Forum",
  INSTANCE_STATE_NAME: "Maine",
};

async function get(path, env = emptyEnv, host = "maine.yourcommunity.forum") {
  return handlePublicHtml(new Request(`https://${host}${path}`), env);
}

test("static public pages render without scripts or third-party URLs", async () => {
  const commons = await get("/commons");
  const html = await commons.text();
  assert.equal(commons.status, 200);
  assert.match(html, /Advisory vote\. Participants are not yet residency-verified/);
  assert.match(html, /First governance question coming soon/);
  assert.match(html, /href="\/methodology"/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic|googletagmanager|google-analytics/i);

  const privacy = await (await get("/privacy")).text();
  assert.match(privacy, /These public HTML pages do not/);
  assert.match(privacy, /Planned/);

  const bills = await get("/bills");
  const billsHtml = await bills.text();
  assert.match(billsHtml, /132nd Legislature \(2025–2026\) — session concluded\. Data: 2026-04-29/);
  assert.match(billsHtml, /Bill posts load after import runs/);
  assert.match(billsHtml, /2,266 posts queued/);
  assert.doesNotMatch(billsHtml, /\btall(?:y|ies)\b|\bpercentages?\b|participant counts/i);
  assert.match(billsHtml, /LegiScan/);

  const methodology = await (await get("/methodology")).text();
  assert.match(methodology, /no “hot” sort|no "hot" sort/);

  const errLogRes = await get("/error-log");
  assert.equal(errLogRes.status, 200);
  const errLog = await errLogRes.text();
  assert.match(errLog, /Error log temporarily unavailable/);
  assert.match(errLog, /admin triage queue/);
  assert.match(errLog, /action="\/api\/error-report"/);
  assert.match(errLog, /name="postId"/);
  assert.match(errLog, /name="description"[^>]*required|required[^>]*name="description"/);
  assert.match(errLog, /Submit to triage queue/);

  const verify = await (await get("/how-we-verify")).text();
  assert.match(verify, /Decided by the first Commons question/);
  assert.match(verify, /href="\/commons"/);

  const missing = await get("/bills/LD-9999");
  const missingHtml = await missing.text();
  assert.equal(missing.status, 404);
  assert.match(missingHtml, /132nd Legislature \(2025–2026\) — session concluded/);
  assert.match(missingHtml, /No bill post/);
});

test("legislation feed is Maine-only platform posts", () => {
  assert.equal(legislationEnabled("me"), true);
  assert.equal(legislationEnabled("nh"), false);
  assert.equal(isPlatformAuthor("platform:legislature"), true);
  assert.equal(isPlatformAuthor("abc"), false);
  assert.equal(eventLabel("work_session"), "Work session");
});

test("hub does not serve Maine board indexes", async () => {
  const res = await get("/boards", emptyEnv, "yourcommunity.forum");
  const html = await res.text();
  assert.match(html, /maine\.yourcommunity\.forum\/boards/);
});
