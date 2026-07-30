import React from "react";
import { t, avatarColors, initials } from "../ui/theme.js";
import { instance } from "../config/instance.js";

// ---- Icons (inline stroke SVG, currentColor) -------------------------------
const mk = (paths, { fill = false } = {}) => function Icon({ size = 18, style, ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"}
      stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
      style={{ flex: "none", ...style }} {...rest}>
      {paths}
    </svg>
  );
};

export const Icon = {
  Pin: mk(<><path d="M12 21s7-6.6 7-11a7 7 0 1 0-14 0c0 4.4 7 11 7 11Z" /><circle cx="12" cy="10" r="2.5" /></>),
  Users: mk(<><path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19" /><circle cx="10" cy="8" r="3.2" /><path d="M20 19v-1.4a3.4 3.4 0 0 0-2.6-3.3M15.5 5.2a3.2 3.2 0 0 1 0 5.6" /></>),
  Chat: mk(<path d="M21 12a8 8 0 0 1-11.5 7.2L4 20.5l1.4-4.3A8 8 0 1 1 21 12Z" />),
  Up: mk(<path d="M7 11v9M7 11l3.2-7a2 2 0 0 1 3.8.9V9h4.3a2 2 0 0 1 2 2.4l-1.3 6.5a2 2 0 0 1-2 1.6H7" />),
  Down: mk(<path d="M17 13V4M17 13l-3.2 7a2 2 0 0 1-3.8-.9V15H5.7a2 2 0 0 1-2-2.4l1.3-6.5a2 2 0 0 1 2-1.6H17" />),
  Back: mk(<path d="M15 19l-7-7 7-7" />),
  Plus: mk(<path d="M12 5v14M5 12h14" />),
  Shield: mk(<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" />),
  Compass: mk(<><circle cx="12" cy="12" r="9" /><path d="M15.5 8.5l-2 5-5 2 2-5 5-2Z" /></>),
  Search: mk(<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>),
  Map: mk(<><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" /><path d="M9 4v14M15 6v14" /></>),
  Check: mk(<path d="M20 6 9 17l-5-5" />),
  Send: mk(<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />),
  Lock: mk(<><rect x="4.5" y="10.5" width="15" height="10" rx="2" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" /></>),
  Globe: mk(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" /></>),
  Spark: mk(<path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6L12 3Z" />),
};

// ---- Avatar ----------------------------------------------------------------
export function Avatar({ name, size = 34 }) {
  const c = avatarColors(name || "?");
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", flex: "none",
      background: c.bg, color: c.fg, boxShadow: `inset 0 0 0 1px ${c.ring}`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.4, fontWeight: 700, letterSpacing: 0.2, userSelect: "none",
    }}>
      {initials(name || "?")}
    </div>
  );
}

// ---- Skeletons -------------------------------------------------------------
export function Skeleton({ w = "100%", h = 14, r = 8, style }) {
  return <div className="civ-skel" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

export function CardSkeleton({ lines = 2 }) {
  return (
    <div style={{ background: t.panel, border: `1px solid ${t.border}`, borderRadius: t.radius, padding: 20, display: "grid", gap: 10 }}>
      <Skeleton w="40%" h={12} />
      {Array.from({ length: lines }).map((_, i) => <Skeleton key={i} w={i === lines - 1 ? "70%" : "100%"} h={13} />)}
    </div>
  );
}

export function Spinner({ size = 16, color = t.dim }) {
  return (
    <svg className="civ-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flex: "none" }}>
      <circle cx="12" cy="12" r="9" stroke={t.border} strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke={color} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ---- Empty state -----------------------------------------------------------
export function EmptyState({ icon: IconCmp, title, children }) {
  return (
    <div style={{
      background: t.panel, border: `1px dashed ${t.borderStrong}`, borderRadius: t.radius,
      padding: "32px 24px", textAlign: "center", display: "grid", gap: 8, justifyItems: "center",
    }}>
      {IconCmp && (
        <div style={{ width: 46, height: 46, borderRadius: 12, background: t.panel3, color: t.dim, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <IconCmp size={22} />
        </div>
      )}
      {title && <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>}
      {children && <div style={{ color: t.dim, fontSize: 13, maxWidth: 320, lineHeight: 1.5 }}>{children}</div>}
    </div>
  );
}

// ---- Footer (trust / protocol) ---------------------------------------------
export function Footer() {
  return (
    <footer style={{ maxWidth: 720, margin: "0 auto", padding: "28px 16px 40px", color: t.faint, fontSize: 12 }}>
      <div style={{ height: 1, background: t.border, marginBottom: 16 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: t.dim, fontWeight: 600, marginBottom: 8 }}>
        <Icon.Shield size={15} /> {instance.protocol.name} {instance.protocol.version}
      </div>
      <div style={{ lineHeight: 1.6 }}>
        No ads. No trackers. No data sales. No profiling. Member-owned by design —
        county boards and lobbies are public; community groups are end-to-end encrypted.
      </div>
    </footer>
  );
}
