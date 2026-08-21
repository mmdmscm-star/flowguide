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

export interface ChunkEnforcement { result: unknown; telemetry: EnforcementTelemetry }

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

export function enforceChunkResult(opts: {
  segmentText: string; chunkOrdinal: number; sourceStart: number;
  sourceText: string | null; result: unknown;
}): ChunkEnforcement {
  const { segmentText, chunkOrdinal, sourceStart, sourceText, result } = opts;
  if (!contractEnforcementEnabled()) return { result, telemetry: empty() };

  const r = (result ?? {}) as { items?: unknown; sections?: { items?: unknown }[] };
  const items = [
    ...(Array.isArray(r.items) ? r.items : []),
    ...(Array.isArray(r.sections) ? r.sections.flatMap((s) => (Array.isArray(s?.items) ? s.items : [])) : []),
  ].filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object");
  if (!items.length || !sourceText) return { result, telemetry: empty() };

  const env = recordEnvelopes(sourceText);
  const parsed = parseClaims(segmentText, chunkOrdinal);
  const a = attributeAll(parsed.claims, parsed.ambiguous, parsed.fragments, env, sourceStart);
  const t = empty();
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

    // RECIPIENT-INTENDED PROSE THAT LOST ITS PRIVATE FIELD IS NOT DISCARDED.
    // Without source authority a note may not stand, but the words were written
    // for the client. With no narrative field yet, they are appended to the
    // recipient-visible description and counted, rather than hidden or deleted.
    let out = e.item;
    for (const un of e.unresolvedNotes) {
      t.privacyRejected++;
      const desc = String(out.description ?? "").trim();
      out = { ...out, description: desc ? `${desc}\n\n${un.text.trim()}` : un.text.trim() };
    }
    replaced.set(item, out);
  }
  return { result: withItems(result, items.map((it) => replaced.get(it) ?? it)), telemetry: t };
}
