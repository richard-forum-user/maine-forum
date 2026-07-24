// Local, non-authoritative family-app state. The DO membership is the source
// of truth; this just remembers who we are and whether onboarding is done so
// we can skip the wizard on reload.

const READY = "podlink.family.ready";
const PROFILE = "podlink.family.profile";

export function familyReady() {
  return localStorage.getItem(READY) === "1";
}
export function setFamilyReady(v) {
  if (v) localStorage.setItem(READY, "1");
  else localStorage.removeItem(READY);
}
export function loadFamilyProfile() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE) || "null");
  } catch {
    return null;
  }
}
export function saveFamilyProfile(profile) {
  localStorage.setItem(PROFILE, JSON.stringify(profile || {}));
}
