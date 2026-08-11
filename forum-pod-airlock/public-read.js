/**
 * Unsigned FamilyDO catalog + Worker HTML router.
 */
import {
  matchPublicRoute,
  isPublicReadGroup,
  isPublicArtifactStatus,
  publicBoardsEnabled,
  isHubHost,
} from "./public-access.js";
import { renderPublicPage, cardList, PUBLIC_HTML_HEADERS } from "./public-html.js";
import {
  privacyBody, methodologyBody, errorLogBody, howWeVerifyBody, commonsBody,
  BILLS_SESSION_LABEL,
} from "./public-pages.js";
import { hideTallies, consultativeLine } from "./public-access.js";
import { PLATFORM_AUTHOR_HANDLE } from "./legislation.js";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlResponse(html, status = 200) {
  return new Response(html, { status, headers: PUBLIC_HTML_HEADERS });
}

function siteNameFor(env, hub) {
  if (hub) return "Your Community Forum";
  return String(env.INSTANCE_NAME || "Maine Forum");
}

function robotsTxt() {
  return `User-agent: *
Allow: /boards
Allow: /bills
Allow: /artifacts
Allow: /commons
Allow: /privacy
Allow: /methodology
Allow: /error-log
Allow: /how-we-verify
Allow: /pod/about
Allow: /pod/charter
Disallow: /api/
Disallow: /pod/
`;
}

/** FamilyDO: unsigned GET /public/* */
export function publicCatalog(sql) {
  const state = sql.exec(
    `SELECT id, name, slug, visibility, encryption_mode, type FROM groups WHERE type = 'state' ORDER BY created_at LIMIT 1`
  ).toArray()[0] || null;
  const counties = sql.exec(
    `SELECT id, name, slug, visibility, encryption_mode, type, parent_group_id FROM groups WHERE type = 'county' ORDER BY name COLLATE NOCASE`
  ).toArray();
  const places = sql.exec(
    `SELECT id, name, slug, visibility, encryption_mode, type, parent_group_id, zip_code FROM groups WHERE type = 'place' ORDER BY name COLLATE NOCASE`
  ).toArray();
  let artifacts = [];
  try {
    artifacts = sql.exec(
      `SELECT r.id, r.title, r.status, r.created_at, r.group_id, g.name AS group_name
       FROM civic_reports r JOIN groups g ON g.id = r.group_id
       WHERE r.status IN ('published', 'invalidated')
       ORDER BY r.created_at DESC LIMIT 50`
    ).toArray();
  } catch {
    artifacts = [];
  }
  return {
    state: state && isPublicReadGroup(state) ? pickGroup(state) : null,
    counties: counties.filter(isPublicReadGroup).map(pickGroup),
    places: places.filter(isPublicReadGroup).map(pickGroup),
    artifacts: artifacts.filter((a) => isPublicArtifactStatus(a.status)).map((a) => ({
      id: a.id,
      title: a.title,
      status: a.status,
      created_at: a.created_at,
      group_id: a.group_id,
      group_name: a.group_name,
    })),
    bills: publicBills(sql).posts,
  };
}

function parseMaybe(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function pickBillPost(p) {
  return {
    id: p.id,
    bill_id: p.bill_id || null,
    bill_number: p.bill_number || null,
    bill_title: p.bill_title || null,
    event_type: p.event_type || null,
    session_key: p.session_key || null,
    text: p.text || "",
    created_at: p.created_at,
    disposition: p.disposition || null,
    disposition_date: p.disposition_date || null,
    sponsors: parseMaybe(p.sponsors_json, p.sponsors || []),
    summary: p.summary || null,
    summary_model: p.summary_model || null,
    summary_version: p.summary_version || null,
    snapshot_date: p.snapshot_date || null,
    source_url: p.source_url || null,
    legiscan_url: p.legiscan_url || null,
    timeline: parseMaybe(p.timeline_json, p.timeline || []),
    attribution: p.attribution || null,
    author: PLATFORM_AUTHOR_HANDLE,
  };
}

/** Platform legislation posts (no tallies). */
export function publicBills(sql) {
  try {
    const board = sql.exec(
      `SELECT id, name, slug FROM groups WHERE type = 'legislation' AND visibility = 'public_read' AND encryption_mode = 'server' ORDER BY created_at LIMIT 1`
    ).toArray()[0];
    if (!board) return { board: null, posts: [] };
    const posts = sql.exec(
      `SELECT id, bill_id, text, created_at, bill_number, bill_title, event_type, session_key,
              disposition, disposition_date, sponsors_json, summary, summary_model, summary_version,
              snapshot_date, source_url, legiscan_url, timeline_json, attribution, source, author_pub, status
       FROM group_posts WHERE group_id = ? AND status = 'visible' AND source = 'legislation'
       ORDER BY created_at DESC LIMIT 150`,
      board.id
    ).toArray().map(pickBillPost);
    return { board: { id: board.id, name: board.name, slug: board.slug }, posts };
  } catch {
    return { board: null, posts: [] };
  }
}

export function publicBillDetail(sql, idOrNumber) {
  const key = String(idOrNumber || "").trim();
  if (!key) return null;
  try {
    const row = sql.exec(
      `SELECT p.id, p.bill_id, p.text, p.created_at, p.bill_number, p.bill_title, p.event_type, p.session_key,
              p.disposition, p.disposition_date, p.sponsors_json, p.summary, p.summary_model, p.summary_version,
              p.snapshot_date, p.source_url, p.legiscan_url, p.timeline_json, p.attribution, p.source, p.status,
              g.visibility, g.encryption_mode, g.type
       FROM group_posts p JOIN groups g ON g.id = p.group_id
       WHERE (p.id = ? OR p.bill_id = ? OR p.bill_number = ? OR REPLACE(p.bill_number,' ','') = REPLACE(?,' ',''))
         AND p.status = 'visible' AND p.source = 'legislation'
         AND g.type = 'legislation' AND g.visibility = 'public_read' AND g.encryption_mode = 'server'
       ORDER BY p.created_at DESC LIMIT 1`,
      key, key, key, key
    ).toArray()[0];
    return row ? pickBillPost(row) : null;
  } catch {
    return null;
  }
}

function pickGroup(g) {
  return {
    id: g.id,
    name: g.name,
    slug: g.slug,
    type: g.type,
    parent_group_id: g.parent_group_id || null,
    zip_code: g.zip_code || null,
  };
}

export function publicGroupDetail(sql, slugOrId) {
  const g = sql.exec(
    `SELECT * FROM groups WHERE id = ? OR slug = ? LIMIT 1`, slugOrId, slugOrId
  ).toArray()[0];
  if (!g || !isPublicReadGroup(g)) return null;
  let posts = [];
  try {
    posts = sql.exec(
      `SELECT id, text, created_at FROM group_posts WHERE group_id = ? AND status = 'visible' ORDER BY created_at DESC LIMIT 40`,
      g.id
    ).toArray();
  } catch {
    posts = [];
  }
  const children = sql.exec(
    `SELECT id, name, slug, type, visibility, encryption_mode, zip_code, parent_group_id
     FROM groups WHERE parent_group_id = ? ORDER BY name COLLATE NOCASE`,
    g.id
  ).toArray().filter(isPublicReadGroup).map(pickGroup);
  return { group: pickGroup(g), posts, children };
}

export function publicArtifactDetail(sql, id) {
  let r;
  try {
    r = sql.exec(
      `SELECT r.*, g.name AS group_name, g.visibility, g.encryption_mode, g.type AS group_type
       FROM civic_reports r JOIN groups g ON g.id = r.group_id WHERE r.id = ?`,
      id
    ).toArray()[0];
  } catch {
    return null;
  }
  if (!r || !isPublicArtifactStatus(r.status)) return null;
  if (r.visibility !== "public_read" || r.encryption_mode !== "server") return null;
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    created_at: r.created_at,
    resolved_at: r.resolved_at,
    group_name: r.group_name,
    report_md: r.report_md || r.sql_report || "",
    synthesis_status: r.synthesis_status,
    wiped_at: r.wiped_at,
  };
}

export async function fetchPublicCatalog(env) {
  if (!env.FAMILY) return { state: null, counties: [], places: [], artifacts: [], bills: [] };
  const id = env.FAMILY.idFromName("family-space-v2");
  const stub = env.FAMILY.get(id);
  const res = await stub.fetch(new Request("https://family.internal/public/catalog", { method: "GET" }));
  if (!res.ok) return { state: null, counties: [], places: [], artifacts: [] };
  return res.json();
}

export async function fetchPublicGroup(env, slug) {
  const id = env.FAMILY.idFromName("family-space-v2");
  const stub = env.FAMILY.get(id);
  const res = await stub.fetch(new Request(`https://family.internal/public/groups/${encodeURIComponent(slug)}`, { method: "GET" }));
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json();
}

export async function fetchPublicArtifact(env, artId) {
  const id = env.FAMILY.idFromName("family-space-v2");
  const stub = env.FAMILY.get(id);
  const res = await stub.fetch(new Request(`https://family.internal/public/artifacts/${encodeURIComponent(artId)}`, { method: "GET" }));
  if (!res.ok) return null;
  return res.json();
}

export async function fetchPublicBills(env) {
  if (!env.FAMILY) return { board: null, posts: [] };
  const id = env.FAMILY.idFromName("family-space-v2");
  const stub = env.FAMILY.get(id);
  const res = await stub.fetch(new Request("https://family.internal/public/bills", { method: "GET" }));
  if (!res.ok) return { board: null, posts: [] };
  return res.json();
}

export async function fetchPublicBill(env, billId) {
  if (!env.FAMILY) return null;
  const id = env.FAMILY.idFromName("family-space-v2");
  const stub = env.FAMILY.get(id);
  const res = await stub.fetch(new Request(`https://family.internal/public/bills/${encodeURIComponent(billId)}`, { method: "GET" }));
  if (!res.ok) return null;
  return res.json();
}

function billCardHtml(p, { detail = false } = {}) {
  const num = p.bill_number ? esc(p.bill_number) : "Bill";
  const title = p.bill_title ? esc(p.bill_title) : "";
  const href = `/bills/${encodeURIComponent(p.bill_number || p.id)}`;
  const disp = [p.disposition, p.disposition_date].filter(Boolean).join(" · ");
  const sponsors = (p.sponsors || []).map((s) => s.label || s.name).filter(Boolean);
  const timeline = detail ? (p.timeline || []) : [];
  const stamp = p.summary && p.summary_model
    ? `<p class="muted">Summary: ${esc(p.summary_model)}${p.summary_version ? ` ${esc(p.summary_version)}` : ""} · snapshot ${esc(p.snapshot_date || "")}. <a href="${esc(p.source_url || "#")}">Maine Legislature bill page</a> · <a href="/error-log?report=${encodeURIComponent(p.id)}">Report an error</a></p>`
    : "";
  return `<article class="card">
    <p class="muted">${esc(p.author)} · platform</p>
    <h2 style="margin-top:0">${detail ? `${num}${title ? ` — ${title}` : ""}` : `<a href="${href}">${num}</a>${title ? ` — ${title}` : ""}`}</h2>
    ${disp ? `<p><strong>${esc(disp)}</strong></p>` : ""}
    ${sponsors.length ? `<p>Sponsor${sponsors.length > 1 ? "s" : ""}: ${esc(sponsors.join("; "))}</p>` : ""}
    ${p.summary ? `<p>${esc(p.summary)}</p>${stamp}` : ""}
    ${timeline.length ? `<h3>Action timeline</h3><ol>${timeline.map((h) => `<li>${esc(h.date)} — ${esc(h.chamber ? `${h.chamber}: ` : "")}${esc(h.action)}</li>`).join("")}</ol>` : ""}
    <p class="muted">${esc(BILLS_SESSION_LABEL)}</p>
    ${p.attribution ? `<p class="muted">${esc(p.attribution)}</p>` : ""}
    <p class="muted">Read-only here. Agree, disagree, and the opinion map are in the <a href="/pod/">member app</a>. No tallies on this page.</p>
  </article>`;
}

export async function handlePublicHtml(request, env) {
  const url = new URL(request.url);
  const route = matchPublicRoute(url.pathname);
  if (!route) return null;

  if (route.name === "robots") {
    return new Response(robotsTxt(), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
    });
  }

  const pack = String(env.INSTANCE_PACK || "me").toLowerCase();
  const hub = isHubHost(url.hostname);
  const boardsOk = publicBoardsEnabled(pack) && !hub;
  const siteName = siteNameFor(env, hub);
  const page = (opts, status = 200) => htmlResponse(renderPublicPage({ origin: url.origin, siteName, ...opts }), status);

  if (["state", "counties", "county", "places", "place", "bills", "bill", "artifacts", "artifact"].includes(route.name) && !boardsOk) {
    return page({
      title: "Boards live on the state Forum",
      lead: "Geographic boards are published on the Maine instance, not this host.",
      bodyHtml: `<p><a href="https://maine.yourcommunity.forum/boards">maine.yourcommunity.forum/boards</a></p>`,
    });
  }

  if (route.name === "privacy") {
    return page({ title: "Privacy", lead: "What this instance collects and publishes today.", bodyHtml: privacyBody(siteName) });
  }
  if (route.name === "methodology") {
    return page({ title: "Methodology", lead: "How public pages are ordered and what numbers mean.", bodyHtml: methodologyBody() });
  }
  if (route.name === "error-log") {
    let rows = [];
    let unavailable = false;
    try {
      if (!env.FAMILY) {
        unavailable = true;
      } else {
        const id = env.FAMILY.idFromName("family-space-v2");
        const res = await env.FAMILY.get(id).fetch(new Request("https://family.internal/public/error-reports", { method: "GET" }));
        if (!res.ok) unavailable = true;
        else rows = (await res.json()).rows || [];
      }
    } catch {
      unavailable = true;
    }
    const queued = url.searchParams.get("queued") === "1";
    const urlError = url.searchParams.get("error") === "1";
    const reportId = url.searchParams.get("report") || "";
    return page({
      title: "Public error log",
      lead: "Queued reports stay private until an admin publishes them.",
      bodyHtml: errorLogBody({ rows, reportId, queued, urlError, unavailable }),
    });
  }
  if (route.name === "how-we-verify") {
    return page({ title: "How we verify", lead: "Residency-verified counted stances are not implemented.", bodyHtml: howWeVerifyBody() });
  }
  if (route.name === "commons") {
    return page({
      title: "The Commons — Platform Governance",
      lead: "A non-geographic board where the platform governs itself in public.",
      bodyHtml: commonsBody(),
    });
  }

  if (route.name === "bills") {
    let feed = { board: null, posts: [] };
    try { feed = await fetchPublicBills(env); } catch { /* empty */ }
    const empty = !feed.posts?.length;
    const body = empty
      ? `<section class="card" aria-labelledby="bills-empty">
           <h2 id="bills-empty">Legislation board</h2>
           <p>Bill posts load after import runs. 132nd Legislature — 2,266 posts queued.</p>
         </section>`
      : `<p>Platform posts for this session. Agree, disagree, and the map are in the <a href="/pod/">member app</a> — this page does not show tallies.</p>
         ${feed.posts.map(billCardHtml).join("")}`;
    return page({ title: "Legislation", lead: BILLS_SESSION_LABEL, bodyHtml: body });
  }

  if (route.name === "bill") {
    let post = null;
    try { post = await fetchPublicBill(env, route.id); } catch { /* 404 */ }
    if (!post) {
      return page({
        title: "Bill post not found",
        lead: BILLS_SESSION_LABEL,
        bodyHtml: `<p>No bill post for <code>${esc(route.id)}</code>. Posts appear after import runs.</p>
          <p><a href="/bills">Back to the legislation feed</a></p>`,
      }, 404);
    }
    return page({
      title: post.bill_number || "Legislation post",
      lead: BILLS_SESSION_LABEL,
      bodyHtml: billCardHtml(post, { detail: true }),
    });
  }

  let catalog;
  try {
    catalog = await fetchPublicCatalog(env);
  } catch {
    catalog = { state: null, counties: [], places: [], artifacts: [], bills: [] };
  }

  if (route.name === "state") {
    const st = catalog.state;
    const body = st
      ? `${cardList([{ title: st.name, href: "/boards", body: "Statewide board. Counties below. Place boards open by ZIP in the member app." }])}
         <h2>Counties</h2>
         ${cardList(catalog.counties.map((c) => ({ title: c.name, href: `/boards/counties/${encodeURIComponent(c.slug || c.id)}` })))}
         <p class="muted">This instance is early. Member participation happens in the <a href="/pod/">member app</a>.</p>`
      : `<p>The statewide board has not been founded yet.</p><p class="muted">A founder seeds counties from the member app.</p>`;
    return page({
      title: env.INSTANCE_STATE_NAME || "Maine",
      lead: "Statewide → county → place. Public read; writes stay in the member app.",
      bodyHtml: body,
    });
  }

  if (route.name === "counties") {
    return page({
      title: "County boards",
      lead: `${env.INSTANCE_STATE_NAME || "Maine"} counties on this instance.`,
      bodyHtml: cardList(catalog.counties.map((c) => ({
        title: c.name,
        href: `/boards/counties/${encodeURIComponent(c.slug || c.id)}`,
      }))),
    });
  }

  if (route.name === "places") {
    return page({
      title: "Place boards",
      lead: "Towns and cities already opened by ZIP.",
      bodyHtml: cardList(catalog.places.map((p) => ({
        title: p.name,
        href: `/boards/places/${encodeURIComponent(p.slug || p.id)}`,
        meta: p.zip_code ? `ZIP ${p.zip_code}` : "",
      }))),
    });
  }

  if (route.name === "county" || route.name === "place") {
    const detail = await fetchPublicGroup(env, route.slug);
    if (!detail) {
      return page({
        title: "Board not found",
        lead: "No public_read board matches that name.",
        bodyHtml: `<p><a href="/boards">Back to boards</a></p>`,
      }, 404);
    }
    const childHref = (c) => (c.type === "place"
      ? `/boards/places/${encodeURIComponent(c.slug || c.id)}`
      : `/boards/counties/${encodeURIComponent(c.slug || c.id)}`);
    const postsHtml = detail.posts.length
      ? detail.posts.map((p) => `<article class="card"><p>${esc(p.text)}</p><p class="muted">${esc((p.created_at || "").slice(0, 10))}</p></article>`).join("")
      : `<p class="muted">No public posts yet. This board is early.</p>`;
    return page({
      title: detail.group.name,
      lead: detail.group.type === "county" ? "County board" : "Place board",
      bodyHtml: `${detail.children.length ? `<h2>${detail.group.type === "county" ? "Places" : "Child boards"}</h2>${cardList(detail.children.map((c) => ({ title: c.name, href: childHref(c), meta: c.zip_code ? `ZIP ${c.zip_code}` : "" })))}` : ""}
        <h2>Discussion</h2>
        <p class="muted">Arguments only — no tallies on this public page.</p>
        ${postsHtml}`,
    });
  }

  if (route.name === "artifacts") {
    return page({
      title: "Frozen artifacts",
      lead: "Settled deliberation reports. Open windows are not listed.",
      bodyHtml: cardList(catalog.artifacts.map((a) => ({
        title: a.title,
        href: `/artifacts/${encodeURIComponent(a.id)}`,
        meta: `${a.group_name} · ${a.status} · ${(a.created_at || "").slice(0, 10)}`,
      }))),
    });
  }

  if (route.name === "artifact") {
    const art = await fetchPublicArtifact(env, route.id);
    if (!art) {
      return page({
        title: "Artifact not found",
        lead: "Only published or invalidated reports are public.",
        bodyHtml: `<p><a href="/artifacts">Back to artifacts</a></p>`,
      }, 404);
    }
    const stamp = hideTallies(art.status)
      ? ""
      : `<p class="muted"><strong>${esc(consultativeLine(null))}</strong></p>`;
    return page({
      title: art.title,
      lead: `${art.group_name} · ${art.status}`,
      bodyHtml: `${stamp}
        ${art.synthesis_status === "ok" ? `<p class="muted">Includes a first-party Workers AI summary of ledger facts (generated when the report was published).</p>` : ""}
        <pre class="card" style="white-space:pre-wrap;font-family:inherit">${esc(art.report_md)}</pre>`,
    });
  }

  return null;
}
