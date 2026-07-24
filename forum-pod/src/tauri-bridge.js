/**
 * Thin bridge to the desktop (Tauri) host. In the browser/PWA these are
 * no-ops, so the UI can call them unconditionally and branch on isTauri().
 */

export function isTauri() {
  return typeof window !== "undefined" && !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
}

function invoke(cmd, args) {
  const api = typeof window !== "undefined" ? window.__TAURI__ : null;
  const fn = api?.core?.invoke || api?.invoke;
  if (!fn) return Promise.reject(new Error("Tauri not available"));
  return fn(cmd, args);
}

function localPort() {
  if (typeof window === "undefined") return 8787;
  const p = parseInt(window.location.port, 10);
  return Number.isFinite(p) && p > 0 ? p : 8787;
}

export async function startTunnel(port = localPort()) {
  return invoke("tunnel_start", { port });
}

export async function tunnelStatus() {
  return invoke("tunnel_status");
}

export async function stopTunnel() {
  return invoke("tunnel_stop");
}
