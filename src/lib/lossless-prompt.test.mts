// THE LOSSLESS BLOCK REACHES EXACTLY TWO PROMPTS.
//
// It was measured on the packet organize path and nowhere else. The Library and
// section-append path shares neither the measurement nor the enforcement scope,
// so a copy of this block arriving there would be an unmeasured change to a
// path deliberately being kept still.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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

test("both organize prompts carry the block, verbatim and once", () => {
  // One prompt each now: the per-type variants these were parameterised over
  // are retired, and the measured evidence for them was nil.
  for (const [name, p] of [["lead", organizeLeadPrompt()], ["sections", sectionsPrompt()]] as const) {
    assert.ok(p.includes(BLOCK), `${name} does not carry the measured block verbatim`);
    assert.equal((p.match(/LOSSLESS ORGANIZATION/g) ?? []).length, 1, `${name} carries the block more than once`);
    // Appended at the end, which is where the measured arm put it.
    assert.ok(p.endsWith(BLOCK), `${name} does not end with the block`);
  }
});

test("the structuring prompt no longer branches on a packet type", () => {
  // Retired 2026-09-16 after a read-only comparison on the real historical
  // sources: fact coverage was identical with and without the vertical hint,
  // and run-to-run variance of the SAME prompt was larger than any difference
  // between them. The column stays for existing rows; nothing reads it.
  for (const builder of [organizeLeadPrompt, sectionsPrompt]) {
    assert.equal(builder.length, 0, `${builder.name} still takes a packet type`);
  }
  const prompts = organizeLeadPrompt() + sectionsPrompt() + itemsOnlyPrompt();
  for (const gone of [/senior living/i, /memory care/i, /real-estate context/i, /HOA/, /MLS/]) {
    assert.doesNotMatch(prompts, gone, `vertical guidance survives in a live prompt: ${gone}`);
  }
  const src = readFileSync("src/lib/ai-prompts.ts", "utf8");
  assert.doesNotMatch(src, /TYPE_GUIDANCE/, "the per-type guidance map is still there");
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

test("nothing user-facing offers a packet type, and nothing branches on the stored one", () => {
  // The column stays for the 13 existing rows that carry a vertical value, and
  // duplicate still copies it — but no code reads it to decide anything, so an
  // old value cannot put a Sendset into a different mode.
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(p) && !/\.test\./.test(p) && !/ \d+\.[a-z]+$/.test(p)) files.push(p);
    }
  };
  walk("src");
  const code = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  // No picker, no labels, nothing asking for a type.
  assert.deepEqual(files.filter((f) => /Senior placement|Real estate|PACKET_TYPES|packetType/.test(code(f))), []);
  // The only remaining mentions of the column: the two creation paths writing
  // the default, and duplicate copying what a row already has. None of them
  // reads it to decide anything.
  const readers = files.filter((f) => /packet_type/.test(code(f)));
  assert.deepEqual(readers.sort(), [
    join("src", "app", "api", "ingest", "organize", "route.ts"),
    join("src", "app", "api", "packets", "[id]", "duplicate", "route.ts"),
    join("src", "app", "api", "packets", "route.ts"),
  ], "something still reads packet_type to decide behaviour");
  assert.match(code(join("src", "app", "api", "packets", "route.ts")), /packet_type: "general"/);
  assert.match(code(join("src", "app", "api", "ingest", "organize", "route.ts")), /p_packet_type: "general"/);
  // Duplicate carries the old value forward as data. That is inert: no branch
  // anywhere reads it, so a copy of a vertical Sendset is an ordinary Sendset.
  const dup = code(join("src", "app", "api", "packets", "[id]", "duplicate", "route.ts"));
  assert.match(dup, /packet_type: original\.packet_type \|\| "general"/);
  assert.doesNotMatch(dup, /if \([^)]*packet_type/, "duplicate branches on the old type");
  // Recipients never saw it, and still do not.
  for (const surface of ["src/app/p/[slug]/page.tsx", "src/app/p/[slug]/print/page.tsx",
                         "src/lib/email-render.ts", "src/lib/queries.ts"]) {
    assert.doesNotMatch(code(surface), /packet_type|packetType/, `${surface} exposes the legacy type`);
  }
});
