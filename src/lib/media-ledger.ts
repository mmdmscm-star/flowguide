// Exact media accounting for an ingestion run.
//
// The failure this exists for: a chunk boundary landed mid-record, the model
// returned nothing usable for the orphaned tail, and three photos left the
// packet with no error and no warning. A packet was published missing them and
// nobody could have known. Counting is the only defense against a silent loss —
// a check that fires on absence, not on a malformed value.
//
// Scope is deliberately MEDIA, not every URL. Website and reference links may
// legitimately be normalized, deduplicated or omitted by the model, so holding
// them to exact accounting would block imports for non-failures. Link fidelity
// is a separate, later concern.
// See docs/investigations/mid-record-chunk-splits-plan.md.

// Structural, not domain-specific: an extension, never a host or a CDN. Video
// and document URLs are links, not media, and are out of scope for now.
const MEDIA_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "avif", "heic"];

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;

/** True when a URL's PATH (ignoring query and fragment) ends in an image extension. */
export function isMediaUrl(raw: string): boolean {
  const trimmed = (raw || "").trim();
  if (!trimmed) return false;
  let pathname: string;
  try {
    pathname = new URL(trimmed).pathname;
  } catch {
    pathname = trimmed.split("?")[0].split("#")[0];
  }
  const dot = pathname.lastIndexOf(".");
  if (dot === -1) return false;
  return MEDIA_EXTENSIONS.includes(pathname.slice(dot + 1).toLowerCase());
}

export interface SourceMedia {
  url: string;
  /** Offset in the source. Retained so Stage 2 can check ownership, and so the
   *  review UI can show a professional WHERE a photo came from. */
  offset: number;
}

/** Every media URL in the source, in source order, with its offset. */
export function extractSourceMedia(source: string): SourceMedia[] {
  const out: SourceMedia[] = [];
  const re = new RegExp(URL_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(source || "")) !== null) {
    // Trailing punctuation is part of the prose, not the URL.
    const url = m[0].replace(/[.,;:]+$/, "");
    if (isMediaUrl(url)) out.push({ url, offset: m.index });
  }
  return out;
}

export type MediaFailureCode =
  | "media_missing"        // stored fewer times than the source lists it
  | "media_duplicated"     // stored MORE times than the source lists it
  | "media_not_in_source"; // stored but absent from the source

export interface MediaFailure {
  code: MediaFailureCode;
  url: string;
  /** How many times the SOURCE lists this URL (0 = not in source at all). */
  sourceOccurrences?: number;
  /** How many rows actually hold it. */
  storedRows?: number;
  /** Present for source-derived failures; absent for media_not_in_source. */
  offset?: number;
  /** Item ids holding this URL — for duplicated/not-in-source. */
  itemIds?: string[];
}

export interface StoredMedia {
  url: string;
  itemId: string;
}

export interface MediaLedger {
  /** Distinct media URLs in the source. */
  sourceCount: number;
  /** Total occurrences, which may exceed sourceCount when one is listed twice. */
  sourceOccurrences: number;
  storedCount: number;
  /** Objective accounting failures. Non-empty ⇒ the run needs review and
   *  publishing is blocked. These are facts, not heuristics. */
  failures: MediaFailure[];
  ok: boolean;
}

/**
 * Reconcile source media against what was actually stored.
 *
 * `rejected` carries URLs the professional (or a later stage) deliberately
 * declined, with a reason recorded elsewhere; a rejected URL is accounted for
 * and therefore not a failure.
 *
 * NOTE ON WHAT THIS CANNOT SEE: the ledger proves nothing was lost, duplicated,
 * or invented. It does NOT prove a stored photo sits on the RIGHT item —
 * that needs per-item provenance, which is Stage 2. For a detected table,
 * record-atomic segmentation removes the mechanism that misattributed media in
 * the first place; for prose, a wrong-item photo still passes this check.
 */
export function buildMediaLedger(opts: {
  source: string;
  stored: StoredMedia[];
  rejected?: string[];
}): MediaLedger {
  const sourceMedia = extractSourceMedia(opts.source);
  const stored = (opts.stored || []).filter((s) => isMediaUrl(s.url));
  const rejected = new Set((opts.rejected || []).map((u) => u.trim()));

  // OCCURRENCE-AWARE. Stage 1 deduplicated the source, so an author who listed
  // the same photo twice was indistinguishable from a duplicate FlowGuide
  // introduced. Both real incidents contained the former: the client source
  // lists 89033BrookPC twice on purpose. Counting occurrences separates
  // "the author repeated it" from "we duplicated it".
  const sourceCounts = new Map<string, number>();
  const firstOffset = new Map<string, number>();
  for (const m of sourceMedia) {
    sourceCounts.set(m.url, (sourceCounts.get(m.url) ?? 0) + 1);
    if (!firstOffset.has(m.url)) firstOffset.set(m.url, m.offset);
  }

  const storedByUrl = new Map<string, string[]>();
  for (const s of stored) {
    const list = storedByUrl.get(s.url) ?? [];
    list.push(s.itemId);
    storedByUrl.set(s.url, list);
  }

  const failures: MediaFailure[] = [];

  for (const [url, expected] of sourceCounts) {
    if (rejected.has(url)) continue;
    const holders = storedByUrl.get(url) ?? [];
    if (holders.length < expected) {
      failures.push({
        code: "media_missing", url, offset: firstOffset.get(url),
        sourceOccurrences: expected, storedRows: holders.length,
        ...(holders.length ? { itemIds: holders } : {}),
      });
    } else if (holders.length > expected) {
      failures.push({
        code: "media_duplicated", url, offset: firstOffset.get(url),
        sourceOccurrences: expected, storedRows: holders.length, itemIds: holders,
      });
    }
  }

  for (const [url, holders] of storedByUrl) {
    if (!sourceCounts.has(url)) {
      failures.push({
        code: "media_not_in_source", url,
        sourceOccurrences: 0, storedRows: holders.length, itemIds: holders,
      });
    }
  }

  return {
    sourceCount: sourceCounts.size,
    sourceOccurrences: sourceMedia.length,
    storedCount: stored.length,
    failures,
    ok: failures.length === 0,
  };
}

/** One human sentence for the review banner. */
export function describeMediaFailures(failures: MediaFailure[]): string {
  if (failures.length === 0) return "";
  const n = (code: MediaFailureCode) => failures.filter((f) => f.code === code).length;
  const parts: string[] = [];
  const missing = n("media_missing");
  const dup = n("media_duplicated");
  const extra = n("media_not_in_source");
  if (missing) parts.push(`${missing} ${missing === 1 ? "photo is" : "photos are"} missing`);
  if (dup) parts.push(`${dup} ${dup === 1 ? "photo appears" : "photos appear"} on more than one item`);
  if (extra) parts.push(`${extra} stored ${extra === 1 ? "photo isn't" : "photos aren't"} in the pasted source`);
  return parts.join(", ");
}
