import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recordSpan } from "./notes-provenance.ts";
import { attributePhotos, photosIn } from "./photo-attribution.ts";
import { auditAttribution } from "./attribution-conflict.ts";
import { privateRegions } from "./notes-provenance.ts";
import { ambiguousRanges, withoutAmbiguous, doubtFor, provenanceWarningsFor, spanRangeOf } from "./ambiguous-provenance.ts";

const codeOf = (p: string) => readFileSync(p, "utf8");
const bodyOf = (p: string) => codeOf(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const P = (n: string) => `https://cdn.example.com/${n}.jpg`;

// Three communities in source order. A is findable. B and C exist structurally
// but the model abbreviated their parentheticals — the real Napa failure.
const A_DESC = "Alpha Gardens is a small assisted living home with a shaded courtyard and twelve private rooms.";
const B_DESC = "Beta Court offers memory care in a purpose-built single-storey building close to the coast.";
const SOURCE = `Alpha Gardens — Napa
Type: AL
 Community Phone: (707) 111-0000
${A_DESC}
Image 1: ${P("alpha1")}

Image 2: ${P("alpha2")}

Beta Court (formerly called Nazareth Rose Garden of Napa) — Napa
Type: AL
 Community Phone: (707) 222-0000
 Private note: the director retires in March.
${B_DESC}
Image 1: ${P("beta1")}

Gamma House (formerly called Nazareth Classic Care of Napa) — Napa
Type: MC
 Community Phone: (707) 333-0000
Image 1: ${P("gamma1")}`;

// What the model returned: A exactly, B and C with SHORTENED parentheticals.
const A_TITLE = "Alpha Gardens";
const B_TITLE = "Beta Court (formerly Nazareth Rose Garden)";
const C_TITLE = "Gamma House (formerly Nazareth Classic Care)";
const TITLES = [A_TITLE, B_TITLE, C_TITLE];

// Chunk 0 holds A; chunk 1 holds B and C. Offsets tile the source exactly.
const SPLIT = SOURCE.indexOf("Beta Court (formerly called");
const CHUNKS = [
  { ordinal: 0, start: 0, end: SPLIT },
  { ordinal: 1, start: SPLIT, end: SOURCE.length },
];
const PROPS = [
  { title: A_TITLE, ordinal: 0, description: A_DESC, photos: [P("alpha1"), P("alpha2")] },
  { title: B_TITLE, ordinal: 1, description: B_DESC, notes: "the director retires in March.", photos: [P("beta1")] },
  { title: C_TITLE, ordinal: 1, photos: [P("gamma1")] },
];

// ===========================================================================
// PART A ENABLED — the parenthetical fallback resolves B and C
// ===========================================================================
test("PART A: an abbreviated parenthetical resolves to its one source header", () => {
  for (const t of [B_TITLE, C_TITLE]) {
    const span = recordSpan(SOURCE, t, TITLES.filter((x) => x !== t));
    assert.notEqual(span, null, `${t} stayed unfindable`);
  }
  assert.equal(ambiguousRanges(PROPS, SOURCE, CHUNKS).length, 0, "nothing should be ambiguous once both resolve");
});

test("PART A: each record then owns exactly its own photos", () => {
  const ranges = ambiguousRanges(PROPS, SOURCE, CHUNKS);
  const got = PROPS.map((p) => attributePhotos(p, SOURCE, TITLES, ranges).photos);
  assert.deepEqual(got[0], [P("alpha1"), P("alpha2")], "A did not keep its own two");
  assert.deepEqual(got[1], [P("beta1")]);
  assert.deepEqual(got[2], [P("gamma1")]);
  assert.equal(got.flat().length, photosIn(SOURCE).length, "the pair count does not reconcile");
});

test("PART A: the boundary is conservative — a base title may not claim a LONGER name", () => {
  // "Acme" must not resolve to "Acme North": a different community.
  const src = `Acme North — Napa\nType: AL\nImage 1: ${P("north")}`;
  assert.equal(recordSpan(src, "Acme (formerly Something)", []), null,
    "a stripped base matched a longer, different community name");
  // ...but it still resolves when the header really is that name.
  const ok = `Acme — Napa\nType: AL\nImage 1: ${P("acme")}`;
  assert.notEqual(recordSpan(ok, "Acme (formerly Something)", []), null);
});

test("PART A: two candidate lines are a guess, so it stays unresolved", () => {
  const src = `Twin Oaks (formerly called A) — Napa\nType: AL\n\nTwin Oaks (formerly called B) — Sonoma\nType: AL`;
  assert.equal(recordSpan(src, "Twin Oaks (formerly X)", []), null,
    "an ambiguous stripped title was resolved anyway");
});

test("PART A: it is the LAST resort — exact and normalised routes still win", () => {
  const src = `Beta Court (formerly called Nazareth Rose Garden of Napa) — Napa\nType: AL\nImage 1: ${P("b")}`;
  // exact full title still resolves without the fallback ever running
  assert.notEqual(recordSpan(src, "Beta Court (formerly called Nazareth Rose Garden of Napa) — Napa", []), null);
  // curly-apostrophe case still handled by the normalised scan
  const curly = `St Michael’s Extended Care — San Rafael\nType: AL\nImage 1: ${P("m")}`;
  assert.notEqual(recordSpan(curly, "St Michael's Extended Care", []), null);
});

// ===========================================================================
// PART B — measured with PART A DELIBERATELY DISABLED
// ===========================================================================
// The fallback is defeated by giving B and C titles no normalisation can reach,
// so containment is tested on a genuinely unresolvable identity rather than on
// a repaired one.
const B_LOST = "Community Nine Hundred";
const C_LOST = "Community Nine Hundred One";
const LOST_TITLES = [A_TITLE, B_LOST, C_LOST];
const LOST_PROPS = [
  { title: A_TITLE, ordinal: 0, description: A_DESC, photos: [P("alpha1"), P("alpha2")] },
  { title: B_LOST, ordinal: 1, description: B_DESC, notes: "the director retires in March.", photos: [P("beta1")] },
  { title: C_LOST, ordinal: 1, photos: [P("gamma1")] },
];
const LOST_RANGES = ambiguousRanges(LOST_PROPS, SOURCE, CHUNKS);

test("PART B: an unresolvable identity marks the range it was read from", () => {
  assert.equal(LOST_RANGES.length, 1, JSON.stringify(LOST_RANGES));
  assert.equal(LOST_RANGES[0].start, SPLIT);
  assert.equal(LOST_RANGES[0].end, SOURCE.length);
});

test("PART B (1): the neighbour CANNOT claim the unresolved records' photos", () => {
  const before = attributePhotos(LOST_PROPS[0], SOURCE, LOST_TITLES);           // no containment
  assert.ok(before.photos.includes(P("beta1")) && before.photos.includes(P("gamma1")),
    "the fixture no longer reproduces the over-extended span");
  const after = attributePhotos(LOST_PROPS[0], SOURCE, LOST_TITLES, LOST_RANGES);
  assert.deepEqual(after.photos, [P("alpha1"), P("alpha2")], "A still claimed a neighbour's photos");
  assert.deepEqual(after.withheld.sort(), [P("beta1"), P("gamma1")].sort(),
    "the doubtful photos were dropped silently instead of being surfaced");
});

test("PART B (2): the unresolved records fail closed", () => {
  for (const p of [LOST_PROPS[1], LOST_PROPS[2]]) {
    const d = doubtFor(p, SOURCE, LOST_TITLES, LOST_RANGES);
    assert.equal(d.unresolved, true, `${String(p.title)} was treated as resolvable`);
    assert.match(provenanceWarningsFor(p, SOURCE, LOST_TITLES, LOST_RANGES)[0], /could not find this community/i);
  }
});

test("PART B (3): ambiguous source cannot support the neighbour's DESCRIPTION", () => {
  // B's description, emitted on A. Without containment A's span covers it.
  const moved = { title: A_TITLE, description: B_DESC };
  const naive = auditAttribution(moved, SOURCE, LOST_TITLES);
  assert.equal(naive.ok, true, "the fixture no longer shows the false support it must prevent");
  const guarded = auditAttribution(moved, withoutAmbiguous(SOURCE, LOST_RANGES), LOST_TITLES);
  assert.ok(!guarded.resolved || guarded.conflicts.length > 0 ||
            !withoutAmbiguous(SOURCE, LOST_RANGES).includes(B_DESC),
    "ambiguous text still reads as positive support for the neighbour");
});

test("PART B (3): ambiguous source cannot authorise the neighbour's PRIVATE NOTE", () => {
  const aSpan = recordSpan(SOURCE, A_TITLE, LOST_TITLES.filter((t) => t !== A_TITLE))!;
  assert.ok(privateRegions(aSpan).some((r) => /director retires/i.test(r)),
    "the fixture no longer shows the directive leaking into A's span");
  const guardedSpan = recordSpan(withoutAmbiguous(SOURCE, LOST_RANGES), A_TITLE,
    LOST_TITLES.filter((t) => t !== A_TITLE))!;
  assert.ok(!privateRegions(guardedSpan).some((r) => /director retires/i.test(r)),
    "a directive in ambiguous source still authorises the neighbour's note");
});

test("PART B (4): a record clear of the ambiguous range is untouched", () => {
  const far = `Delta Villa — Sonoma\nType: AL\nImage 1: ${P("delta1")}`;
  const src = `${far}\n\n${SOURCE}`;
  const titles = ["Delta Villa", ...LOST_TITLES];
  const chunks = [{ ordinal: 0, start: 0, end: far.length + 2 },
                  { ordinal: 1, start: far.length + 2, end: far.length + 2 + SPLIT },
                  { ordinal: 2, start: far.length + 2 + SPLIT, end: src.length }];
  const props = [{ title: "Delta Villa", ordinal: 0, photos: [P("delta1")] },
                 { title: A_TITLE, ordinal: 1, photos: [P("alpha1"), P("alpha2")] },
                 { title: B_LOST, ordinal: 2, photos: [] }, { title: C_LOST, ordinal: 2, photos: [] }];
  const ranges = ambiguousRanges(props, src, chunks);
  const d = doubtFor(props[0], src, titles, ranges);
  assert.equal(d.unresolved, false);
  assert.equal(d.overlapping, false, "an unrelated record was dragged into the doubt");
  assert.deepEqual(attributePhotos(props[0], src, titles, ranges).photos, [P("delta1")]);
  assert.deepEqual(provenanceWarningsFor(props[0], src, titles, ranges), []);
});

test("PART B: the OVERLAPPING neighbour is surfaced, not silently trusted", () => {
  const d = doubtFor(LOST_PROPS[0], SOURCE, LOST_TITLES, LOST_RANGES);
  assert.equal(d.overlapping, true, "A's span crosses the ambiguous range and was not flagged");
  assert.match(provenanceWarningsFor(LOST_PROPS[0], SOURCE, LOST_TITLES, LOST_RANGES)[0],
    /cannot tell where this record ends/i);
});

test("PART B: it MOVES and DELETES nothing", () => {
  const src = codeOf("src/lib/ambiguous-provenance.ts");
  for (const forbidden of [/\.photos\s*=/, /\.description\s*=/, /delete\s+\w+\./, /splice\(/]) {
    assert.doesNotMatch(src, forbidden, `containment mutates content: ${forbidden}`);
  }
});

test("SAVE BLOCKS on provenance doubt, re-derived from source", () => {
  const save = bodyOf("src/app/api/library/import/[runId]/save/route.ts");
  assert.match(save, /outcome: "ambiguous_provenance"/, "save does not block a doubtful record");
  assert.match(save, /ambiguousRanges\(allProposals as never, fullSource, chunkRanges\)/,
    "save does not re-derive the ambiguous ranges");
  assert.ok(!/provenanceWarnings\b/.test(save.replace(/provenanceWarningsFor/g, "")),
    "save reads the stored provenance warning — clearing it would bypass the gate");
});

test("MATERIALISATION surfaces it for review", () => {
  const r = bodyOf("src/app/api/library/import/[runId]/proposals/route.ts");
  assert.match(r, /provenanceWarnings: provWarn/, "the warning is not stored for review");
  assert.match(r, /withheldPhotos: withheld/, "withheld photos are not surfaced");
  assert.match(r, /attributePhotos\([^)]*ambiguous\)/, "materialisation attributes without containment");
});

test("SPAN RANGES are real offsets into the source", () => {
  const r = spanRangeOf(SOURCE, A_TITLE, TITLES)!;
  assert.equal(SOURCE.slice(r.start, r.end), recordSpan(SOURCE, A_TITLE, TITLES.filter((t) => t !== A_TITLE)));
});
