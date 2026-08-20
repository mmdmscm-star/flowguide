// Normalised presence matching — the one implementation.
//
// This is the corpus scorer's reconciliation logic, moved into src so the fact
// ledger and the scorer cannot drift. It arrives with KNOWN failure modes rather
// than fresh ones: two false-positive classes were found and fixed while scoring
// Corpus v1, and both fixes are here.
//
//   - a community name appears inside its own domain and email address
//     (Marin Terrace -> marinterrace.example.com), so a text fact is never
//     matched inside a url-shaped value;
//   - a two-digit number appears inside a postcode or a phone number
//     (Capacity: 47 inside 95472), so short numbers match as whole tokens only.
//
// Matching is deliberately tolerant of reformatting: "$4,720/month" and
// "$4,720 per month" are the same fact. It is presence-based, never
// placement-based — where a fact ended up is a different question.

export type ProbeKind = "url" | "email" | "phone" | "money" | "number" | "text";
export interface Probe { kind: ProbeKind; needle: string }

export const squash = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
export const digitsOf = (s: unknown) => String(s ?? "").replace(/\D+/g, "");
export const urlKey = (s: unknown) =>
  String(s ?? "").toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[/?#]+$/, "");

/** The minimal distinctive needle for a value, chosen by its shape. */
export function probe(text: string): Probe {
  const t = String(text ?? "").trim();
  if (/^https?:\/\//i.test(t)) return { kind: "url", needle: urlKey(t) };
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(t)) return { kind: "email", needle: squash(t) };
  if (/^\+?1?[-.\s(]*\d{3}[-.\s)]*\d{3}[-.\s]*\d{4}$/.test(t)) return { kind: "phone", needle: digitsOf(t) };
  if (/\$/.test(t)) return { kind: "money", needle: digitsOf(t) };
  if (/^\d+$/.test(t)) return { kind: "number", needle: t };
  return { kind: "text", needle: squash(t) };
}

/** Does this probe appear in this haystack? `urlShaped` suppresses text matches. */
export function matches(hay: string, p: Probe, opts: { urlShaped?: boolean } = {}): boolean {
  if (!p.needle) return false;
  if (p.kind === "text" && opts.urlShaped) return false;
  if (p.kind === "number" && p.needle.length <= 3) {
    const tokens: string[] = String(hay).match(/\d+/g) ?? [];
    return tokens.includes(p.needle);
  }
  return String(hay).includes(p.needle);
}

/** Every searchable rendering of a model result item, for presence checks. */
export function itemHaystack(item: Record<string, unknown>): { text: string; urls: string; digits: string } {
  const details = (item.details as { label?: string; value?: string }[] ?? [])
    .map((d) => `${d?.label ?? ""} ${d?.value ?? ""}`).join(" ");
  const contacts = (item.contacts as Record<string, string>[] ?? []);
  const urlish = [
    ...(item.links as { url?: string }[] ?? []).map((l) => l?.url),
    ...(item.photos as unknown[] ?? []).map((p) => (typeof p === "string" ? p : (p as { url?: string })?.url)),
    ...contacts.map((c) => c?.website),
    ...contacts.map((c) => c?.email),
  ].filter(Boolean).map(urlKey).join(" ");
  const text = squash([
    item.title, item.address, item.description, item.notes, details,
    contacts.map((c) => [c?.name, c?.role].join(" ")).join(" "),
  ].join(" "));
  const allDigits = digitsOf([
    details, item.address, item.description, item.notes,
    contacts.map((c) => c?.phone).join(" "),
  ].join(" "));
  return { text, urls: urlish, digits: allDigits };
}

/** Is this value present ANYWHERE in the item? Presence, not placement. */
export function presentInItem(item: Record<string, unknown>, value: string): boolean {
  const p = probe(value);
  const h = itemHaystack(item);
  if (p.kind === "url" || p.kind === "email") return matches(h.urls, p) || matches(h.text, p);
  if (p.kind === "phone") return matches(h.digits, p);
  if (p.kind === "money" || p.kind === "number") return matches(h.digits, p) || matches(h.text, p);
  return matches(h.text, p);
}
