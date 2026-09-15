// A Sendset's QR code encodes its canonical, stable link — and only that.
//
// Scan correctness is proved outside this file: every production slug (and
// edge lengths) was rendered as a large PNG, a small PNG and the real SVG, and
// decoded by macOS CoreImage — an independent decoder — to exactly the
// canonical URL (111/111, with a negative control). These tests pin what that
// proof relied on and the panel's behaviour.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { QR_PNG_MIN_PX, QR_QUIET_ZONE, drawSendsetQr, sendsetQr, sendsetQrFileName, sendsetQrPngScale, sendsetQrSvg } from "./sendset-qr.ts";

const SLUG = "k3x9q2m7p4r8t1v6w5y0za";

test("it encodes the canonical sendset.io URL for the slug, nothing else", () => {
  const qr = sendsetQr(SLUG);
  assert.equal(qr.url, `https://sendset.io/p/${SLUG}`);
  const src = readFileSync("src/lib/sendset-qr.ts", "utf8").replace(/\/\/[^\n]*/g, "");
  assert.match(src, /const url = publicSendsetUrl\(slug\);\s+const r = encode\(url,/, "the encoded text is not the canonical link");
  assert.doesNotMatch(src, /location|window|headers|origin/i, "the QR must not depend on the host being browsed");
});

test("a code depends on the slug alone: identical across edits and republishes, distinct per Sendset", () => {
  assert.deepEqual(sendsetQr(SLUG).modules, sendsetQr(SLUG).modules);
  assert.notDeepEqual(sendsetQr(SLUG).modules, sendsetQr("harbor-view-7k2").modules);
  assert.equal(sendsetQr.length, 1, "sendsetQr takes the slug and nothing that changes on edit");
});

test("a square symbol with a full quiet zone and its finder patterns where scanners look", () => {
  for (const slug of ["a", SLUG, "x".repeat(60)]) {
    const qr = sendsetQr(slug);
    assert.equal(qr.modules.length, qr.size);
    assert.ok(qr.modules.every((row) => row.length === qr.size));
    const q = QR_QUIET_ZONE, last = qr.size - 1;
    for (let i = 0; i < qr.size; i++) {
      for (let k = 0; k < q; k++) {
        assert.ok(!qr.modules[k][i] && !qr.modules[last - k][i] && !qr.modules[i][k] && !qr.modules[i][last - k], `${slug}: quiet zone not light`);
      }
    }
    // Top-left, top-right and bottom-left finder patterns: dark 7×7 rings.
    for (const [ox, oy] of [[q, q], [last - q - 6, q], [q, last - q - 6]]) {
      for (let i = 0; i < 7; i++) {
        assert.ok(qr.modules[oy][ox + i] && qr.modules[oy + 6][ox + i] && qr.modules[oy + i][ox] && qr.modules[oy + i][ox + 6], `${slug}: finder pattern missing`);
      }
    }
  }
  assert.ok(sendsetQr(SLUG).version <= 4, "a production-length link stays a small, easily scanned symbol");
});

test("the SVG is self-contained, black on white, one path covering exactly the dark modules", () => {
  const qr = sendsetQr(SLUG);
  const svg = sendsetQrSvg(qr);
  assert.match(svg, new RegExp(`viewBox="0 0 ${qr.size} ${qr.size}"`));
  assert.match(svg, /<rect width="\d+" height="\d+" fill="#ffffff"\/>/);
  assert.equal((svg.match(/<path /g) ?? []).length, 1);
  assert.match(svg, /fill="#000000"/);
  assert.doesNotMatch(svg.replace('xmlns="http://www.w3.org/2000/svg"', ""), /https?:|<image|<text|<script|href=/i, "the SVG references something outside itself");
  const dark = qr.modules.flat().filter(Boolean).length;
  assert.equal((svg.match(/h1v1h-1z/g) ?? []).length, dark);
});

test("PNG exports are at least 1024px with whole pixels per module; names are safe", () => {
  for (const slug of ["a", SLUG, "x".repeat(60)]) {
    const qr = sendsetQr(slug);
    const scale = sendsetQrPngScale(qr);
    assert.ok(Number.isInteger(scale) && qr.size * scale >= QR_PNG_MIN_PX);
  }
  assert.equal(sendsetQrFileName(SLUG, "png"), `sendset-qr-${SLUG}.png`);
  assert.equal(sendsetQrFileName("../../x y", "svg"), "sendset-qr-xy.svg");
});

test("the PNG drawing paints every pixel exactly as its module, black on white", () => {
  const qr = sendsetQr(SLUG);
  const scale = sendsetQrPngScale(qr);
  const n = qr.size * scale;
  const px: string[][] = Array.from({ length: n }, () => Array(n).fill("unpainted"));
  const ctx = { fillStyle: "" as string, fillRect(x: number, y: number, w: number, h: number) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) px[j][i] = this.fillStyle;
  } };
  drawSendsetQr(ctx as never, qr, scale);
  let wrong = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (px[y][x] !== (qr.modules[Math.floor(y / scale)][Math.floor(x / scale)] ? "#000000" : "#ffffff")) wrong++;
  }
  assert.equal(wrong, 0);
});

test("no third-party QR service anywhere in the app", () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(p) && !/ \d+\.[a-z]+$/.test(p)) files.push(p); } };
  walk("src");
  const offenders = files.filter((f) => /api\.qrserver|chart\.googleapis|quickchart|goqr|qr-code-generator\.com/i.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// The panel, in a DOM served from a non-canonical host
// ---------------------------------------------------------------------------
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let Panel: typeof import("../components/qr-code-panel.tsx").default;

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://flowguide-ruddy.vercel.app/preview/p1", pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window; g.document = dom.window.document;
  g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node; g.Event = dom.window.Event; g.MouseEvent = dom.window.MouseEvent;
  Object.defineProperty(g, "navigator", { value: dom.window.navigator, configurable: true });
  g.IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ act } = await import("react"));
  Panel = (await import("../components/qr-code-panel.tsx")).default;
});

async function mount() {
  const saved: { name: string; type: string }[] = [];
  let closed = 0;
  const blobs = new Map<string, Blob>();
  (globalThis as unknown as { URL: typeof URL }).URL.createObjectURL = (b: Blob) => { const id = `blob:${blobs.size}`; blobs.set(id, b); return id; };
  (globalThis as unknown as { URL: typeof URL }).URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { saved.push({ name: this.download, type: blobs.get(this.getAttribute("href")!)!.type }); };
  (globalThis as unknown as { fetch: unknown }).fetch = () => { throw new Error("the QR panel made a network request"); };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Panel, { slug: SLUG, onClose: () => { closed++; } })); });
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;
  return { host, root, saved, closed: () => closed, button };
}
const click = (el: Element) => act(async () => { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });

test("the panel shows a saveable image of the canonical link, not the host being browsed", async () => {
  const h = await mount();
  const img = h.host.querySelector("img")!;
  assert.equal(img.getAttribute("alt"), `QR code that opens https://sendset.io/p/${SLUG}`);
  assert.equal(decodeURIComponent(img.getAttribute("src")!.replace("data:image/svg+xml;charset=utf-8,", "")), sendsetQrSvg(sendsetQr(SLUG)));
  assert.doesNotMatch(h.host.innerHTML, /vercel\.app/);
  assert.match(h.host.textContent!, /keeps working when you edit and republish; unpublishing turns it off/);
  h.root.unmount();
});

test("Download SVG saves the same drawing; Download PNG says so when the browser cannot draw; Done closes", async () => {
  const h = await mount();
  await click(h.button("Download SVG"));
  assert.deepEqual(h.saved, [{ name: `sendset-qr-${SLUG}.svg`, type: "image/svg+xml" }]);
  await click(h.button("Download PNG"));   // jsdom has no 2D canvas: the honest failure path
  assert.match(h.host.querySelector('[role="alert"]')?.textContent ?? "", /couldn.t create the PNG/);
  await click(h.button("Done"));
  assert.equal(h.closed(), 1);
  h.root.unmount();
});

test("the share step offers it beside the email version and the printed copy, only once published", () => {
  const a = readFileSync("src/components/preview-actions.tsx", "utf8");
  const published = a.slice(a.indexOf('if (status === "published")'), a.indexOf('aria-labelledby="preview-heading"'));
  assert.match(published, /Print \/ Save as PDF[\s\S]{0,200}onClick=\{\(\) => setShowQr\(true\)\}>\s*QR code/);
  assert.match(published, /showQr \? \(\s*<QrCodePanel slug=\{slug\} onClose=\{\(\) => setShowQr\(false\)\} \/>/);
  assert.doesNotMatch(a.slice(a.indexOf('aria-labelledby="preview-heading"')), /QrCodePanel|setShowQr\(true\)/, "a draft cannot have a QR code: its link does not work yet");
});
