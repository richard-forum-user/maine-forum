import React, { useEffect, useState, useCallback } from "react";
import { styles as s, t } from "../ui/theme.js";
import { opinionMap } from "./civic-client.js";
import { hideTallies, LABELS } from "../config/numbers-discipline.js";

const CLUSTER_COLORS = ["#1f6b56", "#c45c26", "#3a6ea5", "#7a5cbf", "#b23a48"];
const groupLabel = (c) => `Opinion Group ${String.fromCharCode(65 + c)}`;

function Scatter({ points, size = 300 }) {
  if (!points.length) return null;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  let minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  if (maxX - minX < 1e-6) { minX -= 1; maxX += 1; }
  if (maxY - minY < 1e-6) { minY -= 1; maxY += 1; }
  const pad = 28;
  const sx = (x) => pad + ((x - minX) / (maxX - minX)) * (size - 2 * pad);
  const sy = (y) => pad + ((y - minY) / (maxY - minY)) * (size - 2 * pad);
  return (
    <svg
      width="100%"
      viewBox={`0 0 ${size} ${size}`}
      style={{
        background: "var(--forum-bg-surface)",
        border: `1px solid ${t.border}`,
        borderRadius: t.radius,
      }}
      role="img"
      aria-label="Opinion map scatter plot"
    >
      <line x1={pad / 2} y1={size / 2} x2={size - pad / 2} y2={size / 2} stroke="var(--forum-map-grid)" strokeWidth="1" />
      <line x1={size / 2} y1={pad / 2} x2={size / 2} y2={size - pad / 2} stroke="var(--forum-map-grid)" strokeWidth="1" />
      {points.map((p, i) => (
        <circle
          key={i}
          cx={sx(p.x)}
          cy={sy(p.y)}
          r={p.is_me ? 8 : 5.5}
          fill={CLUSTER_COLORS[p.cluster % CLUSTER_COLORS.length]}
          fillOpacity={p.is_me ? 1 : 0.8}
          stroke={p.is_me ? "var(--forum-text-primary)" : "none"}
          strokeWidth={p.is_me ? 2 : 0}
        />
      ))}
    </svg>
  );
}

function StatementRow({ st, groupsCount }) {
  const pct = st.agree_pct == null ? null : Math.round(st.agree_pct * 100);
  return (
    <div style={{ padding: "12px 0", borderBottom: `1px solid ${t.border}` }}>
      <div style={{ fontSize: 15, marginBottom: 8, lineHeight: 1.4 }}>
        {st.text || <span style={{ color: t.faint }}>(removed)</span>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <span style={s.pill(t.good)}>{st.agrees} agree</span>
        <span style={s.pill(t.bad)}>{st.disagrees} disagree</span>
        {pct != null && <span style={{ color: t.faint, fontSize: 12 }}>{pct}% agree overall</span>}
      </div>
      {groupsCount > 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 8 }}>
          {st.by_group.filter((g) => g.n > 0).map((g) => (
            <span key={g.cluster} style={{ fontSize: 12, color: CLUSTER_COLORS[g.cluster % CLUSTER_COLORS.length] }}>
              {groupLabel(g.cluster)}: {g.agree_pct == null ? "—" : `${Math.round(g.agree_pct * 100)}% agree`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function OpinionMap({ groupId, windowStatus = "open" }) {
  const [map, setMap] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try { setMap(await opinionMap(groupId)); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [groupId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ color: t.dim, padding: 12 }}>Mapping opinions…</div>;
  if (err) return <div style={{ ...s.card, color: t.bad }}>{err}</div>;
  if (!map || map.participant_count === 0) {
    return (
      <div style={{ ...s.card, color: t.dim, lineHeight: 1.5 }}>
        No opinions yet. As people agree and disagree with posts here, this map clusters
        points of view and surfaces where there's common ground.
      </div>
    );
  }

  const groupsCount = map.opinion_groups.length;
  const divisive = map.statements.filter((x) => x.divisive).sort((a, b) => b.votes - a.votes);
  const statements = map.statements || [];

  if (hideTallies(windowStatus)) {
    const texts = statements.filter((st) => st.text);
    return (
      <div className="mf-fade-in" style={{ display: "grid", gap: 16 }}>
        <div style={{ ...s.card, display: "grid", gap: 10 }}>
          <div style={{ fontFamily: t.display, fontWeight: 700, fontSize: 17 }}>Opinion map</div>
          <p style={{ margin: 0, fontSize: 14, color: t.dim, lineHeight: 1.5 }}>{LABELS.opinionMapOpen}</p>
        </div>
        <div style={s.card}>
          <div style={{ fontFamily: t.display, fontWeight: 700, fontSize: 16, marginBottom: 8 }}>
            Arguments in play
          </div>
          {texts.length ? texts.map((st) => (
            <div
              key={`${st.item_type}:${st.item_id}`}
              style={{ padding: "12px 0", borderBottom: `1px solid ${t.border}`, fontSize: 15, lineHeight: 1.45 }}
            >
              {st.text}
            </div>
          )) : (
            <div style={{ color: t.faint, fontSize: 14 }}>No visible statements yet.</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mf-fade-in" style={{ display: "grid", gap: 16 }}>
      <div style={s.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12, gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontFamily: t.display, fontWeight: 700, fontSize: 17 }}>Opinion map</div>
          <div style={{ color: t.faint, fontSize: 12 }}>
            {map.participant_count} people · {map.item_count} statements
          </div>
        </div>
        <Scatter points={map.points} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 14 }}>
          {map.opinion_groups.map((g) => (
            <div key={g.cluster} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 999,
                  background: CLUSTER_COLORS[g.cluster % CLUSTER_COLORS.length],
                  display: "inline-block",
                }}
              />
              {groupLabel(g.cluster)}
              <span style={{ color: t.faint }}>· {g.size}</span>
              {g.cluster === map.my_cluster && <span style={s.pill(t.accent)}>you</span>}
            </div>
          ))}
        </div>
      </div>

      <div style={s.card}>
        <div style={{ fontFamily: t.display, fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Common ground</div>
        <div style={{ color: t.dim, fontSize: 13, marginBottom: 8 }}>
          Posts most groups agree on (in the same direction).
        </div>
        {map.consensus.length
          ? map.consensus.map((st) => <StatementRow key={`${st.item_type}:${st.item_id}`} st={st} groupsCount={groupsCount} />)
          : <div style={{ color: t.faint, fontSize: 14 }}>No clear common ground yet.</div>}
      </div>

      {groupsCount > 1 && (
        <div style={s.card}>
          <div style={{ fontFamily: t.display, fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Points of division</div>
          <div style={{ color: t.dim, fontSize: 13, marginBottom: 8 }}>
            Posts the opinion groups lean opposite ways on.
          </div>
          {divisive.length
            ? divisive.map((st) => <StatementRow key={`${st.item_type}:${st.item_id}`} st={st} groupsCount={groupsCount} />)
            : <div style={{ color: t.faint, fontSize: 14 }}>No sharp divisions yet.</div>}
        </div>
      )}
    </div>
  );
}
