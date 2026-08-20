// Fields that require explicit source evidence.
//
// Corpus v2 found a REPRODUCIBLE fabrication: a record with no website in its
// source produced one in all three runs, almost certainly synthesised from the
// contact's email domain. This checks the output against the segment rather than
// asking the model not to do it — the model is not the thing being trusted.
//
// OBSERVE ONLY at this stage: it reports what is unbacked and strips nothing.
//
// SCOPE IS DELIBERATELY NARROW. Only fields whose values must appear literally:
// urls, photos, contact websites, emails and phones. `address` and `title` are
// excluded because both are legitimately reformatted and normalised, and holding
// them to literal presence would produce exactly the false-positive class
// media-ledger.ts warns about — a check that blocks work for non-failures.

import { digitsOf, urlKey } from "./fact-match.ts";

export type BackedField = "links.url" | "photos.url" | "contacts.website" | "contacts.email" | "contacts.phone";
export interface Unbacked { field: BackedField; value: string; itemIndex: number; itemTitle: string }

export function findUnbacked(segmentText: string, items: Record<string, unknown>[]): Unbacked[] {
  const src = String(segmentText ?? "");
  const srcUrls = new Set((src.match(/https?:\/\/[^\s"'<>)\]]+/gi) ?? []).map(urlKey));
  const srcEmails = new Set((src.match(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g) ?? []).map((e) => e.toLowerCase()));
  const srcDigits = digitsOf(src);

  const out: Unbacked[] = [];
  items.forEach((item, itemIndex) => {
    const title = String(item.title ?? "");
    const add = (field: BackedField, value: string) => out.push({ field, value, itemIndex, itemTitle: title });

    for (const l of (item.links as { url?: string }[] ?? []))
      if (l?.url && !srcUrls.has(urlKey(l.url))) add("links.url", l.url);
    for (const p of (item.photos as unknown[] ?? [])) {
      const u = typeof p === "string" ? p : (p as { url?: string })?.url;
      if (u && !srcUrls.has(urlKey(u))) add("photos.url", u);
    }
    for (const c of (item.contacts as Record<string, string>[] ?? [])) {
      if (c?.website && !srcUrls.has(urlKey(c.website))) add("contacts.website", c.website);
      if (c?.email && !srcEmails.has(c.email.toLowerCase())) add("contacts.email", c.email);
      // A phone is backed if its digits appear anywhere in the segment: the model
      // legitimately reformats (707) 555-0100 to 707-555-0100.
      if (c?.phone && digitsOf(c.phone).length >= 10 && !srcDigits.includes(digitsOf(c.phone)))
        add("contacts.phone", c.phone);
    }
  });
  return out;
}
