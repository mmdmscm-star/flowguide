// The EXAMPLES the creator flow shows, checked for domain residue.
//
// public-surface.test.mts guards what a stranger can read. It cannot see the
// signed-in side, which is how "e.g. Spring Lake Village" — a real senior
// living community — sat in the /new grouping field: an example nobody is
// looking at once the field has been used, offered to every professional
// before they type anything.
//
// Two reasons it may not come back. The noncompete keeps senior living out of
// what FlowGuide presents as its own; and a real business named in a suggestion
// is being lent to a product it never agreed to appear in. Invented names
// carry neither risk, and the demos already supply them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) tsxFiles(p, out);
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const SURFACES = [...tsxFiles("src/components"), ...tsxFiles("src/app")];

/** Real operators and the vocabulary of the vertical. Names first: each is a
 *  company that exists. Then the words that would identify the vertical even
 *  under an invented name. */
const FORBIDDEN = [
  "Spring Lake Village", "Brookdale", "Atria", "AlmaVia", "Drake Terrace",
  "Primrose", "Oakmont", "Sunrise Senior", "Belmont Village", "The Bristal",
  "The Variel", "Fountaingrove",
  "senior living", "assisted living", "memory care", "skilled nursing",
];

/** What the professional is SHOWN as a suggestion: placeholder text, and any
 *  "e.g. …" wherever it appears in the markup. Not every string in the file —
 *  a variable named for the vertical is a different problem, and banning the
 *  words everywhere would forbid the parsing code from naming what it parses. */
function examplesIn(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/placeholder=(?:"([^"]*)"|\{"([^"]*)"\})/g)) {
    out.push(m[1] ?? m[2] ?? "");
  }
  for (const m of src.matchAll(/e\.g\.\s*([^"'<{}\n]{0,60})/g)) out.push(m[1]);
  return out;
}

test("no creator-facing example names a real senior living business", () => {
  const offences: string[] = [];
  for (const file of SURFACES) {
    const examples = examplesIn(readFileSync(join(ROOT, file), "utf8"));
    for (const example of examples) {
      for (const word of FORBIDDEN) {
        if (example.toLowerCase().includes(word.toLowerCase())) {
          offences.push(`${file}: "${example.trim()}" says "${word}"`);
        }
      }
    }
  }
  assert.deepEqual(offences, [], `creator-facing examples carry domain residue:\n${offences.join("\n")}`);
});

test("the grouping field still offers an example, and it is the invented one", () => {
  // ABSENCE WOULD PASS THE CHECK ABOVE. Deleting the placeholder, or renaming
  // the attribute so the scan no longer finds it, satisfies "no forbidden
  // word" while removing the help the field was given.
  const src = readFileSync(join(ROOT, "src/components/new/new-packet-workspace.tsx"), "utf8");
  const examples = examplesIn(src).filter((e) => e.startsWith("e.g."));
  assert.deepEqual(examples, ["e.g. Harbor House Hotel"],
    "the grouping field no longer suggests the invented example");
  assert.ok(readFileSync(join(ROOT, "src/lib/demo-harbor-house.ts"), "utf8").includes("Harbor House Hotel"),
    "the example is no longer a business the product itself invented");
});
