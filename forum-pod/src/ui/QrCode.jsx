import React, { useEffect, useState } from "react";
import QRCode from "qrcode";
import { t } from "./theme.js";

/** Renders `value` as a QR code image. Falls back to nothing on error. */
export default function QrCode({ value, size = 196 }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (!value) {
      setUrl(null);
      return;
    }
    QRCode.toDataURL(value, {
      width: size,
      margin: 1,
      color: { dark: "#0b0f14", light: "#e6edf3" },
    })
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!url) {
    return (
      <div
        style={{
          width: size,
          height: size,
          display: "grid",
          placeItems: "center",
          background: "#e6edf3",
          borderRadius: 8,
          color: "#0b0f14",
          fontSize: 12,
        }}
      >
        generating…
      </div>
    );
  }
  return (
    <img
      src={url}
      width={size}
      height={size}
      alt="QR code"
      style={{ borderRadius: 8, border: `1px solid ${t.border}`, display: "block" }}
    />
  );
}
