import { createHash } from "node:crypto";
import type { UnresolvedUnit } from "./enforce-chunk";

// UNRESOLVED SOURCE UNITS, PERSISTED FOR THE CREATOR.
//
// Enforcement can refuse a placement the model proposed. The prose is not
// deleted and not silently moved somewhere tidy - both of those are decisions
// the professional never made. It is held here, attached to its record, until
// they say what it is.
//
// WHICH UNITS BLOCK PUBLISHING
// Only `privacy-rejected`. That unit is content the model tried to route into a
// private field with no authority from the source, so publishing without a
// decision means a recipient silently never sees something the source said -
// the exact failure the private-note work closed.
//
// `source-unresolved` is a value the reconciler could not bind to a claim. It
// is evidence, and it stays in the fact ledger where the other evidence lives.
// Blocking on it would put nearly every import into review and teach people to
// click through the block, which is worse than not having one.

export const BLOCKING_KINDS = new Set(["privacy-rejected"]);

export interface ReviewFailure {
  id: string;
  code: string;
  kind?: string;
  record?: number;
  title?: string | null;
  /** The verbatim source excerpt. Present ONLY while unresolved - the RPC
   *  removes it on resolve or ignore. */
  text?: string;
  reason?: string;
  itemIds?: string[];
  status?: string;
  resolved_at?: string;
}

/** Deterministic, content-derived, stable across reloads and replays.
 *  A positional id would move whenever anything else in the array changed, and
 *  a stale client would then clear a different unit than the one on screen. */
export function unitId(runId: string, u: { record: number; kind: string; text: string }): string {
  return "u_" + createHash("sha256")
    .update([runId, u.record, u.kind, u.text].join(" "))
    .digest("hex").slice(0, 16);
}

/** Units to review failures. Deduped by id: the same excerpt on the same record
 *  is one decision, not two, however many chunks reported it. */
export function toReviewFailures(
  runId: string,
  units: UnresolvedUnit[],
  itemIdByTitle?: Map<string, string[]>,
): ReviewFailure[] {
  const out = new Map<string, ReviewFailure>();
  for (const u of units) {
    if (!BLOCKING_KINDS.has(u.kind)) continue;
    const text = String(u.text ?? "").trim();
    if (!text) continue;
    const id = unitId(runId, { record: u.record, kind: u.kind, text });
    if (out.has(id)) continue;
    const ids = u.title ? itemIdByTitle?.get(u.title) : undefined;
    out.set(id, {
      id, code: "unresolved_source_unit", kind: u.kind, record: u.record,
      title: u.title ?? null, text, reason: u.reason, status: "unresolved",
      // An ambiguous title must not name a specific item. The title itself is
      // shown either way, so the professional still knows what they are looking
      // at; pointing at the wrong item would be worse than pointing at none.
      ...(ids && ids.length === 1 ? { itemIds: ids } : {}),
    });
  }
  return [...out.values()];
}

/** A failure the professional can actually decide. Everything else - a missing
 *  photo, a run that produced nothing - has its own remediation and keeps its
 *  existing exit. */
export function isResolvable(f: ReviewFailure): boolean {
  return f?.code === "unresolved_source_unit" && typeof f?.id === "string" && f.id.length > 0;
}

/** Mirrors the RPC's count exactly: a failure with no `status` key is legacy
 *  and counts as OUTSTANDING. Reading a missing status as "handled" would let a
 *  run finalize with real work still in it. */
export function unresolvedCount(failures: ReviewFailure[] | undefined): number {
  return (failures ?? []).filter((f) => (f?.status ?? "unresolved") === "unresolved").length;
}

/** True when a remaining blocker is one of the non-resolvable kinds, i.e. the
 *  per-unit controls cannot clear this run and discard is still the exit. */
export function hasUnresolvableBlocker(failures: ReviewFailure[] | undefined): boolean {
  return (failures ?? []).some((f) => !isResolvable(f) && (f?.status ?? "unresolved") === "unresolved");
}
