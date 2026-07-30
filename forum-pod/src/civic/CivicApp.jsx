import React, { useEffect, useState, useCallback } from "react";
import { styles as s, t } from "../ui/theme.js";
import { instance } from "../config/instance.js";
import { bootstrap, foundInstance, registerHandle, listCounties } from "./civic-client.js";
import { civicReady, setCivicReady, loadCivicProfile, saveCivicProfile } from "./civic-store.js";
import GroupView from "./GroupView.jsx";

function Shell({ children, center }) {
  return (
    <div style={{ ...s.app, paddingBottom: 40 }}>
      <div style={center ? { display: "flex", justifyContent: "center", padding: "48px 16px" } : { maxWidth: 680, margin: "0 auto", padding: "16px" }}>
        {children}
      </div>
    </div>
  );
}

function Onboarding({ mode, onDone }) {
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const founding = mode === "found";

  const go = async () => {
    const h = handle.trim();
    if (h.length < 2) { setErr("Pick a handle of at least 2 characters."); return; }
    setBusy(true); setErr("");
    try {
      if (founding) await foundInstance({ handle: h });
      else await registerHandle(h);
      saveCivicProfile({ handle: h });
      setCivicReady(true);
      onDone();
    } catch (e) {
      setErr(e.code === "handle_taken" ? "That handle is taken — try another." : e.message);
    } finally { setBusy(false); }
  };

  return (
    <Shell center>
      <div style={{ width: "100%", maxWidth: 440 }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: -0.5 }}>{instance.name}</div>
          <div style={{ color: t.dim, marginTop: 6, fontSize: 14 }}>{instance.tagline}</div>
        </div>
        <div style={{ ...s.card, display: "grid", gap: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{founding ? "Set up the forum" : "Join the forum"}</div>
          <div style={{ color: t.dim, fontSize: 13 }}>
            {founding
              ? "You're the first here. Choose a handle to found the forum and open it for public signup."
              : "Choose a public handle. No real name, no email, no ID — your handle is how others see you."}
          </div>
          <div>
            <label style={s.label}>Handle</label>
            <input style={s.input} value={handle} placeholder="e.g. PortlandVoter" onChange={(e) => setHandle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
          </div>
          {err && <div style={{ color: t.bad, fontSize: 13 }}>{err}</div>}
          <button style={s.btn("primary")} disabled={busy} onClick={go}>
            {busy ? "Working…" : founding ? "Found the forum" : "Create my handle"}
          </button>
          <div style={{ color: t.faint, fontSize: 11, lineHeight: 1.5 }}>
            No ads, no trackers, no data sales. Community groups are end-to-end encrypted;
            county boards and lobbies are public by design.
          </div>
        </div>
      </div>
    </Shell>
  );
}

function CountyBrowser({ onOpenGroup }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    listCounties().then((r) => setRows(r.rows)).catch((e) => setErr(e.message));
  }, []);
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div>
        <h2 style={{ margin: "0 0 2px", fontSize: 20 }}>County boards</h2>
        <div style={{ color: t.dim, fontSize: 13 }}>Pick your county to join the discussion and start or join lobbies.</div>
      </div>
      {err && <div style={{ ...s.card, color: t.bad }}>{err}</div>}
      {rows == null ? <div style={{ color: t.dim }}>Loading…</div> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
          {rows.map((g) => (
            <button key={g.id} onClick={() => onOpenGroup(g)} style={{ ...s.card, padding: 14, textAlign: "left", cursor: "pointer" }}>
              <div style={{ fontWeight: 700 }}>{g.name}</div>
              <div style={{ color: t.dim, fontSize: 12, marginTop: 2 }}>{g.member_count} members</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CivicApp() {
  const [phase, setPhase] = useState("loading"); // loading | found | signup | app
  const [stack, setStack] = useState([{ name: "home" }]);
  const [err, setErr] = useState("");
  const profile = loadCivicProfile();
  const view = stack[stack.length - 1];
  const openGroup = (g) => setStack((st) => [...st, { name: "group", group: g }]);
  const goBack = () => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st));
  const goHome = () => setStack([{ name: "home" }]);

  const init = useCallback(async () => {
    setPhase("loading"); setErr("");
    try {
      const b = await bootstrap();
      if (!b.founded) setPhase("found");
      else if (b.already_member) setPhase("app");
      else setPhase("signup");
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => { init(); }, [init]);

  if (phase === "loading") {
    return <Shell center><div style={{ color: t.dim }}>{err ? <span style={{ color: t.bad }}>{err}</span> : `Loading ${instance.name}…`}</div></Shell>;
  }
  if (phase === "found") return <Onboarding mode="found" onDone={init} />;
  if (phase === "signup") return <Onboarding mode="signup" onDone={init} />;

  return (
    <div style={s.app}>
      <header style={{ position: "sticky", top: 0, zIndex: 5, background: t.panel, borderBottom: `1px solid ${t.border}`, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={goHome} style={{ background: "none", border: "none", color: t.text, cursor: "pointer", fontWeight: 800, fontSize: 17, padding: 0 }}>
          {instance.shortName || instance.name}
        </button>
        <div style={{ flex: 1 }} />
        {profile?.handle && <div style={{ color: t.dim, fontSize: 13 }}>{profile.handle}</div>}
      </header>
      <main style={{ maxWidth: 680, margin: "0 auto", padding: "16px" }}>
        {view.name === "home" && <CountyBrowser onOpenGroup={openGroup} />}
        {view.name === "group" && (
          <GroupView key={view.group.id} group={view.group} onOpenGroup={openGroup} onBack={goBack} />
        )}
      </main>
    </div>
  );
}
