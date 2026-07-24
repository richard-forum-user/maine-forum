/**
 * Plain-language error messages for member-facing UI.
 */

const RECOVERY_ERROR_MAP = {
  invalid_recovery_phrase: "That recovery phrase does not look valid. Check all 12 words and try again.",
  invalid_rebind_token: "Recovery timed out on the server. Start recovery again from the beginning.",
  rebind_token_expired: "Recovery timed out. Start recovery again from the beginning.",
  recovery_not_enrolled: "No recovery phrase is enrolled for this identity. Enroll a phrase in Account & privacy first.",
  invalid_signature: "Recovery verification failed. Check the phrase and try again.",
  missing_fields: "Recovery could not complete. Try again in a moment.",
  hex_string_expected: "Recovery verification failed. Check that you entered all 12 words correctly.",
};

function messageFromUnknown(err) {
  if (err == null) return "Something went wrong. Please try again.";
  if (typeof err === "string") return err;
  if (typeof err?.message === "string" && err.message.trim()) return err.message;
  return "Something went wrong. Please try again.";
}

function mapRecoveryApiMessage(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const [key, friendly] of Object.entries(RECOVERY_ERROR_MAP)) {
    if (lower.includes(key) || lower === key) return friendly;
  }
  if (lower.includes("hex string expected")) {
    return RECOVERY_ERROR_MAP.hex_string_expected;
  }
  if (lower.includes("invalid recovery phrase")) {
    return RECOVERY_ERROR_MAP.invalid_recovery_phrase;
  }
  if (lower.includes("non-json")) {
    return "Could not reach the cooperative service. Check your connection and try again.";
  }
  if (lower.includes("recovery request failed")) {
    return "Recovery could not reach the cooperative. Try again later.";
  }
  return null;
}

/**
 * @param {unknown} err
 * @param {{ context?: "recovery" | "sign-in" | "general" }} [opts]
 */
export function formatUserError(err, opts = {}) {
  const raw = messageFromUnknown(err);
  if (opts.context === "recovery") {
    const mapped = mapRecoveryApiMessage(raw);
    if (mapped) return mapped;
  }
  if (raw.length > 200 && opts.context === "recovery") {
    return "Recovery could not complete. Check your 12-word phrase and try again.";
  }
  return raw;
}
