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
  assert.match(save, /library_item_id: item\.id, library_item_revision: item\.revision/);
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
// Block-mode insertion (0018).
//
// An item and its packet_blocks row are a bijection the database enforces.
// Created as two statements from the application, a failure between them leaves
// the packet permanently inconsistent AND unpublishable, with no affordance
// anywhere to repair it — strictly worse than the partial states we have already
// refused elsewhere, because there is no UI that can even see the orphan.
// ---------------------------------------------------------------------------
const M18 = read("supabase/migrations/0018_library_block_insert.sql");
/** Executable SQL only. Ordering assertions against the raw file match the
 *  explanatory comments instead of the statements, which is how a correct
 *  function reads as broken. */
const M18_SQL = M18.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const FROMLIB = read("src/app/api/packets/[id]/items/from-library/route.ts");

test("item and block are created inside ONE function, never as two statements", () => {
  const fn = M18.slice(M18.indexOf("function public.library_insert_item_block"));
  const body = fn.slice(0, fn.indexOf("$$;"));
  assert.match(body, /insert into public\.items/, "the item is created here");
  assert.match(body, /insert into public\.packet_blocks/, "and so is its block");
  assert.match(body, /block_type/, "as an item block");
});

test("the function asserts the bijection before committing", () => {
  // The same assertion add_heading_block runs. Inside the transaction, so a
  // broken bijection writes nothing at all rather than being discovered later.
  const fn = M18_SQL.slice(M18_SQL.indexOf("function public.library_insert_item_block"));
  const body = fn.slice(0, fn.indexOf("$$;"));
  assert.match(body, /perform public\.assert_packet_block_consistency/);
  const insert = body.indexOf("insert into public.packet_blocks");
  const assertAt = body.indexOf("assert_packet_block_consistency");
  assert.ok(assertAt > insert, "and asserts AFTER writing, not before");
});

test("the packet is locked before a position is chosen", () => {
  // max(position)+1 read outside a lock lets two concurrent inserts pick the
  // same position and collide on unique(packet_id, position).
  const fn = M18_SQL.slice(M18_SQL.indexOf("function public.library_insert_item_block"));
  const lock = fn.indexOf("for update");
  const pos = fn.indexOf("max(position)");
  assert.ok(lock > 0 && pos > lock, "the packet row must be locked first");
});

test("it APPENDS and cannot place a block at a caller-chosen position", () => {
  // This is what keeps it a Library insertion rather than a general
  // "add an arbitrary item block" feature nobody asked for.
  const fn = M18.slice(M18.indexOf("function public.library_insert_item_block"));
  const sig = fn.slice(0, fn.indexOf("returns uuid"));
  assert.doesNotMatch(sig, /p_position/, "no caller-supplied position");
  assert.match(fn, /coalesce\(max\(position\) \+ 1, 0\)/, "always appended at the end");
});

test("it takes a library item and nothing that could name arbitrary content", () => {
  const fn = M18.slice(M18.indexOf("function public.library_insert_item_block"));
  const sig = fn.slice(0, fn.indexOf("returns uuid"));
  assert.match(sig, /p_library_item_id uuid/);
  for (const forbidden of ["p_title", "p_description", "p_details", "p_photos"]) {
    assert.ok(!sig.includes(forbidden), `${forbidden} would make this a general block-item writer`);
  }
});

test("owner, draft and block mode are all verified", () => {
  const fn = M18.slice(M18.indexOf("function public.library_insert_item_block"));
  const body = fn.slice(0, fn.indexOf("$$;"));
  assert.match(body, /v_user <> p_owner/, "owner");
  assert.match(body, /v_status <> 'draft'/, "draft");
  assert.match(body, /v_mode <> 'blocks'/, "block mode");
  assert.match(body, /library_items where id = p_library_item_id and user_id = p_owner/,
    "and the library item must belong to the same owner");
});

test("the route sends block packets through the function, not through a raw insert", () => {
  assert.match(FROMLIB, /rpc\("library_insert_item_block"/);
  const blocksBranch = FROMLIB.slice(FROMLIB.indexOf("if (isBlocks)"), FROMLIB.indexOf("} else {"));
  assert.doesNotMatch(blocksBranch, /from\("items"\)\s*\.insert/,
    "a block packet must never get a bare item insert");
});

test("the route still writes no 0014 provenance on either path", () => {
  assert.doesNotMatch(FROMLIB, /origin_run_id|origin_chunk_ordinal|origin_emit_index/);
  const fn = M18.slice(M18.indexOf("function public.library_insert_item_block"));
  assert.doesNotMatch(fn.slice(0, fn.indexOf("$$;")), /origin_run_id/,
    "and neither does the function — a Library copy has no import origin");
});

test("content failure cleanup relies on the cascade, keeping the bijection intact", () => {
  // Deleting the item takes its block with it (packet_blocks.item_id is
  // ON DELETE CASCADE), so the repair cannot itself break consistency.
  assert.match(FROMLIB, /cascades on delete/i);
  assert.match(FROMLIB, /from\("items"\)\.delete\(\)\.eq\("id", itemId\)/);
});
