import React, { useState } from "react";
import { styles as s, t } from "../ui/theme.js";
import { createFamily, joinFamily, parseInviteFromLocation } from "./family-client.js";
import { setFamilyReady, saveFamilyProfile } from "./family-store.js";
import InstallAppButton from "./InstallAppButton.jsx";

export default function FamilyWizard({ onDone }) {
  const invite = parseInviteFromLocation();
  const [mode, setMode] = useState(invite ? "join" : "choose");
  const [familyName, setFamilyName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function doCreate() {
    setErr("");
    if (!familyName.trim() || !displayName.trim()) {
      setErr("Please enter a family name and your name.");
      return;
    }
    setBusy(true);
    try {
      const r = await createFamily({ familyName: familyName.trim(), displayName: displayName.trim() });
      saveFamilyProfile({ displayName: displayName.trim(), role: r?.me?.role || "admin" });
      setFamilyReady(true);
      setMode("done");
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function doJoin() {
    setErr("");
    if (!displayName.trim()) {
      setErr("Please enter your name.");
      return;
    }
    if (!invite) {
      setErr("This invite link is invalid or expired. Ask the family admin for a fresh one.");
      return;
    }
    setBusy(true);
    try {
      await joinFamily({ token: invite, displayName: displayName.trim() });
      saveFamilyProfile({ displayName: displayName.trim(), role: "member" });
      setFamilyReady(true);
      setMode("done");
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ ...s.app, display: "flex", justifyContent: "center", padding: "48px 16px" }}>
      <div style={{ width: "100%", maxWidth: 460 }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: -0.5 }}>Family</div>
          <div style={{ color: t.dim, marginTop: 6, fontSize: 14 }}>
            A private space just for your family. Self-hosted, invite-only.
          </div>
        </div>

        {mode === "choose" && (
          <div style={{ ...s.card, display: "grid", gap: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Get started</div>
            <button style={s.btn("primary")} onClick={() => setMode("create")}>
              Create a new family
            </button>
            <button style={s.btn("ghost")} onClick={() => setMode("join")}>
              I have an invite link
            </button>
          </div>
        )}

        {mode === "create" && (
          <div style={{ ...s.card, display: "grid", gap: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Create your family</div>
            <div>
              <label style={s.label}>Family name</label>
              <input style={s.input} value={familyName} placeholder="The Garcias" onChange={(e) => setFamilyName(e.target.value)} />
            </div>
            <div>
              <label style={s.label}>Your name</label>
              <input style={s.input} value={displayName} placeholder="e.g. Mom" onChange={(e) => setDisplayName(e.target.value)} />
            </div>
            {err && <div style={{ color: t.bad, fontSize: 13 }}>{err}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button style={s.btn("ghost")} onClick={() => setMode("choose")} disabled={busy}>Back</button>
              <button style={{ ...s.btn("primary"), flex: 1 }} onClick={doCreate} disabled={busy}>
                {busy ? "Creating\u2026" : "Create family"}
              </button>
            </div>
          </div>
        )}

        {mode === "done" && (
          <div style={{ ...s.card, display: "grid", gap: 14, textAlign: "center" }}>
            <div style={{ fontSize: 40 }}>{"\uD83C\uDF89"}</div>
            <div style={{ fontWeight: 700, fontSize: 18 }}>You're all set, {displayName.trim()}!</div>
            <div style={{ color: t.dim, fontSize: 14 }}>
              Install the app to your home screen so it opens like a normal app and stays handy.
            </div>
            <InstallAppButton block />
            <button style={s.btn("ghost")} onClick={onDone}>Continue to the app</button>
          </div>
        )}

        {mode === "join" && (
          <div style={{ ...s.card, display: "grid", gap: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Join your family</div>
            <div style={{ color: t.dim, fontSize: 13 }}>
              {invite
                ? "You've been invited. Enter your name to join."
                : "Open the invite link your family admin sent you, then enter your name."}
            </div>
            <div>
              <label style={s.label}>Your name</label>
              <input style={s.input} value={displayName} placeholder="e.g. Grandpa" onChange={(e) => setDisplayName(e.target.value)} />
            </div>
            {err && <div style={{ color: t.bad, fontSize: 13 }}>{err}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button style={s.btn("ghost")} onClick={() => setMode("choose")} disabled={busy}>Back</button>
              <button style={{ ...s.btn("primary"), flex: 1 }} onClick={doJoin} disabled={busy || !invite}>
                {busy ? "Joining\u2026" : "Join family"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
