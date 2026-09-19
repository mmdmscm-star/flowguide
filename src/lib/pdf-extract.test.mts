// PDF v1 — does what a PDF says survive being read, in the right order?
//
// Every fixture here is a REAL PDF, built with pdf-lib and read by the real
// pdf.js, so what is tested is what runs in the browser. pdf-lib matters for a
// reason beyond convenience: it controls not only WHERE text sits but the ORDER
// the file draws it in, which is what lets these tests reproduce the orderings
// real producers write — a price table drawn column by column, two prose
// columns drawn line across line — and prove the output does not depend on it.
//
// The rule these defend: a value is never silently attached to the wrong
// thing. Where the reading order cannot be established, the whole PDF is
// refused, by name and by page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts, degrees, pushGraphicsState, popGraphicsState, setTextRenderingMode,
  TextRenderingMode, beginText, endText, setFontAndSize, moveText, showText, type PDFFont, type PDFPage } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractPdf, MAX_PDF_BYTES, MAX_PDF_PAGES, pageList, type PdfResult } from "./pdf-extract.ts";
import { layoutPage, type PdfTextRun } from "./pdf-layout.ts";
import { detectSourceRecords } from "./segmentation.ts";

const CMAPS = "node_modules/pdfjs-dist/cmaps/";
const read = (bytes: Uint8Array, opts: { remainingChars?: number; timeoutMs?: number } = {}) =>
  extractPdf("fixture.pdf", bytes, { pdfjs: pdfjs as never, cMapUrl: CMAPS, ...opts });

type Draw = (page: PDFPage, font: PDFFont) => void;
async function pdf(...pages: Draw[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const draw of pages) draw(doc.addPage([612, 792]), font);
  return doc.save();
}
const text = (r: PdfResult) => { assert.ok(r.ok, r.ok ? "" : `refused: ${r.message}`); return r.ok ? r.text : ""; };
const refused = (r: PdfResult) => { assert.ok(!r.ok, "it was accepted"); return r.ok ? { code: "", message: "" } : r; };

/** Every non-space character drawn, exactly once — nothing dropped, nothing
 *  duplicated, nothing invented. Order is checked separately, per fixture. */
function sameCharacters(out: string, drawn: string[]) {
  const bag = (s: string) => [...s.replace(/\s+/g, "")].sort().join("");
  assert.equal(bag(out), bag(drawn.join("")), "characters were dropped, duplicated or invented");
}

const ROWS = [
  ["Harbor House", "$2,400"],
  ["The Loft", "$1,950"],
  ["Cedar Row", "$3,100"],
  ["Mill Street Studios", "$1,275"],
];
const PRICE_TABLE = ROWS.map(([n, p]) => `${n}\t${p}`).join("\n");

// ---------------------------------------------------------------------------
// TABLES: THE ROW HOLDS, WHATEVER ORDER THE FILE WROTE
// ---------------------------------------------------------------------------

test("a price table drawn COLUMN BY COLUMN still pairs each name with its own price", async () => {
  const bytes = await pdf((page, font) => {
    ROWS.forEach(([n], i) => page.drawText(n, { x: 72, y: 700 - i * 20, size: 12, font }));
    ROWS.forEach(([, p], i) => page.drawText(p, { x: 400, y: 700 - i * 20, size: 12, font }));
  });
  const out = text(await read(bytes));
  assert.equal(out, PRICE_TABLE);
  sameCharacters(out, ROWS.flat());
});

test("the same table drawn ROW BY ROW reads identically — the stream order does not matter", async () => {
  const bytes = await pdf((page, font) => {
    ROWS.forEach(([n, p], i) => {
      page.drawText(n, { x: 72, y: 700 - i * 20, size: 12, font });
      page.drawText(p, { x: 400, y: 700 - i * 20, size: 12, font });
    });
  });
  assert.equal(text(await read(bytes)), PRICE_TABLE);
});

test("drawn BOTTOM TO TOP, prices first: still the same rows, in reading order", async () => {
  const bytes = await pdf((page, font) => {
    [...ROWS].reverse().forEach(([, p], k) => page.drawText(p, { x: 400, y: 700 - (ROWS.length - 1 - k) * 20, size: 12, font }));
    [...ROWS].reverse().forEach(([n], k) => page.drawText(n, { x: 72, y: 700 - (ROWS.length - 1 - k) * 20, size: 12, font }));
  });
  assert.equal(text(await read(bytes)), PRICE_TABLE);
});

test("RIGHT-ALIGNED prices of different widths stay on their own rows", async () => {
  const rows = [["Harbor House", "$2,400.00"], ["The Loft", "$950"], ["Cedar Row", "$13,100.50"]];
  const bytes = await pdf((page, font) => {
    rows.forEach(([, p], i) => page.drawText(p, { x: 540 - font.widthOfTextAtSize(p, 12), y: 700 - i * 18, size: 12, font }));
    rows.forEach(([n], i) => page.drawText(n, { x: 72, y: 700 - i * 18, size: 12, font }));
  });
  assert.equal(text(await read(bytes)), rows.map(([n, p]) => `${n}\t${p}`).join("\n"));
});

test("a three-column table keeps every cell of a row together, in order", async () => {
  const rows = [["Harbor House", "2 beds", "$2,400"], ["The Loft", "1 bed", "$1,950"], ["Cedar Row", "3 beds", "$3,100"]];
  const bytes = await pdf((page, font) => {
    for (const col of [2, 0, 1]) rows.forEach((r, i) => page.drawText(r[col], { x: [72, 260, 420][col], y: 700 - i * 20, size: 12, font }));
  });
  assert.equal(text(await read(bytes)), rows.map((r) => r.join("\t")).join("\n"));
});

test("VALUES ARE PRESERVED EXACTLY — currency, fractions, superscripts, percent", async () => {
  const cells = [
    ["Community fee", "$1,250.00"],
    ["Deposit", "\u20AC980"],
    ["Half day", "\u00BD rate"],
    ["Suite", "40 m\u00B2"],
    ["Annual increase", "3.5%"],
    ["Parking", "1,250 \u00A3"],
    // The MICRO sign, which pdf.js's own normalization rewrites to Greek mu.
    // A dosage that silently changes character is exactly the failure this
    // pipeline refuses to allow.
    ["Dose", "250 \u00B5g"],
  ];
  const bytes = await pdf((page, font) => {
    cells.forEach(([, v], i) => page.drawText(v, { x: 400, y: 700 - i * 20, size: 12, font }));
    cells.forEach(([k], i) => page.drawText(k, { x: 72, y: 700 - i * 20, size: 12, font }));
  });
  const out = text(await read(bytes));
  assert.equal(out, cells.map(([k, v]) => `${k}\t${v}`).join("\n"));
  // No compatibility normalization: a half is not 1/2 and a superscript two is
  // not a 2. (A no-break space is checked at the layout level below: pdf-lib's
  // standard fonts encode it as an ordinary space glyph, so a fixture cannot
  // carry one distinctly.)
  assert.ok(out.includes("\u00BD rate") && out.includes("m\u00B2"));
  assert.ok(out.includes("250 \u00B5g") && !out.includes("\u03BC"), "the micro sign became Greek mu");
});

test("a superscript or a smaller font on the row stays on the row", async () => {
  const bytes = await pdf((page, font) => {
    page.drawText("Harbor House", { x: 72, y: 700, size: 12, font });
    page.drawText("1", { x: 72 + font.widthOfTextAtSize("Harbor House", 12) + 1, y: 704, size: 7, font });
    page.drawText("$2,400", { x: 400, y: 700, size: 12, font });
    page.drawText("The Loft", { x: 72, y: 685, size: 12, font });
    page.drawText("$1,950", { x: 400, y: 685, size: 10, font });
  });
  assert.equal(text(await read(bytes)), "Harbor House1\t$2,400\nThe Loft\t$1,950");
});

test("text drawn twice in the same place (fake bold) is read once", async () => {
  const bytes = await pdf((page, font) => {
    page.drawText("Harbor House", { x: 72, y: 700, size: 12, font });
    page.drawText("Harbor House", { x: 72.3, y: 700, size: 12, font });
    page.drawText("$2,400", { x: 400, y: 700, size: 12, font });
  });
  assert.equal(text(await read(bytes)), "Harbor House\t$2,400");
});

// ---------------------------------------------------------------------------
// PROSE, COLUMNS, AND THE MIXTURE
// ---------------------------------------------------------------------------

const LEFT = [
  "The courtyard rooms face the harbor and",
  "catch the morning light, which is why",
  "most families ask for them first when",
  "they book for the summer season here.",
];
const RIGHT = [
  "Breakfast is served from seven until ten",
  "in the garden room, and the kitchen will",
  "pack a picnic if you ask the night before",
  "you plan to spend a day out on the water.",
];

test("two PROSE columns drawn line-across-line are read left column, then right", async () => {
  const bytes = await pdf((page, font) => {
    for (let i = 0; i < LEFT.length; i++) {
      page.drawText(LEFT[i], { x: 50, y: 700 - i * 14, size: 11, font });
      page.drawText(RIGHT[i], { x: 330, y: 700 - i * 14, size: 11, font });
    }
  });
  const out = text(await read(bytes));
  assert.equal(out, `${LEFT.join("\n")}\n\n${RIGHT.join("\n")}`);
  assert.ok(!out.includes("\t"), "a prose column was welded to its neighbour as a table cell");
  sameCharacters(out, [...LEFT, ...RIGHT]);
});

test("a heading above two columns and a footer below keep their places", async () => {
  const bytes = await pdf((page, font) => {
    page.drawText("Staying at Harbor House, a note for the family", { x: 50, y: 740, size: 14, font });
    for (let i = 0; i < LEFT.length; i++) {
      page.drawText(RIGHT[i], { x: 330, y: 700 - i * 14, size: 11, font });
      page.drawText(LEFT[i], { x: 50, y: 700 - i * 14, size: 11, font });
    }
    // A footer that CROSSES the gutter: unmistakably not a column line.
    page.drawText("Harbor House Hotel, 41 Mill Street, and we look forward to seeing you all soon", { x: 50, y: 600, size: 10, font });
  });
  const out = text(await read(bytes));
  assert.ok(out.startsWith("Staying at Harbor House"), "the heading moved");
  assert.ok(out.indexOf(LEFT[3]) < out.indexOf(RIGHT[0]), "the right column began before the left one ended");
  assert.ok(out.trimEnd().endsWith("seeing you all soon"), "the footer moved");
});

test("a SHORT line under two columns is refused: a footer and a column's tail look the same", async () => {
  // Found by this suite: this footer ends before the right column begins, so
  // by geometry alone it is indistinguishable from the last line of the left
  // column — and reading it as that put it in the middle of the text.
  const bytes = await pdf((page, font) => {
    for (let i = 0; i < LEFT.length; i++) {
      page.drawText(LEFT[i], { x: 50, y: 700 - i * 14, size: 11, font });
      page.drawText(RIGHT[i], { x: 330, y: 700 - i * 14, size: 11, font });
    }
    page.drawText("Harbor House Hotel, 41 Mill Street", { x: 50, y: 600, size: 9, font });
  });
  assert.equal(refused(await read(bytes)).code, "layout");
});

test("prose above a table, and the table: prose in order, rows intact", async () => {
  const intro = ["These are the three places I would see first,", "in the order I would see them."];
  const bytes = await pdf((page, font) => {
    ROWS.slice(0, 3).forEach(([, p], i) => page.drawText(p, { x: 400, y: 640 - i * 18, size: 12, font }));
    intro.forEach((l, i) => page.drawText(l, { x: 72, y: 700 - i * 15, size: 12, font }));
    ROWS.slice(0, 3).forEach(([n], i) => page.drawText(n, { x: 72, y: 640 - i * 18, size: 12, font }));
  });
  const out = text(await read(bytes));
  assert.equal(out, `${intro.join("\n")}\n\n${ROWS.slice(0, 3).map(([n, p]) => `${n}\t${p}`).join("\n")}`);
});

test("the tabs a mixed page contains do NOT turn the whole source into a spreadsheet", async () => {
  // The segmenter reads a tab as a record delimiter even undeclared; a page of
  // prose with a table in it must not be tiled as though it were all records.
  const bytes = await pdf((page, font) => {
    ["We looked at several places this week.", "Here is where I landed after the tours."]
      .forEach((l, i) => page.drawText(l, { x: 72, y: 700 - i * 15, size: 12, font }));
    ROWS.forEach(([n, p], i) => { page.drawText(n, { x: 72, y: 640 - i * 18, size: 12, font }); page.drawText(p, { x: 400, y: 640 - i * 18, size: 12, font }); });
    ["Call me before Friday if you want to visit.", "I can hold the Loft until then."]
      .forEach((l, i) => page.drawText(l, { x: 72, y: 540 - i * 15, size: 12, font }));
  });
  const out = text(await read(bytes));
  assert.equal(detectSourceRecords(out), null, "a mixed page was treated as a delimited file");
});

test("JUSTIFIED prose with stretched word spaces gains no tab", async () => {
  const words = ["Every", "room", "has", "its", "own", "entrance", "from", "the", "garden"];
  const bytes = await pdf((page, font) => {
    let x = 72;
    for (const w of words) { page.drawText(w, { x, y: 700, size: 12, font }); x += font.widthOfTextAtSize(w, 12) + 12 * 1.4; }
  });
  const out = text(await read(bytes));
  assert.equal(out, words.join(" "));
});

// ---------------------------------------------------------------------------
// WHERE ORDER CANNOT BE ESTABLISHED: REFUSED, BY PAGE
// ---------------------------------------------------------------------------

test("a column of prose beside a column of short list items is REFUSED, not guessed", async () => {
  const list = ["Pool", "Garden", "Library", "Spa"];
  const bytes = await pdf(
    (page, font) => page.drawText("A plain first page, which reads fine on its own.", { x: 72, y: 700, size: 12, font }),
    (page, font) => {
      for (let i = 0; i < LEFT.length; i++) {
        page.drawText(LEFT[i], { x: 50, y: 700 - i * 14, size: 11, font });
        page.drawText(list[i], { x: 400, y: 700 - i * 14, size: 11, font });
      }
    });
  const r = refused(await read(bytes));
  assert.equal(r.code, "layout");
  assert.equal(r.message,
    "Sendset couldn’t safely determine the reading order on page 2. This PDF uses columns or a complex layout that isn’t supported yet.");
});

test("two price tables SIDE BY SIDE are refused — reading them row by row would interleave them", async () => {
  const left = [["Harbor House", "$2,400"], ["The Loft", "$1,950"], ["Cedar Row", "$3,100"]];
  const right = [["Parking", "$150"], ["Storage", "$75"], ["Pets", "$40"]];
  const bytes = await pdf((page, font) => {
    left.forEach(([n, p], i) => { page.drawText(n, { x: 40, y: 700 - i * 18, size: 11, font }); page.drawText(p, { x: 190, y: 700 - i * 18, size: 11, font }); });
    right.forEach(([n, p], i) => { page.drawText(n, { x: 330, y: 700 - i * 18, size: 11, font }); page.drawText(p, { x: 480, y: 700 - i * 18, size: 11, font }); });
  });
  assert.equal(refused(await read(bytes)).code, "layout");
});

test("a spanning line in the MIDDLE of two columns is refused: that is not two columns", async () => {
  const bytes = await pdf((page, font) => {
    for (let i = 0; i < 2; i++) { page.drawText(LEFT[i], { x: 50, y: 700 - i * 14, size: 11, font }); page.drawText(RIGHT[i], { x: 330, y: 700 - i * 14, size: 11, font }); }
    page.drawText("A pull quote across the whole page, set between the two columns of text", { x: 50, y: 660, size: 11, font });
    for (let i = 2; i < 4; i++) { page.drawText(LEFT[i], { x: 50, y: 700 - i * 14 - 30, size: 11, font }); page.drawText(RIGHT[i], { x: 330, y: 700 - i * 14 - 30, size: 11, font }); }
  });
  assert.equal(refused(await read(bytes)).code, "layout");
});

test("rotated text is refused rather than read in an order nobody can vouch for", async () => {
  const bytes = await pdf((page, font) => {
    page.drawText("Harbor House", { x: 72, y: 700, size: 12, font });
    page.drawText("Floor plan, not to scale", { x: 500, y: 300, size: 10, font, rotate: degrees(90) });
  });
  const r = refused(await read(bytes));
  assert.equal(r.code, "layout");
  assert.match(r.message, /page 1\./);
});

// ---------------------------------------------------------------------------
// PAGES
// ---------------------------------------------------------------------------

test("pages come out in order, a blank line apart, and a blank page contributes nothing", async () => {
  const bytes = await pdf(
    (page, font) => page.drawText("First page", { x: 72, y: 700, size: 12, font }),
    () => { /* intentionally blank */ },
    (page, font) => page.drawText("Third page", { x: 72, y: 700, size: 12, font }),
    (page, font) => page.drawText("Fourth page", { x: 72, y: 700, size: 12, font }),
  );
  const r = await read(bytes);
  assert.ok(r.ok);
  assert.equal(r.text, "First page\n\nThird page\n\nFourth page");
  assert.deepEqual(r.pages.map((p) => [p.page, p.text]), [[1, "First page"], [2, ""], [3, "Third page"], [4, "Fourth page"]]);
  assert.equal(r.pageCount, 4);
  assert.match(r.extractor, /^pdfjs-dist@6\.3\.289\+sendset-pdf-layout@1$/);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// EVERY REFUSAL, SPECIFIC
// ---------------------------------------------------------------------------

async function pngBytes(): Promise<Uint8Array> {
  // A 2×2 PNG, enough to draw an image on a page.
  return Uint8Array.from(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64"));
}
async function imagePagePdf(textOnPages: boolean[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const img = await doc.embedPng(await pngBytes());
  for (const hasText of textOnPages) {
    const page = doc.addPage([612, 792]);
    if (hasText) page.drawText("A page with real text on it", { x: 72, y: 700, size: 12, font });
    else page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  }
  return doc.save();
}

test("a SCANNED PDF is refused — never passed off as read", async () => {
  const r = refused(await read(await imagePagePdf([false, false])));
  assert.equal(r.code, "scanned");
  assert.equal(r.message, "This PDF looks like scanned pages, so there’s no text to read. Sendset can’t read scanned PDFs yet.");
});

test("a PDF that is PARTLY scanned is refused whole, naming the pages", async () => {
  const r = refused(await read(await imagePagePdf([true, false, true, false])));
  assert.equal(r.code, "mixed");
  assert.equal(r.message, "Pages 2 and 4 have no readable text (they may be scanned), so this PDF wasn’t added.");
});

test("a scan wearing a hidden OCR text layer is refused as a scan", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const img = await doc.embedPng(await pngBytes());
  const page = doc.addPage([612, 792]);
  page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  const fontName = page.node.newFontDictionary(font.name, font.ref);
  page.pushOperators(
    pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible),
    setFontAndSize(fontName, 12), moveText(72, 700), showText(font.encodeText("Harbor House $2,400")),
    endText(), popGraphicsState());
  const r = refused(await read(await doc.save()));
  assert.equal(r.code, "ocr_layer");
  assert.equal(r.message, "Page 1 looks like a scanned page with a hidden text layer. Sendset can’t read scanned PDFs yet.");
});

test("a photograph ON a text page is fine: that is a brochure, not a scan", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const img = await doc.embedPng(await pngBytes());
  const page = doc.addPage([612, 792]);
  page.drawImage(img, { x: 72, y: 400, width: 200, height: 150 });
  page.drawText("Harbor House", { x: 72, y: 700, size: 12, font });
  assert.equal(text(await read(await doc.save())), "Harbor House");
});

test("a PDF with no text and no pictures is EMPTY", async () => {
  const r = refused(await read(await pdf(() => {}, () => {})));
  assert.equal(r.code, "empty");
  assert.equal(r.message, "This PDF has no text in it.");
});

test("a PASSWORD-PROTECTED PDF is refused with what to do about it", async () => {
  // A real /Encrypt dictionary whose user password is not empty: pdf.js tries
  // the empty password, fails, and asks for one — which is exactly the case a
  // professional hits with a locked statement.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText("Locked", { x: 72, y: 700, size: 12, font });
  const ctx = doc.context;
  const encrypt = ctx.obj({
    Filter: "Standard", V: 1, R: 2, Length: 40, P: -4,
    O: ctx.obj(new Array(32).fill(0).map((_, i) => (i * 7 + 3) % 256)) ,
    U: ctx.obj(new Array(32).fill(0).map((_, i) => (i * 13 + 5) % 256)),
  });
  // pdf-lib writes these arrays as numbers; the handler wants strings.
  const hex = (seed: number) => Array.from({ length: 32 }, (_, i) => ((i * seed + 3) % 256).toString(16).padStart(2, "0")).join("");
  (encrypt as unknown as { set(k: unknown, v: unknown): void }).set(
    (await import("pdf-lib")).PDFName.of("O"), (await import("pdf-lib")).PDFHexString.of(hex(7)));
  (encrypt as unknown as { set(k: unknown, v: unknown): void }).set(
    (await import("pdf-lib")).PDFName.of("U"), (await import("pdf-lib")).PDFHexString.of(hex(13)));
  ctx.trailerInfo.Encrypt = ctx.register(encrypt);
  ctx.trailerInfo.ID = ctx.obj([(await import("pdf-lib")).PDFHexString.of("00".repeat(16)), (await import("pdf-lib")).PDFHexString.of("00".repeat(16))]);
  const r = refused(await read(await doc.save({ useObjectStreams: false })));
  assert.equal(r.code, "encrypted");
  assert.equal(r.message, "This PDF is password-protected. Remove the password (or print it to a new PDF) and try again.");
});

test("damaged and wrong-type files are named for what they are", async () => {
  const garbage = new TextEncoder().encode("%PDF-1.7\n" + "this is not a pdf body at all ".repeat(40));
  assert.equal(refused(await read(garbage)).code, "malformed");
  assert.equal(refused(await read(new Uint8Array())).code, "not_pdf");
  assert.equal(refused(await read(await pngBytes())).code, "not_pdf");
});

test("limits refuse rather than truncate — size, pages, characters and time", async () => {
  const big = new Uint8Array(MAX_PDF_BYTES + 1);
  big.set(new TextEncoder().encode("%PDF-1.7"));
  const size = refused(await read(big));
  assert.equal(size.code, "too_large");
  assert.equal(size.message, "This PDF is 20.0 MB — the limit is 20 MB. Try a smaller file, or paste the part you need.");

  const many = await pdf(...Array.from({ length: MAX_PDF_PAGES + 1 }, () => (p: PDFPage, f: PDFFont) => { p.drawText("x", { x: 72, y: 700, size: 12, font: f }); }));
  const pages = refused(await read(many));
  assert.equal(pages.code, "too_many_pages");
  assert.equal(pages.message, "This PDF has 51 pages — the limit is 50. Split it, or paste the part you need.");

  const table = await pdf((page, font) => ROWS.forEach(([n, p], i) => { page.drawText(n, { x: 72, y: 700 - i * 20, size: 12, font }); page.drawText(p, { x: 400, y: 700 - i * 20, size: 12, font }); }));
  const long = refused(await read(table, { remainingChars: 10 }));
  assert.equal(long.code, "too_long");
  assert.match(long.message, /over the 200,000-character limit/);
  // Exactly at the remaining room is fine: the limit is not off by one.
  assert.ok((await read(table, { remainingChars: PRICE_TABLE.length })).ok);

  assert.equal(refused(await read(table, { timeoutMs: 1 })).code, "timeout");
});

test("page lists read as English", () => {
  assert.equal(pageList([3]), "page 3");
  assert.equal(pageList([7, 3]), "pages 3 and 7");
  assert.equal(pageList([5, 3, 7]), "pages 3, 5 and 7");
});

// ---------------------------------------------------------------------------
// THE LAYOUT RULES DIRECTLY, where a fixture cannot easily reach
// ---------------------------------------------------------------------------

const run = (str: string, x: number, y: number, size = 12, width = str.length * size * 0.5): PdfTextRun =>
  ({ str, x, y, width, size, rotated: false });

test("ligatures are expanded, and NOTHING ELSE is normalized", () => {
  const r = layoutPage([run("O\uFB03ce \uFB01le \u00BD \u00B2 \u2153 1\u00A0250", 72, 100)]);
  assert.ok(r.ok);
  assert.equal(r.ok && r.text, "Office file \u00BD \u00B2 \u2153 1\u00A0250");
});

test("text a font could not decode is refused, not read as nonsense", () => {
  for (const bad of ["Harbor \uFFFD House", "Price \uE012\uE013", "Tab\u0001here"]) {
    const r = layoutPage([run(bad, 72, 100)]);
    assert.deepEqual(r, { ok: false, reason: "undecodable" }, JSON.stringify(bad));
  }
});

test("single-spaced lines never merge; a paragraph gap is kept as a blank line", () => {
  const r = layoutPage([
    run("one", 72, 100), run("two", 72, 114), run("three", 72, 128), run("new paragraph", 72, 160), run("continues", 72, 174),
  ]);
  assert.ok(r.ok);
  assert.equal(r.ok && r.text, "one\ntwo\nthree\n\nnew paragraph\ncontinues");
});

test("evenly spaced table rows are NOT split into paragraphs, however generous the spacing", () => {
  const rows = [0, 1, 2, 3].map((i) => [run(`Row ${i}`, 72, 100 + i * 24), run(`$${i}00`, 400, 100 + i * 24)]).flat();
  const r = layoutPage(rows);
  assert.ok(r.ok);
  assert.equal(r.ok && r.text, "Row 0\t$000\nRow 1\t$100\nRow 2\t$200\nRow 3\t$300");
});

// ---------------------------------------------------------------------------
// FOUND BY PRINTING REAL PAGES (headless Chrome), NOT BY REASONING. Each of
// these was wrong on a real PDF while every fixture above passed.
// ---------------------------------------------------------------------------

test("a FOUR-column table with right-aligned values is one table, not two side by side", async () => {
  // Was refused: two cells either side of the middle gap looked like two lists.
  // After that gap come the row's own values, not a new list's first name.
  const rows = [
    ["Residence", "Size", "Monthly", "Deposit"],
    ["Studio Garden", "410 sq ft", "$2,400", "$500"],
    ["One Bedroom Harbor View", "655 sq ft", "$3,150", "$750"],
    ["Two Bedroom Corner", "890 sq ft", "$4,275.50", "€1,000"],
  ];
  const bytes = await pdf((page, font) => {
    // Drawn column by column, values right-aligned, as real producers do.
    for (let c = 3; c >= 0; c--) rows.forEach((r, i) => {
      const right = [0, 0, 480, 560][c];
      const x = c < 2 ? [58, 296][c] : right - font.widthOfTextAtSize(r[c].replace("€", "E"), 12);
      page.drawText(r[c].replace("€", "E"), { x, y: 650 - i * 15, size: 12, font });
    });
  });
  assert.equal(text(await read(bytes)), rows.map((r) => r.join("\t").replace("€", "E")).join("\n"));
});

test("two columns set HALF A LINE out of step are read left then right, never interleaved", async () => {
  // Was ACCEPTED AS ONE FLOW and interleaved line by line: the two sides never
  // shared a baseline, so no line was split and nothing looked like columns.
  const bytes = await pdf((page, font) => {
    for (let i = 0; i < LEFT.length; i++) {
      page.drawText(RIGHT[i], { x: 330, y: 693 - i * 14, size: 11, font });
      page.drawText(LEFT[i], { x: 50, y: 700 - i * 14, size: 11, font });
    }
  });
  assert.equal(text(await read(bytes)), `${LEFT.join("\n")}\n\n${RIGHT.join("\n")}`);
});

test("uneven real columns — one starts higher, the other ends lower — are read in order", async () => {
  // Was refused: a one-sided line above the first shared row, or below the
  // last, was treated as a possible footer even when it continued its column
  // at exactly the column's own line spacing.
  const bytes = await pdf((page, font) => {
    page.drawText("Welcome to the neighborhood", { x: 50, y: 740, size: 18, font });
    RIGHT.forEach((l, i) => page.drawText(l, { x: 330, y: 700 - i * 14 + 2.3, size: 11, font }));
    [...LEFT, "and a last line."].forEach((l, i) => page.drawText(l, { x: 50, y: 686 - i * 14, size: 11, font }));
  });
  assert.equal(text(await read(bytes)),
    `Welcome to the neighborhood\n\n${[...LEFT, "and a last line."].join("\n")}\n\n${RIGHT.join("\n")}`);
});

test("...but a column's extra line set APART by a gap is still refused: tail or footer, nobody can say", async () => {
  const bytes = await pdf((page, font) => {
    RIGHT.forEach((l, i) => page.drawText(l, { x: 330, y: 700 - i * 14, size: 11, font }));
    LEFT.forEach((l, i) => page.drawText(l, { x: 50, y: 700 - i * 14, size: 11, font }));
    page.drawText("Harbor House, 41 Mill St.", { x: 50, y: 630, size: 11, font });
  });
  assert.equal(refused(await read(bytes)).code, "layout");
});

test("SHORT PARAGRAPHS keep their breaks: half the steps being breaks does not hide them", async () => {
  // Was lost: measured against the median step, which in two-line paragraphs
  // IS the paragraph step.
  const paras = [["Residence 11 faces the courtyard and has a kitchenette,", "a walk-in shower and a balcony."],
    ["Residence 12 faces the street and has a full kitchen,", "a tub and no balcony."],
    ["Tours daily at ten."], ["Parking is free for residents."], ["Pets are welcome."]];
  const bytes = await pdf((page, font) => {
    let y = 700;
    for (const p of paras) { for (const l of p) { page.drawText(l, { x: 50, y, size: 12, font }); y -= 14; } y -= 12; }
  });
  assert.equal(text(await read(bytes)), paras.map((p) => p.join("\n")).join("\n\n"));
});

test("a LETTER with a right-aligned date stays one flow — one line on the right is not a column", async () => {
  const bytes = await pdf((page, font) => {
    page.drawText("Harbor House Hotel", { x: 50, y: 720, size: 12, font });
    page.drawText("September 18, 2026", { x: 440, y: 700, size: 12, font });
    page.drawText("Dear Pat and family,", { x: 50, y: 680, size: 12, font });
    page.drawText("Your rooms are ready from the first of the month.", { x: 50, y: 666, size: 12, font });
  });
  assert.equal(text(await read(bytes)),
    "Harbor House Hotel\nSeptember 18, 2026\nDear Pat and family,\nYour rooms are ready from the first of the month.");
});

test("ONE line set beside a paragraph, out of step with it, is refused — not slotted into the sentence", async () => {
  // Read as one flow, the note would land between the paragraph's two lines.
  const bytes = await pdf((page, font) => {
    page.drawText("The courtyard rooms face the harbor and", { x: 50, y: 700, size: 11, font });
    page.drawText("Deposit $500", { x: 400, y: 693, size: 11, font });
    page.drawText("catch the morning light all year.", { x: 50, y: 686, size: 11, font });
  });
  assert.equal(refused(await read(bytes)).code, "layout");
});

test("DOUBLE-SPACED columns out of step (lines never overlapping) are still read left then right", async () => {
  const bytes = await pdf((page, font) => {
    for (let i = 0; i < LEFT.length; i++) {
      page.drawText(LEFT[i], { x: 50, y: 700 - i * 28, size: 11, font });
      page.drawText(RIGHT[i], { x: 330, y: 686 - i * 28, size: 11, font });
    }
  });
  assert.equal(text(await read(bytes)), `${LEFT.join("\n")}\n\n${RIGHT.join("\n")}`);
});
