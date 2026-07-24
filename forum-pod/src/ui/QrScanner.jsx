import React, { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { t, styles as S } from "./theme.js";

/**
 * Camera QR scanner modal. Calls onResult(text) on the first decode, then
 * stops the camera. Requires a secure context (HTTPS) for getUserMedia.
 */
export default function QrScanner({ onResult, onClose }) {
  const videoRef = useRef(null);
  const rafRef = useRef(0);
  const streamRef = useRef(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        await video.play();
        tick();
      } catch (e) {
        setError(
          e?.name === "NotAllowedError"
            ? "Camera permission denied. Allow camera access and try again."
            : `Could not open camera: ${e.message}`
        );
      }
    }

    function tick() {
      const video = videoRef.current;
      if (!video || cancelled) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
        if (code && code.data) {
          stop();
          onResult(code.data.trim());
          return;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    function stop() {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((tr) => tr.stop());
    }

    start();
    return stop;
  }, [onResult]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(0,0,0,0.85)",
        display: "grid",
        placeItems: "center",
        padding: 20,
      }}
      onClick={onClose}
    >
      <div style={{ ...S.card, width: "min(420px, 100%)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <strong>Scan a contact&apos;s invite QR</strong>
          <button style={{ ...S.btn("ghost"), padding: "4px 10px" }} onClick={onClose}>
            Close
          </button>
        </div>
        {error ? (
          <div style={{ color: t.bad, fontSize: 13, lineHeight: 1.5 }}>{error}</div>
        ) : (
          <video
            ref={videoRef}
            style={{ width: "100%", borderRadius: 8, background: "#000", aspectRatio: "1 / 1", objectFit: "cover" }}
            muted
          />
        )}
        <p style={{ color: t.faint, fontSize: 12, marginTop: 10, marginBottom: 0 }}>
          Point the camera at the other person&apos;s invite QR code.
        </p>
      </div>
    </div>
  );
}
