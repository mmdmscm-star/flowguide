// Library decision logic — pure, no I/O.
//
// Everything that decides what "Update Library version" is allowed to do, and
// what the professional is told before it happens, lives here so it can be
// tested exhaustively without a database.
//
// THE TWO WAYS A REPLACEMENT CAN QUIETLY DESTROY WORK:
//
//   1. A TAILORED DESCENDANT. A Library entry is the reusable base — a community
//      with AL studio/1BR/2BR pricing, memory care, second-person and pet fees.
//      A packet copy is an audience-specific communication and may keep only
//      2BR + second-person + pet. Replacing the base with that subset silently
//      deletes the rest for every future packet.
//
//   2. A STALE DESCENDANT. The packet copy was taken from an older Library
//      state. If the Library entry has been edited directly since, replacing it
//      overwrites those newer edits with values derived from what it looked like
//      before them.
//
// Both are ordinary, not edge cases. Neither is solved by merging: this file
// only ever DESCRIBES what a replacement would do, and lets that description
// decide which action is offered first. There is no synchronization anywhere,
// and nothing here mutates anything.

import type { ItemContentPayload } from "./item-content.ts";

/** A Library snapshot plus the inert lineage a descendant records about it. */
export interface LibraryAncestry {
  /** items.library_item_id — null once the ancestor is deleted (`set null`). */
  libraryItemId: string | null;
  /** items.library_item_revision — the ancestor's revision at copy time. */
  copiedFromRevision: number | null;
  /** library_items.revision — what the ancestor is at NOW. */
  currentRevision: number | null;
}

export type ContentField = "details" | "links" | "photos" | "contacts";

export interface FieldDiff {
  field: ContentField;
  added: string[];
  removed: string[];
  changed: string[];
}

export interface ContentDiff {
  /** Scalar fields whose text differs. */
  scalarsChanged: Array<"title" | "address" | "description" | "notes">;
  fields: FieldDiff[];
  /** True when the descendant lacks anything the ancestor has. THE dangerous
   *  direction: it is the one that deletes reusable content. */
  hasRemovals: boolean;
  /** True when anything at all differs. */
  hasChanges: boolean;
}

/** The identity a diff compares entries by — stable, human-recognisable, and
 *  the same thing the professional sees in the confirmation. */
const keyOf = (field: ContentField, row: Record<string, unknown> | string): string => {
  // A row is normally an object. Photos are the exception: an entry imported
  // before the normaliser existed stores urls as bare strings, and the widened
  // parameter is what lets that be READ rather than silently keyed as "".
  const obj = (typeof row === "string" ? {} : row) as Record<string, unknown>;
  switch (field) {
    case "details":  return String(obj.label ?? "").trim();
    case "links":    return String(obj.url ?? "").trim();
    // Tolerates a bare string as well as {url}: an entry imported before the
    // normaliser existed stores urls as strings, and reading those as "" would
    // make every photo compare equal and hide real removals.
    case "photos":   return typeof row === "string" ? row.trim() : String(obj.url ?? "").trim();
    case "contacts": return String(obj.name ?? "").trim();
  }
};

/** What a row's value is, for detecting a change at the same key. */
const valueOf = (field: ContentField, row: Record<string, unknown>): string => {
  switch (field) {
    case "details":  return String(row.value ?? "");
    case "links":    return String(row.label ?? "");
    case "photos":   return "";   // a photo is identified BY its url; nothing else to change
    case "contacts": return JSON.stringify([row.role, row.phone, row.email, row.website]);
  }
};

function diffField(
  field: ContentField,
  ancestor: Array<Record<string, unknown>>,
  descendant: Array<Record<string, unknown>>,
): FieldDiff {
  const a = new Map<string, string>();
  for (const row of ancestor) {
    const k = keyOf(field, row);
    if (k) a.set(k, valueOf(field, row));
  }
  const d = new Map<string, string>();
  for (const row of descendant) {
    const k = keyOf(field, row);
    if (k) d.set(k, valueOf(field, row));
  }

  const added = [...d.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !d.has(k));
  const changed = [...d.keys()].filter((k) => a.has(k) && a.get(k) !== d.get(k));
  return { field, added, removed, changed };
}

const asRows = (v: unknown): Array<Record<string, unknown>> =>
  Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];

/**
 * What replacing the ancestor with the descendant would do.
 *
 * Direction matters and is not symmetric: `removed` means the DESCENDANT lacks
 * something the ANCESTOR has, so a replacement would destroy it.
 */
export function diffItemContent(
  ancestor: ItemContentPayload,
  descendant: ItemContentPayload,
): ContentDiff {
  const scalarsChanged = (["title", "address", "description", "notes"] as const)
    .filter((k) => (ancestor[k] ?? "") !== (descendant[k] ?? ""));

  const fields = (["details", "links", "photos", "contacts"] as const)
    .map((f) => diffField(f, asRows(ancestor[f]), asRows(descendant[f])));

  const hasRemovals = fields.some((f) => f.removed.length > 0);
  const hasChanges =
    scalarsChanged.length > 0 ||
    fields.some((f) => f.added.length || f.removed.length || f.changed.length);

  return { scalarsChanged, fields, hasRemovals, hasChanges };
}

export type SaveBackAction = "update" | "save_as_new" | "save_new_ancestor_gone" | "none";

export interface SaveBackDecision {
  /** What the confirmation offers FIRST. Never destructive by default. */
  primary: SaveBackAction;
  /** Offered as an explicit, secondary professional decision. */
  secondary: SaveBackAction[];
  /** The ancestor was edited directly since this copy was taken. */
  ancestorMovedOn: boolean;
  /** Replacing would delete content the ancestor has. */
  wouldRemoveContent: boolean;
  /** Machine-readable reasons, so the dialog is driven by facts not prose. */
  warnings: Array<"ancestor_deleted" | "ancestor_moved_on" | "removals" | "no_changes">;
}

/**
 * Decide what to offer for "Update Library version".
 *
 * The rule, in one line: **a replacement is never the default when it would
 * destroy something** — either the ancestor's exclusive content, or edits made
 * to the ancestor since this copy was taken.
 */
export function decideSaveBack(
  ancestry: LibraryAncestry,
  diff: ContentDiff | null,
): SaveBackDecision {
  // The ancestor is gone. `on delete set null` guarantees the packet copy was
  // untouched, and the only honest offer is to save a NEW entry — never to
  // resurrect a record the professional deleted on purpose.
  if (ancestry.libraryItemId === null) {
    return {
      primary: "save_new_ancestor_gone", secondary: [],
      ancestorMovedOn: false, wouldRemoveContent: false,
      warnings: ["ancestor_deleted"],
    };
  }

  const ancestorMovedOn =
    ancestry.copiedFromRevision !== null &&
    ancestry.currentRevision !== null &&
    ancestry.currentRevision > ancestry.copiedFromRevision;

  if (!diff || !diff.hasChanges) {
    return {
      primary: "none", secondary: ancestorMovedOn ? ["update"] : [],
      ancestorMovedOn, wouldRemoveContent: false,
      warnings: ancestorMovedOn ? ["no_changes", "ancestor_moved_on"] : ["no_changes"],
    };
  }

  const warnings: SaveBackDecision["warnings"] = [];
  if (ancestorMovedOn) warnings.push("ancestor_moved_on");
  if (diff.hasRemovals) warnings.push("removals");

  // Removals are the destructive direction, so replacement stops being the
  // default — but stays available, because a professional may genuinely have
  // pruned something obsolete.
  if (diff.hasRemovals) {
    return {
      primary: "save_as_new", secondary: ["update"],
      ancestorMovedOn, wouldRemoveContent: true, warnings,
    };
  }

  // Pure additions or edits. Replacement is the natural action — but when the
  // ancestor has moved on it still overwrites newer Library content, so the
  // confirmation must say so rather than presenting a routine update.
  return {
    primary: "update", secondary: ["save_as_new"],
    ancestorMovedOn, wouldRemoveContent: false, warnings,
  };
}

// ---------------------------------------------------------------------------
// Ancestry coherence, mirrored in TypeScript.
//
// The database makes a half state unrepresentable (CHECK + a BEFORE DELETE
// trigger). This mirrors that rule so a route can never CONSTRUCT one and only
// discover it at the constraint — an error surfacing as a 500 from Postgres
// instead of a refusal the caller can act on.
// ---------------------------------------------------------------------------

/** True when lineage is one of the two meaningful states. */
export function isLineageCoherent(a: Pick<LibraryAncestry, "libraryItemId" | "copiedFromRevision">): boolean {
  return (a.libraryItemId === null) === (a.copiedFromRevision === null);
}

/** Lineage to write when inserting from the Library. Both columns or neither —
 *  never one. */
export function lineageForInsert(libraryItemId: string, revision: number) {
  return { library_item_id: libraryItemId, library_item_revision: revision };
}

/** Lineage to write when the ancestor is gone. Both cleared together. */
export const CLEARED_LINEAGE = { library_item_id: null, library_item_revision: null } as const;

// ---------------------------------------------------------------------------
// Optimistic concurrency.
//
// The decision the professional reviewed was computed against a revision. The
// Library can change again between reviewing and submitting — another tab,
// another device. A replacement must land only against the state that was
// actually reviewed.
//
// The conflict is NOT an error. It is an ordinary race with a defined
// resolution: recompute the comparison and show what changed. Modelling it as a
// failure would push callers toward retrying blindly, which is exactly the
// overwrite this exists to prevent.
// ---------------------------------------------------------------------------

/** The sentinel `library_update_from_item` returns when the revision moved. */
export const REVISION_CONFLICT = -1;

export type SaveBackResult =
  | { status: "updated"; revision: number }
  | { status: "conflict"; currentRevision: number; diff: ContentDiff; decision: SaveBackDecision };

/** Did the atomic writer refuse because the reviewed revision was stale? */
export const isRevisionConflict = (returned: number | null): boolean =>
  returned === REVISION_CONFLICT;

/**
 * What to send a caller after a conflict: the CURRENT comparison, not the stale
 * one they submitted against. The professional then decides again with accurate
 * information — which is the whole point of refusing the write.
 */
export function recomputeAfterConflict(
  currentSnapshot: ItemContentPayload,
  descendant: ItemContentPayload,
  ancestry: LibraryAncestry,
): { diff: ContentDiff; decision: SaveBackDecision } {
  const diff = diffItemContent(currentSnapshot, descendant);
  return { diff, decision: decideSaveBack(ancestry, diff) };
}

// ---------------------------------------------------------------------------
// Duplicate detection, for Save to Library.
// ---------------------------------------------------------------------------

const norm = (s: string | undefined) =>
  (s ?? "").toLowerCase().replace(/\s+/g, " ").replace(/[.,#]/g, "").trim();

/**
 * Warn, never merge and never block. Two genuinely different things can share a
 * name — two branches of one operator, two units at one address — and silently
 * merging a professional's content is unrecoverable.
 *
 * Address participates only when BOTH sides have one: a Library entry saved
 * without an address should still match its namesake rather than being treated
 * as a different place on the strength of an absence.
 */
export function isDuplicateCandidate(a: ItemContentPayload, b: ItemContentPayload): boolean {
  const ta = norm(a.title), tb = norm(b.title);
  if (!ta || !tb || ta !== tb) return false;
  const aa = norm(a.address), ab = norm(b.address);
  if (aa && ab) return aa === ab;
  return true;
}
