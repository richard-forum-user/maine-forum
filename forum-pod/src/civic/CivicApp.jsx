import React, { useEffect, useState, useCallback } from "react";
import { styles as s, t } from "../ui/theme.js";
import { instance, MODERATION } from "../config/instance.js";
import { bootstrap, foundInstance, registerHandle, listCounties } from "./civic-client.js";
import { loadCivicProfile, saveCivicProfile, setCivicReady } from "./civic-store.js";
import GroupView from "./GroupView.jsx";
import Profile from "./Profile.jsx";

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
    <div className="mf-hero">
      <div className="mf-hero__inner">
        <p className="mf-brand mf-fade-up" style={{ fontSize: "clamp(2.4rem, 8vw, 3.4rem)", marginBottom: 10 }}>
          {instance.name}
        </p>
        <p className="mf-fade-up mf-delay-1" style={{ color: t.dim, fontSize: 17, margin: "0 0 28px", maxWidth: 36 * 16 }}>
          {instance.tagline}
        </p>

        <div className="mf-fade-up mf-delay-2" style={{ display: "grid", gap: 14 }}>
          <div>
            <label style={s.label} htmlFor="mf-handle">
              {founding ? "Your founding handle" : "Choose a public handle"}
            </label>
            <input
              id="mf-handle"
              style={s.input}
              value={handle}
              autoFocus
              autoComplete="username"
              placeholder="e.g. PortlandVoter"
              onChange={(e) => setHandle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && go()}
            />
            <div style={{ color: t.faint, fontSize: 13, marginTop: 8, lineHeight: 1.45 }}>
              {founding
                ? "You're first. This opens public signup and seeds Maine's 16 county boards."
                : "No real name, email, or ID. Your handle is how others see you."}
            </div>
          </div>
          {err && <div style={{ color: t.bad, fontSize: 14 }}>{err}</div>}
          <button style={s.btn("primary", busy)} disabled={busy} onClick={go}>
            {busy ? "Working…" : founding ? "Found the forum" : "Join Maine Forum"}
          </button>
          <p style={{ color: t.faint, fontSize: 12, lineHeight: 1.5, margin: 0 }}>
            No ads · no trackers · member data never sold. {MODERATION.summary}
          </p>
        </div>
      </div>
    </div>
  );
}

function CountyBrowser({ onOpenGroup }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    listCounties().then((r) => setRows(r.rows)).catch((e) => setErr(e.message));
  }, []);

  const filtered = (rows || []).filter((g) =>
    !q.trim() || g.name.toLowerCase().includes(q.trim().toLowerCase())
  );

  return (
    <div className="mf-fade-in" style={{ display: "grid", gap: 18 }}>
      <div>
        <h1 className="mf-brand" style={{ margin: "0 0 6px", fontSize: "clamp(1.6rem, 4vw, 2rem)" }}>
          County boards
        </h1>
        <p style={{ color: t.dim, fontSize: 15, margin: 0 }}>
          Pick your county to join the discussion and start or join lobbies.
        </p>
      </div>

      <input
        style={s.input}
        value={q}
        placeholder="Filter counties…"
        aria-label="Filter counties"
        onChange={(e) => setQ(e.target.value)}
      />

      {err && <div style={{ ...s.card, color: t.bad }}>{err}</div>}
      {rows == null ? (
        <div style={{ color: t.dim }}>Loading counties…</div>
      ) : (
        <div className="mf-county-grid">
          {filtered.map((g, i) => (
            <button
              key={g.id}
              className="mf-county-tile mf-fade-up"
              style={{ animationDelay: `${Math.min(i, 12) * 0.03}s` }}
              onClick={() => onOpenGroup(g)}
            >
              <div style={{ fontFamily: t.display, fontWeight: 700, fontSize: 16 }}>{g.name}</div>
              <div style={{ color: t.faint, fontSize: 12, marginTop: 4 }}>
                {g.member_count} {g.member_count === 1 ? "member" : "members"}
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <div style={{ color: t.faint, gridColumn: "1 / -1" }}>No counties match “{q}”.</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CivicApp() {
  const [phase, setPhase] = useState("loading");
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
    return (
      <div className="mf-hero">
        <div className="mf-hero__inner mf-fade-in" style={{ textAlign: "center" }}>
          <div className="mf-brand" style={{ fontSize: 28, marginBottom: 8 }}>{instance.name}</div>
          <div style={{ color: err ? t.bad : t.dim }}>{err || "Loading…"}</div>
        </div>
      </div>
    );
  }
  if (phase === "found") return <Onboarding mode="found" onDone={init} />;
  if (phase === "signup") return <Onboarding mode="signup" onDone={init} />;

  return (
    <div style={s.app}>
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          backdropFilter: "blur(12px)",
          background: "color-mix(in srgb, var(--forum-bg-elevated) 88%, transparent)",
          borderBottom: `1px solid ${t.border}`,
          padding: "12px 16px",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <button
          onClick={goHome}
          style={{
            background: "none",
            border: "none",
            color: t.text,
            cursor: "pointer",
            fontFamily: t.display,
            fontWeight: 800,
            fontSize: 18,
            letterSpacing: "-0.03em",
            padding: 0,
          }}
        >
          {instance.shortName || instance.name}
        </button>
        <div style={{ flex: 1 }} />
        {profile?.handle && (
          <button
            onClick={() => setStack((st) => [...st, { name: "profile" }])}
            style={{
              background: "none", border: "none", color: t.dim, cursor: "pointer",
              fontSize: 13, fontWeight: 500, fontFamily: "inherit", padding: 0,
            }}
          >
            {profile.handle}
          </button>
        )}
      </header>
      <main style={{ maxWidth: 720, margin: "0 auto", padding: "20px 16px 48px" }}>
        {view.name === "home" && <CountyBrowser onOpenGroup={openGroup} />}
        {view.name === "group" && (
          <GroupView key={view.group.id} group={view.group} onOpenGroup={openGroup} onBack={goBack} />
        )}
        {view.name === "profile" && (
          <Profile
            onOpenGroup={(g) => setStack((st) => [...st, { name: "group", group: g }])}
            onBack={goBack}
          />
        )}
      </main>
    </div>
  );
}
