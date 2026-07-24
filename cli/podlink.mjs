#!/usr/bin/env node
/**
 * podlink setup — the guided installer for your personal device-to-device
 * encrypted pipeline. Two hub modes:
 *
 *   cloud  — host your Pod on your own Cloudflare account (workers.dev).
 *   home   — host on this machine (workerd) reached over a Cloudflare Tunnel,
 *            so there is no open inbound port.
 *
 * Usage:
 *   podlink setup                         # interactive
 *   podlink setup --cloud [--name NAME]   # non-interactive cloud deploy
 *   podlink setup --home                  # start a home tunnel
 *   podlink doctor                        # check prerequisites
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = join(CLI_DIR, "..");
const WORKER_DIR = join(REPO, "forum-pod-airlock");
const WRANGLER_TOML = join(WORKER_DIR, "wrangler.toml");
const CONFIG_PATH = join(REPO, "podlink.config.json");

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

function log(...a) {
  console.log(...a);
}

/** Run a command, streaming output; resolves with combined stdout text. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd || REPO, env: process.env, shell: false });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (!opts.quiet) stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      out += d;
      if (!opts.quiet) stdout.write(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
    });
  });
}

async function ask(question, def = "") {
  const rl = createInterface({ input: stdin, output: stdout });
  const a = (await rl.question(`${question}${def ? ` [${def}]` : ""}: `)).trim();
  rl.close();
  return a || def;
}

function writeConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  log(c.dim(`wrote ${CONFIG_PATH}`));
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      flags[k] = v === undefined ? true : v;
    } else positional.push(a);
  }
  return { flags, positional };
}

// ---- doctor ---------------------------------------------------------------

async function checkCmd(cmd, args = ["--version"]) {
  try {
    const out = await run(cmd, args, { quiet: true });
    return out.split("\n")[0].trim();
  } catch {
    return null;
  }
}

async function doctor() {
  log(c.bold("\npodlink doctor\n"));
  const node = process.version;
  log(`  node        ${c.green(node)}`);
  const wrangler = await checkCmd("npx", ["wrangler", "--version"]);
  log(`  wrangler    ${wrangler ? c.green(wrangler) : c.red("not found (npm i -g wrangler)")}`);
  const cloudflared = await checkCmd("cloudflared", ["--version"]);
  log(`  cloudflared ${cloudflared ? c.green(cloudflared) : c.yellow("not found (needed for home mode)")}`);
  if (wrangler) {
    const who = await checkCmd("npx", ["wrangler", "whoami"]);
    log(`  cf account  ${who ? c.green("authenticated") : c.yellow("run: npx wrangler login")}`);
  }
  log("");
}

// ---- cloud mode -----------------------------------------------------------

async function ensureD1(dbName) {
  log(c.dim(`checking D1 database "${dbName}"…`));
  let list = "";
  try {
    list = await run("npx", ["wrangler", "d1", "list", "--json"], { quiet: true });
  } catch {
    list = "";
  }
  let id = null;
  try {
    const arr = JSON.parse(list);
    const found = Array.isArray(arr) ? arr.find((d) => d.name === dbName) : null;
    if (found) id = found.uuid || found.database_id || found.id;
  } catch {
    /* fall through to create */
  }
  if (!id) {
    log(c.dim(`creating D1 database "${dbName}"…`));
    const out = await run("npx", ["wrangler", "d1", "create", dbName], { quiet: true });
    const m = out.match(/database_id\s*=\s*"([0-9a-f-]+)"/i) || out.match(/"uuid":\s*"([0-9a-f-]+)"/i);
    if (m) id = m[1];
    if (!id) {
      const m2 = out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (m2) id = m2[1];
    }
  }
  if (!id) throw new Error("Could not determine D1 database_id. Run `npx wrangler d1 create` manually and paste the id into wrangler.toml.");
  return id;
}

function patchWranglerToml({ name, dbId }) {
  let toml = readFileSync(WRANGLER_TOML, "utf8");
  if (name) toml = toml.replace(/^name\s*=\s*".*"/m, `name = "${name}"`);
  if (dbId) toml = toml.replace(/database_id\s*=\s*"[^"]*"/g, `database_id = "${dbId}"`);
  writeFileSync(WRANGLER_TOML, toml);
  log(c.dim(`patched ${WRANGLER_TOML}`));
}

function extractDeployedUrl(out) {
  const m = out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i) ||
    out.match(/https:\/\/[^\s]+\.workers\.dev/i);
  return m ? m[0] : null;
}

async function setupCloud(flags) {
  log(c.bold("\nHost your Pod on Cloudflare\n"));
  const name = flags.name || (await ask("Worker name", "podlink-pod"));
  const dbName = flags.db || `${name}-db`;

  await run("npx", ["wrangler", "whoami"], { quiet: true }).catch(() => {
    throw new Error("Not authenticated. Run `npx wrangler login` first.");
  });

  const dbId = await ensureD1(dbName);
  patchWranglerToml({ name, dbId });

  log(c.dim("building the pod UI…"));
  await run("npm", ["run", "build:pod"], { cwd: WORKER_DIR });

  log(c.dim("deploying worker…"));
  const out = await run("npx", ["wrangler", "deploy"], { cwd: WORKER_DIR });
  const url = extractDeployedUrl(out) || (await ask("Deploy done. Paste the worker URL"));

  // Persist the public URL so contact cards/invites are addressable.
  patchPublicUrl(url);
  log(c.dim("re-deploying with PUBLIC_POD_URL set…"));
  await run("npx", ["wrangler", "deploy"], { cwd: WORKER_DIR }).catch(() => {});

  writeConfig({ mode: "cloud", podUrl: url, worker: name, db: dbName });
  log(`\n${c.green("✓ Pod is live:")} ${c.cyan(url)}`);
  log(`Open the app and enter this URL, or it will be detected automatically when served from the pod.\n`);
  return url;
}

function patchPublicUrl(url) {
  if (!url) return;
  let toml = readFileSync(WRANGLER_TOML, "utf8");
  toml = toml.replace(/PUBLIC_POD_URL\s*=\s*"[^"]*"/, `PUBLIC_POD_URL = "${url}"`);
  writeFileSync(WRANGLER_TOML, toml);
}

// ---- home mode ------------------------------------------------------------

async function setupHome() {
  log(c.bold("\nHost your Pod at home (Cloudflare Tunnel)\n"));
  const cf = await checkCmd("cloudflared", ["--version"]);
  if (!cf) {
    throw new Error("cloudflared is not installed. See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
  }
  log(c.dim("Make sure your pod is running locally on http://127.0.0.1:8787"));
  log(c.dim("(the desktop app boots workerd automatically; otherwise run the workerd sidecar)."));
  log("");
  log("Starting a Quick Tunnel. Watch for the https://<random>.trycloudflare.com URL:\n");
  log(c.yellow("  cloudflared tunnel --url http://127.0.0.1:8787\n"));
  log("Once you see the URL, run:");
  log(c.yellow(`  podlink config --url https://<your>.trycloudflare.com\n`));
  log("For a stable hostname, create a named tunnel + DNS route instead (see docs/PIPELINE.md).");
  // Best-effort: launch the quick tunnel for the user.
  try {
    await run("cloudflared", ["tunnel", "--url", "http://127.0.0.1:8787"]);
  } catch (e) {
    log(c.dim(`(tunnel exited: ${e.message})`));
  }
}

// ---- main -----------------------------------------------------------------

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0] || "setup";

  if (cmd === "doctor") return doctor();

  if (cmd === "config") {
    const url = flags.url;
    if (!url) throw new Error("Usage: podlink config --url https://your-pod-url");
    const existing = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
    writeConfig({ ...existing, podUrl: url.replace(/\/$/, "") });
    return;
  }

  if (cmd === "setup") {
    let mode = flags.cloud ? "cloud" : flags.home ? "home" : "";
    if (!mode) {
      log(c.bold("\nWhere should your Pod live?\n"));
      log("  1) My Cloudflare account (recommended, always-on)");
      log("  2) My home machine + Cloudflare Tunnel (no open ports)\n");
      const a = await ask("Choose 1 or 2", "1");
      mode = a === "2" ? "home" : "cloud";
    }
    if (mode === "cloud") return setupCloud(flags);
    return setupHome();
  }

  log(`Unknown command: ${cmd}`);
  log("Commands: setup [--cloud|--home], doctor, config --url URL");
}

main().catch((e) => {
  console.error(c.red(`\n✗ ${e.message}\n`));
  process.exit(1);
});
