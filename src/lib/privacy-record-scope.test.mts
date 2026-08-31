import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sourceGrantsPrivacy, privateSourceOf, noteSupportedBy, splitFields } from "./enforce.ts";
import { recordEnvelopes } from "./attribution.ts";
import { INTERNAL_ONLY_CSV as CSV } from "./__fixtures__/internal-only-import.ts";

// THE REAL IMPORT THAT EXPOSED THIS.
//
// A CSV with a column headed `INTERNAL ONLY` beside one headed `Client-Facing
// Notes`. Three records ended up in the review panel looking identical:
//
//   Redfern Renovation      INTERNAL ONLY column, explicitly private   → was WRONGLY surfaced
//   Finch & Frame           INTERNAL ONLY column, explicitly private   → was WRONGLY surfaced
//   Coastline Craft         Client-Facing Notes column, NOT private    → correctly surfaced
//
// Two failures came from the marker pattern demanding a colon that a column
// heading does not have. The third is a genuine catch and must stay.
//
// The two corrections are inseparable, and the ORDER matters. Widening the
// pattern alone would have granted privacy chunk-wide — and Coastline shares a
// chunk with an internal marker in both chunks it appears in, so its
// client-facing prose would have been silently hidden from the client. That is
// the harm this contract exists to prevent, and it would have been caused by
// "fixing" the bug. Scope first, then pattern.


/** One record's own text, exactly as enforcement derives it: from the envelope
 *  seg-v4 already tiled the source into, never from a title search. */
function recordText(name: string): string {
  const env = recordEnvelopes(CSV, ",");
  assert.ok(env, "the fixture no longer parses as records");
  const e = env!.find((x) => x.name === name);
  assert.ok(e, `no envelope named ${name}`);
  return CSV.slice(e!.start, e!.end);
}

// ---------------------------------------------------------------------------
// THE THREE RECORDS
// ---------------------------------------------------------------------------
test("Redfern's own row carries an INTERNAL ONLY declaration", () => {
  const t = recordText("Redfern Renovation");
  assert.match(t, /INTERNAL ONLY — Luis said/, "the fixture lost the marker");
  assert.equal(sourceGrantsPrivacy(t), true,
    "an explicit INTERNAL ONLY column value is not recognised as a declaration");
});

test("Finch & Frame's own row does too", () => {
  const t = recordText("Finch & Frame Renovation");
  assert.match(t, /INTERNAL ONLY — Naomi mentioned/);
  assert.equal(sourceGrantsPrivacy(t), true);
});

test("COASTLINE'S OWN ROW DOES NOT — its note came from Client-Facing Notes", () => {
  const t = recordText("Coastline Craft Construction");
  assert.ok(!/INTERNAL ONLY/i.test(t),
    "the fixture changed: Coastline's row now contains an internal marker");
  assert.match(t, /Same Maya Chen who appears at Marin Cabinet Studio/,
    "the client-facing note is missing from the fixture");
  assert.equal(sourceGrantsPrivacy(t), false,
    "a client-facing note would be hidden from the client");
});

// ---------------------------------------------------------------------------
// RECORD SCOPE IS THE LOAD-BEARING PART
// ---------------------------------------------------------------------------
test("THE CHUNK GRANTS WHAT NO RECORD SHOULD — which is why scope came first", () => {
  // The whole file contains internal markers. Asked at chunk scope, every
  // record in it — Coastline included — would be authorised.
  assert.equal(sourceGrantsPrivacy(CSV), true,
    "the fixture no longer demonstrates the hazard");
  assert.equal(sourceGrantsPrivacy(recordText("Coastline Craft Construction")), false,
    "record scope did not narrow the answer, so the widening is unsafe");
});

test("no record is authorised by a NEIGHBOUR's marker", () => {
  const env = recordEnvelopes(CSV, ",")!;
  const authorised = env
    .filter((e) => sourceGrantsPrivacy(CSV.slice(e.start, e.end)))
    .map((e) => e.name);
  // Exactly the two rows whose own INTERNAL ONLY column is populated, plus the
  // header row, whose cells literally are the column names.
  assert.deepEqual(authorised.filter((n) => n !== "Firm").sort(),
    ["Finch & Frame Renovation", "Redfern Renovation"],
    `privacy authority leaked to: ${JSON.stringify(authorised)}`);
});

test("the header row naming the column does not authorise the rows beneath it", () => {
  const env = recordEnvelopes(CSV, ",")!;
  const header = env.find((e) => e.name === "Firm")!;
  assert.match(CSV.slice(header.start, header.end), /INTERNAL ONLY/,
    "the header no longer declares the column");
  // Whatever the header itself says, it is its own record and speaks only for
  // itself. Every ordinary row is judged on its own text.
  for (const n of ["Alder & Stone Remodel", "Marin Cabinet Studio", "Oak & Tile Interiors",
                   "Willow Creek Remodels", "Delta Millwork & Build"]) {
    const e = env.find((x) => x.name === n);
    if (!e) continue;
    assert.equal(sourceGrantsPrivacy(CSV.slice(e.start, e.end)), false,
      `${n} was authorised by the column heading rather than its own content`);
  }
});

// ---------------------------------------------------------------------------
// AND THE RECORD IS NOT THE FIELD
//
// Record scope fixed the neighbour problem and left a smaller version of it.
// Redfern's row holds BOTH an INTERNAL ONLY column and a Client-Facing Notes
// column ("Make sure the client understands which finish materials are outside
// the quoted number."). If the model misfiles that client-facing sentence into
// the private field, the internal marker sitting a few columns away must not
// authorise hiding it.
// ---------------------------------------------------------------------------
const HEADER = CSV.split("\n")[0];

test("the authorised text of a row is the PRIVATE FIELD, not the whole row", () => {
  const priv = privateSourceOf(recordText("Redfern Renovation"), { headerRow: HEADER, delimiter: "," });
  assert.match(priv, /INTERNAL ONLY — Luis said/, "the private column is not authorised");
  assert.ok(!priv.includes("Make sure the client understands"),
    "the client-facing column was authorised by its neighbour");
  assert.ok(!priv.includes("Corte Madera"), "an ordinary column was authorised");
});

test("A MISROUTED CLIENT-FACING FIELD IS REJECTED, from the same row", () => {
  const row = recordText("Redfern Renovation");
  const priv = privateSourceOf(row, { headerRow: HEADER, delimiter: "," });
  // The genuinely private one stands.
  assert.equal(noteSupportedBy(
    "INTERNAL ONLY — Luis said he can probably hold the November slot for one week without a deposit, but does not want that promised to the client yet.",
    priv), true, "the record's own internal note was refused");
  // Its neighbour does not.
  assert.equal(noteSupportedBy(
    "Make sure the client understands which finish materials are outside the quoted number.",
    priv), false,
    "a client-facing field was hidden because a DIFFERENT field in the same row was marked internal");
});

test("a column HEADING authorises its own column, and only that column", () => {
  // The value need not repeat the label: a field headed INTERNAL ONLY is
  // authorised by the heading alone.
  const row = 'Acme Co,Someplace,Held the slot for a week,Tell the client about the allowance';
  const head = 'Firm,City,INTERNAL ONLY,Client-Facing Notes';
  const priv = privateSourceOf(row, { headerRow: head, delimiter: "," });
  assert.equal(priv, "Held the slot for a week", `authorised: ${JSON.stringify(priv)}`);
  assert.equal(noteSupportedBy("Held the slot for a week", priv), true);
  assert.equal(noteSupportedBy("Tell the client about the allowance", priv), false,
    "the heading authorised a column it does not head");
});

test("a VALUE that merely opens with the marker is not treated as a heading", () => {
  // Otherwise `INTERNAL ONLY — Luis said…` sitting in row one would authorise
  // that column in every row beneath it — chunk scope wearing a new hat.
  const head = 'Firm,Notes,INTERNAL ONLY — Luis said he can hold the slot';
  //                        ^ a first data ROW, mistaken for a heading
  const row  = 'Acme Co,Tell the client about the allowance,Ordinary schedule detail';
  const priv = privateSourceOf(row, { headerRow: head, delimiter: "," });
  assert.ok(!priv.includes("Ordinary schedule detail"),
    "a data value was read as a column heading and authorised that column in every row");
  assert.ok(!priv.includes("Tell the client"), "a client-facing column was authorised");
  assert.equal(priv, "", `nothing in this row is declared private, but got: ${JSON.stringify(priv)}`);
});

test("fields are split with quote state, so a comma inside a value is not a boundary", () => {
  assert.deepEqual(splitFields('a,"b,c",d', ","), ["a", "b,c", "d"]);
  assert.deepEqual(splitFields('a,"say ""hi""",d', ","), ["a", 'say "hi"', "d"]);
});

test("an undelimited source still uses its privately-marked LINES", () => {
  // A directive's region deliberately runs across continuation lines until a
  // blank line or a new labelled field — the Library path's existing rule, so a
  // private note spanning two lines stays one note. The region therefore ends
  // where the source says it ends, not at the first newline.
  const prose = [
    "Oak House",
    "Capacity: 40",
    "Private note: the director is retiring",
    "and has not told the staff",
    "",
    "Tours daily",
  ].join("\n");
  const priv = privateSourceOf(prose, { headerRow: null, delimiter: null });
  assert.match(priv, /the director is retiring/);
  assert.match(priv, /has not told the staff/, "the note's own second line was dropped");
  assert.ok(!priv.includes("Tours daily"), "an ordinary line beyond the region was authorised");
  assert.ok(!priv.includes("Capacity"), "a line before the directive was authorised");
});

// ---------------------------------------------------------------------------
// THE PATTERN, WIDENED ONLY WHERE IT IS SAFE
// ---------------------------------------------------------------------------
test("standalone markers are recognised with a colon, a dash, or nothing at all", () => {
  for (const s of [
    "INTERNAL ONLY",
    "INTERNAL ONLY — Luis said he can hold the slot",
    "INTERNAL ONLY: Luis said he can hold the slot",
    "Internal only - keep this back",
    "Private note: the director is retiring",
    "Private Notes — the director is retiring",
    "internal use only",
    ',"INTERNAL ONLY — Naomi mentioned by phone",',
  ]) {
    assert.equal(sourceGrantsPrivacy(s), true, `not recognised: ${JSON.stringify(s)}`);
  }
});

test("BARE markers still require a colon, because they are ordinary words first", () => {
  for (const s of [
    "Internal staircase and internal wiring were replaced",
    "confidential to both parties by agreement",
    "The internal layout is open plan",
  ]) {
    assert.equal(sourceGrantsPrivacy(s), false, `over-matched: ${JSON.stringify(s)}`);
  }
  assert.equal(sourceGrantsPrivacy("Internal: Luis said…"), true, "a labelled bare marker still counts");
  assert.equal(sourceGrantsPrivacy("Confidential: do not forward"), true);
});

test("THE ROOM-TYPE LESSON HOLDS — a privacy adjective is not a declaration", () => {
  // 29 of 65 communities in an earlier corpus contained the word "private" as
  // a floor plan. None of them may authorise anything.
  for (const s of [
    "Memory Care Private Studio, private bath, semi-private accommodations",
    "Private Dining available nightly",
    "Offers private rooms and private suites",
    "private patio",
  ]) {
    assert.equal(sourceGrantsPrivacy(s), false, `a room type granted privacy: ${JSON.stringify(s)}`);
  }
});

test("a marker MID-SENTENCE declares nothing", () => {
  assert.equal(sourceGrantsPrivacy("we keep an internal only copy for our files"), false,
    "a marker inside prose was read as a field declaration");
  assert.equal(sourceGrantsPrivacy("the work is internal only"), false);
});

test("explicit instructions still count, wherever they sit", () => {
  for (const s of [
    "Do not share with the client",
    "not for the family",
    "For my reference: he is retiring",
  ]) assert.equal(sourceGrantsPrivacy(s), true, `not recognised: ${JSON.stringify(s)}`);
});

// ---------------------------------------------------------------------------
// THE FULL REPLAY
//
// The real run's chunks, with the model's notes put back exactly as it wrote
// them (enforcement had already emptied them in the stored result). This runs
// the whole contract, not just the marker test, and is the assertion that
// actually answers "would this import still ask me three questions?".
// ---------------------------------------------------------------------------
process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";
const { enforceChunkResult } = await import("./enforce-chunk.ts");
const REPLAY = JSON.parse(
  readFileSync(new URL("./__fixtures__/internal-only-chunks.json", import.meta.url), "utf8"),
) as { delimiterHint: string; chunks: Array<{ ordinal: number; sourceStart: number; segmentText: string; result: unknown }> };

function replay() {
  const notes = new Map<string, string>();
  const cards: Array<{ title: string | null; text: string }> = [];
  const unprovable: Array<{ title: string | null; text: string }> = [];
  for (const c of REPLAY.chunks) {
    const out = enforceChunkResult({
      segmentText: c.segmentText, chunkOrdinal: c.ordinal, sourceStart: c.sourceStart,
      sourceText: CSV, result: c.result, runId: "replay",
      destination: "packet", delimiterHint: REPLAY.delimiterHint,
    });
    const r = out.result as { items?: Record<string, unknown>[]; sections?: { items?: Record<string, unknown>[] }[] };
    const items = [...(r.items ?? []), ...((r.sections ?? []).flatMap((s) => s.items ?? []))];
    for (const it of items) notes.set(String(it.title ?? ""), String(it.notes ?? "").trim());
    for (const u of out.unresolved.filter((x) => x.kind === "privacy-rejected"))
      cards.push({ title: u.title, text: String(u.text) });
    for (const u of out.unresolved.filter((x) => x.kind === "unbound-private-note"))
      unprovable.push({ title: u.title, text: String(u.text) });
  }
  return { notes, cards, unprovable };
}

test("REPLAY: a PROVABLE internal note is still kept automatically", () => {
  const { notes } = replay();
  assert.match(notes.get("Finch & Frame Renovation") ?? "", /^INTERNAL ONLY — Naomi mentioned by phone/,
    "an explicitly internal note was still stripped");
});

// REDFERN CHANGED, AND THE CHANGE IS THE POINT.
//
// This assertion used to read like Finch's, and it passed for a reason nobody
// had checked: Redfern's proposal never bound to a source record, so
// enforcement SKIPPED it entirely and the model's choice of `notes` stood
// unexamined. The note happened to be genuinely internal, so the outcome looked
// right and proved nothing.
//
// Binding fails here for a real reason that is still true: the neighbouring
// Baylight proposal carries Redfern's email, phone and website, so two
// proposals claim the one record. Solving that would mean guessing identity
// from a shared contact, which is the move this contract refuses.
//
// So the note becomes a question instead of a silent decision — and a question
// that says the true thing, which is that FlowGuide could not place the note,
// NOT that the source failed to mark it. One click of "Keep as private note"
// restores exactly what used to happen by accident.
test("REPLAY: an UNPROVABLE internal note is surfaced instead of silently kept", () => {
  const { notes, unprovable, cards } = replay();
  assert.equal(notes.get("Redfern Renovation"), "",
    "an unbindable proposal kept a private note on the model's say-so");
  const held = unprovable.find((c) => c.title === "Redfern Renovation");
  assert.ok(held, "the note was dropped rather than surfaced");
  assert.match(held!.text, /^INTERNAL ONLY — Luis said he can probably hold/,
    "the note's text was not preserved for the decision");
  assert.ok(!cards.some((c) => c.title === "Redfern Renovation"),
    "Redfern was told its source marks nothing private, which is false of this file");
});

test("REPLAY: they no longer produce unresolved cards", () => {
  const { cards } = replay();
  const titles = cards.map((c) => c.title);
  assert.ok(!titles.includes("Redfern Renovation"), "Redfern still asks a question it answered itself");
  assert.ok(!titles.includes("Finch & Frame Renovation"), "Finch & Frame still asks a question it answered itself");
});

test("REPLAY: Coastline's CLIENT-FACING note is still surfaced, not hidden", () => {
  const { notes, cards } = replay();
  assert.equal(notes.get("Coastline Craft Construction"), "",
    "a client-facing note was left in the private field, where the client will never see it");
  const card = cards.find((c) => c.title === "Coastline Craft Construction");
  assert.ok(card, "the one genuine catch was lost — this is the regression the scope fix exists to prevent");
  assert.match(card!.text, /Same Maya Chen who appears at Marin Cabinet Studio/);
});

test("REPLAY: exactly ONE privacy question, where there were three", () => {
  const { cards, unprovable } = replay();
  assert.equal(cards.length, 1, `expected one card, got ${JSON.stringify(cards.map((c) => c.title))}`);
  assert.equal(cards[0].title, "Coastline Craft Construction");
  // The second question is a different question, and it is the only other one.
  assert.deepEqual(unprovable.map((c) => c.title), ["Redfern Renovation"]);
});

// ---------------------------------------------------------------------------
// THE RESOLUTION, WHICH MUST PERFORM THE DECISION
// ---------------------------------------------------------------------------
const bodyOf = (p: string) => readFileSync(p, "utf8")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

test("the panel offers a destination, not just a dismissal", () => {
  const ui = bodyOf("src/components/ImportProgress.tsx");
  assert.match(ui, /resolveUnit\(f\.id, "kept_private"\)/, "there is no way to keep it as a private note");
  assert.match(ui, />\s*\{resolving === f\.id \? "Saving\\u2026" : "Keep as private note"\}/,
    "the primary action is not the one that performs the decision");
  assert.match(ui, /resolveUnit\(f\.id, "ignored"\)/, "Leave it out is gone");
});

test("the manual path says plainly that FlowGuide moves nothing", () => {
  const ui = bodyOf("src/components/ImportProgress.tsx");
  assert.ok(!/I've handled this/.test(ui),
    "the vague wording survives — it means only 'I put it somewhere myself'");
  assert.match(ui, /I added it elsewhere/, "the manual path is not named explicitly");
  assert.match(ui, /FlowGuide does not move the text for you/,
    "nothing tells the professional that the second button changes nothing");
});

test("the guidance asks a question the buttons can answer", () => {
  const reg = bodyOf("src/lib/review-units.ts");
  assert.match(reg, /What should FlowGuide do with it\?/, "the card still instructs rather than asks");
  assert.ok(!/then mark it done/.test(reg), "the old acknowledge-me wording survives");
});

test("the route and the RPC agree on the three dispositions", () => {
  const route = bodyOf("src/app/api/ingest/[runId]/review/[unitId]/route.ts");
  for (const s of ["resolved", "ignored", "kept_private"])
    assert.ok(route.includes(`"${s}"`), `the route rejects ${s}`);
  const sql = readFileSync("supabase/migrations/0043_review_keep_as_private_note.sql", "utf8");
  assert.match(sql, /p_status not in \('resolved', 'ignored', 'kept_private'\)/,
    "the database does not accept the disposition the UI sends");
});

test("kept_private writes ONLY notes — nothing recipient-facing is reachable", () => {
  // SQL COMMENTS STRIPPED. The block's own comment lists the fields it must not
  // touch, so a scan that left it in would match its own rationale — the same
  // trap the Library guards already learned.
  const sql = readFileSync("supabase/migrations/0043_review_keep_as_private_note.sql", "utf8")
    .split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  const block = sql.slice(sql.indexOf("if p_status = 'kept_private' then"), sql.indexOf("select jsonb_agg("));

  // Exactly one write, and its SET clause reaches exactly one column. The
  // SELECTs above it mention title and section_id to LOCATE the item, which is
  // a read — the earlier version of this assertion confused the two.
  assert.equal((block.match(/\bupdate\s+public\./g) ?? []).length, 1,
    "the disposition performs more than one write");
  const set = block.slice(block.indexOf("update public.items"), block.indexOf("where id = v_item"));
  assert.match(set, /set notes = case/, "it writes something other than notes");
  for (const col of ["description", "highlight", "title", "address", "sort_order", "section_id"])
    assert.ok(!set.includes(col), `the private-note write can SET ${col}`);
  // ...and it targets the item by id, never by a predicate that could match more.
  assert.match(block, /where id = v_item;/);
});

test("and the recipient renderers still never read notes at all", () => {
  // Asserted in full by email-render and highlight-and-paragraphs; this is the
  // link between "we now write notes deliberately" and "notes stays private".
  const email = readFileSync("src/lib/email-render.test.mts", "utf8");
  assert.match(email, /SECRET-PRIVATE-NOTE-must-never-appear/,
    "the recipient-surface guard for notes has gone missing");
});

test("the migration keeps the SAME function identity, so the ACL survives", () => {
  const sql = readFileSync("supabase/migrations/0043_review_keep_as_private_note.sql", "utf8");
  assert.match(sql, /create or replace function public\.resolve_review_unit\(\s*\n?\s*p_owner uuid, p_run_id uuid, p_unit_id text, p_status text\s*\n?\s*\)/,
    "the signature changed — a NEW function would default EXECUTE to PUBLIC");
  assert.match(sql, /revoke all on function public\.resolve_review_unit\(uuid, uuid, text, text\) from anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.resolve_review_unit\(uuid, uuid, text, text\) to service_role;/);
});
