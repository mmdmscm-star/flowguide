// WHAT WE INSTRUCT A MODEL TO WRITE IS A PUBLIC SURFACE.
//
// An ice cream shop's phone number reached a recipient's page labelled
// "Community". The word was not in the source and no one typed it: the import
// prompt ORDERED it.
//
//     Emit the community's own number … with role "Community" and NO name.
//
// That rule was written against a 65-community senior-living import, and it
// applied to everything thereafter. Two separate defects, and only one of them
// is vocabulary:
//
//   1. POSITIONING. The product is horizontal and its public surfaces must not
//      read as senior living. A prompt is a public surface at one remove — its
//      words become the model's words, and the model's words reach a client.
//   2. INVENTION. ITEM_FIELDS already says role is emitted "only if stated".
//      CONTACTS_RULE overrode it and told the model to add a word the source
//      never contained — the exact failure this whole layer exists to prevent,
//      written into the instructions rather than committed by the model.
//
// So the check is over the SET of prompt-bearing files, derived rather than
// listed, because the next prompt will be written in whatever vocabulary its
// author's current test data happens to use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\./.test(p) && !/ \d+\.[a-z]+$/.test(p)) acc.push(p);
  }
  return acc;
}

/** Source with comments removed. A comment may name the incident — that is
 *  history worth keeping — but only code reaches a model. */
const code = (p: string) => readFileSync(p, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");

/** Files that hold text a model is given. Derived: a new one is in scope on
 *  the day it is written. */
const promptFiles = () => walk("src").filter((f) => {
  const s = code(f);
  return /_RULE\s*=\s*`|_PROMPT\s*=\s*`|_FIELDS\s*=\s*`|_SCHEMA\s*=\s*`|role:\s*"system"/.test(s);
});

/** Vocabulary that belongs to ONE vertical. Not a ban on the words existing in
 *  the world — a ban on this product telling a model to use them. */
const VERTICAL = /\b(communit(y|ies)|residents?|senior living|assisted living|memory care|care type|care home|respite care|move-in fee)\b/i;

test("the prompt-bearing files are found, not listed", () => {
  const files = promptFiles();
  assert.ok(files.length >= 3, `only ${files.length} prompt files found — has the detector stopped working?`);
  assert.ok(files.includes(join("src", "lib", "ai-prompts.ts")), "the main import prompt is not in scope");
});

test("NO PROMPT TELLS A MODEL TO USE ONE VERTICAL'S VOCABULARY", () => {
  const offenders: string[] = [];
  for (const f of promptFiles()) {
    for (const line of code(f).split("\n")) {
      const m = line.match(VERTICAL);
      if (m) offenders.push(`${f}: …${line.trim().slice(0, 90)}…`);
    }
  }
  assert.deepEqual(offenders, [],
    `a prompt carries one vertical's vocabulary into every Sendset:\n  ${offenders.join("\n  ")}`);
});

test("THE DETECTOR CATCHES THE REAL ONE — checked before its silence is believed", () => {
  // It reports success by finding nothing, which is indistinguishable from
  // being unable to find anything. So it is shown the rule as it actually
  // shipped, and the shapes it must not object to.
  const shipped = `const CONTACTS_RULE = \`Emit the community's own number ("Community Phone") as its own contact with role "Community" and NO name.\`;`;
  assert.ok(VERTICAL.test(shipped), "the detector misses the rule that produced the defect");
  for (const innocent of [
    'const X_RULE = `Emit the item\'s own number ("Phone", "Main", "Office") with NO name.`;',
    "const Y_PROMPT = `Copy every price EXACTLY as the source writes it.`;",
    "// a real 65-item import lost one of two phone numbers",
  ]) {
    assert.ok(!VERTICAL.test(innocent.replace(/\/\/.*$/, "")), `false positive: ${innocent}`);
  }
});

test("AND THE RULE NO LONGER OVERRIDES 'only if stated'", () => {
  // The vocabulary is half of it. The other half is that a prompt told the
  // model to ADD a word the source did not contain, while another rule in the
  // same prompt said roles are emitted only when the source states one.
  const p = code("src/lib/ai-prompts.ts");
  assert.match(p, /role \(only if stated\)/, "ITEM_FIELDS stopped requiring a stated role");
  assert.match(p, /with a role ONLY if the source states one/,
    "the contacts rule no longer defers to the source for the role");
  assert.ok(!/role "[A-Z]/.test(p), "a prompt still hands the model a literal role to write");
});

test("the distinction the rule exists for is intact", () => {
  // It was written because a real import lost one of two phone numbers 43 times
  // out of 65. Neutralising the wording must not lose the rule.
  const p = code("src/lib/ai-prompts.ts");
  assert.match(p, /different facts — keep BOTH/);
  assert.match(p, /Never drop one phone because another is present/);
  assert.match(p, /never move a person's direct number onto the item's own contact/);
  assert.match(p, /do NOT invent one/, "the no-invented-person rule is gone");
});
