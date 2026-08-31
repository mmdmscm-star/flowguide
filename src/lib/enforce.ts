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
import { factTokens, privateRegions } from "./notes-provenance.ts";

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
 * Does THIS TEXT carry an explicit declaration of privacy?
 *
 * Callers pass the narrowest span they can prove: one FIELD where the source is
 * structured, one record otherwise. A whole chunk would let one record's marker
 * speak for its neighbours; a whole record would let one field's marker speak
 * for the others beside it.
 */
export function sourceGrantsPrivacy(text: string): boolean {
  const t = String(text ?? "");
  return STANDALONE.test(t) || PRIVACY_LABEL.test(t) || PRIVACY_DIRECTIVE.test(t);
}

/** A column HEADING that announces privacy — the cell is the marker and
 *  essentially nothing else.
 *
 *  Deliberately stricter than sourceGrantsPrivacy. A heading names what the
 *  column is for; a value that merely opens with the marker is one record's
 *  content. Reading `INTERNAL ONLY — Luis said…` as a heading would authorise
 *  that column in EVERY row, which is the chunk-scope mistake wearing a
 *  different hat. */
/*  A LIST OF EXACT PHRASES WAS THE WRONG SHAPE. The event-planner file names
 *  its column `Private / Internal Notes` — an entirely ordinary heading that
 *  matched nothing, because the pattern wanted `private` and `notes` adjacent.
 *  That column therefore authorised NOTHING, in every row, and the only reason
 *  one venue's note was correctly kept private was an inline "do not share"
 *  sentence that happened to be in its text.
 *
 *  So the rule is structural instead: a heading authorises when EVERY word in
 *  it is a privacy word or a filler word, and at least one is a privacy word.
 *  Order, punctuation and separators stop mattering — `Private / Internal
 *  Notes`, `Internal — Notes` and `Notes (Confidential)` all pass — while the
 *  whitelist keeps it from drifting into phrase matching.
 *
 *  WHAT IT MUST NOT DO IS THE POINT. `Planner Notes — Audience Not Yet
 *  Decided` contains no privacy word and is refused, which is correct twice
 *  over: the source itself says the audience is undecided, so hiding it would
 *  answer a question the professional has not been asked. And because every
 *  word must be listed, none of the client-facing prose in this file can reach
 *  it — `private office`, `internal courtyard`, `confidential one-on-one
 *  meeting space`, `confidentiality screens` (not even the same word) and
 *  Clementine Club's menu that is confidential to the public but explicitly
 *  reviewable by the client all stay client-facing.
 *
 *  This widens ONLY the heading. The inline patterns above are untouched: a
 *  value that opens with a marker is still one record's content, and reading it
 *  as a heading would authorise that column in every row. */
const HEADING_PRIVACY = new Set(["private", "internal", "confidential"]);
const HEADING_FILLER = new Set(["note", "notes", "only", "use"]);

export function headingGrantsPrivacy(heading: string): boolean {
  const words = String(heading ?? "").toLowerCase().match(/[a-z]+/g) ?? [];
  if (!words.length) return false;
  if (!words.some((w) => HEADING_PRIVACY.has(w))) return false;
  return words.every((w) => HEADING_PRIVACY.has(w) || HEADING_FILLER.has(w));
}

/** RFC4180 fields of one row. Small on purpose — the source layer already
 *  tiled the file into records with quote state; this only needs the columns
 *  inside one of them. */
export function splitFields(row: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (quoted) {
      if (ch === '"' && row[i + 1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { quoted = false; continue; }
      cur += ch; continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { out.push(cur); cur = ""; continue; }
    if (ch === "\r") continue;
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * THE PRIVATELY-AUTHORISED TEXT of one record — not a yes/no for the record.
 *
 * A row can hold an INTERNAL ONLY column AND a Client-Facing Notes column. A
 * whole-record grant would let the first authorise the second, so a note the
 * model misfiled out of the client-facing column would be hidden from the
 * client on the strength of a marker that had nothing to do with it. Scope has
 * to reach the field.
 *
 * Two ways a field earns authority, and both are declarations:
 *   * its OWN value declares privacy — `INTERNAL ONLY — Luis said…`
 *   * its COLUMN HEADING does — a field headed `INTERNAL ONLY` authorises its
 *     value even when the value does not repeat the label. The heading speaks
 *     for that column only, never for the row.
 *
 * Where the source is not delimited there are no fields to divide, so the
 * record's own privately-marked LINES are used instead — the same regions the
 * Library path derives. Returns "" when nothing is authorised.
 */
/*  A THIRD AUDIENCE STATE, BECAUSE THE SOURCE DECLARES ONE.
 *
 *  The event-planner file names a column `Planner Notes — Audience Not Yet
 *  Decided`. That is not private and it is not client-facing; it is the
 *  professional saying, in the file itself, that they have not decided. Reading
 *  it as either one answers a question they explicitly left open — and until
 *  now the answer was whichever field the MODEL happened to choose. The same
 *  sentence became a private note on one venue and client-facing description
 *  prose on another, from one import.
 *
 *  Structural, like the privacy heading and for the same reason: the heading
 *  must name an AUDIENCE and say it is UNSETTLED. `Planner Notes — Audience Not
 *  Yet Decided` qualifies; `Client-Facing Notes` names an audience and settles
 *  it; `Private / Internal Notes` is handled by the privacy rule and mentions no
 *  audience at all. No prose is scanned — only the column heading. */
const AUDIENCE_WORD = new Set(["audience", "share", "shared", "sharing", "visibility", "recipient"]);
const UNSETTLED_WORD = new Set(["undecided", "tbd", "unclear", "unknown", "undetermined", "pending"]);
const SETTLED_WORD = new Set(["decided", "determined", "confirmed", "settled"]);

export function headingDefersAudience(heading: string): boolean {
  const words: string[] = String(heading ?? "").toLowerCase().match(/[a-z]+/g) ?? [];
  if (!words.some((w) => AUDIENCE_WORD.has(w))) return false;
  if (words.some((w) => UNSETTLED_WORD.has(w))) return true;
  // "not yet decided", "not determined" — the negation has to reach the word.
  const i = words.indexOf("not");
  return i >= 0 && words.slice(i + 1, i + 4).some((w) => SETTLED_WORD.has(w));
}

/** What each audience state owns in ONE record, read from the column headings.
 *
 *  Undecided is checked FIRST: a heading that manages to say both is the more
 *  conservative of the two, because an undecided item always asks rather than
 *  silently hiding. */
export function audienceSourceOf(
  recordText: string, opts: { headerRow?: string | null; delimiter?: string | null } = {},
): { private: string; undecided: string } {
  const row = String(recordText ?? "");
  const delimiter = opts.delimiter || null;
  if (!delimiter) return { private: privateRegions(row).join("\n"), undecided: "" };
  const cells = splitFields(row, delimiter);
  const heads = opts.headerRow ? splitFields(String(opts.headerRow), delimiter) : [];
  const priv: string[] = [], undec: string[] = [];
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i].trim();
    if (!v) continue;
    const head = i < heads.length ? heads[i] : "";
    if (head && headingDefersAudience(head)) { undec.push(v); continue; }
    if ((head && headingGrantsPrivacy(head)) || sourceGrantsPrivacy(cells[i])) priv.push(v);
  }
  return { private: priv.join("\n"), undecided: undec.join("\n") };
}

export function privateSourceOf(
  recordText: string, opts: { headerRow?: string | null; delimiter?: string | null } = {},
): string {
  return audienceSourceOf(recordText, opts).private;
}

/** Is every fact-bearing token of the note present in the authorised text?
 *
 *  The same question the Library path asks. One directive authorises what it
 *  introduces, not everything the model chose to pile in beside it. */
export function noteSupportedBy(note: string, privateSource: string): boolean {
  const want = factTokens(String(note ?? ""));
  if (!want.length) return true;
  if (!String(privateSource ?? "").trim()) return false;
  const have = new Set(factTokens(privateSource));
  return want.every((t) => have.has(t));
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
  /** Content taken OUT of a recipient-facing destination because the source
   *  field it came from is not addressed to the recipient. `kept` is true when
   *  the same content is already safely held in this item's private notes, in
   *  which case removing the visible copy needs no question. */
  audienceRemoved: { text: string; state: "private" | "undecided"; where: string; kept: boolean }[];
}

/** Apply the contract to ONE item, given that item's resolutions. */
export function enforceItem(
  item: Item, resolutions: Resolution[], claims: Claim[],
  opts: { privateSource: string; undecidedSource?: string },
): Enforcement {
  const next: Item = { ...item };
  const applied: { claimId: string; action: string }[] = [];
  const stripped: Enforcement["stripped"] = [];
  const unresolvedNotes: Enforcement["unresolvedNotes"] = [];
  const audienceRemoved: Enforcement["audienceRemoved"] = [];
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

  // THE SOURCE FIELD'S AUDIENCE CONSTRAINS EVERY DESTINATION, NOT JUST NOTES.
  //
  // Until now the contract asked one question — "is this NOTE allowed to be
  // private?" — and never the reverse one. So a model that copied a private
  // cell into a `details` row, or folded an undecided planner sentence into
  // `description`, walked straight past it. Both happened in one ordinary
  // import: the Clementine Room's private note was in Private Notes AND in a
  // client-visible detail, and the Foundry Annex's "audience not yet decided"
  // judgment went to the client as description prose with nothing asked.
  //
  // The model's choice of field must not settle the question the source left
  // open, so the audience is read from the SOURCE FIELD and applied wherever
  // the content landed.
  //
  //   UNDECIDED always asks. It is removed from wherever it is — private or
  //   recipient-facing, notes included — and surfaced. That is the whole point
  //   of the column: the professional has not decided yet.
  //
  //   PRIVATE never stays visible. If the same content is already held in this
  //   item's notes AND those notes are themselves authorised, the visible copy
  //   is a duplicate and goes without a question — nobody needs to be asked
  //   whether explicitly private material should be public. If it is NOT held
  //   anywhere, removing it would lose it, so it is surfaced instead.
  //
  // Matching is by FACT TOKENS against the record's own field text, which is the
  // same provenance test the privacy rule already uses. It is not a keyword scan:
  // nothing matches unless every fact-bearing word of the candidate appears in
  // that record's restricted field, and a candidate with fewer than four such
  // words is left alone as too slight to attribute.
  {
    const MIN_FACTS = 4;
    const priv = String(opts.privateSource ?? "");
    const undec = String(opts.undecidedSource ?? "");
    const supported = (text: string, src: string) =>
      Boolean(src.trim()) && factTokens(text).length >= MIN_FACTS && noteSupportedBy(text, src);
    const verdict = (text: string): "private" | "undecided" | null =>
      supported(text, undec) ? "undecided" : supported(text, priv) ? "private" : null;

    // Notes only count as a safe home if they will themselves survive the
    // privacy rule below — otherwise "already preserved" would be a promise
    // about a field that is about to be emptied.
    const noteText = String(next.notes ?? "");
    const notesSurvive = Boolean(noteText.trim()) && noteSupportedBy(noteText, priv);
    const held = (text: string) => notesSurvive && noteSupportedBy(text, noteText);

    const take = (text: string, state: "private" | "undecided", where: string) => {
      // Undecided is never "already safe": private is not a resolution of it.
      const kept = state === "private" && held(text);
      audienceRemoved.push({ text, state, where, kept });
      applied.push({ claimId: "-", action: `${where}: removed ${state} source content` });
    };

    // PROSE, SENTENCE BY SENTENCE. The Foundry Annex's description is four
    // legitimate client-facing sentences with two planner sentences folded in;
    // dropping the whole field would discard the model's real work.
    for (const field of ["description", "highlight"] as const) {
      const whole = String(next[field] ?? "");
      if (!whole.trim()) continue;
      const parts = whole.split(/(?<=[.!?])\s+/);
      const keep: string[] = [];
      for (const part of parts) {
        const v = verdict(part);
        if (!v) { keep.push(part); continue; }
        take(part.trim(), v, field);
      }
      if (keep.length !== parts.length) next[field] = keep.join(" ").trim();
    }

    // WHOLE-VALUE DESTINATIONS.
    const detailRows = arr(next.details) as { label?: string; value?: string }[];
    const keptDetails = detailRows.filter((d) => {
      const text = `${String(d?.label ?? "")}: ${String(d?.value ?? "")}`.trim();
      const v = verdict(text) ?? verdict(String(d?.value ?? ""));
      if (!v) return true;
      take(text, v, "details");
      return false;
    });
    if (keptDetails.length !== detailRows.length) next.details = keptDetails;

    const addr = String(next.address ?? "");
    const addrVerdict = addr.trim() ? verdict(addr) : null;
    if (addrVerdict) { take(addr.trim(), addrVerdict, "address"); next.address = ""; }

    // LINK LABELS AND CONTACT NAMES. The URL, email and phone are identity and
    // are left alone; only the free text beside them can carry a note.
    next.links = arr(next.links).map((l) => {
      const o = l as { label?: string };
      const t = String(o?.label ?? "");
      const v = t.trim() ? verdict(t) : null;
      if (!v) return l;
      take(t.trim(), v, "links");
      return { ...(o as object), label: "" };
    });
    next.contacts = arr(next.contacts).map((c) => {
      const o = c as Record<string, unknown>;
      const out = { ...o };
      for (const f of ["name", "role"]) {
        const t = String(o?.[f] ?? "");
        const v = t.trim() ? verdict(t) : null;
        if (!v) continue;
        take(t.trim(), v, `contacts.${f}`);
        out[f] = null;
      }
      return out;
    });

    // AND NOTES ITSELF, for the undecided case only. Private content in notes is
    // the privacy rule's business, immediately below.
    if (noteText.trim() && supported(noteText, undec)) {
      take(noteText, "undecided", "notes");
      next.notes = "";
    }
  }

  // THE PRIVACY RULE. A note may only stand on the strength of source that is
  // itself marked private — and only for what that source actually says.
  //
  // The check is CONTENT, not a flag. `privateSource` is the text of the fields
  // (or lines) this record marks private, and every fact-bearing word of the
  // note must appear in it. So a row holding both an INTERNAL ONLY column and a
  // Client-Facing Notes column authorises the first and refuses the second,
  // where a per-record boolean would have waved both through.
  //
  // The claims the note held have already been placed by their own rung above,
  // so clearing it removes a duplicate, not a fact.
  if (String(next.notes ?? "").trim() && !noteSupportedBy(String(next.notes), opts.privateSource)) {
    // SURFACED, NOT DELETED. The ice-cream import put 13 "Why it made the list"
    // paragraphs into notes — prose plainly written FOR the recipient, which a
    // private field hides. Removing it from notes is right; discarding it is
    // not. It has no safe destination yet, so it becomes an explicit unresolved
    // item for the professional to place.
    unresolvedNotes.push({
      text: String(next.notes),
      reason: "recipient-intended prose placed in a private field with no source authority for it",
    });
    applied.push({ claimId: "-", action: "notes surfaced as unresolved — no source authority for privacy" });
    next.notes = "";
  }
  return { item: next, applied, stripped, unresolvedNotes, audienceRemoved };
}
