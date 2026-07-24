// Captures the browser's install prompt so the app can offer an explicit
// "Install app" button. Chromium fires `beforeinstallprompt` once when the
// PWA is installable; we stash it and let the UI trigger it on demand. iOS
// Safari has no programmatic prompt, so the UI shows manual instructions.

let deferredPrompt = null;
const listeners = new Set();

function notify() {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* ignore listener errors */
    }
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notify();
  });
}

export function subscribe(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function canPrompt() {
  return !!deferredPrompt;
}

export function isStandalone() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

export function isIOS() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iOSDevice = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ reports as Mac; detect touch to disambiguate.
  const iPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return iOSDevice || iPadOS;
}

/**
 * Trigger the native install prompt. Returns "accepted", "dismissed", or
 * "unavailable" (no captured prompt — e.g. iOS or already installed).
 */
export async function promptInstall() {
  if (!deferredPrompt) return "unavailable";
  deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice.catch(() => ({ outcome: "dismissed" }));
  deferredPrompt = null;
  notify();
  return choice?.outcome || "dismissed";
}
