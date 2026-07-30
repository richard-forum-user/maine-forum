import React, { useEffect, useState, useCallback } from "react";
import { styles as s, t } from "../ui/theme.js";
import { opinionMap } from "./civic-client.js";

// Distinct, colorblind-friendly-ish cluster colors.
const CLUSTER_COLORS = ["#4ea1ff", "#f0883e", "#3fb950", "#c297ff", "#ff6b8a"];
const groupLabel = (c) => `Opinion Group ${String.fromCharCode(65 + c)}`;

function Scatter({ points, size = 300 }) {
  if (!points.length) return null;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  let minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  if (maxX - minX < 1e-6) { minX -= 1; maxX += 1; }
  if (maxY - minY < 1e-6) { minY -= 1; maxY += 1; }
  const pad = 26;
  const sx = (x) => pad + ((x - minX) / (maxX - minX)) * (size - 2 * pad);
  const sy = (y) => pad + ((y - minY) / (maxY - minY)) * (size - 2 * pad);
  return (
    <svg width="100%" viewBox={`0 0 ${size} ${size}`} style={{ background: t.panel2, border: `1px solid ${t.border}`, borderRadius: t.radius }}>
      <line x1={pad / 2} y1={size / 2} x2={size - pad / 2} y2={size / 2} stroke={t.border} strokeDasharray="3 4" />
      <line x1={size / 2} y1={pad / 2} x2={size / 2} y2={size - pad / 2} stroke={t.border} strokeDasharray="3 4" />
      {points.map((p, i) => (
        <circle
          key={i}
          cx={sx(p.x)} cy={sy(p.y)}
          r={p.is_me ? 7 : 5}
          fill={CLUSTER_COLORS[p.cluster % CLUSTER_COLORS.length]}
          fillOpacity={p.is_me ? 1 : 0.75}
          stroke={p.is_me ? t.text : "none"} strokeWidth={p.is_me ? 2 : 0}
        />
      ))}
    </svg>
  );
}

function StatementRow({ st, groupsCount }) {
  const pct = st.agree_pct == null ? null : Math.round(st.agree_pct * 100);
  return (
    <div style={{ padding: "10px 0", borderBottom: `1px solid ${t.border}` }}>
      <div style={{ fontSize: 14, marginBottom: 6 }}>{st.text || <span style={{ color: t.faint }}>(removed)</span>}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <span style={s.pill(t.good)}>{st.agrees} agree</span>
        <span style={s.pill(t.bad)}>{st.disagrees} disagree</span>
        {pct != null && <span style={{ color: t.dim, fontSize: 12 }}>{pct}% agree overall</span>}
      </div>
      {groupsCount > 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
          {st.by_group.filter((g) => g.n > 0).map((g) => (
            <span key={g.cluster} style={{ fontSize: 11, color: CLUSTER_COLORS[g.cluster % CLUSTER_COLORS.length] }}>
              {groupLabel(g.cluster)}: {g.agree_pct == null ? "—" : `${Math.round(g.agree_pct * 100)}% agree`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function OpinionMap({ groupId }) {
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
      <div style={{ ...s.card, color: t.dim }}>
        No opinions yet. As people like and dislike posts here, this map will cluster the
        different points of view and surface where there's consensus.
      </div>
    );
  }

  const groupsCount = map.opinion_groups.length;
  const divisive = map.statements.filter((x) => x.divisive).sort((a, b) => (b.votes - a.votes));

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={s.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Opinion map</div>
          <div style={{ color: t.dim, fontSize: 12 }}>{map.participant_count} people · {map.item_count} statements</div>
        </div>
        <Scatter points={map.points} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 12 }}>
          {map.opinion_groups.map((g) => (
            <div key={g.cluster} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <span style={{ width: 12, height: 12, borderRadius: 999, background: CLUSTER_COLORS[g.cluster % CLUSTER_COLORS.length], display: "inline-block" }} />
              {groupLabel(g.cluster)}
              <span style={{ color: t.dim }}>· {g.size}</span>
              {g.cluster === map.my_cluster && <span style={s.pill(t.accent)}>you</span>}
            </div>
          ))}
        </div>
      </div>

      <div style={s.card}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Common ground</div>
        <div style={{ color: t.dim, fontSize: 12, marginBottom: 8 }}>Posts most groups agree on (in the same direction).</div>
        {map.consensus.length
          ? map.consensus.map((st) => <StatementRow key={`${st.item_type}:${st.item_id}`} st={st} groupsCount={groupsCount} />)
          : <div style={{ color: t.faint, fontSize: 13 }}>No clear common ground yet.</div>}
      </div>

      {groupsCount > 1 && (
        <div style={s.card}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Points of division</div>
          <div style={{ color: t.dim, fontSize: 12, marginBottom: 8 }}>Posts the opinion groups lean opposite ways on.</div>
          {divisive.length
            ? divisive.map((st) => <StatementRow key={`${st.item_type}:${st.item_id}`} st={st} groupsCount={groupsCount} />)
            : <div style={{ color: t.faint, fontSize: 13 }}>No sharp divisions yet.</div>}
        </div>
      )}
    </div>
  );
}
