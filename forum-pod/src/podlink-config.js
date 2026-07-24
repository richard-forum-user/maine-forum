/**
 * podlink app config: where the user's Pod hub lives and how setup is going.
 * The `podlink setup` CLI may also drop a podlink.config.json that the worker
 * serves; the app reads localStorage first, then that file as a hint.
 */

import { setHttpProviderUrl, httpProviderUrl } from "./pod-adapter-http.js";
import { updateIdentityFields, loadIdentity } from "./messaging/identity.js";

const MODE_KEY = "podlink.hubMode";
const SETUP_KEY = "podlink.setupComplete";

export function defaultPodUrl() {
  if (typeof window === "undefined") return "";
  if (window.__TAURI__ || window.__TAURI_INTERNALS__) return "http://127.0.0.1:8787";
  // When the PWA is served by the pod worker (CF or workerd), same-origin is
  // the pod. In `vite dev` this points at the dev server; the user overrides.
  return window.location.origin;
}

/**
 * Normalize a Pod URL to the API origin. The PWA is *served* under `/pod/`, but
 * the Pod API lives at `<origin>/api/pod` and `/api/inbox`. Users often paste
 * the address-bar URL (which ends in `/pod`), so strip a trailing `/pod` and
 * any trailing slashes to keep requests hitting the right place.
 */
export function normalizePodUrl(url) {
  let u = (url || "").trim().replace(/\s+/g, "");
  if (!u) return "";
  u = u.replace(/\/+$/, "");
  u = u.replace(/\/pod$/i, "");
  u = u.replace(/\/+$/, "");
  return u;
}

export function getPodUrl() {
  const id = loadIdentity();
  return httpProviderUrl() || id?.podUrl || "";
}

export function setPodUrl(url) {
  const clean = normalizePodUrl(url);
  setHttpProviderUrl(clean);
  updateIdentityFields({ podUrl: clean });
  return clean;
}

export function getHubMode() {
  return localStorage.getItem(MODE_KEY) || "";
}

export function setHubMode(mode) {
  localStorage.setItem(MODE_KEY, mode);
}

export function isSetupComplete() {
  return localStorage.getItem(SETUP_KEY) === "1";
}

export function markSetupComplete() {
  localStorage.setItem(SETUP_KEY, "1");
}

export async function tryLoadConfigFile() {
  try {
    const base = defaultPodUrl();
    const res = await fetch(`${base}/podlink.config.json`, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
