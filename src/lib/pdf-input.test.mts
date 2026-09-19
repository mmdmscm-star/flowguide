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
// WHAT THE SERVER VERIFIES, AND WHAT IT ONLY RECORDS AS REPORTED
//
// The PDF never reaches the server. So the document fields — name, size, file
// SHA-256, page count, extractor — are CLIENT-REPORTED: bounded and
// well-formed, but not provable. What the server verifies independently is the
// text it received: every page span must hash to the page it claims to be.
// ---------------------------------------------------------------------------

const BELL = String.fromCharCode(7);
const PAGE_EMOJI = String.fromCodePoint(0x1F4C4);         // one character, two UTF-16 units
const HALF_EMOJI = String.fromCharCode(0xD83D);           // a surrogate with no partner
const blankPages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ page: i + 1, chars: 0, sha256: sha(""), start: null, end: null }));

/** A correct manifest for a two-page PDF inside `source`. */
function fixture() {
  const d = doc("prices.pdf", ["Harbor House\t$2,400", ""]);
  const source = `Intro.\n\n${d.contributed}`;
  return { source, manifest: buildManifest(source, [d]) as unknown as Record<string, unknown>[] };
}
const refusedAs = (raw: unknown, source: string, reason: "malformed" | "mismatch", what: string) => {
  const v = verifySourceDocuments(raw, source);
  assert.ok(v && !v.ok, `${what} was accepted`);
  assert.equal(v && !v.ok && v.reason, reason, `${what} was refused for the wrong reason`);
  // Refused means NOTHING is stored: there is no partial or trimmed result.
  assert.ok(!("documents" in (v as object)), `${what} returned documents alongside a refusal`);
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mut = (m: Record<string, any>[]) => void;
const mutated = (f: Mut) => { const { source, manifest } = fixture(); const m = structuredClone(manifest); f(m); return { source, m }; };

test("a correct manifest is accepted and stored EXACTLY as sent — nothing added, nothing trimmed", () => {
  const { source, manifest } = fixture();
  const v = verifySourceDocuments(manifest, source);
  assert.ok(v && v.ok);
  assert.deepEqual(v && v.ok && v.documents, manifest);
  assert.equal(verifySourceDocuments(undefined, source), null, "no manifest is not an error");
  assert.equal(verifySourceDocuments(null, source), null);
});

test("THE FILE HASH IS REPORTED, NOT ATTESTED: the server cannot check it, and does not claim to", () => {
  // Any well-formed hash is accepted with correct spans, because the server
  // never holds the file. A test that pretended otherwise would be the lie.
  const { source, m } = mutated((m) => { m[0].sha256 = "f".repeat(64); m[0].name = "not-what-was-read.pdf"; m[0].bytes = 7; });
  assert.ok(verifySourceDocuments(m, source)?.ok, "reported fields are being treated as checkable");
  // ...while the SPANS are checked against the text actually received.
  const { m: forged } = mutated((m) => { m[0].pages[0].sha256 = sha("Harbor House\t$9,999"); });
  refusedAs(forged, source, "mismatch", "a span whose text is not the reported page");
  const src = codeOf("src/lib/source-documents.ts") + raw("src/lib/source-documents.ts");
  assert.match(src, /CLIENT-REPORTED/);
  assert.match(src, /does NOT prove which file/);
});

test("ONE span that does not match the text received refuses the whole request", () => {
  const cases: [string, Mut][] = [
    ["a shifted span", (m) => { m[0].pages[0].start += 1; m[0].pages[0].end += 1; }],
    ["a span past the end of the source", (m) => { m[0].pages[0].end = 10_000; m[0].pages[0].start = 10_000 - m[0].pages[0].chars; }],
    ["a blank page with a made-up hash", (m) => { m[0].pages[1].sha256 = "b".repeat(64); }],
  ];
  for (const [what, f] of cases) { const { source, m } = mutated(f); refusedAs(m, source, "mismatch", what); }
});

test("THE BOUNDARY: anything outside the exact shape refuses the request, never trimmed to fit", () => {
  const cases: [string, Mut | unknown][] = [
    ["not an array", { documents: [] }],
    ["an empty list", []],
    ["21 documents", (m) => { while (m.length < 21) m.push(structuredClone(m[0])); }],
    ["an extra document field", (m) => { m[0].text = "the whole PDF"; }],
    ["a missing document field", (m) => { delete m[0].extractor; }],
    ["an extra page field", (m) => { m[0].pages[0].text = "Harbor House\t$2,400"; }],
    ["a __proto__ key", (m) => { m[0] = JSON.parse(JSON.stringify(m[0]).replace("{", '{"__proto__":{"x":1},')); }],
    ["another kind", (m) => { m[0].kind = "docx"; }],
    ["an empty name", (m) => { m[0].name = ""; }],
    ["a 256-character name", (m) => { m[0].name = "x".repeat(252) + ".pdf"; }],
    ["a control character in the name", (m) => { m[0].name = `a${BELL}.pdf`; }],
    ["half an emoji in the name", (m) => { m[0].name = `a${HALF_EMOJI}.pdf`; }],
    ["a size of zero", (m) => { m[0].bytes = 0; }],
    ["a size over 20 MB", (m) => { m[0].bytes = 20 * 1024 * 1024 + 1; }],
    ["a fractional size", (m) => { m[0].bytes = 10.5; }],
    ["an upper-case hash", (m) => { m[0].sha256 = "A".repeat(64); }],
    ["a short hash", (m) => { m[0].sha256 = "a".repeat(63); }],
    ["a page count of 0", (m) => { m[0].pageCount = 0; m[0].pages = []; }],
    ["a page count of 51", (m) => { m[0].pageCount = 51; m[0].pages = blankPages(51); }],
    ["page entries disagreeing with the count", (m) => { m[0].pageCount = 3; }],
    ["pages out of order", (m) => { m[0].pages[0].page = 2; m[0].pages[1].page = 1; }],
    ["an unknown extractor", (m) => { m[0].extractor = "my-own-reader"; }],
    ["an unbounded extractor", (m) => { m[0].extractor = `pdfjs-dist@6.3.289+sendset-pdf-layout@1${"9".repeat(200)}`; }],
    ["a negative start", (m) => { m[0].pages[0].start = -1; }],
    ["half a span", (m) => { m[0].pages[0].end = null; }],
    ["a span longer than its page", (m) => { m[0].pages[0].end += 1; }],
    ["a span on a blank page", (m) => { m[0].pages[1].start = 0; m[0].pages[1].end = 0; }],
    ["a string offset", (m) => { m[0].pages[0].start = String(m[0].pages[0].start); }],
    // An EDITED page has no span, so nothing but the shape rules guards these.
    ["a negative character count on an edited page", (m) => { Object.assign(m[0].pages[0], { start: null, end: null, chars: -1 }); }],
    ["a fractional character count on an edited page", (m) => { Object.assign(m[0].pages[0], { start: null, end: null, chars: 2.5 }); }],
    ["an upper-case page hash on an edited page", (m) => { Object.assign(m[0].pages[0], { start: null, end: null, sha256: "A".repeat(64) }); }],
    ["a missing page hash on an edited page", (m) => { Object.assign(m[0].pages[0], { start: null, end: null, sha256: null }); }],
  ];
  for (const [what, f] of cases) {
    const { source, m } = typeof f === "function" ? mutated(f as Mut) : { source: fixture().source, m: f };
    refusedAs(m, source, "malformed", what);
  }
});

test("an OVERSIZED manifest is refused by its size, before its shape is even read", () => {
  const { source } = fixture();
  const huge = [{ kind: "pdf", pad: "y".repeat(300 * 1024) }];
  const v = verifySourceDocuments(huge, source);
  assert.ok(v && !v.ok && v.reason === "malformed" && v.message === "manifest too large");
});

test("...and the boundaries themselves are ACCEPTED: 20 documents, 50 pages, a 255-character name", () => {
  const { source, m } = mutated((m) => {
    m[0].name = PAGE_EMOJI.repeat(251) + ".pdf";            // 255 characters, 506 UTF-16 units
    m[1] = structuredClone(m[0]);
    m[1].pageCount = 50;
    m[1].pages = blankPages(50);
    while (m.length < 20) m.push(structuredClone(m[1]));
  });
  assert.ok(verifySourceDocuments(m, source)?.ok, "a manifest at the limits was refused");
});

test("the browser prepares a name the server will take: no control characters, cut at 255 characters", () => {
  const d = doc(BELL + PAGE_EMOJI.repeat(300) + ".pdf", ["Harbor House\t$2,400"]);
  const [m] = buildManifest(d.contributed, [d]);
  assert.equal([...m.name].length, 255);
  assert.ok(!m.name.includes(BELL));
  assert.ok(verifySourceDocuments([m], d.contributed)?.ok, "the browser's own manifest was refused");
});

test("organize checks the manifest BEFORE it creates anything, refuses both failures, and stamps what it checked", () => {
  const route = codeOf("src/app/api/ingest/organize/route.ts");
  const check = route.indexOf("verifySourceDocuments(body.sourceDocuments, rawText)");
  assert.ok(check > 0 && check < route.indexOf('rpc("create_organize_run"'), "a run can be created before its provenance is checked");
  const refusal = route.slice(check, route.indexOf('rpc("create_organize_run"'));
  assert.match(refusal, /if \(documents && !documents\.ok\) \{\s*return NextResponse\.json\(/);
  assert.match(refusal, /documents\.reason === "mismatch"[\s\S]*error: "provenance_mismatch"[\s\S]*error: "invalid_source_documents"[\s\S]*status: 400/);
  assert.match(route, /if \(documents\?\.ok\) stamp\.source_documents = documents\.documents;/);
});

test("0060 says what is reported and what is verified — and never that the file hash proves anything", () => {
  const sql = raw("supabase/migrations/0060_ingestion_source_documents.sql");
  assert.doesNotMatch(sql, /proves it is the same/i);
  assert.match(sql, /CLIENT-REPORTED/);
  assert.match(sql, /VERIFIED BY THE SERVER/);
});
