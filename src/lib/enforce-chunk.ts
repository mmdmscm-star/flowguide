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
import { recordEnvelopes, attributeAll, bindByProvenance } from "./attribution.ts";
import { reconcile } from "./reconcile.ts";
import { enforceItem, sourceGrantsPrivacy, contractEnforcementEnabled } from "./enforce.ts";
import { buildReviewUnits, type ReviewFailure } from "./review-units.ts";

export interface EnforcementTelemetry {
  accepted: number; repaired: number; stripped: number;
  sourceUnresolved: number; attributionUnresolved: number;
  privacyRejected: number; itemsGoverned: number;
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
  kind: "privacy-rejected" | "source-unresolved";
  text: string;
  reason: string;
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
  attributionUnresolved: 0, privacyRejected: 0, itemsGoverned: 0,
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
  const parsed = parseClaims(segmentText, chunkOrdinal);
  const a = attributeAll(parsed.claims, parsed.ambiguous, parsed.fragments, env, sourceStart);
  const t: EnforcementTelemetry = { ...empty(), scope };
  const unresolved: UnresolvedUnit[] = [];
  t.attributionUnresolved = a.unattributedClaims.length + a.unattributedAmbiguous.length;

  const bound = env ? bindByProvenance(env, sourceText, items).bound : new Map<number, Record<string, unknown>>();
  const privacyGranted = sourceGrantsPrivacy(segmentText);
  const replaced = new Map<Record<string, unknown>, Record<string, unknown>>();

  for (const [rec, g] of a.byRecord) {
    const item = bound.get(rec);
    if (!item) { t.attributionUnresolved += g.claims.length + g.ambiguous.length; continue; }
    const res = reconcile({ claims: g.claims, ambiguous: g.ambiguous, fragments: g.fragments }, item);
    const e = enforceItem(item, res.resolutions, g.claims, { privacyGranted });
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
    for (const r of res.resolutions.filter((x) => x.outcome === "SOURCE_UNRESOLVED")) {
      unresolved.push({ record: rec, title: String(item.title ?? "") || null,
        kind: "source-unresolved", text: r.value, reason: r.why });
    }
    replaced.set(item, e.item);
  }
  return {
    result: withItems(result, items.map((it) => replaced.get(it) ?? it)),
    telemetry: t, unresolved,
    // The SPLIT happens here, at the point of production, so the two channels
    // can never disagree about what is a question and what is a note to self.
    reviewUnits: buildReviewUnits(runId ?? "", chunkOrdinal, unresolved),
  };
}
