/**
 * Connection / sync status with icon + text (accessibility-friendly).
 */

const STATUS_META = {
  connected: { icon: "✓", label: "Connected", color: "var(--forum-success)" },
  connecting: { icon: "⟳", label: "Connecting", color: "var(--forum-warning)" },
  error: { icon: "!", label: "Problem", color: "var(--forum-danger)" },
  disconnected: { icon: "○", label: "Offline", color: "var(--forum-text-muted)" },
};

export function ConnectionStatus({ status, label, compact }) {
  const meta = STATUS_META[status] || STATUS_META.disconnected;
  const text = label || meta.label;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: compact ? 11 : 12,
        color: "var(--forum-text-secondary)",
        minHeight: compact ? undefined : 20,
      }}
      role="status"
      aria-live="polite"
    >
      <span style={{ color: meta.color, fontWeight: 700, lineHeight: 1 }} aria-hidden>
        {meta.icon}
      </span>
      {!compact && <span>{text}</span>}
      {compact && (
        <span className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden" }}>
          {text}
        </span>
      )}
    </div>
  );
}
