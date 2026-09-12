// MARKETING IMAGERY, CAPTURED FROM THE REAL PRODUCT.
//
//   npm run dev                    # in another terminal, on :3000
//   npm run capture:marketing
//
// Every asset on the homepage is a photograph of something this codebase
// actually renders — the recipient page, the print route, the HTML email
// renderer, the client-message panel — taken from the DEMO Sendset in the
// DEFAULT treatment. Nothing is mocked, nothing is drawn in a design tool, and
// no client data is involved: /p/demo is the published sample, it carries no
// client and no private note, and its subject (offsite venues) is deliberately
// neutral.
//
// A SCREENSHOT IS A SECOND REPRESENTATION OF THE PRODUCT, and this project
// refuses second sources of truth everywhere else. It cannot be refused here —
// a picture of a UI is what a homepage is for — so the answer is that
// regenerating it is one command, and that the command reads from the running
// product rather than from a saved mockup. Run it after any change to the
// recipient page, the print stylesheet, the email renderer or the treatment
// layer, and look at what comes out.
//
// DELIBERATELY NOT A TEST. There is no visual-regression gate: a pixel diff on
// a page with remote photographs in it would fail for reasons that have nothing
// to do with the product, and a marketing asset going stale is a thing a person
// should notice and decide about, not a thing that should redden CI.
//
// WHAT IS TOUCHED BEFORE A CAPTURE, and nothing else:
//   * the Next dev-server indicator is removed  (dev-only chrome, absent in prod)
//   * CSS transitions are disabled              (a headless pane never finishes
//                                                one, so a colour would freeze
//                                                mid-interpolation)
//   * fonts and images are awaited              (or the shot races the page)
// Packet content is never altered.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { samplePacket } from "../../src/lib/sample-data.ts";
import { renderPacketEmail } from "../../src/lib/email-render.ts";
import { buildClientMessage } from "../../src/lib/client-message.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const WORK = join(HERE, ".work");          // intermediates; gitignored
const OUT = join(ROOT, "public", "marketing");
const ORIGIN = process.env.CAPTURE_ORIGIN ?? "http://localhost:3000";
const PORT = 9412;
const CHROME = process.env.CHROME_PATH
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// A very small CDP client. Chrome is the only dependency, and it is already on
// any machine that can look at the site.
// ---------------------------------------------------------------------------
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return open(page.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("headless Chrome never became debuggable");
}

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiting = new Map();
    let id = 0;
    ws.addEventListener("open", () => resolve({
      send(method, params = {}) {
        const n = ++id;
        return new Promise((res, rej) => {
          waiting.set(n, { res, rej });
          ws.send(JSON.stringify({ id: n, method, params }));
          setTimeout(() => waiting.has(n) && (waiting.delete(n), rej(new Error(`${method} timed out`))), 60000);
        });
      },
      close: () => ws.close(),
    }));
    ws.addEventListener("error", reject);
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.error) w.rej(new Error(JSON.stringify(m.error)));
      else w.res(m.result);
    });
  });
}

/** Everything a deterministic shot needs, run in the page before every capture.
 *
 *  CAPPED, because the demo's photographs are remote: a request that hangs must
 *  cost a few seconds and a slightly emptier picture, not the whole run. */
const SETTLE = `(async () => {
  document.querySelector('nextjs-portal')?.remove();
  const s = document.createElement('style');
  s.textContent = '*{transition:none !important;animation:none !important}';
  document.head.appendChild(s);
  const cap = (p, ms) => Promise.race([p, new Promise(r => setTimeout(r, ms))]);
  await cap(document.fonts.ready.catch(() => {}), 8000);
  await cap(Promise.all([...document.images].map(i => i.decode().catch(() => {}))), 15000);
  return document.images.length;
})()`;

// `dsf` is the device pixel ratio the page is rendered at, and it is also the
// factor between the CSS-pixel clip and the pixels that come out — a 374 CSS
// wide clip at dsf 2 is a 748px image. `clip.scale` multiplies on TOP of that,
// which is why it stays at 1 everywhere: 2 x 2 is a four-times asset nobody
// asked for.
async function shot(cdp, { url, width, height, out, select, pad = 0, dsf = 2, before, headers }) {
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: dsf, mobile: width < 700 });
  // THE PRINTED URL IS THE REQUEST'S HOST, not packet content. Telling the dev
  // server it is being served as sendset.io makes it print what it prints in
  // production; leaving it alone would put "localhost:3000" on the homepage.
  await cdp.send("Network.setExtraHTTPHeaders", { headers: headers ?? {} });
  await cdp.send("Page.navigate", { url });
  await sleep(1200);
  await cdp.send("Runtime.evaluate", { expression: SETTLE, awaitPromise: true });
  if (before) await cdp.send("Runtime.evaluate", { expression: before, awaitPromise: true });

  // The clip is measured from the page, so a layout change moves the crop with
  // it instead of silently cutting a card in half.
  const expr = `(() => {
    const r = (${select})();
    window.scrollTo(0, 0);
    return JSON.stringify({ x: r.x, y: r.y + window.scrollY, width: r.width, height: r.height });
  })()`;
  const { result } = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true });
  const r = JSON.parse(result.value);
  const clip = {
    x: Math.max(0, Math.round(r.x - pad)),
    y: Math.max(0, Math.round(r.y - pad)),
    width: Math.round(r.width + pad * 2),
    height: Math.round(r.height + pad * 2),
    scale: 1,
  };
  const png = await cdp.send("Page.captureScreenshot",
    { format: "png", clip, captureBeyondViewport: true });
  writeFileSync(out, Buffer.from(png.data, "base64"));
  return clip;
}

// ---------------------------------------------------------------------------
// The two artifacts that are not routes: the email renderer's own output, and
// the client-message panel. Both are rendered by the real code, then written to
// a file so Chrome can photograph them the same way it photographs a page.
// ---------------------------------------------------------------------------
async function writeStandalones(css) {
  const email = renderPacketEmail(samplePacket, { liveUrl: "https://sendset.io/p/demo" });
  writeFileSync(join(WORK, "email.html"),
    `<!doctype html><meta charset="utf-8"><body style="margin:0">${email}</body>`);

  const { default: ClientMessagePanel } = await import("../../src/components/client-message-panel.tsx");
  const message = renderToStaticMarkup(React.createElement(ClientMessagePanel, {
    title: samplePacket.clientTitle,
    clientName: samplePacket.clientName,
    professionalName: samplePacket.professional?.name,
    url: "https://sendset.io/p/demo",
    onCopyLink: () => {},
    linkCopied: false,
  }));
  writeFileSync(join(WORK, "message.html"),
    `<!doctype html><meta charset="utf-8"><style>${css}</style>` +
    `<body style="margin:0;background:#fff"><div style="padding:26px 28px">${message}</div></body>`);
  // The message text itself, for the record — it is generated, not written here.
  writeFileSync(join(WORK, "message.txt"), buildClientMessage({
    title: samplePacket.clientTitle,
    clientName: samplePacket.clientName,
    professionalName: samplePacket.professional?.name,
    url: "https://sendset.io/p/demo",
  }));
}

/** A composition page: the captured artifacts, arranged, in the app's tokens. */
function composition({ css, body, width, height }) {
  return `<!doctype html><meta charset="utf-8"><style>${css}
    html,body{margin:0;background:#fff;
      font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
    .frame{border:1px solid var(--color-border);border-radius:14px;overflow:hidden;background:#fff}
    .label{font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--color-foreground);margin:0 0 8px}
    .sub{font-size:12px;color:var(--color-muted);margin:0 0 10px}
  </style><body style="width:${width}px;height:${height}px">${body}</body>`;
}

// ---------------------------------------------------------------------------
async function main() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  const html = await (await fetch(`${ORIGIN}/`)).text();
  const cssHref = html.match(/href="([^"]*\.css[^"]*)"/)?.[1];
  if (!cssHref) throw new Error(`no stylesheet found at ${ORIGIN}/ — is the dev server running?`);
  const css = await (await fetch(new URL(cssHref, ORIGIN))).text();
  await writeStandalones(css);

  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    "--no-default-browser-check", "--allow-file-access-from-files",
    // OUTSIDE THE REPO. A Chrome profile is thousands of files, several of them
    // JavaScript, and dropping one inside scripts/ hands the linter a few
    // thousand problems that have nothing to do with this project.
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "sendset-capture-"))}`,
    `--remote-debugging-port=${PORT}`, "about:blank",
  ], { stdio: "ignore" });

  try {
    const cdp = await connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");

    // 1. THE HERO, which is also the link's tile in the composite — ONE OPTION, from its photograph down through its prices.
    //    Not the whole page shrunk to a thumbnail: a page-shaped picture says
    //    "a website", and one card at readable size says "a guide". The bottom
    //    edge is the detail table's, measured, so a content change moves the
    //    crop instead of slicing a row in half.
    await shot(cdp, {
      url: `${ORIGIN}/p/demo`, width: 390, height: 1600,
      out: join(WORK, "hero.png"),
      select: `() => {
        const card = document.querySelector('#item-i1 > div');
        // The detail table, found by the layout of a label/value row rather
        // than by any word in it — nothing here knows what the packet says.
        // Three rows, then stop. The whole table is nine hundred pixels tall
        // and a hero that long stops being a glance. Cutting at a row boundary
        // reads as "there is more", which there is.
        const rows = card.querySelectorAll('[class*="gap-x-6"]');
        const c = card.getBoundingClientRect();
        const last = rows[Math.min(2, rows.length - 1)];
        const bottom = last ? last.getBoundingClientRect().bottom : c.bottom;
        return { x: c.x, y: c.y, width: c.width, height: (bottom - c.top) };
      }`,
    });

    // 2. THE WORKOUT, DAY A, at phone width — the right half of the before/after
    //    on the landing page. The LEFT half is not captured: it is the same
    //    rows rendered as a spreadsheet grid, in markup, on the page itself, so
    //    the two panels cannot drift apart and the claim that they are the same
    //    data is structural rather than a promise.
    //
    //    ONE card, measured rather than guessed, so a content change moves the
    //    crop instead of slicing it. One is the whole argument and two is a
    //    column of screenshot: a name, a photograph of the movement, a coaching
    //    line, the numbers, and the one note the trainer wanted read — none of
    //    which a spreadsheet row can carry.
    await shot(cdp, {
      url: `${ORIGIN}/p/month-one`, width: 390, height: 2200,
      out: join(WORK, "workout-after.png"),
      select: `() => document.querySelector('#item-a1 > div').getBoundingClientRect()`,
    });

    // 3. PRINT — the paper, from its section heading down through one item, so
    //    the tile shows the document rather than another copy of the header.
    await shot(cdp, {
      url: `${ORIGIN}/p/demo/print`, width: 980, height: 1500,
      out: join(WORK, "print.png"),
      headers: { "x-forwarded-host": "sendset.io", "x-forwarded-proto": "https" },
      before: `document.querySelectorAll('.pg-noprint').forEach(e => e.remove())`,
      select: `() => { const d = document.querySelector('.pg-doc').getBoundingClientRect();
                       const h = document.querySelector('.pg-section-title').getBoundingClientRect();
                       return { x: d.x, y: h.y - 18, width: d.width, height: 620 }; }`,
    });

    // 4. EMAIL — the real renderer's HTML, in a mail-width column.
    await shot(cdp, {
      url: `file://${join(WORK, "email.html")}`, width: 700, height: 2600,
      out: join(WORK, "email.png"),
      // The first ITEM, not the section heading — otherwise the email tile and
      // the print tile are two pictures of the same three words.
      select: `() => { const item = document.querySelector('h3').closest('table[width]');
                       const r = item.getBoundingClientRect();
                       return { x: r.x, y: r.y, width: r.width, height: 620 }; }`,
    });

    // 5. MESSAGE — the real panel, with the message it actually generates.
    await shot(cdp, {
      url: `file://${join(WORK, "message.html")}`, width: 700, height: 760,
      out: join(WORK, "message.png"), pad: 14,
      select: `() => document.querySelector('body > div').getBoundingClientRect()`,
    });

    // ---- the two compositions -----------------------------------------------
    const b64 = (f) => `data:image/png;base64,${readFileSync(join(WORK, f)).toString("base64")}`;

    // COMPOSED AT ITS DISPLAY SIZE, TWICE.
    //
    // A composition designed at 768 and shown at 342 is a composition whose
    // labels are 6px tall — the exact failure that makes screenshot collages
    // useless on a phone. So each width gets its own layout, built at the size
    // it will actually be read at, and the page picks between them with a
    // media query. Same four artifacts in both; only the arrangement differs.
    //
    // THE LINK IS BIGGER THAN THE OTHER THREE in both, because the product says
    // so: the interactive version is the one the others exist to point at.
    const tile = (label, sub, file, style) =>
      `<div><p class="label">${label}</p><p class="sub">${sub}</p>
       <div class="frame" style="${style}"><img src="${b64(file)}" style="display:block;width:100%"></div></div>`;

    const WIDE = { w: 768, h: 660, pad: 20, gap: 20, left: 246, right: 150 };
    writeFileSync(join(WORK, "formats-wide.html"), composition({
      css, width: WIDE.w, height: WIDE.h,
      body: `<div style="padding:${WIDE.pad}px;display:grid;gap:${WIDE.gap}px;
                  grid-template-columns:${WIDE.left}px 1fr">
        ${tile("The link", "Opens on a phone. Swipe the photos, tap to call.", "hero.png", "height:530px")}
        <div style="display:grid;gap:${WIDE.gap}px;align-content:start">
          ${tile("A message", "A few sentences around the link, ready to paste.", "message.png", `height:${WIDE.right}px`)}
          ${tile("An email", "The whole guide inside the body of the email.", "email.png", `height:${WIDE.right}px`)}
          ${tile("Print or PDF", "The same guide, on paper.", "print.png", `height:${WIDE.right}px`)}
        </div>
      </div>`,
    }));
    await shot(cdp, {
      url: `file://${join(WORK, "formats-wide.html")}`, width: WIDE.w, height: WIDE.h,
      out: join(WORK, "formats-wide.png"),
      select: `() => ({ x: 0, y: 0, width: ${WIDE.w}, height: ${WIDE.h} })`,
    });

    // NARROW: a list, not a grid. Four tiles across 342px would be 150px wide
    // and unreadable; a thumbnail beside its own label is legible at any width
    // and is shorter than the prose it replaces.
    const NARROW = { w: 342, h: 470, pad: 14, gap: 12, thumb: 104 };
    const row = (label, sub, file, h) =>
      `<div style="display:grid;grid-template-columns:${NARROW.thumb}px 1fr;gap:12px;align-items:start">
         <div class="frame" style="height:${h}px"><img src="${b64(file)}" style="display:block;width:100%"></div>
         <div><p class="label" style="margin:2px 0 4px">${label}</p><p class="sub" style="margin:0">${sub}</p></div>
       </div>`;
    writeFileSync(join(WORK, "formats-narrow.html"), composition({
      css, width: NARROW.w, height: NARROW.h,
      body: `<style>.label{font-size:13px}.sub{font-size:12px;line-height:1.4}</style>
        <div style="padding:${NARROW.pad}px;display:grid;gap:${NARROW.gap}px">
          ${row("The link", "Opens on a phone. Swipe the photos, tap to call.", "hero.png", 150)}
          ${row("A message", "A few sentences around the link, ready to paste.", "message.png", 62)}
          ${row("An email", "The whole guide inside the body of the email.", "email.png", 90)}
          ${row("Print or PDF", "The same guide, on paper.", "print.png", 90)}
        </div>`,
    }));
    await shot(cdp, {
      url: `file://${join(WORK, "formats-narrow.html")}`, width: NARROW.w, height: NARROW.h,
      out: join(WORK, "formats-narrow.png"),
      select: `() => ({ x: 0, y: 0, width: ${NARROW.w}, height: ${NARROW.h} })`,
    });

    // The link-preview card. Big type, one artifact, nothing to squint at.
    writeFileSync(join(WORK, "og.html"), composition({
      css, width: 1200, height: 630,
      body: `<div style="position:relative;width:1200px;height:630px;overflow:hidden">
        <div style="position:absolute;left:0;top:0;bottom:0;width:14px;background:var(--color-accent)"></div>
        <div style="padding:96px 0 0 84px;max-width:620px">
          <p style="margin:0 0 26px;font-size:22px;font-weight:600;letter-spacing:.18em;color:var(--color-muted)">SENDSET</p>
          <p style="margin:0;font-size:56px;line-height:1.12;font-weight:700;letter-spacing:-.02em;color:var(--color-foreground)">
            One guide your client<br>can actually use.</p>
          <p style="margin:28px 0 0;font-size:25px;line-height:1.45;color:var(--color-muted)">
            Link, message, email or print &mdash; built once.</p>
        </div>
        <div class="frame" style="position:absolute;right:74px;top:64px;width:330px;border-radius:20px;
             box-shadow:0 18px 48px rgba(15,23,42,.16)">
          <img src="${b64("hero.png")}" style="display:block;width:100%">
        </div>
      </div>`,
    }));
    // 1200x630 EXACTLY — the size every unfurl service expects, so dsf 1.
    await shot(cdp, {
      url: `file://${join(WORK, "og.html")}`, width: 1200, height: 630,
      out: join(WORK, "og.png"), dsf: 1,
      select: `() => ({ x: 0, y: 0, width: 1200, height: 630 })`,
    });

    cdp.close();
  } finally {
    chrome.kill();
  }

  // ---- encode --------------------------------------------------------------
  // WebP for the page (every browser Sendset supports reads it), PNG for the
  // link-preview card, where the consumers are other people's unfurl services.
  // WebP for the page — every browser that can render a Sendset reads it, and
  // it is roughly a third of the PNG on this material. Each asset gets a 1x
  // twin so a phone on a slow connection is not made to download a retina file
  // it cannot show.
  const webp = (src, dst, q, resize) =>
    execFileSync("cwebp", ["-q", String(q), "-m", "6", "-quiet",
      ...(resize ? ["-resize", String(resize), "0"] : []),
      join(WORK, src), "-o", join(OUT, dst)]);
  webp("hero.png", "hero.webp", 80);
  webp("hero.png", "hero@1x.webp", 76, 374);
  webp("formats-wide.png", "formats-wide.webp", 78);
  webp("formats-wide.png", "formats-wide@1x.webp", 74, 768);
  webp("formats-narrow.png", "formats-narrow.webp", 78);
  webp("formats-narrow.png", "formats-narrow@1x.webp", 74, 342);
  webp("workout-after.png", "workout-after.webp", 80);
  webp("workout-after.png", "workout-after@1x.webp", 76, 390);

  // THE LINK CARD IS A PHOTOGRAPH OF A PHOTOGRAPH, so it is a JPEG. A PNG of
  // this material is ~450KB for no visible gain, and every unfurl service that
  // matters — iMessage, Slack, WhatsApp, X, LinkedIn, Facebook — has read JPEG
  // for as long as they have read anything.
  execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "78",
    join(WORK, "og.png"), "--out", join(ROOT, "public", "og.jpg")], { stdio: "ignore" });

  const size = (p) => (readFileSync(p).length / 1024).toFixed(1) + " KB";
  for (const f of ["hero.webp", "hero@1x.webp", "formats-wide.webp",
                   "formats-wide@1x.webp", "formats-narrow.webp", "formats-narrow@1x.webp",
                   "workout-after.webp", "workout-after@1x.webp"])
    console.log(`  public/marketing/${f.padEnd(18)} ${size(join(OUT, f))}`);
  console.log(`  public/og.jpg${" ".repeat(19)} ${size(join(ROOT, "public", "og.jpg"))}`);
  if (!existsSync(join(OUT, "hero.webp"))) throw new Error("nothing was written");
}

main().catch((e) => { console.error(e); process.exit(1); });
