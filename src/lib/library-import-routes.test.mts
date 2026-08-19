// Wiring invariants for the Library AI import, asserted against source.
// Each is a mistake that type-checks perfectly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const IMPORT_DIR = "src/app/api/library/import";

const CREATE = read(`${IMPORT_DIR}/route.ts`);
const PROPOSALS = read(`${IMPORT_DIR}/[runId]/proposals/route.ts`);
const PATCH = read(`${IMPORT_DIR}/[runId]/proposals/[id]/route.ts`);
const SAVE = read(`${IMPORT_DIR}/[runId]/save/route.ts`);
const FINISH = read(`${IMPORT_DIR}/[runId]/finish/route.ts`);
const ABANDON = read(`${IMPORT_DIR}/[runId]/abandon/route.ts`);
const UI = read("src/components/library/import-with-ai.tsx");

/** Every route file under the import tree, for whole-surface assertions. */
function allImportRoutes(dir = IMPORT_DIR): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...allImportRoutes(`${dir}/${e.name}`));
    else if (e.name === "route.ts") out.push(`${dir}/${e.name}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contract 7 — library_save_proposal is the ONLY writer
// ---------------------------------------------------------------------------
test("no import route writes library_items directly", () => {
  // A second writer would reintroduce the crash window 0021 closed, and would
  // bypass the title rule the RPC enforces.
  for (const f of allImportRoutes()) {
    assert.doesNotMatch(read(f), /from\("library_items"\)/,
      `${f} must go through library_save_proposal, never touch library_items itself`);
  }
});

test("the save route calls library_save_proposal, once per proposal", () => {
  assert.match(SAVE, /rpc\("library_save_proposal"/);
  assert.match(SAVE, /for \(const t of targets\)/,
    "one call per proposal, so a single failure cannot fail the batch");
});

test("a null return from the save RPC is treated as already-saved, not as an error", () => {
  assert.match(SAVE, /already_saved/,
    "null means the proposal was consumed by an earlier attempt — a retry, not a failure");
});

// ---------------------------------------------------------------------------
// Contract 1 — create/reuse
// ---------------------------------------------------------------------------
test("the create route passes every parameter the RPC declares", () => {
  for (const p of ["p_owner", "p_source_text", "p_source_hash", "p_source_len",
                   "p_segmenter_version", "p_chunks"]) {
    assert.ok(CREATE.includes(p), `create_library_import_run needs ${p}`);
  }
});

test("chunks are built before the call, so run and chunks are one transaction", () => {
  assert.ok(CREATE.indexOf("buildRunChunks") < CREATE.indexOf('rpc("create_library_import_run"'));
  assert.doesNotMatch(CREATE, /from\("ingestion_chunks"\)\s*\.insert/,
    "inserting chunks from the route is the split-write this design exists to avoid");
});

test("an import already in progress returns WHICH one, not just a refusal", () => {
  assert.match(CREATE, /import_in_progress/);
  assert.match(CREATE, /runId:/,
    "a professional who pastes something new needs to be offered the open import");
});

test("the open import is discoverable without the original text", () => {
  assert.match(CREATE, /export async function GET/,
    "reconnecting through POST needs the paste, which a closed tab does not have");
});

// ---------------------------------------------------------------------------
// Contract 2 — materialisation is repeatable and non-destructive
// ---------------------------------------------------------------------------
test("materialisation goes through the RPC, never a route-side insert", () => {
  assert.match(PROPOSALS, /rpc\("library_materialize_proposals"/);
  assert.doesNotMatch(PROPOSALS, /from\("library_import_proposals"\)\s*\.insert/);
});

test("materialisation is refused until extraction is actually finished", () => {
  assert.match(PROPOSALS, /derivePhase\(run\.status, chunks\) !== "review"/,
    "materialising early would present a partial import as the whole thing");
});

// ---------------------------------------------------------------------------
// Contract 3 — source order, not identity order
// ---------------------------------------------------------------------------
test("proposals are returned in SOURCE order on both paths", () => {
  assert.equal((PROPOSALS.match(/orderProposals\(/g) ?? []).length, 2,
    "the GET restore and the POST materialise must both order by source position");
  assert.doesNotMatch(PROPOSALS, /\.order\("ordinal"\)/,
    "ordinal order is identity order; a split chunk's children carry higher ordinals");
});

// ---------------------------------------------------------------------------
// Contract 5 — edits are durable and normalised like every other Library write
// ---------------------------------------------------------------------------
test("a proposal edit is normalised by the same function the Library uses", () => {
  assert.match(PATCH, /normalizeItemContent/,
    "an edited proposal and a hand-written entry must not end up shaped differently");
});

test("edits are refused once the import is closed", () => {
  assert.match(PATCH, /run\.status !== "active"/);
});

// ---------------------------------------------------------------------------
// Contract 6 — finish is not abandon
// ---------------------------------------------------------------------------
test("finish and abandon are separate routes, not one close with an argument", () => {
  assert.match(FINISH, /p_status: "finalized"/);
  assert.match(ABANDON, /p_status: "discarded"/);
  assert.doesNotMatch(FINISH, /discarded/);
  assert.doesNotMatch(ABANDON, /finalized/);
});

test("finishing refuses while anything is unsaved, until acknowledged", () => {
  assert.match(FINISH, /unsavedAtFinish/);
  assert.match(FINISH, /unsaved_proposals/);
  assert.match(FINISH, /discardUnsaved === true/,
    "nothing is deleted by a request that did not know what it was deleting");
});

test("abandoning requires its own explicit confirmation", () => {
  assert.match(ABANDON, /confirm_required/);
  assert.match(ABANDON, /body\.confirm !== true/);
});

test("the UI never sends a bare close — both endings state what they discard", () => {
  assert.match(UI, /discardUnsaved/);
  assert.match(UI, /confirm: true/);
  assert.doesNotMatch(UI, /library_close_import_run/,
    "the client must not reach the generic close directly");
});

// ---------------------------------------------------------------------------
// The shared packet path stays guarded
// ---------------------------------------------------------------------------
test("the chunk route skips the packet lookup for a library run", () => {
  const CHUNK = read("src/app/api/ingest/[runId]/chunks/[ordinal]/route.ts");
  assert.match(CHUNK, /run\.destination === "library"/);
  assert.match(CHUNK, /select\("id, user_id, packet_id, destination/);
});

test("packet finalize refuses a library run with a readable message", () => {
  const FINAL = read("src/app/api/ingest/[runId]/finalize/route.ts");
  assert.match(FINAL, /destination === "library"/);
  assert.match(FINAL, /wrong_destination/);
});

test("library_import reuses the existing items-only prompt and shape", () => {
  assert.match(read("src/lib/ingestion.ts"),
    /entryPoint === "section_append" \|\| entryPoint === "library_import"\) systemPrompt = itemsOnlyPrompt/);
  assert.match(read("src/lib/ingest-validate.ts"), /entryPoint === "library_import" \? "items"/);
});

test("no import route creates packet composition", () => {
  for (const f of allImportRoutes()) {
    for (const t of ['from("packets")', 'from("sections")', 'from("items")', 'from("packet_blocks")']) {
      assert.ok(!read(f).includes(`.${t}.insert`), `${f} must not create packet composition`);
    }
  }
});
