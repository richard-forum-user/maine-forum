import React, { useEffect, useState } from "react";
import { styles as s, t } from "../ui/theme.js";
import { listEvents, createEvent, rsvpEvent, deleteEvent } from "./family-client.js";

export default function Calendar({ me, names = {} }) {
  const [events, setEvents] = useState([]);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ title: "", start_at: "", location: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function refresh() {
    try {
      setEvents(await listEvents());
    } catch (e) {
      setErr(e.message);
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  async function add() {
    if (!form.title.trim() || !form.start_at) {
      setErr("A title and date/time are required.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      await createEvent({
        title: form.title.trim(),
        start_at: new Date(form.start_at).toISOString(),
        location: form.location.trim(),
        description: form.description.trim(),
      });
      setForm({ title: "", start_at: "", location: "", description: "" });
      setShow(false);
      await refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function rsvp(id, status) {
    await rsvpEvent(id, status);
    await refresh();
  }
  async function remove(id) {
    if (!confirm("Delete this event?")) return;
    await deleteEvent(id);
    await refresh();
  }

  const now = Date.now();
  const upcoming = events.filter((e) => Date.parse(e.start_at) >= now - 3600_000);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <div style={{ fontWeight: 700, fontSize: 18, flex: 1 }}>Upcoming</div>
        <button style={s.btn("primary")} onClick={() => setShow(!show)}>
          {show ? "Cancel" : "New event"}
        </button>
      </div>

      {show && (
        <div style={{ ...s.card, display: "grid", gap: 12 }}>
          <div>
            <label style={s.label}>What</label>
            <input style={s.input} value={form.title} placeholder="Sunday dinner" onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div>
            <label style={s.label}>When</label>
            <input style={s.input} type="datetime-local" value={form.start_at} onChange={(e) => setForm({ ...form, start_at: e.target.value })} />
          </div>
          <div>
            <label style={s.label}>Where (optional)</label>
            <input style={s.input} value={form.location} placeholder="Grandma's house" onChange={(e) => setForm({ ...form, location: e.target.value })} />
          </div>
          <div>
            <label style={s.label}>Details (optional)</label>
            <textarea style={{ ...s.input, minHeight: 50, fontFamily: "inherit" }} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          {err && <div style={{ color: t.bad, fontSize: 13 }}>{err}</div>}
          <button style={s.btn("primary")} onClick={add} disabled={busy}>{busy ? "Saving\u2026" : "Add event"}</button>
        </div>
      )}

      {upcoming.length === 0 && !show && (
        <div style={{ ...s.card, textAlign: "center", color: t.dim }}>No upcoming events. Plan something!</div>
      )}

      {upcoming.map((e) => {
        const mine = (e.rsvps || []).find((r) => r.member_pub === me?.member_pub);
        const going = (e.rsvps || []).filter((r) => r.status === "yes");
        return (
          <div key={e.id} style={{ ...s.card, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <DateBadge iso={e.start_at} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{e.title}</div>
                <div style={{ color: t.dim, fontSize: 13 }}>{fmtWhen(e.start_at)}</div>
                {e.location && <div style={{ color: t.dim, fontSize: 13 }}>{"\uD83D\uDCCD "}{e.location}</div>}
                {e.description && <div style={{ marginTop: 6, fontSize: 14, whiteSpace: "pre-wrap" }}>{e.description}</div>}
              </div>
              {(e.created_by === me?.member_pub || me?.role === "admin") && (
                <button style={{ ...s.btn("ghost"), padding: "4px 10px", fontSize: 12 }} onClick={() => remove(e.id)}>Delete</button>
              )}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              {["yes", "maybe", "no"].map((st) => (
                <button
                  key={st}
                  onClick={() => rsvp(e.id, st)}
                  style={{ ...s.btn(mine?.status === st ? "primary" : "secondary"), padding: "5px 12px", fontSize: 12 }}
                >
                  {st === "yes" ? "Going" : st === "maybe" ? "Maybe" : "Can't"}
                </button>
              ))}
              <span style={{ color: t.faint, fontSize: 12, marginLeft: 6 }}>
                {going.length > 0 ? `${going.map((g) => names[g.member_pub] || "Member").join(", ")} going` : "No RSVPs yet"}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DateBadge({ iso }) {
  const d = new Date(iso);
  return (
    <div style={{ textAlign: "center", background: t.panel2, border: `1px solid ${t.border}`, borderRadius: 10, padding: "6px 10px", minWidth: 52 }}>
      <div style={{ fontSize: 11, color: t.accent, fontWeight: 700, textTransform: "uppercase" }}>
        {d.toLocaleString(undefined, { month: "short" })}
      </div>
      <div style={{ fontSize: 20, fontWeight: 800 }}>{d.getDate()}</div>
    </div>
  );
}
function fmtWhen(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}
