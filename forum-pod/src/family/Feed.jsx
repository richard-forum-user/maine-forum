import React, { useEffect, useRef, useState } from "react";
import { styles as s, t, relTime } from "../ui/theme.js";
import {
  listPosts,
  createPost,
  getPost,
  addComment,
  reactToPost,
  deletePost,
  uploadPhoto,
  createAlbum,
} from "./family-client.js";
import EncryptedImage from "./EncryptedImage.jsx";

export default function Feed({ me, names = {} }) {
  const [posts, setPosts] = useState([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [pendingFiles, setPendingFiles] = useState([]);
  const [openId, setOpenId] = useState(null);
  const fileRef = useRef(null);

  async function refresh() {
    try {
      setPosts(await listPosts());
    } catch (e) {
      setErr(e.message);
    }
  }
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15000);
    return () => clearInterval(id);
  }, []);

  async function post() {
    if (!body.trim() && pendingFiles.length === 0) return;
    setBusy(true);
    setErr("");
    try {
      let media = [];
      if (pendingFiles.length) {
        // Attach photos to a lightweight per-post album so they also show up
        // in the Albums tab.
        const album = await createAlbum(`Post \u00b7 ${new Date().toLocaleDateString()}`);
        for (const f of pendingFiles) {
          const { r2_key } = await uploadPhoto({ albumId: album.id, file: f });
          media.push({ r2_key, type: f.type });
        }
      }
      await createPost({ body: body.trim(), media });
      setBody("");
      setPendingFiles([]);
      await refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ ...s.card, display: "grid", gap: 10 }}>
        <textarea
          style={{ ...s.input, minHeight: 70, resize: "vertical", fontFamily: "inherit" }}
          placeholder={`Share something with the family, ${names[me?.member_pub] || ""}\u2026`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {pendingFiles.length > 0 && (
          <div style={{ fontSize: 12, color: t.dim }}>{pendingFiles.length} photo(s) attached</div>
        )}
        {err && <div style={{ color: t.bad, fontSize: 13 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => setPendingFiles(Array.from(e.target.files || []))}
          />
          <button style={s.btn("secondary")} onClick={() => fileRef.current?.click()} disabled={busy}>
            Add photos
          </button>
          <div style={{ flex: 1 }} />
          <button style={s.btn("primary")} onClick={post} disabled={busy}>
            {busy ? "Posting\u2026" : "Post"}
          </button>
        </div>
      </div>

      {posts.length === 0 && (
        <div style={{ ...s.card, textAlign: "center", color: t.dim }}>
          No posts yet. Say hello to your family!
        </div>
      )}

      {posts.map((p) => (
        <PostCard
          key={p.id}
          post={p}
          me={me}
          names={names}
          open={openId === p.id}
          onToggleOpen={() => setOpenId(openId === p.id ? null : p.id)}
          onChanged={refresh}
        />
      ))}
    </div>
  );
}

function PostCard({ post, me, names = {}, open, onToggleOpen, onChanged }) {
  const authorName = names[post.author_pub] || "Member";
  const [detail, setDetail] = useState(null);
  const [comment, setComment] = useState("");
  const liked = (post.my_reactions || []).includes("\u2764\ufe0f");
  const likeCount = (post.reactions || []).find((r) => r.emoji === "\u2764\ufe0f")?.n || 0;

  useEffect(() => {
    if (open) getPost(post.id).then(setDetail).catch(() => {});
  }, [open, post.id]);

  async function like() {
    await reactToPost(post.id, "\u2764\ufe0f");
    onChanged();
  }
  async function sendComment() {
    if (!comment.trim()) return;
    await addComment(post.id, comment.trim());
    setComment("");
    getPost(post.id).then(setDetail);
    onChanged();
  }
  async function remove() {
    if (!confirm("Delete this post?")) return;
    await deletePost(post.id);
    onChanged();
  }

  return (
    <div style={{ ...s.card, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={avatarStyle(authorName)}>{initials(authorName)}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700 }}>{authorName}</div>
          <div style={{ fontSize: 12, color: t.faint }}>{relTime(post.created_at)}</div>
        </div>
        {(post.author_pub === me?.member_pub || me?.role === "admin") && (
          <button style={{ ...s.btn("ghost"), padding: "4px 10px", fontSize: 12 }} onClick={remove}>
            Delete
          </button>
        )}
      </div>

      {post.locked ? (
        <div style={{ color: t.faint, fontStyle: "italic" }}>{"\uD83D\uDD12 Encrypted \u2014 you don't have the key for this post."}</div>
      ) : (
        post.body && <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{post.body}</div>
      )}

      {post.media && post.media.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: post.media.length > 1 ? "1fr 1fr" : "1fr", gap: 6 }}>
          {post.media.map((m, i) => (
            <EncryptedImage
              key={i}
              r2Key={m.r2_key}
              epoch={post.epoch}
              style={{ width: "100%", borderRadius: 8, border: `1px solid ${t.border}`, objectFit: "cover", maxHeight: 320, aspectRatio: "4 / 3" }}
            />
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 16, alignItems: "center", color: t.dim, fontSize: 13 }}>
        <button
          onClick={like}
          style={{ background: "none", border: "none", cursor: "pointer", color: liked ? t.bad : t.dim, fontSize: 14 }}
        >
          {liked ? "\u2764\ufe0f" : "\u2661"} {likeCount > 0 ? likeCount : ""} Like
        </button>
        <button
          onClick={onToggleOpen}
          style={{ background: "none", border: "none", cursor: "pointer", color: t.dim, fontSize: 14 }}
        >
          {"\uD83D\uDCAC"} {post.comment_count > 0 ? post.comment_count : ""} Comment
        </button>
      </div>

      {open && (
        <div style={{ display: "grid", gap: 8, borderTop: `1px solid ${t.border}`, paddingTop: 10 }}>
          {(detail?.comments || []).map((c) => {
            const cName = names[c.author_pub] || "Member";
            return (
              <div key={c.id} style={{ display: "flex", gap: 8 }}>
                <div style={{ ...avatarStyle(cName), width: 28, height: 28, fontSize: 11 }}>{initials(cName)}</div>
                <div style={{ background: t.panel2, borderRadius: 8, padding: "6px 10px", flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>{cName}</div>
                  <div style={{ fontSize: 14 }}>{c.body}</div>
                </div>
              </div>
            );
          })}
          <div style={{ display: "flex", gap: 8 }}>
            <input
              style={s.input}
              placeholder="Write a comment\u2026"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendComment()}
            />
            <button style={s.btn("primary")} onClick={sendComment}>Send</button>
          </div>
        </div>
      )}
    </div>
  );
}

function initials(name) {
  return (name || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}
function avatarStyle(name) {
  const colors = ["#4ea1ff", "#3fb950", "#d29922", "#f85149", "#a371f7", "#db61a2"];
  let h = 0;
  for (const ch of name || "") h = (h * 31 + ch.charCodeAt(0)) % colors.length;
  return {
    width: 38,
    height: 38,
    borderRadius: "50%",
    background: colors[h],
    color: "#04121f",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 800,
    fontSize: 14,
    flexShrink: 0,
  };
}
