import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { missingFrom, missingFromChunk, completenessWarnings, siteKey } from "./source-completeness.ts";

const SRC = `Aegis Living Corte Madera
Type: AL, MC
 Community Phone: (415) 927-4200
 Contact Name: Leslye Peterson
 Contact Title: Marketing Director
 Cell Phone: (781) 635-6032
 Email Address: Leslye.Peterson@aegisliving.com
 Existing Website: https://www.aegisliving.com/locations/aegis-living-corte-madera-ca
Image 1: https://res.cloudinary.com/dkmsj5vdx/image/upload/v1782242937/98380Callig_nyydbp.jpg`;

test("THE REAL LOSS IS REPORTED — the community's main line", () => {
  // What the importer actually produced: the person's cell kept, the
  // community's own number dropped.
  const rec = { contacts: [{ name: "Leslye Peterson", role: "Marketing Director",
    phone: "(781) 635-6032", email: "Leslye.Peterson@aegisliving.com" }],
    links: [{ url: "https://aegisliving.com/locations/aegis-living-corte-madera-ca/" }] };
  const m = missingFrom(rec, SRC);
  assert.deepEqual(m.phones, ["(415) 927-4200"], "the dropped community line was not reported");
  assert.deepEqual(m.emails, [], "an email was wrongly reported missing");
  assert.deepEqual(m.websites, [], "a canonicalised website was wrongly reported missing");
  assert.equal(m.ok, false);
});

test("KEEPING BOTH PHONES SATISFIES THE CHECK", () => {
  const rec = { contacts: [
    { role: "Community", phone: "(415) 927-4200" },
    { name: "Leslye Peterson", role: "Marketing Director", phone: "(781) 635-6032", email: "Leslye.Peterson@aegisliving.com" }],
    links: [{ url: "https://www.aegisliving.com/locations/aegis-living-corte-madera-ca" }] };
  assert.equal(missingFrom(rec, SRC).ok, true, `still reported: ${JSON.stringify(missingFrom(rec, SRC))}`);
});

test("A CANONICALISED URL IS NOT A LOSS", () => {
  // Both false positives from the real run: www dropped, http upgraded to
  // https, trailing slash added.
  assert.equal(siteKey("https://www.aegisliving.com/x"), siteKey("https://aegisliving.com/x/"));
  assert.equal(siteKey("http://sonomaretirement.com"), siteKey("https://sonomaretirement.com/"));
  const rec = { links: [{ url: "https://sonomaretirement.com/" }] };
  assert.deepEqual(missingFrom(rec, "Existing Website: http://sonomaretirement.com").websites, []);
});

test("A GENUINELY ABSENT WEBSITE IS REPORTED", () => {
  const m = missingFrom({ links: [] }, "Existing Website: https://realsite.example.com/x");
  assert.deepEqual(m.websites, ["https://realsite.example.com/x"]);
});

test("IMAGE URLS ARE NOT TREATED AS WEBSITES", () => {
  // Reporting every photo URL would bury the one website that matters.
  assert.deepEqual(missingFrom({ links: [] }, "Image 1: https://res.cloudinary.com/x/a.jpg").websites, []);
  assert.deepEqual(missingFrom({ links: [] }, "Photo: https://cdn.example.com/a.jpeg").websites, []);
});

test("ONLY LABELLED PHONES COUNT — an image version is not a number", () => {
  // "v1782242937" is ten digits and was reported as a lost phone by a digit
  // scan. Label-anchoring is why this no longer happens.
  assert.deepEqual(missingFrom({}, "Image 1: https://res.cloudinary.com/x/upload/v1782242937/a.jpg").phones, []);
  assert.deepEqual(missingFrom({}, "Community Phone: (707) 791-4787").phones, ["(707) 791-4787"]);
});

test("emails are still checked, and matched case-insensitively", () => {
  assert.deepEqual(missingFrom({ contacts: [{ email: "leslye.peterson@aegisliving.com" }] }, SRC).emails, []);
  assert.deepEqual(missingFrom({}, "Email Address: a@b.com").emails, ["a@b.com"]);
});

test("the warnings say what did not survive", () => {
  const w = completenessWarnings({ contacts: [] }, "Community Phone: (415) 927-4200");
  assert.deepEqual(w, ["phone not carried over: (415) 927-4200"]);
});

test("materialisation surfaces completeness, and does not block on it", () => {
  const r = readFileSync("src/app/api/library/import/[runId]/proposals/route.ts", "utf8");
  assert.match(r, /missingFromChunk\(siblings, sourceTextFor\(/, "completeness is never computed, or is not chunk-scoped");
  assert.match(r, /completenessWarnings: missing/, "it is computed but never stored");
  const save = readFileSync("src/app/api/library/import/[runId]/save/route.ts", "utf8");
  assert.ok(!/completenessWarnings/.test(save), "an omission BLOCKS a save — it should surface, not block");
});

test("the prompts carry the two-phones rule", () => {
  const src = readFileSync("src/lib/ai-prompts.ts", "utf8");
  assert.match(src, /A community's MAIN phone and a named person's DIRECT phone are different facts/);
  assert.match(src, /do NOT invent one/, "the N/A case is not covered");
  assert.equal((src.match(/\$\{CONTACTS_RULE\}/g) ?? []).length, 3);
});

test("A NEIGHBOUR'S FACTS ARE NOT REPORTED AS THIS RECORD'S LOSS", () => {
  // The bug this exists for: a chunk holds several communities, so auditing one
  // record against the whole chunk reported its neighbours' phones and emails
  // as missing. Aegis Living Corte Madera was warned about Solano Life House's
  // email. A fact is lost only when NO record from the chunk carries it.
  const chunk = `Aegis Living Corte Madera
 Community Phone: (415) 927-4200
 Email Address: Leslye.Peterson@aegisliving.com
Solano Life House
 Community Phone: (707) 678-1652
 Email Address: Mary@solanolifehouse.com`;
  const aegis = { title: "Aegis Living Corte Madera",
    contacts: [{ role: "Community", phone: "(415) 927-4200", email: "Leslye.Peterson@aegisliving.com" }] };
  const solano = { title: "Solano Life House",
    contacts: [{ role: "Community", phone: "(707) 678-1652", email: "Mary@solanolifehouse.com" }] };

  // Record-scoped — the WRONG unit — blames each for the other's facts.
  assert.ok(!missingFrom(aegis, chunk).ok, "the record-scoped check is no longer wrong (update this test)");
  // Chunk-scoped — the right unit — reports nothing, because between them the
  // records carry everything the chunk states.
  const m = missingFromChunk([aegis, solano], chunk);
  assert.deepEqual(m.phones, [], `a neighbour's phone was blamed: ${JSON.stringify(m.phones)}`);
  assert.deepEqual(m.emails, [], `a neighbour's email was blamed: ${JSON.stringify(m.emails)}`);
  assert.equal(m.ok, true);
});

test("a fact NO record in the chunk carries is still reported", () => {
  const chunk = `A Place
 Community Phone: (415) 927-4200
 Cell Phone: (781) 635-6032`;
  const only = { title: "A Place", contacts: [{ role: "Community", phone: "(415) 927-4200" }] };
  assert.deepEqual(missingFromChunk([only], chunk).phones, ["(781) 635-6032"],
    "a genuinely dropped second phone was not reported");
});
