// THE RULER — one scorer, used identically on all three arms.
//
// It never repairs anything. Every number here describes what the MODEL
// proposed; the deterministic contract is asked "what would you have had to do
// to this?" and the answer is recorded, not applied. A would-be REPAIRED is a
// model miss, not a success.
import { parseClaims } from "../../../src/lib/claim-parser.ts";
import { recordEnvelopes, attributeAll, bindByProvenance } from "../../../src/lib/attribution.ts";
import { reconcile } from "../../../src/lib/reconcile.ts";
import { sourceGrantsPrivacy } from "../../../src/lib/enforce.ts";

export type Item = Record<string, any>;

/** Pull every item out of whatever shape the model returned. */
export function itemsOf(result: unknown): Item[] {
  const r = (result ?? {}) as { items?: unknown; sections?: { items?: unknown }[] };
  return [
    ...(Array.isArray(r.items) ? r.items : []),
    ...(Array.isArray(r.sections) ? r.sections.flatMap((s) => (Array.isArray(s?.items) ? s.items : [])) : []),
  ].filter((x): x is Item => Boolean(x) && typeof x === "object");
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const digits = (s: unknown) => String(s ?? "").replace(/\D+/g, "");

/** SPECIFICS ONLY. Prose is paraphrased by design, so scoring a description as
 *  "fabricated" would measure the task rather than a failure at it. URLs,
 *  emails, phones and amounts are copied or they are wrong. */
export function specifics(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) out.push(m[0]);
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) out.push(m[0]);
  for (const m of text.matchAll(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g)) out.push(m[0]);
  for (const m of text.matchAll(/\$[\d,]+(?:\.\d{2})?/g)) out.push(m[0]);
  return out;
}
const specKey = (s: string) =>
  /^https?:/i.test(s) ? norm(s.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, ""))
  : /@/.test(s) ? norm(s)
  : /^\$/.test(s) ? "money:" + digits(s)
  : "num:" + digits(s);

/** Where a value ended up, in the model's proposal. */
export const DESTS = ["title", "address", "description", "notes", "details", "links", "photos", "contacts"] as const;
export type Dest = (typeof DESTS)[number];

export function destinationsOf(it: Item): Record<Dest, string> {
  const j = (v: unknown) => JSON.stringify(v ?? "");
  return {
    title: String(it.title ?? ""), address: String(it.address ?? ""),
    description: String(it.description ?? ""), notes: String(it.notes ?? ""),
    details: j(it.details), links: j(it.links), photos: j(it.photos), contacts: j(it.contacts),
  };
}

export interface Score {
  claimsInSource: number;
  itemsProposed: number;
  recordsInSource: number;
  bound: number;
  attributionUnresolved: number;   // records the contract could not bind to an item
  accepted: number;                // model already had it right
  wouldBeRepaired: number;         // model had it wrong; enforcement WOULD have fixed it
  contentUnresolved: number;
  sourceUnresolved: number;
  omissions: number;               // source specifics absent from the whole proposal
  fabrications: number;            // proposal specifics absent from the source
  unauthorizedNotes: number;       // items with notes where the source grants no privacy
  malformed: number;               // set by the caller
  /** value-key -> destination, for cross-repetition disagreement scoring. */
  placement: Record<string, Dest>;
  /** record index -> content hash, for whole-item consistency. */
  itemHash: Record<number, string>;
}

export function score(source: string, items: Item[], malformed: number): Score {
  const env = recordEnvelopes(source);
  const parsed = parseClaims(source, 0);
  const a = attributeAll(parsed.claims, parsed.ambiguous, parsed.fragments, env, 0);
  const binding = env ? bindByProvenance(env, source, items) : { bound: new Map<number, Item>() };
  const bound = binding.bound as Map<number, Item>;

  let accepted = 0, wouldBeRepaired = 0, contentUnresolved = 0, sourceUnresolved = 0;
  let attributionUnresolved = a.unattributedClaims.length + a.unattributedAmbiguous.length;
  const itemHash: Record<number, string> = {};

  for (const [rec, g] of a.byRecord) {
    const item = bound.get(rec);
    if (!item) { attributionUnresolved += g.claims.length + g.ambiguous.length; continue; }
    const res = reconcile({ claims: g.claims, ambiguous: g.ambiguous, fragments: g.fragments }, item);
    accepted += res.counts.accepted;
    wouldBeRepaired += res.counts.repaired;
    contentUnresolved += res.counts.unresolved;
    sourceUnresolved += res.counts.sourceUnresolved;
    // Whole-item consistency across repetitions: the rendered content of the
    // item bound to this record, key-order independent.
    itemHash[rec] = JSON.stringify(Object.entries(destinationsOf(item)).sort());
  }

  // ---- omissions and fabrications, on specifics ---------------------------
  const srcKeys = new Set(specifics(source).map(specKey));
  const proposalText = JSON.stringify(items);
  const propKeys = new Set(specifics(proposalText).map(specKey));
  let omissions = 0;
  for (const k of srcKeys) if (!propKeys.has(k)) omissions++;
  let fabrications = 0;
  for (const k of propKeys) if (!srcKeys.has(k)) fabrications++;

  // ---- placement, for destination disagreement ----------------------------
  const placement: Record<string, Dest> = {};
  for (const it of items) {
    const d = destinationsOf(it);
    for (const raw of specifics(JSON.stringify(it))) {
      const key = specKey(raw);
      for (const dest of DESTS) {
        if (specifics(d[dest]).some((x) => specKey(x) === key)) { placement[key] = dest; break; }
      }
    }
  }

  const granted = sourceGrantsPrivacy(source);
  const unauthorizedNotes = granted ? 0 : items.filter((i) => String(i.notes ?? "").trim().length > 0).length;

  return {
    claimsInSource: parsed.claims.length,
    itemsProposed: items.length,
    recordsInSource: env?.length ?? 0,
    bound: bound.size,
    attributionUnresolved, accepted, wouldBeRepaired, contentUnresolved, sourceUnresolved,
    omissions, fabrications, unauthorizedNotes, malformed,
    placement, itemHash,
  };
}

/** Across repetitions of ONE arm: how often did the same source value land in
 *  a different destination, and how often was a whole item identical? */
export function acrossReps(scores: Score[]) {
  const keys = new Set(scores.flatMap((s) => Object.keys(s.placement)));
  let disagreements = 0;
  for (const k of keys) {
    const seen = new Set(scores.map((s) => s.placement[k]).filter(Boolean));
    if (seen.size > 1) disagreements++;
  }
  const recs = new Set(scores.flatMap((s) => Object.keys(s.itemHash).map(Number)));
  let identical = 0, compared = 0;
  for (const r of recs) {
    const hs = scores.map((s) => s.itemHash[r]).filter(Boolean);
    if (hs.length < scores.length) continue;   // not present in every rep
    compared++;
    if (new Set(hs).size === 1) identical++;
  }
  return { destinationDisagreements: disagreements, placedValues: keys.size,
    itemsIdenticalAcrossReps: identical, itemsCompared: compared };
}
