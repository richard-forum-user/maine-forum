/**
 * Android Keystore signing (release APK). Falls back to Web Crypto in browser builds.
 * Full Keystore plugin: see docs/ANDROID-KEYSTORE.md
 */

import { signBundle as webSignBundle } from "./pod-signing.js";

export async function signBundle(payload, sessionHint, aud) {
  return webSignBundle(payload, sessionHint, aud);
}

export function nativeSigningAvailable() {
  return false;
}
