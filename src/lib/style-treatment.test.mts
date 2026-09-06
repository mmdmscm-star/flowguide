// ONE TREATMENT, FOUR RENDERERS — AND NOW MORE THAN ONE TREATMENT.
//
// The recipient page said its ink was #1a1a1a; print and email said #1f2328.
// Nothing recorded that these were meant to be one decision, so nothing noticed
// they had stopped being one. Slice 1 pinned the contract that replaced that.
// This slice adds two more treatments, and the thing that must be pinned hardest
// is that DEFAULT DID NOT MOVE: the shipped Sendset look is a first-class
// treatment, not a starting point that gets edited on the way to a second one.
//
// DELIBERATELY NOT "no renderer may contain a colour literal". A print
// stylesheet's page geometry, a mail client's font stack and a screen preview's
// backdrop are medium-specific implementation detail and belong where they are.
// What is pinned is that the TREATMENT-CRITICAL roles come from one place, that
// every variable a renderer reads is one the treatment layer emits, and that no
// renderer anywhere asks WHICH treatment it is wearing.
process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TREATMENT, WARM_TREATMENT, EDITORIAL_TREATMENT, TREATMENTS,
         TREATMENT_NAMES, treatmentFor, treatmentByName, webVars, printVars,
         emailStyle, linkPalettes, LINK_TYPE_NAMES,
         type Medium, type TreatmentDefinition } from "./style/treatment.ts";
import { renderPacketEmail, renderPacketEmailText } from "./email-render.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8");
const codeOf = (p: string) =>
  raw(p).replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");

const MEDIA: Medium[] = ["web", "print", "email"];
const T = DEFAULT_TREATMENT;

/** THE RECIPIENT-FACING SURFACE, named rather than globbed.
 *
 *  src/components also holds creator surfaces — the import progress panel, the
 *  ownership screens, the publish banner — which never wear a treatment and are
 *  free to use the app's own theme tokens. Globbing the directory would make
 *  this file assert things about them that are not true. Existence is checked
 *  below so a rename cannot silently empty the list. */
const PACKET_FILES = [
  "src/components/packet-header.tsx",
  "src/components/personal-note.tsx",
  "src/components/section-group.tsx",
  "src/components/section-contents.tsx",
  "src/components/item-card.tsx",
  "src/components/packet-block-body.tsx",
  "src/components/professional-footer.tsx",
  "src/components/photo-gallery.tsx",
  "src/components/preview-surface.tsx",
  "src/app/p/[slug]/page.tsx",
  "src/app/preview/[id]/page.tsx",
];

test("THE RECIPIENT SURFACE IS THE ONE THIS FILE THINKS IT IS", () => {
  for (const f of PACKET_FILES) assert.ok(raw(f).length > 0, `${f} is gone`);
  // Every component the recipient page and Preview actually mount.
  const mounted = new Set<string>();
  for (const f of ["src/app/p/[slug]/page.tsx", "src/app/preview/[id]/page.tsx",
                   "src/components/section-group.tsx", "src/components/packet-block-body.tsx",
                   "src/components/item-card.tsx"])
    for (const m of codeOf(f).matchAll(/from "\.\/([a-z-]+)"|from "@\/components\/([a-z-]+)"/g))
      mounted.add(`src/components/${m[1] ?? m[2]}.tsx`);
  // Preview mounts one piece of CREATOR CHROME above the Sendset — the publish
  // banner. It is not part of what a client sees and wears no treatment, which
  // is exactly why it is named here rather than quietly skipped.
  const CHROME = ["src/components/preview-actions.tsx"];
  for (const f of mounted)
    assert.ok(PACKET_FILES.includes(f) || CHROME.includes(f),
      `${f} is mounted into a Sendset but not covered here`);
});

// ---------------------------------------------------------------------------
// 1. THE SHAPE
// ---------------------------------------------------------------------------

test("EVERY ROLE IS ANSWERED FOR EVERY VISUAL MEDIUM, BY EVERY TREATMENT", () => {
  for (const t of TREATMENTS) {
    const roles: [string, unknown][] = [
      ...Object.entries(t.colors), ...Object.entries(t.type), ...Object.entries(t.leading),
      ...Object.entries(t.rhythm), ...Object.entries(t.radius), ...Object.entries(t.weight),
      ...Object.entries(t.tracking), ...Object.entries(t.fonts),
      ["thumbRadius", t.thumbRadius],
    ];
    for (const [name, byMedium] of roles)
      for (const m of MEDIA)
        assert.ok(String((byMedium as Record<string, string>)[m] ?? "").trim(),
          `${t.name}: ${name} has no answer for ${m}`);
    for (const type of LINK_TYPE_NAMES)
      for (const part of ["ink", "ground", "hover", "rule"] as const)
        for (const m of MEDIA)
          assert.ok(String(t.linkTypes[type][part][m] ?? "").trim(),
            `${t.name}: link ${type}.${part} has no answer for ${m}`);
    for (const scalar of [t.imageAspect, t.printHeroHeight, t.printDocSize, t.printDocLeading])
      assert.ok(String(scalar).trim(), `${t.name} left a scalar blank`);
    assert.ok(t.label.trim() && t.blurb.trim(), `${t.name} has no name a professional can read`);
  }
});

test("A ROLE MAY DIFFER BY MEDIUM — that is the point, not a bug", () => {
  assert.notEqual(T.colors.ink.web, T.colors.ink.print);
  assert.notEqual(T.type.pageTitle.web, T.type.pageTitle.email);
  assert.match(T.type.pageTitle.web, /rem$/);
  assert.match(T.type.pageTitle.print, /pt$/);
  assert.match(T.type.pageTitle.email, /px$/);
  // And the two new treatments name a WEB face by variable and a print/email
  // face by stack, because a webfont in Outlook does not degrade, it disappears.
  for (const t of [WARM_TREATMENT, EDITORIAL_TREATMENT]) {
    assert.match(t.fonts.display.web, /^var\(--font-/, `${t.name} hard-codes a web family`);
    assert.ok(!t.fonts.display.email.includes("var("), `${t.name} sends a webfont to email`);
    assert.ok(!t.fonts.body.print.includes("var("), `${t.name} sends a webfont to paper`);
    assert.match(t.fonts.display.email, /Georgia/, `${t.name}'s email face is not web-safe`);
  }
  // Default's web face is the one the root layout already loads.
  assert.ok(T.fonts.display.web.includes("--font-geist-sans"));
  const layout = codeOf("src/app/layout.tsx");
  for (const v of ["--font-geist-sans", "--font-newsreader", "--font-source-sans", "--font-source-serif"])
    assert.ok(layout.includes(v), `the root layout does not declare ${v}`);
  // Only the face every Sendset wears today is preloaded; the rest are worn by
  // a treatment nobody has selected yet.
  assert.equal((layout.match(/preload: false/g) ?? []).length, 3,
    "a treatment face is preloaded, or one stopped being");
});

// ---------------------------------------------------------------------------
// 2. THE REGISTRY, AND THE ABSENCE OF PERSISTENCE
// ---------------------------------------------------------------------------

test("THE PERSISTED NAME IS THE ONE SOURCE OF TRUTH", () => {
  assert.deepEqual([...TREATMENT_NAMES], ["default", "warm", "editorial"]);
  assert.equal(treatmentByName("warm"), WARM_TREATMENT);
  assert.equal(treatmentByName("EDITORIAL"), EDITORIAL_TREATMENT);
  // Unknown is not an error: a row can hold a treatment that has since been
  // withdrawn, and a packet built before the column existed carries nothing.
  // Neither may blank a recipient's page.
  for (const bad of ["", "   ", "nope", null, undefined, "../../etc"])
    assert.equal(treatmentByName(bad), DEFAULT_TREATMENT, `${String(bad)} did not fall back`);

  // treatmentFor now READS the packet.
  assert.equal(treatmentFor({ styleTreatment: "warm" }), WARM_TREATMENT);
  assert.equal(treatmentFor({ styleTreatment: "editorial" }), EDITORIAL_TREATMENT);
  assert.equal(treatmentFor({ styleTreatment: "default" }), DEFAULT_TREATMENT);
  for (const bad of [undefined, null, "", "nope"])
    assert.equal(treatmentFor({ styleTreatment: bad as string }), DEFAULT_TREATMENT);
  assert.equal(treatmentFor(), DEFAULT_TREATMENT);
  assert.equal(treatmentFor(null), DEFAULT_TREATMENT);

  // EVERY assembly path carries the column. The published block branch is the
  // one that had already forgotten show_quick_nav; a treatment is not inert
  // there, so it is carried inside the SHARED assembly rather than by each
  // caller remembering.
  const q = codeOf("src/lib/queries.ts");
  assert.equal((q.match(/styleTreatment: packet\.style_treatment/g) ?? []).length, 3,
    "the three packet builders do not all carry style_treatment");
  const block = q.slice(q.indexOf("async function buildBlockPacket"), q.indexOf("export async function assembleItemsByIds"));
  assert.ok(block.includes("styleTreatment: packet.style_treatment"),
    "the shared block assembly does not carry the treatment");
  assert.ok(block.includes("showQuickNav: packet.show_quick_nav"),
    "the shared block assembly still drops show_quick_nav");
  assert.ok(!/showQuickNav: packet\.show_quick_nav !== false \}/.test(q),
    "a caller is still attaching showQuickNav after the fact");

  // The column exists, and 0049 is what created it.
  const m = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => /style/.test(f));
  assert.deepEqual(m, ["0049_packet_style_treatment.sql"]);
});

test("THE PROTOTYPE OVERRIDE IS GONE — ONE SOURCE OF TRUTH", () => {
  // The file itself.
  assert.throws(() => raw("src/lib/style/prototype-style.ts"), "prototype-style.ts is still here");
  // …and every route that used to consult a query parameter.
  for (const f of ["src/app/p/[slug]/page.tsx", "src/app/p/[slug]/print/page.tsx",
                   "src/app/preview/[id]/page.tsx", "src/app/api/packets/[id]/email/route.ts",
                   "src/components/preview-actions.tsx", "src/lib/email-render.ts"]) {
    const src = codeOf(f);
    assert.ok(!/prototypeTreatment|\?style=|searchParams\.style|styleOverride|"style"\)/.test(src),
      `${f} still consults a style query parameter`);
  }
  // The three recipient-facing renderers resolve from the packet, nothing else.
  assert.match(codeOf("src/app/p/[slug]/page.tsx"), /webVars\(treatmentFor\(packet\)\)/);
  assert.match(codeOf("src/app/p/[slug]/print/page.tsx"), /const treatment = treatmentFor\(packet\)/);
  assert.match(codeOf("src/lib/email-render.ts"), /emailStyle\(treatmentFor\(packet\)\)/);
  // renderPacketEmail no longer takes an override argument at all.
  assert.match(codeOf("src/lib/email-render.ts"),
    /export function renderPacketEmail\(packet: Packet, opts: EmailRenderOptions\): string/);
});

test("THE WRITE PATH VALIDATES AGAINST THE REGISTRY, NOT A SECOND LIST", () => {
  const route = codeOf("src/app/api/packets/[id]/route.ts");
  assert.match(route, /import \{ TREATMENT_NAMES \} from "@\/lib\/style\/treatment"/);
  assert.match(route, /styleTreatment: "style_treatment"/, "the column is not mapped");
  assert.match(route, /!TREATMENT_NAMES\.includes\(body\.styleTreatment\)/,
    "validation does not derive from the registry");
  assert.match(route, /status: 400/, "an invalid treatment does not 400");
  // No hardcoded treatment list anywhere in the route.
  for (const name of ["warm", "editorial"])
    assert.ok(!new RegExp(`"${name}"`).test(route), `the route hardcodes "${name}"`);
});

test("DUPLICATING A SENDSET COPIES ITS PRESENTATION, BY VALUE", () => {
  const dup = codeOf("src/app/api/packets/[id]/duplicate/route.ts");
  assert.match(dup, /style_treatment: original\.style_treatment \|\| "default"/);
  // The pre-existing defect this package found: the duplicate silently reset it.
  assert.match(dup, /show_quick_nav: original\.show_quick_nav !== false/);
  // A copy, never a reference — there is no id or foreign key involved.
  assert.ok(!/style_treatment_id|styleRef/.test(dup));
});

test("NO RENDERER ASKS WHICH TREATMENT IT IS WEARING", () => {
  // The treatment is the source of intent; renderers resolve values. A name
  // comparison outside the treatment layer is the failure mode this whole
  // design exists to prevent.
  // preview-surface.tsx is the SELECTOR: choosing between named treatments is
  // its entire job, so it is excluded here by name rather than by accident.
  const files = [...PACKET_FILES.filter((f) => !f.endsWith("preview-surface.tsx")),
                 "src/lib/email-render.ts", "src/app/p/[slug]/print/page.tsx",
                 "src/app/p/[slug]/page.tsx", "src/app/preview/[id]/page.tsx"];
  for (const f of files) {
    const src = codeOf(f);
    assert.ok(!/"(warm|editorial)"/.test(src), `${f} names a treatment`);
    assert.ok(!/\.name\s*===/.test(src), `${f} branches on a treatment name`);
    assert.ok(!/\.modes\./.test(src), `${f} reads a mode instead of a resolved value`);
  }
  // print.css cannot name one either — it only reads variables.
  assert.ok(!/warm|editorial/i.test(raw("src/app/p/[slug]/print/print.css")));
});

// ---------------------------------------------------------------------------
// 3. THE RENDERERS CONSUME IT — COMPLETELY
// ---------------------------------------------------------------------------

test("WEB: every --sg-* a renderer reads is one the treatment emits", () => {
  const emitted = new Set(Object.keys(webVars(T)));
  // globals.css both reads variables and defines the one mask URL that is not a
  // treatment decision.
  const globals = raw("src/app/globals.css");
  const defined = new Set([...globals.matchAll(/^\s*(--sg-[a-z-]+):/gm)].map((m) => m[1]));
  const read = new Set<string>();
  for (const f of [...PACKET_FILES, "src/app/globals.css"])
    // A name ending in "-" is a template literal the component composes at
    // runtime — `var(--sg-link-${type}-ink)`. Those are checked below, per type.
    for (const m of raw(f).matchAll(/var\((--sg-[a-z-]+)/g))
      if (!m[1].endsWith("-")) read.add(m[1]);
  assert.ok(read.size > 30, "the scan found almost nothing; the pattern is wrong");
  for (const v of read)
    assert.ok(emitted.has(v) || defined.has(v),
      `${v} is read by a renderer but never emitted by the treatment`);
  // The link-type palette is emitted per type, and the component composes the
  // name rather than branching.
  for (const type of LINK_TYPE_NAMES)
    assert.ok(emitted.has(`--sg-link-${type}-ink`), `no palette for ${type}`);
  assert.ok(codeOf("src/components/item-card.tsx").includes("`var(--sg-link-${type}-ink)`"),
    "the card no longer composes the palette name");

  // Both web surfaces publish the treatment on the element that wraps a Sendset.
  assert.match(codeOf("src/app/p/[slug]/page.tsx"),
    /style=\{webVars\(treatmentFor\(packet\)\) as React\.CSSProperties\}/,
    "the recipient page does not publish the packet's treatment");
  // Preview publishes through the selector surface, which is the only place a
  // click can change the variables without a round trip.
  assert.match(codeOf("src/components/preview-surface.tsx"),
    /style=\{webVars\(treatmentByName\(sel\.shown\)\) as React\.CSSProperties\}/,
    "Preview does not publish the chosen treatment");
  assert.match(codeOf("src/app/preview/[id]/page.tsx"),
    /persisted=\{packet\.styleTreatment\}/, "Preview does not seed the selector from the column");
  for (const page of ["src/app/p/[slug]/page.tsx", "src/components/preview-surface.tsx"])
    assert.ok(codeOf(page).includes("sg-packet"), `${page} does not mark the packet surface`);
});

test("WEB: the treatment-critical literals are gone from the recipient components", () => {
  // Not "no literal anywhere" — a YouTube play button is a brand affordance and
  // stays red. What is pinned is that the roles a treatment must be able to move
  // no longer live in a component.
  const gone = ["bg-blue-50", "border-blue-100", "text-gray-600", "text-gray-500",
                "bg-surface", "border-border", "bg-card", "text-foreground/80",
                "text-muted/40", "bg-accent hover:"];
  // preview-surface.tsx is creator chrome around the Sendset — its own frame,
  // labels and selected-state ring are drawn in the APP's tokens on purpose, so
  // that "which one is chosen" can never be mistaken for part of the sample.
  for (const f of PACKET_FILES.filter((f) => !f.endsWith("preview-surface.tsx"))) {
    const src = codeOf(f);
    for (const g of gone)
      assert.ok(!src.includes(g), `${f} still decides ${g} for itself`);
  }
  // The client highlight carries no palette of its own.
  const card = codeOf("src/components/item-card.tsx");
  const highlight = card.slice(card.indexOf("item.highlight?.trim()"),
                               card.indexOf('audience === "professional"'));
  assert.ok(highlight.length > 80, "the highlight block moved; re-scope this");
  assert.ok(!/amber|#/.test(highlight), "the highlight still carries its own palette");
  assert.ok(highlight.includes("--sg-highlight-bg") && highlight.includes("--sg-highlight-ink"));
});

test("PRINT: every --pg-* the stylesheet reads is one printVars emits", () => {
  const css = raw("src/app/p/[slug]/print/print.css");
  const emitted = new Set([...printVars(T).matchAll(/(--pg-[a-z-]+):/g)].map((m) => m[1]));
  const defined = new Set([...css.matchAll(/^\s*(--pg-[a-z-]+):/gm)].map((m) => m[1]));
  const read = new Set([...css.matchAll(/var\((--pg-[a-z-]+)/g)].map((m) => m[1]));
  assert.ok(read.size > 20, "the scan found almost nothing; the pattern is wrong");
  for (const v of read)
    assert.ok(emitted.has(v) || defined.has(v), `print.css reads ${v}, which nothing emits`);
  assert.match(codeOf("src/app/p/[slug]/print/page.tsx"), /printVars\(treatment\)/);

  // The treatment-critical literals are gone.
  for (const g of ["#1f2328", "#5b6570", "#e3e6ea", "#fdf8ec", "#c8a951",
                   "#3a4450", "#8b949e", "#d8dce1"])
    assert.ok(!css.includes(g), `print.css still decides ${g} for itself`);

  // PAGINATION IS NOT A TREATMENT DECISION and stays exactly where it is.
  for (const kept of ["@page", "break-inside", "orphans: 2", "print-color-adjust",
                      "size: Letter", "margin: 0.55in 0.6in"])
    assert.ok(css.includes(kept), `print.css lost its ${kept} rule`);
  // The one literal left is the SCREEN preview's ground behind the paper, which
  // is not part of the document.
  const literals = [...css.matchAll(/#[0-9a-f]{6}/g)].map((m) => m[0]);
  assert.deepEqual(literals, ["#f4f5f7"], "a colour literal returned to the stylesheet");
});

test("EMAIL: the palette, the scale and the structure come from the treatment", () => {
  const src = codeOf("src/lib/email-render.ts");
  assert.match(src, /emailStyle\(treatmentFor\(packet\)\)/,
    "email does not resolve the packet's treatment per render");
  for (const gone of ["#1f2328", "#5b6570", "#e3e6ea", "#1a56db", "#fdf8ec", "#c8a951",
                      "#6b5518", "#eef2ff", "#dbe3ff", "-apple-system"])
    assert.ok(!src.includes(gone), `email still decides ${gone} for itself`);
  // The font is now a role, resolved to a web-safe stack per treatment.
  assert.equal(emailStyle(T).FONT, T.fonts.body.email);
  assert.match(emailStyle(EDITORIAL_TREATMENT).FONT, /Georgia/);
});

test("PLAIN TEXT IS CONTENT-SEMANTIC ONLY, AND THE SAME UNDER EVERY TREATMENT", () => {
  const src = codeOf("src/lib/email-render.ts");
  const text = src.slice(src.indexOf("export function renderPacketEmailText"));
  for (const styling of ["SIZE.", "INK", "MUTED", "LINE", "HL_", "font-size", "color:", "emailStyle"])
    assert.ok(!text.includes(styling), `the plain-text flavour applies ${styling}`);
  // It takes no treatment at all — there is nothing for one to say about it.
  assert.match(src,
    /export function renderPacketEmailText\(packet: Packet, opts: EmailRenderOptions\)/);
});

// ---------------------------------------------------------------------------
// 4. DEFAULT DID NOT MOVE
// ---------------------------------------------------------------------------

test("EVERY DEFAULT VALUE IS WHAT THAT MEDIUM ALREADY RENDERED", () => {
  // Pinned literally, because the one thing that must not happen when a second
  // treatment arrives is an incidental redesign of the first.
  assert.deepEqual(T.colors.ink,     { web: "#1a1a1a", print: "#1f2328", email: "#1f2328" });
  assert.deepEqual(T.colors.muted,   { web: "#6b7280", print: "#5b6570", email: "#5b6570" });
  assert.deepEqual(T.colors.line,    { web: "#e5e7eb", print: "#e3e6ea", email: "#e3e6ea" });
  assert.deepEqual(T.colors.accent,  { web: "#2563eb", print: "#5b6570", email: "#1a56db" });
  assert.deepEqual(T.colors.surface, { web: "#f9fafb", print: "#f4f5f7", email: "#f4f5f7" });
  // The exact colours the Tailwind utilities resolved to, so a class swap could
  // not become a colour change.
  assert.equal(T.colors.label.web, "oklch(44.6% 0.03 256.802)");        // text-gray-600
  assert.equal(T.colors.subtle.web, "oklch(55.1% 0.027 264.364)");      // text-gray-500
  assert.equal(T.colors.prose.web, "color-mix(in oklab, #1a1a1a 80%, transparent)"); // /80
  assert.equal(T.colors.faint.web, "color-mix(in oklab, #6b7280 40%, transparent)"); // /40
  assert.equal(T.colors.chipGround.web, "oklch(97% 0.014 254.604)");    // bg-blue-50
  assert.equal(T.colors.chipRule.web, "oklch(93.2% 0.032 255.585)");    // border-blue-100
  assert.equal(T.colors.imageGround.web, "oklch(96.7% 0.003 264.542)"); // bg-gray-100
  // The shipped link-type coding, still four distinct palettes.
  assert.equal(T.modes.linkColor, "by-type");
  const pal = linkPalettes(T);
  assert.equal(new Set(LINK_TYPE_NAMES.map((n) => pal[n].ink.web)).size, 4);
  // The shipped geometry.
  assert.deepEqual(T.modes, { card: "outlined", contacts: "chips", image: "inset",
                              highlight: "filled", sectionDivider: "none", linkColor: "by-type" });
  assert.equal(T.radius.card.web, "0.75rem");   // rounded-xl
  assert.equal(T.radius.inner.web, "0.5rem");   // rounded-lg
  assert.equal(T.weight.title.web, "700");      // font-bold
  assert.equal(T.weight.itemTitle.web, "600");  // font-semibold — the item name was always lighter
  assert.equal(T.weight.itemTitle.print, "700");// but full bold on paper, which is what print.css said
  assert.equal(T.leading.body.web, "1.5rem");   // text-base's own leading
  assert.equal(T.leading.small.web, "1.25rem"); // text-sm's own leading
  assert.equal(T.printDocSize, "10.5pt");
  assert.equal(T.thumbRadius.print, "3px");
  assert.equal(T.imageAspect, "5 / 4");
  // Default draws no separator, no section rule and no mark, because it never did.
  const d = webVars(T);
  assert.equal(d["--sg-item-rule-width"], "0");
  assert.equal(d["--sg-section-rule-width"], "0");
  assert.equal(d["--sg-chip-row-rule"], "none");
  assert.equal(d["--sg-highlight-mark"], "none");
  assert.equal(d["--sg-chip-min-h"], "auto");
  assert.equal(d["--sg-chip-justify"], "normal");
  // The one primary action, exactly as it has always been drawn: an accent
  // ground, white ink, no border, no rule, no minimum height, weight 500 (which
  // is what the `font-medium` class it carries has always resolved to).
  assert.equal(d["--sg-btn-ground"], T.colors.accent.web);
  assert.equal(d["--sg-btn-ink"], T.colors.onAccent.web);
  assert.equal(d["--sg-btn-rule"], "none");
  assert.equal(d["--sg-btn-min-h"], "auto");
  assert.equal(d["--sg-btn-weight"], "500");
  assert.equal(d["--sg-btn-pad"], "0.5rem 1rem");
  assert.equal(d["--sg-faint"], "color-mix(in oklab, #6b7280 40%, transparent)");
  // And on paper the "separator" is the card's own edge, or a boxed card would
  // lose its top border to the rule that draws the separator.
  assert.ok(printVars(T).includes("--pg-item-rule-width:1px"));
  assert.ok(printVars(T).includes("--pg-item-rule-pad:12px"));

  // The web values still match the app-wide theme they were taken from.
  const globals = raw("src/app/globals.css");
  assert.ok(globals.includes(`--color-foreground: ${T.colors.ink.web}`));
  assert.ok(globals.includes(`--color-muted: ${T.colors.muted.web}`));
  assert.ok(globals.includes(`--color-border: ${T.colors.line.web}`));
  assert.ok(globals.includes(`--color-accent: ${T.colors.accent.web}`));
});

const SAMPLE = {
  slug: "abc", title: "T", clientTitle: "Spring Lake Village", clientName: "the Alvarez family",
  personalNote: "A note.", compositionMode: "legacy",
  professional: { name: "Dana", businessName: "Ellison and Co", phone: "2065550100",
                  email: "dana@example.com", footerLabel: "Your advisor" },
  sections: [{ id: "s1", title: "Options", description: "In order of fit.", items: [{
    id: "i1", title: "Little River", description: "A warm community.",
    address: "1 Mill Street", highlight: "Start here.", notes: "PRIVATE-NOTE-MUST-NOT-APPEAR",
    details: [{ label: "Monthly Fee", value: "$6,396" }, { label: "", value: "Fee is refundable." }],
    links: [{ url: "https://example.com/tour.mp4", label: "Tour" }],
    contacts: [{ name: "Ana", role: "Director", phone: "2065550111", email: "ana@example.com" }],
  }] }],
} as never;
const OPTS = { liveUrl: "https://sendset.io/p/abc" };
/** The same packet, wearing a persisted treatment — the real path now. */
const wearing = (name: string) => ({ ...(SAMPLE as object), styleTreatment: name }) as never;

test("THE DEFAULT EMAIL STILL RENDERS EXACTLY WHAT IT DID", () => {
  const html = renderPacketEmail(SAMPLE, OPTS);
  assert.ok(html.includes("#1f2328"), "the email ink changed");
  assert.ok(html.includes("#5b6570"), "the email muted changed");
  assert.ok(html.includes("#e3e6ea"), "the email rule changed");
  assert.ok(html.includes("font-size:26px"), "the email page title changed");
  assert.ok(html.includes("font-size:22px"), "the email section title changed");
  assert.ok(html.includes("font-size:19px"), "the email item title changed");
  assert.ok(html.includes("#fdf8ec") && html.includes("#6b5518"), "the highlight changed");
  assert.ok(html.includes("#eef2ff") && html.includes("#dbe3ff"), "the footer buttons changed");
  assert.ok(html.includes("border-radius:8px"), "the document plate changed");
  assert.ok(html.includes("-apple-system"), "the email font stack changed");
  // A boxed treatment declares no ground it does not need, exactly as before.
  assert.ok(!html.includes("background:transparent"));
});

// ---------------------------------------------------------------------------
// 5. STYLE IS METADATA. IT CANNOT REACH CONTENT.
// ---------------------------------------------------------------------------

const visibleText = (html: string) =>
  html.replace(/<[^>]+>/g, "\n")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'")
      .split("\n").map((s) => s.trim()).filter(Boolean).join("\n");

test("EVERY TREATMENT SAYS EXACTLY THE SAME THING, IN THE SAME ORDER", () => {
  const texts = TREATMENTS.map((t) => visibleText(renderPacketEmail(wearing(t.name), OPTS)));
  for (let i = 1; i < texts.length; i++)
    assert.equal(texts[i], texts[0],
      `${TREATMENTS[i].name} changed the words, their order, or which of them appear`);
  // ...and it is not the same because nothing rendered.
  assert.ok(texts[0].includes("Little River") && texts[0].includes("$6,396")
    && texts[0].includes("Fee is refundable.") && texts[0].includes("Start here."));
  // The private note is a recipient-invisible field under every treatment.
  for (const t of TREATMENTS)
    assert.ok(!renderPacketEmail(wearing(t.name), OPTS).includes("PRIVATE-NOTE-MUST-NOT-APPEAR"),
      `${t.name} leaked the private note`);
  // The plain-text flavour has no treatment to differ by.
  const plain = renderPacketEmailText(SAMPLE, OPTS);
  assert.ok(!/#[0-9a-f]{6}|font-size|Georgia/i.test(plain));
});

test("THE TREATMENTS ARE VISIBLY DIFFERENT, OR THE CHOICE IS A LIE", () => {
  const [d, w, e] = TREATMENTS.map((t) => renderPacketEmail(wearing(t.name), OPTS));
  assert.notEqual(d, w);
  assert.notEqual(d, e);
  assert.notEqual(w, e);
  assert.ok(w.includes(WARM_TREATMENT.colors.accent.email), "Warm's accent never reaches the mail");
  assert.ok(e.includes("Georgia"), "Editorial's face never reaches the mail");
  // Editorial states its destinations as links rather than as filled cells —
  // same destinations, same labels, only the drawing changes.
  assert.equal(emailStyle(EDITORIAL_TREATMENT).BUTTONS_AS_LINKS, true);
  assert.equal(emailStyle(T).BUTTONS_AS_LINKS, false);
});

test("A ROW TREATMENT KEEPS A TAP TARGET, AND THE MARK DECORATES AN EXISTING FIELD", () => {
  const ed = webVars(EDITORIAL_TREATMENT);
  // Removing the chip must not shrink the target: a phone number an older reader
  // cannot hit is not a refinement.
  assert.equal(ed["--sg-chip-min-h"], "44px");
  assert.equal(ed["--sg-chip-width"], "100%");
  assert.match(ed["--sg-chip-row-rule"], /^inset 0 -1px 0 0 /);
  // The one icon is switched by `content`, so a treatment that does not want it
  // generates no box at all rather than a hidden one.
  assert.equal(webVars(T)["--sg-highlight-mark"], "none");
  assert.equal(ed["--sg-highlight-mark"], '""');

  // THE PRIMARY ACTION IS RULED, NOT FILLED — and is the tallest control on the
  // page, not the smallest. Emphasis is carried by height, rule weight and font
  // weight, none of which shrinks the target.
  assert.equal(ed["--sg-btn-ground"], "transparent");
  assert.equal(ed["--sg-btn-ink"], EDITORIAL_TREATMENT.colors.accent.web);
  assert.match(ed["--sg-btn-rule"], /^inset 0 -2px 0 0 /);
  assert.equal(ed["--sg-btn-min-h"], "48px");
  assert.equal(ed["--sg-btn-weight"], "600");
  assert.ok(parseInt(ed["--sg-btn-min-h"]) >= 44, "the primary action fell below a tap target");
  assert.ok(parseInt(ed["--sg-btn-min-h"]) > parseInt(ed["--sg-chip-min-h"]),
    "the primary action is not taller than a secondary row");
  // Warm keeps the filled button. Only the row treatment changes it.
  const w = webVars(WARM_TREATMENT);
  assert.equal(w["--sg-btn-ground"], WARM_TREATMENT.colors.accent.web);
  assert.equal(w["--sg-btn-rule"], "none");
  assert.equal(w["--sg-btn-min-h"], "auto");

  // The footer mark reads more clearly in the two new treatments, and nowhere
  // else. 40% -> 1.7:1 on white; 75% -> ~3:1, measured in a browser.
  assert.equal(webVars(T)["--sg-faint"], "color-mix(in oklab, #6b7280 40%, transparent)");
  assert.match(w["--sg-faint"], /75%/);
  assert.match(ed["--sg-faint"], /75%/);
  const globals = raw("src/app/globals.css");
  assert.match(globals, /\.sg-highlight::before \{\s*content: var\(--sg-highlight-mark, none\);/);
  // It decorates item.highlight and nothing else — no label-derived icons.
  const markRule = globals.slice(globals.indexOf(".sg-highlight::before"),
                                 globals.indexOf("--sg-mark-star: url("));
  assert.ok(!/detail|label|price|value/i.test(markRule), "the mark reads content");
});

test("A TREATMENT CANNOT REACH A FACT", () => {
  // The whole surface of a treatment, enumerated: colours, sizes, leading,
  // rhythm, radii, weights, tracking, faces, six structural modes and four
  // scalars. Nothing here is a string a recipient reads.
  const t: TreatmentDefinition = EDITORIAL_TREATMENT;
  assert.deepEqual(Object.keys(t).sort(), [
    "blurb", "colors", "fonts", "imageAspect", "label", "leading", "linkTypes",
    "modes", "name", "printDocLeading", "printDocSize", "printHeroHeight",
    "radius", "rhythm", "thumbRadius", "tracking", "type", "weight",
  ], "a treatment grew a field — is it presentation?");
  assert.deepEqual(Object.keys(t.modes).sort(),
    ["card", "contacts", "highlight", "image", "linkColor", "sectionDivider"]);
});

// ---------------------------------------------------------------------------
// 6. PREVIEW PARITY
// ---------------------------------------------------------------------------

test("PREVIEW RENDERS THE COMPOSITION THE RECIPIENT PAGE RENDERS", () => {
  const live = codeOf("src/app/p/[slug]/page.tsx");
  const preview = codeOf("src/app/preview/[id]/page.tsx");
  const branch = /packet\.compositionMode === "blocks" \? \([\s\S]{0,200}PacketBlockBody/;
  assert.match(live, branch, "the recipient page lost its block branch");
  assert.match(preview, branch, "Preview still renders sections for a block packet");

  const q = codeOf("src/lib/queries.ts");
  assert.match(q, /if \(packet\.composition_mode === "blocks"\) \{[\s\S]{0,400}buildBlockPacket\(supabase, packet, profile\)/,
    "the editor path never loads blocks, so Preview's branch can never fire");
  assert.equal((q.match(/buildBlockPacket\(supabase, packet, profile\)/g) ?? []).length, 2,
    "the published and editor paths do not share one block assembly");

  // Same control, same size — and now the same treatment.
  const mapClass = /sg-btn-primary flex items-center justify-center gap-2 w-full py-3 font-medium/;
  assert.match(live, mapClass);
  assert.match(preview, mapClass, "Preview's map button is a different control again");

  assert.match(preview, /audience="professional"/, "Preview stopped declaring itself");
  assert.ok(!/audience="professional"/.test(live), "the recipient page declares itself professional");
  assert.match(preview, /<PreviewActions/, "the Preview banner is gone");
});
