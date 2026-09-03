import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assessRecovery, projectRawInput, recoveryMessage, APPEND_DELIMITER } from "./ingest-recovery.ts";

const codeOf = (p: string) => readFileSync(p, "utf8");
const OLD = "https://cdn.example.com/earlier-work/cedar-ridge.jpg";
const NEW = "https://cdn.example.com/new-import/harbor-light.jpg";
const PASTED = "https://images.example.net/pasted-during-the-run.jpg";
const UPLOADED = "https://x.supabase.co/storage/v1/object/public/packet-photos/u/abc.jpg";

const EARLIER = `Cedar Ridge\nPhoto: ${OLD}\n`;
const NEWSRC  = `Harbor Light\nPhoto: ${NEW}\n`;

// ---------------------------------------------------------------------------
// THE PROJECTION — the bug that made recovery useless
// ---------------------------------------------------------------------------

test("PROJECTION mirrors finalize: organize REPLACES, append CONCATENATES", () => {
  assert.equal(projectRawInput("organize", EARLIER, NEWSRC), NEWSRC);
  assert.equal(projectRawInput("append", EARLIER, NEWSRC), EARLIER + APPEND_DELIMITER + NEWSRC);
  assert.equal(projectRawInput("section_append", EARLIER, NEWSRC), EARLIER + APPEND_DELIMITER + NEWSRC);
});

test("THE DELIMITER MATCHES THE ONE FINALIZE WRITES", () => {
  // A second copy of a literal is a drift risk. finalize declares it as
  //   v_delim constant text := E'\n\n--- Added ---\n\n';
  // If that ever changes, this fails instead of the projection silently
  // disagreeing with reality and falsely blocking recovery.
  const sql = codeOf("supabase/migrations/0026_packet_evidence_retention.sql");
  const m = /v_delim\s+constant\s+text\s*:=\s*E'([^']*)'/.exec(sql);
  assert.ok(m, "finalize no longer declares v_delim — re-verify the projection by hand");
  const fromSql = m[1].replace(/\\n/g, "\n");
  assert.equal(fromSql, APPEND_DELIMITER, "the projected delimiter no longer matches finalize's");
});

// ---------------------------------------------------------------------------
// THE FOUNDER'S CASE: historical media must not block recovery
// ---------------------------------------------------------------------------

test("A HISTORICAL EXTERNAL PHOTO DOES NOT BLOCK RECOVERY", () => {
  // An append whose new source has no reason to mention a photo from an
  // earlier import. Judging against the run's source alone reported it as
  // media_not_in_source and refused recovery on an ordinary Sendset.
  const v = assessRecovery({
    entryPoint: "append", rawInput: EARLIER, sourceText: NEWSRC,
    storedPhotos: [{ url: OLD, itemId: "i1" }],
  });
  assert.equal(v.canApply, true, `falsely blocked: ${JSON.stringify(v.blockers)}`);
  assert.deepEqual(v.blockers, []);
});

test("AN EXTERNAL PHOTO PASTED DURING THE RUN DOES block recovery", () => {
  const v = assessRecovery({
    entryPoint: "append", rawInput: EARLIER, sourceText: NEWSRC,
    storedPhotos: [{ url: OLD, itemId: "i1" }, { url: PASTED, itemId: "i1" }],
  });
  assert.equal(v.canApply, false, "a photo from nowhere was allowed through");
  const b = v.blockers.find((x) => x.code === "media_not_in_source") as { urls: string[] } | undefined;
  assert.deepEqual(b?.urls, [PASTED], "blocked on the wrong photo");
});

test("media_missing and media_duplicated do NOT block the pre-apply path", () => {
  // The run's own photos are legitimately not stored yet — it hasn't applied.
  // Treating every ledger failure as a blocker refuses a perfectly clean packet.
  const v = assessRecovery({
    entryPoint: "append", rawInput: EARLIER, sourceText: NEWSRC,
    storedPhotos: [{ url: OLD, itemId: "i1" }],   // NEW is promised but absent
  });
  assert.equal(v.canApply, true, "media_missing blocked the recovery path");
});

test("a creator-uploaded photo never blocks, in any source", () => {
  const v = assessRecovery({
    entryPoint: "organize", rawInput: "", sourceText: "no photos here",
    storedPhotos: [{ url: UPLOADED, itemId: "i1" }],
  });
  assert.equal(v.canApply, true, "an uploaded photo was treated as unaccountable");
});

// ---------------------------------------------------------------------------
// section_append destination
// ---------------------------------------------------------------------------

test("A MISSING section_append TARGET CANNOT BE OVERRIDDEN", () => {
  const v = assessRecovery({
    entryPoint: "section_append", rawInput: EARLIER, sourceText: NEWSRC,
    storedPhotos: [], targetSectionValid: false,
  });
  assert.equal(v.canApply, false, "offered to apply into a section that no longer exists");
  assert.ok(v.blockers.some((b) => b.code === "target_section_missing"));
  assert.match(recoveryMessage(v), /no longer exists/i);
});

test("a section_append with a LIVE target can be recovered", () => {
  const v = assessRecovery({
    entryPoint: "section_append", rawInput: EARLIER, sourceText: NEWSRC,
    storedPhotos: [{ url: OLD, itemId: "i1" }], targetSectionValid: true,
  });
  assert.equal(v.canApply, true, `blocked: ${JSON.stringify(v.blockers)}`);
});

test("the messages say what happened and what will happen", () => {
  const ok = recoveryMessage({ canApply: true, blockers: [] });
  assert.match(ok, /changed while AI was working/i);
  assert.match(ok, /nothing has been lost/i);
  const media = recoveryMessage({ canApply: false, blockers: [{ code: "media_not_in_source", urls: [PASTED] }] });
  assert.match(media, /unpublishable/i, "the consequence of applying is not stated");
});

// ---------------------------------------------------------------------------
// WIRING — the guard is worth nothing if the paths do not use it
// ---------------------------------------------------------------------------

test("the finalize route asks assessRecovery before offering the override", () => {
  const r = codeOf("src/app/api/ingest/[runId]/finalize/route.ts");
  assert.match(r, /error: "structure_changed"/, "a structural conflict is still reported as a failure");
  assert.match(r, /assessRunRecovery\(supabase, runId\)/, "the override is offered without checking");
  assert.match(r, /rebaseline_ingestion_run/, "the accept path does not re-baseline");
  assert.match(r, /status: 409/, "the conflict is not a 409");
});

test("the client STOPS on a structural conflict instead of spinning", () => {
  // Both "not done yet" and this arrive as 409. Treating this one as
  // "keep driving" would loop against a condition that never clears.
  const h = codeOf("src/lib/useIngestion.ts");
  const i = h.indexOf('fin.data?.error === "structure_changed"');
  const j = h.indexOf("if (fin.status === 409)");
  assert.ok(i > -1, "the client does not recognise a structural conflict");
  assert.ok(i < j, "the generic 409 retry is checked BEFORE the conflict — it will spin");
  assert.match(h, /phase: "conflict"/, "there is no conflict state to render");
});

test("the panel offers 'Add' ONLY when the server said it can be applied", () => {
  const c = codeOf("src/components/ImportProgress.tsx");
  assert.match(c, /recovery\?\.canApply === true/, "the panel decides for itself whether to offer the override");
  const panel = c.slice(c.indexOf('phase === "conflict"'));
  const addIdx = panel.indexOf("Add the organized content");
  assert.ok(addIdx > -1, "no recovery action is offered at all");
  assert.ok(panel.slice(0, addIdx).includes("canApply &&"), "the Add action is not gated on canApply");
  assert.match(panel, /Discard this import/, "there is no way out when recovery is impossible");
});

test("REBASELINE ENFORCES ITS OWN INVARIANTS — it does not trust the UI", () => {
  const sql = codeOf("supabase/migrations/0034_structural_rev.sql");
  const fn = sql.slice(sql.indexOf("create or replace function public.rebaseline_ingestion_run"));
  for (const [what, re] of [
    ["ownership of the run", /v_run\.user_id <> p_owner/],
    ["ownership of the packet", /v_puser <> p_owner/],
    ["draft status", /v_pstatus <> 'draft'/],
    ["the run is active", /v_run\.status <> 'active'/],
    ["the destination guard", /v_run\.destination <> 'packet'/],
    ["the section_append target", /target section no longer valid/],
    ["a fixed search_path", /set search_path = ''/],
    ["security definer", /security definer/],
  ] as const) {
    assert.match(fn, re, `rebaseline does not enforce ${what}`);
  }
  assert.match(sql, /revoke all on function public\.rebaseline_ingestion_run\(uuid, uuid\)/, "the new RPC is not revoked");
  assert.match(sql, /grant execute on function public\.rebaseline_ingestion_run\(uuid, uuid\) to service_role/, "not granted to service_role");
});

test("metadata is not in the structural trigger, and structure is", () => {
  const sql = codeOf("supabase/migrations/0034_structural_rev.sql");
  // The three child triggers move both counters...
  assert.equal((sql.match(/content_rev = content_rev \+ 1, structural_rev = structural_rev \+ 1/g) ?? []).length, 3);
  // ...and the metadata trigger is not redefined here at all.
  assert.ok(!/create or replace function public\.ingest_bump_packet_self/.test(sql),
    "the metadata trigger was redefined — it must not touch structural_rev");
});

test("THE STRUCTURAL GUARD IS ACTUALLY IN finalize, not just described", () => {
  // A mutation that replaced the guard condition with `if false` was caught
  // only by the database e2e. This is the cheap tripwire beside it.
  const sql = codeOf("supabase/migrations/0034_structural_rev.sql");
  assert.match(sql, /if v_cur_srev <> v_run\.baseline_structural_rev then/,
    "finalize no longer compares structural_rev against the run's baseline");
  assert.match(sql, /raise exception 'ingestion: packet structure changed since the import began/,
    "the guard no longer raises");
  assert.match(sql, /select status, user_id, content_rev, structural_rev into/,
    "finalize does not read structural_rev at all");
  // And the old gate must be gone, or both would have to agree forever.
  assert.ok(!/if v_cur_rev <> v_run\.baseline_content_rev then/.test(sql),
    "the old content_rev gate is still in place — metadata edits will still break runs");
});

test("the migration refuses to apply while a run is in flight", () => {
  const sql = codeOf("supabase/migrations/0034_structural_rev.sql");
  assert.match(sql, /MIGRATION 0034 ABORTED/, "the precondition was removed");
  assert.match(sql, /status in \('active','finalizing'\) and packet_id is not null/,
    "the precondition no longer scopes to runs that could actually finalize");
});

// ---------------------------------------------------------------------------
// 0035 — deleting a section AI is writing into
// ---------------------------------------------------------------------------

test("THE SECTION-DELETE GUARD USES A STABLE SQLSTATE, not English", () => {
  const sql = codeOf("supabase/migrations/0035_block_section_delete_during_ingest.sql");
  assert.match(sql, /using errcode = 'FG001'/, "the refusal carries no machine-readable code");
  assert.match(sql, /detail\s*=\s*'section_append_in_progress'/, "no stable detail identifier");
  assert.match(sql, /before delete on public\.sections/, "the guard is not a BEFORE DELETE on sections");
  assert.match(sql, /status in \('active','finalizing'\)/, "the guard no longer scopes to in-flight runs");
  assert.match(sql, /packet_deleted_at is null/,
    "the packet-cascade exemption is gone — deleting a Sendset will now fail");
  assert.match(sql, /revoke all on function public\.block_section_delete_during_ingest\(\)/,
    "the trigger function is not revoked");
});

test("the route recognises the CODE and never the message text", () => {
  const r = codeOf("src/app/api/sections/route.ts");
  assert.match(r, /\(error as \{ code\?: string \}\)\.code === "FG001"/,
    "the route does not branch on the SQLSTATE");
  assert.match(r, /AI is currently adding content to this section/, "the professional-facing wording is missing");
  assert.match(r, /status: 409/, "a blocked delete is not reported as a conflict");
  // Matching the raw exception text would break the moment the wording changes.
  assert.ok(!/cannot delete a section while an import/.test(r),
    "the route matches the database's English instead of its code");
});

test("A REFUSED SECTION DELETE NO LONGER LOOKS LIKE IT WORKED", () => {
  const e = codeOf("src/components/editor/legacy-packet-editor.tsx");
  const fn = e.slice(e.indexOf("async function deleteSection"), e.indexOf("async function deleteSection") + 1400);
  assert.match(fn, /if \(!res\.ok\)/, "the response is discarded again");
  assert.match(fn, /setSectionError\(/, "a refusal says nothing");
  // The removal from local state must come AFTER the ok check, not before.
  assert.ok(fn.indexOf("if (!res.ok)") < fn.indexOf("setSections((prev) => prev.filter"),
    "the section is removed from the editor even when the server refused");
  assert.match(e, /\{sectionError &&/, "the error is never rendered");
});
