import React, { useEffect, useState } from "react";
import { t } from "../ui/theme.js";
import { photoObjectUrl } from "./family-client.js";

/**
 * Fetches an encrypted photo from R2 and decrypts it client-side into a blob
 * URL. The bytes on the server are ciphertext; only members with the epoch key
 * can render them.
 */
export default function EncryptedImage({ r2Key, epoch, alt = "", style }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoked = false;
    let objUrl = null;
    photoObjectUrl(r2Key, epoch)
      .then((u) => {
        if (revoked) {
          if (u) URL.revokeObjectURL(u);
          return;
        }
        if (u) {
          objUrl = u;
          setUrl(u);
        } else {
          setFailed(true);
        }
      })
      .catch(() => setFailed(true));
    return () => {
      revoked = true;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [r2Key, epoch]);

  if (failed) {
    return (
      <div style={{ ...style, display: "flex", alignItems: "center", justifyContent: "center", background: t.panel2, color: t.faint, fontSize: 22 }}>
        {"\uD83D\uDD12"}
      </div>
    );
  }
  if (!url) {
    return <div style={{ ...style, background: t.panel2 }} />;
  }
  return <img src={url} alt={alt} style={style} />;
}
