/**
 * Static public-page bodies. Text describes current behavior.
 * Anything not shipped is marked planned.
 */
import { COMMONS_HONESTY_HEADER } from "./public-access.js";
import { plannedNote } from "./public-html.js";

export function privacyBody(siteName = "Maine Forum") {
  return `
<section>
  <h2>What these pages are</h2>
  <p>This privacy page describes the <strong>${escapeHtml(siteName)}</strong> instance on Cloudflare Workers as it runs today. It is not a counsel-signed policy for a data cooperative.</p>
</section>
<section>
  <h2>What we collect</h2>
  <ul>
    <li><strong>Device public keys.</strong> Civic RPC is signed with an Ed25519 key kept in the browser. There is no password and no session cookie.</li>
    <li><strong>Pseudonymous handle</strong> on the instance membership roll.</li>
    <li><strong>Mailbox uniqueness (when used).</strong> Signup can prove mailbox ownership via a confirmation code. Production stores a nullifier/hash, not a marketing email list. Raw street addresses are never collected.</li>
    <li><strong>ZIP codes</strong> only when a member opens a place board. The ZIP is stored on that board row (five digits), not as a home address, and never with a street line.</li>
    <li><strong>Civic posts, comments, and stances</strong> on server-readable boards (state / county / place / lobby) so the instance can render public discussion and later frozen reports.</li>
  </ul>
</section>
<section>
  <h2>What we do not collect</h2>
  <ul>
    <li>Street addresses — anywhere, including logs and error reports.</li>
    <li>Payments, payouts, ads, or third-party analytics SDKs.</li>
    <li>Engagement-ranked “hot” scores or re-engagement notifications.</li>
  </ul>
</section>
<section>
  <h2>What is public on this Worker path</h2>
  <p>Unsigned HTML can list <code>public_read</code> state, county, and place boards, the legislation feed (platform-authored bill posts), and frozen deliberation artifacts. Live vote tallies are not shown on open windows (numbers discipline). Joining, agreeing, commenting, and starting lobbies happen only in the member app.</p>
</section>
<section>
  <h2>Infrastructure that still sees requests</h2>
  <ul>
    <li>Cloudflare terminates TLS and may retain connection metadata. This Worker rate-limits by IP (hashed into a short-lived D1 bucket) and prunes those rows after a few windows.</li>
    <li>Cloudflare Workers observability is enabled at low sample rate on the Worker.</li>
    <li>The <strong>member React app</strong> still loads Google Fonts today. That is a third-party request on <code>/pod</code>. <strong>These public HTML pages do not.</strong>
      ${plannedNote("Self-host those fonts on the member app so a logged-in page load is also first-party only.")}</li>
  </ul>
</section>
<section>
  <h2>Retention</h2>
  <p>Civic ledger rows live in the instance Durable Object until a member deletes their account (soft-delete of their visible posts) or a lobby is dissolved. Frozen report ledgers may wipe verbatim excerpts after the review window. IP rate-limit rows are not a user profile and are not kept with ZIP.</p>
</section>
`;
}

export function methodologyBody() {
  return `
<section>
  <h2>What you are reading</h2>
  <p>Public pages are generated on the Maine Forum Worker from the instance ledger. They are not engagement-ranked. Board lists are alphabetical or chronological. There is no “hot” sort.</p>
</section>
<section>
  <h2>Numbers</h2>
  <p>While a deliberation window is open, public pages do not show tallies, percentages, or opinion-map scoreboards. Aggregates appear only on <a href="/artifacts">frozen artifacts</a>, with a consultative label until residency is verified.</p>
</section>
<section>
  <h2>Bills</h2>
  <p>The 132nd Maine Legislature session is treated as <strong>concluded</strong> for labeling. A dedicated legislation board holds <strong>platform-authored</strong> posts (hearing, work session, floor vote, enacted — never introduction). Members agree or disagree in the member app; that signal builds this session’s opinion map. Public HTML lists the feed without tallies.</p>
  <p>No CSV ingest has run, so the feed is empty today.
  ${plannedNote("Phase 3 will import the local Maine LegiScan CSV batch (no live API) and create a feed post only on those status changes.")}</p>
</section>
<section>
  <h2>AI</h2>
  <p>Frozen co-op deliberation reports may include an optional first-party Workers AI summary constrained to SQL facts, stamped in the report when present. Public HTML does not call a model when you load a page.
  ${plannedNote("Bill plain-language summaries, if added, will carry generator name, version, date, source links, and a report-an-error path.")}</p>
</section>
`;
}

export function errorLogBody({ rows = [], reportId = "", queued = false, urlError = false, unavailable = false } = {}) {
  const published = rows.filter((r) => r.status === "open" || r.status === "corrected");
  const list = unavailable
    ? `<p>Error log temporarily unavailable</p>`
    : published.length
    ? `<ul>${published.map((r) => `<li><strong>${escapeHtml((r.created_at || "").slice(0, 10))}</strong> — ${escapeHtml(r.bill_number || r.item_id || "item")} · ${escapeHtml(r.status)}</li>`).join("")}</ul>`
    : `<p class="muted">No published entries yet. New reports go to an admin queue first and do not appear here until an admin marks them open or corrected.</p>`;
  return `
<section>
  <p>Reports about public pages and bill posts are held in an admin triage queue. Only entries an admin has marked <strong>open</strong> or <strong>corrected</strong> appear on this page.</p>
  ${queued ? `<p class="card" role="status">Received. This report is in the admin queue (not public) until it is triaged.</p>` : ""}
  ${urlError ? `<p class="card" role="alert">Description is required.</p>` : ""}
  <h2>Published log</h2>
  ${list}
  <h2>Report an error</h2>
  <form method="post" action="/api/error-report">
    <p>
      <label for="postId">Related post (optional)</label>
      <input id="postId" name="postId" type="text" maxlength="120" value="${escapeHtml(reportId)}" autocomplete="off" />
    </p>
    <p>
      <label for="description">Description (required)</label>
      <textarea id="description" name="description" rows="4" maxlength="1000" required></textarea>
    </p>
    <p><button type="submit">Submit to triage queue</button></p>
  </form>
  <p class="muted">This form posts to <code>/api/error-report</code> without JavaScript. Security issues: <a href="/.well-known/security.txt">security.txt</a>.</p>
</section>
`;
}

export function howWeVerifyBody() {
  return `
<section>
  <p>Decided by the first Commons question — <a href="/commons">link to /commons</a>.</p>
</section>
`;
}

export function commonsBody() {
  return `
<section>
  <p class="honesty card">${escapeHtml(COMMONS_HONESTY_HEADER)}</p>
  <p>First governance question coming soon.</p>
  <p><a href="/methodology">Methodology</a></p>
</section>
`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const BILLS_SESSION_LABEL =
  "132nd Legislature (2025–2026) — session concluded. Data: 2026-04-29.";
