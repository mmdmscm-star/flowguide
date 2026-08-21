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
// ADDITIVE, NOT DESTRUCTIVE. Enforcement ensures a claim is PRESENT in its
// contract destination. It does not delete the model's own placements, because
// a wrong deletion is unrecoverable while a duplicate is visible and fixable —
// with the single exception of the privacy rule, where leaving the content in
// place is the harm.
import type { Claim } from "./claim-parser.ts";
import type { Resolution } from "./reconcile.ts";

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

  for (const r of resolutions) {
    if (r.outcome !== "REPAIRED" || !r.want) continue;
    const c = byId.get(r.claimId);
    if (!c) continue;

    if (r.want === "details") {
      const details = arr(next.details) as { label?: string; value?: string }[];
      details.push({ label: c.label ?? "", value: c.value });
      next.details = details;
      applied.push({ claimId: c.id, action: `details += ${c.label}` });
    } else if (r.want === "links" || r.want === "photos") {
      const list = arr(next[r.want]);
      list.push(r.want === "photos" ? c.value : { url: c.value, label: c.label ?? "Website" });
      next[r.want] = list;
      applied.push({ claimId: c.id, action: `${r.want} += url` });
    } else if (r.want === "contacts") {
      // WHICH contact a phone or email belongs to is model judgment. Enforcement
      // only guarantees the value is not lost, so an unattached value becomes
      // its own contact entry rather than being guessed onto an existing one.
      const contacts = arr(next.contacts) as Record<string, unknown>[];
      const field = /@/.test(c.value) ? "email" : "phone";
      contacts.push({ name: c.label ?? null, [field]: c.value });
      next.contacts = contacts;
      applied.push({ claimId: c.id, action: `contacts += ${field}` });
    } else if (r.want === "address" && !String(next.address ?? "").trim()) {
      next.address = c.value;
      applied.push({ claimId: c.id, action: "address set" });
    }
  }

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
