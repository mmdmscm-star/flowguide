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
import { privateSourceOf, noteSupportedBy, splitFields, headingGrantsPrivacy,
  headingDefersAudience, audienceSourceOf } from "./enforce.ts";
import { enforceChunkResult } from "./enforce-chunk.ts";
import { parseClaims } from "./claim-parser.ts";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

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
  // CHECKED ON ITEMS THAT BIND. Four of run 1's venues cannot be bound, and
  // their recipient-facing content is now withheld for review rather than
  // published — so the property "a legitimate quoted cell survives" is a claim
  // about the QUOTE PARSING, and has to be read on items that got that far.
  // Run 2 binds all twelve, so the same values are checked there in full.
  const keep: [string, string][] = [
    ["Atlas Hall", "Stage, 16-foot screen, house sound, freight elevator, waterfront lobby"],
    ["Atlas Courtyard", "Market lights, heaters, portable bar, adjacent loading access"],
  ];
  for (const [title, value] of keep) {
    const found = detailsOf(byTitle(title)).some((d) => String(d.value ?? "").trim() === value);
    assert.ok(found, `${title} lost a legitimate multi-value field: ${JSON.stringify(value)}`);
  }
  for (const [title, value] of [
    ["Larkspur Landing Conference Center",
     "Parking, Wi-Fi, standard projector, 4 breakout rooms, confidentiality screens available on request"],
    ["Glasshouse Studio", "Demonstration kitchen, movable walls, private roof deck, basic furniture"],
    ["Clementine Club", "Full restaurant buyout, bar, two dining rooms, printed menus"],
    ["Clementine Room at Parkline Hotel", "Built-in display, foyer, hotel Wi-Fi, guestrooms upstairs"],
  ] as [string, string][]) {
    const found = detailsOf(r2(title)).some((d) => String(d.value ?? "").trim() === value);
    assert.ok(found, `${title} lost a legitimate multi-value field in run 2: ${JSON.stringify(value)}`);
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
// B2. THE PARSER READS CELLS, SO THE GUARD STAYS A BACKSTOP
// ---------------------------------------------------------------------------

const labelled = (src: string, delimiter?: string) =>
  parseClaims(src, 0, delimiter ? { delimiter } : {}).claims
    .filter((c) => c.kind === "labelled" || c.kind === "url")
    .map((c) => `${c.label}=${c.value}`);

test("a quoted multiline cell is parsed inside its own cell", () => {
  // The record is ONE physical line until the quoted pricing cell breaks it.
  // Everything after that cell's second line is the rest of the columns.
  const row = 'Venue,Contact,Pricing,Availability,Amenities\n'
    + 'Alpha Room,Sam Reyes,"Full-day rental: $7,400\nEvening extension: $1,100",October 17 available,"Wi-Fi, mics, display"';
  const got = labelled(row, ",");
  assert.ok(got.includes("Full-day rental=$7,400"), `lost the first line: ${JSON.stringify(got)}`);
  assert.ok(got.includes("Evening extension=$1,100"), `lost the second line: ${JSON.stringify(got)}`);
  // NOTHING ran on into the next columns.
  for (const c of got)
    assert.ok(!/October 17|Wi-Fi|mics/.test(c), `a claim escaped its cell: ${JSON.stringify(c)}`);

  // CONTROL: without a declared delimiter the old behaviour is untouched, and
  // it is the behaviour that produced the run-on. If this ever stops running
  // on, the assertions above stop proving the delimiter is what fixed it.
  const bare = labelled(row);
  assert.ok(bare.some((c) => /October 17|Wi-Fi/.test(c)),
    "the undelimited path changed too — the test no longer isolates the fix");
});

test("a clock time is not a label separator", () => {
  const row = 'Venue,Pricing\nAlpha Room,"Evening extension after 6:00 PM: $1,100\nSecurity after 9:00 PM: $450"';
  const got = labelled(row, ",");
  assert.ok(got.includes("Evening extension after 6:00 PM=$1,100"), JSON.stringify(got));
  assert.ok(got.includes("Security after 9:00 PM=$450"), JSON.stringify(got));
  for (const c of got)
    assert.ok(!/=00 PM|=30 PM/.test(c), `split inside a clock time: ${JSON.stringify(c)}`);
  // An ordinary label:value is still split at its colon.
  assert.deepEqual(labelled('A,B\nx,"Day rental: $5,900"', ","), ["Day rental=$5,900"]);
});

test("a cell that trails off mid-clause does not absorb the next column", () => {
  // The continuation rule exists for a real shape: a value wrapping onto the
  // next LINE. Once cells are cut, the block after a trailing "for" can be the
  // next COLUMN instead, and joining them rebuilds the run-on by another route.
  const src = 'Firm,Pricing,Timeline\n'
    + 'Acme,"Care Costs: monthly fee based on level of care for","Assisted Living $3,700 per month"';
  const got = labelled(src, ",");
  assert.deepEqual(got, ["Care Costs=monthly fee based on level of care for"],
    `a cell absorbed its neighbour: ${JSON.stringify(got)}`);

  // CONTROL: within ONE cell the continuation still works, which is the
  // behaviour this guard must not break.
  const wrapped = 'Firm,Pricing\n'
    + 'Acme,"Care Costs: monthly fee based on level of care for\nAssisted Living $3,700 per month"';
  assert.deepEqual(labelled(wrapped, ","),
    ["Care Costs=monthly fee based on level of care for Assisted Living $3,700 per month"],
    "a genuine wrapped continuation stopped joining");
});

test("two adjacent columns are not read as a label and its value", () => {
  // `October 17 available` recurs across the file, so it passes the recurrence
  // test that the two-line label/value form relies on — and the amenities
  // column sits right beside it.
  const rows = 'Venue,Availability,Amenities\n'
    + 'Alpha Room,October 17 available,"Stage, screen, lobby"\n'
    + 'Beta Room,October 17 available,"Bar, patio, lighting"';
  for (const c of labelled(rows, ","))
    assert.ok(!/^October 17 available=/.test(c), `paired two columns: ${JSON.stringify(c)}`);
});

test("the guard is a backstop, not the parser: only real model spills remain", () => {
  const flagged = OUT.units.filter((u) => u.code === "cross_cell_detail").map((u) => String(u.title));
  // EXACTLY the four the model emitted...
  for (const [title] of OBSERVED_SPILLS)
    assert.ok(flagged.some((t) => t.startsWith(title)), `${title} is no longer flagged`);
  // ...and NONE of the six that were the parser's own doing. Asserting these by
  // name is what makes this a regression rather than a count that happens to
  // match: before the parser read cells, every one of them raised a question.
  for (const title of ["Harbor House Loft", "Harbor House Garden", "The Foundry Hall",
                       "The Foundry Annex", "Atlas Hall", "Atlas Courtyard"])
    assert.ok(!flagged.some((t) => t.startsWith(title)),
      `${title} still raises a cross-cell question the parser should have prevented`);
  assert.equal(flagged.length, 4, `expected 4 cross-cell questions, got ${JSON.stringify(flagged)}`);
});

test("the facts the parser now recovers are on the items, not only in excerpts", () => {
  const want: [string, string, string][] = [
    ["Assembly House", "Furniture reset fee", "$350"],
    ["The Foundry Hall", "Cleaning", "$800"],
    ["Harbor House Loft", "Security after 9:00 PM", "$450"],
    ["Redwood Assembly", "Full-day rental", "$7,400"],
    ["Assembly House", "Availability", "October 17 available until 9:30 PM"],
  ];
  for (const [title, label, value] of want) {
    const d = detailsOf(byTitle(title)).find((x) => String(x.label ?? "") === label);
    assert.ok(d, `${title} has no ${label} detail`);
    assert.equal(String(d!.value).trim(), value, `${title} / ${label}`);
  }
  // And no detail anywhere is a clock-time fragment.
  for (const it of OUT.items) for (const d of detailsOf(it))
    assert.ok(!/^\d\d PM\b/.test(String(d.value ?? "").trim()),
      `${it.title} shows a clock-time fragment: ${JSON.stringify(d)}`);
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
    // ITS OWN KIND NOW. `privacy_rejected` says the source marks nothing
    // private, which is true but beside the point: this column declares the
    // audience UNDECIDED, and saying so is what stops "leave it out" from
    // looking like the obvious answer to a question the professional parked.
    const units = unitsFor("audience_undecided", title);
    assert.equal(units.length, 1, `${title} produced no question about its planner note`);
    assert.ok(String(units[0].text).includes(phrase),
      `${title}'s planner note was not preserved verbatim`);
    assert.equal(unitsFor("privacy_rejected", title).length, 0,
      `${title} was reported as an unauthorised private note rather than an undecided one`);
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

test("every note the source marks private is authorised to stay private", () => {
  // THE TEST KEY'S FOUR PRIVATE CASES, checked at the layer where the fixture is
  // whole. Two of them cannot be shown end-to-end: the production run that
  // PRODUCED this fixture had already stripped Redwood's and Clementine Room's
  // notes into review cards, so the stored proposal no longer carries them.
  // What decides the outcome is whether the source authorises the field, and
  // that is exactly what is asserted here.
  const env = recordEnvelopes(CSV, DELIM)!;
  const headerRow = CSV.slice(env[0].start, env[0].end);
  const cases: [string, string][] = [
    ["Redwood Assembly", "Keep between the planning team"],
    ["The Foundry Hall", "For planner only"],
    ["Glasshouse Studio", "Do not share with the client yet"],
    ["Clementine Room at Parkline Hotel", "Private note for our team"],
  ];
  for (const [title, phrase] of cases) {
    const e = env.find((x) => x.name.startsWith(title))!;
    const row = CSV.slice(e.start, e.end);
    const note = splitFields(row, DELIM)[16].trim();
    assert.ok(note.includes(phrase), `${title}'s private column changed — this assertion is vacuous`);
    assert.equal(noteSupportedBy(note, privateSourceOf(row, { headerRow, delimiter: DELIM })), true,
      `${title}'s private note is no longer authorised to stay private`);
  }
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

// ---------------------------------------------------------------------------
// F. SOURCE AUDIENCE CONSTRAINS EVERY DESTINATION
//
// A SECOND PRODUCTION RUN of the SAME FILE, whose model output differs. It is
// the run that exposed the gap: the model copied the Clementine Room's private
// cell into a client-visible detail, and folded the Foundry Annex's "audience
// not yet decided" planner judgment into its description. Neither was governed,
// because the contract only ever inspected `notes`.
// ---------------------------------------------------------------------------

const RUN2 = createRequire(import.meta.url)("./__fixtures__/event-planner-chunks-run2.json") as {
  ordinal: number; source_start: number; segment_text: string; result: unknown;
}[];

/** Every destination `item-card.tsx` and `print-packet.tsx` put in front of a
 *  recipient. `notes` is deliberately absent: it renders only when the viewer is
 *  the professional. */
const recipientFacing = (it: Item) => JSON.stringify([
  it.description, it.highlight, it.address,
  ...detailsOf(it).map((d) => `${d.label}: ${d.value}`),
  ...(Array.isArray(it.links) ? it.links : []).map((l) => (l as { label?: string })?.label),
  ...(Array.isArray(it.contacts) ? it.contacts : []).map((c) => {
    const o = c as { name?: string; role?: string }; return `${o?.name ?? ""} ${o?.role ?? ""}`;
  }),
]);

function runChunks(chunks: typeof RUN2) {
  process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";
  const items: Item[] = [], units: { code: string; title?: string | null; text?: string }[] = [];
  for (const c of chunks) {
    const out = enforceChunkResult({
      segmentText: c.segment_text, chunkOrdinal: c.ordinal, sourceStart: c.source_start,
      sourceText: CSV, result: c.result, runId: "run2", destination: "packet", delimiterHint: DELIM,
    });
    items.push(...itemsOf(out.result));
    units.push(...out.reviewUnits);
  }
  return { items, units };
}
const R2 = runChunks(RUN2);
const r2 = (t: string) => {
  const it = R2.items.find((x) => String(x.title ?? "").startsWith(t));
  assert.ok(it, `run 2 has no item titled ${t}`);
  return it!;
};

test("private source content is in Private Notes and in no recipient-facing field", () => {
  const cases: [string, string][] = [
    ["Clementine Room at Parkline Hotel", "this hotel waived the meeting-room rental"],
    ["Redwood Assembly", "Keep between the planning team"],
    ["Glasshouse Studio", "Do not share with the client yet"],
    ["The Foundry Hall", "For planner only"],
  ];
  for (const [title, phrase] of cases) {
    const it = r2(title);
    assert.ok(String(it.notes ?? "").includes(phrase),
      `${title}: the private note is not in Private Notes`);
    assert.ok(!recipientFacing(it).includes(phrase),
      `${title}: private text is visible to the recipient — ${recipientFacing(it).slice(0, 200)}`);
  }
});

test("NOT VACUOUS: the model really did publish the Clementine Room's private note", () => {
  // Without this, the assertion above would pass on a run where nothing was
  // wrong. The model emitted a detail LABELLED with the private field's own
  // opening words, carrying its text, alongside the correct private note.
  const model = RUN2.flatMap((c) => itemsOf(c.result));
  const cr = model.find((x) => String(x.title ?? "").startsWith("Clementine Room"))!;
  const leak = detailsOf(cr).find((d) => String(d.value ?? "").includes("this hotel waived the meeting-room rental"));
  assert.ok(leak, "the run-2 fixture no longer contains the leak it exists to prove");
  assert.equal(String(leak!.label), "Private note for our team");
});

test("a held private duplicate is removed WITHOUT asking a question", () => {
  // Nobody needs to be asked whether explicitly private material should be
  // public. The copy in notes is the answer, so the visible one just goes.
  const asked = R2.units.filter((u) => String(u.title ?? "").startsWith("Clementine Room"));
  assert.deepEqual(asked, [], `a question was raised about a duplicate: ${JSON.stringify(asked)}`);
  assert.ok(String(r2("Clementine Room at Parkline Hotel").notes ?? "")
    .includes("this hotel waived the meeting-room rental"), "the private copy was not kept");
});

test("undecided-audience judgment leaves the description and becomes ONE question", () => {
  const fa = r2("The Foundry Annex");
  for (const phrase of ["85 people may feel tight", "I would probably discuss layout"])
    assert.ok(!recipientFacing(fa).includes(phrase),
      `the Foundry Annex still shows undecided planner text: ${phrase}`);
  assert.equal(String(fa.notes ?? "").trim(), "",
    "undecided material was filed as private instead of asked about");

  const units = R2.units.filter((u) => String(u.title ?? "").startsWith("The Foundry Annex"));
  assert.equal(units.length, 1, `expected one question, got ${units.length}`);
  assert.equal(units[0].code, "audience_undecided");
  // NO CONTENT LOSS: both sentences survive inside the one question.
  for (const phrase of ["85 people may feel tight", "I would probably discuss layout"])
    assert.ok(String(units[0].text).includes(phrase), `the question lost: ${phrase}`);

  // The client-facing sentences around them are untouched.
  const desc = String(fa.description ?? "");
  assert.ok(desc.includes("Smaller sister space next door to The Foundry Hall"),
    "a client-facing sentence was removed with the planner text");
  assert.ok(desc.includes("Separate venue from The Foundry Hall"),
    "the trailing client-facing sentence was lost");
});

test("undecided material surfaces from NOTES too, wherever the model puts it", () => {
  // Atlas Courtyard's soft hold went into `notes` in production and raised a
  // card. The stored proposal is POST-enforcement, so the text is no longer in
  // it — the note is restored here from the source's own planner column, which
  // is what the model had proposed.
  const env = recordEnvelopes(CSV, DELIM)!;
  const e = env.find((x) => x.name.startsWith("Atlas Courtyard"))!;
  const planner = splitFields(CSV.slice(e.start, e.end), DELIM)[17].trim();
  assert.ok(planner.includes("another group has a soft hold"), "the fixture's planner column changed");

  const restored = RUN2.map((c) => ({
    ...c,
    result: c.result && (c.result as { sections?: unknown[] }).sections
      ? { ...(c.result as object), sections: ((c.result as { sections: { items?: Item[] }[] }).sections)
          .map((s) => ({ ...s, items: (s.items ?? []).map((it) =>
            String(it.title ?? "").startsWith("Atlas Courtyard") ? { ...it, notes: planner } : it) })) }
      : c.result,
  }));
  const out = runChunks(restored);
  const ac = out.items.find((x) => String(x.title ?? "").startsWith("Atlas Courtyard"))!;
  assert.equal(String(ac.notes ?? "").trim(), "",
    "an undecided note was filed as private rather than asked about");
  assert.ok(!recipientFacing(ac).includes("another group has a soft hold"));
  const unit = out.units.find((u) => String(u.title ?? "").startsWith("Atlas Courtyard"));
  assert.ok(unit, "the soft hold was dropped instead of surfaced");
  assert.equal(unit!.code, "audience_undecided");
  assert.ok(String(unit!.text).includes("another group has a soft hold"));
});

test("client-facing source proposed as private still fails closed, not silently", () => {
  // Clementine Club's note is CLIENT-FACING in the source and the model put it
  // in `notes`. Restored the same way, and for the same reason.
  const env = recordEnvelopes(CSV, DELIM)!;
  const e = env.find((x) => x.name.startsWith("Clementine Club"))!;
  const row = CSV.slice(e.start, e.end);
  const clientNote = splitFields(row, DELIM)[15].trim();
  assert.ok(clientNote.includes("The client may review it now"), "the fixture's client-facing note changed");

  // It is neither private nor undecided as far as the source is concerned.
  const aud = audienceSourceOf(row, {
    headerRow: CSV.slice(env[0].start, env[0].end), delimiter: DELIM });
  assert.equal(noteSupportedBy(clientNote, aud.private), false, "client-facing text was authorised as private");
  assert.equal(noteSupportedBy(clientNote, aud.undecided), false, "client-facing text was treated as undecided");

  const restored = RUN2.map((c) => ({
    ...c,
    result: c.result && (c.result as { sections?: unknown[] }).sections
      ? { ...(c.result as object), sections: ((c.result as { sections: { items?: Item[] }[] }).sections)
          .map((s) => ({ ...s, items: (s.items ?? []).map((it) =>
            String(it.title ?? "").startsWith("Clementine Club") ? { ...it, notes: clientNote } : it) })) }
      : c.result,
  }));
  const out = runChunks(restored);
  const cc = out.items.find((x) => String(x.title ?? "").startsWith("Clementine Club"))!;
  assert.equal(String(cc.notes ?? "").trim(), "", "client-facing text was left hidden in a private field");
  const unit = out.units.find((u) => String(u.title ?? "").startsWith("Clementine Club"));
  assert.ok(unit, "the client-facing note was discarded");
  assert.equal(unit!.code, "privacy_rejected",
    "a client-facing note was reported as an undecided-audience question");
  assert.ok(String(unit!.text).includes("The client may review it now"));
});

test("an undecided heading is recognised, and settled headings are not", () => {
  for (const h of ["Planner Notes — Audience Not Yet Decided", "Notes — Audience TBD", "Sharing Undecided"])
    assert.equal(headingDefersAudience(h), true, JSON.stringify(h));
  for (const h of ["Client-Facing Notes", "Private / Internal Notes", "Included / Amenities",
                   "Related / Cross-Reference", "Pricing", "Availability / Date"])
    assert.equal(headingDefersAudience(h), false, JSON.stringify(h));
  // The two states are exclusive on this file: the private column is not
  // undecided, and the undecided column grants no privacy.
  assert.equal(headingGrantsPrivacy("Planner Notes — Audience Not Yet Decided"), false);
  assert.equal(headingDefersAudience("Private / Internal Notes"), false);
});

test("run 2 introduces no cross-cell regression and loses nothing", () => {
  const cells = sourceCells(CSV, DELIM);
  for (const it of R2.items) {
    for (const d of detailsOf(it))
      assert.equal(spansCells(cells, String(d.value ?? "")), false,
        `${it.title} [${d.label}] spans source cells`);
    for (const f of ["description", "highlight"] as const)
      assert.equal(spansCells(cells, String(it[f] ?? "")), false, `${it.title} ${f} spans source cells`);
  }
  // The ordinary phrases the file exists to protect are all still visible.
  for (const [title, phrase] of [["Redwood Assembly", "internal courtyard"],
                                 ["Assembly House", "private office"],
                                 ["Glasshouse Studio", "private roof deck"],
                                 ["Larkspur Landing Conference Center", "confidentiality screens"]] as [string, string][])
    assert.ok(recipientFacing(r2(title)).toLowerCase().includes(phrase),
      `${title} lost a client-facing phrase: ${phrase}`);
});

test("private content with NO private copy is surfaced, never silently dropped", () => {
  // The remainder case. On this file every private leak had a correct copy in
  // notes, so removal was deterministic and silent. Strip that copy away and the
  // same removal would LOSE the content — which is the one outcome worse than
  // asking, so it becomes a question instead.
  const stripped = RUN2.map((c) => ({
    ...c,
    result: c.result && (c.result as { sections?: unknown[] }).sections
      ? { ...(c.result as object), sections: ((c.result as { sections: { items?: Item[] }[] }).sections)
          .map((s) => ({ ...s, items: (s.items ?? []).map((it) =>
            String(it.title ?? "").startsWith("Clementine Room") ? { ...it, notes: "" } : it) })) }
      : c.result,
  }));
  const out = runChunks(stripped);
  const cr = out.items.find((x) => String(x.title ?? "").startsWith("Clementine Room"))!;
  const phrase = "this hotel waived the meeting-room rental";
  assert.ok(!recipientFacing(cr).includes(phrase), "private text stayed visible");
  const unit = out.units.find((u) => String(u.title ?? "").startsWith("Clementine Room"));
  assert.ok(unit, "the only copy of the private note was deleted");
  assert.equal(unit!.code, "private_shown");
  assert.ok(String(unit!.text).includes(phrase), "the question did not preserve the text");

  // CONTRAST: with the private copy present, the same removal asks nothing.
  assert.deepEqual(R2.units.filter((u) => String(u.title ?? "").startsWith("Clementine Room")), [],
    "the held-duplicate case started asking questions");
});

// ---------------------------------------------------------------------------
// G. AN UNBOUND PROPOSAL CANNOT PUBLISH EITHER
//
// Failing to establish provenance already refused to authorise a private note.
// It refused nothing on the way out, so the model's prose ABOUT an unidentified
// record still reached the client unverified — and on both real imports an
// unbound proposal repeatedly carried a NEIGHBOURING record's email, phone and
// website, which is the shape the contamination actually takes.
// ---------------------------------------------------------------------------

import { INTERNAL_ONLY_CSV } from "./__fixtures__/internal-only-import.ts";
const CONTRACTOR = JSON.parse(
  readFileSync(new URL("./__fixtures__/internal-only-chunks.json", import.meta.url), "utf8"),
) as { delimiterHint: string; chunks: { ordinal: number; sourceStart: number; segmentText: string; result: unknown }[] };

function runContractor() {
  process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";
  const items: Item[] = [], units: { code: string; title?: string | null; text?: string }[] = [];
  for (const c of CONTRACTOR.chunks) {
    const out = enforceChunkResult({
      segmentText: c.segmentText, chunkOrdinal: c.ordinal, sourceStart: c.sourceStart,
      sourceText: INTERNAL_ONLY_CSV, result: c.result, runId: "contractor",
      destination: "packet", delimiterHint: CONTRACTOR.delimiterHint,
    });
    items.push(...itemsOf(out.result));
    units.push(...out.reviewUnits);
  }
  return { items, units };
}

test("an unbound proposal publishes no prose, and nothing it proposed is lost", () => {
  // Run 1's four unbindable venues. Each carried a description, an address, six
  // or seven details, a link label and contact names.
  for (const title of ["Larkspur Landing Conference Center", "Glasshouse Studio",
                       "Clementine Club", "Clementine Room at Parkline Hotel"]) {
    const it = byTitle(title);
    assert.equal(String(it.description ?? "").trim(), "", `${title} published a description unverified`);
    assert.equal(String(it.highlight ?? "").trim(), "", `${title} published a highlight unverified`);
    assert.equal(String(it.address ?? "").trim(), "", `${title} published an address unverified`);
    assert.deepEqual(detailsOf(it), [], `${title} published details unverified`);
    for (const l of (Array.isArray(it.links) ? it.links : []) as { label?: string }[])
      assert.equal(String(l?.label ?? ""), "", `${title} published a link label unverified`);
    for (const c of (Array.isArray(it.contacts) ? it.contacts : []) as Record<string, unknown>[])
      assert.equal(c.name ?? null, null, `${title} published a contact name unverified`);

    // RECOVERABLE, not deleted — one card holding the whole item.
    const held = unitsFor("unbound_recipient_content", title);
    assert.equal(held.length, 1, `${title}: expected exactly one card, got ${held.length}`);
    assert.ok(String(held[0].text).length > 100, `${title}: the card is empty`);
  }

  // The identity values are DELIBERATELY still there: a phone number is not
  // prose, and dropping it would lose the fact while proving nothing.
  const cc = byTitle("Clementine Club");
  assert.ok((cc.contacts as { email?: string }[]).some((c) => String(c?.email ?? "").includes("@")),
    "an email was discarded along with the prose");
});

test("the withheld text is recoverable verbatim", () => {
  const held = unitsFor("unbound_recipient_content", "Larkspur Landing Conference Center")[0];
  assert.ok(held, "nothing was held");
  const text = String(held.text);
  for (const phrase of ["Parking, Wi-Fi, standard projector, 4 breakout rooms",
                        "confidentiality screens available on request"])
    assert.ok(text.includes(phrase), `the held card lost: ${phrase}`);
  // Its address and contact are in there too, so the item can be rebuilt.
  assert.ok(/Address:/.test(text), "the address was dropped rather than held");
  assert.ok(/Contact:/.test(text), "the contact name was dropped rather than held");
});

test("a BOUND ordinary record is completely unaffected", () => {
  // Run 2 binds all twelve, so nothing is withheld anywhere in it.
  assert.equal(R2.units.filter((u) => u.code === "unbound_recipient_content").length, 0,
    "a bound run had content withheld");
  for (const it of R2.items) {
    assert.ok(String(it.description ?? "").trim().length > 0, `${it.title} lost its description`);
    assert.ok(detailsOf(it).length > 0, `${it.title} lost its details`);
  }
  // And in run 1, the eight venues that DO bind keep everything.
  for (const title of ["Harbor House Loft", "Harbor House Garden", "The Foundry Hall",
                       "The Foundry Annex", "Redwood Assembly", "Assembly House",
                       "Atlas Hall", "Atlas Courtyard"]) {
    const it = byTitle(title);
    assert.ok(String(it.description ?? "").trim().length > 0, `${title} lost its description`);
    assert.ok(detailsOf(it).length > 0, `${title} lost its details`);
    assert.equal(unitsFor("unbound_recipient_content", title).length, 0,
      `${title} bound, yet its content was withheld`);
  }
});

test("NO FUZZY IDENTITY: an exact title match does not rescue an unbindable proposal", () => {
  // The records DO have unique anchors here — each has its own website — so a
  // binder that consulted titles would have something to bind WITH. The
  // proposals carry no identity value at all: no link, no contact, no email,
  // no phone. All they share with the source is the venue name, character for
  // character, and prose quoted from the record's own cell.
  //
  // That is the whole test. If the title, the neighbouring row, the shared
  // contact or the wording were ever consulted, these two would bind and
  // publish. They must not.
  const source = [
    "Venue,Contact,Phone,Email,Website,Notes",
    "Alpha Room,Sam Reyes,(415) 555-0101,sam@shared.example,https://alpharoom.example,Bright corner room",
    "Beta Room,Sam Reyes,(415) 555-0101,sam@shared.example,https://betaroom.example,Quiet garden room",
  ].join("\n");
  const result = { sections: [{ items: [
    { title: "Alpha Room", description: "Bright corner room",
      details: [{ label: "Notes", value: "Bright corner room" }] },
    { title: "Beta Room", description: "Quiet garden room",
      details: [{ label: "Notes", value: "Quiet garden room" }] },
  ] }] };
  process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";
  const out = enforceChunkResult({
    segmentText: source, chunkOrdinal: 1, sourceStart: 0, sourceText: source,
    result, runId: "no-guess", destination: "packet", delimiterHint: ",",
  });
  for (const it of itemsOf(out.result))
    assert.equal(String(it.description ?? "").trim(), "",
      `${it.title} was bound by its title or its prose — identity was inferred`);
  assert.equal(out.reviewUnits.filter((u) => u.code === "unbound_recipient_content").length, 2,
    "the unbindable proposals were not surfaced");

  // CONTROL: give ONE proposal the record's own website and it binds and
  // publishes normally. Without this, the assertions above would also pass if
  // binding were simply broken for everything.
  const withSite = { sections: [{ items: [
    { ...result.sections[0].items[0], links: [{ url: "https://alpharoom.example/" }] },
    result.sections[0].items[1],
  ] }] };
  const out2 = enforceChunkResult({
    segmentText: source, chunkOrdinal: 1, sourceStart: 0, sourceText: source,
    result: withSite, runId: "no-guess-2", destination: "packet", delimiterHint: ",",
  });
  const alpha = itemsOf(out2.result).find((x) => x.title === "Alpha Room")!;
  const beta = itemsOf(out2.result).find((x) => x.title === "Beta Room")!;
  assert.equal(String(alpha.description ?? "").trim(), "Bright corner room",
    "a proposal carrying its record's own website failed to bind");
  assert.equal(String(beta.description ?? "").trim(), "",
    "the proposal with no anchor bound anyway");
});

test("the event-planner still asks exactly THREE questions when everything binds", () => {
  // Run 2's own model output, with the two notes production had already
  // stripped put back from the source. This is the packet the professional
  // would actually see.
  const env = recordEnvelopes(CSV, DELIM)!;
  const col = (t: string, i: number) => {
    const e = env.find((x) => x.name.startsWith(t))!;
    return splitFields(CSV.slice(e.start, e.end), DELIM)[i].trim();
  };
  const restore: Record<string, string> = {
    "Atlas Courtyard": col("Atlas Courtyard", 17),
    "Clementine Club": col("Clementine Club", 15),
  };
  const fixed = RUN2.map((c) => ({
    ...c,
    result: c.result && (c.result as { sections?: unknown[] }).sections
      ? { ...(c.result as object), sections: ((c.result as { sections: { items?: Item[] }[] }).sections)
          .map((s) => ({ ...s, items: (s.items ?? []).map((it) => {
            const k = Object.keys(restore).find((x) => String(it.title ?? "").startsWith(x));
            return k ? { ...it, notes: restore[k] } : it;
          }) })) }
      : c.result,
  }));
  const out = runChunks(fixed);
  const codes = out.units.map((u) => u.code).sort();
  assert.deepEqual(codes, ["audience_undecided", "audience_undecided", "privacy_rejected"],
    `expected three questions, got ${JSON.stringify(out.units.map((u) => `${u.code}:${u.title}`))}`);
  assert.equal(out.units.filter((u) => u.code === "unbound_recipient_content").length, 0,
    "the fail-closed rule fired on a run where everything binds");
});

test("contractor Redfern stays conservative, and stays recoverable", () => {
  const out = runContractor();
  const red = out.items.find((x) => String(x.title ?? "").startsWith("Redfern Renovation"))!;
  // Its private note still fails closed exactly as before.
  assert.equal(String(red.notes ?? "").trim(), "");
  const note = out.units.find((u) => u.code === "unbound_private_note"
    && String(u.title ?? "").startsWith("Redfern"));
  assert.ok(note, "Redfern's internal note stopped failing closed");
  assert.match(String(note!.text), /^INTERNAL ONLY — Luis said he can probably hold/);
  // And now its recipient-facing side is held too, in its own single card.
  assert.equal(String(red.description ?? "").trim(), "", "Redfern published prose it could not vouch for");
  const held = out.units.filter((u) => u.code === "unbound_recipient_content"
    && String(u.title ?? "").startsWith("Redfern"));
  assert.equal(held.length, 1);
  // Everything it proposed is in the one card: prose, address, priced details
  // and the contact's name — enough to rebuild the item by hand.
  const text = String(held[0].text);
  for (const phrase of ["Construction-focused firm", "Address: 44 Casa Buena Dr",
                        "$39,500", "1-year workmanship warranty", "Contact: Luis Ortega, Owner"])
    assert.ok(text.includes(phrase), `the held card lost: ${phrase}`);
  // Records that DO bind are untouched.
  const alder = out.items.find((x) => String(x.title ?? "").startsWith("Alder & Stone"))!;
  assert.ok(String(alder.description ?? "").trim().length > 0, "a bound contractor lost its description");
});

test("PROVENANCE THAT FAILED vs PROVENANCE THAT WAS NEVER ON OFFER", () => {
  // The boundary this rule stands on. A pasted shortlist tiles into NO records,
  // so every item is "unbound" for want of anything to bind to — and on the
  // corpus that is most ordinary sources, not a few. Withholding there would
  // empty the packet for all of them while answering a question nobody could
  // ask. That case has its own answer already: the whole-source fallback, which
  // never blocks and never places.
  const prose = `SHORTLIST

Riverbend Studio
$1,800/day. 3,000 sq ft, blackout capable, in-house grip.
riverbend.example.com | Booking: Nia Patel 646-555-0188
`;
  assert.equal(recordEnvelopes(prose), null, "this fixture gained record structure");
  process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";
  const out = enforceChunkResult({
    segmentText: prose, chunkOrdinal: 0, sourceStart: 0, sourceText: prose,
    result: { items: [{ title: "Riverbend Studio",
      description: "3,000 sq ft, blackout capable, in-house grip.",
      details: [{ label: "Day rate", value: "$1,800/day" }] }] },
    destination: "packet",
  });
  const it = itemsOf(out.result)[0];
  assert.equal(String(it.description ?? ""), "3,000 sq ft, blackout capable, in-house grip.",
    "a source with no records had its prose withheld");
  assert.equal(detailsOf(it).length, 1, "a source with no records had its details withheld");
  assert.equal(out.reviewUnits.filter((u) => u.code === "unbound_recipient_content").length, 0);

  // CONTRAST: the SAME shape of failure, on a source that does tile into
  // records, is withheld. The difference is whether binding was ever possible.
  const table = [
    "Venue,Contact,Phone,Email,Website,Notes",
    "Alpha Room,Sam Reyes,(415) 555-0101,sam@shared.example,https://alpharoom.example,Bright corner room",
    "Beta Room,Sam Reyes,(415) 555-0101,sam@shared.example,https://betaroom.example,Quiet garden room",
  ].join("\n");
  assert.ok(recordEnvelopes(table, ",")!.length > 1, "the control fixture lost its record structure");
  const out2 = enforceChunkResult({
    segmentText: table, chunkOrdinal: 1, sourceStart: 0, sourceText: table,
    result: { sections: [{ items: [{ title: "Alpha Room", description: "Bright corner room" }] }] },
    destination: "packet", delimiterHint: ",",
  });
  assert.equal(String(itemsOf(out2.result)[0].description ?? "").trim(), "",
    "an unbindable proposal published prose on a source that HAS records");
  assert.equal(out2.reviewUnits.filter((u) => u.code === "unbound_recipient_content").length, 1);
});

// ---------------------------------------------------------------------------
// H. THE REVIEW INTERACTION FOR HELD RECIPIENT CONTENT
//
// The three dispositions were designed for a question about a PRIVATE NOTE, and
// the panel rendered all three for every kind. A card holding a venue's
// description, address, priced details and a contact's name is not that
// question: "Keep as private note" there proposes hiding the whole item from
// the person it was written for, on the button that reads like the safe one.
// ---------------------------------------------------------------------------

import { dispositionsFor, guidanceFor, REVIEW_REQUIRED } from "./review-units.ts";

const panelSource = readFileSync(
  new URL("../components/ImportProgress.tsx", import.meta.url), "utf8");
const routeSource = readFileSync(
  new URL("../app/api/ingest/[runId]/review/[unitId]/route.ts", import.meta.url), "utf8");
const unit = (kind: string) => ({ id: "u1", code: REVIEW_REQUIRED[kind].code, kind });

test("the held-content card offers NO private-note action", () => {
  const d = dispositionsFor(unit("unbound-recipient-content"));
  assert.deepEqual(d, ["resolved", "ignored"]);
  assert.ok(!d.includes("kept_private"),
    "a bundle of client-facing material offers to be filed as a private note");
});

test("private-note kinds keep all three, so this narrowed one thing and not the panel", () => {
  for (const kind of ["privacy-rejected", "unbound-private-note", "audience-undecided", "private-shown"])
    assert.ok(dispositionsFor(unit(kind)).includes("kept_private"),
      `${kind} lost the disposition that actually preserves its content`);
});

test("the card's wording is truthful and non-private", () => {
  const g = guidanceFor(unit("unbound-recipient-content"));
  assert.match(g, /could(n't| not) reliably tell which source record/i);
  assert.match(g, /left it out rather than risk showing it under the wrong item/i);
  assert.ok(!/private/i.test(g), `the wording calls it private: ${JSON.stringify(g)}`);
  // It says the material is still here, because the professional is about to
  // decide whether to go and copy it.
  assert.match(g, /kept here until you decide/i);
});

test("the panel renders actions from the registry, not a hardcoded three", () => {
  assert.ok(/dispositionsFor\(f\)\.includes\("kept_private"\) && \(/.test(panelSource),
    "the private-note button is still unconditional");
  // And the footnote no longer promises a private note on a card that has none.
  assert.ok(/either button clears FlowGuide/.test(panelSource),
    "the non-private card does not warn that both buttons clear the held copy");
});

test("the server refuses kept_private for a kind that does not offer it", () => {
  // The panel is not the guarantee: a tab opened before this shipped still
  // shows the button.
  assert.ok(/if \(status === "kept_private"\)/.test(routeSource),
    "the route accepts any disposition for any kind");
  assert.ok(/dispositionsFor\(unit\)\.includes\("kept_private"\)/.test(routeSource),
    "the route does not consult the registry");
  assert.ok(/\.eq\("user_id", session\.userId\)/.test(routeSource),
    "the route's lookup is not owner-scoped");
});

test("ACKNOWLEDGEMENT WRITES NOTHING, and discard is the only other option", () => {
  // `resolved` and `ignored` both leave every item untouched — the RPC writes
  // only under `kept_private`, and only to `notes`. That is what makes "I added
  // it where it belongs" an acknowledgement rather than a move.
  const rpc = readFileSync(
    new URL("../../supabase/migrations/0043_review_keep_as_private_note.sql", import.meta.url), "utf8");
  const writeBlock = rpc.slice(rpc.indexOf("if p_status = 'kept_private' then"),
                               rpc.indexOf("select jsonb_agg("));
  assert.ok(/update public\.items/.test(writeBlock), "the fixture no longer contains the write");
  assert.equal((rpc.match(/update public\.items/g) ?? []).length, 1,
    "something outside the kept_private branch now writes to items");
  assert.ok(/set notes = case/.test(writeBlock), "the write reaches a field other than notes");
  // Both settling paths strip the excerpt — which is why the card has to say so.
  assert.ok(/then \(f - 'text'\)/.test(rpc), "the excerpt is no longer cleared on settle");
});

test("held content survives until a disposition succeeds", () => {
  // Nothing clears the excerpt outside the resolve transaction, so an item's
  // held bundle stays readable while the card is open.
  const held = unitsFor("unbound_recipient_content", "Larkspur Landing Conference Center")[0];
  assert.ok(held && String(held.text).length > 100, "the held bundle is not readable");
  assert.equal((held as { status?: string }).status ?? "unresolved", "unresolved");
});

// ---------------------------------------------------------------------------
// I. THE SAME PRINCIPLE, APPLIED TO THE OTHER MIXED BUNDLE
// ---------------------------------------------------------------------------

test("cross_cell_detail offers no private-note action either", () => {
  const d = dispositionsFor(unit("cross-cell-detail"));
  assert.deepEqual(d, ["resolved", "ignored"]);
  assert.ok(!d.includes("kept_private"),
    "a spilled detail offers to hide a client-facing price as a private note");
});

test("cross_cell_detail keeps the two actions that ARE honest for it", () => {
  const d = dispositionsFor(unit("cross-cell-detail"));
  assert.ok(d.includes("resolved"), "the professional cannot say they placed the fact");
  assert.ok(d.includes("ignored"), "the professional cannot discard it deliberately");
  // And its excerpt still carries the real fact, which is what makes
  // "I added it where it belongs" a thing they can act on.
  const spill = unitsFor("cross_cell_detail", "Assembly House")[0];
  assert.ok(spill && String(spill.text).includes("$350"),
    "the held excerpt no longer contains the fact the professional needs");
});

test("A STALE CLIENT'S kept_private IS REJECTED, for every restricted kind", () => {
  // The decision itself, not a description of it.
  for (const kind of ["cross-cell-detail", "unbound-recipient-content"])
    assert.equal(dispositionsFor(unit(kind)).includes("kept_private"), false, kind);

  // And the route asks the registry rather than naming kinds, which is what
  // makes the line above true of cross_cell_detail without touching the route.
  assert.ok(/dispositionsFor\(unit\)\.includes\("kept_private"\)/.test(routeSource),
    "the route does not consult the registry");
  for (const code of ["cross_cell_detail", "unbound_recipient_content", "privacy_rejected"])
    assert.ok(!routeSource.includes(code),
      `the route hardcodes ${code}; a future restricted kind would slip past it`);
});

test("REGISTRY AUDIT: only private-note decisions keep the private-note action", () => {
  // Pinned as a list so adding a kind is a decision someone makes on purpose.
  const privateNoteDecisions = ["privacy-rejected", "unbound-private-note",
                                "audience-undecided", "private-shown"];
  const placementDecisions = ["cross-cell-detail", "unbound-recipient-content"];
  assert.deepEqual(
    Object.keys(REVIEW_REQUIRED).sort(),
    [...privateNoteDecisions, ...placementDecisions].sort(),
    "a review kind was added or removed without classifying it");
  for (const kind of privateNoteDecisions)
    assert.ok(dispositionsFor(unit(kind)).includes("kept_private"),
      `${kind} is a private-note decision and lost its private-note action`);
  for (const kind of placementDecisions)
    assert.ok(!dispositionsFor(unit(kind)).includes("kept_private"),
      `${kind} is a placement decision and offers to file itself privately`);
});
