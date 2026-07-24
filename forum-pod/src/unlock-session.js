/**
 * In-memory unlock token from server-verified WebAuthn (never persisted).
 */

import { loadMemberProfile } from "./member-store.js";

let cachedUnlockToken = null;
let cachedCredentialId = null;
let cachedPilotUnlock = false;

export function getUnlockToken() {
  if (!cachedUnlockToken) return null;
  if (Date.now() > cachedUnlockToken.expiresAtMs) {
    clearUnlockToken();
    return null;
  }
  return cachedUnlockToken;
}

export function setUnlockToken(token, credentialId) {
  cachedUnlockToken = token;
  cachedCredentialId = credentialId || token?.credentialId || null;
  cachedPilotUnlock = false;
}

export function setPilotUnlock(credentialId) {
  cachedUnlockToken = null;
  cachedCredentialId = credentialId || null;
  cachedPilotUnlock = true;
}

export function clearUnlockToken() {
  cachedUnlockToken = null;
  cachedCredentialId = null;
  cachedPilotUnlock = false;
}

export function getUnlockCredentialId() {
  return cachedCredentialId;
}

function pilotUnlockIsValidForProfile() {
  const profile = loadMemberProfile();
  if (!profile?.credential_id) return false;
  const mode = String(profile.auth_mode || "");
  const cred = String(profile.credential_id || "");
  if (mode.startsWith("local-") || mode.startsWith("pilot")) return true;
  if (cred.startsWith("local-") || cred.startsWith("pilot")) return true;
  if (import.meta.env.VITE_WEBAPP_LOCAL_FIRST === "1") return true;
  return false;
}

export function hasActiveUnlock() {
  if (getUnlockToken()) return true;
  return cachedPilotUnlock && pilotUnlockIsValidForProfile();
}
