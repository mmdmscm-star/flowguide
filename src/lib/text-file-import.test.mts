import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readTextFile, rejectionFor, isSupportedTextFile, TextFileError, MAX_IMPORT_CHARS } from "./text-file-import.ts";

const codeOf = (p: string) =>
  readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const fileOf = (name: string, body: string) =>
  new File([body], name, { type: "text/plain" });

test("the three formats are accepted", () => {
  for (const n of ["a.csv", "a.tsv", "a.txt", "a.md", "a.markdown", "A.CSV"]) {
    assert.ok(isSupportedTextFile(n), `${n} rejected`);
  }
});

test("PDF and Word get their OWN sentence, not 'unsupported'", () => {
  // These are the two most likely next attempts. "We can't read PDFs yet" is a
  // different message from "that isn't a file type we know", and the difference
  // is what tells a professional whether to wait or to work around it.
  assert.match(rejectionFor("brochure.pdf", 100)!, /can’t read PDFs yet/);
  assert.match(rejectionFor("notes.docx", 100)!, /Word documents/);
  // A spreadsheet gets the actionable instruction rather than a refusal.
  assert.match(rejectionFor("list.xlsx", 100)!, /Save the sheet as CSV/);
  assert.match(rejectionFor("thing.zip", 100)!, /isn’t supported/);
});

test("an oversized file is refused before it is read", () => {
  assert.match(rejectionFor("big.csv", MAX_IMPORT_CHARS * 4 + 1)!, /too large/);
  assert.equal(rejectionFor("fine.csv", 1000), null);
});

test("a supported file returns its text", async () => {
  const text = await readTextFile(fileOf("list.csv", "Name,Price\nAlpha,100\nBeta,200"));
  assert.equal(text, "Name,Price\nAlpha,100\nBeta,200");
});

test("line endings are normalized and NOTHING ELSE is rewritten", async () => {
  // The text becomes the source of record. A source that was silently altered
  // cannot be reconciled against what the professional actually wrote.
  const text = await readTextFile(fileOf("a.txt", "one\r\ntwo\rthree\n  spaced  \t tabs\t"));
  assert.equal(text, "one\ntwo\nthree\n  spaced  \t tabs\t");
});

test("an empty file is a clear refusal, not an empty draft", async () => {
  await assert.rejects(() => readTextFile(fileOf("a.txt", "   \n\n  ")),
    (e: Error) => e instanceof TextFileError && /looks empty/.test(e.message));
});

test("a file over the character limit says the actual numbers", async () => {
  const big = "x".repeat(MAX_IMPORT_CHARS + 1);
  await assert.rejects(() => readTextFile(fileOf("a.txt", big)),
    (e: Error) => e instanceof TextFileError && /the limit is 200,000/.test(e.message));
});

test("a rejected type throws before any reading happens", async () => {
  await assert.rejects(() => readTextFile(fileOf("b.pdf", "%PDF-1.4 …")),
    (e: Error) => e instanceof TextFileError && /PDFs/.test(e.message));
});

// ---------------------------------------------------------------------------
// THE ARCHITECTURE
// ---------------------------------------------------------------------------

test("NO STORAGE, NO UPLOAD, NO SECOND SOURCE", () => {
  const lib = codeOf("src/lib/text-file-import.ts");
  const ui = codeOf("src/components/new/new-packet-workspace.tsx");
  for (const forbidden of [/FormData/, /storage/i, /supabase/i, /\bfetch\(.*upload/i]) {
    assert.doesNotMatch(lib + ui, forbidden, `the file is being sent somewhere: ${forbidden}`);
  }
  // The file's text must reach the SAME organize call a paste reaches.
  assert.match(ui, /rawText: source/, "the organize contract changed");
  assert.match(ui, /setRawText\(/, "the file text does not land in the shared box");
});

test("the text is shown before it is organized", () => {
  const ui = codeOf("src/components/new/new-packet-workspace.tsx");
  // handleFile must not organize. A professional sees what was read first —
  // a mangled encoding is visible rather than baked into a draft.
  const fn = /async function handleFile[\s\S]*?\n  \}/.exec(ui)?.[0] ?? "";
  assert.ok(fn, "handleFile is gone");
  assert.doesNotMatch(fn, /ingest\/organize|handleOrganize\(/, "the file is submitted without being shown");
});

test("adding a file APPENDS rather than destroying what is already typed", async () => {
  const ui = codeOf("src/components/new/new-packet-workspace.tsx");
  assert.match(ui, /prev\.trim\(\) \?/, "a file overwrites existing text");
});

test("one accept list, stated once", () => {
  const lib = codeOf("src/lib/text-file-import.ts");
  const ui = codeOf("src/components/new/new-packet-workspace.tsx");
  assert.match(ui, /accept=\{TEXT_FILE_ACCEPT\}/, "the picker has its own copy of the accept list");
  assert.match(lib, /export const TEXT_FILE_ACCEPT/);
});
