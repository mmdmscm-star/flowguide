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

export interface EnforcementTelemetry {
  accepted: number; repaired: number; stripped: number;
  sourceUnresolved: number; attributionUnresolved: number;
  privacyRejected: number; itemsGoverned: number;
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
  unresolved: UnresolvedUnit[];
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
  sourceText: string | null; result: unknown;
}): ChunkEnforcement {
  const { segmentText, chunkOrdinal, sourceStart, sourceText, result } = opts;
  if (!contractEnforcementEnabled()) return { result, telemetry: empty(), unresolved: [] };
  maybeThrowForTest();

  const r = (result ?? {}) as { items?: unknown; sections?: { items?: unknown }[] };
  const items = [
    ...(Array.isArray(r.items) ? r.items : []),
    ...(Array.isArray(r.sections) ? r.sections.flatMap((s) => (Array.isArray(s?.items) ? s.items : [])) : []),
  ].filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object");
  if (!items.length || !sourceText) return { result, telemetry: empty(), unresolved: [] };

  const env = recordEnvelopes(sourceText);
  const parsed = parseClaims(segmentText, chunkOrdinal);
  const a = attributeAll(parsed.claims, parsed.ambiguous, parsed.fragments, env, sourceStart);
  const t = empty();
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
  return { result: withItems(result, items.map((it) => replaced.get(it) ?? it)), telemetry: t, unresolved };
}
