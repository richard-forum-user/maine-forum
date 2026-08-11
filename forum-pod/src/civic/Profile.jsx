import React, { useEffect, useState, useCallback } from "react";
import { styles as s, t, relTime } from "../ui/theme.js";
import { GROUP_TYPES, MODERATION } from "../config/instance.js";
import { myProfile, getProfile } from "./civic-client.js";

function Section({ title, children, empty }) {
  return (
    <section style={{ ...s.card, display: "grid", gap: 10 }}>
      <h3 style={{ margin: 0, fontFamily: t.display, fontWeight: 700, fontSize: 16 }}>{title}</h3>
      {empty ? <div style={{ color: t.faint, fontSize: 14 }}>{empty}</div> : children}
    </section>
  );
}

export default function Profile({ memberPub, onOpenGroup, onBack }) {
  const [profile, setProfile] = useState(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState("posts");

  const load = useCallback(async () => {
    setErr("");
    try {
      setProfile(memberPub ? await getProfile(memberPub) : await myProfile());
    } catch (e) {
      setErr(e.message);
    }
  }, [memberPub]);

  useEffect(() => { load(); }, [load]);

  if (err) return <div style={{ ...s.card, color: t.bad }}>{err}</div>;
  if (!profile) return <div style={{ color: t.dim }}>Loading profile…</div>;

  const TABS = [
    ["posts", `Posts (${profile.counts.posts})`],
    ["comments", `Comments (${profile.counts.comments})`],
    ["votes", "Agreed / disagreed"],
    ["groups", `Lobbies & boards (${profile.counts.groups})`],
  ];

  return (
    <div className="mf-fade-in" style={{ display: "grid", gap: 16 }}>
      <div>
        {onBack && (
          <button
            onClick={onBack}
            style={{ background: "none", border: "none", color: t.accent, cursor: "pointer", fontSize: 13, padding: 0, fontFamily: "inherit" }}
          >
            ← Back
          </button>
        )}
        <h1 className="mf-brand" style={{ margin: "8px 0 4px", fontSize: "clamp(1.5rem, 4vw, 2rem)" }}>
          {profile.handle || "Member"}
        </h1>
        <div style={{ color: t.dim, fontSize: 13 }}>
          {profile.is_me ? "Your profile" : "Member profile"}
          {profile.joined_at ? ` · joined ${relTime(profile.joined_at)}` : ""}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          <span style={s.pill(t.accent)}>{profile.counts.posts} posts</span>
          <span style={s.pill(t.accent)}>{profile.counts.comments} comments</span>
          <span style={s.pill(t.good)}>{profile.counts.agrees} agrees</span>
          <span style={s.pill(t.bad)}>{profile.counts.disagrees} disagrees</span>
          <span style={s.pill(t.dim)}>{profile.counts.groups} groups</span>
        </div>
      </div>

      <div style={{ ...s.card, fontSize: 13, color: t.dim, lineHeight: 1.5 }}>
        <strong style={{ color: t.text }}>Speech standard:</strong> {MODERATION.summary}
      </div>

      <div style={{ display: "flex", gap: 12, borderBottom: `1px solid ${t.border}`, overflowX: "auto" }}>
        {TABS.map(([id, lbl]) => (
          <button key={id} className={`mf-tab${tab === id ? " mf-tab--active" : ""}`} onClick={() => setTab(id)}>
            {lbl}
          </button>
        ))}
      </div>

      {tab === "posts" && (
        <Section title="Posts" empty={profile.posts.length ? null : "No posts yet."}>
          {profile.posts.map((p) => (
            <button
              key={p.id}
              onClick={() => onOpenGroup?.({ id: p.group_id, name: p.group_name, type: p.group_type })}
              style={{
                display: "block", width: "100%", textAlign: "left", background: "none",
                border: "none", borderBottom: `1px solid ${t.border}`, padding: "12px 0",
                cursor: onOpenGroup ? "pointer" : "default", color: "inherit", fontFamily: "inherit",
              }}
            >
              <div style={{ fontSize: 12, color: t.faint }}>
                {p.group_name} · {relTime(p.created_at)}
                {p.edited_at ? " · edited" : ""}
              </div>
              <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{p.text}</div>
            </button>
          ))}
        </Section>
      )}

      {tab === "comments" && (
        <Section title="Comments" empty={profile.comments.length ? null : "No comments yet."}>
          {profile.comments.map((c) => (
            <div key={c.id} style={{ padding: "12px 0", borderBottom: `1px solid ${t.border}` }}>
              <div style={{ fontSize: 12, color: t.faint }}>
                {c.group_name} · {relTime(c.created_at)}{c.edited_at ? " · edited" : ""}
              </div>
              <div style={{ marginTop: 4 }}>{c.text}</div>
            </div>
          ))}
        </Section>
      )}

      {tab === "votes" && (
        <Section title="Agreed / disagreed" empty={profile.votes.length ? null : "No votes yet."}>
          {profile.votes.map((v, i) => (
            <div key={`${v.item_type}:${v.item_id}:${i}`} style={{ padding: "12px 0", borderBottom: `1px solid ${t.border}` }}>
              <div style={{ fontSize: 12, color: t.faint }}>
                {v.group_name} · {v.vote > 0 ? "agreed" : "disagreed"} · {relTime(v.created_at)}
              </div>
              <div style={{ marginTop: 4 }}>{v.text}</div>
            </div>
          ))}
        </Section>
      )}

      {tab === "groups" && (
        <Section title="Lobbies & boards" empty={profile.groups.length ? null : "Not in any groups yet."}>
          <div style={{ display: "grid", gap: 8 }}>
            {profile.groups.map((g) => (
              <button
                key={g.id}
                onClick={() => onOpenGroup?.(g)}
                style={{
                  ...s.card, padding: 14, textAlign: "left", cursor: "pointer",
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  width: "100%", fontFamily: "inherit", color: "inherit",
                }}
              >
                <div>
                  <div style={{ fontFamily: t.display, fontWeight: 700 }}>{g.name || g.slug || "Group"}</div>
                  <div style={{ color: t.faint, fontSize: 12, marginTop: 2 }}>
                    {GROUP_TYPES[g.type]?.label || g.type} · {g.my_role}
                  </div>
                </div>
                <span style={{ color: t.accent }}>→</span>
              </button>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
