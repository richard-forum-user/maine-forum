import React, { useEffect, useRef, useState } from "react";
import { styles as s, t } from "../ui/theme.js";
import { listAlbums, createAlbum, getAlbum, uploadPhoto } from "./family-client.js";
import EncryptedImage from "./EncryptedImage.jsx";

export default function Albums() {
  const [albums, setAlbums] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [newTitle, setNewTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function refresh() {
    try {
      setAlbums(await listAlbums());
    } catch (e) {
      setErr(e.message);
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  async function add() {
    if (!newTitle.trim()) return;
    setBusy(true);
    try {
      await createAlbum(newTitle.trim());
      setNewTitle("");
      await refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (openId) return <AlbumView albumId={openId} onBack={() => { setOpenId(null); refresh(); }} />;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ ...s.card, display: "flex", gap: 8 }}>
        <input style={s.input} placeholder="New album name" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
        <button style={s.btn("primary")} onClick={add} disabled={busy}>Create</button>
      </div>
      {err && <div style={{ color: t.bad, fontSize: 13 }}>{err}</div>}

      {albums.length === 0 && (
        <div style={{ ...s.card, textAlign: "center", color: t.dim }}>No albums yet. Create one to share photos.</div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 }}>
        {albums.map((a) => (
          <div key={a.id} onClick={() => setOpenId(a.id)} style={{ ...s.card, padding: 0, overflow: "hidden", cursor: "pointer" }}>
            <div style={{ aspectRatio: "1 / 1", background: t.panel2 }}>
              {a.cover ? (
                <EncryptedImage r2Key={a.cover} epoch={a.cover_epoch} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", color: t.faint, fontSize: 32 }}>
                  {"\uD83D\uDCF7"}
                </div>
              )}
            </div>
            <div style={{ padding: 10 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{a.title}</div>
              <div style={{ color: t.faint, fontSize: 12 }}>{a.n || 0} photos</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AlbumView({ albumId, onBack }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef(null);

  async function refresh() {
    try {
      setData(await getAlbum(albumId));
    } catch (e) {
      setErr(e.message);
    }
  }
  useEffect(() => {
    refresh();
  }, [albumId]);

  async function upload(files) {
    setBusy(true);
    setErr("");
    try {
      for (const f of files) await uploadPhoto({ albumId, file: f });
      await refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button style={s.btn("ghost")} onClick={onBack}>{"\u2190 Back"}</button>
        <div style={{ fontWeight: 700, fontSize: 18, flex: 1 }}>{data?.album?.title || "Album"}</div>
        <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={(e) => upload(Array.from(e.target.files || []))} />
        <button style={s.btn("primary")} onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? "Uploading\u2026" : "Add photos"}
        </button>
      </div>
      {err && <div style={{ color: t.bad, fontSize: 13 }}>{err}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 6 }}>
        {(data?.photos || []).map((p) => (
          <EncryptedImage key={p.id} r2Key={p.r2_key} epoch={p.epoch} alt={p.caption || ""} style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 8, border: `1px solid ${t.border}` }} />
        ))}
      </div>
      {data && data.photos.length === 0 && (
        <div style={{ ...s.card, textAlign: "center", color: t.dim }}>No photos yet. Add some!</div>
      )}
    </div>
  );
}
