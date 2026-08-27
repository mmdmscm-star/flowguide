import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { auditAttribution, attributionWarningsFor, anchorsOf, classifyAnchor, normalizeForMatch } from "./attribution-conflict.ts";

const codeOf = (p: string) => readFileSync(p, "utf8");
const bodyOf = (p: string) => codeOf(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// Two communities under ONE operator, each mentioning the other — the pattern
// the founder says will grow with smaller RCFEs. Alpha's row also carries a
// description of Beta, which is the real source-entry error.
const A_OWN = "Alpha House is a locally owned assisted living community in San Rafael with a garden courtyard.";
const B_OWN = "Beta Manor offers memory care in a purpose-built single-storey building near the coast.";
const B_TEXT_IN_A = "Beta Manor is a locally owned and operated memory care community that provides personalized support in a warm, family-centered environment.";
const SOURCE = `Alpha House — San Rafael
 Community Phone: (415) 111-2222
${A_OWN} Alpha House and Beta Manor share the same owners.
${B_TEXT_IN_A}

Beta Manor — San Rafael
 Community Phone: (415) 333-4444
${B_OWN} Beta Manor is operated by the same family as Alpha House.`;
const TITLES = ["Alpha House — San Rafael", "Beta Manor — San Rafael"];

test("1. THE REAL CASE: text sitting in A's span, emitted on B, is flagged and blocks", () => {
  const a = auditAttribution({ title: "Beta Manor — San Rafael", description: B_TEXT_IN_A }, SOURCE, TITLES);
  assert.equal(a.resolved, true);
  assert.equal(a.ok, false, "content living only in another record's span was accepted");
  assert.equal(a.conflicts.length, 1);
  assert.match(a.conflicts[0].owner, /Alpha House/);
  const w = attributionWarningsFor({ title: "Beta Manor — San Rafael", description: B_TEXT_IN_A }, SOURCE, TITLES);
  assert.match(w[0], /Alpha House/, "the warning does not name where the text actually sits");
  assert.match(w[0], /Confirm where it belongs/i, "the warning resolves ownership instead of asking");
});

test("2. A MENTIONS B AND THE CONTENT STAYS ON A — no false reassignment", () => {
  // Alpha's own description names Beta. A name is never evidence.
  const a = auditAttribution({ title: "Alpha House — San Rafael",
    description: `${A_OWN} Alpha House and Beta Manor share the same owners.` }, SOURCE, TITLES);
  assert.equal(a.ok, true, `flagged because a sibling's NAME appears: ${JSON.stringify(a.conflicts)}`);
});

test("3. TWO RECORDS UNDER ONE OPERATOR MAY CITE EACH OTHER", () => {
  const b = auditAttribution({ title: "Beta Manor — San Rafael",
    description: `${B_OWN} Beta Manor is operated by the same family as Alpha House.` }, SOURCE, TITLES);
  assert.equal(b.ok, true, `a legitimate cross-reference was treated as a conflict: ${JSON.stringify(b.conflicts)}`);
});

test("4. CONTENT SUPPORTED BY ITS OWN SPAN SAVES NORMALLY", () => {
  assert.equal(auditAttribution({ title: "Alpha House — San Rafael", description: A_OWN }, SOURCE, TITLES).ok, true);
  assert.equal(auditAttribution({ title: "Beta Manor — San Rafael", description: B_OWN }, SOURCE, TITLES).ok, true);
});

test("5. PROVENANCE FAILURE FAILS CLOSED", () => {
  const a = auditAttribution({ title: "Community Not In This Source", description: B_TEXT_IN_A }, SOURCE, TITLES);
  assert.equal(a.resolved, false, "an underivable span was treated as derivable");
  assert.equal(a.ok, false, "an unlocatable record was waved through");
  assert.match(attributionWarningsFor({ title: "Community Not In This Source", description: B_TEXT_IN_A }, SOURCE, TITLES)[0],
    /could not locate/i);
});

test("6. MIXED DESCRIPTION: one genuine sentence does not authorise a copied one", () => {
  // The escape the founder identified: judging per DESCRIPTION rather than per
  // ANCHOR lets a locally-supported opening sentence carry copied text with it.
  const mixed = `${B_OWN} ${B_TEXT_IN_A}`;
  const a = auditAttribution({ title: "Beta Manor — San Rafael", description: mixed }, SOURCE, TITLES);
  assert.equal(a.ok, false, "a locally-supported sentence authorised the sentence copied from Alpha");
  assert.equal(a.conflicts.length, 1, `expected exactly the copied sentence: ${JSON.stringify(a.conflicts)}`);
  assert.match(a.conflicts[0].anchor, /warm, family-centered/);
  assert.match(a.conflicts[0].owner, /Alpha House/);
});

test("PARAPHRASE IS NEVER A BLOCK — the rule is provable movement, not provenance", () => {
  // 20 of 65 real descriptions had no verbatim anchor at all. Requiring
  // provenance would block a third of the Library.
  const a = auditAttribution({ title: "Beta Manor — San Rafael",
    description: "A thoughtfully designed community offering compassionate care and an engaging daily rhythm for residents." },
    SOURCE, TITLES);
  assert.equal(a.ok, true, "a paraphrased description was blocked");
});

test("boilerplate shared by several records makes NO claim", () => {
  const shared = "All residents enjoy chef-prepared dining and a full calendar of engaging daily activities.";
  const src = `A One — Town\n${shared}\n\nB Two — Town\n${shared}`;
  const a = auditAttribution({ title: "B Two — Town", description: shared }, src, ["A One — Town", "B Two — Town"]);
  assert.equal(a.ok, true, "text present in several spans was blamed on one");
});

test("short clauses are not anchors", () => {
  assert.deepEqual(anchorsOf("Pet friendly. Dog park."), [], "a short generic clause became an anchor");
  assert.equal(anchorsOf(A_OWN).length, 1);
});

test("normalisation is whitespace and Unicode ONLY, never wording", () => {
  assert.equal(normalizeForMatch("a  b\nc"), "a b c");
  assert.equal(normalizeForMatch("it’s “ok”"), `it's "ok"`);
  // Wording differences must NOT be normalised away.
  assert.notEqual(normalizeForMatch("the community is warm"), normalizeForMatch("the community is welcoming"));
});

test("classifyAnchor reports each of the four verdicts", () => {
  const others = [{ title: "A", span: "alpha text here" }, { title: "B", span: "beta text here" }];
  assert.equal(classifyAnchor("mine", "mine own span", others).kind, "own");
  assert.equal(classifyAnchor("alpha text", "own", others).kind, "conflict");
  assert.equal(classifyAnchor("text here", "own", others).kind, "ambiguous");
  assert.equal(classifyAnchor("nowhere", "own", others).kind, "unmatched");
});

test("IT HAS NO MOVE AND NO DELETE", () => {
  const src = codeOf("src/lib/attribution-conflict.ts");
  for (const forbidden of [/\.description\s*=/, /delete\s+\w+\.description/, /splice\(/]) {
    assert.doesNotMatch(src, forbidden, `the safeguard mutates content: ${forbidden}`);
  }
});

test("SAVE RE-DERIVES FROM SOURCE and does not trust the stored warning", () => {
  const save = bodyOf("src/app/api/library/import/[runId]/save/route.ts");
  assert.match(save, /auditAttribution\(t\.payload as \{ title\?: unknown; description\?: unknown \}, provenanceSource, allTitles\)/,
    "save does not re-audit attribution from source");
  // Positive evidence comes from source no unresolved record may own, and that
  // set is re-derived here rather than read off the payload.
  assert.match(save, /const provenanceSource = withoutAmbiguous\(fullSource, ambiguous\)/,
    "save judges attribution against ranges an unlocatable record may own");
  assert.match(save, /ambiguousRanges\(allProposals as never, fullSource, chunkRanges\)/,
    "save trusts a stored ambiguity instead of re-deriving it");
  assert.match(save, /select\("source_text"\)/, "save never loads the authoritative source");
  assert.ok(!/attributionWarnings/.test(save), "save reads the stored warning — clearing it would bypass the gate");
  assert.match(save, /outcome: "attribution_conflict"/);
});

test("materialisation surfaces it for review", () => {
  const r = codeOf("src/app/api/library/import/[runId]/proposals/route.ts");
  assert.match(r, /attributionWarningsFor\(/, "the conflict is never surfaced at review");
  assert.match(r, /attributionWarnings: attribWarn/, "it is computed but not stored");
});

test("REAL RUN: exactly one conflict, and it is the known one", () => {
  const T = process.env.TMPDIR!;
  let props: Record<string, unknown>[]; let SRC: string;
  try {
    props = JSON.parse(readFileSync(T + "FINAL.json", "utf8")).proposals;
    SRC = readFileSync(T + "master-source.txt", "utf8");
  } catch { return; }                 // artefacts absent — skip, never fake a pass
  const titles = props.map((p) => String(p.title));
  const flagged: string[] = [];
  for (const p of props) {
    const a = auditAttribution(p as { title?: unknown; description?: unknown }, SRC, titles);
    if (!a.ok) flagged.push(`${String(p.title)} <- ${a.conflicts[0]?.owner ?? "unresolved"}`);
  }
  assert.equal(flagged.length, 1, `expected exactly the Greenwood case: ${JSON.stringify(flagged)}`);
  assert.match(flagged[0], /Greenwood/);
  assert.match(flagged[0], /St Michael/);
});
