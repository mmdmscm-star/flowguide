// Shared scoring core for the semantic corpora.
//
// ONE implementation, because two would drift and the numbers would stop being
// comparable between v1 and v2. It carries the two artifact fixes v1's first
// runs forced: a text fact is never matched inside a url-shaped destination, and
// short numbers are matched as whole tokens rather than as substrings of longer
// digit strings.
export type Dest =
  | "title" | "address" | "description" | "notes"
  | "details" | "links" | "photos"
  | "contacts.name" | "contacts.role" | "contacts.phone" | "contacts.email" | "contacts.website";

export const DESTS: Dest[] = ["title","address","description","notes","details","links","photos",
  "contacts.name","contacts.role","contacts.phone","contacts.email","contacts.website"];

export const squash = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const digits = (s: unknown) => String(s ?? "").replace(/\D+/g, "");
const urlKey = (s: unknown) => String(s ?? "").toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");

export function probe(text: string): { kind: string; needle: string } {
  if (/^https?:\/\//.test(text)) return { kind: "url", needle: urlKey(text) };
  if (/@/.test(text)) return { kind: "email", needle: squash(text) };
  if (/^\d{3}-\d{3}-\d{4}$/.test(text)) return { kind: "phone", needle: digits(text) };
  if (/\$/.test(text)) return { kind: "money", needle: digits(text) };
  if (/^\d+$/.test(text)) return { kind: "number", needle: text };
  return { kind: "text", needle: squash(text) };
}

type Item = Record<string, any>;
export function haystacks(it: Item): Record<Dest, string> & { __numbers: string[] } {
  const contacts = it.contacts ?? [];
  const detailText = (it.details ?? []).map((d: any) => `${d?.label} ${d?.value}`).join(" ");
  return {
    title: squash(it.title), address: squash(it.address),
    description: squash(it.description), notes: squash(it.notes),
    details: squash(detailText),
    links: (it.links ?? []).map((l: any) => urlKey(l?.url)).join(" "),
    photos: (it.photos ?? []).map((p: any) => urlKey(typeof p === "string" ? p : p?.url)).join(" "),
    "contacts.name": squash(contacts.map((c: any) => c?.name).join(" ")),
    "contacts.role": squash(contacts.map((c: any) => c?.role).join(" ")),
    "contacts.phone": digits(contacts.map((c: any) => c?.phone).join(" ")),
    "contacts.email": squash(contacts.map((c: any) => c?.email).join(" ")),
    "contacts.website": contacts.map((c: any) => urlKey(c?.website)).filter(Boolean).join(" "),
    __numbers: [],
  } as any;
}

// A name appears inside its own domain and email address; a two-digit capacity
// appears inside a postcode. Neither is placement.
const URL_SHAPED: Dest[] = ["links", "photos", "contacts.website", "contacts.email"];
export function found(hay: Record<Dest, string>, d: Dest, p: { kind: string; needle: string }): boolean {
  const h = hay[d] ?? "";
  if (!p.needle) return false;
  if (p.kind === "text" && URL_SHAPED.includes(d)) return false;
  if (p.kind === "number" && p.needle.length <= 3) {
    // whole-token match only, so 47 does not "appear" in postcode 95472
    const tokens = String(h).match(/\d+/g) ?? [];
    return tokens.includes(p.needle);
  }
  if (p.kind === "url") return h.split(/\s+/).includes(p.needle) || h.includes(p.needle);
  return h.includes(p.needle);
}

export type Outcome = "CORRECT" | "CORRECTLY_ABSENT" | "MISCLASSIFIED" | "LOST" | "FABRICATED" | "DUPLICATED";
export function classify(hay: Record<Dest, string>, text: string, expect: Dest, present: boolean):
    { outcome: Outcome; actual?: Dest[] } {
  const p = probe(text);
  const where = DESTS.filter((d) => found(hay, d, p));
  if (!present) return where.length ? { outcome: "FABRICATED", actual: where } : { outcome: "CORRECTLY_ABSENT" };
  if (where.length === 0) return { outcome: "LOST" };
  if (where.length > 1) return { outcome: "DUPLICATED", actual: where };
  return where[0] === expect ? { outcome: "CORRECT" } : { outcome: "MISCLASSIFIED", actual: where };
}
