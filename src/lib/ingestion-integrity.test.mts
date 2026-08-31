import { test } from "node:test";
import assert from "node:assert/strict";

// TWO INGESTION-INTEGRITY DEFECTS A NORMAL VENUE IMPORT EXPOSED.
//
// Both were silent. Neither failed anything, and the packet looked fine.
//
//   1. A URL at the end of a CSV field kept the delimiter, so a record's
//      website anchor read `harborhouseloft.example,` while the proposal's read
//      `harborhouseloft.example`. Invisible until a website is a record's LAST
//      anchor — which is what happens when two venues share a coordinator and
//      the shared email and phone are correctly discarded as non-unique. Six of
//      twelve venues could not be bound, and an unbound proposal was skipped by
//      enforcement entirely: three of them hid planner judgment as creator-only
//      notes on the model's say-so, and nobody was asked.
//
//   2. A quoted multi-line pricing field split on the colon inside "6:00" and
//      then ran past the field's closing quote, swallowing raw CSV. Four
//      recipient-facing details ended up carrying other columns — in three
//      cases including the source's own private-notes column, twice while a
//      review card was asking about that very sentence.
//
// These run as PURE MODULES on purpose. Seven component-mounting suites cannot
// load under Node 25 (no JSX in its type stripping), and integrity coverage
// must not be parked behind a broken harness.
import { EVENT_PLANNER_CSV as CSV, EVENT_PLANNER_DELIMITER as DELIM } from "./__fixtures__/event-planner-import.ts";
import { recordEnvelopes, bindByProvenance, sourceCells, spansCells } from "./attribution.ts";
import { privateSourceOf, noteSupportedBy, splitFields, headingGrantsPrivacy } from "./enforce.ts";
import { enforceChunkResult } from "./enforce-chunk.ts";
import { createRequire } from "node:module";

const CHUNKS = createRequire(import.meta.url)("./__fixtures__/event-planner-chunks.json") as {
  ordinal: number; source_start: number; segment_text: string; result: unknown;
}[];

type Item = Record<string, unknown>;
const itemsOf = (result: unknown): Item[] => {
  const r = (result ?? {}) as { items?: Item[]; sections?: { items?: Item[] }[] };
  return [...(r.items ?? []), ...(r.sections ?? []).flatMap((s) => s.items ?? [])];
};
const detailsOf = (it: Item) => (Array.isArray(it.details) ? it.details : []) as { label?: string; value?: string }[];

/** The whole chunk pipeline, run once and shared. Enforcement is flagged, so it
 *  is switched on here rather than assumed. */
function runAll() {
  process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";
  const items: Item[] = [];
  const units: { code: string; title?: string | null; text?: string }[] = [];
  const telemetry: Record<string, number>[] = [];
  for (const c of CHUNKS) {
    const out = enforceChunkResult({
      segmentText: c.segment_text, chunkOrdinal: c.ordinal, sourceStart: c.source_start,
      sourceText: CSV, result: c.result, runId: "fixture-run",
      destination: "packet", delimiterHint: DELIM,
    });
    items.push(...itemsOf(out.result));
    units.push(...out.reviewUnits);
    telemetry.push(out.telemetry as unknown as Record<string, number>);
  }
  return { items, units, telemetry };
}
const OUT = runAll();
const byTitle = (t: string) => {
  const it = OUT.items.find((x) => String(x.title ?? "").startsWith(t));
  assert.ok(it, `the fixture no longer contains an item titled ${t}`);
  return it!;
};
const unitsFor = (code: string, title: string) =>
  OUT.units.filter((u) => u.code === code && String(u.title ?? "").startsWith(title));

// ---------------------------------------------------------------------------
// A. ANCHOR TOKENIZATION
// ---------------------------------------------------------------------------

test("a website sitting against a CSV delimiter still identifies its record", () => {
  // Two records that share a contact person completely. The email and phone are
  // therefore non-unique and correctly discarded, so the ONLY thing that can
  // tell these two apart is the website — and in a CSV the website is followed
  // immediately by a comma.
  const source = [
    "Venue,Contact,Phone,Email,Website,Notes",
    "Alpha Room,Sam Reyes,(415) 555-0101,sam@shared.example,https://alpharoom.example,First",
    "Beta Room,Sam Reyes,(415) 555-0101,sam@shared.example,https://betaroom.example,Second",
  ].join("\n");
  const env = recordEnvelopes(source, ",")!;
  assert.equal(env.length, 3, "the source did not tile into a heading and two records");

  const proposals = [
    { title: "Alpha Room", links: [{ url: "https://alpharoom.example/" }] },
    { title: "Beta Room", links: [{ url: "https://betaroom.example/" }] },
  ];
  const bound = bindByProvenance(env, source, proposals).bound;
  assert.equal(bound.get(1), proposals[0], "Alpha Room did not bind to its own proposal");
  assert.equal(bound.get(2), proposals[1], "Beta Room did not bind to its own proposal");

  // CONTROL — the website really is what did the work. Take it away and the
  // shared contact identifies nobody, so neither record binds. Without this the
  // assertions above would also pass if binding had matched on something else.
  const noSite = source.replace(/,https:\/\/[a-z]+\.example/g, ",");
  const env2 = recordEnvelopes(noSite, ",")!;
  const bound2 = bindByProvenance(env2, noSite, proposals.map((p) => ({ title: p.title }))).bound;
  assert.equal(bound2.size, 0,
    "records bound with no distinguishing anchor — this test proves nothing about the website");
});

test("each shared-contact pair in the real import binds to its own record", () => {
  const env = recordEnvelopes(CSV, DELIM)!;
  const proposals = itemsOf(CHUNKS.find((c) => c.ordinal === 1)!.result)
    .concat(itemsOf(CHUNKS.find((c) => c.ordinal === 2)!.result));

  // Bind each chunk the way the pipeline does — against the whole source, with
  // only that chunk's proposals.
  const resolved = new Map<string, string>();
  for (const ord of [1, 2]) {
    const chunkItems = itemsOf(CHUNKS.find((c) => c.ordinal === ord)!.result);
    const bound = bindByProvenance(env, CSV, chunkItems).bound;
    for (const [rec, it] of bound) resolved.set(env[rec].name, String((it as Item).title ?? ""));
  }

  // THE THREE PAIRS. Lauren Pike is on both Harbor rows, Omar Reed on both
  // Foundry rows, Jae Kim on both Atlas rows — so each of these six can only be
  // told apart by its own website.
  for (const name of ["Harbor House Loft", "Harbor House Garden", "The Foundry Hall",
                      "The Foundry Annex", "Atlas Hall (formerly Pier 27 Gallery)", "Atlas Courtyard"]) {
    assert.equal(resolved.get(name), name,
      `${name} did not bind to its own proposal (got ${JSON.stringify(resolved.get(name))})`);
  }
  assert.ok(proposals.length >= 12, "the fixture lost proposals");
});

// ---------------------------------------------------------------------------
// B. CROSS-CELL VALUES ARE REJECTED FROM RECIPIENT-FACING OUTPUT
// ---------------------------------------------------------------------------

/** The four the model actually emitted, by identity. A count would pass while
 *  flagging four entirely different values. */
const OBSERVED_SPILLS: [string, string, string][] = [
  ["Redwood Assembly", "Evening extension after 6", "Assembly House"],
  ["Assembly House", "Furniture reset fee", "Assembly House is unrelated to Redwood Assembly."],
  ["Glasshouse Studio", "Roof deck staffing", "Clementine Club"],
  ["Clementine Room at Parkline Hotel", "Coffee service", "this hotel waived the meeting-room rental"],
];

test("the four observed spills are gone from recipient-facing details", () => {
  for (const [title, label, foreign] of OBSERVED_SPILLS) {
    const it = byTitle(title);
    const still = detailsOf(it).find((d) => String(d.value ?? "").includes(foreign));
    assert.equal(still, undefined,
      `${title} still shows a detail carrying ${JSON.stringify(foreign)}: ${JSON.stringify(still)}`);
    // And the spill's own label must not survive holding the spilled text.
    const byLabel = detailsOf(it).find((d) => String(d.label ?? "") === label);
    assert.ok(!byLabel || String(byLabel.value ?? "").length < 60,
      `${title} kept ${label} with a ${String(byLabel?.value ?? "").length}-character value`);
  }
});

test("each spill is surfaced whole, once, as its own question", () => {
  for (const [title, label, foreign] of OBSERVED_SPILLS) {
    const units = unitsFor("cross_cell_detail", title);
    const match = units.filter((u) => String(u.text ?? "").includes(foreign));
    assert.equal(match.length, 1,
      `${title} produced ${match.length} questions for one excerpt (expected exactly 1)`);
    const text = String(match[0].text);
    assert.ok(text.startsWith(`${label}:`),
      `the excerpt lost its label: ${JSON.stringify(text.slice(0, 60))}`);
    // NOT TRUNCATED AND NOT REPAIRED. The real fact and the foreign text both
    // survive, because deciding which part was meant belongs to the
    // professional. Assembly House's "$350" exists ONLY here.
    assert.ok(text.includes(foreign), "the foreign text was trimmed away rather than shown");
  }
  const a = unitsFor("cross_cell_detail", "Assembly House").find((u) => String(u.text).includes("Furniture reset fee"));
  assert.ok(String(a?.text).includes("$350"),
    "the only surviving copy of the $350 reset fee was thrown away rather than surfaced");
  const c = unitsFor("cross_cell_detail", "Clementine Room").find((u) => String(u.text).includes("Coffee service"));
  assert.ok(String(c?.text).includes("$28 per person"),
    "the only surviving copy of the $28 coffee service was thrown away rather than surfaced");
});

test("legitimate quoted and multiline cells are left alone", () => {
  // Values holding commas inside ONE quoted field. If the guard were splitting
  // on punctuation rather than reading quote state, every one of these would go.
  const keep: [string, string][] = [
    ["Larkspur Landing Conference Center",
     "Parking, Wi-Fi, standard projector, 4 breakout rooms, confidentiality screens available on request"],
    ["Glasshouse Studio", "Demonstration kitchen, movable walls, private roof deck, basic furniture"],
    ["Clementine Club", "Full restaurant buyout, bar, two dining rooms, printed menus"],
    ["Atlas Hall", "Stage, 16-foot screen, house sound, freight elevator, waterfront lobby"],
    ["Clementine Room at Parkline Hotel", "Built-in display, foyer, hotel Wi-Fi, guestrooms upstairs"],
  ];
  for (const [title, value] of keep) {
    const found = detailsOf(byTitle(title)).some((d) => String(d.value ?? "").trim() === value);
    assert.ok(found, `${title} lost a legitimate multi-value field: ${JSON.stringify(value)}`);
  }

  // A MULTILINE quoted field yields both of its lines as ordinary facts.
  const redwood = detailsOf(byTitle("Redwood Assembly")).map((d) => String(d.value ?? "").trim());
  assert.ok(redwood.includes("$7,400"), "the full-day rental was lost with the spill");
  assert.ok(redwood.includes("$1,100"), "the evening extension fee was lost with the spill");
  // And the value the spill overwrote is intact, because the bad CLAIM was
  // refused before it could replace a good detail.
  assert.ok(detailsOf(byTitle("The Foundry Hall")).some((d) => String(d.value ?? "").trim() === "$800"),
    "The Foundry Hall's cleaning fee was overwritten by the spilled claim");
});

test("spansCells speaks only from evidence", () => {
  const cells = sourceCells(CSV, DELIM);
  // Present in the source, inside one quoted cell -> not spanning.
  assert.equal(spansCells(cells,
    "Parking, Wi-Fi, standard projector, 4 breakout rooms, confidentiality screens available on request"), false);
  // Not in the source at all -> silent, because absence of a match is absence
  // of proof rather than proof of a defect.
  assert.equal(spansCells(cells, "a sentence that appears nowhere in this file at all"), false);
  // Crosses a delimiter -> spanning.
  assert.equal(spansCells(cells,
    "Restored historic house suited to smaller leadership gatherings. A private office off the library can be used as a speaker prep room or confidential one-on-one meeting space.,54 seated"),
    true, "a value running across a delimiter was not detected");
});

// ---------------------------------------------------------------------------
// C. UNBOUND PROPOSALS FAIL CLOSED
// ---------------------------------------------------------------------------

test("an unbindable proposal's private note is surfaced, not silently kept", () => {
  // Glasshouse Studio carries another venue's contact and website inside its
  // proposal, so provenance cannot be established for it. Its note may well be
  // private — the point is that nothing PROVED it, so it becomes a question
  // instead of creator-only content on the model's say-so.
  const it = byTitle("Glasshouse Studio");
  assert.equal(String(it.notes ?? "").trim(), "",
    "an unbound proposal kept a private note nothing proved");
  // ITS OWN KIND. Saying "nothing in your source marks it private" would be a
  // false statement here — the source's `Private / Internal Notes` column marks
  // it plainly. What is missing is proof that the note is THIS row's.
  const units = unitsFor("unbound_private_note", "Glasshouse Studio");
  assert.equal(units.length, 1, "the unbound note was dropped instead of surfaced");
  assert.ok(String(units[0].text).includes("Imani verbally offered to waive corkage"),
    "the note's text was not preserved for the decision");
  assert.equal(unitsFor("privacy_rejected", "Glasshouse Studio").length, 0,
    "an unprovable note was reported as one the source does not mark private");
  assert.ok(OUT.telemetry.some((t) => t.unboundSurfaced > 0),
    "nothing was recorded as surfaced for want of binding");
});

test("Foundry Annex and Atlas Courtyard no longer hide planner judgment", () => {
  // Both sit in `Planner Notes — Audience Not Yet Decided`. The source says the
  // audience is undecided, so hiding it answers a question nobody asked.
  for (const [title, phrase] of [
    ["The Foundry Annex", "85 people may feel tight"],
    ["Atlas Courtyard", "another group has a soft hold"],
  ] as [string, string][]) {
    assert.equal(String(byTitle(title).notes ?? "").trim(), "",
      `${title} still hides its planner note as creator-only content`);
    const units = unitsFor("privacy_rejected", title);
    assert.equal(units.length, 1, `${title} produced no question about its planner note`);
    assert.ok(String(units[0].text).includes(phrase),
      `${title}'s planner note was not preserved verbatim`);
  }

  // NOT VACUOUS: a note the source DOES authorise is still kept privately and
  // raises no question. Without this, "surface everything" would pass.
  const hall = byTitle("The Foundry Hall");
  assert.ok(String(hall.notes ?? "").includes("For planner only — Omar offered a 7% courtesy reduction"),
    "an authorised private note was surfaced instead of kept");
  assert.equal(unitsFor("privacy_rejected", "The Foundry Hall").length, 0,
    "an authorised private note was turned into a question");
});

// ---------------------------------------------------------------------------
// D. PRIVATE SOURCE TEXT CANNOT REACH A RECIPIENT-FACING FIELD
// ---------------------------------------------------------------------------

test("no recipient-facing detail carries text from an explicitly private field", () => {
  // The decisive one. Redwood, Glasshouse and Clementine Room all BOUND and
  // were governed, and their private-column text reached the client anyway —
  // through `details`, which the privacy rule never looked at. Twice, while a
  // card was asking the professional about that same sentence.
  const PRIVATE: [string, string][] = [
    ["Redwood Assembly", "Keep between the planning team"],
    ["Glasshouse Studio", "Do not share with the client yet"],
    ["Clementine Room at Parkline Hotel", "this hotel waived the meeting-room rental"],
  ];
  // NOT VACUOUS: each phrase really is in the source's private column.
  const env = recordEnvelopes(CSV, DELIM)!;
  const headerRow = CSV.slice(env[0].start, env[0].end);
  for (const [title, phrase] of PRIVATE) {
    const e = env.find((x) => x.name.startsWith(title))!;
    const fields = splitFields(CSV.slice(e.start, e.end), DELIM);
    assert.ok(String(fields[16] ?? "").includes(phrase),
      `${title}'s private column no longer contains ${JSON.stringify(phrase)} — this test is vacuous`);
  }
  assert.ok(headerRow.includes("Private / Internal Notes"), "the fixture's private column was renamed");

  for (const [, phrase] of PRIVATE) {
    for (const it of OUT.items) {
      for (const d of detailsOf(it)) {
        assert.ok(!String(d.value ?? "").includes(phrase),
          `${it.title} shows ${JSON.stringify(String(d.label ?? ""))} carrying private text: ${JSON.stringify(phrase)}`);
      }
      for (const field of ["description", "highlight", "address"]) {
        assert.ok(!String(it[field] ?? "").includes(phrase),
          `${it.title}'s ${field} carries private text: ${JSON.stringify(phrase)}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// E. HEADING-SCOPED PRIVACY VOCABULARY
// ---------------------------------------------------------------------------

test("an ordinary private-notes heading authorises its own field", () => {
  for (const h of ["Private / Internal Notes", "Internal — Notes", "Notes (Confidential)",
                   "INTERNAL ONLY", "Internal Use Only", "Private Notes", "Confidential"])
    assert.equal(headingGrantsPrivacy(h), true, `${JSON.stringify(h)} should authorise its column`);

  // ONLY that field. The record's other columns gain nothing from it.
  const env = recordEnvelopes(CSV, DELIM)!;
  const headerRow = CSV.slice(env[0].start, env[0].end);
  const e = env.find((x) => x.name.startsWith("Redwood Assembly"))!;
  const row = CSV.slice(e.start, e.end);
  const fields = splitFields(row, DELIM);
  const authorised = privateSourceOf(row, { headerRow, delimiter: DELIM });
  assert.ok(authorised.includes("Keep between the planning team"),
    "the private column was not authorised");
  assert.ok(!authorised.includes("internal courtyard"),
    "authority leaked from the private column into the client-facing description");
  assert.ok(String(fields[4] ?? "").includes("internal courtyard"),
    "the fixture's client-facing description changed — this assertion is vacuous");
});

test("an undecided-audience heading authorises nothing", () => {
  assert.equal(headingGrantsPrivacy("Planner Notes — Audience Not Yet Decided"), false);
  const env = recordEnvelopes(CSV, DELIM)!;
  const headerRow = CSV.slice(env[0].start, env[0].end);
  const e = env.find((x) => x.name.startsWith("The Foundry Annex"))!;
  const row = CSV.slice(e.start, e.end);
  const planner = splitFields(row, DELIM)[17].trim();
  assert.ok(planner.includes("85 people may feel tight"), "the fixture's planner column changed");
  const authorised = privateSourceOf(row, { headerRow, delimiter: DELIM });
  assert.equal(noteSupportedBy(planner, authorised), false,
    "an undecided planner note was granted privacy");
});

test("privacy words in client-facing prose stay client-facing", () => {
  // The trap the file was built to prove. Every one of these is a real phrase
  // from the CLIENT-FACING column, and every one would be caught by widening
  // `private` / `internal` / `confidential` as phrases rather than headings.
  for (const s of ["private office", "internal courtyard", "confidential one-on-one meeting space",
                   "confidentiality screens", "Private Dining Room", "Client-Facing Notes",
                   "Related / Cross-Reference", "Included / Amenities"])
    assert.equal(headingGrantsPrivacy(s), false, `${JSON.stringify(s)} must not authorise privacy`);

  // Clementine Club's menu is confidential to the PUBLIC and explicitly
  // reviewable by the client. Hiding it would take away information the source
  // says the client may see.
  const env = recordEnvelopes(CSV, DELIM)!;
  const headerRow = CSV.slice(env[0].start, env[0].end);
  const e = env.find((x) => x.name.startsWith("Clementine Club"))!;
  const row = CSV.slice(e.start, e.end);
  const clientFacing = splitFields(row, DELIM)[15].trim();
  assert.ok(clientFacing.includes("confidential until September 20")
    && clientFacing.includes("The client may review it now"),
    "the fixture's Clementine Club client-facing note changed — this assertion is vacuous");
  assert.equal(noteSupportedBy(clientFacing, privateSourceOf(row, { headerRow, delimiter: DELIM })), false,
    "text the source says the client may review was authorised as private");
  assert.equal(String(byTitle("Clementine Club").notes ?? "").trim(), "",
    "Clementine Club's client-facing note was stored as a private note");
});
