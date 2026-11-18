import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t, styles as S, relTime } from "../ui/theme.js";
import QrCode from "../ui/QrCode.jsx";
import QrScanner from "../ui/QrScanner.jsx";
import {
  loadIdentity,
  contactCard,
  encodeInvite,
  decodeInvite,
} from "./identity.js";
import { getPodUrl, setPodUrl } from "../podlink-config.js";
import { isTauri, startTunnel, tunnelStatus, stopTunnel } from "../tauri-bridge.js";
import {
  listContacts,
  addContact,
  deleteContact,
  listThreads,
  listMessages,
  listGroups,
  createGroup,
  sendDm,
  sendGroup,
  listDevices,
  authorizeDevice,
  revokeDevice,
  resetDevices,
  decryptRow,
  acceptGroupKeyChange,
  podRpc,
} from "./client.js";

const POLL_MS = 5000;

export default function Messenger() {
  const identity = useMemo(() => loadIdentity(), []);
  const [tab, setTab] = useState("chats");
  const [contacts, setContacts] = useState([]);
  const [groups, setGroups] = useState([]);
  const [threads, setThreads] = useState([]);
  const [active, setActive] = useState(null); // {kind, id, title, peer}
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [toast, setToast] = useState(null);
  const [pendingKey, setPendingKey] = useState(null);
  const scrollRef = useRef(null);

  const contactsByHandle = useMemo(() => {
    const m = {};
    for (const c of contacts) m[c.handle] = c;
    return m;
  }, [contacts]);

  const flash = useCallback((msg, kind = "info") => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const refreshLists = useCallback(async () => {
    try {
      const [c, g, th] = await Promise.all([listContacts(), listGroups(), listThreads()]);
      setContacts(c);
      setGroups(g);
      setThreads(th);
    } catch (e) {
      flash(e.message, "bad");
    }
  }, [flash]);

  const refreshActive = useCallback(async () => {
    if (!active) return;
    try {
      const rows = await listMessages(active.id);
      const decoded = rows.map((r) => ({ row: r, dec: decryptRow(identity, r, contactsByHandle) }));
      const prompt = decoded.find((x) => x.dec?.groupKeyPrompt);
      setPendingKey(
        prompt
          ? {
              ...prompt.dec.groupKeyPrompt,
              from: prompt.dec.from,
              title: prompt.dec.control?.title || prompt.dec.groupKeyPrompt.title,
            }
          : null
      );
      const requestThread = String(active.id).startsWith("req:");
      const visible = decoded.filter((x) => {
        if (!x.dec || x.dec.control) return false;
        if (requestThread) return !!x.dec.unverified;
        return !x.dec.unverified;
      });
      setMessages(visible);
      // flush outbox so delivery retries promptly
      podRpc("POST", "/outbox/flush").catch(() => {});
    } catch (e) {
      flash(e.message, "bad");
    }
  }, [active, identity, flash, contactsByHandle]);

  useEffect(() => {
    refreshLists();
  }, [refreshLists]);

  useEffect(() => {
    refreshActive();
  }, [active, refreshActive]);

  useEffect(() => {
    const id = setInterval(() => {
      refreshLists();
      refreshActive();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [refreshLists, refreshActive]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  async function send() {
    const body = draft.trim();
    if (!body || !active) return;
    setDraft("");
    try {
      if (active.kind === "group") {
        const group = groups.find((g) => g.group_id === active.id.replace(/^g:/, "")) || {
          group_id: active.id.replace(/^g:/, ""),
        };
        await sendGroup(group, { body });
      } else {
        const contact = active.peer;
        await sendDm(contact, { body });
      }
      await refreshActive();
      await refreshLists();
    } catch (e) {
      flash(e.message, "bad");
      setDraft(body);
    }
  }

  function openContactThread(c) {
    setActive({ kind: "dm", id: `dm:${c.handle}`, title: c.display_name || c.handle, peer: { handle: c.handle, x: c.x, podUrl: c.pod_url } });
    setTab("chats");
  }

  function threadTitle(th) {
    if (String(th.thread_id).startsWith("req:")) {
      return `Unverified · ${th.peer_handle || "unknown sender"}`;
    }
    if (th.kind === "group") {
      const g = groups.find((x) => x.group_id === th.group_id);
      return g?.title || "Group";
    }
    const c = contactsByHandle[th.peer_handle];
    return c?.display_name || th.peer_handle || "Unknown";
  }

  return (
    <div style={{ ...S.app, display: "flex", flexDirection: "column", height: "100vh" }}>
      <Header tab={tab} setTab={setTab} />
      {toast && (
        <div
          style={{
            position: "fixed",
            top: 14,
            right: 14,
            zIndex: 50,
            ...S.card,
            padding: "10px 14px",
            borderColor: toast.kind === "bad" ? t.bad : t.border,
            color: toast.kind === "bad" ? t.bad : t.text,
            fontSize: 13,
            maxWidth: 360,
          }}
        >
          {toast.msg}
        </div>
      )}

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {tab === "chats" && (
          <>
            <ThreadList
              threads={threads}
              active={active}
              titleFor={threadTitle}
              onSelect={(th) =>
                setActive({
                  kind: th.kind,
                  id: th.thread_id,
                  title: threadTitle(th),
                  peer:
                    th.kind === "dm"
                      ? (() => {
                          const c = contactsByHandle[th.peer_handle];
                          return c ? { handle: c.handle, x: c.x, podUrl: c.pod_url } : { handle: th.peer_handle };
                        })()
                      : null,
                })
              }
            />
            <Conversation
              active={active}
              messages={messages}
              identity={identity}
              contactsByHandle={contactsByHandle}
              draft={draft}
              setDraft={setDraft}
              onSend={send}
              scrollRef={scrollRef}
              pendingKey={pendingKey}
              onAcceptKey={async () => {
                if (!pendingKey) return;
                acceptGroupKeyChange(pendingKey.groupId, pendingKey);
                const who = contactsByHandle[pendingKey.from]?.display_name || pendingKey.from;
                flash(`${who} rotated the key for ${pendingKey.title || "a group"}. Accepted.`);
                setPendingKey(null);
                await refreshActive();
              }}
            />
          </>
        )}

        {tab === "contacts" && (
          <ContactsPanel
            contacts={contacts}
            groups={groups}
            identity={identity}
            onOpen={openContactThread}
            onChanged={refreshLists}
            flash={flash}
          />
        )}

        {tab === "settings" && <SettingsPanel identity={identity} flash={flash} />}
      </div>
    </div>
  );
}

function Header({ tab, setTab }) {
  const tabs = [
    ["chats", "Chats"],
    ["contacts", "Contacts"],
    ["settings", "Settings"],
  ];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "12px 18px",
        borderBottom: `1px solid ${t.border}`,
        background: t.panel,
      }}
    >
      <div style={{ fontWeight: 800, fontSize: 18 }}>podlink</div>
      <div style={{ display: "flex", gap: 6 }}>
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              ...S.btn(tab === id ? "neutral" : "ghost"),
              padding: "6px 12px",
              borderColor: tab === id ? t.accent : "transparent",
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={{ marginLeft: "auto", ...S.pill(t.good) }}>E2E encrypted</div>
    </div>
  );
}

function ThreadList({ threads, active, onSelect, titleFor }) {
  const requests = threads.filter((th) => String(th.thread_id).startsWith("req:"));
  const chats = threads.filter((th) => !String(th.thread_id).startsWith("req:"));
  const row = (th) => (
    <div
      key={th.thread_id}
      onClick={() => onSelect(th)}
      style={{
        padding: "12px 16px",
        cursor: "pointer",
        borderBottom: `1px solid ${t.border}`,
        background: active?.id === th.thread_id ? t.panel2 : "transparent",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 600 }}>
          {th.kind === "group" ? "# " : ""}
          {titleFor(th)}
        </span>
        <span style={{ fontSize: 11, color: t.faint }}>{relTime(th.last_at)}</span>
      </div>
      <div style={{ fontSize: 12, color: t.faint }}>
        {th.n} message{th.n === 1 ? "" : "s"}
      </div>
    </div>
  );
  return (
    <div style={{ width: 280, borderRight: `1px solid ${t.border}`, overflow: "auto", background: t.bg }}>
      {chats.length === 0 && requests.length === 0 && (
        <div style={{ padding: 18, color: t.faint, fontSize: 13 }}>
          No conversations yet. Add a contact to start.
        </div>
      )}
      {chats.map(row)}
      {requests.length > 0 && (
        <div style={{ padding: "14px 16px 6px", fontSize: 11, fontWeight: 700, letterSpacing: 0.4, color: t.faint }}>
          MESSAGE REQUESTS
        </div>
      )}
      {requests.map(row)}
    </div>
  );
}

function Conversation({
  active,
  messages,
  identity,
  contactsByHandle,
  draft,
  setDraft,
  onSend,
  scrollRef,
  pendingKey,
  onAcceptKey,
}) {
  if (!active) {
    return (
      <div style={{ flex: 1, display: "grid", placeItems: "center", color: t.faint }}>
        Select a conversation
      </div>
    );
  }
  const request = String(active.id).startsWith("req:");
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      <div style={{ padding: "12px 18px", borderBottom: `1px solid ${t.border}`, fontWeight: 600 }}>
        {active.kind === "group" ? "# " : ""}
        {active.title}
      </div>
      {request && (
        <div style={{ padding: "10px 18px", background: t.panel2, color: t.dim, fontSize: 13, lineHeight: 1.45 }}>
          Message request. This sender is not a verified contact, so it is not in an existing thread.
        </div>
      )}
      {pendingKey && (
        <div style={{ padding: "10px 18px", background: t.panel2, color: t.text, fontSize: 13, lineHeight: 1.45 }}>
          {contactsByHandle[pendingKey.from]?.display_name || pendingKey.from} rotated the key for{" "}
          {pendingKey.title || "a group"}. Accept?
          <button style={{ ...S.btn("primary"), marginLeft: 10, padding: "4px 10px" }} onClick={onAcceptKey}>
            Accept
          </button>
        </div>
      )}
      <div ref={scrollRef} style={{ flex: 1, overflow: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
        {messages.length === 0 && (
          <div style={{ color: t.faint, fontSize: 13 }}>No messages yet. Say hello.</div>
        )}
        {messages.map(({ row, dec }, i) => {
          const mine = dec.direction === "out";
          const who = mine
            ? "You"
            : dec.unverified
              ? `${dec.from || "unknown"} (unverified)`
              : contactsByHandle[dec.from]?.display_name || dec.from;
          return (
            <div key={row.msg_id || i} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "70%" }}>
              <div
                style={{
                  background: mine ? t.accentDim : t.panel2,
                  border: `1px solid ${t.border}`,
                  borderRadius: 12,
                  padding: "8px 12px",
                  fontSize: 14,
                  lineHeight: 1.45,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color: dec.error ? t.bad : t.text,
                }}
              >
                {dec.error ? "[could not decrypt]" : dec.locked ? "[no group key yet]" : dec.body}
              </div>
              <div style={{ fontSize: 10, color: t.faint, marginTop: 3, textAlign: mine ? "right" : "left" }}>
                {who} · {relTime(dec.ts)}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8, padding: 14, borderTop: `1px solid ${t.border}` }}>
        <input
          style={S.input}
          value={draft}
          placeholder="Write a message…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <button style={S.btn("primary", !draft.trim())} disabled={!draft.trim()} onClick={onSend}>
          Send
        </button>
      </div>
    </div>
  );
}

function ContactsPanel({ contacts, groups, identity, onOpen, onChanged, flash }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [groupTitle, setGroupTitle] = useState("");
  const [groupPicks, setGroupPicks] = useState({});
  const [pendingCard, setPendingCard] = useState(null);
  const invite = identity ? encodeInvite(contactCard(identity)) : "";

  async function addFromText(text, confirmKeyChange = false) {
    setBusy(true);
    try {
      const card = decodeInvite(text);
      await addContact(card, { confirmKeyChange });
      setCode("");
      setPendingCard(null);
      flash(`Added ${card.displayName || card.handle}`);
      onChanged();
    } catch (e) {
      if (e.code === "safety_number_changed") {
        try {
          setPendingCard(decodeInvite(text));
        } catch {
          /* invite already parsed once */
        }
        flash("Safety number changed. Confirm before accepting the new keys.", "bad");
      } else {
        flash(e.message, "bad");
      }
    } finally {
      setBusy(false);
    }
  }

  const add = () => addFromText(code);

  async function makeGroup() {
    const members = contacts.filter((c) => groupPicks[c.handle]).map((c) => ({ handle: c.handle, x: c.x, podUrl: c.pod_url }));
    if (!groupTitle.trim() || members.length === 0) {
      flash("Name the group and pick at least one member.", "bad");
      return;
    }
    try {
      await createGroup(groupTitle.trim(), members);
      setGroupTitle("");
      setGroupPicks({});
      flash("Group created and keys delivered.");
      onChanged();
    } catch (e) {
      flash(e.message, "bad");
    }
  }

  return (
    <div style={{ flex: 1, overflow: "auto", padding: 20, display: "grid", gap: 18, gridTemplateColumns: "1fr", maxWidth: 760 }}>
      <div style={S.card}>
        <h3 style={{ marginTop: 0 }}>Add a contact</h3>
        <p style={{ color: t.dim, fontSize: 13, lineHeight: 1.5 }}>
          Paste a contact&apos;s invite code. Share yours so they can add you back — messaging needs
          both sides.
        </p>
        <textarea
          style={{ ...S.input, minHeight: 70, resize: "vertical", marginBottom: 8 }}
          value={code}
          placeholder="podlink://contact/…"
          onChange={(e) => setCode(e.target.value)}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={S.btn("primary", busy)} disabled={busy} onClick={add}>
            Add contact
          </button>
          <button style={S.btn("ghost")} onClick={() => setScanning(true)}>
            Scan QR
          </button>
          <button style={S.btn("ghost")} onClick={() => setShowInvite((v) => !v)}>
            {showInvite ? "Hide my invite" : "Show my invite"}
          </button>
        </div>
        {pendingCard && (
          <div style={{ marginTop: 12, padding: 12, border: `1px solid ${t.bad}`, borderRadius: 10 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Safety number changed</div>
            <p style={{ color: t.dim, fontSize: 13, lineHeight: 1.5, margin: "0 0 10px" }}>
              {pendingCard.displayName || pendingCard.handle} is already a contact, and the keys in this invite
              are different. Accept only if you expected them to change.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={S.btn("primary", busy)} disabled={busy} onClick={() => addFromText(code || encodeInvite(pendingCard), true)}>
                Accept new keys
              </button>
              <button style={S.btn("ghost")} onClick={() => setPendingCard(null)}>
                Keep the old keys
              </button>
            </div>
          </div>
        )}
        {scanning && (
          <QrScanner
            onClose={() => setScanning(false)}
            onResult={(text) => {
              setScanning(false);
              addFromText(text);
            }}
          />
        )}
        {showInvite && (
          <div style={{ marginTop: 14, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
            <QrCode value={invite} size={160} />
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ ...S.card, background: t.panel2, ...S.mono, maxHeight: 110, overflow: "auto" }}>{invite}</div>
              <button style={{ ...S.btn("ghost"), marginTop: 8 }} onClick={() => navigator.clipboard?.writeText(invite)}>
                Copy invite
              </button>
            </div>
          </div>
        )}
      </div>

      <div style={S.card}>
        <h3 style={{ marginTop: 0 }}>Contacts</h3>
        {contacts.length === 0 && <div style={{ color: t.faint, fontSize: 13 }}>No contacts yet.</div>}
        {contacts.map((c) => (
          <div key={c.handle} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `1px solid ${t.border}` }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{c.display_name || c.handle}</div>
              <div style={{ fontSize: 11, color: t.faint, ...S.mono }}>{c.handle}</div>
            </div>
            <button style={{ ...S.btn("ghost"), padding: "6px 10px" }} onClick={() => onOpen(c)}>
              Message
            </button>
            <button
              style={{ ...S.btn("danger"), padding: "6px 10px" }}
              onClick={async () => {
                await deleteContact(c.handle);
                onChanged();
              }}
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <div style={S.card}>
        <h3 style={{ marginTop: 0 }}>New group channel</h3>
        <input
          style={{ ...S.input, marginBottom: 10 }}
          value={groupTitle}
          placeholder="Group name"
          onChange={(e) => setGroupTitle(e.target.value)}
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          {contacts.map((c) => (
            <label key={c.handle} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, border: `1px solid ${t.border}`, borderRadius: 999, padding: "4px 10px" }}>
              <input
                type="checkbox"
                checked={!!groupPicks[c.handle]}
                onChange={(e) => setGroupPicks((p) => ({ ...p, [c.handle]: e.target.checked }))}
              />
              {c.display_name || c.handle}
            </label>
          ))}
        </div>
        <button style={S.btn("primary")} onClick={makeGroup}>
          Create group
        </button>
        {groups.length > 0 && (
          <div style={{ marginTop: 14, fontSize: 13, color: t.dim }}>
            Your groups: {groups.map((g) => g.title).join(", ")}
          </div>
        )}
      </div>
    </div>
  );
}

function HomeTunnelPanel({ flash }) {
  const [status, setStatus] = useState({ running: false, url: null });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const poll = () => tunnelStatus().then((s) => live && setStatus(s)).catch(() => {});
    poll();
    const id = setInterval(poll, 3000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div style={S.card}>
      <h3 style={{ marginTop: 0 }}>Home tunnel</h3>
      <p style={{ color: t.dim, fontSize: 13, lineHeight: 1.5 }}>
        Expose this machine&apos;s Pod over a Cloudflare Tunnel so contacts can reach you — no open
        inbound port. Set the printed URL as your public Pod URL so it appears in your invite.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
        <span style={S.pill(status.running ? t.good : t.faint)}>{status.running ? "running" : "stopped"}</span>
        {status.url && <span style={{ ...S.mono }}>{status.url}</span>}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          style={S.btn("primary", busy || status.running)}
          disabled={busy || status.running}
          onClick={async () => {
            setBusy(true);
            try {
              await startTunnel();
              flash("Tunnel starting… URL will appear shortly.");
            } catch (e) {
              flash(e.message, "bad");
            } finally {
              setBusy(false);
            }
          }}
        >
          Start tunnel
        </button>
        <button
          style={S.btn("ghost", !status.url)}
          disabled={!status.url}
          onClick={() => {
            setPodUrl(status.url);
            flash("Public Pod URL updated to the tunnel URL.");
          }}
        >
          Use as my Pod URL
        </button>
        <button
          style={S.btn("danger", !status.running)}
          disabled={!status.running}
          onClick={async () => {
            await stopTunnel().catch(() => {});
            flash("Tunnel stopped.");
          }}
        >
          Stop
        </button>
      </div>
    </div>
  );
}

function SettingsPanel({ identity, flash }) {
  const [devices, setDevices] = useState([]);
  const [newDevice, setNewDevice] = useState("");
  const invite = identity ? encodeInvite(contactCard(identity)) : "";

  function reloadDevices() {
    return listDevices().then(setDevices).catch(() => {});
  }

  useEffect(() => {
    reloadDevices();
  }, []);

  return (
    <div style={{ flex: 1, overflow: "auto", padding: 20, display: "grid", gap: 18, maxWidth: 760 }}>
      <div style={S.card}>
        <h3 style={{ marginTop: 0 }}>Your identity</h3>
        <div style={{ fontSize: 13, color: t.dim, marginBottom: 6 }}>Handle</div>
        <div style={{ ...S.mono, marginBottom: 12 }}>{identity?.handle}</div>
        <div style={{ fontSize: 13, color: t.dim, marginBottom: 6 }}>Pod URL</div>
        <div style={{ ...S.mono, marginBottom: 12 }}>{getPodUrl()}</div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          <QrCode value={invite} size={150} />
          <button style={S.btn("ghost")} onClick={() => navigator.clipboard?.writeText(invite)}>
            Copy invite
          </button>
        </div>
      </div>

      <div style={S.card}>
        <h3 style={{ marginTop: 0 }}>Paired devices</h3>
        <p style={{ color: t.dim, fontSize: 13, lineHeight: 1.5 }}>
          On a new device, enter your recovery phrase to restore this identity, then paste that
          device&apos;s signing key below to authorize it on this Pod.
        </p>
        {devices.length > 1 && (
          <p style={{ color: t.text, fontSize: 13, lineHeight: 1.5 }}>
            More than one device can use this Pod. Revoke any device you don&apos;t recognize.
          </p>
        )}
        {devices.map((d) => (
          <div key={d.ed_pub_hex} style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${t.border}` }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13 }}>{d.label || "device"}</div>
              <div style={{ ...S.mono, fontSize: 11, color: t.faint }}>
                {d.ed_pub_hex} · {relTime(d.added_at)}
              </div>
            </div>
            <button
              style={S.btn("danger", devices.length <= 1)}
              disabled={devices.length <= 1}
              onClick={async () => {
                try {
                  await revokeDevice(d.ed_pub_hex);
                  flash("Device removed.");
                  reloadDevices();
                } catch (e) {
                  flash(e.message, "bad");
                }
              }}
            >
              Revoke
            </button>
          </div>
        ))}
        <input
          style={{ ...S.input, margin: "12px 0 8px" }}
          value={newDevice}
          placeholder="new device signing key (hex)"
          onChange={(e) => setNewDevice(e.target.value)}
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            style={S.btn("primary", !newDevice.trim())}
            disabled={!newDevice.trim()}
            onClick={async () => {
              try {
                await authorizeDevice(newDevice.trim().toLowerCase(), "paired device");
                setNewDevice("");
                flash("Device authorized. If you don't recognize it, revoke it.");
                reloadDevices();
              } catch (e) {
                flash(e.message, "bad");
              }
            }}
          >
            Authorize device
          </button>
          <button
            style={S.btn("danger")}
            onClick={async () => {
              try {
                await resetDevices();
                flash("Other devices were signed out. Only this device remains.");
                reloadDevices();
              } catch (e) {
                flash(e.message, "bad");
              }
            }}
          >
            Reset to this device
          </button>
        </div>
      </div>

      {isTauri() && <HomeTunnelPanel flash={flash} />}

      <div style={S.card}>
        <h3 style={{ marginTop: 0, color: t.dim }}>What podlink guarantees</h3>
        <ul style={{ color: t.dim, fontSize: 13, lineHeight: 1.7 }}>
          <li>Message text is encrypted on your device; your Pod and the network only see ciphertext.</li>
          <li>Your identity carries no name, email, or phone unless you add a display name.</li>
          <li>No cooperative, no aggregation, no AI.</li>
        </ul>
      </div>
    </div>
  );
}
