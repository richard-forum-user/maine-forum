import React, { useEffect, useState, useCallback } from "react";
import { styles as s, t, relTime } from "../ui/theme.js";
import { GROUP_TYPES, MODERATION } from "../config/instance.js";
import { loadSigningMeta } from "../member-store.js";
import {
  getGroup, joinGroup, listLobbies, createLobby,
  listPosts, createPost, editPost, listComments, createComment, editComment, vote, hideItem,
} from "./civic-client.js";
import OpinionMap from "./OpinionMap.jsx";

function myPub() {
  return loadSigningMeta()?.publicKeyHex || null;
}

function VoteBar({ gid, itemType, itemId, likes, dislikes, myVote, onChanged }) {
  const [busy, setBusy] = useState(false);
  const cast = async (v) => {
    setBusy(true);
    try { await vote(gid, itemType, itemId, myVote === v ? 0 : v); await onChanged(); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <button
        className={`mf-vote mf-vote--up${myVote === 1 ? " mf-vote--on" : ""}`}
        disabled={busy}
        onClick={() => cast(1)}
        aria-pressed={myVote === 1}
        aria-label={myVote === 1 ? "Agree (your stance)" : "Agree"}
      >
        Agree
      </button>
      <button
        className={`mf-vote mf-vote--down${myVote === -1 ? " mf-vote--on" : ""}`}
        disabled={busy}
        onClick={() => cast(-1)}
        aria-pressed={myVote === -1}
        aria-label={myVote === -1 ? "Disagree (your stance)" : "Disagree"}
      >
        Disagree
      </button>
    </div>
  );
}

function HideMenu({ gid, itemType, itemId, canModerate, onDone }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!canModerate) return null;
  const run = async (reason) => {
    setBusy(true);
    try { await hideItem(gid, itemType, itemId, reason); setOpen(false); await onDone(); }
    catch (e) { alert(e.message); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ position: "relative" }}>
      <button
        style={{ background: "none", border: "none", color: t.faint, cursor: "pointer", fontSize: 12, fontFamily: "inherit", padding: 0 }}
        onClick={() => setOpen((o) => !o)}
      >
        Hide (illegal only)…
      </button>
      {open && (
        <div style={{ ...s.card, position: "absolute", zIndex: 4, right: 0, top: "100%", marginTop: 4, minWidth: 240, padding: 10, display: "grid", gap: 6 }}>
          <div style={{ fontSize: 11, color: t.dim, lineHeight: 1.4 }}>{MODERATION.summary}</div>
          {MODERATION.hideReasons.map((r) => (
            <button key={r.id} style={{ ...s.btn("ghost"), padding: "6px 10px", fontSize: 12 }} disabled={busy} onClick={() => run(r.id)}>
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EditableBody({ text, editedAt, canEdit, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(text); }, [text]);
  const save = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try { await onSave(draft.trim()); setEditing(false); }
    finally { setBusy(false); }
  };
  if (editing) {
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <textarea
          style={{ ...s.input, minHeight: 72, resize: "vertical", fontFamily: "inherit" }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button style={s.btn("ghost")} disabled={busy} onClick={() => { setEditing(false); setDraft(text); }}>Cancel</button>
          <button style={s.btn("primary")} disabled={busy || !draft.trim()} onClick={save}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    );
  }
  return (
    <div>
      <div style={{ fontSize: 16, whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{text}</div>
      <div style={{ display: "flex", gap: 12, marginTop: 6, alignItems: "center" }}>
        {editedAt && <span style={{ fontSize: 11, color: t.faint }}>edited</span>}
        {canEdit && (
          <button
            style={{ background: "none", border: "none", color: t.accent, cursor: "pointer", fontSize: 12, fontFamily: "inherit", padding: 0 }}
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        )}
      </div>
    </div>
  );
}

function Comments({ gid, postId, canPost, canModerate, me }) {
  const [rows, setRows] = useState(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { setRows((await listComments(gid, postId)).rows); }, [gid, postId]);
  useEffect(() => { load(); }, [load]);
  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try { await createComment(gid, postId, text.trim()); setText(""); await load(); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ marginTop: 12, paddingLeft: 14, borderLeft: `2px solid ${t.border}`, display: "grid", gap: 10 }}>
      {rows == null ? <div style={{ color: t.faint, fontSize: 13 }}>Loading…</div> :
        rows.length === 0 ? <div style={{ color: t.faint, fontSize: 13 }}>No replies yet.</div> :
          rows.map((c) => (
            <div key={c.id}>
              <div style={{ fontSize: 12, color: t.faint }}>{c.handle || "member"} · {relTime(c.created_at)}</div>
              <div style={{ marginTop: 2, fontSize: 14 }}>
                <EditableBody
                  text={c.text}
                  editedAt={c.edited_at}
                  canEdit={me && c.author_pub === me}
                  onSave={async (next) => { await editComment(gid, postId, c.id, next); await load(); }}
                />
              </div>
              <div style={{ marginTop: 6, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <VoteBar gid={gid} itemType="comment" itemId={c.id} likes={c.likes} dislikes={c.dislikes} myVote={c.my_vote} onChanged={load} />
                <HideMenu gid={gid} itemType="comment" itemId={c.id} canModerate={canModerate} onDone={load} />
              </div>
            </div>
          ))}
      {canPost && (
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ ...s.input, flex: 1 }} placeholder="Reply…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
          <button style={s.btn("ghost")} disabled={busy || !text.trim()} onClick={submit}>Reply</button>
        </div>
      )}
    </div>
  );
}

function Feed({ group }) {
  const [rows, setRows] = useState(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [openComments, setOpenComments] = useState({});
  const canPost = !!group.my_role;
  const canModerate = group.my_role === "steward" || group.my_role === "moderator";
  const me = myPub();

  const load = useCallback(async () => { setRows((await listPosts(group.id)).rows); }, [group.id]);
  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try { await createPost(group.id, text.trim()); setText(""); await load(); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {canPost ? (
        <div style={{ ...s.card, display: "grid", gap: 10 }}>
          <textarea
            style={{ ...s.input, minHeight: 88, resize: "vertical", fontFamily: "inherit" }}
            placeholder="Share a position. Others will agree or disagree — that shapes the opinion map."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button style={s.btn("primary")} disabled={busy || !text.trim()} onClick={submit}>
              {busy ? "Posting…" : "Post"}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ ...s.card, color: t.dim, fontSize: 14 }}>Join this group to post and vote.</div>
      )}

      {rows == null ? <div style={{ color: t.dim }}>Loading…</div> :
        rows.length === 0 ? <div style={{ ...s.card, color: t.faint }}>No posts yet. Start the conversation.</div> :
          rows.map((p) => (
            <article key={p.id} style={s.card} className="mf-fade-in">
              <div style={{ fontSize: 12, color: t.faint, marginBottom: 6 }}>{p.handle || "member"} · {relTime(p.created_at)}</div>
              <EditableBody
                text={p.text}
                editedAt={p.edited_at}
                canEdit={me && p.author_pub === me}
                onSave={async (next) => { await editPost(group.id, p.id, next); await load(); }}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginTop: 10 }}>
                <VoteBar gid={group.id} itemType="post" itemId={p.id} likes={p.likes} dislikes={p.dislikes} myVote={p.my_vote} onChanged={load} />
                <button
                  style={{ background: "none", border: "none", color: t.dim, cursor: "pointer", fontSize: 13, fontFamily: "inherit", padding: 0 }}
                  onClick={() => setOpenComments((o) => ({ ...o, [p.id]: !o[p.id] }))}
                >
                  {p.comment_count} {p.comment_count === 1 ? "reply" : "replies"}
                  {openComments[p.id] ? " · hide" : ""}
                </button>
                <HideMenu gid={group.id} itemType="post" itemId={p.id} canModerate={canModerate} onDone={load} />
              </div>
              {openComments[p.id] && (
                <Comments gid={group.id} postId={p.id} canPost={canPost} canModerate={canModerate} me={me} />
              )}
            </article>
          ))}
    </div>
  );
}

function Lobbies({ county, onOpenGroup }) {
  const [rows, setRows] = useState(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const canCreate = !!county.my_role;

  const load = useCallback(async () => { setRows((await listLobbies(county.id)).rows); }, [county.id]);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true); setErr("");
    try {
      const r = await createLobby({ name: name.trim(), parentId: county.id });
      setName("");
      await load();
      onOpenGroup(r.group);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...s.card, display: "grid", gap: 10 }}>
        <div style={{ fontFamily: t.display, fontWeight: 700, fontSize: 17 }}>Start a lobby</div>
        <div style={{ color: t.dim, fontSize: 14 }}>
          A civilian lobby for a specific issue in {county.name}. Deliberate, find common ground, then act.
        </div>
        {canCreate ? (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                style={{ ...s.input, flex: 1, minWidth: 180 }}
                placeholder="e.g. Ranked-choice voting"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && create()}
              />
              <button style={s.btn("primary")} disabled={busy || !name.trim()} onClick={create}>
                {busy ? "Creating…" : "Create"}
              </button>
            </div>
            {err && <div style={{ color: t.bad, fontSize: 13 }}>{err}</div>}
          </>
        ) : (
          <div style={{ color: t.faint, fontSize: 13 }}>Join this county board to start a lobby.</div>
        )}
      </div>

      {rows == null ? <div style={{ color: t.dim }}>Loading…</div> :
        rows.length === 0 ? <div style={{ ...s.card, color: t.faint }}>No lobbies yet in {county.name}.</div> :
          rows.map((g) => (
            <button
              key={g.id}
              onClick={() => onOpenGroup(g)}
              style={{
                ...s.card,
                textAlign: "left",
                cursor: "pointer",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                width: "100%",
                fontFamily: "inherit",
                color: "inherit",
              }}
            >
              <div>
                <div style={{ fontFamily: t.display, fontWeight: 700 }}>{g.name}</div>
                <div style={{ color: t.faint, fontSize: 12, marginTop: 2 }}>{g.member_count} members</div>
              </div>
              <span style={{ color: t.accent, fontSize: 18 }} aria-hidden>→</span>
            </button>
          ))}
    </div>
  );
}

export default function GroupView({ group: initial, onOpenGroup, onBack }) {
  const [group, setGroup] = useState(initial);
  const isCounty = group.type === "county";
  const [tab, setTab] = useState(isCounty ? "lobbies" : "discussion");
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    setGroup(initial);
    setTab(initial.type === "county" ? "lobbies" : "discussion");
    getGroup(initial.id).then((r) => setGroup(r.group)).catch(() => {});
  }, [initial]);

  const refreshGroup = useCallback(async () => {
    setGroup((await getGroup(group.id)).group);
  }, [group.id]);

  const join = async () => {
    setJoining(true);
    try { await joinGroup(group.id); await refreshGroup(); }
    finally { setJoining(false); }
  };

  const label = GROUP_TYPES[group.type]?.label || group.type;
  const TABS = isCounty
    ? [["lobbies", "Lobbies"], ["discussion", "Discussion"], ["map", "Opinion map"]]
    : [["discussion", "Discussion"], ["map", "Opinion map"]];

  return (
    <div className="mf-fade-in" style={{ display: "grid", gap: 16 }}>
      <div>
        <button
          onClick={onBack}
          style={{ background: "none", border: "none", color: t.accent, cursor: "pointer", fontSize: 13, padding: 0, fontFamily: "inherit" }}
        >
          ← Back
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
          <h2 className="mf-brand" style={{ margin: 0, fontSize: "clamp(1.4rem, 4vw, 1.85rem)" }}>{group.name}</h2>
          <span style={s.pill(t.accent)}>{label}</span>
        </div>
        <div style={{ color: t.dim, fontSize: 13, marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span>{group.member_count} members · {group.visibility === "public_read" ? "public" : group.visibility}</span>
          {!group.my_role && (
            <button onClick={join} disabled={joining} style={{ ...s.btn("primary"), padding: "6px 14px", fontSize: 13 }}>
              {joining ? "Joining…" : "Join"}
            </button>
          )}
          {group.my_role && <span style={s.pill(t.good)}>{group.my_role}</span>}
        </div>
      </div>

      <div style={{ display: "flex", gap: 14, borderBottom: `1px solid ${t.border}` }}>
        {TABS.map(([id, lbl]) => (
          <button
            key={id}
            className={`mf-tab${tab === id ? " mf-tab--active" : ""}`}
            onClick={() => setTab(id)}
          >
            {lbl}
          </button>
        ))}
      </div>

      {tab === "lobbies" && isCounty && <Lobbies county={group} onOpenGroup={onOpenGroup} />}
      {tab === "discussion" && <Feed group={group} />}
      {tab === "map" && <OpinionMap groupId={group.id} />}
    </div>
  );
}
