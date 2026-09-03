// Applies the semantic contract to ONE chunk's model result, behind the flag.
//
// Composes exactly the pieces the offline gates proved: claim parse, structural
// record envelopes, source-backed attribution, precedence reconciliation,
// canonical rendering, specialized-destination exclusivity, and the privacy
// rule. Nothing new is invented here.
//
// SCOPE IS THE HORIZONTAL SUBSET. Unlabelled pricing associations are never
// inferred — those stay SOURCE_UNRESOLVED — and no vertical vocabulary is
// consulted anywhere in the chain.
import { parseClaims } from "./claim-parser.ts";
import { recordEnvelopes, attributeAll, bindByProvenance, sourceCells, spansCells,
  type SourceCells } from "./attribution.ts";
import { reconcile } from "./reconcile.ts";
import { enforceItem, audienceSourceOf, contractEnforcementEnabled } from "./enforce.ts";
import { locate } from "./placement.ts";
import { specializedValueKind, type Claim } from "./claim-parser.ts";
import { buildReviewUnits, type ReviewFailure } from "./review-units.ts";

export interface EnforcementTelemetry {
  accepted: number; repaired: number; stripped: number;
  /** WHOLE-SOURCE FALLBACK. Facts checked without an owner, and how they went. */
  wholeSourceChecked: number; wholeSourcePresent: number; wholeSourceMissing: number;
  sourceUnresolved: number; attributionUnresolved: number;
  privacyRejected: number; itemsGoverned: number;
  /** Recipient-facing values proven to have crossed a source cell boundary,
   *  and proposals refused governance because they could not be bound. Both
   *  are COUNTS OF A SAFETY ACTION THAT ALREADY HAPPENED - the material is
   *  surfaced whether or not anyone reads these numbers. Telemetry records
   *  the contract; it has never been the thing that enforces it. */
  crossCellRejected: number; unboundSurfaced: number;
  /** Content taken out of a recipient-facing destination because its source
   *  field is not addressed to the recipient. */
  audienceRemoved: number;
  /** Recipient-facing content held back because its proposal could not be
   *  bound to a source record. */
  unboundRecipientWithheld: number;
  /** Why enforcement did or did not run for this chunk. Recorded even when it
   *  declined, so "we were asked and said no" is a fact in the evidence rather
   *  than an absence someone has to interpret. */
  scope?: ScopeVerdict;
}

// DESTINATION SCOPE — WHERE THE SEMANTIC CONTRACT IS ALLOWED TO ACT.
//
// Enforcement strips content it cannot place and holds it as a review-required
// unit. That is only safe where the held unit is SURFACED to the creator, which
// today is the packet path alone: a Library import closes through
// `library_close_import_run`, which clears the transport channel, so a unit held
// there would be stripped and then discarded without anyone seeing it.
//
// The Library is not merely unprotected without enforcement - it is SAFER. A
// model-placed private note is shown to its owner as "Private note - Only you
// see this". Enforcing without surfacing would turn a visible note into a
// deletion, so declining here preserves content rather than risking it.
//
// The lists are exhaustive on purpose. A destination added later matches
// neither, resolves to `unsupported`, and does not run - it cannot inherit
// packet semantics by being new.
export const ENFORCED_DESTINATIONS = ["packet"] as const;
export const KNOWN_DESTINATIONS = ["packet", "library"] as const;
export type KnownDestination = (typeof KNOWN_DESTINATIONS)[number];

export type ScopeVerdict =
  /** In scope: held units have somewhere to be seen. */
  | "enforced"
  /** Known destination, deliberately outside the contract's reach. */
  | "out-of-scope"
  /** Absent, or a destination nobody has decided about. Never guessed. */
  | "unsupported";

export function enforcementScope(destination: string | null | undefined): ScopeVerdict {
  const d = typeof destination === "string" ? destination : "";
  if ((ENFORCED_DESTINATIONS as readonly string[]).includes(d)) return "enforced";
  if ((KNOWN_DESTINATIONS as readonly string[]).includes(d)) return "out-of-scope";
  return "unsupported";
}

/** Source content that survived, attached to its record, awaiting a decision.
 *  NOT hidden, NOT deleted, and NOT placed into description or details — those
 *  would each be a silent choice the professional never made. */
export interface UnresolvedUnit {
  record: number;
  title: string | null;
  kind: "privacy-rejected" | "source-unresolved" | "cross-cell-detail" | "unbound-private-note"
    | "audience-undecided" | "private-shown" | "unbound-recipient-content";
  text: string;
  reason: string;
  /** Absolute source offset where the fact was written, when known. Provenance
   *  survives even where ownership does not. */
  offset?: number;
}

export interface ChunkEnforcement {
  result: unknown;
  telemetry: EnforcementTelemetry;
  /** EVERY unit, review-required and observed alike. Telemetry: this is what
   *  goes to the fact ledger, and nothing product-facing may read it. */
  unresolved: UnresolvedUnit[];
  /** ONLY the review-required exceptions, with stable ids. Product state: this
   *  is what goes to `ingestion_chunks.review_units` and becomes a question. */
  reviewUnits: ReviewFailure[];
}

const empty = (): EnforcementTelemetry => ({
  accepted: 0, repaired: 0, stripped: 0, sourceUnresolved: 0,
  wholeSourceChecked: 0, wholeSourcePresent: 0, wholeSourceMissing: 0,
  attributionUnresolved: 0, privacyRejected: 0, itemsGoverned: 0,
  crossCellRejected: 0, unboundSurfaced: 0, audienceRemoved: 0,
  unboundRecipientWithheld: 0,
});

/** Rebuild a result object with the same shape, items replaced. */
function withItems(result: unknown, next: Record<string, unknown>[]): unknown {
  const r = (result ?? {}) as { items?: unknown; sections?: { items?: unknown }[] };
  if (Array.isArray(r.sections)) {
    let i = 0;
    return { ...r, sections: r.sections.map((s) => {
      const n = Array.isArray(s?.items) ? s.items.length : 0;
      const slice = next.slice(i, i + n); i += n;
      return { ...s, items: slice };
    }) };
  }
  return { ...r, items: next };
}

/** Test-only fault injection, dead code in production builds. Lets the control
 *  test prove that an enforcement failure does NOT stage unprotected output. */
function maybeThrowForTest(): void {
  if (process.env.NODE_ENV === "production") return;
  if (process.env.FLOWGUIDE_TEST_ENFORCE_THROW === "1")
    throw new Error("injected enforcement failure (test hook)");
}

/** ONE RULE, APPLIED EVERYWHERE A RECIPIENT-FACING VALUE CAN ARRIVE.
 *
 *  A value can reach `details` from two places, and BOTH produced the same
 *  spill on the event-planner import: the model emitted one, and the claim
 *  parser independently split the same quoted multi-line pricing block on the
 *  colon inside "6:00" and ran past the field. Guarding only the model's copy
 *  left enforcement free to write the parser's copy back in — and worse, to
 *  overwrite a perfectly good detail with it. The Foundry Hall's cleaning fee
 *  was proposed correctly as "$800" and replaced by 768 characters of the next
 *  three columns.
 *
 *  So the rule lives here, in one place, and is applied to claims before they
 *  are materialized and to details on the way out. */
function partitionSpanning<T>(
  values: T[], cells: SourceCells, valueOf: (v: T) => string,
): { kept: T[]; rejected: T[] } {
  const kept: T[] = [], rejected: T[] = [];
  for (const v of values) (spansCells(cells, valueOf(v)) ? rejected : kept).push(v);
  return { kept, rejected };
}

/** The kinds whose canonical form makes presence-matching exact. Deliberately
 *  small: `labelled` values reshape legitimately, and treating a reshaped value
 *  as missing would turn nine non-issues into nine warnings. */
const WHOLE_SOURCE_KINDS: ReadonlySet<string> = new Set(["url", "phone", "email"]);

export function enforceChunkResult(opts: {
  segmentText: string; chunkOrdinal: number; sourceStart: number;
  sourceText: string | null; result: unknown; runId?: string;
  /** The run's PERSISTED destination. Required: an optional scope argument is
   *  one forgotten call site away from enforcing somewhere nobody checked. */
  destination: string | null | undefined;
  /** Delimiter declared by the source file, or null for a pasted source. */
  delimiterHint?: string | null;
}): ChunkEnforcement {
  const { segmentText, chunkOrdinal, sourceStart, sourceText, result, runId, destination, delimiterHint } = opts;
  if (!contractEnforcementEnabled()) return { result, telemetry: empty(), unresolved: [], reviewUnits: [] };

  // SCOPE BEFORE EVERYTHING ELSE, including the fail-closed test hook: a run
  // outside the contract's reach must return the model's result byte-for-byte,
  // and must not be capable of failing its chunk either.
  const scope = enforcementScope(destination);
  if (scope !== "enforced") {
    return { result, telemetry: { ...empty(), scope }, unresolved: [], reviewUnits: [] };
  }
  maybeThrowForTest();

  const r = (result ?? {}) as { items?: unknown; sections?: { items?: unknown }[] };
  const items = [
    ...(Array.isArray(r.items) ? r.items : []),
    ...(Array.isArray(r.sections) ? r.sections.flatMap((s) => (Array.isArray(s?.items) ? s.items : [])) : []),
  ].filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object");
  if (!items.length || !sourceText) return { result, telemetry: { ...empty(), scope }, unresolved: [], reviewUnits: [] };

  const env = recordEnvelopes(sourceText, delimiterHint ?? undefined);
  const envByIndex = new Map((env ?? []).map((e) => [e.index, e]));
  // The heading row is the first record the tiling produced. The delimiter is
  // the declared one where the file supplied it, and is otherwise inferred from
  // the heading itself — whichever candidate splits it into the most columns.
  const headerRow = env && env.length ? sourceText.slice(env[0].start, env[0].end) : null;
  const delimiter = delimiterHint
    || (headerRow ? [",", "\t", ";", "|"]
        .map((d) => ({ d, n: headerRow.split(d).length }))
        .sort((a, b) => b.n - a.n)
        .filter((x) => x.n >= 3)[0]?.d ?? null
      : null);
  // THE PARSER GETS THE DELIMITER TOO. Reading the source's structure in one
  // place and not the other is how a quoted multiline cell came to be parsed as
  // a bare line and ran on through three columns.
  const parsed = parseClaims(segmentText, chunkOrdinal, { delimiter });
  const a = attributeAll(parsed.claims, parsed.ambiguous, parsed.fragments, env, sourceStart);
  const t: EnforcementTelemetry = { ...empty(), scope };
  const unresolved: UnresolvedUnit[] = [];
  t.attributionUnresolved = a.unattributedClaims.length + a.unattributedAmbiguous.length;

  // A VALUE THAT CROSSED A CELL BOUNDARY IS NOT A FIELD CLAIM.
  //
  // This runs BEFORE binding, because a spilled value is not merely wrong
  // output — it is bad evidence. The four observed spills carried the NEXT
  // record's email, phone and website inside them, so the binder saw one
  // proposal claiming two records and refused both. Removing the proven-invalid
  // value first lets provenance work on what the model actually asserted about
  // this record.
  //
  // Nothing is truncated and nothing is repaired: the value goes out whole, to
  // a question. Only `details` are examined, because that is the recipient-
  // facing destination whose values are supposed to BE single source cells.
  const cells = delimiter ? sourceCells(sourceText, delimiter) : null;
  // Collected from every pass and surfaced ONCE, at the end. The model and the
  // claim parser mis-split the same field in the same way, so the same excerpt
  // arrives from two directions; one excerpt is one decision.
  const crossCell: { record: number; title: string; label: string; value: string }[] = [];
  const detailValue = (d: unknown) => String((d as { value?: unknown })?.value ?? "");
  const detailLabel = (d: unknown) => String((d as { label?: unknown })?.label ?? "");
  const scanned = cells
    ? items.map((it) => {
        const details = Array.isArray(it.details) ? it.details : null;
        if (!details) return it;
        const { kept, rejected } = partitionSpanning(details, cells, detailValue);
        for (const d of rejected)
          crossCell.push({ record: -1, title: String(it.title ?? ""),
                           label: detailLabel(d), value: detailValue(d) });
        return rejected.length ? { ...it, details: kept } : it;
      })
    : items;
  // `scanned` is what everything downstream sees. Keeping the original array
  // around to fall back on would be exactly the silent second source of truth
  // this contract exists to prevent.
  const bound = env ? bindByProvenance(env, sourceText, scanned).bound : new Map<number, Record<string, unknown>>();
  // THE CHUNK IS NOT THE RECORD — AND THE RECORD IS NOT THE FIELD.
  //
  // Authority used to be read from the whole chunk and handed to every record
  // in it, so one record's INTERNAL ONLY marker could authorise its neighbour's
  // client-facing prose. Narrowing to the record fixed that and left a smaller
  // version of the same hole: a single row can hold an INTERNAL ONLY column AND
  // a Client-Facing Notes column, and a per-record answer lets the first speak
  // for the second.
  //
  // So what is computed here is not a flag but the TEXT this record marks
  // private — field by field where the source is delimited, using the column
  // heading as well as the value, and line by line where it is not. enforceItem
  // then asks whether the note is actually supported by it.
  //
  // The record's own text comes from its ENVELOPE, which is provenance rather
  // than a title search: seg-v4 already tiled the source into records, and
  // start/end are that tiling. When a record has no envelope there is no proof
  // of what it owns, so nothing is authorised and the note is surfaced for a
  // decision — fail closed, exactly as before.
  const EMPTY_AUDIENCE = { private: "", undecided: "" };
  const audienceFor = (rec: number): { private: string; undecided: string } => {
    const e = envByIndex.get(rec);
    if (!e) return EMPTY_AUDIENCE;
    // The heading is not a record with content of its own; it names columns.
    if (env && env.length && e.index === env[0].index) return EMPTY_AUDIENCE;
    return audienceSourceOf(sourceText.slice(e.start, e.end), { headerRow, delimiter });
  };
  const replaced = new Map<Record<string, unknown>, Record<string, unknown>>();

  for (const [rec, g] of a.byRecord) {
    const item = bound.get(rec);
    if (!item) { t.attributionUnresolved += g.claims.length + g.ambiguous.length; continue; }
    // A CLAIM THAT SPANS CELLS IS NOT A CLAIM ABOUT THIS FIELD.
    //
    // Dropped BEFORE reconciliation rather than after, because a materialized
    // spanning claim does not merely add a bad detail — it can REPLACE a good
    // one. The Foundry Hall proposed its cleaning fee correctly as "$800" and
    // enforcement overwrote it with the next three columns, on the authority of
    // a claim the parser had mis-split. Refusing the claim leaves "$800" alone.
    //
    // CLAIMS ONLY. An ambiguous unit never reaches `details` — it resolves to
    // SOURCE_UNRESOLVED, which is recorded and shown to nobody — so filtering it
    // here would remove nothing from the recipient and would only make the
    // ledger less complete.
    const gc = cells ? partitionSpanning(g.claims, cells, (c) => c.value)
                     : { kept: g.claims, rejected: [] as Claim[] };
    for (const c of gc.rejected)
      crossCell.push({ record: rec, title: String(item.title ?? ""),
                       label: c.label ?? "", value: c.value });
    const res = reconcile({ claims: gc.kept, ambiguous: g.ambiguous, fragments: g.fragments }, item);
    const audience = audienceFor(rec);
    const e = enforceItem(item, res.resolutions, gc.kept,
      { privateSource: audience.private, undecidedSource: audience.undecided });
    t.accepted += res.counts.accepted; t.repaired += res.counts.repaired;
    t.sourceUnresolved += res.counts.sourceUnresolved;
    t.stripped += e.stripped.length;
    t.itemsGoverned++;

    // RECIPIENT-INTENDED PROSE THAT LOST ITS PRIVATE FIELD BECOMES AN EXPLICIT
    // UNRESOLVED UNIT — attached to its record, never placed automatically.
    //
    // An earlier version appended it to `description`, which would have turned
    // description into exactly the narrative overflow field we decided not to
    // create. Choosing a destination on the professional's behalf is the same
    // class of error as the model choosing `notes`: it looks tidy and it hides
    // a decision nobody made.
    for (const un of e.unresolvedNotes) {
      t.privacyRejected++;
      unresolved.push({ record: rec, title: String(item.title ?? "") || null,
        kind: "privacy-rejected", text: un.text, reason: un.reason });
    }
    // WHAT THE AUDIENCE SWEEP TOOK OUT. A removal whose content is already held
    // privately is a duplicate and asks nothing; everything else becomes a
    // question, so nothing is removed and lost in the same motion.
    //
    // ONE DECISION PER ITEM PER AUDIENCE STATE. The Foundry Annex had two
    // planner sentences folded into its description; they are one question
    // about one column, not two, and splitting them would make the review queue
    // a function of the model's sentence breaks.
    t.audienceRemoved += e.audienceRemoved.length;
    for (const state of ["undecided", "private"] as const) {
      const parts = e.audienceRemoved.filter((a) => a.state === state && !a.kept);
      if (!parts.length) continue;
      const where = [...new Set(parts.map((a) => a.where))].join(", ");
      unresolved.push({
        record: rec, title: String(item.title ?? "") || null,
        kind: state === "undecided" ? "audience-undecided" : "private-shown",
        text: parts.map((a) => a.text).join(" "),
        reason: state === "undecided"
          ? `the source column this came from declares its audience undecided; it was proposed in ${where}`
          : `the source marks this private and it was proposed in ${where}, with no private copy kept`,
      });
    }
    for (const r of res.resolutions.filter((x) => x.outcome === "SOURCE_UNRESOLVED")) {
      unresolved.push({ record: rec, title: String(item.title ?? "") || null,
        kind: "source-unresolved", text: r.value, reason: r.why });
    }
    replaced.set(item, e.item);
  }
  // =========================================================================
  // WHOLE-SOURCE FALLBACK — an unowned fact is still a fact.
  //
  // Record-level governance can only speak for items it could ATTRIBUTE to a
  // source record. Measured over sixteen ordinary inputs, records were provable
  // in four of them, so for most sources the contract had nothing to say and a
  // dropped fact left no trace at all — a bare hostname beside a contact
  // vanished from six consecutive imports without appearing in any output,
  // any field, or any telemetry.
  //
  // This does NOT invent an owner. It answers a strictly weaker question that
  // needs no owner to answer: did this fact survive ANYWHERE in the draft?
  // Present is accounted for; absent becomes visible. Nothing is placed,
  // because choosing a destination without provable ownership is the silent
  // decision this whole contract exists to prevent.
  //
  // ONLY HIGH-IDENTITY KINDS, and that restriction is the precision.
  // Canonical matching is exact for these three — squashed comparison for URLs
  // and emails, digits-only for phones — so a reformatted fact still counts as
  // present. On the corpus, ten source facts were absent by naive comparison:
  // NINE were `labelled` claims where a whole line became one claim and the
  // content survived reshaped, and ONE was a genuine loss. Governing only these
  // kinds catches that one and none of the nine.
  // FAIL CLOSED WHEN PROVENANCE COULD NOT BE ESTABLISHED.
  //
  // `bound.get(rec)` returning nothing used to `continue`, and that was the
  // whole of it: the proposal was never enforced, never surfaced, and the only
  // trace was a counter. A note the model decided to hide therefore reached the
  // packet as creator-only content on the strength of the model's own choice —
  // the exact thing the privacy rule exists to refuse. Three venues in the
  // event-planner import hid planner judgment this way, and nobody was asked.
  //
  // Being unable to bind is not evidence that the material is safe. It is the
  // absence of evidence either way, so it becomes a question. This does NOT
  // reach for a weaker identity: no title match, no shared contact, no
  // neighbouring record, no domain. It simply declines to grant privacy that
  // nothing proved.
  //
  // Only `notes` is governed here, because that is the field whose meaning is
  // "the client will never see this". A proposal FlowGuide could not attribute
  // is left otherwise untouched.
  const governed = new Set(bound.values());
  for (const it of scanned) {
    if (governed.has(it)) continue;
    const note = String(it.notes ?? "");
    const next: Record<string, unknown> = { ...it };
    if (note.trim()) {
      t.unboundSurfaced++;
      t.privacyRejected++;
      unresolved.push({
        record: -1,
        title: String(it.title ?? "") || null,
        // ITS OWN KIND, because the reason differs from the ordinary privacy
        // rejection and the professional is owed the true one. The source may
        // well mark this private; what is absent is proof that it is THIS row's.
        kind: "unbound-private-note",
        text: note,
        reason: "Sendset could not establish which source record this came from, "
          + "so nothing proves the source meant it to be private",
      });
      next.notes = "";
    }

    // AND THE RECIPIENT-FACING SIDE, for the same reason.
    //
    // Withholding only the private note closed half the hole: the model's prose
    // ABOUT an unidentified record still went to the client, unverified. On the
    // two real imports an unbound proposal repeatedly carried a neighbouring
    // record's email, phone and website, so this is the shape the contamination
    // actually takes rather than a hypothetical.
    //
    // ONLY WHERE BINDING WAS POSSIBLE IN THE FIRST PLACE. There is a difference
    // between provenance that FAILED and provenance that was never on offer,
    // and it is the whole difference here. A pasted shortlist tiles into no
    // records at all: every item is "unbound" because there is nothing to bind
    // TO, and on the corpus that is most ordinary sources rather than a few.
    // Applying this rule there would empty the packet for all of them, and it
    // would be answering a question nobody could ask. That case already has its
    // own answer — the whole-source fallback, which checks that facts survived
    // SOMEWHERE and deliberately never blocks and never places.
    //
    // So the rule speaks only when the source did produce records and THIS
    // proposal could not be matched to one. That is a real failure, and the
    // event-planner and contractor imports are both of that kind.
    //
    // Title and photos are left: the title is the item's identity and losing it
    // would leave an anonymous card the professional cannot even recognise, and
    // a photo URL is not prose. Everything else is held.
    const held: string[] = [];
    if (!env || !env.length) { replaced.set(it, next); continue; }
    const desc = String(it.description ?? "").trim();
    if (desc) { held.push(desc); next.description = ""; }
    const high = String(it.highlight ?? "").trim();
    if (high) { held.push(high); next.highlight = ""; }
    const addr = String(it.address ?? "").trim();
    if (addr) { held.push(`Address: ${addr}`); next.address = ""; }
    for (const d of (Array.isArray(it.details) ? it.details : []) as { label?: string; value?: string }[]) {
      const line = `${String(d?.label ?? "").trim()}: ${String(d?.value ?? "").trim()}`.trim();
      if (line.replace(/^:|:$/, "").trim()) held.push(line);
    }
    if (Array.isArray(it.details) && it.details.length) next.details = [];
    for (const l of (Array.isArray(it.links) ? it.links : []) as { label?: string }[]) {
      const t2 = String(l?.label ?? "").trim();
      if (t2) held.push(`Link: ${t2}`);
    }
    if (Array.isArray(it.links)) next.links = it.links.map((l) => ({ ...(l as object), label: "" }));
    for (const c of (Array.isArray(it.contacts) ? it.contacts : []) as Record<string, unknown>[]) {
      const who = [String(c?.name ?? "").trim(), String(c?.role ?? "").trim()].filter(Boolean).join(", ");
      if (who) held.push(`Contact: ${who}`);
    }
    if (Array.isArray(it.contacts))
      next.contacts = it.contacts.map((c) => ({ ...(c as object), name: null, role: null }));

    if (held.length) {
      t.unboundRecipientWithheld++;
      unresolved.push({
        record: -1,
        title: String(it.title ?? "") || null,
        kind: "unbound-recipient-content",
        // ONE decision, everything in it, so nothing is removed and lost in the
        // same motion and the professional sees the whole item at once.
        text: held.join("\n"),
        reason: "Sendset could not establish which source record this proposal came from, "
          + "so nothing proves these facts belong to it",
      });
    }
    replaced.set(it, next);
  }

  // THE INVARIANT, CHECKED WHERE IT MATTERS: ON THE WAY OUT.
  //
  // The two passes above cover the two writers we know about. This one states
  // the guarantee itself — no value leaving here is one that provably crossed a
  // cell boundary — so a future write path cannot quietly reopen the hole. If
  // the earlier passes are complete this finds nothing, which is the point.
  const enforced = scanned.map((it) => replaced.get(it) ?? it);
  const finalItems = cells
    ? enforced.map((it) => {
        const details = Array.isArray(it.details) ? it.details : null;
        if (!details) return it;
        const { kept, rejected } = partitionSpanning(details, cells, detailValue);
        if (!rejected.length) return it;
        for (const d of rejected)
          crossCell.push({ record: -1, title: String(it.title ?? ""),
                           label: detailLabel(d), value: detailValue(d) });
        return { ...it, details: kept };
      })
    : enforced;
  // SURFACED ONCE, WITH THE WHOLE EXCERPT.
  //
  // The label is kept with the value so the professional can see both the real
  // fact and where it ran on to — Redwood's "$1,100 evening extension" is in
  // there, followed by three columns that are not. Which part was meant is
  // their decision; making it here would be the silent choice this contract
  // exists to refuse, so nothing is truncated or repaired.
  //
  // `crossCellRejected` counts values REMOVED, which is more than the number of
  // questions asked when two passes catch the same excerpt. The count is a
  // record of what the contract did; the unit is what the professional sees.
  {
    const seen = new Set<string>();
    for (const c of crossCell) {
      t.crossCellRejected++;
      const text = c.label ? `${c.label}: ${c.value}` : c.value;
      if (seen.has(text)) continue;
      seen.add(text);
      unresolved.push({
        record: c.record, title: c.title || null, kind: "cross-cell-detail", text,
        reason: "this value spans more than one cell of the source file, so it is not a single field value",
      });
    }
  }

  const ungoverned: Claim[] = [...a.unattributedClaims];
  for (const [rec, g] of a.byRecord) if (!bound.get(rec)) ungoverned.push(...g.claims);

  const seen = new Set<string>();
  for (const c of ungoverned) {
    const kind = specializedValueKind(c);
    if (!kind || !WHOLE_SOURCE_KINDS.has(kind)) continue;
    // One fact written twice is one fact.
    const key = `${kind}:${c.value.trim().toLowerCase().replace(/\s+/g, "")}`;
    if (seen.has(key)) continue;
    seen.add(key);

    t.wholeSourceChecked++;
    if (finalItems.some((it) => locate(it, c.value).length > 0)) { t.wholeSourcePresent++; continue; }

    t.wholeSourceMissing++;
    unresolved.push({
      // No record: saying -1 is honest where inventing 0 would not be.
      record: -1,
      title: null,
      kind: "source-unresolved",
      text: c.value.trim(),
      reason: `${kind} written in the source but not found anywhere in the draft; no record structure to place it`,
      offset: sourceStart + c.offset,
    });
  }

  return {
    result: withItems(result, finalItems),
    telemetry: t, unresolved,
    // The SPLIT happens here, at the point of production, so the two channels
    // can never disagree about what is a question and what is a note to self.
    reviewUnits: buildReviewUnits(runId ?? "", chunkOrdinal, unresolved),
  };
}
