// Library wiring invariants, asserted against source in the style of
// ownership-route.test.mts. Each is a mistake that type-checks perfectly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATION = read("supabase/migrations/0017_library_items.sql");
const SERVICE = read("src/lib/library-service.ts");
const SAVEBACK = read("src/app/api/library/[id]/update-from-item/route.ts");
const DETAIL = read("src/app/api/library/[id]/route.ts");

// ---------------------------------------------------------------------------
// Optimistic concurrency
// ---------------------------------------------------------------------------
test("the direct-edit update is predicated on the reviewed revision", () => {
  // Without the predicate two tabs silently overwrite each other.
  assert.match(SERVICE, /\.eq\("revision", expectedRevision\)/,
    "the UPDATE must only match the revision the editor loaded");
});

test("both write paths REFUSE without an expected revision rather than guessing", () => {
  for (const [name, src] of [["direct edit", DETAIL], ["save-back", SAVEBACK]] as const) {
    assert.match(src, /typeof expected(Revision)? !== "number"/,
      `${name} must require the reviewed revision`);
  }
});

test("the atomic writer checks the revision under a row lock, inside the function", () => {
  // A check outside the lock is not a check: two callers could both read the
  // same revision and both believe they won.
  const fn = MIGRATION.slice(MIGRATION.indexOf("function public.library_update_from_item"));
  const lock = fn.indexOf("for update");
  const compare = fn.indexOf("v_current <> p_expected_revision");
  assert.ok(lock > 0, "the library row must be locked");
  assert.ok(compare > lock, "and locked BEFORE the revision is compared");
});

test("a stale revision returns a sentinel, not an exception", () => {
  // An exception invites blind retry, which is the overwrite this prevents.
  const fn = MIGRATION.slice(MIGRATION.indexOf("function public.library_update_from_item"));
  assert.match(fn.slice(0, fn.indexOf("select i.title")), /return -1;/);
  assert.match(SAVEBACK, /revision_conflict/);
  assert.match(SAVEBACK, /recomputeAfterConflict/,
    "a conflict must return the RECOMPUTED comparison, not the stale one");
});

// ---------------------------------------------------------------------------
// Cross-table atomicity
// ---------------------------------------------------------------------------
test("both cross-table operations write inside ONE function, not two statements", () => {
  for (const fnName of ["library_update_from_item", "library_save_as_new_from_item"]) {
    const fn = MIGRATION.slice(MIGRATION.indexOf(`function public.${fnName}`));
    const body = fn.slice(0, fn.indexOf("$$;"));
    assert.match(body, /update public\.items/,
      `${fnName} must refresh the descendant's lineage itself`);
    assert.match(body, /library_item_revision/,
      `${fnName} must write the revision, not just the id`);
  }
});

test("the service does NOT re-implement those writes outside the function", () => {
  // A second write path would reintroduce exactly the partial state the
  // functions exist to prevent.
  const after = SERVICE.slice(SERVICE.indexOf("updateLibraryFromItem"));
  assert.doesNotMatch(after, /from\("items"\)[\s\S]{0,200}\.update\(/,
    "the descendant's revision must be refreshed inside the transaction only");
});

// ---------------------------------------------------------------------------
// Lineage coherence
// ---------------------------------------------------------------------------
test("half-lineage is unrepresentable in the schema", () => {
  assert.match(MIGRATION, /check \(\(library_item_id is null\) = \(library_item_revision is null\)\)/);
});

test("deleting an entry clears BOTH lineage columns, not just the id", () => {
  // `on delete set null` nulls only the id, which would strand a revision AND
  // violate the check, making deletion fail.
  const trg = MIGRATION.slice(MIGRATION.indexOf("library_clear_descendant_lineage"));
  assert.match(trg, /library_item_id = null, library_item_revision = null/);
  assert.match(MIGRATION, /before delete on public\.library_items/,
    "it must run BEFORE the FK's own action");
});

test("every route that sets lineage sets both columns together", () => {
  const save = read("src/app/api/library/route.ts");
  // Backreferenced on purpose: both columns must come from the SAME entry, so
  // this keeps holding under a rename and still fails if the two ever diverge.
  assert.match(save, /library_item_id: (\w+)\.id, library_item_revision: \1\.revision/);
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------
test("every library query is scoped by user_id, never inferred", () => {
  // RLS is on with no policy, so the table is service-role only — which makes
  // ownership this layer's job rather than the database's.
  // Window after each call site rather than a lazy match to ";" — these chains
  // span several lines and contain semicolons of their own.
  const parts = SERVICE.split('from("library_items")').slice(1);
  assert.ok(parts.length >= 4, `expected several library queries, found ${parts.length}`);
  for (const [i, part] of parts.entries()) {
    const window = part.slice(0, 400);
    assert.ok(/eq\("user_id", userId\)|user_id: userId/.test(window),
      `library query ${i + 1} has no explicit owner predicate:\n${window.slice(0, 200)}`);
  }
});

test("the RPCs verify item ownership through the packet, since items carry no user_id", () => {
  for (const fnName of ["library_update_from_item", "library_save_as_new_from_item"]) {
    const fn = MIGRATION.slice(MIGRATION.indexOf(`function public.${fnName}`));
    const body = fn.slice(0, fn.indexOf("$$;"));
    // Order-independent: the SQL selects pk.user_id BEFORE naming the join.
    assert.match(body, /join public\.packets pk/, `${fnName} must join packets`);
    assert.match(body, /pk\.user_id/, `${fnName} must read the owner from the packet`);
    assert.match(body, /join public\.sections s/, `${fnName} must reach it through sections`);
    assert.match(body, /v_item_owner <> p_owner/, `${fnName} must reject a foreign item`);
  }
});

test("a Library insertion must not fabricate ingestion provenance", () => {
  // 0014 provenance means "this came from an import". A Library copy did not,
  // so ownership recompute must decline for it rather than guess — which is
  // what keeps the 0016 gate honest.
  for (const src of [read("src/app/api/library/route.ts"), SAVEBACK, SERVICE]) {
    assert.doesNotMatch(src, /origin_run_id|origin_chunk_ordinal|origin_emit_index/,
      "no Library path may write 0014 provenance");
  }
});

// ---------------------------------------------------------------------------
// Block mode is refused, and WHY — pinned so this is not re-attempted blind.
//
// The first attempt at supporting it reasoned from the wrong evidence: item
// blocks are created in exactly one place (convert_packet_to_blocks), so it
// looked like the only gap was a missing packet_blocks row. It was not.
//
// trg_freeze_items (0007) rejects INSERT, DELETE, section_id and sort_order
// changes for ANY item whose packet is in block mode, and trg_freeze_sections
// does the same for sections. In block mode composition is owned by
// packet_blocks and the items/sections substrate is deliberately FROZEN — only
// content edits are allowed. So the item INSERT itself is rejected by the
// database, before any question of blocks arises.
//
// Supporting Library insertion there means changing that invariant, which is a
// composition decision rather than a Library one.
// ---------------------------------------------------------------------------
const FROMLIB = read("src/app/api/packets/[id]/items/from-library/route.ts");

test("the freeze that makes block-mode insertion impossible still exists", () => {
  // If this ever stops being true, the refusal below should be revisited —
  // deliberately, not by accident.
  const m7 = read("supabase/migrations/0007_packet_blocks_r1a.sql");
  assert.match(m7, /create trigger trg_freeze_items/);
  assert.match(m7, /items are frozen: cannot INSERT an item into a block-mode packet/);
  assert.match(m7, /create trigger trg_freeze_sections/);
});

test("the route refuses block packets rather than failing at the database", () => {
  assert.match(FROMLIB, /composition_mode === "blocks"/);
  assert.match(FROMLIB, /unsupported_composition/);
  // The refusal must come BEFORE any write is attempted.
  const guard = FROMLIB.indexOf('composition_mode === "blocks"');
  const insert = FROMLIB.indexOf('from("items").insert');
  assert.ok(guard > 0 && guard < insert, "refuse before writing, not after");
});

test("the refusal explains that this is structural, not unimplemented", () => {
  // A future reader who sees only "isn't available yet" will try to add it and
  // rediscover the freeze the hard way, as I did.
  assert.match(FROMLIB, /trg_freeze_items/,
    "the guard's comment must name the trigger that makes this impossible");
});

test("no Library affordance is offered in the block editor", () => {
  const blockEditor = read("src/components/editor/block-packet-editor.tsx");
  assert.doesNotMatch(blockEditor, /LibraryPicker|BulkPromote/,
    "offering an action the database will refuse is worse than not offering it");
});

test("the route still writes no 0014 provenance", () => {
  assert.doesNotMatch(FROMLIB, /origin_run_id|origin_chunk_ordinal|origin_emit_index/);
});
