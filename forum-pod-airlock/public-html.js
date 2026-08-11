/**
 * Minimal semantic HTML for unsigned public pages.
 * No scripts. System fonts only — zero third-party requests.
 */
// TODO: SPA bundle loads Google Fonts via
// forum-theme.css @import — self-host fonts and
// tighten SPA CSP (fonts.googleapis.com /
// fonts.gstatic.com) in a follow-up PR

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #e8eef2;
  --text: #1a2429;
  --dim: #3d4d56;
  --faint: #5c6b73;
  --accent: #1f6b56;
  --border: #c5d0d6;
  --card: #f4f7f8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #12181d;
    --text: #e8eef2;
    --dim: #b7c3c9;
    --faint: #8a969c;
    --accent: #7dcea0;
    --border: #2a353c;
    --card: #1a2228;
  }
}
* { box-sizing: border-box; }
html { font-size: 112.5%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  line-height: 1.55;
}
.skip {
  position: absolute; left: -999px; top: 0;
  background: var(--card); color: var(--text); padding: 0.5rem 1rem;
}
.skip:focus { left: 0.5rem; top: 0.5rem; z-index: 2; }
header, main, footer { max-width: 42rem; margin: 0 auto; padding: 1rem 1.25rem; }
header {
  display: flex; flex-wrap: wrap; gap: 0.75rem 1.25rem;
  align-items: baseline; border-bottom: 1px solid var(--border);
}
header a, footer a, main a { color: var(--accent); }
nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.75rem 1rem; }
h1 { font-size: 1.75rem; line-height: 1.2; margin: 0 0 0.75rem; }
h2 { font-size: 1.2rem; margin: 1.75rem 0 0.5rem; }
p, li { color: var(--dim); }
.lead { font-size: 1.05rem; color: var(--dim); }
.card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: 10px; padding: 1rem 1.1rem; margin: 0.75rem 0;
}
.muted { color: var(--faint); font-size: 0.92rem; }
.planned { font-size: 0.85rem; letter-spacing: 0.02em; text-transform: uppercase; color: var(--faint); }
footer { border-top: 1px solid var(--border); margin-top: 2rem; font-size: 0.92rem; }
.honesty { font-style: italic; }
label { display: block; }
input[type="text"], textarea {
  width: 100%; max-width: 36rem; margin-top: 0.35rem;
  padding: 0.45rem 0.55rem; font: inherit; color: var(--text);
  background: var(--card); border: 1px solid var(--border); border-radius: 6px;
}
button {
  font: inherit; cursor: pointer; padding: 0.5rem 1rem;
  background: var(--accent); color: var(--bg); border: 0; border-radius: 6px;
}
a:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible {
  outline: 3px solid var(--accent); outline-offset: 2px;
}
`;

export const LEGISCAN_FOOTER =
  "Bill data © LegiScan LLC, used under Creative Commons Attribution 4.0. This site is not affiliated with or endorsed by LegiScan.";

export function renderPublicPage({ title, lead, bodyHtml, origin = "", siteName = "Maine Forum" }) {
  const t = esc(title);
  const site = esc(siteName);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>${t} — ${site}</title>
  <meta name="description" content="${esc(lead || title)}" />
  <style>${CSS}</style>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header>
    <a href="${esc(origin)}/boards">${site}</a>
    <nav aria-label="Public pages">
      <ul>
        <li><a href="/boards">Boards</a></li>
        <li><a href="/bills">Legislation</a></li>
        <li><a href="/artifacts">Artifacts</a></li>
        <li><a href="/commons">The Commons</a></li>
        <li><a href="/privacy">Privacy</a></li>
      </ul>
    </nav>
  </header>
  <main id="main">
    <h1>${t}</h1>
    ${lead ? `<p class="lead">${esc(lead)}</p>` : ""}
    ${bodyHtml}
  </main>
  <footer>
    <p>Read-only public pages. To join, comment, or start a lobby, use the
      <a href="/pod/">member app</a>.</p>
    <p><a href="/methodology">Methodology</a> ·
      <a href="/error-log">Error log</a> ·
      <a href="/how-we-verify">How we verify</a> ·
      <a href="/pod/about">About the network</a> ·
      <a href="/pod/charter">Lobby charter</a></p>
    <p class="muted">${esc(LEGISCAN_FOOTER)}</p>
  </footer>
</body>
</html>`;
}

export function cardList(items) {
  if (!items.length) return `<p class="muted">Nothing listed yet. This board is early — not empty theater.</p>`;
  return items.map((it) => {
    const title = it.href
      ? `<a href="${esc(it.href)}">${esc(it.title)}</a>`
      : esc(it.title);
    return `<article class="card"><h2 style="margin-top:0">${title}</h2>${
      it.body ? `<p>${esc(it.body)}</p>` : ""
    }${it.meta ? `<p class="muted">${esc(it.meta)}</p>` : ""}</article>`;
  }).join("\n");
}

export function plannedNote(text) {
  return `<p><span class="planned">Planned</span> ${esc(text)}</p>`;
}

export const PUBLIC_HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "public, max-age=60",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Content-Type-Options": "nosniff",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};
