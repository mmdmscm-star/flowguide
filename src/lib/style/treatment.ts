// HOW A SENDSET LOOKS, DECIDED ONCE.
//
// Four renderers present the same packet — the recipient page, Preview, print
// and email — and until now each decided independently what its own ink, rule
// and hierarchy were. They had drifted, quietly and reasonably: the web page
// says #1a1a1a, print and email say #1f2328; the web muted is #6b7280 and
// theirs is #5b6570; the link is #2563eb on screen and #1a56db in mail. Nothing
// recorded that these were meant to be one decision, so nothing noticed.
//
// A TREATMENT IS SEMANTIC, AND ITS RESOLUTION IS PER MEDIUM. "This is the
// client highlight" is one intent; amber on a screen, a bordered panel that
// still reads on a mono laser printer, and a table cell that survives Outlook
// are three correct answers to it. So a role holds one value per medium rather
// than one value pretending to work everywhere — and the renderers stop
// choosing.
//
// STYLE IS METADATA, NOT CONTENT. Nothing here can reach a fact, a word, an
// order, a grouping or a provenance record: it is a palette and a scale. A
// future `packets.style_treatment` will select one of these by name, live and
// mutable after publish exactly as `show_quick_nav` is — not frozen into
// professional_snapshot, and deliberately not part of content_rev, because a
// look is not a revision of what was said. That column does not exist yet and
// this slice does not add it; one treatment is the absence of a choice.
//
// WHAT THIS DELIBERATELY IS NOT. Not a design tool. There is no picker, no
// slider and no per-role override: the unit a professional will eventually
// choose is a whole coherent treatment, because a product that lets someone
// assemble their own is a product that lets them assemble a bad one.

/** The three visual media. Plain-text email is absent on purpose: it has no
 *  typography to decide, and giving it a palette would invite one. */
export type Medium = "web" | "print" | "email";

/** One role, answered for each medium. */
export type ByMedium = Readonly<Record<Medium, string>>;

export interface TreatmentColors {
  /** Body text and headings. */
  ink: ByMedium;
  /** Supporting text: labels, captions, the "prepared for" line. */
  muted: ByMedium;
  /** Hairlines: card borders, dividers, detail rows. */
  line: ByMedium;
  /** Links and the one primary action. On paper a link cannot be pressed, so
   *  print resolves this to the colour a printed URL is set in. */
  accent: ByMedium;
  /** The ground a card or panel sits on, one step off the page. */
  surface: ByMedium;
  /** THE CLIENT HIGHLIGHT — the note written for the person reading. Its own
   *  three roles because it is the one place emphasis is carried by colour, and
   *  on paper the rule has to carry it instead when colour does not print. */
  highlightInk: ByMedium;
  highlightGround: ByMedium;
  highlightRule: ByMedium;
}

export interface TreatmentType {
  pageTitle: ByMedium;
  sectionTitle: ByMedium;
  itemTitle: ByMedium;
  body: ByMedium;
  small: ByMedium;
}

export interface TreatmentRhythm {
  /** The margin between the page edge and the content. */
  pageGutter: ByMedium;
  /** Between one section and the next. */
  sectionGap: ByMedium;
  /** Between one item card and the next. */
  itemGap: ByMedium;
}

export interface TreatmentDefinition {
  name: string;
  colors: TreatmentColors;
  type: TreatmentType;
  rhythm: TreatmentRhythm;
}

// ---------------------------------------------------------------------------
// THE ONE TREATMENT.
//
// EVERY VALUE HERE IS WHAT THAT MEDIUM ALREADY RENDERED. This slice moves the
// decisions; it does not make them again. A palette reconciliation would be a
// redesign wearing a refactor's clothes, and it would arrive in the same commit
// as a large mechanical change — the worst possible way to ship a visual
// difference. The three palettes still disagree, on purpose, and now they
// disagree in one file where the disagreement is visible and can be settled
// deliberately later.
// ---------------------------------------------------------------------------
export const DEFAULT_TREATMENT: TreatmentDefinition = {
  name: "default",
  colors: {
    ink:             { web: "#1a1a1a", print: "#1f2328", email: "#1f2328" },
    muted:           { web: "#6b7280", print: "#5b6570", email: "#5b6570" },
    line:            { web: "#e5e7eb", print: "#e3e6ea", email: "#e3e6ea" },
    accent:          { web: "#2563eb", print: "#5b6570", email: "#1a56db" },
    surface:         { web: "#f9fafb", print: "#f4f5f7", email: "#f4f5f7" },
    highlightInk:    { web: "#78350f", print: "#6b5518", email: "#6b5518" },
    highlightGround: { web: "#fffbeb", print: "#fdf8ec", email: "#fdf8ec" },
    highlightRule:   { web: "#fde68a", print: "#c8a951", email: "#c8a951" },
  },
  // UNITS ARE THE MEDIUM'S OWN. Points are what a print stylesheet is written
  // in and pixels are what a mail client understands; converting either into
  // the other's vocabulary would make both harder to read and neither more
  // correct.
  type: {
    pageTitle:    { web: "1.5rem",    print: "19pt",   email: "26px" },
    sectionTitle: { web: "1.25rem",   print: "14pt",   email: "22px" },
    itemTitle:    { web: "1.125rem",  print: "12.5pt", email: "19px" },
    body:         { web: "1rem",      print: "11pt",   email: "16px" },
    small:        { web: "0.875rem",  print: "10pt",   email: "15px" },
  },
  rhythm: {
    pageGutter: { web: "1.25rem", print: "0",      email: "24px" },
    sectionGap: { web: "2rem",    print: "18pt",   email: "14px" },
    itemGap:    { web: "1rem",    print: "10pt",   email: "14px" },
  },
};

/** The treatment a packet wears.
 *
 *  Takes the packet so the call sites are already shaped for the day a
 *  `style_treatment` column selects between several. Today there is one, so the
 *  argument is unused and the answer is the same for everyone — which is the
 *  point: no behaviour depends on a choice nobody has made yet. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function treatmentFor(packet?: unknown): TreatmentDefinition {
  return DEFAULT_TREATMENT;
}

/** The treatment's web half as CSS custom properties.
 *
 *  Emitted onto the element that wraps a rendered Sendset, so the packet
 *  components read the treatment through the cascade rather than each holding
 *  its own literal. Named `--sg-*` (Sendset guide) so they cannot collide with
 *  Tailwind's own theme variables. */
export function webVars(t: TreatmentDefinition): Record<string, string> {
  return {
    "--sg-ink": t.colors.ink.web,
    "--sg-muted": t.colors.muted.web,
    "--sg-line": t.colors.line.web,
    "--sg-accent": t.colors.accent.web,
    "--sg-surface": t.colors.surface.web,
    "--sg-highlight-ink": t.colors.highlightInk.web,
    "--sg-highlight-ground": t.colors.highlightGround.web,
    "--sg-highlight-rule": t.colors.highlightRule.web,
    "--sg-page-title": t.type.pageTitle.web,
    "--sg-section-title": t.type.sectionTitle.web,
    "--sg-item-title": t.type.itemTitle.web,
    "--sg-body": t.type.body.web,
    "--sg-small": t.type.small.web,
    "--sg-page-gutter": t.rhythm.pageGutter.web,
    "--sg-section-gap": t.rhythm.sectionGap.web,
    "--sg-item-gap": t.rhythm.itemGap.web,
  };
}

/** The same, as the `:root`-style declaration block a print stylesheet needs.
 *  Print CSS is a static file, so the variables are injected by the print page
 *  rather than written into it twice. */
export function printVars(t: TreatmentDefinition): string {
  const rows: [string, string][] = [
    ["--pg-ink", t.colors.ink.print],
    ["--pg-muted", t.colors.muted.print],
    ["--pg-line", t.colors.line.print],
    ["--pg-accent", t.colors.accent.print],
    ["--pg-surface", t.colors.surface.print],
    ["--pg-highlight-ink", t.colors.highlightInk.print],
    ["--pg-highlight-ground", t.colors.highlightGround.print],
    ["--pg-highlight-rule", t.colors.highlightRule.print],
    ["--pg-page-title", t.type.pageTitle.print],
    ["--pg-section-title", t.type.sectionTitle.print],
    ["--pg-item-title", t.type.itemTitle.print],
    ["--pg-body", t.type.body.print],
    ["--pg-small", t.type.small.print],
    ["--pg-section-gap", t.rhythm.sectionGap.print],
    ["--pg-item-gap", t.rhythm.itemGap.print],
  ];
  return `:root{${rows.map(([k, v]) => `${k}:${v}`).join(";")}}`;
}
