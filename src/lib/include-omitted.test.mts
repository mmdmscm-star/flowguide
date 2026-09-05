// "ADD THESE TO THE ITEM" — the runtime half.
//
// 0047 does the writing: one label-less detail per accepted source line, the
// professional's own wording, a leading list bullet removed and a leading '*'
// or '**' kept. These are the application-side rules around it — who may press
// the button, what the browser is allowed to say, and what a detail with no
// label looks like in each of the three places a client can read one.
process.env.FLOWGUIDE_ENFORCE_CONTRACT = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_REQUIRED, dispositionsFor, actionLabel, namesOneItem,
         type ReviewFailure } from "./review-units.ts";
import { renderPacketEmail, renderPacketEmailText } from "./email-render.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const codeOf = (p: string) =>
  readFileSync(join(ROOT, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8");
const PANEL = codeOf("src/components/ImportProgress.tsx");
const ROUTE = codeOf("src/app/api/ingest/[runId]/review/[unitId]/route.ts");
const HOOK = codeOf("src/lib/useIngestion.ts");
const CARD = codeOf("src/components/item-card.tsx");
const PRINT = codeOf("src/components/print/print-packet.tsx");
const PRINT_CSS = raw("src/app/p/[slug]/print/print.css");
const EMAIL = codeOf("src/lib/email-render.ts");

const unit = (kind: string, itemIds?: string[]): ReviewFailure =>
  ({ id: "u", code: "x", kind, text: "a line", ...(itemIds ? { itemIds } : {}) });

// ---------------------------------------------------------------------------
// 1. WHO MAY BE OFFERED IT
// ---------------------------------------------------------------------------

test("INCLUDED IS OFFERED ONLY BY source-details-omitted", () => {
  assert.deepEqual(dispositionsFor(unit("source-details-omitted")),
    ["included", "resolved", "ignored"]);
  for (const kind of Object.keys(REVIEW_REQUIRED))
    if (kind !== "source-details-omitted")
      assert.ok(!dispositionsFor(unit(kind)).includes("included"),
        `${kind} offers to add source lines it is not holding`);
  // A kind that names no dispositions gets the default set, which excludes it.
  assert.ok(!dispositionsFor(unit("nonexistent-kind")).includes("included"),
    "the default answer set now writes recipient-facing content");
});

test("KEPT_PRIVATE IS STILL REFUSED for the omission kind", () => {
  assert.ok(!dispositionsFor(unit("source-details-omitted")).includes("kept_private"),
    "the omission card offers to hide the client's own material from them");
  // And the database refuses it too, which is the guarantee — the registry is
  // application code and this function is SECURITY DEFINER.
  const sql = raw("supabase/migrations/0047_review_include_omitted_details.sql");
  assert.match(sql, /= 'source-details-omitted' then[\s\S]{0,200}keeping it private is not one of its answers/,
    "0047 does not refuse kept_private for this kind");
  assert.match(sql, /<> 'source-details-omitted' then[\s\S]{0,200}included is not one of its answers/,
    "0047 does not restrict included to this kind");
});

test("the BUTTON is hidden unless the unit names exactly one item", () => {
  assert.equal(namesOneItem(unit("source-details-omitted", ["a"])), true);
  assert.equal(namesOneItem(unit("source-details-omitted")), false, "no itemIds counted as one");
  assert.equal(namesOneItem(unit("source-details-omitted", [])), false, "empty itemIds counted as one");
  assert.equal(namesOneItem(unit("source-details-omitted", ["a", "b"])), false, "two items counted as one");
  // The panel asks BOTH questions before rendering it.
  assert.match(PANEL, /dispositionsFor\(f\)\.includes\("included"\) && namesOneItem\(f\)/,
    "the add button is offered without a resolved item to add to");
  // The other two answers are NOT gated on it: they settle without writing.
  const other = PANEL.slice(PANEL.indexOf('resolveUnit(f.id, "resolved")') - 400,
                            PANEL.indexOf('resolveUnit(f.id, "ignored")') + 200);
  assert.ok(!/namesOneItem/.test(other), "settling now requires an item it does not write to");
  // And the server refuses it anyway, so a stale tab cannot get past the panel.
  assert.match(ROUTE, /status === "included" \|\| status === "kept_private"\) && !namesOneItem\(unit\)/,
    "the server offers a writing disposition with nowhere to write");
});

// ---------------------------------------------------------------------------
// 2. WHAT THE BROWSER MAY SAY
// ---------------------------------------------------------------------------

test("THE CLIENT SENDS A DISPOSITION AND NOTHING ELSE", () => {
  const calls = [...PANEL.matchAll(/resolveUnit\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(calls.includes('f.id, "included"'), "the add button does not send `included`");
  for (const c of calls)
    assert.match(c, /^f\.id,\s*"(included|kept_private|resolved|ignored)"$/,
      `a control carries content: ${c}`);
  // The hook posts the status and nothing else.
  assert.match(HOOK, /review\/\$\{encodeURIComponent\(unitId\)\}`, \{ status \}\)/,
    "the hook sends more than the disposition");
  assert.ok(!/text|lines|details/.test(HOOK.slice(HOOK.indexOf("const resolveUnit"), HOOK.indexOf("const resolveUnit") + 400)),
    "the hook sends content back to the server");
  // The route never reads a text field from the body either.
  assert.ok(!/body\?\.(text|lines|details)/.test(ROUTE), "the route accepts content from the client");
});

test("route validation is REGISTRY-DRIVEN, not a list of names", () => {
  assert.match(ROUTE, /dispositionsFor\(unit\)\.includes\(status as ReviewDisposition\)/,
    "the route does not ask the registry about the disposition it was sent");
  // The known-status list exists only to turn a typo into a sentence; the
  // registry is what decides whether this kind may take it.
  assert.match(ROUTE, /const KNOWN: ReviewDisposition\[\]/, "the route lost its shape check");
  for (const kind of Object.keys(REVIEW_REQUIRED))
    assert.ok(!ROUTE.includes(kind), `the route hardcodes ${kind}`);
});

test("A SUCCESSFUL INCLUDE REFRESHES THE ITEM", () => {
  assert.match(HOOK, /status === "kept_private" \|\| status === "included"\) opts\?\.onItemsChanged/,
    "the editor is not told that details were added, so they stay invisible until reload");
  // And still NOT for the two that write nothing.
  const line = HOOK.slice(HOOK.indexOf("onItemsChanged?.()") - 120, HOOK.indexOf("onItemsChanged?.()") + 30);
  assert.ok(!/"resolved"|"ignored"/.test(line), "settling now costs a wasted packet refetch");
});

test("the card's copy says what each answer does", () => {
  const f = unit("source-details-omitted", ["a"]);
  assert.equal(actionLabel(f, "included", "x"), "Add these to the item");
  assert.equal(actionLabel(f, "resolved", "x"), "I added these elsewhere");
  assert.equal(actionLabel(f, "ignored", "x"), "Leave them out");
  // NOT "exactly as your source wrote it" — that would be an overclaim. 0047
  // strips a leading list bullet, and a brochure line wrapped by the
  // transcription was already rejoined before the card ever showed it.
  assert.match(PANEL, /Adding puts each line into this item using your source wording/,
    "the card does not say what adding will do");
  assert.ok(!PANEL.includes("exactly as your source wrote it"),
    "the card promises a fidelity the insertion rule does not give");
  // The panel reads it from the registry; the string beside it is the fallback
  // every other button already carries, for a kind that names no wording.
  assert.match(PANEL, /actionLabel\(f, "included", /,
    "the add button's wording does not come from the registry");
});

// ---------------------------------------------------------------------------
// 3. A DETAIL WITH NO LABEL, IN ALL THREE PLACES A CLIENT CAN READ ONE
// ---------------------------------------------------------------------------

test("WEB: a label-less detail is full width and left aligned", () => {
  assert.match(CARD, /if \(!String\(detail\.label \?\? ""\)\.trim\(\)\) \{/,
    "the web card has no branch for a detail with no label");
  const branch = CARD.slice(CARD.indexOf('if (!String(detail.label ?? "").trim())'),
                            CARD.indexOf('if (atomic) {'));
  assert.ok(!/justify-between|text-right|flex-1|flex-shrink-0/.test(branch),
    "the label-less row still uses the two-column pair layout");
  assert.match(branch, /\{detail\.value\}/, "the label-less row does not render its value");
  // The branch runs BEFORE the atomic/block decision, so a short label-less
  // value cannot fall into the right-aligned column layout either.
  assert.ok(CARD.indexOf('if (!String(detail.label ?? "").trim())') < CARD.indexOf("if (atomic) {"),
    "a short label-less value still reaches the atomic row");
});

test("PRINT: a label-less detail is full width and left aligned", () => {
  assert.match(PRINT, /pg-detail-row pg-detail-row--bare/,
    "print has no label-less variant");
  assert.match(PRINT, /String\(d\?\.label \?\? ""\)\.trim\(\) && <span className="pg-detail-label">/,
    "print renders an empty label span");
  assert.match(PRINT_CSS, /\.pg-detail-row--bare \{ display: block; \}/,
    "the bare row is still a space-between pair");
  assert.match(PRINT_CSS, /\.pg-detail-row--bare \.pg-detail-value \{ text-align: left; \}/,
    "a label-less sentence still prints against the right margin");
});

test("EMAIL: a label-less detail is one full-width cell", () => {
  assert.match(EMAIL, /colspan="2"/, "the email table has no full-width cell");
  const html = renderPacketEmail(EMAIL_FIXTURE, { liveUrl: "https://sendset.io/p/abc" });
  assert.match(html, /colspan="2"[^>]*>\*\*The Community Fee is refundable/,
    "the label-less line is not rendered as one full-width cell");
  assert.match(html, /width:45%">Little River<\/td>/, "a labelled detail stopped rendering as a pair");
});

/** The same item through both email flavours: one labelled detail and two
 *  label-less lines of the kind `included` writes. */
const EMAIL_FIXTURE = {
  slug: "abc", title: "T", clientTitle: "Spring Lake Village", clientName: null,
  personalNote: null, compositionMode: "legacy", professional: { name: "A" },
  sections: [{ id: "s1", title: "Community Information", description: null, items: [{
    id: "i1", title: "Spring Lake Village",
    details: [
      { label: "Little River", value: "$6,396" },
      { label: "Community Fee**", value: "$6,500" },
      { label: "", value: "**The Community Fee is refundable according to the terms of the admission agreement." },
      { label: "", value: "Lake walks, hiking trails and bocce" },
    ],
  }] }],
} as never;

test("PLAIN-TEXT EMAIL: a label-less detail is standalone text, with no stray colon", () => {
  // Traced before the branch existed, this rendered
  //     "  : **The Community Fee is refundable according to the terms ..."
  // — the professional's own source wording behind an orphan colon.
  const lines = renderPacketEmailText(EMAIL_FIXTURE, { liveUrl: "https://sendset.io/p/abc" }).split("\n");
  const find = (needle: string) => lines.find((l) => l.includes(needle)) ?? "";

  assert.equal(find("refundable according"),
    "  **The Community Fee is refundable according to the terms of the admission agreement.",
    "a label-less line still carries an empty-label artefact");
  assert.equal(find("Lake walks"), "  Lake walks, hiking trails and bocce");
  // No line anywhere begins with the artefact.
  for (const l of lines)
    assert.ok(!/^\s*:\s/.test(l), `a line starts with a stray colon: ${JSON.stringify(l)}`);

  // LABELLED DETAILS ARE UNTOUCHED — including one whose label legitimately
  // ends in the footnote markers 0047 preserves.
  assert.equal(find("$6,396"), "  Little River: $6,396");
  assert.equal(find("$6,500"), "  Community Fee**: $6,500");

  // Same indent as every other item line, so it reads as part of the item.
  assert.ok(find("Lake walks").startsWith("  ") && !find("Lake walks").startsWith("   "),
    "the label-less line is indented differently from its neighbours");
});

test("LABELLED DETAILS ARE VISUALLY UNCHANGED", () => {
  // The two-column layouts are still there, untouched, for every detail that
  // has a label. Only the empty-label case takes the new path.
  assert.match(CARD, /justify-between/, "the block row lost its pair layout");
  assert.match(CARD, /flex-shrink-0 whitespace-nowrap text-right/, "the atomic row lost its column");
  assert.match(PRINT_CSS, /\.pg-detail-value \{ text-align: right; overflow-wrap: anywhere; \}/,
    "print's labelled value stopped being right aligned");
  assert.match(EMAIL, /width:45%">\$\{esc\(d\.label\)\}/, "email's labelled pair changed");
});

test("EDITOR ROUND TRIP preserves a label-less row", () => {
  const editor = codeOf("src/components/editor/block-item-editor.tsx");
  // A row survives the save when EITHER field has content. A label-less detail
  // has a value, so it is kept — dropping it would silently delete accepted
  // source material on the professional's next edit.
  assert.match(editor,
    /details\.filter\(\(d\) => String\(d\?\.label \?\? ""\)\.trim\(\) \|\| String\(d\?\.value \?\? ""\)\.trim\(\)\)/,
    "the editor drops a row whose label is empty");
  // And the writer stores an empty label rather than refusing it.
  const sql = raw("supabase/migrations/0033_item_highlight.sql");
  assert.match(sql, /coalesce\(r->>'label', ''\)/, "update_item_content cannot store a label-less detail");
});

// ---------------------------------------------------------------------------
// 4. PHASE 1 IS UNTOUCHED
// ---------------------------------------------------------------------------

test("PHASE 1 OMISSION BEHAVIOUR IS UNCHANGED", () => {
  const omit = codeOf("src/lib/omitted-source.ts");
  assert.ok(!/included|resolve_review_unit|item_details/.test(omit),
    "the omission detector learned about the disposition that answers it");
  const finalize = codeOf("src/app/api/ingest/[runId]/finalize/route.ts");
  assert.equal((finalize.match(/buildOmission\(/g) ?? []).length, 1);
  assert.match(finalize, /omission_check_failed/, "the fail-closed refusal is gone");
  assert.match(finalize, /chunk: -1/, "the unit stopped being run-level");
  // The card still carries the same excerpt and the same headline.
  assert.equal(REVIEW_REQUIRED["source-details-omitted"].headline,
    "Some source details weren't included");
  assert.equal(REVIEW_REQUIRED["source-details-omitted"].code, "source_details_omitted");
});
