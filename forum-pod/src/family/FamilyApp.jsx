import React, { useEffect, useState, useCallback } from "react";
import { styles as s, t } from "../ui/theme.js";
import { getFamily, memberNameMap, hasKey } from "./family-client.js";
import { familyReady, setFamilyReady } from "./family-store.js";
import FamilyWizard from "./FamilyWizard.jsx";
import Feed from "./Feed.jsx";
import Calendar from "./Calendar.jsx";
import Albums from "./Albums.jsx";
import Members from "./Members.jsx";
import InstallAppButton from "./InstallAppButton.jsx";

const TABS = [
  { id: "feed", label: "Feed", icon: "\uD83C\uDFE0" },
  { id: "albums", label: "Photos", icon: "\uD83D\uDCF7" },
  { id: "calendar", label: "Calendar", icon: "\uD83D\uDCC5" },
  { id: "members", label: "Family", icon: "\uD83D\uDC65" },
];

export default function FamilyApp() {
  const [ready, setReady] = useState(familyReady());
  const [tab, setTab] = useState("feed");
  const [family, setFamily] = useState(null);
  const [familyName, setFamilyName] = useState("");
  const [me, setMe] = useState(null);
  const [names, setNames] = useState({});
  const [loadErr, setLoadErr] = useState("");

  const loadFamily = useCallback(async () => {
    try {
      const r = await getFamily();
      setFamily(r.family);
      setFamilyName(r.familyName || "");
      setMe(r.me);
      setFamilyReady(true);
      if (r.me?.status === "active") {
        memberNameMap().then(setNames).catch(() => {});
      }
    } catch (e) {
      if (/family_not_created|not_a_member/.test(e.message)) {
        setFamilyReady(false);
        setReady(false);
      } else {
        setLoadErr(e.message);
      }
    }
  }, []);

  useEffect(() => {
    if (ready) loadFamily();
  }, [ready, loadFamily]);

  if (!ready) return <FamilyWizard onDone={() => setReady(true)} />;

  // Joined but not yet admitted by an admin.
  if (me && me.status === "pending") {
    return <WaitingScreen onRefresh={loadFamily} />;
  }

  return (
    <div style={{ ...s.app, paddingBottom: 72 }}>
      <header style={{ position: "sticky", top: 0, zIndex: 5, background: t.panel, borderBottom: `1px solid ${t.border}`, padding: "14px 16px", display: "flex", alignItems: "center" }}>
        <div style={{ fontWeight: 800, fontSize: 18, flex: 1 }}>{familyName || "Family"}</div>
        {me && <div style={{ color: t.dim, fontSize: 13 }}>{names[me.member_pub] || "You"}</div>}
      </header>

      <main style={{ maxWidth: 620, margin: "0 auto", padding: "16px" }}>
        {loadErr && <div style={{ ...s.card, color: t.bad, marginBottom: 12 }}>{loadErr}</div>}
        {me && me.status === "active" && !hasKey() && (
          <div style={{ ...s.card, color: t.warn, marginBottom: 12 }}>
            Syncing your encryption key\u2026 if this persists, ask an admin to re-admit this device.
          </div>
        )}
        {tab === "feed" && <Feed me={me} names={names} />}
        {tab === "albums" && <Albums />}
        {tab === "calendar" && <Calendar me={me} names={names} />}
        {tab === "members" && <Members me={me} names={names} onChanged={loadFamily} />}
      </main>

      <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: t.panel, borderTop: `1px solid ${t.border}`, display: "flex", justifyContent: "space-around", padding: "8px 0" }}>
        {TABS.map((tb) => (
          <button key={tb.id} onClick={() => setTab(tb.id)} style={{ background: "none", border: "none", cursor: "pointer", color: tab === tb.id ? t.accent : t.dim, display: "grid", justifyItems: "center", gap: 2, fontSize: 11, fontWeight: 600, padding: "2px 12px" }}>
            <span style={{ fontSize: 20 }}>{tb.icon}</span>
            {tb.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function WaitingScreen({ onRefresh }) {
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ ...s.app, display: "flex", justifyContent: "center", padding: "48px 16px" }}>
      <div style={{ width: "100%", maxWidth: 440 }}>
        <div style={{ ...s.card, textAlign: "center", display: "grid", gap: 14 }}>
          <div style={{ fontSize: 40 }}>{"\u23F3"}</div>
          <div style={{ fontWeight: 700, fontSize: 18 }}>Almost in!</div>
          <div style={{ color: t.dim, fontSize: 14 }}>
            A family admin needs to approve you. They'll see your request and let you in \u2014 then this
            unlocks automatically. Nothing is visible to you until you're admitted.
          </div>
          <button
            style={s.btn("primary")}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onRefresh();
              setBusy(false);
            }}
          >
            {busy ? "Checking\u2026" : "Check again"}
          </button>
          <InstallAppButton block />
        </div>
      </div>
    </div>
  );
}
