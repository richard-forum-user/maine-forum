/**
 * Recursive canonical JSON for signatures. One module for the client, the
 * worker, and the Durable Object so nested objects sign to the same bytes.
 *
 * JCS-style (RFC 8785): object keys are sorted by UTF-16 code units at every
 * level, arrays keep their order, and values are serialized with JSON
 * stringification. Undefined object fields are omitted.
 */

function normalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    out[key] = normalize(value[key]);
  }
  return out;
}

export function canonicalise(value) {
  const json = JSON.stringify(normalize(value));
  if (typeof json !== "string") throw new Error("not_json");
  return json;
}
