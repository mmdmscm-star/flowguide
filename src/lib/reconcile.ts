// RECONCILIATION — the enforcement half of "the model proposes, FlowGuide
// enforces". OBSERVE-ONLY: it computes outcomes and returns them. It moves
// nothing, writes nothing and is read by nothing yet.
//
// Every claim resolves to exactly one outcome, and the three counts must sum to
// the number of claims. That identity is asserted, because an accounting layer
// that can lose track of its own claims is worse than none.
import { type Claim, type Fragment, type ParseResult, specializedValueKind } from "./claim-parser.ts";
import { locate, survives, type Field } from "./placement.ts";
import { squash, probe } from "./fact-match.ts";

// FOUR OUTCOMES, NO DROPPED STATE.
//
//   detected   = attributed + attribution_unresolved
//   attributed = accepted + repaired + content_unresolved
//
// Every detected source claim ends as exactly one of these. A claim that cannot
// be attributed is not a claim that vanished; it is a claim in a named state.
export type Outcome = "ACCEPTED" | "REPAIRED" | "CONTENT_UNRESOLVED" | "ATTRIBUTION_UNRESOLVED";
export interface Resolution {
  claimId: string;
  label?: string;
  value: string;
  rung: 1 | 2 | 3;
  want: Field | null;
  found: Field[];
  outcome: Outcome;
  why: string;
}
export interface Reconciliation {
  resolutions: Resolution[];
  fragments: Fragment[];
  /** Fragments whose content does NOT appear anywhere in the item. A fragment
   *  the model placed sensibly — a description paragraph that became the
   *  description — is accounted for and is not an exception. Only genuinely
   *  unplaced source content holds a proposal back. */
  orphaned: Fragment[];
  counts: { claims: number; accepted: number; repaired: number; unresolved: number;
            fragments: number; orphaned: number };
}

const IMAGE = /\.(jpe?g|png|gif|webp|avif)(\?|$)/i;
const MAP = /(google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.app\.goo\.gl)/i;
// A street address, recognised in the SOURCE. Rung 1 applies only when the
// source itself makes the address identifiable — a name and address run
// together on one line is the model's to separate, not ours to guess.
const ADDRESS = /\b(\d{1,6})\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)*?)\s+(St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Blvd|Boulevard|Ln|Lane|Way|Ct|Court|Pl|Place|Ter|Terrace|Cir|Circle)\b\.?/;

/** Rung 1: does this claim have a specialized source-backed destination? */
function specialized(c: Claim): { want: Field; why: string } | null {
  const kind = specializedValueKind(c);
  if (kind === "email") return { want: "contacts", why: "email → contacts" };
  if (kind === "phone") return { want: "contacts", why: "phone → contacts" };
  if (kind === "url") {
    if (IMAGE.test(c.value)) return { want: "photos", why: "image URL → photos" };
    if (MAP.test(c.value)) return { want: "links", why: "map URL → links" };
    return { want: "links", why: "URL → links" };
  }
  if (c.kind === "labelled" && /^address$/i.test(c.label ?? "")) return { want: "address", why: "labelled address → address" };
  if (c.kind === "labelled" && ADDRESS.test(c.value) && !/\$/.test(c.value))
    return { want: "address", why: "source-recognised street address → address" };
  return null;
}

/** ADDRESS IS NOT MATCHED BY EXACT STRING. A community's address is legitimately
 *  reformatted — "1200 Example Rd, Santa Rosa CA 95401" may be stored with or
 *  without the ZIP, the state spelled out, the comma moved. Requiring equality
 *  would report a correctly-placed address as missing. Provenance is what
 *  matters: the street number and street name must both survive. */
function addressPresent(item: Record<string, unknown>, value: string): Field[] {
  const m = ADDRESS.exec(value);
  const hay = squash(String(item.address ?? ""));
  if (m) {
    // Street NUMBER and street NAME must both survive. The suffix deliberately
    // does not: "Rd" and "Road" are the same address, and comparing suffixes
    // fails exactly the reformatting this check exists to tolerate.
    const num = m[1], name = squash(m[2]);
    if (hay.includes(num) && name && hay.includes(name)) return ["address"];
  }
  return locate(item, value);
}

/** Every detail-ish slot in the proposal, as matchable text. Occurrence-aware:
 *  each slot may satisfy at most ONE pricing claim, so a repeated amount cannot
 *  discharge two different source facts. */
function priceSlots(item: Record<string, unknown> | null): { text: string; used: boolean }[] {
  if (!item) return [];
  const out: { text: string; used: boolean }[] = [];
  for (const d of (item.details as { label?: string; value?: string }[]) ?? [])
    out.push({ text: `${d?.label ?? ""} ${d?.value ?? ""}`, used: false });
  for (const k of ["description", "notes", "title"] as const)
    if (item[k]) out.push({ text: String(item[k]), used: false });
  return out;
}
const DESC_STOP = new Set(["the", "a", "an", "of", "and", "or", "for", "per", "from", "to", "if", "available", "starting", "at"]);
const descTokens = (s: string) =>
  (s.toLowerCase().match(/[a-z]+/g) ?? []).filter((t) => t.length > 2 && !DESC_STOP.has(t));

/** A pricing claim is satisfied when its immutable anchors agree: every amount
 *  present, the unit present if the source stated one, and enough descriptor
 *  tokens shared. Wording and order are NOT required — the model legitimately
 *  rewrites "$4,090/month One Bedroom" as "One Bedroom | $4,090/month". */
function matchPricing(c: Claim, slots: { text: string; used: boolean }[]): number {
  const a = c.anchors;
  if (!a) return -1;
  const want = descTokens(a.descriptor);
  const need = want.length === 0 ? 0 : want.length === 1 ? 1 : Math.max(1, Math.ceil(want.length * 0.5));
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s.used) continue;
    const digits = (s.text.match(/\d[\d,]*/g) ?? []).map((x) => x.replace(/\D/g, ""));
    if (!a.amounts.every((amt) => digits.includes(amt))) continue;
    if (a.unit && !new RegExp(`\\b${a.unit}`, "i").test(s.text)) continue;
    const have = new Set(descTokens(s.text));
    if (want.filter((t) => have.has(t)).length < need) continue;
    s.used = true;
    return i;
  }
  return -1;
}

export function reconcile(parsed: ParseResult, item: Record<string, unknown> | null): Reconciliation {
  const resolutions: Resolution[] = [];
  const slots = priceSlots(item);
  for (const c of parsed.claims) {
    if (c.kind === "pricing") {
      const hit = matchPricing(c, slots);
      resolutions.push({
        claimId: c.id, label: c.anchors?.descriptor, value: c.value, rung: 2,
        want: "details", found: hit >= 0 ? ["details"] : [],
        outcome: hit >= 0 ? "ACCEPTED" : "REPAIRED",
        why: hit >= 0 ? "pricing anchors agree (reordering tolerated)" : "priced fact not found in the proposal",
      });
      continue;
    }
    const spec = specialized(c);
    const found = !item ? []
      : spec?.want === "address" ? addressPresent(item, c.value)
      : locate(item, c.value);

    if (spec) {
      const ok = found.includes(spec.want);
      resolutions.push({
        claimId: c.id, label: c.label, value: c.value, rung: 1, want: spec.want, found,
        outcome: ok ? "ACCEPTED" : found.length ? "REPAIRED" : "REPAIRED",
        why: ok ? spec.why : `${spec.why} — found in ${found.length ? found.join("+") : "nothing"}`,
      });
      continue;
    }
    if (c.kind === "labelled") {
      // RUNG 2. Every labelled claim, whatever its value looks like. Value shape
      // may inform rendering; it does not decide preservation.
      const ok = found.includes("details");
      resolutions.push({
        claimId: c.id, label: c.label, value: c.value, rung: 2, want: "details", found,
        outcome: ok ? "ACCEPTED" : "REPAIRED",
        why: ok ? "labelled → details" : `labelled → details — found in ${found.length ? found.join("+") : "nothing"}`,
      });
      continue;
    }
    resolutions.push({ claimId: c.id, value: c.value, rung: 3, want: null, found,
      outcome: "CONTENT_UNRESOLVED", why: "no deterministic destination" });
  }

  // PRESENCE-TOLERANT, STILL DETERMINISTIC.
  //
  // A prefix comparison called a fragment orphaned whenever the model reworded
  // it — and rewording is most of what the model legitimately does. The source
  // line "Vine Ridge Senior Living 247 Treadway Dr. Cloverdale, CA 95425" is
  // fully present once split into a title and an address, and holding a record
  // for review over that is a limitation of the matcher, not real ambiguity.
  //
  // A fragment is orphaned only when its own content is genuinely missing:
  // its numbers are gone, or too few of its meaningful tokens survive.
  const orphaned = parsed.fragments.filter((f) => {
    if (f.reason === "label with no value") return false;   // there is no content to lose
    // GENUINE AMBIGUITY IS NOT SETTLED BY PRESENCE. When a priced line's
    // descriptor cannot be resolved, the amount is usually present in the
    // proposal — paired with SOME descriptor. The open question is whether it is
    // paired with the RIGHT one, and no presence test can answer that. These
    // always surface; that is what the review state is for.
    if (f.reason === "priced line whose descriptor cannot be resolved") return true;
    const t = squash(f.text);
    if (t.length < 12) return false;
    if (!item) return true;
    const nums = f.text.match(/\d[\d,]*/g)?.map((x) => x.replace(/\D/g, "")).filter((x) => x.length >= 3) ?? [];
    const hayNums = JSON.stringify(item).match(/\d[\d,]*/g)?.map((x) => x.replace(/\D/g, "")) ?? [];
    if (nums.length && nums.every((n) => hayNums.includes(n))) return false;
    return !survives(item, f.text);
  });

  const counts = {
    orphaned: orphaned.length,
    claims: parsed.claims.length,
    accepted: resolutions.filter((r) => r.outcome === "ACCEPTED").length,
    repaired: resolutions.filter((r) => r.outcome === "REPAIRED").length,
    unresolved: resolutions.filter((r) => r.outcome === "CONTENT_UNRESOLVED").length,
    fragments: parsed.fragments.length,
  };
  // The identity that makes this an accounting layer rather than a heuristic.
  if (counts.accepted + counts.repaired + counts.unresolved !== counts.claims)
    throw new Error(`reconciliation lost a claim: ${JSON.stringify(counts)}`);
  return { resolutions, fragments: parsed.fragments, orphaned, counts };
}

/** Would this proposal materialize? Not while it holds unaccounted source content. */
export function blocksMaterialization(r: Reconciliation): boolean {
  return r.counts.unresolved > 0 || r.counts.orphaned > 0;
}
