// THE COUNT NOBODY READ.
//
// reconcile has always produced an orphan count and nothing has ever consumed
// it. On the real Spring Lake run that silence cost four material pricing
// qualifiers and five bullets: they were in the professional's source, in none
// of the packet, and in no telemetry anyone would ever look at.
//
// The reason it stayed unread is in these numbers. Asked per chunk — the only
// place reconcile runs — the same run reports 58 orphans, and most of them are
// artefacts of chunking rather than losses. Asked ONCE, against the item the
// run would actually publish, it reports 11.
//
//   58 chunk-local apparent orphans  ->  11 real run-level omissions  ->  1 card
process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { omittedSourceLines, omittedExcerpt, recipientVisible, buildOmission } from "./omitted-source.ts";
import { collapseToOneItem } from "./collapse-item.ts";
import { parseClaims } from "./claim-parser.ts";
import { reconcile } from "./reconcile.ts";
import { survives } from "./placement.ts";
import { attributeAll } from "./attribution.ts";
import { declaredEnvelopes } from "./declared-record.ts";
import { enforceChunkResult } from "./enforce-chunk.ts";
import { REVIEW_REQUIRED, OBSERVED_ONLY, isReviewRequired, dispositionsFor,
         guidanceFor, headlineFor, actionLabel, unitId, type ReviewFailure } from "./review-units.ts";

type Bag = Record<string, unknown>;
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const codeOf = (p: string) =>
  readFileSync(join(ROOT, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
const fixture = (n: string) => JSON.parse(readFileSync(join(HERE, "__fixtures__", n), "utf8"));

const F = fixture("spring-lake-run.json");
const SEGMENTS = (F.chunks as Bag[]).map((c) => ({ ordinal: c.ordinal as number, segmentText: c.segmentText as string }));
const SHIPPED = F.shippedItem.item as Bag;
const OPTS = { sourceText: F.sourceText as string, delimiterHint: F.delimiterHint as string | null };
const lines = () => omittedSourceLines(SEGMENTS, SHIPPED, OPTS);

/** The material the professional named. A price that survives while its own
 *  qualifier disappears is the failure this whole unit exists to stop. */
const QUALIFIERS = [
  "subject to annual increases",
  "additional charges will apply for personal assistance services",
  "The Community Fee is refundable according to the terms of the admission agreement",
  "Fees listed are as of April 1, 2026 and are subject to change",
];

// ---------------------------------------------------------------------------
// 1. THE MEASUREMENT THAT JUSTIFIES ASKING RUN-LEVEL
// ---------------------------------------------------------------------------

test("58 CHUNK-LOCAL ORPHANS ARE 11 RUN-LEVEL OMISSIONS", () => {
  // Per chunk, against that chunk's own proposal — what reconcile computes today.
  let chunkLocal = 0;
  for (const c of F.chunks as Bag[]) {
    const out = enforceChunkResult({
      segmentText: c.segmentText as string, chunkOrdinal: c.ordinal as number,
      sourceStart: c.sourceStart as number, sourceText: F.sourceText, result: c.result,
      runId: "r", destination: "packet", delimiterHint: F.delimiterHint,
      grouping: { intent: "keep_together", title: "Spring Lake Village" } as never,
    });
    const items = ((out.result as { sections?: { items?: Bag[] }[] }).sections ?? []).flatMap((s) => s.items ?? []);
    const p = parseClaims(c.segmentText as string, c.ordinal as number, { delimiter: null });
    const a = attributeAll(p.claims, p.ambiguous, p.fragments,
      declaredEnvelopes(F.sourceText, "Spring Lake Village"), c.sourceStart as number);
    const g = a.byRecord.get(0) ?? { claims: [], ambiguous: [], fragments: [] };
    chunkLocal += reconcile(g, items[0] ?? null).orphaned.length;
  }
  assert.equal(chunkLocal, 58, "the chunk-local orphan count moved; re-measure before accepting");
  assert.equal(lines().length, 11, "the run-level omission count moved; re-measure");
});

test("EVERY MATERIAL PRICING QUALIFIER IS IN THE ONE UNIT", () => {
  const text = omittedExcerpt(lines());
  for (const q of QUALIFIERS)
    assert.ok(text.includes(q), `the card does not carry: ${q}`);
  // And the bullets the professional noticed were gone.
  for (const b of ["Lake walks, hiking trails and bocce", "Participative and wellness-focused culture",
                   "Lots of ways to lead a meaningful life", "Dining options to suit any taste",
                   "Bustling, down-to-earth community"])
    assert.ok(text.includes(b), `the card does not carry the omitted bullet: ${b}`);
});

test("CONTENT THAT IS IN THE ITEM IS NOT REPORTED AS MISSING", () => {
  const text = omittedExcerpt(lines());
  // These are orphaned in their OWN chunk and present in the packet — the whole
  // reason the question may not be asked per chunk.
  for (const present of ["Scheduled transportation", "Emergency response system",
                         "Inviting kitchen with upscale appliances", "Washer and dryer and ample closets",
                         "Interior and exterior maintenance", "Lush landscaping",
                         "Wide variety of resident-initiated"])
    assert.ok(!text.includes(present), `"${present}" is in the item and was reported missing`);
  // Line-wrap continuations have no independent existence either.
  for (const wrap of ["charging port", "paths and beautiful resident-tended gardens", "programs and wood shop"])
    assert.ok(!text.includes(wrap), `a transcription line-wrap was reported as an omission: ${wrap}`);
  // A price is never an omission: prices are claims, and they survived.
  for (const p of ["$6,396", "$9,665", "$6,500", "$500"])
    assert.ok(!text.includes(p), `${p} was reported missing although it is in the item`);
});

test("NOTHING MISSING MEANS NO UNIT AT ALL", () => {
  // An item that carries the whole source verbatim has nothing to report.
  const everything: Bag = { title: "X", description: String(F.sourceText) };
  assert.deepEqual(omittedSourceLines(SEGMENTS, everything, OPTS), []);
  assert.equal(omittedExcerpt([]), "", "an empty excerpt would still build a card");
  // And a run with no assembled item reports nothing rather than everything:
  // that failure has its own name (checkRunOutcome) and must not be buried.
  assert.deepEqual(omittedSourceLines(SEGMENTS, null, OPTS), []);
  assert.deepEqual(omittedSourceLines([], SHIPPED, OPTS), []);
});

test("REPLAY IS STABLE — same run, same lines, same unit id", () => {
  const a = lines(), b = lines();
  assert.deepEqual(a, b, "the omission list is not deterministic");
  const idOf = (text: string) => unitId("run-1", { chunk: -1, record: 0, kind: "source-details-omitted", text });
  assert.equal(idOf(omittedExcerpt(a)), idOf(omittedExcerpt(b)), "a replayed finalize would add a second card");
  // Exact duplicates collapse: one line written twice is one omission.
  const doubled = [...SEGMENTS, ...SEGMENTS];
  assert.deepEqual(omittedSourceLines(doubled, SHIPPED, OPTS), a,
    "the same segment seen twice doubled the card");
});

// ---------------------------------------------------------------------------
// 2. WHAT IT IS AND IS NOT ALLOWED TO DO
// ---------------------------------------------------------------------------

test("EVERY REPORTED LINE IS VERBATIM SOURCE — nothing is written", () => {
  // WHITESPACE-NORMALISED, and that is the whole allowance. A brochure line
  // wrapped by the transcription — "All the ingredients for" / "an engaging
  // life." — is one sentence the parser rejoins, so the reported line is the
  // source's own words, in source order, with a wrap replaced by one space.
  // Nothing is added, removed or reordered, which is what this asserts.
  const ws = (x: string) => x.replace(/\s+/g, " ");
  const src = ws(String(F.sourceText));
  for (const l of lines())
    assert.ok(src.includes(ws(l)), `a reported line is not the source's own words: ${JSON.stringify(l)}`);
  // At least one reported line IS a literal substring, so the test above cannot
  // be passing on normalisation alone.
  assert.ok(lines().some((l) => String(F.sourceText).includes(l)), "nothing reported is literal source");
  // No model, no provider, no prose.
  const code = codeOf("src/lib/omitted-source.ts");
  for (const forbidden of ["fetch(", "openrouter", "OPENROUTER", "processSegment", "max_tokens"])
    assert.ok(!code.includes(forbidden), `the omission check reaches for ${forbidden}`);
  // It reads the source and the item, and writes neither.
  assert.ok(!/\.update\(|\.insert\(|\.upsert\(/.test(code), "the omission check writes to the database");
});

test("ONE UNIT, RUN-LEVEL, AND NEVER PER CHUNK OR PER LINE", () => {
  const route = codeOf("src/app/api/ingest/[runId]/finalize/route.ts");
  assert.equal((route.match(/buildOmission\(/g) ?? []).length, 1,
    "the omission check runs more than once");
  assert.equal((route.match(/code: "source_details_omitted"/g) ?? []).length, 1,
    "more than one omission unit can be built");
  assert.match(route, /chunk: -1/, "the run-level unit claims to belong to a chunk");
  // AFTER the fold, so the question is asked about the assembled item.
  assert.ok(route.indexOf("collapseRunToOneItem") < route.indexOf("buildOmission"),
    "the omission check runs before the collapse, so it would judge a partial item");
  // BEFORE the apply, so nothing is published on the strength of an unasked question.
  assert.ok(route.indexOf("buildOmission") < route.indexOf('rpc("finalize_ingestion_run"'),
    "the omission check runs after the content is applied");
  // And no per-chunk path can produce this kind.
  for (const f of ["src/lib/enforce-chunk.ts", "src/app/api/ingest/[runId]/chunks/[ordinal]/route.ts"])
    assert.ok(!codeOf(f).includes("source-details-omitted"),
      `${f} can emit an omission unit, so it would fan out per chunk`);
});

test("KEEP_TOGETHER ONLY — auto is not touched", () => {
  const route = codeOf("src/app/api/ingest/[runId]/finalize/route.ts");
  // It is reachable only from the collapse's success, and the collapse returns
  // `skipped` for anything that is not keep_together.
  assert.match(route, /if \(collapse\.kind === "collapsed"\)[\s\S]{0,400}buildOmission/,
    "the omission check is not gated on a completed keep_together fold");
  assert.ok(!codeOf("src/lib/omitted-source.ts").includes("grouping"),
    "the omission module branches on grouping rather than being handed one item");
  // And enforcement is unchanged: no new unit kind reaches the chunk path.
  const a = enforceChunkResult({
    segmentText: (F.chunks as Bag[])[1].segmentText as string, chunkOrdinal: 1,
    sourceStart: (F.chunks as Bag[])[1].sourceStart as number, sourceText: F.sourceText,
    result: (F.chunks as Bag[])[1].result, runId: "r", destination: "packet",
    delimiterHint: F.delimiterHint, grouping: null,
  });
  assert.deepEqual(a.unresolved.filter((u) => u.kind === "source-details-omitted"), []);
  assert.deepEqual(a.reviewUnits.filter((u) => u.kind === "source-details-omitted"), []);
});

test("THE CARD OFFERS ONLY THE THREE HONEST ANSWERS", () => {
  const f = { id: "u", code: "source_details_omitted", kind: "source-details-omitted" } as ReviewFailure;
  assert.deepEqual(dispositionsFor(f), ["included", "resolved", "ignored"],
    "the omission card offers a disposition it cannot honestly take");
  assert.ok(!dispositionsFor(f).includes("kept_private"),
    "it offers to file the client's own source material privately");
  assert.equal(headlineFor(f), "Some source details weren't included");
  assert.equal(actionLabel(f, "resolved", "x"), "I added these elsewhere");
  assert.equal(actionLabel(f, "ignored", "x"), "Leave them out");
  assert.match(guidanceFor(f), /won't guess where they belong/);
  // Review-required, so it blocks publishing rather than being telemetry.
  assert.ok(isReviewRequired("source-details-omitted"));
  assert.ok(!("source-details-omitted" in OBSERVED_ONLY));
  assert.equal(REVIEW_REQUIRED["source-details-omitted"].code, "source_details_omitted");
  // The panel takes all of this from the registry, not from its own strings.
  const panel = codeOf("src/components/ImportProgress.tsx");
  assert.match(panel, /headlineFor\(f\)/, "the panel does not render the kind's headline");
  assert.match(panel, /actionLabel\(f, "resolved"/, "the panel hardcodes the button wording");
  assert.ok(!panel.includes("Some source details"), "the copy is hardcoded in the panel");
});

// ---------------------------------------------------------------------------
// 3. HOW NOISY IS THE CARD, on sources that are not this one
// ---------------------------------------------------------------------------

test("NOISE: representative real sources produce a SMALL card, not a wall", () => {
  const ep = fixture("event-planner-chunks.json");
  const epSegs = [0, 1, 2].map((i) => ({ ordinal: ep[i].ordinal as number, segmentText: ep[i].segment_text as string }));
  const epItems = [0, 1, 2].flatMap((i) =>
    ((ep[i].result?.sections ?? []) as { items?: Bag[] }[]).flatMap((s) => s.items ?? []));
  const epLines = omittedSourceLines(epSegs, collapseToOneItem(epItems, "One") as unknown as Bag,
    { sourceText: epSegs.map((s) => s.segmentText).join("\n"), delimiterHint: null });
  assert.equal(epItems.length, 12, "the event-planner fixture changed");
  assert.equal(epLines.length, 2, "the event-planner card size moved; re-measure");

  const io = fixture("internal-only-chunks.json");
  const ioSegs = (io.chunks as Bag[]).map((c) => ({ ordinal: c.ordinal as number, segmentText: c.segmentText as string }));
  const ioItems = (io.chunks as Bag[]).flatMap((c) =>
    (((c.result as { sections?: { items?: Bag[] }[] })?.sections ?? [])).flatMap((s) => s.items ?? []));
  const ioLines = omittedSourceLines(ioSegs, collapseToOneItem(ioItems, "One") as unknown as Bag,
    { sourceText: ioSegs.map((s) => s.segmentText).join("\n"), delimiterHint: io.delimiterHint ?? null });
  assert.equal(ioLines.length, 5, "the internal-only card size moved; re-measure");

  // The shape that matters: a card is a handful of lines on every source
  // measured so far, never a per-fragment fan-out.
  // Exactly one line on each of these survives ONLY in the private note, and is
  // therefore reported: a planner's "October 17 but expects to know tomorrow…"
  // and an "INTERNAL ONLY" marker. The client sees neither.
  for (const [set, item] of [[epLines, collapseToOneItem(epItems, "One")],
                             [ioLines, collapseToOneItem(ioItems, "One")]] as const)
    assert.equal(set.filter((l) => survives({ notes: item.notes } as Bag, l)).length, 1,
      "the notes-only omission stopped being reported");

  for (const [name, n, frags] of [["spring-lake", lines().length, 67],
                                  ["event-planner", epLines.length, 10],
                                  ["internal-only", ioLines.length, 157]] as const)
    assert.ok(n <= 12, `${name} would show ${n} lines (of ${frags} fragments) — that is a wall, not a card`);
});

// ---------------------------------------------------------------------------
// 4. A PRIVATE NOTE IS NOT SURVIVAL
//
// The question is not "is this text anywhere in the item" — it is "did it reach
// the person the Sendset was prepared for". `notes` is the one field whose
// entire meaning is that they never see it, so a qualifier filed there has been
// lost to the client exactly as completely as one dropped outright.
// ---------------------------------------------------------------------------

/** One caveat line, present ONLY in the creator's private note. */
const CAVEAT = "*Your monthly fee is subject to annual increases and additional charges will apply for personal assistance services.";

test("A LINE THAT SURVIVES ONLY IN NOTES IS STILL REPORTED", () => {
  const notesOnly: Bag = { ...SHIPPED, notes: CAVEAT };
  // Nothing the client sees carries it.
  assert.ok(!JSON.stringify(recipientVisible(notesOnly)).includes("annual increases"),
    "the fixture leaked the caveat into a recipient-visible field, so this measures nothing");
  const reported = omittedSourceLines(SEGMENTS, notesOnly, OPTS);
  assert.ok(reported.some((l) => l.includes("subject to annual increases")),
    "a qualifier filed in the private note was treated as having survived");
  // And nothing else moved: filing it privately neither hides nor adds omissions.
  assert.equal(reported.length, lines().length,
    "putting a line in notes changed the omission count in some other way");
});

test("RECIPIENT-VISIBLE FIELDS STILL SATISFY SURVIVAL, one field at a time", () => {
  const line = "Fees listed are as of April 1, 2026 and are subject to change.";
  assert.ok(lines().includes(line), "the fixture no longer omits the line this test moves around");
  const carriers: [string, Bag][] = [
    ["description", { description: line }],
    ["details", { details: [{ label: "Pricing", value: line }] }],
    ["highlight", { highlight: line }],
    ["title", { title: line }],
    ["address", { address: line }],
    ["links", { links: [{ url: "https://example.test", label: line }] }],
    ["contacts", { contacts: [{ name: "A", role: line }] }],
  ];
  for (const [where, carrier] of carriers) {
    const item: Bag = { ...SHIPPED, ...carrier };
    assert.ok(!omittedSourceLines(SEGMENTS, item, OPTS).includes(line),
      `a line carried in ${where} — which the client sees — was reported missing`);
  }
  // notes is the one that does NOT count.
  assert.ok(omittedSourceLines(SEGMENTS, { ...SHIPPED, notes: line }, OPTS).includes(line),
    "notes satisfied a recipient-facing completeness check");
});

test("the private-note provenance gate is untouched by this", () => {
  // This changes what counts as SURVIVAL for a completeness question. It does
  // not change who may mark something private, or what enforcement does with an
  // unauthorised note — that rule lives in enforce.ts and knows nothing of this.
  const enforce = codeOf("src/lib/enforce.ts");
  assert.ok(!enforce.includes("omittedSourceLines") && !enforce.includes("recipientVisible"),
    "the privacy gate now depends on the omission check");
  // And the projection is driven by placement's own map, not by naming a field.
  const code = codeOf("src/lib/omitted-source.ts");
  assert.match(code, /isRecipientVisible\(/, "the recipient projection hardcodes which field is private");
  assert.ok(!/["']notes["']/.test(code), "the module names `notes` instead of asking placement");
});

// ---------------------------------------------------------------------------
// 5. THE DETECTOR FAILS CLOSED
//
// It was best-effort in its first version. That publishes a Sendset while
// reporting that everything passed, which is the failure this whole unit exists
// to prevent, wearing a different hat.
// ---------------------------------------------------------------------------

test("A DETECTOR FAILURE IS A FAILURE — never zero omissions", () => {
  // A segment whose text cannot be read at all.
  const poisoned = [{ ordinal: 0, get segmentText(): string { throw new Error("boom"); } }];
  const out = buildOmission(poisoned as unknown as typeof SEGMENTS, SHIPPED, OPTS);
  assert.equal(out.ok, false, "a throw inside the check was reported as 'nothing omitted'");
  if (!out.ok) assert.match(out.message, /boom/);

  // An item that cannot be inspected.
  const hostile: Bag = { title: "X", get details(): unknown { throw new Error("nope"); } };
  const out2 = buildOmission(SEGMENTS, hostile, OPTS);
  assert.equal(out2.ok, false, "an unreadable item was reported as complete");

  // The healthy path still returns the same answer as the raw function.
  const ok = buildOmission(SEGMENTS, SHIPPED, OPTS);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.lines, lines());
    assert.equal(ok.text, omittedExcerpt(lines()));
  }
});

test("A DETECTOR FAILURE STOPS THE FINALIZE BEFORE THE RPC IS CALLED", () => {
  const route = codeOf("src/app/api/ingest/[runId]/finalize/route.ts");
  const at = route.indexOf("buildOmission(");
  const rpc = route.indexOf('rpc("finalize_ingestion_run"');
  assert.ok(at > 0 && rpc > at, "the omission check does not precede the apply");

  // The refusal is a RETURN, and it is between the check and the apply.
  const between = route.slice(at, rpc);
  assert.match(between, /if \(!omission\.ok\)/, "a failed check is not tested for");
  assert.match(between, /omission_check_failed/, "the refusal has no named error");
  const refusal = between.indexOf("omission_check_failed");
  assert.match(between.slice(Math.max(0, refusal - 200), refusal + 200), /return NextResponse\.json/,
    "the failure is reported without returning, so the apply still runs");

  // NOT SWALLOWED. No catch may sit between the check and the apply, and the
  // check itself no longer runs inside one.
  assert.ok(!/catch\s*\(/.test(between), "a catch between the check and the apply could swallow the refusal");
  assert.ok(!route.includes("[finalize] omission check threw"), "the best-effort swallow is still there");

  // And the run is left retryable: nothing is applied and no status is written
  // before this point — the only earlier write is the fold, which is idempotent.
  assert.ok(route.indexOf("omission_check_failed") < route.indexOf('status: "needs_review"'),
    "a detector failure could be recorded as a review decision");
  assert.ok(!/omission\.ok[\s\S]{0,300}needs_review/.test(route),
    "a detector failure is converted into a review state");
});
