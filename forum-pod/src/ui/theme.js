// Minimal shared styling for the podlink app. Dark, calm, readable.

export const t = {
  bg: "#0b0f14",
  panel: "#11161d",
  panel2: "#161c24",
  border: "#222c38",
  text: "#e6edf3",
  dim: "#93a1b1",
  faint: "#5b6876",
  accent: "#4ea1ff",
  accentDim: "#1b3a5c",
  good: "#3fb950",
  warn: "#d29922",
  bad: "#f85149",
  radius: 12,
};

export const styles = {
  app: {
    minHeight: "100vh",
    background: t.bg,
    color: t.text,
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    WebkitFontSmoothing: "antialiased",
  },
  card: {
    background: t.panel,
    border: `1px solid ${t.border}`,
    borderRadius: t.radius,
    padding: 20,
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    background: t.panel2,
    color: t.text,
    border: `1px solid ${t.border}`,
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 14,
    outline: "none",
  },
  label: { display: "block", fontSize: 12, color: t.dim, marginBottom: 6, fontWeight: 600 },
  btn: (kind = "primary", disabled = false) => ({
    appearance: "none",
    border: "1px solid transparent",
    borderRadius: 9,
    padding: "10px 16px",
    fontSize: 14,
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
    transition: "background .15s, border-color .15s",
    ...(kind === "primary"
      ? { background: t.accent, color: "#04121f" }
      : kind === "ghost"
      ? { background: "transparent", color: t.text, borderColor: t.border }
      : kind === "danger"
      ? { background: "transparent", color: t.bad, borderColor: t.bad }
      : { background: t.panel2, color: t.text, borderColor: t.border }),
  }),
  pill: (color) => ({
    display: "inline-block",
    fontSize: 11,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 999,
    background: "transparent",
    border: `1px solid ${color}`,
    color,
  }),
  mono: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 12,
    wordBreak: "break-all",
  },
};

export function relTime(iso) {
  if (!iso) return "";
  const d = typeof iso === "string" ? Date.parse(iso) : iso;
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
