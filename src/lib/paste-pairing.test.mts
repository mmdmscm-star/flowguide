// The detector behind the paste-time advisory.
//
// The case it exists for is real and traced end to end: themenustar6.com writes
// each menu row as <span class="pull-right">PRICE</span> followed by the dish
// name, floated right by CSS. A drag beginning on the visible title starts
// after the first price, and the clipboard's text/plain then reads
// "name, description, NEXT dish's price" all the way down. That exact string
// was reproduced from the live page and matched the stored source byte for
// byte.
//
// A FALSE ALARM IS THE EXPENSIVE FAILURE HERE. Warning on an ordinary paste
// teaches a professional that the paste box is unreliable, which costs more
// than this saves. Most of what follows is therefore about staying silent.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { checkPastedPairing } from "./paste-pairing.ts";

before(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  (globalThis as unknown as Record<string, unknown>).DOMParser = dom.window.DOMParser;
});

/** The real shape: price first in the DOM, floated right. */
const priceFirstRow = (price: string, name: string, desc = "Some description.") =>
  `<div class="media"><span class="pull-right">${price}</span>` +
  `<h4 class="media-heading">${name}</h4><div class="text-sm">${desc}</div></div>`;

/** The ordinary shape: name, then price, then description. */
const nameFirstRow = (name: string, price: string, desc = "Some description.") =>
  `<div class="row"><h4>${name}</h4><span class="price">${price}</span><div>${desc}</div></div>`;

const DISHES: Array<[string, string]> = [
  ["Super Burrito", "$16.24"], ["Taco Carne Asada", "$4.93"],
  ["Regular Burrito", "$15.08"], ["Taco Carnitas", "$4.64"],
  ["#5. Enchiladas Combo", "$17.98"], ["Taco Pollo Asado", "$4.64"],
];

// VERBATIM FROM THE LIVE PAGE. Captured by performing the selection in a
// browser and reading both clipboard flavours; the plain text below matched the
// stored `source_text` line for line, typo ("A combination o carne asada")
// included. Prices are the page's TRUE ones.
const REAL_ROWS: Array<[string, string]> = [
  ["Taco Carne Asada", "$4.93"], ["Regular Burrito", "$15.08"],
  ["Taco Carnitas", "$4.64"], ["#5. Enchiladas Combo", "$17.98"],
  ["Taco Pollo Asado", "$4.64"], ["Taco", "$5.80"], ["Tacos Al Pastor", "$4.64"],
];
const REAL_HTML =
  // Super Burrito's price sat BEFORE the drag started, so its row carries none.
  `<div class="media"><h4 class="media-heading">Super Burrito</h4>` +
  `<div class="text-sm">Your choice of meat, rice, beans…</div></div>` +
  REAL_ROWS.map(([n, p]) => priceFirstRow(p, n, `Description of ${n}.`)).join("");
const REAL_PLAIN = [
  "Super Burrito", "Your choice of meat, rice, beans…",
  "$4.93", "Taco Carne Asada", "A combination o carne asada (steak)…",
  "$15.08", "Regular Burrito", "Your choice of meat, rice, beans…",
  "$4.64", "Taco Carnitas", "A combination of crispy carnitas…",
  "$17.98", "#5. Enchiladas Combo", "Two enchiladas with your choices of meat…",
  "$4.64", "Taco Pollo Asado", "A combination of grilled chicken…",
  "$5.80", "Taco",
  "$4.64", "Tacos Al Pastor", "A combination of al pastor…",
].join("\n");

test("THE REAL CASE: the Taqueria paste, verbatim, is caught", () => {
  const v = checkPastedPairing(REAL_HTML, REAL_PLAIN);
  assert.ok(v, "the contradiction that reached a draft was not detected");
  assert.ok(v!.conflicts >= 5, `only ${v!.conflicts} of ${v!.compared} rows flagged`);
  // Every flagged row must be REPORTED, never corrected: the detector states
  // the disagreement and stops.
  assert.notEqual(v!.example.htmlValue, v!.example.plainValue);
});

test("THE HONEST LIMIT: it cannot recover a value that was never copied", () => {
  // Super Burrito's real price ($16.24) sat before the selection. It is absent
  // from BOTH flavours, so no row for it exists and nothing claims otherwise.
  const v = checkPastedPairing(REAL_HTML, REAL_PLAIN)!;
  assert.ok(!/16\.24/.test(JSON.stringify(v)),
    "the verdict invented a price that was never in the clipboard");
});

test("SILENT when the page's order survives flattening", () => {
  const html = DISHES.map(([n, p]) => nameFirstRow(n, p)).join("");
  const plain = DISHES.flatMap(([n, p]) => [n, p, "Some description."]).join("\n");
  assert.equal(checkPastedPairing(html, plain), null,
    "a well-ordered page was reported as a problem");
});

test("SILENT with no HTML flavour at all — a plain-text paste is just a paste", () => {
  const plain = DISHES.flatMap(([n, p]) => [n, p]).join("\n");
  assert.equal(checkPastedPairing("", plain), null);
});

test("THE SIGNAL IS DISAGREEMENT, NOT DOM ORDER", () => {
  // A name-first page — the shape that usually flattens correctly — whose text
  // nonetheless pairs each label with the following row's value. Whatever
  // caused it, the two readings contradict each other and that is the whole
  // test. Keying on "the value came first in the markup" would miss this
  // entirely, and would also fire on tables that are perfectly fine.
  const html = DISHES.map(([n, p]) => nameFirstRow(n, p)).join("");
  const plain = DISHES.flatMap(([n], i) =>
    [n, "Some description.", DISHES[i + 1]?.[1] ?? ""]).filter(Boolean).join("\n");
  const v = checkPastedPairing(html, plain);
  assert.ok(v, "a contradiction was missed because the markup looked conventional");
  assert.ok(v!.conflicts >= 2, `only ${v!.conflicts} conflicts`);
});

test("SILENT on a TABLE whose price column comes first — the common false alarm", () => {
  // A spreadsheet or an HTML table puts the price in the first cell, so the
  // value precedes the label in document order exactly as the menu did. But a
  // table serialises one ROW PER LINE with tabs between cells, so the pairing
  // survives perfectly. Warning here would fire on every pasted spreadsheet,
  // which is the single most expensive false positive this could have — so the
  // detector must key on the actual flattening, never on "the value came
  // first".
  const html = "<table>" + DISHES.map(([n, p]) =>
    `<tr><td>${p}</td><td>${n}</td><td>Some description.</td></tr>`).join("") + "</table>";
  const plain = DISHES.map(([n, p]) => `${p}\t${n}\tSome description.`).join("\n");
  assert.equal(checkPastedPairing(html, plain), null,
    "a pasted table was reported as mis-paired");
});

test("SILENT when a value-first page was copied WHOLE and still flattens per line", () => {
  // Same DOM order as the menu, but each row survives as its own line, so the
  // label and its value stay adjacent. Structure alone is not the signal.
  const html = DISHES.map(([n, p]) => priceFirstRow(p, n, "")).join("");
  const plain = DISHES.map(([n, p]) => `${p} ${n}`).join("\n");
  assert.equal(checkPastedPairing(html, plain), null,
    "a value-first page that flattens correctly was reported");
});

test("SILENT on prose that merely mentions money", () => {
  const html = "<p>The deposit is $500 and the balance of $2,000 is due later. " +
               "Ask about the $50 fee.</p>";
  const plain = "The deposit is $500 and the balance of $2,000 is due later. Ask about the $50 fee.";
  assert.equal(checkPastedPairing(html, plain), null, "prose was treated as rows");
});

test("SILENT on one or two priced rows — that is not a pattern", () => {
  for (const n of [1, 2]) {
    const html = DISHES.slice(0, n).map(([nm, p]) => priceFirstRow(p, nm)).join("");
    const plain = DISHES.slice(0, n).flatMap(([nm]) => [nm, "Some description.", "$9.99"]).join("\n");
    assert.equal(checkPastedPairing(html, plain), null, `${n} row(s) produced a warning`);
  }
});

test("SILENT when only a minority disagree — a single oddity is not a shift", () => {
  // Five rows agree, one does not. A real structural shift moves everything.
  const rows = DISHES.map(([n, p]) => nameFirstRow(n, p)).join("");
  const plain = DISHES.flatMap(([n, p], i) =>
    [n, i === 2 ? "$99.99" : p, "Some description."]).join("\n");
  assert.equal(checkPastedPairing(rows, plain), null, "one mismatch triggered a warning");
});

test("SILENT when the label cannot be found in the text — nothing to compare", () => {
  const html = DISHES.map(([n, p]) => priceFirstRow(p, n)).join("");
  assert.equal(checkPastedPairing(html, "totally unrelated pasted text\nwith no dishes"), null);
});

test("it names the row, the page's value, and the value that would be used", () => {
  const html = DISHES.map(([n, p]) => priceFirstRow(p, n)).join("");
  const plain = DISHES.flatMap(([n], i) =>
    [n, "Some description.", DISHES[i + 1]?.[1] ?? ""]).filter(Boolean).join("\n");
  const v = checkPastedPairing(html, plain);
  assert.ok(v, "not detected");
  assert.ok(v!.example.label, "no row named");
  assert.match(v!.example.htmlValue, /^\$/, "no page value given");
  assert.match(v!.example.plainValue, /^\$/, "no flattened value given");
  assert.notEqual(v!.example.htmlValue, v!.example.plainValue);
});

test("NON-BREAKING SPACES do not manufacture a disagreement", () => {
  const nb = " ";
  const html = DISHES.map(([n, p]) => nameFirstRow(n, p.replace("$", `$${nb}`))).join("");
  const plain = DISHES.flatMap(([n, p]) => [n, p.replace("$", `$${nb}`), "Some description."]).join("\n");
  assert.equal(checkPastedPairing(html, plain), null, "whitespace was read as a conflict");
});
