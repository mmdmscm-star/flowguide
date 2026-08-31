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
 *  Three shapes count, all of them declarations:
 *    * a field whose LABEL announces privacy — "Private Note:", "Internal:"
 *    * a standalone marker heading a field or value — "INTERNAL ONLY — …"
 *    * an explicit instruction — "do not share", "not for the client"
 *  A descriptive adjective in a product name is none of them. */
//  THE COLON WAS DOING TOO MUCH WORK. A real import declared privacy in a
//  column headed `INTERNAL ONLY` and wrote values as `INTERNAL ONLY — Luis
//  said…`. Both are unmistakable declarations, and neither matched: an em dash
//  is not a colon, and the phrase list held `internal use only` but not
//  `internal only`. Two legitimately private notes were surfaced as problems.
//
//  So a declaration is now a MARKER plus a SEPARATOR, and which separators
//  count depends on how explicit the marker is.
//
//    STANDALONE markers say "private" and nothing else — `internal only`,
//    `private note`. They may head a field or a value, so a colon, a dash, or
//    simply the end of the field is enough.
//
//    BARE markers — `internal`, `confidential` — are ordinary English before
//    they are declarations ("internal staircase", "confidential to both
//    parties"). They still require a colon, exactly as before.
//
//  A marker must also BEGIN a field: line start, a delimiter, or an opening
//  quote. That is what keeps `internal` inside a sentence from declaring
//  anything, and it is why this widening is safe only now that authority is
//  read from one record's own text rather than a whole chunk's.
const FIELD_START = "(?:^|[\\n\\r,;\\t|])[ \\t]*[-•*]?[ \\t]*[\"'\u201c]?[ \\t]*";
/** Explicit enough to stand alone as a heading or a value prefix. */
const STANDALONE = new RegExp(
  FIELD_START +
  "(private[ \\t]+notes?|internal[ \\t]+notes?|internal[ \\t]+only|internal[ \\t]+use[ \\t]+only|confidential[ \\t]+notes?)" +
  "[ \\t]*(?:[\"'\u201d][ \\t]*)?(?::|[\u2014\u2013]|-[ \\t]|[,;\\r\\n]|$)", "im");
/** Ordinary words until punctuated as a label, so the colon stays required. */
const PRIVACY_LABEL = new RegExp(
  FIELD_START + "(private[ \\t]+notes?|internal[ \\t]+notes?|internal|confidential)[ \\t]*:", "im");
/** An instruction, wherever it appears in the record's own text.
 *
 *  `confidential` here once matched a colon OR A SPACE, so any sentence opening
 *  "confidential to both parties…" granted privacy over the record. Both
 *  legitimate shapes are covered above — `Confidential:` by the label, and
 *  `Confidential note` by the standalone — so the loose form is gone rather
 *  than kept for safety it was not providing. An over-grant hides client-facing
 *  content, which is the failure that costs the most. */
const PRIVACY_DIRECTIVE = /\b(do not share|don't share|not for the client|not for the family|for my reference|internal use only)\b/i;

/**
 * Does THIS RECORD'S OWN TEXT carry explicit authority to treat content as
 * private? Callers must pass one record's span — a whole chunk would let one
 * record's marker speak for its neighbours.
 */
export function sourceGrantsPrivacy(recordText: string): boolean {
  const t = String(recordText ?? "");
  return STANDALONE.test(t) || PRIVACY_LABEL.test(t) || PRIVACY_DIRECTIVE.test(t);
}

type Item = Record<string, unknown>;
const arr = (v: unknown) => (Array.isArray(v) ? [...v] : []);

export interface Enforcement {
  item: Item;
  applied: { claimId: string; action: string }[];
  /** Competing renderings of a governed specialized claim, removed from
   *  noncanonical fields. Telemetry: how often the model duplicates a fact it
   *  was given one home for. */
  stripped: { claimId: string; from: string; text: string; reason: string }[];
  /** Content removed from `notes` for want of source authority, PRESERVED here
   *  rather than deleted. It is ordinary source prose the model made private;
   *  it needs a decision, not a bin. */
  unresolvedNotes: { text: string; reason: string }[];
}

/** Apply the contract to ONE item, given that item's resolutions. */
export function enforceItem(
  item: Item, resolutions: Resolution[], claims: Claim[], opts: { privacyGranted: boolean },
): Enforcement {
  const next: Item = { ...item };
  const applied: { claimId: string; action: string }[] = [];
  const stripped: Enforcement["stripped"] = [];
  const unresolvedNotes: Enforcement["unresolvedNotes"] = [];
  const byId = new Map(claims.map((c) => [c.id, c]));

  // OCCURRENCE-AWARE SLOT ASSIGNMENT. Two claims can share a label — "Care
  // Costs" for assisted living and again for memory care — and each needs its
  // own row. Without this the second claim overwrites the first's slot and one
  // of two genuinely different facts disappears.
  const usedDetail = new Set<number>();
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
      const at = details.findIndex((d, ix) =>
        !usedDetail.has(ix) &&
        (locate({ details: [d] } as Record<string, unknown>, c.value).length > 0 ||
         canonicalLabel(String(d?.label ?? "")).toLowerCase() === label.toLowerCase()));
      const rendered = { label, value: safe };
      if (at >= 0) {
        usedDetail.add(at);
        const before = JSON.stringify(details[at]);
        details[at] = rendered;
        if (before !== JSON.stringify(rendered)) applied.push({ claimId: c.id, action: `details canonicalized: ${label}` });
      } else {
        usedDetail.add(details.length);
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
      const canon = canonicalValue(c.value, field);
      // ALREADY THERE, JUST WRITTEN DIFFERENTLY. "(707) 723-9250" and
      // "707-723-9250" are one fact; adding a second entry for the second
      // spelling makes the contact list depend on the model's formatting, which
      // is precisely what canonical rendering exists to prevent.
      const key = field === "phone" ? canon.replace(/\D/g, "") : canon.toLowerCase();
      const already = contacts.some((x) => {
        const v = String((x as Record<string, unknown>)?.[field] ?? "");
        return v && (field === "phone" ? v.replace(/\D/g, "") === key : v.toLowerCase() === key);
      });
      if (already) { applied.push({ claimId: c.id, action: `contacts already holds this ${field}` }); continue; }
      contacts.push({ name: canonicalLabel(c.label ?? "") || null, [field]: canon });
      next.contacts = contacts;
      applied.push({ claimId: c.id, action: `contacts += ${field}` });
    } else if (r.want === "address" && !String(next.address ?? "").trim()) {
      next.address = canonicalValue(c.value);
      applied.push({ claimId: c.id, action: "address set" });
    }
  }

  // SPECIALIZED DESTINATIONS ARE EXCLUSIVE.
  //
  // A governed claim with a specialized destination has ONE canonical home. A
  // competing rendering of that same claim in `details` is not extra
  // information — it is a second copy that can drift, and when it drifts it
  // reaches the recipient as an unsupported fact. The Ridge at Healdsburg
  // carried two different "Community Phone" details across two runs of the same
  // source; one of them was simply wrong.
  //
  // STRIPPING IS BOUNDED AND MUST BE PROVABLE. This is not licence to tidy
  // model-authored content:
  //   * the same claim rendered again        -> strip
  //   * the same claim LABEL with a conflicting value -> strip, because an
  //     unsupported competing fact is worse than a missing one
  //   * a detail carrying INDEPENDENT source-backed content as well -> keep the
  //     independent part, remove only the duplicated claim
  //   * identity not provable                -> leave it alone and account for it
  {
    const digits = (x: string) => String(x).replace(/\D/g, "");
    const squash = (x: string) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");
    const details = arr(next.details) as { label?: string; value?: string }[];
    const keep: typeof details = [];
    for (const d of details) {
      const dv = String(d?.value ?? ""), dl = canonicalLabel(String(d?.label ?? ""));
      let removed: { claimId: string; reason: string } | null = null;
      for (const r of resolutions) {
        if (!r.want || r.want === "details" || (r.outcome !== "ACCEPTED" && r.outcome !== "REPAIRED")) continue;
        const c = byId.get(r.claimId);
        if (!c) continue;
        const kind = kindOf(c.value);
        const sameValue = kind === "phone"
          ? digits(c.value).length >= 7 && digits(dv).includes(digits(c.value))
          : squash(c.value).length >= 6 && squash(dv).includes(squash(c.value));
        const sameLabel = Boolean(c.label) && dl.toLowerCase() === canonicalLabel(c.label!).toLowerCase();
        if (!sameValue && !sameLabel) continue;
        // Does this detail carry anything BEYOND the governed claim? If so the
        // independent part is preserved rather than deleted with it.
        const residue = dv.replace(new RegExp(c.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
        if (squash(residue).length >= 6 && sameValue) {
          keep.push({ label: d?.label, value: residue.replace(/\s+/g, " ").trim() });
          stripped.push({ claimId: c.id, from: "details", text: c.value, reason: "duplicate of a specialized claim; independent content preserved" });
          removed = { claimId: c.id, reason: "partial" };
          break;
        }
        removed = { claimId: c.id, reason: sameValue ? "duplicate rendering" : "conflicting value for the same governed claim" };
        stripped.push({ claimId: c.id, from: "details", text: `${d?.label ?? ""}: ${dv}`, reason: removed.reason });
        break;
      }
      if (!removed) keep.push(d);
    }
    next.details = keep;
  }

  // SPECIALIZED VALUES RENDER CANONICALLY WHEREVER THEY SIT.
  //
  // Which contact owns a phone number is model judgment, so nothing is moved or
  // restructured here. But the VALUE is a governed fact, and it must not read
  // differently depending on whether the model placed it or FlowGuide did —
  // "707-555-0101" and "(707) 555-0101" are the same fact and must render as
  // one. This normalizes in place and rearranges nothing.
  // DESTINATION-INTERNAL DEDUPE, applied to every specialized destination.
  // Contacts already did this; links and photos did not, so one governed URL
  // emitted twice by the model stayed twice and made the canonical destination
  // depend on model repetition. The same fact has one canonical home and one
  // entry in it.
  const seenUrl = new Set<string>();
  next.links = arr(next.links).map((l) => {
    const o = l as { url?: string };
    return o && typeof o === "object" && o.url ? { ...o, url: canonicalValue(String(o.url), "url") } : l;
  }).filter((l) => {
    const u = String((l as { url?: string })?.url ?? "").toLowerCase();
    if (!u) return true;
    if (seenUrl.has(`l:${u}`)) return false;
    seenUrl.add(`l:${u}`);
    return true;
  });
  next.photos = arr(next.photos).map((ph) =>
    typeof ph === "string" ? canonicalValue(ph, "url")
      : ph && typeof ph === "object" && (ph as { url?: string }).url
        ? { ...(ph as object), url: canonicalValue(String((ph as { url?: string }).url), "url") } : ph)
    .filter((ph) => {
      const u = (typeof ph === "string" ? ph : String((ph as { url?: string })?.url ?? "")).toLowerCase();
      if (!u) return true;
      if (seenUrl.has(`p:${u}`)) return false;
      seenUrl.add(`p:${u}`);
      return true;
    });
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
    // SURFACED, NOT DELETED. The ice-cream import put 13 "Why it made the list"
    // paragraphs into notes — prose plainly written FOR the recipient, which a
    // private field hides. Removing it from notes is right; discarding it is
    // not. It has no safe destination yet, so it becomes an explicit unresolved
    // item for the professional to place.
    unresolvedNotes.push({
      text: String(next.notes),
      reason: "recipient-intended prose placed in a private field with no source authority",
    });
    applied.push({ claimId: "-", action: "notes surfaced as unresolved — no source authority for privacy" });
    next.notes = "";
  }
  return { item: next, applied, stripped, unresolvedNotes };
}
