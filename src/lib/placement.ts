// PLACEMENT ACCOUNTING — where did a fact actually land, and where should it?
//
// The fact ledger answers "is this fact present anywhere". That is blind to the
// production symptom, which is a fact that IS present and is in the wrong field.
// This module answers the other half: which field holds it, and is that field
// defensible for a fact of that kind.
//
// THREE VERDICTS, NOT TWO. A binary correct/wrong forces a judgement the data
// often does not support: "Notes: the director was candid about pricing" holds a
// price and belongs in notes. So a placement is only called WRONG when the
// intended destination is stated — by the production prompts, not by me — and
// everything else is returned as NEEDS_JUDGEMENT for a human. A scorer that
// guesses confidently produces a number nobody can act on.
import { probe, squash } from "./fact-match.ts";

export type Field =
  | "title" | "address" | "description" | "notes"
  | "details" | "links" | "photos" | "contacts";
export const FIELDS: Field[] = ["title", "address", "description", "notes", "details", "links", "photos", "contacts"];

export type Verdict = "CORRECT" | "MISPLACED" | "NEEDS_JUDGEMENT" | "ABSENT";

/** Where the value appears in this item. More than one field means DUPLICATED. */
export function locate(item: Record<string, unknown>, value: string): Field[] {
  const p = probe(value);
  const hit: Field[] = [];
  const has = (hay: unknown): boolean => {
    if (hay == null) return false;
    if (typeof hay === "string") return matchIn(hay, value, p.kind);
    if (Array.isArray(hay)) return hay.some(has);
    if (typeof hay === "object") return Object.values(hay as object).some(has);
    return false;
  };
  for (const f of FIELDS) if (has(item[f])) hit.push(f);
  return hit;
}

function matchIn(hay: string, value: string, kind: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (kind === "url" || kind === "email") return squash(hay).includes(squash(v));
  if (kind === "phone") return hay.replace(/\D/g, "").includes(v.replace(/\D/g, ""));
  return squash(hay).includes(squash(v));
}

// ---------------------------------------------------------------------------
// THE CONTRACT. Every rule below is quoted from a production prompt in
// ai-prompts.ts. Nothing here is my opinion about where a fact ought to go —
// if a rule is not stated to the model, a fact is NEEDS_JUDGEMENT, not wrong.
//
//   ITEM_FIELDS   URL_RULES   TYPE_GUIDANCE["senior-placement"]
//   "full street addresses -> address"        (packet prompts only)
//   "monthly cost, care level, memory care, pet policy as details"  (packet only)
//   "tour notes -> notes"                                            (packet only)
//   "keep every person + their own phone/email"                      (both)
//   "PHOTO/IMAGE -> photos", "MAP -> links", "ALL OTHER -> links"    (both)
// ---------------------------------------------------------------------------
export interface Rule { id: string; expect: Field; statedIn: "both" | "packet-only"; }

/** The destination the prompts state for this fact, or null if they state none. */
export function intendedField(opts: { label?: string; value: string }): Rule | null {
  const v = opts.value.trim();
  const k = probe(v).kind;

  if (k === "url") {
    return /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(v)
      ? { id: "url:image", expect: "photos", statedIn: "both" }
      : { id: "url:other", expect: "links", statedIn: "both" };
  }
  if (k === "email") return { id: "contact:email", expect: "contacts", statedIn: "both" };
  if (k === "phone") return { id: "contact:phone", expect: "contacts", statedIn: "both" };

  const label = (opts.label ?? "").toLowerCase();
  if (!label) return null;

  // TYPE_GUIDANCE, senior placement. STATED ONLY IN THE PACKET PROMPTS — the
  // Library import prompt carries none of it, which is the asymmetry this
  // investigation is testing.
  if (/\b(cost|fee|rate|price|pricing|deposit|monthly|per month)\b/.test(label))
    return { id: "guidance:cost", expect: "details", statedIn: "packet-only" };
  if (/\b(care|memory care|level)\b/.test(label))
    return { id: "guidance:care-level", expect: "details", statedIn: "packet-only" };
  if (/\bpet\b/.test(label))
    return { id: "guidance:pet-policy", expect: "details", statedIn: "packet-only" };

  return null;
}

export interface Placed {
  value: string;
  label?: string;
  found: Field[];
  duplicated: boolean;
  rule: Rule | null;
  verdict: Verdict;
}

/** Judge one fact against one item. */
export function judge(item: Record<string, unknown>, fact: { value: string; label?: string }): Placed {
  const found = locate(item, fact.value);
  const rule = intendedField({ label: fact.label, value: fact.value });
  let verdict: Verdict;
  if (found.length === 0) verdict = "ABSENT";
  else if (!rule) verdict = "NEEDS_JUDGEMENT";
  else if (found.includes(rule.expect)) verdict = "CORRECT";
  else verdict = "MISPLACED";
  return { value: fact.value, label: fact.label, found, duplicated: found.length > 1, rule, verdict };
}
