// Deploy one podlink Pod per name to the authenticated Cloudflare account.
// Usage: node scripts/deploy-pods.mjs alice bob carol
// For each NAME: ensures a D1 db (podlink-NAME-db), deploys worker
// "podlink-NAME", sets PUBLIC_POD_URL, and records the workers.dev URL.
// Writes scripts/.pods.json and restores wrangler.toml afterward.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = join(ROOT, "forum-pod-airlock");
const TOML = join(WORKER, "wrangler.toml");
const OUT = join(ROOT, "scripts", ".pods.json");

const names = process.argv.slice(2).map((s) => s.trim().toLowerCase()).filter(Boolean);
if (names.length === 0) {
  console.error("Usage: node scripts/deploy-pods.mjs <name> [<name> ...]");
  process.exit(1);
}

// Custom domains per pod. Attaching a custom_domain route makes Cloudflare
// create the DNS record + edge certificate automatically (zone must be on this
// account). Keeping it here means every redeploy re-asserts the domain.
const DOMAINS = {
  family: "family.yourcommunity.forum",
};

function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: WORKER, env: process.env });
    let out = "";
    p.stdout.on("data", (d) => ((out += d), opts.quiet || process.stdout.write(d)));
    p.stderr.on("data", (d) => ((out += d), opts.quiet || process.stdout.write(d)));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${out.slice(-400)}`))));
  });
}
const run = (args, opts) => exec("npx", args, opts);

async function ensureD1(dbName) {
  let id = null;
  try {
    const list = await run(["wrangler", "d1", "list", "--json"], { quiet: true });
    const arr = JSON.parse(list);
    const found = Array.isArray(arr) ? arr.find((d) => d.name === dbName) : null;
    if (found) id = found.uuid || found.database_id || found.id;
  } catch {}
  if (!id) {
    const out = await run(["wrangler", "d1", "create", dbName], { quiet: true });
    const m =
      out.match(/database_id\s*=\s*"([0-9a-f-]+)"/i) ||
      out.match(/"uuid":\s*"([0-9a-f-]+)"/i) ||
      out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (m) id = m[1];
  }
  if (!id) throw new Error(`could not resolve D1 id for ${dbName}`);
  return id;
}

function patch({ name, dbId, publicUrl, domain }) {
  // Always start from the pristine template so custom-domain blocks and
  // origin lists don't accumulate across the two-phase deploy.
  let toml = template;
  toml = toml.replace(/^name\s*=\s*".*"/m, `name = "${name}"`);
  toml = toml.replace(/database_id\s*=\s*"[^"]*"/g, `database_id = "${dbId}"`);
  toml = toml.replace(/PUBLIC_POD_URL\s*=\s*"[^"]*"/, `PUBLIC_POD_URL = "${publicUrl || ""}"`);
  if (domain) {
    toml = toml.replace(/WEBAUTHN_ALLOWED_ORIGINS\s*=\s*"([^"]*)"/, (_m, val) =>
      `WEBAUTHN_ALLOWED_ORIGINS = "${val},https://${domain}"`
    );
    toml += `\n[[routes]]\npattern = "${domain}"\ncustom_domain = true\n`;
  }
  writeFileSync(TOML, toml);
}

const extractUrl = (out) => (out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i) || [])[0] || null;

const template = readFileSync(TOML, "utf8");
const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
try {
  // Build the PWA once; all pods share the same client bundle.
  console.log("=== building pod UI ===");
  await exec("npm", ["run", "build:pod"]);

  for (const base of names) {
    const worker = `podlink-${base}`;
    const dbName = `podlink-${base}-db`;
    const domain = DOMAINS[base] || null;
    console.log(`\n=== ${worker} (db ${dbName})${domain ? ` @ ${domain}` : ""} ===`);
    const dbId = await ensureD1(dbName);
    patch({ name: worker, dbId, publicUrl: "", domain });
    const out = await run(["wrangler", "deploy"]);
    const url = extractUrl(out);
    if (!url && !domain) throw new Error(`no workers.dev URL for ${worker}`);
    const publicUrl = domain ? `https://${domain}` : url;
    patch({ name: worker, dbId, publicUrl, domain });
    await run(["wrangler", "deploy"], { quiet: true });
    results[worker] = domain ? `https://${domain}` : url;
    console.log(`URL: ${results[worker]}${domain ? `  (also ${url})` : ""}`);
  }
  writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
  console.log(`\nWrote ${OUT}`);
  console.log("\nPod URLs:");
  for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(20)} ${v}`);
} finally {
  writeFileSync(TOML, template);
  console.log("\nRestored wrangler.toml template.");
}
