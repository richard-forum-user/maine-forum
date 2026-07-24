import React, { useEffect, useState } from "react";
import { styles as s, t, relTime } from "../ui/theme.js";
import {
  listMembers,
  listRequests,
  admitMember,
  denyMember,
  removeMember,
  makeInvite,
  inviteLink,
} from "./family-client.js";

export default function Members({ me, onChanged }) {
  const [members, setMembers] = useState([]);
  const [requests, setRequests] = useState([]);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");

  const isAdmin = me?.role === "admin";

  async function refresh() {
    try {
      setMembers(await listMembers());
      if (isAdmin) setRequests(await listRequests());
    } catch (e) {
      setErr(e.message);
    }
  }
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 12000);
    return () => clearInterval(id);
  }, []);

  async function invite() {
    setBusy(true);
    setErr("");
    try {
      setLink(inviteLink(await makeInvite()));
      setCopied(false);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      /* clipboard blocked; select manually */
    }
  }

  async function admit(req) {
    setErr("");
    try {
      await admitMember({ member_pub: req.member_pub, x_pub: req.x_pub, name: req.name || "Member" });
      await refresh();
      onChanged?.();
    } catch (e) {
      setErr(e.message);
    }
  }
  async function deny(req) {
    await denyMember(req.member_pub);
    await refresh();
  }
  async function remove(m) {
    if (!confirm(`Remove ${m.name || "this member"}? This rotates the family key so they lose future access.`)) return;
    setBusy(true);
    try {
      await removeMember(m.member_pub);
      await refresh();
      onChanged?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {isAdmin && requests.length > 0 && (
        <div style={{ ...s.card, display: "grid", gap: 10, borderColor: t.accent }}>
          <div style={{ fontWeight: 700 }}>Requests to join ({requests.length})</div>
          {requests.map((r) => (
            <div key={r.member_pub} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={avatarStyle(r.name || "?")}>{initials(r.name || "?")}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{r.name || "(name unreadable)"}</div>
                <div style={{ fontSize: 12, color: t.faint }}>asked {relTime(r.created_at)} ago</div>
              </div>
              <button style={{ ...s.btn("primary"), padding: "5px 12px", fontSize: 12 }} onClick={() => admit(r)}>Admit</button>
              <button style={{ ...s.btn("ghost"), padding: "5px 10px", fontSize: 12 }} onClick={() => deny(r)}>Deny</button>
            </div>
          ))}
        </div>
      )}

      {isAdmin && (
        <div style={{ ...s.card, display: "grid", gap: 12 }}>
          <div style={{ fontWeight: 700 }}>Invite family</div>
          <div style={{ color: t.dim, fontSize: 13 }}>
            Send this link to a family member. They'll request to join, then you approve them here.
          </div>
          {!link ? (
            <button style={s.btn("primary")} onClick={invite} disabled={busy}>
              {busy ? "Creating\u2026" : "Create invite link"}
            </button>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ ...s.mono, ...s.input, background: t.panel2 }}>{link}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={s.btn("primary")} onClick={copy}>{copied ? "Copied!" : "Copy link"}</button>
                {navigator.share && (
                  <button style={s.btn("ghost")} onClick={() => navigator.share({ url: link, title: "Join our family" })}>
                    {"Share\u2026"}
                  </button>
                )}
                <button style={s.btn("ghost")} onClick={invite}>New link</button>
              </div>
            </div>
          )}
          {err && <div style={{ color: t.bad, fontSize: 13 }}>{err}</div>}
        </div>
      )}

      <div style={{ ...s.card, display: "grid", gap: 10 }}>
        <div style={{ fontWeight: 700 }}>Members ({members.filter((m) => m.status === "active").length})</div>
        {members.filter((m) => m.status === "active").map((m) => (
          <div key={m.member_pub} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={avatarStyle(m.name || "?")}>{initials(m.name || "?")}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>
                {m.name || "(encrypted)"}
                {m.member_pub === me?.member_pub ? " (you)" : ""}
              </div>
              <div style={{ fontSize: 12, color: t.faint }}>joined {relTime(m.joined_at)} ago</div>
            </div>
            {m.role === "admin" && <span style={s.pill(t.accent)}>admin</span>}
            {isAdmin && m.member_pub !== me?.member_pub && (
              <button style={{ ...s.btn("danger"), padding: "4px 10px", fontSize: 12 }} onClick={() => remove(m)} disabled={busy}>
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
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
  return { width: 38, height: 38, borderRadius: "50%", background: colors[h], color: "#04121f", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 14, flexShrink: 0 };
}
