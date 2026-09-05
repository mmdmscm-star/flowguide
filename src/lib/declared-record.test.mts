// THE GUARD THAT NEVER RAN.
//
// Production, run 3882fdd0 — "Spring Lake Village", keep_together, six chunks,
// fifty-two details published to a packet:
//
//     itemsGoverned: 0   stripped: 0   unresolved: []   review_units: null
//
// on EVERY chunk. env was null under keep_together, so bindByProvenance was
// skipped, byRecord stayed empty and enforceItem was never reached. Four of the
// fifty-two details were not source text at all and nothing said so.
//
// The creator declaring "this source is ONE thing" is not the absence of
// provenance. It IS provenance, supplied by the person who owns the document.
// These tests hold that line, and they run on the real transcription of three
// photographed brochure pages together with the real proposals the model
// returned for it.
process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { enforceChunkResult } from "./enforce-chunk.ts";
import { buildChunkAccounting } from "./chunk-accounting.ts";
import { collapseToOneItem } from "./collapse-item.ts";
import { partitionAcrossItems, declaredEnvelopes, DECLARED_RECORD } from "./declared-record.ts";
import { parseClaims } from "./claim-parser.ts";
import { reconcile } from "./reconcile.ts";
import { enforceItem } from "./enforce.ts";

type Bag = Record<string, unknown>;
const F = JSON.parse(readFileSync(new URL("./__fixtures__/spring-lake-run.json", import.meta.url), "utf8"));
const KEEP = { intent: "keep_together", title: "Spring Lake Village" } as never;
const PRICES = ["$6,396", "$6,493", "$6,545", "$7,077", "$8,879", "$9,665", "$6,500", "$500", "$27", "$5"];

const itemsOf = (result: unknown): Bag[] =>
  ((result as { sections?: { items?: Bag[] }[] })?.sections ?? []).flatMap((s) => s.items ?? []);
const detailKeys = (items: Bag[]) =>
  items.flatMap((i) => ((i.details ?? []) as { label: string; value: string }[])
    .map((d) => `${d.label} => ${d.value}`));

/** Every chunk of the real run, through the real enforcement. */
function replay(grouping: unknown, override?: (c: Bag) => unknown) {
  let governed = 0, stripped = 0, orphaned = 0, records = 0;
  const unresolved: { kind: string; text: string }[] = [];
  const perChunk: { ordinal: number; governed: number; records: number; before: string[]; after: string[] }[] = [];
  const items: Bag[] = [];
  for (const c of F.chunks as Bag[]) {
    const result = override ? override(c) : c.result;
    const out = enforceChunkResult({
      segmentText: c.segmentText as string, chunkOrdinal: c.ordinal as number,
      sourceStart: c.sourceStart as number, sourceText: F.sourceText, result,
      runId: "replay", destination: "packet", delimiterHint: F.delimiterHint,
      grouping: grouping as never,
    });
    const acc = buildChunkAccounting({
      segmentText: c.segmentText as string, chunkOrdinal: c.ordinal as number,
      sourceStart: c.sourceStart as number, sourceText: F.sourceText, result: out.result,
      delimiterHint: F.delimiterHint, grouping: grouping as never,
    });
    governed += out.telemetry.itemsGoverned;
    stripped += out.telemetry.stripped;
    records += acc.records.length;
    orphaned += acc.records.reduce((n, r) => n + r.orphaned, 0);
    for (const u of out.unresolved) unresolved.push({ kind: u.kind, text: String(u.text) });
    perChunk.push({ ordinal: c.ordinal as number, governed: out.telemetry.itemsGoverned,
      records: acc.records.length, before: detailKeys(itemsOf(result)), after: detailKeys(itemsOf(out.result)) });
    items.push(...itemsOf(out.result));
  }
  return { governed, stripped, orphaned, records, unresolved, perChunk, items };
}

// ---------------------------------------------------------------------------
// 1. THE DEFECT ITSELF
// ---------------------------------------------------------------------------

test("KEEP TOGETHER NOW GOVERNS EVERY PROPOSAL — production measured zero", () => {
  const k = replay(KEEP);
  assert.ok(k.governed > 0, "itemsGoverned is still 0 — the declared record is not binding");
  assert.equal(k.governed, 27, "the number of governed proposals moved; re-measure before accepting");
  for (const c of k.perChunk)
    assert.ok(c.governed > 0, `chunk ${c.ordinal} proposed items and governed none`);
});

test("a chunk whose segment parses NO claims still governs its proposals", () => {
  // Two of the six chunks are prose: zero claims, zero ambiguous units. A loop
  // driven by byRecord skips them, and their items would reach the packet
  // unchecked. The declared record exists because the creator said so.
  const prose = (F.chunks as Bag[]).filter((c) =>
    parseClaims(c.segmentText as string, c.ordinal as number, { delimiter: null }).claims.length === 0);
  assert.ok(prose.length >= 2, "the fixture no longer contains a claim-free chunk");
  const k = replay(KEEP);
  for (const c of prose) {
    const row = k.perChunk.find((p) => p.ordinal === c.ordinal)!;
    if (itemsOf(c.result).length) assert.ok(row.governed > 0, `claim-free chunk ${c.ordinal} was skipped`);
  }
});

// ---------------------------------------------------------------------------
// 2. WHAT SURVIVES — nothing may be lost to make governance possible
// ---------------------------------------------------------------------------

test("EVERY PRICE SURVIVES, and the production path only ADDS details", () => {
  const k = replay(KEEP);
  const blob = JSON.stringify(collapseToOneItem(k.items, "Spring Lake Village"));
  for (const p of PRICES) assert.ok(blob.includes(p), `the source price ${p} was lost`);
  // Chunk by chunk: governance restored eight priced claims the model had left
  // out and rewrote nothing. A removal here is a fact deleted by enforcement.
  for (const c of k.perChunk) {
    const gone = c.before.filter((d) => !c.after.includes(d));
    assert.deepEqual(gone, [], `chunk ${c.ordinal} lost details: ${gone.join(" | ")}`);
  }
  const added = k.perChunk.flatMap((c) => c.after.filter((d) => !c.before.includes(d)));
  assert.equal(added.length, 8, "the restored claim count moved; re-measure");
  for (const p of ["$6,396", "$6,493", "$6,545", "$7,077", "$8,879", "$9,665", "$6,500", "$500"])
    assert.ok(added.some((d) => d.includes(p)), `${p} was not restored into a proposal`);
});

test("the creator's declaration never silently deletes a proposal", () => {
  const k = replay(KEEP);
  const proposed = (F.chunks as Bag[]).reduce((n, c) => n + itemsOf(c.result).length, 0);
  assert.equal(k.items.length, proposed, "enforcement dropped a proposed item");
  assert.equal(k.stripped, 0, "enforcement stripped content on the declared path");
});

// ---------------------------------------------------------------------------
// 3. SEVERAL PROPOSALS FOR ONE DECLARED RECORD
// ---------------------------------------------------------------------------

test("EVERY proposal is governed when the model disobeys the one-item prompt", () => {
  // The prompt asks for one item. Governing only the first would be the silent
  // choice this contract refuses; handing all of them the same claims would
  // write the same fact into each.
  const two = replay(KEEP, (c) => {
    const items = itemsOf(c.result);
    if (items.length !== 1) return c.result;
    const [a] = items;
    const details = (a.details ?? []) as unknown[];
    const half = Math.ceil(details.length / 2);
    return { sections: [{ title: "Community Information", items: [
      { ...a, details: details.slice(0, half) },
      { ...a, title: `${String(a.title ?? "")} (continued)`, description: "", details: details.slice(half) },
    ] }] };
  });
  const one = replay(KEEP);
  assert.ok(two.governed > one.governed, "splitting a proposal in two did not increase itemsGoverned");
  for (const c of two.perChunk)
    if (c.before.length) assert.ok(c.governed >= 2, `chunk ${c.ordinal} governed ${c.governed} of two proposals`);

  // AND NOTHING IS WRITTEN TWICE. A claim goes to exactly one proposal.
  for (const c of two.perChunk) {
    const dupes = c.after.filter((d, i) => c.after.indexOf(d) !== i);
    assert.deepEqual(dupes, [], `chunk ${c.ordinal} duplicated details across proposals: ${dupes.join(" | ")}`);
  }
  for (const p of PRICES)
    assert.ok(JSON.stringify(two.items).includes(p), `${p} was lost when the model returned two items`);
});

test("partitionAcrossItems is the identity for a single proposal", () => {
  const group = { claims: [{ id: "c", value: "$1", kind: "labelled", offset: 0 }] as never[],
    ambiguous: [] as never[], fragments: [] as never[] };
  for (const items of [[], [{ title: "one" }]])
    assert.equal(partitionAcrossItems(group, items as Bag[])[0], group,
      "automatic attribution can observe the partition, so auto is not untouched");
  // A claim already present in the SECOND proposal is assigned there, not to
  // the first — which is why it is ACCEPTED where it sits instead of restored.
  const parts = partitionAcrossItems(group, [{ title: "a" }, { title: "b", details: [{ label: "x", value: "$1" }] }]);
  assert.equal(parts[0].claims.length, 0);
  assert.equal(parts[1].claims.length, 1);
});

test("the declared envelope is the whole source, named by the creator", () => {
  const [e] = declaredEnvelopes("abcdef", "Spring Lake Village");
  assert.deepEqual(e, { index: DECLARED_RECORD, start: 0, end: 6, name: "Spring Lake Village" });
});

// ---------------------------------------------------------------------------
// 4. AUTO IS UNTOUCHED
// ---------------------------------------------------------------------------

test("AUTO IS BYTE-IDENTICAL on the same fixture — measured against the committed code", () => {
  const a = replay(null);
  // Measured on the committed enforcement before this change, chunk by chunk.
  assert.deepEqual(a.perChunk.map((c) => c.governed), [0, 0, 0, 0, 0, 1], "auto governance moved");
  assert.deepEqual(a.perChunk.map((c) => c.records), [0, 0, 9, 7, 14, 1], "auto record tiling moved");
  for (const c of a.perChunk)
    assert.deepEqual(c.after, c.before, `auto rewrote chunk ${c.ordinal}'s details`);
});

// ---------------------------------------------------------------------------
// 5. THE LEDGER DESCRIBES THE RUN THAT HAPPENED
// ---------------------------------------------------------------------------

test("ACCOUNTING AND ENFORCEMENT READ THE SAME RECORD COUNT", () => {
  // Before this, the observe-only ledger tiled a keep_together run into thirty
  // bullet records while enforcement used none — it described a run that never
  // happened, which is what its own header forbids.
  const k = replay(KEEP);
  assert.deepEqual(k.perChunk.map((c) => c.records), [1, 1, 1, 1, 1, 1],
    "the ledger still tiles a declared single record into many");
  const a = replay(null);
  assert.notDeepEqual(a.perChunk.map((c) => c.records), k.perChunk.map((c) => c.records),
    "auto and keep_together now read the source identically, so grouping is not reaching the ledger");
});

// ---------------------------------------------------------------------------
// 6. WHAT IS STILL NOT CAUGHT — measured, named, and deliberately not fixed here
// ---------------------------------------------------------------------------

test("GAP: an omitted qualifier is COUNTED but never asked about", () => {
  // "*Your monthly fee is subject to annual increases…", the Community Fee
  // refundability line, the April 1 2026 effective date and six of the eight
  // EVERYTHING YOU NEED bullets are all absent from the packet. With the
  // declared record bound they are now attributed and reconciled — the ledger
  // counts them orphaned — but reconcile's orphan count has no consumer, so
  // nothing reaches the professional.
  const k = replay(KEEP);
  assert.ok(k.orphaned > 0, "the omissions are no longer even counted");
  const blob = JSON.stringify(collapseToOneItem(k.items, "Spring Lake Village")).toLowerCase();
  for (const gone of ["annual increase", "refundable according", "april 1, 2026",
                      "lake walk", "wellness-focused", "internet"])
    assert.ok(!blob.includes(gone), `"${gone}" now survives — this gap is closed, update this test`);
  assert.equal(k.unresolved.filter((u) => u.kind === "source-unresolved" && !u.text.startsWith("+$")).length, 0,
    "an omission now surfaces — the orphan count grew a consumer, so this gap is closed");
});

test("GAP: synthesized recipient-facing prose is not caught by any guard", () => {
  // The published item carries `Description: "Senior living community offering
  // comprehensive amenities…"` — no clause of which is in the source, and the
  // word "senior" appears nowhere in it. enforceItem canonicalizes claims,
  // enforces specialized-destination exclusivity and applies the audience
  // sweep; none of them asks whether a model-authored detail is supported.
  const synthesized = "Senior living community offering comprehensive amenities and programs for residents.";
  assert.ok(!String(F.sourceText).toLowerCase().includes("senior living community"),
    "the fixture's source now contains the phrase, so this measures nothing");
  const out = enforceChunkResult({
    segmentText: (F.chunks as Bag[])[5].segmentText as string, chunkOrdinal: 5,
    sourceStart: (F.chunks as Bag[])[5].sourceStart as number, sourceText: F.sourceText,
    result: { sections: [{ title: "S", items: [{ title: "Spring Lake Village",
      details: [{ label: "Description", value: synthesized }] }] }] },
    runId: "r", destination: "packet", delimiterHint: F.delimiterHint, grouping: KEEP,
  });
  assert.equal(out.telemetry.itemsGoverned, 1, "the proposal was not governed at all");
  assert.ok(JSON.stringify(out.result).includes(synthesized),
    "unsupported prose is now removed — a source-support guard exists, so this gap is closed");
  assert.equal(out.unresolved.filter((u) => u.text.includes("Senior living")).length, 0,
    "unsupported prose is now surfaced — this gap is closed, update this test");
});

// ---------------------------------------------------------------------------
// 7. CANONICALIZATION MUST NOT DELETE WHAT IT DISPLACES
//
// Governance renders a governed claim over the model's detail, replacing it
// whole. On an aggregated detail that took the rest of the row with it:
//
//   [Little River — Studio Apartment] 490 sq ft, $6,396   ->   [490 sq ft] $6,396
//
// The remainder is now kept — but only where the record's own source text bears
// it out, which is what keeps "approximately" from riding along.
// ---------------------------------------------------------------------------

const SL_ROWS = [
  "Little River\tStudio Apartment\t490 sq ft\t$6,396",
  "Timber Cove\tAlcove Apartment\t530 sq ft\t$6,493",
];
const aggregated = SL_ROWS.map((r) => {
  const [name, type, size, fee] = r.split("\t");
  return { label: `${name} — ${type}`, value: `${size}, ${fee}` };
});

/** enforceItem directly, so the canonicalization is actually exercised: through
 *  the chunk route this source infers a tab delimiter and parses no claims. */
function governed(source: string, details: Record<string, string>[]) {
  const item: Bag = { title: "Spring Lake Village", details };
  const p = parseClaims(source);
  const r = reconcile(p, item);
  const e = enforceItem(item, r.resolutions, p.claims, { privateSource: "", recordSource: source });
  return { rows: (e.item.details ?? []) as { label: string; value: string }[], applied: e.applied,
           json: JSON.stringify(e.item) };
}

test("PRICE AND SIZE STILL CANONICALIZE to the source's own wording", () => {
  const g = governed(SL_ROWS.join("\n"), aggregated);
  assert.ok(g.applied.some((a) => a.action.includes("canonicalized")), "nothing was canonicalized at all");
  assert.ok(g.rows.some((d) => d.label === "490 sq ft" && d.value === "$6,396"),
    "the governed claim was not rendered from the source");
  assert.ok(g.rows.some((d) => d.label === "530 sq ft" && d.value === "$6,493"));
});

test("AND EVERY DISPLACED SOURCE FACT SURVIVES IT", () => {
  const g = governed(SL_ROWS.join("\n"), aggregated);
  for (const fact of ["Little River", "Studio Apartment", "490 sq ft", "$6,396",
                      "Timber Cove", "Alcove Apartment", "530 sq ft", "$6,493"])
    assert.ok(g.json.includes(fact), `${fact} was deleted by canonicalization`);
  // The remainder keeps the professional's own words, verbatim — nothing here
  // writes replacement prose.
  assert.ok(g.rows.some((d) => d.label === "Little River — Studio Apartment" && d.value === "490 sq ft"),
    "the residue was rewritten rather than preserved");
});

test("UNSUPPORTED PARAPHRASE GAINS NOTHING by sharing a detail with a claim", () => {
  // The measured property this must not undo: the source says "$2,400" and the
  // model said "approximately $2,400". The hedge is not in the source, so it is
  // not a fact the residue rule may protect.
  const alone = governed("Community Fee: $2,400",
    [{ label: "Community Fee", value: "approximately $2,400" }]);
  assert.deepEqual(alone.rows, [{ label: "Community Fee", value: "$2,400" }],
    "the model's paraphrase became canonical");

  // Nor does surrounding it with more unsupported wording rescue it.
  const padded = governed("Community Fee: $2,400",
    [{ label: "Community Fee", value: "approximately $2,400, payable on move-in" }]);
  assert.ok(!padded.json.includes("approximately"), "an unsupported hedge survived");
  assert.ok(!padded.json.includes("payable"), "unsupported model wording survived");
  assert.ok(padded.json.includes("$2,400"), "the supported fact was lost with the paraphrase");

  // A residue is all-or-nothing against the source, so no unsupported word can
  // ride in beside a supported one.
  const mixed = governed("Little River\tStudio Apartment\t490 sq ft\t$6,396",
    [{ label: "Little River — Studio Apartment (our favourite)", value: "490 sq ft, $6,396" }]);
  assert.ok(!mixed.json.includes("favourite"), "unsupported wording rode in on a supported residue");

  // AND NOTHING IS PRESERVED WHERE NOTHING CAN PROVE IT. With no record text
  // the rule declines rather than guessing.
  const item: Bag = { title: "X", details: [{ label: "Little River — Studio Apartment", value: "490 sq ft, $6,396" }] };
  const p = parseClaims("Little River\tStudio Apartment\t490 sq ft\t$6,396");
  const r = reconcile(p, item);
  const blind = enforceItem(item, r.resolutions, p.claims, { privateSource: "" });
  assert.ok(!JSON.stringify(blind.item).includes("Little River"),
    "residue was preserved with no source to prove it — that is a guess");
});

// ---------------------------------------------------------------------------
// 8. TWO BULLETS ARE TWO BULLETS
// ---------------------------------------------------------------------------

test("ADJACENT LIST ITEMS NEVER BECOME A LABEL AND ITS VALUE", () => {
  // Measured on the real transcription: "24-hour security" appears under both
  // EVERYTHING YOU NEED and HOUSEHOLD AMENITIES, so it recurs — and recurrence
  // is what promotes a line to a field name. The bullet under it became its
  // value, and the packet asserted a pairing the brochure never makes.
  const claims = parseClaims(F.sourceText, 0, { delimiter: null }).claims;
  const fabricated = claims.filter((c) => /^\s*[-–—•*]\s/.test(c.value) || /^\s*[-–—•*]\s/.test(c.label ?? ""));
  assert.deepEqual(fabricated.map((c) => `${c.label} => ${c.value}`), [],
    "a bullet pair is still being read as a claim");
  assert.equal(claims.length, 12, "the claim count moved; re-measure before accepting");

  // The smallest reproduction, on its own.
  const two = parseClaims(["- 24-hour security", "- Independent living, assisted living, skilled nursing",
                           "- 24-hour security"].join("\n"), 0, { delimiter: null });
  assert.equal(two.claims.length, 0, "two sibling bullets still pair");
});

test("BUT REAL PAIRS ARE UNTOUCHED — syntax decides, not vocabulary", () => {
  // Explicit label-value syntax.
  const colon = parseClaims("Community Fee: $6,500\nApplication Fee: $500");
  assert.equal(colon.claims.length, 2, "an explicit Label: value pair stopped parsing");

  // A tabular row wears no list marker, so nothing here can reach it.
  const rows = parseClaims(["Little River\t$6,396", "Timber Cove\t$6,493"].join("\n"));
  assert.equal(rows.claims.length, 2, "a delimited row stopped parsing");

  // A bullet followed by a value that identifies ITSELF is still a pair: the
  // value is recognised, not inferred from repetition.
  const identity = parseClaims(["- Community Phone", "- (415) 927-4200"].join("\n"));
  assert.ok(identity.claims.some((c) => /927/.test(c.value)),
    "a bullet followed by an identity value stopped pairing");

  // And every price in the real fixture still parses.
  const real = parseClaims(F.sourceText, 0, { delimiter: null }).claims;
  for (const p of ["$6,396", "$6,493", "$6,545", "$7,077", "$8,879", "$9,665", "$6,500", "$500", "$27", "$5"])
    assert.ok(real.some((c) => c.value.includes(p)), `${p} stopped being a claim`);
});
