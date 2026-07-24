/**
 * Shared Forum Pod UI styles (CSS variables + helpers).
 */

import React from "react";

export const UI = {
  root: {
    display: "flex",
    height: "100vh",
    minHeight: 0,
    background: "var(--forum-bg-root)",
    color: "var(--forum-text-primary)",
    fontFamily: "var(--forum-font-sans)",
    fontSize: 14,
    overflow: "hidden",
  },
  sidebar: (collapsed) => ({
    width: collapsed ? 64 : 220,
    flexShrink: 0,
    background: "var(--forum-bg-surface)",
    borderRight: "1px solid var(--forum-border)",
    display: "flex",
    flexDirection: "column",
    boxShadow: "var(--forum-shadow-sm)",
    transition: "width 0.2s ease",
  }),
  podHeader: { padding: "16px 12px 12px", borderBottom: "1px solid var(--forum-border)" },
  podTitle: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 },
  podIcon: {
    width: 32,
    height: 32,
    background: "var(--forum-bg-elevated)",
    borderRadius: "var(--forum-radius-md)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    flexShrink: 0,
    boxShadow: "var(--forum-shadow-sm)",
  },
  podName: {
    fontWeight: 700,
    color: "var(--forum-text-primary)",
    fontSize: 14,
    letterSpacing: "0.01em",
  },
  statusRow: { display: "flex", alignItems: "center", gap: 6, marginTop: 4 },
  schemaPane: { flex: 1, overflowY: "auto", padding: "10px 10px" },
  sectionLabel: {
    fontSize: 10,
    color: "var(--forum-text-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    marginBottom: 6,
    paddingLeft: 4,
  },
  tableRow: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "4px 6px",
    borderRadius: "var(--forum-radius-sm)",
    cursor: "pointer",
    color: "var(--forum-text-secondary)",
    userSelect: "none",
  },
  colRow: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "2px 6px 2px 20px",
    fontSize: 12,
    color: "var(--forum-text-muted)",
  },
  main: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    minWidth: 0,
    minHeight: 0,
  },
  navSection: { padding: "8px 8px 4px", flex: 1, overflowY: "auto" },
  navSectionLabel: (collapsed) => ({
    fontSize: 10,
    color: "var(--forum-text-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    margin: collapsed ? "8px 0 4px" : "12px 8px 6px",
    paddingLeft: collapsed ? 0 : 4,
    textAlign: collapsed ? "center" : "left",
    display: collapsed ? "none" : "block",
  }),
  chatArea: {
    flex: 1,
    overflowY: "auto",
    padding: "20px 24px",
    display: "flex",
    flexDirection: "column",
    gap: 16,
    background: "var(--forum-bg-surface)",
  },
  bubble: (role) => ({
    maxWidth: "75%",
    alignSelf: role === "user" ? "flex-end" : "flex-start",
    background: role === "user" ? "var(--forum-accent-soft)" : "var(--forum-bg-elevated)",
    border: "1px solid var(--forum-border)",
    borderRadius: 14,
    padding: "12px 14px",
    boxShadow: "var(--forum-shadow-sm)",
  }),
  sqlBlock: {
    marginTop: 8,
    background: "var(--forum-bg-muted)",
    border: "1px solid var(--forum-border)",
    borderRadius: "var(--forum-radius-md)",
    overflow: "hidden",
    boxShadow: "var(--forum-shadow-sm)",
  },
  sqlBlockHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 12px",
    background: "var(--forum-bg-elevated)",
    borderBottom: "1px solid var(--forum-border)",
    fontSize: 12,
    color: "var(--forum-text-secondary)",
  },
  pre: {
    margin: 0,
    padding: "10px 12px",
    color: "var(--forum-accent)",
    fontSize: 12,
    fontFamily: "var(--forum-font-mono)",
    overflowX: "auto",
    lineHeight: 1.5,
  },
  resultsTable: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    padding: "8px 12px",
    textAlign: "left",
    color: "var(--forum-text-secondary)",
    fontWeight: 600,
    fontSize: 12,
    borderBottom: "1px solid var(--forum-border)",
    background: "var(--forum-bg-elevated)",
  },
  td: {
    padding: "8px 12px",
    borderBottom: "1px solid var(--forum-border)",
    color: "var(--forum-text-primary)",
  },
  chatInputRow: {
    padding: "14px 20px",
    borderTop: "1px solid var(--forum-border)",
    background: "var(--forum-bg-elevated)",
    display: "flex",
    gap: 8,
    alignItems: "flex-end",
  },
  chatInput: {
    flex: 1,
    background: "var(--forum-bg-input)",
    border: "1px solid var(--forum-border)",
    borderRadius: "var(--forum-radius-md)",
    padding: "12px 14px",
    color: "var(--forum-text-primary)",
    fontSize: 14,
    fontFamily: "inherit",
    outline: "none",
    resize: "none",
    lineHeight: 1.5,
    minHeight: "var(--forum-touch-min)",
    boxSizing: "border-box",
  },
  sendBtn: (disabled) => ({
    padding: "10px 16px",
    background: disabled ? "var(--forum-bg-muted)" : "var(--forum-accent)",
    border: "none",
    borderRadius: "var(--forum-radius-md)",
    color: disabled ? "var(--forum-text-muted)" : "var(--forum-on-accent)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 14,
    fontFamily: "inherit",
    minHeight: "var(--forum-touch-min)",
    whiteSpace: "nowrap",
    boxShadow: disabled ? "none" : "var(--forum-shadow-sm)",
  }),
  sqlEditor: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  sqlEditorTop: {
    padding: "14px 20px",
    borderBottom: "1px solid var(--forum-border)",
    background: "var(--forum-bg-elevated)",
  },
  sqlTextarea: {
    width: "100%",
    background: "var(--forum-bg-input)",
    border: "1px solid var(--forum-border)",
    borderRadius: "var(--forum-radius-md)",
    padding: "12px 16px",
    color: "var(--forum-accent)",
    fontSize: 13,
    fontFamily: "var(--forum-font-mono)",
    outline: "none",
    resize: "none",
    lineHeight: 1.6,
    boxSizing: "border-box",
  },
  runBtn: (disabled) => ({
    padding: "10px 18px",
    background: disabled ? "var(--forum-bg-muted)" : "var(--forum-accent)",
    border: "none",
    borderRadius: "var(--forum-radius-md)",
    color: disabled ? "var(--forum-text-muted)" : "var(--forum-on-accent)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 14,
    fontFamily: "inherit",
    marginTop: 8,
    minHeight: "var(--forum-touch-min)",
    boxShadow: disabled ? "none" : "var(--forum-shadow-sm)",
  }),
  resultsPane: {
    flex: 1,
    overflow: "auto",
    padding: "16px 20px",
    background: "var(--forum-bg-surface)",
  },
  uploadZone: {
    border: "2px dashed var(--forum-border)",
    borderRadius: "var(--forum-radius-lg)",
    padding: "48px 32px",
    textAlign: "center",
    cursor: "pointer",
    background: "var(--forum-bg-elevated)",
    boxShadow: "var(--forum-shadow-sm)",
  },
  tag: (kind) => {
    const map = {
      accent: "var(--forum-accent)",
      success: "var(--forum-success)",
      warning: "var(--forum-warning)",
    };
    const color = map[kind] || map.accent;
    return {
      display: "inline-flex",
      alignItems: "center",
      padding: "3px 8px",
      borderRadius: 99,
      fontSize: 11,
      letterSpacing: "0.03em",
      background: `color-mix(in srgb, ${color} 18%, transparent)`,
      border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
      color,
    };
  },
  metaRow: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 },
  filterChip: (active) => ({
    padding: "6px 12px",
    borderRadius: 999,
    fontSize: 12,
    fontFamily: "inherit",
    cursor: "pointer",
    minHeight: 36,
    background: active ? "var(--forum-accent)" : "var(--forum-bg-muted)",
    border: `1px solid ${active ? "var(--forum-accent)" : "var(--forum-border)"}`,
    color: active ? "var(--forum-on-accent)" : "var(--forum-text-secondary)",
  }),
  typePill: () => ({
    fontSize: 10,
    padding: "2px 6px",
    borderRadius: "var(--forum-radius-sm)",
    background: "var(--forum-accent-soft)",
    color: "var(--forum-text-muted)",
    border: "1px solid var(--forum-border)",
    marginLeft: "auto",
    whiteSpace: "nowrap",
    fontFamily: "var(--forum-font-mono)",
  }),
  heading: { fontSize: 16, fontWeight: 700, color: "var(--forum-text-primary)", marginBottom: 4 },
  subheading: { fontSize: 14, fontWeight: 600, color: "var(--forum-text-primary)", marginBottom: 6 },
  bodyText: { fontSize: 13, color: "var(--forum-text-secondary)", lineHeight: 1.55, marginBottom: 12 },
  label: { fontSize: 12, color: "var(--forum-text-secondary)", display: "block", marginBottom: 6 },
  panel: {
    marginBottom: 14,
    padding: "12px 14px",
    border: "1px solid var(--forum-border)",
    borderRadius: "var(--forum-radius-md)",
    background: "var(--forum-bg-elevated)",
    boxShadow: "var(--forum-shadow-sm)",
  },
  ghostBtn: {
    background: "transparent",
    border: "1px solid var(--forum-border)",
    color: "var(--forum-accent)",
    borderRadius: "var(--forum-radius-sm)",
    padding: "6px 10px",
    fontSize: 12,
    fontFamily: "inherit",
    cursor: "pointer",
    minHeight: 32,
  },
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 1002,
    background: "color-mix(in srgb, var(--forum-bg-root) 88%, transparent)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  modal: {
    width: "100%",
    maxWidth: 520,
    background: "var(--forum-bg-elevated)",
    border: "1px solid var(--forum-border)",
    borderRadius: "var(--forum-radius-lg)",
    padding: 20,
    boxShadow: "var(--forum-shadow-md)",
  },
};

export const ASSISTANT_UI = {
  shell: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--forum-bg-surface)" },
  header: {
    padding: "14px 18px",
    borderBottom: "1px solid var(--forum-border)",
    background: "var(--forum-bg-elevated)",
    boxShadow: "var(--forum-shadow-sm)",
  },
  modeBtn: (active) => ({
    background: active ? "var(--forum-accent)" : "var(--forum-bg-muted)",
    border: `1px solid ${active ? "var(--forum-accent)" : "var(--forum-border)"}`,
    color: active ? "var(--forum-on-accent)" : "var(--forum-text-secondary)",
    borderRadius: 999,
    padding: "8px 14px",
    fontSize: 12,
    fontFamily: "inherit",
    cursor: "pointer",
    minHeight: 36,
  }),
  body: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: 16, overflow: "hidden" },
  transcript: {
    flex: 1,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    paddingRight: 4,
  },
  bubble: (role) => ({
    maxWidth: "78%",
    alignSelf: role === "user" ? "flex-end" : "flex-start",
    background: role === "user" ? "var(--forum-accent-soft)" : "var(--forum-bg-elevated)",
    border: "1px solid var(--forum-border)",
    borderRadius: 14,
    padding: "12px 14px",
    whiteSpace: "pre-wrap",
    lineHeight: 1.55,
    boxShadow: "var(--forum-shadow-sm)",
    color: "var(--forum-text-primary)",
  }),
  inputRow: {
    borderTop: "1px solid var(--forum-border)",
    paddingTop: 12,
    marginTop: 12,
    display: "flex",
    gap: 8,
    alignItems: "flex-end",
  },
  input: { ...UI.chatInput, minHeight: 58 },
  sendBtn: UI.sendBtn,
};

export function alertStyle(ok) {
  return {
    padding: "10px 14px",
    borderRadius: "var(--forum-radius-md)",
    fontSize: 13,
    lineHeight: 1.5,
    background: ok
      ? "color-mix(in srgb, var(--forum-success) 12%, var(--forum-bg-elevated))"
      : "color-mix(in srgb, var(--forum-danger) 12%, var(--forum-bg-elevated))",
    border: "1px solid var(--forum-border)",
    color: ok ? "var(--forum-success)" : "var(--forum-danger)",
  };
}

export function fmtCell(v) {
  if (v === null || v === undefined) {
    return <span style={{ color: "var(--forum-text-muted)" }}>—</span>;
  }
  if (typeof v === "boolean") {
    return <span style={{ color: "var(--forum-warning)" }}>{String(v)}</span>;
  }
  if (typeof v === "number" || typeof v === "bigint") {
    return <span style={{ color: "var(--forum-success)" }}>{String(v)}</span>;
  }
  return String(v);
}

const SYNC_STATUS = {
  transmitted: { label: "Synced", color: "var(--forum-success)" },
  private: { label: "Private", color: "var(--forum-text-secondary)" },
  pending: { label: "Pending", color: "var(--forum-warning)" },
  syncing: { label: "Syncing", color: "var(--forum-accent)" },
  failed: { label: "Failed", color: "var(--forum-danger)" },
};

export function statusPill(status) {
  const s = SYNC_STATUS[status] || { label: status || "—", color: "var(--forum-text-muted)" };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 500,
        background: `color-mix(in srgb, ${s.color} 14%, var(--forum-bg-elevated))`,
        border: `1px solid color-mix(in srgb, ${s.color} 35%, transparent)`,
        color: s.color,
        whiteSpace: "nowrap",
      }}
    >
      {s.label}
    </span>
  );
}
