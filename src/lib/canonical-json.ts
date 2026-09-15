// VALUE EQUALITY FOR STORED JSON.
//
// jsonb reorders object keys, so a publication read back from the database is
// the same value as the copy that was sent but rarely the same bytes. Anything
// deciding whether two Sendset copies are "the same" compares this, never
// JSON.stringify.

/** Key-order-independent JSON text: object keys sorted at every depth; array order kept. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
