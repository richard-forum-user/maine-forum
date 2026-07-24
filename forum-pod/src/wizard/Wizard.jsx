import React, { useState } from "react";
import { t, styles as S } from "../ui/theme.js";
import QrCode from "../ui/QrCode.jsx";
import { generateRecoveryPhrase } from "../recovery-phrase.js";
import {
  createIdentity,
  loadIdentity,
  contactCard,
  encodeInvite,
  updateIdentityFields,
} from "../messaging/identity.js";
import { provisionPod, recoverDevice } from "../messaging/client.js";
import {
  defaultPodUrl,
  setPodUrl,
  setHubMode,
  markSetupComplete,
} from "../podlink-config.js";

const STEPS = ["Welcome", "Your identity", "Your Pod", "Done"];

function StepDots({ step }) {
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
      {STEPS.map((label, i) => (
        <div key={label} style={{ flex: 1, textAlign: "center" }}>
          <div
            style={{
              height: 4,
              borderRadius: 999,
              background: i <= step ? t.accent : t.border,
              marginBottom: 6,
            }}
          />
          <div style={{ fontSize: 11, color: i === step ? t.text : t.faint }}>{label}</div>
        </div>
      ))}
    </div>
  );
}

export default function Wizard({ onDone }) {
  const [step, setStep] = useState(0);
  const [phrase, setPhrase] = useState(() => generateRecoveryPhrase());
  const [savedPhrase, setSavedPhrase] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [podUrl, setPodUrlInput] = useState(() => defaultPodUrl());
  const [hubMode, setHubModeInput] = useState("cloud");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [restorePhrase, setRestorePhrase] = useState("");

  const wrap = { ...S.app, display: "grid", placeItems: "center", padding: 20 };
  const panel = { ...S.card, width: "min(560px, 100%)" };

  function makeIdentity() {
    setError(null);
    try {
      const p = restoring ? restorePhrase.trim().replace(/\s+/g, " ") : phrase;
      if (restoring && p.split(" ").length < 12) {
        setError("Enter your full 12-word recovery phrase.");
        return;
      }
      createIdentity(p, { displayName });
      setStep(2);
    } catch (e) {
      setError(e.message);
    }
  }

  async function connectPod() {
    setError(null);
    setBusy(true);
    try {
      const clean = setPodUrl(podUrl);
      setHubMode(hubMode);
      updateIdentityFields({ podUrl: clean });
      try {
        await provisionPod();
      } catch (e) {
        // Restoring on a new device: this device isn't on the Pod's allowlist
        // yet. Prove the recovery key, enroll this device, then provision.
        if (/device_not_authorized|auth_failed/.test(e.message)) {
          await recoverDevice();
          await provisionPod();
        } else {
          throw e;
        }
      }
      setStep(3);
    } catch (e) {
      setError(`Could not reach your Pod at ${podUrl}. ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    markSetupComplete();
    onDone?.();
  }

  const identity = loadIdentity();
  const invite = identity ? encodeInvite(contactCard(identity)) : "";

  return (
    <div style={wrap}>
      <div style={panel}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.5 }}>podlink</div>
          <span style={S.pill(t.good)}>private</span>
        </div>
        <StepDots step={step} />

        {error && (
          <div style={{ color: t.bad, fontSize: 13, marginBottom: 14, lineHeight: 1.5 }}>{error}</div>
        )}

        {step === 0 && (
          <div>
            <h2 style={{ marginTop: 0 }}>A private line between your devices and people you trust.</h2>
            <p style={{ color: t.dim, lineHeight: 1.6 }}>
              podlink sets up your own personal Pod and an end-to-end encrypted pipeline. Messages
              are sealed on your device and only ever travel as ciphertext — your Pod and the
              network never see what you wrote. There is no company in the middle, no aggregation,
              and no AI.
            </p>
            <ul style={{ color: t.dim, lineHeight: 1.7, fontSize: 14 }}>
              <li>Your identity is a random handle plus keys — no name, email, or phone required.</li>
              <li>You host your Pod yourself (your Cloudflare account or your home machine + tunnel).</li>
              <li>You message people directly, pod to pod.</li>
            </ul>
            <div style={{ marginTop: 20 }}>
              <button style={S.btn("primary")} onClick={() => setStep(1)}>
                Get started
              </button>
            </div>
          </div>
        )}

        {step === 1 && !restoring && (
          <div>
            <h2 style={{ marginTop: 0 }}>Create your identity</h2>
            <p style={{ color: t.dim, lineHeight: 1.6 }}>
              These 12 words are the master key to your identity. Anyone with them can become you,
              and we can&apos;t recover them for you. Write them down and keep them somewhere safe.
            </p>
            <div
              style={{
                ...S.card,
                background: t.panel2,
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 8,
                marginBottom: 12,
              }}
            >
              {phrase.split(" ").map((w, i) => (
                <div key={i} style={{ fontSize: 13 }}>
                  <span style={{ color: t.faint, marginRight: 6 }}>{i + 1}</span>
                  {w}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <button
                style={S.btn("ghost")}
                onClick={() => {
                  setPhrase(generateRecoveryPhrase());
                  setSavedPhrase(false);
                }}
              >
                Regenerate
              </button>
              <button
                style={S.btn("ghost")}
                onClick={() => navigator.clipboard?.writeText(phrase)}
              >
                Copy
              </button>
            </div>

            <label style={S.label}>Display name (optional — shown to contacts you choose)</label>
            <input
              style={{ ...S.input, marginBottom: 14 }}
              value={displayName}
              placeholder="e.g. Sam (or leave blank)"
              onChange={(e) => setDisplayName(e.target.value)}
            />

            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 16 }}>
              <input
                type="checkbox"
                checked={savedPhrase}
                onChange={(e) => setSavedPhrase(e.target.checked)}
              />
              I&apos;ve saved my 12-word recovery phrase.
            </label>

            <div style={{ display: "flex", gap: 8 }}>
              <button style={S.btn("ghost")} onClick={() => setStep(0)}>
                Back
              </button>
              <button style={S.btn("primary", !savedPhrase)} disabled={!savedPhrase} onClick={makeIdentity}>
                Continue
              </button>
            </div>
            <div style={{ marginTop: 14, fontSize: 13, color: t.dim }}>
              Restoring on a new device?{" "}
              <a style={{ color: t.accent, cursor: "pointer" }} onClick={() => setRestoring(true)}>
                Enter your recovery phrase
              </a>
            </div>
          </div>
        )}

        {step === 1 && restoring && (
          <div>
            <h2 style={{ marginTop: 0 }}>Restore your identity</h2>
            <p style={{ color: t.dim, lineHeight: 1.6 }}>
              Enter your 12-word recovery phrase. This re-creates your identity here; when you
              connect your Pod, this device will be re-paired using your recovery key.
            </p>
            <textarea
              style={{ ...S.input, minHeight: 90, resize: "vertical", marginBottom: 14 }}
              value={restorePhrase}
              placeholder="word1 word2 word3 …"
              onChange={(e) => setRestorePhrase(e.target.value)}
            />
            <label style={S.label}>Display name (optional)</label>
            <input
              style={{ ...S.input, marginBottom: 14 }}
              value={displayName}
              placeholder="e.g. Sam (or leave blank)"
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button style={S.btn("ghost")} onClick={() => setRestoring(false)}>
                Back
              </button>
              <button style={S.btn("primary", !restorePhrase.trim())} disabled={!restorePhrase.trim()} onClick={makeIdentity}>
                Restore
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 style={{ marginTop: 0 }}>Connect your Pod</h2>
            <p style={{ color: t.dim, lineHeight: 1.6 }}>
              Your Pod is the hub your devices and contacts reach. Point podlink at it.
            </p>
            <label style={S.label}>Where is your Pod hosted?</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              {[
                ["cloud", "My Cloudflare account"],
                ["home", "My home machine + tunnel"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  style={{
                    ...S.btn(hubMode === id ? "primary" : "ghost"),
                    flex: 1,
                  }}
                  onClick={() => setHubModeInput(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <label style={S.label}>Pod URL</label>
            <input
              style={{ ...S.input, marginBottom: 6 }}
              value={podUrl}
              placeholder="https://podlink-pod.yourname.workers.dev"
              onChange={(e) => setPodUrlInput(e.target.value)}
            />
            <p style={{ color: t.faint, fontSize: 12, lineHeight: 1.5, marginBottom: 16 }}>
              Run <code>podlink setup</code> to create this, or paste the URL it printed. On desktop
              this is detected automatically.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={S.btn("ghost")} onClick={() => setStep(1)}>
                Back
              </button>
              <button style={S.btn("primary", busy)} disabled={busy} onClick={connectPod}>
                {busy ? "Connecting…" : "Connect & provision"}
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h2 style={{ marginTop: 0 }}>You&apos;re set up</h2>
            <p style={{ color: t.dim, lineHeight: 1.6 }}>
              Your Pod is live and your identity is ready. Share your invite so people can message
              you. Your handle is <strong style={{ color: t.text }}>{identity?.handle}</strong>.
            </p>
            <div style={{ display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
              <QrCode value={invite} />
              <div style={{ flex: 1, minWidth: 220 }}>
                <label style={S.label}>Your invite code</label>
                <div style={{ ...S.card, background: t.panel2, ...S.mono, maxHeight: 120, overflow: "auto" }}>
                  {invite}
                </div>
                <button
                  style={{ ...S.btn("ghost"), marginTop: 8 }}
                  onClick={() => navigator.clipboard?.writeText(invite)}
                >
                  Copy invite
                </button>
              </div>
            </div>
            <button style={S.btn("primary")} onClick={finish}>
              Open podlink
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
