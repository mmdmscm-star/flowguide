// ONE TREATMENT, FOUR RENDERERS.
//
// The recipient page said its ink was #1a1a1a; print and email said #1f2328.
// The muted text was #6b7280 on screen and #5b6570 on paper. Nothing recorded
// that these were meant to be one decision, so nothing noticed they had stopped
// being one. This pins the contract that replaced that: the treatment layer
// decides, the renderers resolve.
//
// DELIBERATELY NOT "no renderer may contain a colour literal". A print
// stylesheet's page geometry, a mail client's font stack and a screen preview's
// backdrop are medium-specific implementation detail and belong where they are.
// What is pinned is that the TREATMENT-CRITICAL roles come from one place.
process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TREATMENT, treatmentFor, webVars, printVars,
         type Medium } from "./style/treatment.ts";
import { renderPacketEmail, renderPacketEmailText } from "./email-render.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8");
const codeOf = (p: string) =>
  raw(p).replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");

const MEDIA: Medium[] = ["web", "print", "email"];
const T = DEFAULT_TREATMENT;

// ---------------------------------------------------------------------------
// 1. THE SHAPE
// ---------------------------------------------------------------------------

test("EVERY ROLE IS ANSWERED FOR EVERY VISUAL MEDIUM", () => {
  const roles = [
    ...Object.entries(T.colors), ...Object.entries(T.type), ...Object.entries(T.rhythm),
  ];
  assert.equal(roles.length, 8 + 5 + 3, "a role was added or removed without a decision");
  for (const [name, byMedium] of roles)
    for (const m of MEDIA)
      assert.ok(String((byMedium as Record<string, string>)[m] ?? "").trim(),
        `${name} has no answer for ${m}`);
});

test("A ROLE MAY DIFFER BY MEDIUM — that is the point, not a bug", () => {
  // Amber on a screen, a bordered panel that survives a mono laser printer, and
  // a table cell Outlook understands are three correct answers to one intent.
  assert.notEqual(T.colors.ink.web, T.colors.ink.print);
  assert.notEqual(T.type.pageTitle.web, T.type.pageTitle.email);
  // And each medium's units are its own: rem on screen, points on paper.
  assert.match(T.type.pageTitle.web, /rem$/);
  assert.match(T.type.pageTitle.print, /pt$/);
  assert.match(T.type.pageTitle.email, /px$/);
});

test("SELECTION IS ALREADY SHAPED FOR A FUTURE style_treatment", () => {
  // treatmentFor takes the packet, so the call sites do not move when a column
  // selects between several. Today there is one, so every packet gets it.
  assert.equal(treatmentFor().name, "default");
  assert.equal(treatmentFor({ slug: "a" }), treatmentFor({ slug: "b" }));
  // And nothing persists a treatment yet — this slice adds no column.
  const migrations = readFileSync(join(ROOT, "supabase/schema.sql"), "utf8");
  assert.ok(!/style_treatment/.test(migrations), "a style column appeared in the schema");
  assert.ok(!/style_treatment/.test(codeOf("src/lib/queries.ts")),
    "the query layer reads a column that does not exist");
});

// ---------------------------------------------------------------------------
// 2. THE RENDERERS CONSUME IT
// ---------------------------------------------------------------------------

test("WEB: the packet surface publishes the treatment, and the components read it", () => {
  const vars = webVars(T);
  assert.equal(vars["--sg-ink"], T.colors.ink.web);
  assert.equal(vars["--sg-page-title"], T.type.pageTitle.web);
  assert.equal(vars["--sg-item-gap"], T.rhythm.itemGap.web);

  // Both web surfaces put them on the element that wraps the Sendset.
  for (const page of ["src/app/p/[slug]/page.tsx", "src/app/preview/[id]/page.tsx"])
    assert.match(codeOf(page), /style=\{webVars\(treatmentFor\(packet\)\) as React\.CSSProperties\}/,
      `${page} does not publish the treatment`);

  // And the packet components read the roles rather than holding literals.
  for (const [file, role] of [
    ["src/components/packet-header.tsx", "--sg-page-title"],
    ["src/components/section-group.tsx", "--sg-section-title"],
    ["src/components/item-card.tsx", "--sg-item-title"],
  ] as const)
    assert.ok(codeOf(file).includes(role), `${file} does not read ${role}`);

  const card = codeOf("src/components/item-card.tsx");
  for (const role of ["--sg-ink", "--sg-line", "--sg-surface", "--sg-accent",
                      "--sg-highlight-ground", "--sg-highlight-ink", "--sg-highlight-rule"])
    assert.ok(card.includes(role), `the card does not read ${role}`);
  // The CLIENT HIGHLIGHT no longer names a colour of its own. Scoped to that
  // block rather than to the whole file: the link-type chips carry their own
  // per-type accents, which are UI affordance rather than treatment, and a
  // blanket "no amber anywhere" rule would forbid them for no reason.
  const highlight = card.slice(card.indexOf("item.highlight?.trim()"),
                               card.indexOf("audience === \"professional\""));
  assert.ok(highlight.length > 80, "the highlight block moved; re-scope this");
  assert.ok(!/amber/.test(highlight), "the highlight still carries its own palette");
  assert.ok(highlight.includes("--sg-highlight-ground") && highlight.includes("--sg-highlight-ink"),
    "the highlight does not read its treatment roles");
});

test("PRINT: the stylesheet reads the treatment the page publishes", () => {
  const css = raw("src/app/p/[slug]/print/print.css");
  const page = codeOf("src/app/p/[slug]/print/page.tsx");
  assert.match(page, /printVars\(treatment\)/, "the print page does not publish the treatment");
  const emitted = printVars(T);
  for (const role of ["--pg-ink", "--pg-muted", "--pg-line", "--pg-highlight-ground",
                      "--pg-highlight-rule", "--pg-page-title", "--pg-section-title",
                      "--pg-item-title", "--pg-small"]) {
    assert.ok(emitted.includes(`${role}:`), `printVars omits ${role}`);
    assert.ok(css.includes(`var(${role})`), `print.css does not read ${role}`);
  }
  // The treatment-critical literals are gone from the stylesheet.
  for (const gone of ["#1f2328", "#5b6570", "#e3e6ea", "#fdf8ec", "#c8a951", "#e8d9a8"])
    assert.ok(!css.includes(gone), `print.css still decides ${gone} for itself`);
  // Page geometry stays local: it is how paper works, not how a Sendset looks.
  assert.match(css, /@page/, "the print stylesheet lost its page setup");
});

test("EMAIL: the palette and the scale come from the treatment", () => {
  const src = codeOf("src/lib/email-render.ts");
  assert.match(src, /const T = treatmentFor\(\)/, "email does not read the treatment");
  for (const bind of ["T.colors.ink.email", "T.colors.muted.email", "T.colors.line.email",
                      "T.colors.accent.email", "T.colors.surface.email",
                      "T.colors.highlightInk.email", "T.type.pageTitle.email"])
    assert.ok(src.includes(bind), `email does not bind ${bind}`);
  for (const gone of ["#1f2328", "#5b6570", "#e3e6ea", "#1a56db", "#fdf8ec", "#c8a951", "#6b5518"])
    assert.ok(!src.includes(gone), `email still decides ${gone} for itself`);
  // The font stack stays local — it is what Outlook will render, not a look.
  assert.match(src, /const FONT = "-apple-system/, "the email font stack moved into the treatment");
});

test("PLAIN TEXT IS CONTENT-SEMANTIC ONLY", () => {
  // It has no typography to decide, and giving it a palette would invite one.
  const src = codeOf("src/lib/email-render.ts");
  const text = src.slice(src.indexOf("export function renderPacketEmailText"));
  for (const styling of ["SIZE.", "INK", "MUTED", "LINE", "HL_", "font-size", "color:"])
    assert.ok(!text.includes(styling), `the plain-text flavour applies ${styling}`);
  assert.ok(!("web" in ({} as Record<string, unknown>)) || true);
});

// ---------------------------------------------------------------------------
// 3. APPEARANCE IS PRESERVED — this slice moves decisions, it does not make them
// ---------------------------------------------------------------------------

test("EVERY VALUE IS WHAT THAT MEDIUM ALREADY RENDERED", () => {
  // Pinned literally, because the one thing that must not happen in a
  // centralisation is an incidental redesign riding along with it.
  assert.deepEqual(T.colors.ink,     { web: "#1a1a1a", print: "#1f2328", email: "#1f2328" });
  assert.deepEqual(T.colors.muted,   { web: "#6b7280", print: "#5b6570", email: "#5b6570" });
  assert.deepEqual(T.colors.line,    { web: "#e5e7eb", print: "#e3e6ea", email: "#e3e6ea" });
  assert.deepEqual(T.colors.accent,  { web: "#2563eb", print: "#5b6570", email: "#1a56db" });
  assert.deepEqual(T.colors.surface, { web: "#f9fafb", print: "#f4f5f7", email: "#f4f5f7" });
  assert.equal(T.type.pageTitle.email, "26px");
  assert.equal(T.type.sectionTitle.print, "14pt");
  // The web values still match the app-wide theme they were taken from, so the
  // creator's surfaces and the recipient's read the same.
  const globals = raw("src/app/globals.css");
  assert.ok(globals.includes(`--color-foreground: ${T.colors.ink.web}`));
  assert.ok(globals.includes(`--color-muted: ${T.colors.muted.web}`));
  assert.ok(globals.includes(`--color-border: ${T.colors.line.web}`));
  assert.ok(globals.includes(`--color-accent: ${T.colors.accent.web}`));
});

test("THE EMAIL STILL RENDERS EXACTLY WHAT IT DID", () => {
  const packet = {
    slug: "abc", title: "T", clientTitle: "Spring Lake Village", clientName: "the Alvarez family",
    personalNote: null, compositionMode: "legacy", professional: { name: "Dana" },
    sections: [{ id: "s1", title: "Options", description: "In order of fit.", items: [{
      id: "i1", title: "Little River", description: "A warm community.",
      highlight: "I'd start here.",
      details: [{ label: "Monthly Fee", value: "$6,396" }],
    }] }],
  } as never;
  const html = renderPacketEmail(packet, { liveUrl: "https://sendset.io/p/abc" });
  // The exact values the four module constants used to hold.
  assert.ok(html.includes("#1f2328"), "the email ink changed");
  assert.ok(html.includes("#5b6570"), "the email muted changed");
  assert.ok(html.includes("#e3e6ea"), "the email rule changed");
  assert.ok(html.includes("font-size:26px"), "the email page title changed");
  assert.ok(html.includes("font-size:22px"), "the email section title changed");
  assert.ok(html.includes("font-size:19px"), "the email item title changed");
  assert.ok(html.includes("#fdf8ec") && html.includes("#6b5518"), "the highlight changed");
  // And the plain-text flavour carries no styling at all.
  const text = renderPacketEmailText(packet, { liveUrl: "https://sendset.io/p/abc" });
  assert.ok(!/#[0-9a-f]{6}|font-size|px|pt\b/i.test(text), "the plain-text flavour gained styling");
});

// ---------------------------------------------------------------------------
// 4. PREVIEW PARITY
// ---------------------------------------------------------------------------

test("PREVIEW RENDERS THE COMPOSITION THE RECIPIENT PAGE RENDERS", () => {
  const live = codeOf("src/app/p/[slug]/page.tsx");
  const preview = codeOf("src/app/preview/[id]/page.tsx");
  const branch = /packet\.compositionMode === "blocks" \? \([\s\S]{0,200}PacketBlockBody/;
  assert.match(live, branch, "the recipient page lost its block branch");
  assert.match(preview, branch, "Preview still renders sections for a block packet");

  // And the data layer actually loads them, or the branch is decoration.
  const q = codeOf("src/lib/queries.ts");
  assert.match(q, /if \(packet\.composition_mode === "blocks"\) \{[\s\S]{0,400}buildBlockPacket\(supabase, packet, profile\)/,
    "the editor path never loads blocks, so Preview's branch can never fire");
  assert.equal((q.match(/buildBlockPacket\(supabase, packet, profile\)/g) ?? []).length, 2,
    "the published and editor paths do not share one block assembly");

  // The map button drifted to a different size in Preview. Same control, same size.
  const mapClass = /rounded-xl bg-accent hover:bg-accent-hover text-white text-base font-medium/;
  assert.match(live, mapClass);
  assert.match(preview, mapClass, "Preview's map button is still a different size");

  // The deliberate difference stays deliberate.
  assert.match(preview, /audience="professional"/, "Preview stopped declaring itself");
  assert.ok(!/audience="professional"/.test(live), "the recipient page declares itself professional");
  assert.match(preview, /<PreviewActions/, "the Preview banner is gone");
});
