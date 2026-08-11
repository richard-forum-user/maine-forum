import React from "react";
import { t } from "../ui/theme.js";
import { consultativeLine, isConsultativeTier } from "../config/numbers-discipline.js";

/** Required stamp on every rendered aggregate until Tier 2 exists. */
export default function ConsultativeLabel({ n, style }) {
  if (!isConsultativeTier()) return null;
  return (
    <p
      style={{
        margin: 0,
        fontSize: 13,
        lineHeight: 1.45,
        color: t.dim,
        fontWeight: 600,
        ...style,
      }}
    >
      {consultativeLine(n)}
    </p>
  );
}
