// Maine Forum shared tokens — mirrors CSS variables in forum-theme.css so
// inline styles stay in sync with the coastal civic look.

export const t = {
  bg: "var(--forum-bg-root)",
  panel: "var(--forum-bg-elevated)",
  panel2: "var(--forum-bg-surface)",
  muted: "var(--forum-bg-muted)",
  border: "var(--forum-border)",
  text: "var(--forum-text-primary)",
  dim: "var(--forum-text-secondary)",
  faint: "var(--forum-text-muted)",
  accent: "var(--forum-accent)",
  accentHover: "var(--forum-accent-hover)",
  accentSoft: "var(--forum-accent-soft)",
  onAccent: "var(--forum-on-accent)",
  good: "var(--forum-success)",
  warn: "var(--forum-warning)",
  bad: "var(--forum-danger)",
  radius: "var(--forum-radius-md)",
  display: "var(--forum-font-display)",
  sans: "var(--forum-font-sans)",
  shadow: "var(--forum-shadow-sm)",
  shadowMd: "var(--forum-shadow-md)",
};

export const styles = {
  app: {
    minHeight: "100dvh",
    background: t.bg,
    color: t.text,
    fontFamily: t.sans,
    WebkitFontSmoothing: "antialiased",
  },
  card: {
    background: t.panel,
    border: `1px solid ${t.border}`,
    borderRadius: t.radius,
    padding: 20,
    boxShadow: t.shadow,
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    background: "var(--forum-bg-input)",
    color: t.text,
    border: `1px solid ${t.border}`,
    borderRadius: 10,
    padding: "12px 14px",
    fontSize: 15,
    fontFamily: "inherit",
    outline: "none",
    minHeight: "var(--forum-touch-min)",
  },
  label: {
    display: "block",
    fontSize: 12,
    color: t.dim,
    marginBottom: 6,
    fontWeight: 600,
    letterSpacing: "0.02em",
    textTransform: "uppercase",
  },
  btn: (kind = "primary", disabled = false) => ({
    appearance: "none",
    border: "1px solid transparent",
    borderRadius: 11,
    padding: "12px 18px",
    fontSize: 15,
    fontWeight: 600,
    fontFamily: "inherit",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
    transition: "background .15s, border-color .15s, transform .15s",
    minHeight: "var(--forum-touch-min)",
    ...(kind === "primary"
      ? { background: t.accent, color: t.onAccent }
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
    padding: "3px 9px",
    borderRadius: 999,
    background: "transparent",
    border: `1px solid ${color}`,
    color,
  }),
  mono: {
    fontFamily: "var(--forum-font-mono)",
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
