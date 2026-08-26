import { recordSpan } from "./notes-provenance.ts";

// A PHOTO BELONGS TO THE COMMUNITY WHOSE SOURCE BLOCK CONTAINS IT.
//
// Measured on the real 65-community import: 344 source photos in, 315 out —
// 90 missing from the record whose source lists them, 61 sitting on a
// NEIGHBOUR's record, 0 invented. The arithmetic closes exactly:
// 344 - 90 + 61 = 315.
//
// The cause is not the model. Chunking loses nothing — all 343 distinct URLs
// reach chunk text — but 31 of 65 communities have their `Pictures` block
// SPLIT ACROSS A CHUNK BOUNDARY. The tail arrives in the next chunk, beside
// the next community's text, and is either attached to that community or
// dropped. The continuation merge cannot help: the tail is absorbed under a
// DIFFERENT title, so there is no same-title pair to fold. The "always exactly
// six photos" pattern is simply where the boundary tends to fall.
//
// So attribution is not asked of the model at all. A photo URL appears
// verbatim in exactly one community's source block, which makes its owner a
// fact rather than a judgement. Assigning from the source span places all 343
// correctly — 65 of 65 communities match their source row exactly.
//
// FAILS OPEN, DELIBERATELY. If a record's span cannot be derived, the model's
// own photos are kept and the uncertainty is surfaced. Replacing a real photo
// set with an empty one because a title moved would be a worse failure than
// the one this fixes.

const IMG = /https?:\/\/[^\s"'<>)\]]+?\.(?:jpe?g|png|gif|webp|heic)(?=[\s"'<>)\]]|$)/gi;

export function photosIn(text: unknown): string[] {
  return [...new Set([...String(text ?? "").matchAll(IMG)].map((m) => m[0].trim()))];
}

export interface Attribution {
  /** The photos this record should carry, in source order. */
  photos: string[];
  /** True when the record's own source block was found. */
  resolved: boolean;
  /** Source photos the model had placed here that its block does not list. */
  removed: string[];
  /** Photos from its own block that the model had missed. */
  added: string[];
}

/**
 * Attribute photos to one record from its own block of the FULL source.
 *
 * The full source, not the chunk: the whole point is that a community's photo
 * block can cross a chunk boundary, so a chunk-scoped answer reproduces the bug.
 */
export function attributePhotos(
  proposal: { title?: unknown; photos?: unknown },
  fullSource: string,
  allTitles: string[],
): Attribution {
  const title = String(proposal.title ?? "");
  const had = Array.isArray(proposal.photos) ? (proposal.photos as unknown[]).map((p) => String(p).trim()) : [];
  const span = recordSpan(fullSource, title, allTitles.filter((t) => t !== title));
  if (span === null) return { photos: had, resolved: false, removed: [], added: [] };
  const mine = photosIn(span);
  return {
    photos: mine,
    resolved: true,
    removed: had.filter((p) => !mine.includes(p)),
    added: mine.filter((p) => !had.includes(p)),
  };
}

/** Source photos that reach no record at all — the check that must never be
 *  satisfied by "every record has at least one photo". */
export function unplacedPhotos(records: Array<{ photos?: unknown }>, fullSource: string): string[] {
  const placed = new Set<string>();
  for (const r of records) for (const p of (Array.isArray(r.photos) ? r.photos : [])) placed.add(String(p).trim());
  return photosIn(fullSource).filter((u) => !placed.has(u));
}
