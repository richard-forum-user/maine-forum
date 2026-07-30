// Local, non-authoritative civic-app state. The DO membership is the source of
// truth; this just remembers our pseudonymous handle + that onboarding is done
// so we can skip the signup screen on reload.

const READY = "civic.ready";
const PROFILE = "civic.profile";

export function civicReady() {
  return localStorage.getItem(READY) === "1";
}
export function setCivicReady(v) {
  if (v) localStorage.setItem(READY, "1");
  else localStorage.removeItem(READY);
}
export function loadCivicProfile() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE) || "null");
  } catch {
    return null;
  }
}
export function saveCivicProfile(profile) {
  localStorage.setItem(PROFILE, JSON.stringify(profile || {}));
}
