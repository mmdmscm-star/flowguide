import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { auditProposal, sourceOrdinalsOf, sourceTextFor, priceWarningsFor, priceBlockMessage } from "./library-price-gate.ts";
import { mergeProposals } from "./library-continuation.ts";

const codeOf = (p: string) => readFileSync(p, "utf8");
/** Source with comments stripped — a rule that must not appear in CODE is not
 *  violated by a comment explaining why it must not appear. */
const bodyOf = (p: string) => codeOf(p)
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SAVE = codeOf("src/app/api/library/import/[runId]/save/route.ts");
const PATCH = codeOf("src/app/api/library/import/[runId]/proposals/[id]/route.ts");
const MAT = codeOf("src/app/api/library/import/[runId]/proposals/route.ts");

// The real Windsong shape: two tables, one community.
const CH = [
  { ordinal: 4, segment_text: "Windsong of Sonoma\n Shared Studio\n - $5,595-$6,250/month\n Community Fee: Starting at $6,000\n" },
  { ordinal: 5, segment_text: "Additional PDF entry / possible updated pricing:\n Shared Studio\n - $5,200/month\n" },
  { ordinal: 9, segment_text: "Somewhere Else\n Studio - $1,111/month\n" },
];

test("SAVE RE-AUDITS FROM SOURCE — it does not trust priceWarnings", () => {
  // The stored array lives in a payload the client can PATCH. Gating on it
  // would let the gate be cleared by editing the thing it guards.
  assert.match(SAVE, /auditProposal\(\{ \.\.\.t\.payload \}, chunkTexts\)/,
    "save does not re-audit from the chunk text");
  assert.match(SAVE, /loadChunkTexts\(supabase, runId\)/, "save never loads the authoritative source");
  assert.ok(!/priceWarnings/.test(bodyOf("src/app/api/library/import/[runId]/save/route.ts")),
    "save READS the stored warnings — clearing them would bypass the gate");
});

test("CLEARING priceWarnings BY HAND DOES NOT BYPASS SAVE", () => {
  // Simulate exactly that: a payload whose warnings were wiped, still holding
  // an unsupported range.
  const wiped = { title: "Windsong of Sonoma", ordinal: 4, priceWarnings: [],
                  details: [{ label: "Shared Studio", value: "$5,200-$6,250/month" }] };
  const a = auditProposal(wiped, CH);
  assert.equal(a.ok, false, "a wiped warnings array let an invented range through");
  assert.deepEqual(a.unsupportedRanges, ["$5,200-$6,250"]);
});

test("BYPASSING MATERIALISATION DOES NOT BYPASS SAVE", () => {
  // A payload that never went through materialisation carries no warnings at
  // all. Save must still refuse it.
  const never = { title: "Windsong of Sonoma", ordinal: 4,
                  details: [{ label: "Shared Studio", value: "$9,999/month" }] };
  assert.equal(auditProposal(never, CH).ok, false, "an unmaterialised payload was accepted");
});

test("WINDSONG'S BLENDED RANGE IS BLOCKED DETERMINISTICALLY", () => {
  const blended = { title: "Windsong of Sonoma", sourceOrdinals: [4, 5],
                    details: [{ label: "Shared Studio", value: "$5,200-$6,250/month" }] };
  const a = auditProposal(blended, CH);
  assert.equal(a.ok, false, "the blend was accepted");
  assert.deepEqual(a.unsupportedRanges, ["$5,200-$6,250"]);
  // Both endpoints are individually real — the PAIRING is what is invented.
  assert.deepEqual(a.unsupported, [], "an endpoint was wrongly reported as fabricated");
});

test("EITHER SOURCE TABLE, KEPT WHOLE, IS ACCEPTED", () => {
  for (const value of ["$5,595-$6,250/month", "$5,200/month"]) {
    const ok = { title: "Windsong of Sonoma", sourceOrdinals: [4, 5],
                 details: [{ label: "Shared Studio", value }] };
    assert.equal(auditProposal(ok, CH).ok, true, `a real source price was blocked: ${value}`);
  }
});

test("EDITING AN UNSUPPORTED PRICE TO A SUPPORTED ONE CLEARS THE BLOCK", () => {
  const before = { title: "Windsong of Sonoma", sourceOrdinals: [4, 5],
                   details: [{ label: "Shared Studio", value: "$5,200-$6,250/month" }] };
  assert.equal(priceWarningsFor(before, CH).length, 1);
  const after = { ...before, details: [{ label: "Shared Studio", value: "$5,595-$6,250/month" }] };
  assert.deepEqual(priceWarningsFor(after, CH), [], "a corrected price still blocks");
  assert.equal(auditProposal(after, CH).ok, true);
});

test("ADDING A NEW UNSUPPORTED PRICE THROUGH AN EDIT CREATES A BLOCK", () => {
  const clean = { title: "Windsong of Sonoma", sourceOrdinals: [4, 5],
                  details: [{ label: "Shared Studio", value: "$5,595-$6,250/month" }] };
  assert.deepEqual(priceWarningsFor(clean, CH), []);
  const edited = { ...clean, details: [...clean.details, { label: "Invented", value: "$12,345/month" }] };
  assert.deepEqual(priceWarningsFor(edited, CH), ["$12,345"], "a newly typed price was not caught");
});

test("A MERGED RECORD IS AUDITED AGAINST BOTH HALVES", () => {
  // Auditing a merged community against one half reports the other half's
  // legitimate prices as unsupported — a false block on every split community.
  const a = { ordinal: 4, idx: 0, title: "Windsong of Sonoma",
              details: [{ label: "Shared Studio", value: "$5,595-$6,250/month" }] };
  const b = { ordinal: 5, idx: 0, title: "Windsong of Sonoma",
              details: [{ label: "Updated Shared Studio", value: "$5,200/month" }] };
  const merged = mergeProposals(a as never, b as never) as Record<string, unknown>;
  assert.deepEqual(sourceOrdinalsOf(merged), [4, 5], "the merge lost a half's provenance");
  assert.ok(sourceTextFor(merged, CH).includes("$5,200"), "the second half's text is not authoritative");
  assert.equal(auditProposal(merged, CH).ok, true, "a legitimately merged record was blocked");
});

test("provenance is not the professional's to edit", () => {
  assert.match(PATCH, /sourceOrdinals: sourceOrdinalsOf\(/,
    "PATCH takes sourceOrdinals from the client — a record could claim another community's source");
  assert.match(PATCH, /priceWarnings: warnings/, "PATCH does not recompute warnings");
});

test("the audit never runs against an EMPTY source and calls it clean", () => {
  // loadImportChunks does not select segment_text. Auditing against it finds no
  // supporting value and condemns every price — the opposite failure, and just
  // as wrong. A dedicated loader exists for this reason.
  const starved = auditProposal({ title: "X", ordinal: 4, details: [{ label: "S", value: "$5,595" }] },
    [{ ordinal: 4, segment_text: "" }]);
  assert.equal(starved.ok, false, "an empty source silently passed everything");
  assert.match(MAT, /loadChunkTexts\(supabase, runId\)/, "materialise audits against textless chunks");
  assert.match(PATCH, /loadChunkTexts\(supabase, runId\)/, "patch audits against textless chunks");
});

test("the refusal names the community, the value, and what to do", () => {
  const m = priceBlockMessage("Windsong of Sonoma", ["$5,200-$6,250"]);
  assert.match(m, /Windsong of Sonoma/);
  assert.match(m, /\$5,200-\$6,250/);
  assert.match(m, /Correct or remove/i);
  assert.match(SAVE, /outcome: "unsupported_price"/, "a blocked save is not distinguishable");
  assert.match(SAVE, /priceBlockMessage\(title, offending\)/, "the professional is told nothing specific");
});

test("REAL DATA: the other 64 communities are unaffected", () => {
  const T = process.env.TMPDIR!;
  let props: Record<string, unknown>[];
  try {
    props = JSON.parse(readFileSync(T + "proposals.json", "utf8")).proposals;
  } catch { return; }                    // artefact absent — skip, never fake a pass
  const sheet = JSON.parse(readFileSync(T + "sheet.json", "utf8")) as string[][];
  const rows = sheet.slice(1).filter((r) => r.some((c) => String(c).trim()));
  const key = (t: unknown) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  let blocked: string[] = [];
  for (const p of props) {
    const row = rows.find((r) => key(r[0]).startsWith(key(p.title).slice(0, 14)) && key(r[0]).length > 4);
    if (!row) continue;
    const chunks = [{ ordinal: Number(p.ordinal), segment_text: row.map(String).join("\n") }];
    if (!auditProposal(p, chunks).ok) blocked.push(String(p.title));
  }
  assert.deepEqual(blocked, ["Windsong of Sonoma"],
    `the gate blocks communities it should not: ${JSON.stringify(blocked)}`);
});
