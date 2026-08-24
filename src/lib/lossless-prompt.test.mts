// THE LOSSLESS BLOCK REACHES EXACTLY TWO PROMPTS.
//
// It was measured on the packet organize path and nowhere else. The Library and
// section-append path shares neither the measurement nor the enforcement scope,
// so a copy of this block arriving there would be an unmeasured change to a
// path deliberately being kept still.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { organizeLeadPrompt, sectionsPrompt, itemsOnlyPrompt } from "./ai-prompts.ts";

// The block as measured, pinned here as a literal. If someone edits the wording
// in ai-prompts.ts, this fails - which is the point: the offline result belongs
// to THIS text, and different text is an unmeasured prompt.
const BLOCK = `LOSSLESS ORGANIZATION - this applies to the whole source:
- Every distinct factual claim stated in the source must still be represented in your output.
- Where several values of the same kind are given, they are separate facts. Keep all of them; do not choose one as representative.
- Enumerations of facts must be preserved as the individual facts they are. Do not replace a list of values with a summary, a range, or a description of the list.
- Apparent redundancy is not permission to omit. Two values that look similar, or that seem to serve the same purpose, are still two facts.
- You may reorganize how information is presented and grouped. You may not reduce how much factual content is present.`;

const TYPES = ["senior-placement", "general", "real-estate", "unknown-type"];

test("both organize prompts carry the block, verbatim and once", () => {
  for (const t of TYPES) {
    for (const [name, p] of [["lead", organizeLeadPrompt(t)], ["sections", sectionsPrompt(t)]] as const) {
      assert.ok(p.includes(BLOCK), `${name}[${t}] does not carry the measured block verbatim`);
      assert.equal((p.match(/LOSSLESS ORGANIZATION/g) ?? []).length, 1,
        `${name}[${t}] carries the block more than once`);
      // Appended at the end, which is where the measured arm put it.
      assert.ok(p.endsWith(BLOCK), `${name}[${t}] does not end with the block`);
    }
  }
});

test("itemsOnlyPrompt is untouched by it", () => {
  // section_append AND library_import both use this one.
  const p = itemsOnlyPrompt();
  assert.doesNotMatch(p, /LOSSLESS/, "the lossless block reached the Library/section-append prompt");
  assert.doesNotMatch(p, /Apparent redundancy/, "block wording reached the Library/section-append prompt");
});

test("the block is defined once, not pasted twice", () => {
  // Two copies could drift, and then the two organize prompts would quietly be
  // running different contracts.
  const src = readFileSync("src/lib/ai-prompts.ts", "utf8");
  assert.equal((src.match(/LOSSLESS ORGANIZATION - this applies/g) ?? []).length, 1,
    "the block literal appears more than once in the source");
  assert.equal((src.match(/\$\{LOSSLESS_RULES\}/g) ?? []).length, 2,
    "expected exactly two references to the shared constant");
});

test("routing is unchanged: which prompt each entry point gets", () => {
  // The block changes prompt TEXT. If it also changed which prompt an entry
  // point receives, the measurement would not transfer.
  const ing = readFileSync("src/lib/ingestion.ts", "utf8");
  assert.match(ing, /entryPoint === "section_append" \|\| entryPoint === "library_import"\) systemPrompt = itemsOnlyPrompt/);
  assert.match(ing, /entryPoint === "organize" && isLead\) systemPrompt = organizeLeadPrompt/);
  assert.match(ing, /else systemPrompt = sectionsPrompt/);
});
