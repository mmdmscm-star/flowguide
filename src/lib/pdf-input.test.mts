// PDF INPUT ON NEW SENDSET — everything around the extractor.
//
//   * the file never leaves the device, and pdf.js is loaded only when needed;
//   * PDFs enter by the one way in, sized up front, several at a time, in order;
//   * the page manifest records only what it can prove, and the server re-checks
//     every span against the text it actually received;
//   * nothing about a PDF creates a second creation path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, type ReadDocument } from "./pdf-manifest.ts";
import { verifySourceDocuments } from "./source-documents.ts";
import { planBundle, DOCUMENT_ACCEPT, looksLikePdf } from "./source-bundle.ts";
import { MAX_PDF_BYTES } from "./pdf-extract.ts";

const raw = (p: string) => readFileSync(p, "utf8");
const codeOf = (p: string) =>
  raw(p).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const WORKSPACE = "src/components/new/new-packet-workspace.tsx";

function doc(name: string, pageTexts: string[]): ReadDocument {
  const pages = pageTexts.map((text, i) => ({ page: i + 1, text, chars: text.length, sha256: sha(text) }));
  return {
    name, bytes: 1000, sha256: "a".repeat(64), pageCount: pages.length,
    extractor: "pdfjs-dist@6.3.289+sendset-pdf-layout@1", pages,
    contributed: pageTexts.filter(Boolean).join("\n\n"),
  };
}

// ---------------------------------------------------------------------------
// THE FILE STAYS ON THE DEVICE
// ---------------------------------------------------------------------------

test("pdf.js is loaded LAZILY, from one place, and never statically", () => {
  const importers = [...filesUnder("src/app"), ...filesUnder("src/components"), ...filesUnder("src/lib")]
    .filter((f) => !/\.test\./.test(f))
    .filter((f) => /from ["']pdfjs-dist|import\(["']pdfjs-dist/.test(codeOf(f)));
  assert.deepEqual(importers, ["src/lib/pdf-browser.ts"]);
  const browser = codeOf("src/lib/pdf-browser.ts");
  assert.match(browser, /await import\("pdfjs-dist"\)/, "pdf.js is imported eagerly");
  assert.doesNotMatch(browser, /^import .*pdfjs-dist/m, "pdf.js is imported eagerly");
  // Its worker and character maps are served from the version that was installed.
  assert.match(browser, /workerSrc = "\/pdfjs\/pdf\.worker\.min\.mjs"/);
  assert.match(browser, /cMapUrl: "\/pdfjs\/cmaps\/"/);
  const pkg = JSON.parse(raw("package.json"));
  assert.equal(pkg.scripts.prebuild, "node scripts/copy-pdfjs-assets.mjs");
  assert.equal(pkg.scripts.predev, "node scripts/copy-pdfjs-assets.mjs");
  assert.match(raw(".gitignore"), /^\/public\/pdfjs\/$/m, "the copied assets would be committed and go stale");
});

test("nothing in a PDF is ever evaluated, and fonts are never loaded", () => {
  const extract = codeOf("src/lib/pdf-extract.ts");
  assert.match(extract, /isEvalSupported: false/);
  assert.match(extract, /disableFontFace: true/);
  assert.match(extract, /enableXfa: false/);
  // Pinned at a version long past CVE-2024-4367 (fixed in 4.2.67).
  const version = JSON.parse(raw("package.json")).dependencies["pdfjs-dist"];
  assert.match(version, /^\d+\.\d+\.\d+$/, "pdf.js is not pinned exactly");
  const [major, minor] = version.split(".").map(Number);
  assert.ok(major > 4 || (major === 4 && minor >= 2), `pdf.js ${version} predates the CVE-2024-4367 fix`);
});

test("THE PDF IS NEVER UPLOADED: its path reads in the browser and posts nothing", () => {
  const ui = codeOf(WORKSPACE);
  const read = ui.slice(ui.indexOf("async function readOnePdf"), ui.indexOf("function removeDoc"));
  assert.match(read, /readPdfInBrowser\(file, /);
  assert.doesNotMatch(read, /fetch\(|FormData|source-image|transcribe/, "the PDF path sends the file somewhere");
  const browser = codeOf("src/lib/pdf-browser.ts");
  assert.doesNotMatch(browser, /fetch\(|FormData|XMLHttpRequest|sendBeacon/, "the reader sends the file somewhere");
  // The only upload in the whole workspace is still the picture evidence.
  assert.equal((ui.match(/fetch\("\/api\/ingest\/source-image"/g) ?? []).length, 1);
});

test("a PDF feeds the SAME organize call as everything else — no second creation path", () => {
  const ui = codeOf(WORKSPACE);
  assert.equal((ui.match(/fetch\("\/api\/ingest\/organize"/g) ?? []).length, 1);
  assert.match(ui, /rawText: source/);
  // The manifest rides along; the page TEXT does not travel twice.
  assert.match(ui, /sourceDocuments: buildManifest\(source, docsForManifest\)/);
  assert.match(ui, /append\(contributed\)/, "a PDF's text does not land in the shared box");
});

test("a PDF blocks organizing while it is being read", () => {
  const ui = codeOf(WORKSPACE);
  const org = ui.slice(ui.indexOf("async function handleOrganize"));
  assert.match(org, /is still being read\. Wait for it to finish before organizing\./);
  assert.ok(org.indexOf("readingDoc || readingPdf") < org.indexOf('fetch("/api/ingest/organize"'));
  assert.match(ui, /const ready = [^;]*!readingPdf/);
});

// ---------------------------------------------------------------------------
// THE ONE WAY IN
// ---------------------------------------------------------------------------

const file = (name: string, size = 100, type = "") => ({ name, size, type }) as unknown as File;

test("PDFs are accepted by name or by type, several at a time, in the order given", () => {
  const plan = planBundle([file("a.pdf"), file("b.PDF"), file("scan", 10, "application/pdf")]);
  assert.ok(plan.ok);
  assert.deepEqual(plan.ok && plan.items.map((i) => [i.kind, i.file.name]),
    [["pdf", "a.pdf"], ["pdf", "b.PDF"], ["pdf", "scan"]]);
  assert.ok(looksLikePdf(file("x.pdf")) && !looksLikePdf(file("x.pdfx")));
  assert.match(DOCUMENT_ACCEPT, /\.pdf,application\/pdf$/);
});

test("PDFs mix with pictures and one spreadsheet, and the spreadsheet rule is unchanged", () => {
  const plan = planBundle([file("page.jpg", 10, "image/jpeg"), file("prices.pdf"), file("rates.csv")]);
  assert.ok(plan.ok);
  assert.deepEqual(plan.ok && plan.items.map((i) => i.kind), ["image", "pdf", "text"]);
  assert.equal(planBundle([file("a.csv"), file("b.pdf"), file("c.csv")]).ok, false, "two spreadsheets slipped through");
});

test("an oversized PDF refuses the WHOLE batch before anything is read", () => {
  const plan = planBundle([file("small.pdf", 1000), file("huge.pdf", MAX_PDF_BYTES + 1)]);
  assert.equal(plan.ok, false);
  assert.match(!plan.ok ? plan.message : "", /^huge\.pdf: This PDF is 20\.0 MB — the limit is 20 MB\./);
});

// ---------------------------------------------------------------------------
// THE MANIFEST: ONLY WHAT IT CAN PROVE
// ---------------------------------------------------------------------------

test("an untouched PDF maps every page exactly, and blank pages point nowhere", () => {
  const d = doc("prices.pdf", ["Harbor House\t$2,400", "", "The Loft\t$1,950"]);
  const source = `My notes first.\n\n${d.contributed}\n\nAnd a closing line.`;
  const [m] = buildManifest(source, [d]);
  assert.deepEqual(m.pages.map((p) => source.slice(p.start ?? 0, p.end ?? 0)), ["Harbor House\t$2,400", "", "The Loft\t$1,950"]);
  assert.equal(m.pages[1].start, null);
  assert.equal(m.pageCount, 3);
  // Never the page text itself: that already IS the source.
  assert.ok(m.pages.every((p) => !("text" in p)));
  assert.ok(!("contributed" in m));
});

test("a page the professional EDITED gets no span, and the others keep theirs", () => {
  const d = doc("prices.pdf", ["Harbor House\t$2,400", "The Loft\t$1,950"]);
  const source = "Harbor House\t$2,500\n\nThe Loft\t$1,950";   // they fixed page one
  const [m] = buildManifest(source, [d]);
  assert.equal(m.pages[0].start, null, "a span points at text the page never said");
  assert.equal(source.slice(m.pages[1].start!, m.pages[1].end!), "The Loft\t$1,950");
});

test("a page whose text appears TWICE is not guessed at — it gets no span", () => {
  const d = doc("prices.pdf", ["Call before Friday.", "The Loft\t$1,950"]);
  // The block was edited (so it is not intact), and page one's text now also
  // appears inside the professional's own sentence.
  const source = "Call before Friday.\n\nCall before Friday. Really.\n\nThe Loft\t$1,950";
  const [m] = buildManifest(source, [d]);
  assert.equal(m.pages[0].start, null, "a span was guessed between two matches");
  assert.equal(source.slice(m.pages[1].start!, m.pages[1].end!), "The Loft\t$1,950");
});

test("a PDF whose whole text is in the box TWICE is not pinned to either copy", () => {
  const d = doc("prices.pdf", ["Harbor House\t$2,400", "The Loft\t$1,950"]);
  const source = `${d.contributed}\n\n${d.contributed}`;
  const [m] = buildManifest(source, [d]);
  assert.deepEqual(m.pages.map((p) => p.start), [null, null], "a span was pinned to one copy of two");
});

test("two PDFs are mapped in order, each to its own text", () => {
  const a = doc("a.pdf", ["Alpha page"]);
  const b = doc("b.pdf", ["Beta page"]);
  const source = `${a.contributed}\n\n${b.contributed}`;
  const [ma, mb] = buildManifest(source, [a, b]);
  assert.equal(source.slice(ma.pages[0].start!, ma.pages[0].end!), "Alpha page");
  assert.equal(source.slice(mb.pages[0].start!, mb.pages[0].end!), "Beta page");
});

// ---------------------------------------------------------------------------
// THE SERVER BELIEVES NOTHING IT CANNOT CHECK
// ---------------------------------------------------------------------------

test("a manifest whose spans hash to their pages is accepted — and only its known fields are kept", () => {
  const d = doc("prices.pdf", ["Harbor House\t$2,400", ""]);
  const source = `Intro.\n\n${d.contributed}`;
  const manifest = buildManifest(source, [d]).map((m) => ({ ...m, pages: m.pages.map((p) => ({ ...p, text: "SMUGGLED" })), extra: 1 }));
  const v = verifySourceDocuments(manifest, source);
  assert.ok(v && v.ok);
  const stored = JSON.stringify(v && v.ok ? v.documents : null);
  assert.doesNotMatch(stored, /SMUGGLED|"extra"/, "fields the browser added reached the database");
});

test("ONE span that does not match its page refuses the whole request", () => {
  const d = doc("prices.pdf", ["Harbor House\t$2,400", "The Loft\t$1,950"]);
  const source = d.contributed;
  const good = buildManifest(source, [d]);
  const shifted = structuredClone(good);
  shifted[0].pages[1].start! += 1; shifted[0].pages[1].end! += 1;
  const forged = structuredClone(good);
  forged[0].pages[0].sha256 = sha("Harbor House\t$9,999");
  const beyond = structuredClone(good);
  beyond[0].pages[1].end = source.length + 5; beyond[0].pages[1].start = source.length + 5 - beyond[0].pages[1].chars;
  for (const [what, m] of [["a shifted span", shifted], ["a forged hash", forged], ["a span past the end", beyond]] as const) {
    const v = verifySourceDocuments(m, source);
    assert.ok(v && !v.ok, `${what} was accepted`);
  }
  assert.equal(verifySourceDocuments(undefined, source), null, "no manifest is not an error");
  assert.ok(!(verifySourceDocuments({}, source) as { ok: boolean }).ok);
});

test("organize checks the manifest BEFORE it creates anything, and stamps what it checked", () => {
  const route = codeOf("src/app/api/ingest/organize/route.ts");
  const check = route.indexOf("verifySourceDocuments(body.sourceDocuments, rawText)");
  assert.ok(check > 0 && check < route.indexOf('rpc("create_organize_run"'), "a run can be created before its provenance is checked");
  assert.match(route, /if \(documents && !documents\.ok\) \{[\s\S]{0,200}error: "provenance_mismatch"/);
  assert.match(route, /if \(documents\?\.ok\) stamp\.source_documents = documents\.documents;/);
});
