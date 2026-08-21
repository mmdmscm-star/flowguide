// STEP 3 — ENFORCEMENT. The model proposes; this makes the contract true.
//
// FLAGGED OFF BY DEFAULT. `contractEnforcementEnabled()` is the only switch, and
// with it off this module is never called and ingestion behaves exactly as it
// does today.
//
// SCOPE IS THE HORIZONTAL SUBSET ONLY — the part the cross-vertical audit proved
// carries no industry vocabulary:
//
//   * specialized source-backed destinations (contacts, links, photos, address)
//   * explicit labelled source claims -> details
//   * the privacy rule: a note needs source authority
//
// Unlabelled money is NOT repaired. It is recognized, accounted for as
// SOURCE_UNRESOLVED, and left for the professional. A positional/run-shape
// approach is a separate experiment and must prove itself across verticals
// before it is allowed anywhere near this file.
//
// FOR A GOVERNED CLAIM, THE SOURCE OWNS THE MEANING AND FLOWGUIDE OWNS THE
// RENDERING. The model owns neither, so its paraphrase is replaced by the
// canonical form — otherwise ACCEPTED and REPAIRED produce two different facts
// from one source claim, which is exactly the non-determinism this exists to
// end. ACCEPTED and REPAIRED remain as TELEMETRY: they record whether the model
// got there on its own, and they no longer change what is rendered.
//
// Outside the governed subset enforcement stays ADDITIVE and hands-off. It does
// not touch titles, descriptions, unresolved narrative or unlabelled pricing,
// and it deletes nothing there — a wrong deletion is unrecoverable while a
// duplicate is visible. The privacy rule is the one place content is removed,
// because leaving it is the harm.
import type { Claim } from "./claim-parser.ts";
import type { Resolution } from "./reconcile.ts";
import { canonicalLabel, canonicalValue, meaningPreserved, type ValueKind } from "./canonical.ts";
import { locate } from "./placement.ts";
import { probe } from "./fact-match.ts";

export function contractEnforcementEnabled(): boolean {
  return process.env.FLOWGUIDE_ENFORCE_CONTRACT === "1";
}

/** Does the source carry explicit authority to treat anything as private?
 *
 *  AUTHORITY MUST BE DECLARED, NOT MENTIONED. An earlier version matched the
 *  word "private" anywhere — which "Memory Care Private Studio" and "Private
 *  Dining" both satisfy. A room type was therefore granting privacy authority
 *  over a whole record, and the note survived because of it. That is the
 *  vertical-vocabulary failure again, wearing a policy costume: the rule looked
 *  horizontal and was decided by industry nouns.
 *
 *  Two shapes count, both of them declarations:
 *    * a field whose LABEL announces privacy — "Private Note:", "Internal:"
 *    * an explicit instruction — "do not share", "not for the client"
 *  A descriptive adjective in a product name is neither. */
const PRIVACY_LABEL = /^[ \t]*[-•*]?[ \t]*(private[ \t]+note|private[ \t]+notes|internal[ \t]+note|internal[ \t]+notes|internal|confidential)[ \t]*:/im;
const PRIVACY_DIRECTIVE = /\b(do not share|don't share|not for the client|not for the family|for my reference|internal use only|confidential[: ])/i;
export function sourceGrantsPrivacy(segmentText: string): boolean {
  const t = String(segmentText ?? "");
  return PRIVACY_LABEL.test(t) || PRIVACY_DIRECTIVE.test(t);
}

type Item = Record<string, unknown>;
const arr = (v: unknown) => (Array.isArray(v) ? [...v] : []);

export interface Enforcement {
  item: Item;
  applied: { claimId: string; action: string }[];
}

/** Apply the contract to ONE item, given that item's resolutions. */
export function enforceItem(
  item: Item, resolutions: Resolution[], claims: Claim[], opts: { privacyGranted: boolean },
): Enforcement {
  const next: Item = { ...item };
  const applied: { claimId: string; action: string }[] = [];
  const byId = new Map(claims.map((c) => [c.id, c]));

  const kindOf = (v: string): ValueKind => {
    const k = probe(v).kind;
    return k === "url" || k === "email" || k === "phone" ? k : "text";
  };

  for (const r of resolutions) {
    // GOVERNED means rung 1 or 2 — a claim with a deterministic destination.
    // Both ACCEPTED and REPAIRED are materialized, from the same canonical form.
    if (r.outcome !== "ACCEPTED" && r.outcome !== "REPAIRED") continue;
    if (!r.want) continue;
    const c = byId.get(r.claimId);
    if (!c) continue;

    if (r.want === "details") {
      const label = canonicalLabel(c.label ?? "");
      const value = canonicalValue(c.value, kindOf(c.value));
      // The transform must not have changed the fact. This is an assertion
      // about the transform, not a decision about the value: if it ever fires,
      // canonicalization is wrong and the source text stands.
      const safe = meaningPreserved(c.value, value) ? value : c.value.trim();
      const details = arr(next.details) as { label?: string; value?: string }[];
      // Replace the model's own rendering OF THIS CLAIM, wherever it put it,
      // and leave every other detail alone — including elaborations the model
      // derived from ungoverned content.
      const at = details.findIndex((d) =>
        locate({ details: [d] } as Record<string, unknown>, c.value).length > 0 ||
        canonicalLabel(String(d?.label ?? "")).toLowerCase() === label.toLowerCase());
      const rendered = { label, value: safe };
      if (at >= 0) {
        const before = JSON.stringify(details[at]);
        details[at] = rendered;
        if (before !== JSON.stringify(rendered)) applied.push({ claimId: c.id, action: `details canonicalized: ${label}` });
      } else {
        details.push(rendered);
        applied.push({ claimId: c.id, action: `details += ${label}` });
      }
      next.details = details;
    } else if (r.outcome !== "REPAIRED") {
      // Specialized destinations: only act when something is actually missing.
      continue;
    } else if (r.want === "links" || r.want === "photos") {
      const list = arr(next[r.want]);
      const url = canonicalValue(c.value, "url");
      list.push(r.want === "photos" ? url : { url, label: canonicalLabel(c.label ?? "") || "Website" });
      next[r.want] = list;
      applied.push({ claimId: c.id, action: `${r.want} += url` });
    } else if (r.want === "contacts") {
      // WHICH contact a phone or email belongs to is model judgment. Enforcement
      // only guarantees the value is not lost, so an unattached value becomes
      // its own contact entry rather than being guessed onto an existing one.
      const contacts = arr(next.contacts) as Record<string, unknown>[];
      const field = /@/.test(c.value) ? "email" : "phone";
      contacts.push({ name: canonicalLabel(c.label ?? "") || null, [field]: canonicalValue(c.value, field) });
      next.contacts = contacts;
      applied.push({ claimId: c.id, action: `contacts += ${field}` });
    } else if (r.want === "address" && !String(next.address ?? "").trim()) {
      next.address = canonicalValue(c.value);
      applied.push({ claimId: c.id, action: "address set" });
    }
  }

  // SPECIALIZED VALUES RENDER CANONICALLY WHEREVER THEY SIT.
  //
  // Which contact owns a phone number is model judgment, so nothing is moved or
  // restructured here. But the VALUE is a governed fact, and it must not read
  // differently depending on whether the model placed it or FlowGuide did —
  // "707-555-0101" and "(707) 555-0101" are the same fact and must render as
  // one. This normalizes in place and rearranges nothing.
  next.links = arr(next.links).map((l) => {
    const o = l as { url?: string };
    return o && typeof o === "object" && o.url ? { ...o, url: canonicalValue(String(o.url), "url") } : l;
  });
  next.photos = arr(next.photos).map((ph) =>
    typeof ph === "string" ? canonicalValue(ph, "url")
      : ph && typeof ph === "object" && (ph as { url?: string }).url
        ? { ...(ph as object), url: canonicalValue(String((ph as { url?: string }).url), "url") } : ph);
  next.contacts = arr(next.contacts).map((ct) => {
    const o = ct as Record<string, unknown>;
    if (!o || typeof o !== "object") return ct;
    const out: Record<string, unknown> = { ...o };
    if (typeof o.email === "string" && o.email) out.email = canonicalValue(o.email, "email");
    if (typeof o.phone === "string" && o.phone) out.phone = canonicalValue(o.phone, "phone");
    if (typeof o.website === "string" && o.website) out.website = canonicalValue(o.website, "url");
    return out;
  });

  // THE PRIVACY RULE. Without source authority a note may not stand: the field
  // is private, so anything left there is content the recipient will never see.
  // The claims it held have already been placed by their own rung above, so
  // clearing it removes a duplicate, not a fact.
  if (!opts.privacyGranted && String(next.notes ?? "").trim()) {
    applied.push({ claimId: "-", action: "notes cleared — no source authority for privacy" });
    next.notes = "";
  }
  return { item: next, applied };
}
