import React, { useEffect, useState } from "react";
import { styles as s, t } from "../ui/theme.js";
import { canPrompt, isIOS, isStandalone, promptInstall, subscribe } from "../pwa-install.js";

/**
 * "Install app" button. On Chromium it fires the native install prompt; on
 * iOS Safari (no programmatic prompt) it reveals Add-to-Home-Screen steps.
 * Renders nothing if the app is already running as an installed PWA.
 */
export default function InstallAppButton({ block = false }) {
  const [, force] = useState(0);
  const [showIosHelp, setShowIosHelp] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => subscribe(() => force((n) => n + 1)), []);

  if (isStandalone()) return null;

  const ios = isIOS();

  async function onClick() {
    if (ios) {
      setShowIosHelp(true);
      return;
    }
    const outcome = await promptInstall();
    if (outcome === "accepted") setNote("Installing\u2026");
    else if (outcome === "unavailable") setShowIosHelp(true);
    else setNote("You can install anytime from your browser menu.");
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <button style={{ ...s.btn("primary"), ...(block ? { width: "100%" } : {}) }} onClick={onClick}>
        {"\uD83D\uDCF1 Install app"}
      </button>
      {note && <div style={{ color: t.dim, fontSize: 12 }}>{note}</div>}

      {showIosHelp && (
        <div style={{ ...s.card, background: t.panel2, display: "grid", gap: 6, fontSize: 13 }}>
          <div style={{ fontWeight: 700 }}>Add to Home Screen</div>
          {ios ? (
            <ol style={{ margin: 0, paddingLeft: 18, color: t.dim, lineHeight: 1.6 }}>
              <li>Tap the <b>Share</b> button in Safari (the square with an up arrow).</li>
              <li>Scroll and tap <b>Add to Home Screen</b>.</li>
              <li>Tap <b>Add</b>. The Family app icon appears on your home screen.</li>
            </ol>
          ) : (
            <div style={{ color: t.dim }}>
              Open your browser menu and choose <b>Install app</b> or <b>Add to Home screen</b>.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function canOfferInstall() {
  return !isStandalone() && (canPrompt() || isIOS());
}
