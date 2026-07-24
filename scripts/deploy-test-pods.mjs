// Deploy two CF-hosted podlink test pods (A and B) to the authenticated
// Cloudflare account. Writes their URLs to scripts/.test-pods.json and
// restores wrangler.toml to its template afterward.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER = join(ROOT, "forum-pod-airlock");
const TOML = join(WORKER, "wrangler.toml");
const OUT = join(ROOT, "scripts", ".test-pods.json");

const PODS = [
  { name: "podlink-pod-a", dbId: "2a6d93c1-f93b-4594-b5dd-455dfa81a537" },
  { name: "podlink-pod-b", dbId: "b109c638-89e7-490f-bb83-3e51651fc052" },
];

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("npx", args, { cwd: WORKER, env: process.env });
    let out = "";
    p.stdout.on("data", (d) => ((out += d), process.stdout.write(d)));
    p.stderr.on("data", (d) => ((out += d), process.stdout.write(d)));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
  });
}

function patch({ name, dbId, publicUrl }) {
  let toml = readFileSync(TOML, "utf8");
  toml = toml.replace(/^name\s*=\s*".*"/m, `name = "${name}"`);
  toml = toml.replace(/database_id\s*=\s*"[^"]*"/g, `database_id = "${dbId}"`);
  toml = toml.replace(/PUBLIC_POD_URL\s*=\s*"[^"]*"/, `PUBLIC_POD_URL = "${publicUrl || ""}"`);
  writeFileSync(TOML, toml);
}

function extractUrl(out) {
  const m = out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
  return m ? m[0] : null;
}

const template = readFileSync(TOML, "utf8");
const results = {};
try {
  for (const pod of PODS) {
    console.log(`\n=== deploying ${pod.name} ===`);
    patch({ name: pod.name, dbId: pod.dbId, publicUrl: "" });
    const out = await run(["wrangler", "deploy"]);
    const url = extractUrl(out);
    if (!url) throw new Error(`could not find workers.dev URL for ${pod.name}`);
    console.log(`URL: ${url}`);
    patch({ name: pod.name, dbId: pod.dbId, publicUrl: url });
    await run(["wrangler", "deploy"]);
    results[pod.name] = url;
  }
  writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
  console.log(`\nWrote ${OUT}:`, results);
} finally {
  writeFileSync(TOML, template);
  console.log("Restored wrangler.toml template.");
}
