// HOW A SENDSET LOOKS, DECIDED ONCE.
//
// Four renderers present the same packet — the recipient page, Preview, print
// and email — and each used to decide independently what its own ink, rule and
// hierarchy were. Slice 1 moved the colours and the type scale here. This slice
// moves the rest: the fonts, the radii, the chip palette, the link-type
// palette, the prose greys, the print literals that carry intent, and the
// structural decisions that a second treatment cannot express as a colour.
//
// A TREATMENT IS SEMANTIC, AND ITS RESOLUTION IS PER MEDIUM. "This is the
// client highlight" is one intent; amber on a screen, a bordered panel that
// still reads on a mono laser printer, and a table cell that survives Outlook
// are three correct answers to it. So a role holds one value per medium rather
// than one value pretending to work everywhere — and the renderers stop
// choosing.
//
// STRUCTURE IS A MODE, NOT A NAME. Warm and Editorial differ from Default in
// ways no scalar can hold: Editorial has no card, no chip and no filled
// highlight. Those differences are declared as MODES — card, contacts, image,
// highlight, sectionDivider, linkColor — and this file is the only place that
// knows what a mode resolves to. A renderer never asks which treatment it is
// wearing; it reads the resolved value. `treatment.name === "editorial"` must
// not appear outside this file, and there is a test that says so.
//
// STYLE IS METADATA, NOT CONTENT. Nothing here can reach a fact, a word, an
// order, a grouping or a provenance record: it is a palette, a scale and a set
// of structural choices. A future `packets.style_treatment` will select one of
// these by name, live and mutable after publish exactly as `show_quick_nav` is
// — not frozen into professional_snapshot, and deliberately not part of
// content_rev, because a look is not a revision of what was said. That column
// does not exist yet and this slice does not add it: the two new treatments are
// reachable only through an owner-only `?style=` override on Preview, and
// nothing persists.
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

// ---------------------------------------------------------------------------
// STRUCTURAL MODES.
//
// Each is a small closed vocabulary of INTENTS, not of implementations. The
// resolver below turns one into the concrete values a medium needs.
// ---------------------------------------------------------------------------

/** How an item is bounded.
 *  outlined — a hairline box on white, the shipped Sendset card.
 *  tinted   — no border; a warm ground one step off the page is the boundary.
 *  bare     — no box at all; items are separated by a rule and by whitespace. */
export type CardMode = "outlined" | "tinted" | "bare";

/** How a destination is drawn.
 *  chips — filled pills that wrap, the shipped behaviour.
 *  rows  — full-width ruled rows. Tap height is held at 44px on purpose: a
 *          phone number an older reader cannot hit is not a refinement. */
export type ContactMode = "chips" | "rows";

/** How a photograph is framed. */
export type ImageMode = "inset" | "soft" | "flush";

/** How the client highlight carries its emphasis.
 *  filled — a tinted panel, the shipped behaviour.
 *  rule   — a left rule and nothing else, which is already what paper does. */
export type HighlightMode = "filled" | "rule";

/** Whether a section announces itself with a rule above its title. */
export type DividerMode = "none" | "rule";

/** Whether the four link types keep their own colours.
 *  by-type  — video red, brochure amber, map green, website blue (shipped).
 *  unified  — every type takes the treatment's one chip palette. The ICONS are
 *             untouched either way; only the colour is unified. */
export type LinkColorMode = "by-type" | "unified";

export interface TreatmentModes {
  card: CardMode;
  contacts: ContactMode;
  image: ImageMode;
  highlight: HighlightMode;
  sectionDivider: DividerMode;
  linkColor: LinkColorMode;
}

// ---------------------------------------------------------------------------
// ROLES.
// ---------------------------------------------------------------------------

export interface TreatmentColors {
  /** Body text and headings. */
  ink: ByMedium;
  /** Supporting text: captions, the "prepared for" line, a contact's role. */
  muted: ByMedium;
  /** Long-form prose that sits one step softer than ink — an item description. */
  prose: ByMedium;
  /** The muted key in a label/value pair, and a section's description. */
  label: ByMedium;
  /** The smallest supporting text under a subheading. */
  subtle: ByMedium;
  /** The quietest mark on the page — "Powered by Sendset", the printed tail. */
  faint: ByMedium;
  /** Hairlines: card borders, dividers, detail rows. */
  line: ByMedium;
  /** A divider drawn to be SEEN rather than to bound a box — the header rule. */
  rule: ByMedium;
  /** Links and the one primary action. On paper a link cannot be pressed, so
   *  print resolves this to the colour a printed URL is set in. */
  accent: ByMedium;
  accentHover: ByMedium;
  /** Text drawn on top of the accent. */
  onAccent: ByMedium;
  /** The ground a panel sits on, one step off the page. */
  surface: ByMedium;
  /** The ground BEHIND a photograph, seen wherever a picture is letterboxed
   *  rather than cropped. Its own role because it is read against photographs
   *  rather than against text, and it is a shade colder than `surface`. */
  imageGround: ByMedium;
  /** The ground an ITEM sits on. Separate from `surface` because a tinted
   *  treatment moves the card off white while its panels move further.
   *  "transparent" means the medium declares no ground at all. */
  cardGround: ByMedium;
  /** The ground a PANEL inside an item sits on — the details table, the contact
   *  block. Its own role because the three media have never agreed: the web
   *  card fills it, and paper and mail have always left it clear. */
  panelGround: ByMedium;
  /** The chip palette — one destination, drawn as a control. */
  chipInk: ByMedium;
  chipGround: ByMedium;
  chipHover: ByMedium;
  chipRule: ByMedium;
  /** THE CLIENT HIGHLIGHT — the note written for the person reading. Its own
   *  three roles because it is the one place emphasis is carried by colour, and
   *  on paper the rule has to carry it instead when colour does not print. */
  highlightInk: ByMedium;
  highlightGround: ByMedium;
  highlightRule: ByMedium;
}

/** The four link types the packet already distinguishes (see item-links.ts).
 *  Nothing here infers a type; it colours one the packet already carries. */
export type LinkTypeName = "video" | "brochure" | "map" | "website";
export const LINK_TYPE_NAMES: readonly LinkTypeName[] =
  ["video", "brochure", "map", "website"] as const;

export interface LinkTypePalette {
  ink: ByMedium;
  ground: ByMedium;
  hover: ByMedium;
  rule: ByMedium;
}

export interface TreatmentType {
  pageTitle: ByMedium;
  sectionTitle: ByMedium;
  itemTitle: ByMedium;
  body: ByMedium;
  small: ByMedium;
}

/** LEADING IS PART OF A SIZE, NOT A SEPARATE TASTE. A size set without its
 *  leading inherits whatever the parent happened to have, which is how a
 *  centralisation silently reflows a page. Only the three that are set
 *  alongside a size in a renderer are here; every other place states its own
 *  leading in the markup and keeps it. */
export interface TreatmentLeading {
  sectionTitle: ByMedium;
  body: ByMedium;
  small: ByMedium;
}

export interface TreatmentRhythm {
  /** The margin between the page edge and the content. */
  pageGutter: ByMedium;
  /** Between one section and the next. */
  sectionGap: ByMedium;
  /** Between one item and the next. */
  itemGap: ByMedium;
}

export interface TreatmentDefinition {
  name: string;
  /** What a professional reads when choosing. */
  label: string;
  /** One line saying what the look is for. */
  blurb: string;
  modes: TreatmentModes;
  /** Display face (titles) and body face, per medium. Web references the
   *  next/font variables declared in layout.tsx; print and email must name
   *  faces the machine already has — see the comments on each treatment. */
  fonts: { display: ByMedium; body: ByMedium };
  colors: TreatmentColors;
  /** Consulted only when modes.linkColor is "by-type". */
  linkTypes: Record<LinkTypeName, LinkTypePalette>;
  type: TreatmentType;
  leading: TreatmentLeading;
  /** `title` is the page and section heading; an item's name has always been a
   *  step lighter, and a treatment resizes the pair, it does not merge them. */
  weight: { title: ByMedium; itemTitle: ByMedium; eyebrow: ByMedium };
  tracking: { title: ByMedium; eyebrow: ByMedium };
  radius: { card: ByMedium; inner: ByMedium; chip: ByMedium; shell: ByMedium };
  rhythm: TreatmentRhythm;
  /** The height of the printed hero photograph, and the aspect of the web one.
   *  Framing is presentation; the photograph and its order are not. */
  imageAspect: string;
  printHeroHeight: string;
  /** A thumbnail's corner. Separate from the hero's because a 3px radius on a
   *  small tile and a 4px radius on a full-width plate are not the same
   *  decision at that size — and the three media have never agreed on it. */
  thumbRadius: ByMedium;
  /** The document's own base size and leading — what the `font` shorthand on
   *  .pg-doc is written with. A treatment that changes the face owns its
   *  leading: Georgia at 10.5pt needs more air than a system sans does. */
  printDocSize: string;
  printDocLeading: string;
}

const all = (v: string): ByMedium => ({ web: v, print: v, email: v });

// ---------------------------------------------------------------------------
// DEFAULT — THE SHIPPED SENDSET LOOK.
//
// EVERY VALUE HERE IS WHAT THAT MEDIUM ALREADY RENDERED. Slice 1 moved the
// colours and sizes; this slice moves the rest, and it moves them at the value
// they already had — including the exact oklch() the Tailwind palette resolves
// `gray-600`, `blue-50` and the link-type colours to, and the exact
// color-mix() an opacity modifier produces. A palette reconciliation would be a
// redesign wearing a refactor's clothes.
//
// The three media still disagree with each other in places, on purpose, and now
// they disagree in one file where the disagreement is visible.
// ---------------------------------------------------------------------------

const SANS_SYSTEM = "-apple-system, 'Segoe UI', Roboto, Arial, Helvetica, sans-serif";
const SERIF_SYSTEM = "Georgia, 'Iowan Old Style', 'Times New Roman', Times, serif";

export const DEFAULT_TREATMENT: TreatmentDefinition = {
  name: "default",
  label: "Default",
  blurb: "The Sendset look: clear cards, blue links, plain type.",
  modes: {
    card: "outlined",
    contacts: "chips",
    image: "inset",
    highlight: "filled",
    sectionDivider: "none",
    linkColor: "by-type",
  },
  // THE WEB FACE IS GEIST, exactly as the root layout already sets it. Print and
  // email name only faces the machine already has: a webfont does not degrade in
  // Outlook, it disappears, and a print stylesheet that waits on a network fetch
  // can paginate differently than the page that was previewed.
  fonts: {
    display: {
      web: "var(--font-geist-sans), system-ui, -apple-system, sans-serif",
      print: SANS_SYSTEM,
      email: SANS_SYSTEM,
    },
    body: {
      web: "var(--font-geist-sans), system-ui, -apple-system, sans-serif",
      print: SANS_SYSTEM,
      email: SANS_SYSTEM,
    },
  },
  colors: {
    ink:             { web: "#1a1a1a", print: "#1f2328", email: "#1f2328" },
    muted:           { web: "#6b7280", print: "#5b6570", email: "#5b6570" },
    // text-foreground/80 on the item description.
    prose:           { web: "color-mix(in oklab, #1a1a1a 80%, transparent)", print: "#3a4450", email: "#1f2328" },
    // text-gray-600 on detail labels and section descriptions.
    label:           { web: "oklch(44.6% 0.03 256.802)", print: "#5b6570", email: "#5b6570" },
    // text-gray-500 under a block subheading.
    subtle:          { web: "oklch(55.1% 0.027 264.364)", print: "#5b6570", email: "#5b6570" },
    // text-muted/40 on "Powered by Sendset"; #8b949e on the printed tail.
    faint:           { web: "color-mix(in oklab, #6b7280 40%, transparent)", print: "#8b949e", email: "#8b949e" },
    line:            { web: "#e5e7eb", print: "#e3e6ea", email: "#e3e6ea" },
    rule:            { web: "#e5e7eb", print: "#d8dce1", email: "#e3e6ea" },
    accent:          { web: "#2563eb", print: "#5b6570", email: "#1a56db" },
    accentHover:     { web: "#1d4ed8", print: "#5b6570", email: "#1a56db" },
    onAccent:        all("#ffffff"),
    surface:         { web: "#f9fafb", print: "#f4f5f7", email: "#f4f5f7" },
    // bg-gray-100 behind a letterboxed photograph.
    imageGround:     { web: "oklch(96.7% 0.003 264.542)", print: "#f4f5f7", email: "#f4f5f7" },
    cardGround:      { web: "#ffffff", print: "transparent", email: "transparent" },
    panelGround:     { web: "#f9fafb", print: "transparent", email: "transparent" },
    // The contact chips: text-accent on bg-blue-50 / border-blue-100.
    chipInk:         { web: "#2563eb", print: "#5b6570", email: "#1a56db" },
    chipGround:      { web: "oklch(97% 0.014 254.604)", print: "#f4f5f7", email: "#eef2ff" },
    chipHover:       { web: "oklch(93.2% 0.032 255.585)", print: "#f4f5f7", email: "#eef2ff" },
    chipRule:        { web: "oklch(93.2% 0.032 255.585)", print: "#e3e6ea", email: "#dbe3ff" },
    highlightInk:    { web: "#78350f", print: "#6b5518", email: "#6b5518" },
    highlightGround: { web: "#fffbeb", print: "#fdf8ec", email: "#fdf8ec" },
    highlightRule:   { web: "#fde68a", print: "#c8a951", email: "#c8a951" },
  },
  // THE SHIPPED LINK-TYPE CODING. red-600/50/100, amber-700/50/100,
  // green-700/50/100, and the accent on blue-50/100 for a plain website.
  linkTypes: {
    video: {
      ink:    { web: "oklch(57.7% 0.245 27.325)", print: "#5b6570", email: "#1a56db" },
      ground: { web: "oklch(97.1% 0.013 17.38)",  print: "#f4f5f7", email: "#eef2ff" },
      hover:  { web: "oklch(93.6% 0.032 17.717)", print: "#f4f5f7", email: "#eef2ff" },
      rule:   { web: "oklch(93.6% 0.032 17.717)", print: "#e3e6ea", email: "#dbe3ff" },
    },
    brochure: {
      ink:    { web: "oklch(55.5% 0.163 48.998)", print: "#5b6570", email: "#1a56db" },
      ground: { web: "oklch(98.7% 0.022 95.277)", print: "#f4f5f7", email: "#eef2ff" },
      hover:  { web: "oklch(96.2% 0.059 95.617)", print: "#f4f5f7", email: "#eef2ff" },
      rule:   { web: "oklch(96.2% 0.059 95.617)", print: "#e3e6ea", email: "#dbe3ff" },
    },
    map: {
      ink:    { web: "oklch(52.7% 0.154 150.069)", print: "#5b6570", email: "#1a56db" },
      ground: { web: "oklch(98.2% 0.018 155.826)", print: "#f4f5f7", email: "#eef2ff" },
      hover:  { web: "oklch(96.2% 0.044 156.743)", print: "#f4f5f7", email: "#eef2ff" },
      rule:   { web: "oklch(96.2% 0.044 156.743)", print: "#e3e6ea", email: "#dbe3ff" },
    },
    website: {
      ink:    { web: "#2563eb", print: "#5b6570", email: "#1a56db" },
      ground: { web: "oklch(97% 0.014 254.604)",   print: "#f4f5f7", email: "#eef2ff" },
      hover:  { web: "oklch(93.2% 0.032 255.585)", print: "#f4f5f7", email: "#eef2ff" },
      rule:   { web: "oklch(93.2% 0.032 255.585)", print: "#e3e6ea", email: "#dbe3ff" },
    },
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
  leading: {
    sectionTitle: { web: "1.75rem", print: "1.25", email: "1.25" },
    body:         { web: "1.5rem",  print: "1.5",  email: "1.5" },
    small:        { web: "1.25rem", print: "1.45", email: "1.45" },
  },
  // The item's name is a step lighter on screen and full bold on paper and in
  // mail — which is what the three renderers already did, separately.
  weight:   { title: all("700"), itemTitle: { web: "600", print: "700", email: "700" }, eyebrow: all("500") },
  tracking: { title: all("normal"), eyebrow: { web: "0.1em", print: "0.09em", email: "1px" } },
  radius: {
    card:  { web: "0.75rem", print: "6px", email: "6px" },
    inner: { web: "0.5rem",  print: "4px", email: "4px" },
    chip:  { web: "0.5rem",  print: "4px", email: "6px" },
    // The document's own corner — the email's outer plate and its footer panel.
    shell: { web: "0.75rem", print: "6px", email: "8px" },
  },
  rhythm: {
    pageGutter: { web: "1.25rem", print: "0",    email: "24px" },
    sectionGap: { web: "2rem",    print: "18px", email: "14px" },
    itemGap:    { web: "1rem",    print: "14px", email: "14px" },
  },
  imageAspect: "5 / 4",
  printHeroHeight: "2.6in",
  thumbRadius: { web: "0.75rem", print: "3px", email: "3px" },
  printDocSize: "10.5pt",
  printDocLeading: "1.5",
};

// ---------------------------------------------------------------------------
// WARM — softer, more human.
//
// The page is warm paper and structure comes from tint rather than from rules.
// Newsreader sets the titles; Source Sans 3 sets the body, because the body is
// what an older reader reads for ten minutes and a humanist sans is kinder
// there than a serif. Terracotta replaces blue, and the four link colours
// collapse into it — the icons stay, so nothing the packet distinguishes is
// lost, only the noise of four unrelated hues.
// ---------------------------------------------------------------------------
export const WARM_TREATMENT: TreatmentDefinition = {
  name: "warm",
  label: "Warm",
  blurb: "Softer and more personal: warm paper, serif titles, terracotta.",
  modes: {
    card: "tinted",
    contacts: "chips",
    image: "soft",
    highlight: "filled",
    sectionDivider: "none",
    linkColor: "unified",
  },
  fonts: {
    display: {
      web: "var(--font-newsreader), Georgia, 'Times New Roman', serif",
      print: SERIF_SYSTEM,
      email: "Georgia, 'Times New Roman', Times, serif",
    },
    body: {
      web: "var(--font-source-sans), system-ui, -apple-system, sans-serif",
      print: SANS_SYSTEM,
      email: SANS_SYSTEM,
    },
  },
  colors: {
    ink:             all("#2b2320"),
    muted:           { web: "#7a6f68", print: "#6d635c", email: "#6d635c" },
    prose:           { web: "color-mix(in oklab, #2b2320 82%, transparent)", print: "#4a403b", email: "#4a403b" },
    label:           { web: "#7a6f68", print: "#6d635c", email: "#6d635c" },
    subtle:          { web: "#8c8079", print: "#6d635c", email: "#6d635c" },
    faint:           { web: "color-mix(in oklab, #7a6f68 75%, transparent)", print: "#a89a92", email: "#a89a92" },
    line:            { web: "#e9dfd5", print: "#ded2c6", email: "#e2d6ca" },
    rule:            { web: "#ded2c6", print: "#cdbfb1", email: "#ded2c6" },
    accent:          { web: "#a8552f", print: "#5b4a42", email: "#9d4e2b" },
    accentHover:     { web: "#8e4526", print: "#5b4a42", email: "#9d4e2b" },
    onAccent:        all("#ffffff"),
    surface:         { web: "#f6efe6", print: "#f2ece4", email: "#f6efe6" },
    imageGround:     { web: "#f2e7db", print: "#efe6dc", email: "#f2e7db" },
    cardGround:      { web: "#fdfaf6", print: "#fbf7f2", email: "#fdfaf6" },
    panelGround:     { web: "#f6efe6", print: "#f2ece4", email: "#f6efe6" },
    chipInk:         { web: "#a8552f", print: "#5b4a42", email: "#9d4e2b" },
    chipGround:      { web: "#f7ece3", print: "#f2ece4", email: "#f7ece3" },
    chipHover:       { web: "#f0dfd1", print: "#f2ece4", email: "#f7ece3" },
    chipRule:        { web: "#ecd9c9", print: "#ded2c6", email: "#ecd9c9" },
    highlightInk:    { web: "#7a4c14", print: "#6b4a16", email: "#6b4a16" },
    highlightGround: { web: "#fdf3e3", print: "#fbf2e2", email: "#fdf3e3" },
    highlightRule:   { web: "#e6c98f", print: "#c8a951", email: "#dcbb75" },
  },
  // UNIFIED, so these are never read. Declared for shape rather than left
  // optional: an absent palette is a branch waiting to be written.
  linkTypes: uniformLinkTypes(
    { web: "#a8552f", print: "#5b4a42", email: "#9d4e2b" },
    { web: "#f7ece3", print: "#f2ece4", email: "#f7ece3" },
    { web: "#f0dfd1", print: "#f2ece4", email: "#f7ece3" },
    { web: "#ecd9c9", print: "#ded2c6", email: "#ecd9c9" },
  ),
  type: {
    pageTitle:    { web: "1.625rem",  print: "20pt",   email: "27px" },
    sectionTitle: { web: "1.3125rem", print: "14.5pt", email: "22px" },
    itemTitle:    { web: "1.1875rem", print: "13pt",   email: "20px" },
    body:         { web: "1rem",      print: "11pt",   email: "16px" },
    small:        { web: "0.9375rem", print: "10pt",   email: "15px" },
  },
  leading: {
    sectionTitle: all("1.3"),
    body:         all("1.6"),
    small:        all("1.45"),
  },
  weight:   { title: all("600"), itemTitle: { web: "600", print: "700", email: "700" }, eyebrow: all("600") },
  tracking: { title: all("-0.005em"), eyebrow: { web: "0.12em", print: "0.11em", email: "1.2px" } },
  radius: {
    card:  { web: "1rem",     print: "8px",    email: "8px" },
    inner: { web: "0.75rem",  print: "6px",    email: "6px" },
    chip:  { web: "999px",    print: "999px",  email: "999px" },
    shell: { web: "1rem",     print: "8px",    email: "12px" },
  },
  rhythm: {
    pageGutter: { web: "1.375rem", print: "0",    email: "26px" },
    sectionGap: { web: "2.25rem",  print: "20px", email: "16px" },
    itemGap:    { web: "1.25rem",  print: "16px", email: "16px" },
  },
  imageAspect: "4 / 3",
  printHeroHeight: "2.8in",
  thumbRadius: { web: "1rem", print: "5px", email: "5px" },
  printDocSize: "10.5pt",
  printDocLeading: "1.55",
};

// ---------------------------------------------------------------------------
// EDITORIAL — refined typography, stronger hierarchy, restrained rules.
//
// The box disappears. Source Serif 4 sets everything; a hairline above a
// section title replaces the space that used to announce it; items are divided
// by a rule rather than boxed; the highlight keeps only its left rule, which is
// already what paper does. Destinations become full-width ruled rows — held at
// 44px, because removing the chip must not shrink the tap target.
// ---------------------------------------------------------------------------
export const EDITORIAL_TREATMENT: TreatmentDefinition = {
  name: "editorial",
  label: "Editorial",
  blurb: "Quiet and typographic: serif throughout, rules instead of boxes.",
  modes: {
    card: "bare",
    contacts: "rows",
    image: "flush",
    highlight: "rule",
    sectionDivider: "rule",
    linkColor: "unified",
  },
  fonts: {
    display: {
      web: "var(--font-source-serif), Georgia, 'Times New Roman', serif",
      print: SERIF_SYSTEM,
      email: "Georgia, 'Times New Roman', Times, serif",
    },
    body: {
      web: "var(--font-source-serif), Georgia, 'Times New Roman', serif",
      print: SERIF_SYSTEM,
      email: "Georgia, 'Times New Roman', Times, serif",
    },
  },
  colors: {
    ink:             all("#16181d"),
    muted:           { web: "#6a7078", print: "#5f656d", email: "#5f656d" },
    prose:           { web: "color-mix(in oklab, #16181d 86%, transparent)", print: "#2f333a", email: "#2f333a" },
    label:           { web: "#6a7078", print: "#5f656d", email: "#5f656d" },
    subtle:          { web: "#7c828a", print: "#5f656d", email: "#5f656d" },
    faint:           { web: "color-mix(in oklab, #6a7078 75%, transparent)", print: "#9aa0a8", email: "#9aa0a8" },
    line:            { web: "#dcdfe4", print: "#d4d8de", email: "#dcdfe4" },
    rule:            { web: "#c8cdd4", print: "#b9c0c8", email: "#c8cdd4" },
    accent:          { web: "#2a3f5f", print: "#2a3f5f", email: "#2a3f5f" },
    accentHover:     { web: "#1c2c45", print: "#2a3f5f", email: "#2a3f5f" },
    onAccent:        all("#ffffff"),
    surface:         all("#ffffff"),
    imageGround:     { web: "#eef0f3", print: "#eef0f3", email: "#eef0f3" },
    cardGround:      { web: "#ffffff", print: "transparent", email: "transparent" },
    panelGround:     all("transparent"),
    chipInk:         all("#2a3f5f"),
    chipGround:      all("transparent"),
    chipHover:       { web: "#f2f4f7", print: "transparent", email: "transparent" },
    chipRule:        all("transparent"),
    highlightInk:    { web: "#3d3223", print: "#3d3223", email: "#3d3223" },
    highlightGround: all("transparent"),
    highlightRule:   { web: "#c9a227", print: "#8a7320", email: "#c9a227" },
  },
  linkTypes: uniformLinkTypes(
    all("#2a3f5f"),
    all("transparent"),
    { web: "#f2f4f7", print: "transparent", email: "transparent" },
    all("transparent"),
  ),
  type: {
    pageTitle:    { web: "1.875rem",  print: "22pt",   email: "30px" },
    sectionTitle: { web: "1.375rem",  print: "15pt",   email: "23px" },
    itemTitle:    { web: "1.25rem",   print: "13.5pt", email: "21px" },
    body:         { web: "1.0625rem", print: "11pt",   email: "17px" },
    small:        { web: "0.9375rem", print: "10pt",   email: "15px" },
  },
  leading: {
    sectionTitle: all("1.25"),
    body:         all("1.65"),
    small:        all("1.5"),
  },
  weight:   { title: all("700"), itemTitle: all("700"), eyebrow: all("600") },
  tracking: { title: all("-0.015em"), eyebrow: { web: "0.14em", print: "0.13em", email: "1.4px" } },
  radius: {
    card:  all("0"),
    inner: { web: "2px", print: "2px", email: "2px" },
    chip:  all("0"),
    shell: all("0"),
  },
  rhythm: {
    pageGutter: { web: "1.5rem", print: "0",    email: "28px" },
    sectionGap: { web: "3rem",   print: "26px", email: "20px" },
    itemGap:    { web: "2rem",   print: "18px", email: "20px" },
  },
  // THE SAME FRAME AS DEFAULT, deliberately. Editorial's picture differs by
  // being a flush square-cornered plate with no border — not by being cropped
  // differently. The gallery letterboxes rather than crops, so a squarer frame
  // would not make a photograph more editorial; it would put grey bands above
  // and below every landscape picture in the packet.
  imageAspect: "5 / 4",
  printHeroHeight: "2.4in",
  thumbRadius: all("0"),
  printDocSize: "11pt",
  printDocLeading: "1.6",
};

function uniformLinkTypes(
  ink: ByMedium, ground: ByMedium, hover: ByMedium, rule: ByMedium,
): Record<LinkTypeName, LinkTypePalette> {
  const one: LinkTypePalette = { ink, ground, hover, rule };
  return { video: one, brochure: one, map: one, website: one };
}

// ---------------------------------------------------------------------------
// THE REGISTRY.
// ---------------------------------------------------------------------------

export const TREATMENTS: readonly TreatmentDefinition[] =
  [DEFAULT_TREATMENT, WARM_TREATMENT, EDITORIAL_TREATMENT] as const;

export const TREATMENT_NAMES: readonly string[] = TREATMENTS.map((t) => t.name);

/** A treatment by name, DEFAULT for anything else.
 *
 *  Unknown is not an error: a name can arrive from a URL a professional typed,
 *  and one day from a column holding a treatment that has since been withdrawn.
 *  Neither may blank a recipient's page. */
export function treatmentByName(name?: string | null): TreatmentDefinition {
  const key = String(name ?? "").trim().toLowerCase();
  return TREATMENTS.find((t) => t.name === key) ?? DEFAULT_TREATMENT;
}

/** The treatment a packet wears.
 *
 *  ONE SOURCE OF TRUTH: `packets.style_treatment` (migration 0049), carried into
 *  the packet as `styleTreatment` by every assembly path. Absent, null or
 *  unrecognised all resolve to Default — a packet built before the column
 *  existed, a row holding a treatment that was later withdrawn, and a typo must
 *  none of them blank a recipient's page. */
export function treatmentFor(
  packet?: { styleTreatment?: string | null } | null,
): TreatmentDefinition {
  return treatmentByName(packet?.styleTreatment);
}

// ---------------------------------------------------------------------------
// RESOLUTION — the one place a mode becomes a value.
// ---------------------------------------------------------------------------

/** The chip/row geometry a contact mode asks for.
 *
 *  A ROW'S RULE IS A box-shadow, NOT A BORDER. Each destination sets its own
 *  chip colours as local custom properties — that is how the four link types
 *  keep their palettes without a branch — and a border colour set that way
 *  would be overwritten per chip. An inset shadow is untouchable from the
 *  element, costs no layout, and is exactly one hairline. */
function contactShape(t: TreatmentDefinition, m: Medium) {
  const rows = t.modes.contacts === "rows";
  return {
    display: rows ? "flex" : "inline-flex",
    width: rows ? "100%" : "auto",
    // `auto`, not 0: these are flex items, and `min-height: auto` is what they
    // had. A treatment that wants a tap target states one.
    minHeight: rows ? "44px" : "auto",
    padding: rows ? "0.625rem 0" : "0.375rem 0.75rem",
    // The professional's footer buttons have always been the roomier control on
    // the page; a treatment resizes them together, it does not merge them.
    buttonPadding: rows ? "0.75rem 0" : "0.5rem 1rem",
    // THE ONE PRIMARY ACTION, and how it carries its emphasis.
    //
    // Derived from the contacts mode rather than given a mode of its own: a
    // treatment that has replaced every filled chip with a ruled row has already
    // decided that a filled block is not how it speaks. Default and Warm keep
    // the accent-filled button they have always had.
    //
    // A RULED PRIMARY MUST STILL READ AS PRIMARY, and it must not shrink. It is
    // 48px against the secondary rows' 44, its rule is 2px against their 1, and
    // its label is semibold against their regular — three signals, none of which
    // is colour and none of which is size-of-target.
    buttonGround: rows ? "transparent" : t.colors.accent[m],
    buttonInk: rows ? t.colors.accent[m] : t.colors.onAccent[m],
    buttonHover: rows ? t.colors.chipHover[m] : t.colors.accentHover[m],
    buttonRule: rows ? `inset 0 -2px 0 0 ${t.colors.accent[m]}` : "none",
    buttonMinHeight: rows ? "48px" : "auto",
    buttonWeight: rows ? "600" : "500",
    radius: rows ? "0" : t.radius.chip[m],
    borderWidth: rows ? "0" : "1px",
    rowRule: rows ? `inset 0 -1px 0 0 ${t.colors.line[m]}` : "none",
    gap: rows ? "0px" : "0.5rem",
    justify: rows ? "flex-start" : "normal",
  };
}

/** The box, or the absence of one, an item is drawn in. */
function cardShape(t: TreatmentDefinition, m: Medium) {
  const mode = t.modes.card;
  return {
    ground: mode === "tinted" ? t.colors.cardGround[m] : mode === "bare" ? "transparent" : t.colors.cardGround[m],
    border: mode === "outlined" ? `1px solid ${t.colors.line[m]}` : "0 none",
    radius: mode === "bare" ? "0" : t.radius.card[m],
    // THE TOP EDGE OF AN ITEM THAT FOLLOWS ANOTHER.
    //
    // Only a bare treatment needs a separator, because only a bare treatment has
    // removed the thing that used to separate. What that edge is otherwise
    // depends on what the element IS, and the two media differ:
    //
    //   print  — the item IS the card, so its top edge is the card's own border
    //            and the card's own top padding. Restating them here is what
    //            keeps a boxed treatment's card intact, because this rule
    //            overrides the shorthand that drew it.
    //   web    — the item is a WRAPPER; the card sits inside it and owns its own
    //            edge. A treatment that draws no separator draws nothing here.
    //
    // WIDTH AND COLOUR, NOT A SHORTHAND, on the web side: Tailwind's preflight
    // gives every element border-style:solid at zero width, so a shorthand
    // resolving to "0 none" would move the computed style of a border nobody
    // can see.
    itemRuleWidth: mode === "bare" ? "1px" : m === "print" && mode === "outlined" ? "1px" : "0",
    itemRuleColor: t.colors.line[m],
    itemRulePad: mode === "bare"
      ? t.rhythm.itemGap[m]
      : m === "print" ? "12px" : "0",
    // The detail table: filled and boxed, or ruled top and bottom only.
    detailsGround: mode === "bare" ? "transparent" : t.colors.panelGround[m],
    detailsBorderWidth: mode === "bare" ? "1px 0" : "1px",
    detailsRadius: mode === "bare" ? "0" : t.radius.inner[m],
    // A bare treatment has no box to pad, so its content aligns to the page
    // gutter instead — which is the whole reason to remove the box.
    // Each medium keeps its own units: rem on screen, px on paper.
    pad: m === "print"
      ? (mode === "bare" ? "0" : "12px 14px")
      : (mode === "bare" ? "0" : mode === "tinted" ? "1.375rem" : "1.25rem"),
    detailsRowPad: m === "print"
      ? (mode === "bare" ? "6px 0" : "6px 12px")
      : (mode === "bare" ? "0.625rem 0" : "0.625rem 0.875rem"),
  };
}

/** How the highlight carries emphasis. `filled` boxes it; `rule` keeps only the
 *  left edge, which is what a mono laser printer has always had to rely on. */
function highlightShape(t: TreatmentDefinition, m: Medium) {
  const ruleOnly = t.modes.highlight === "rule";
  return {
    ground: ruleOnly ? "transparent" : t.colors.highlightGround[m],
    // On paper and in mail the filled panel has always carried a heavier left
    // edge, because that is the half of the emphasis a mono printer keeps.
    borderWidth: ruleOnly ? "0 0 0 3px" : m === "web" ? "1px" : "1px 1px 1px 3px",
    radius: ruleOnly ? "0" : t.radius.inner[m],
    padding: ruleOnly ? "0 0 0 0.875rem" : "0.75rem 0.875rem",
    // THE ONE MARK. It presents a meaning `item.highlight` ALREADY carries —
    // "the professional wrote this for you" — which today is spelled by an
    // amber ground alone, and an amber ground is exactly what a mono laser
    // printer and a rule-only treatment do not have. It is drawn by a ::before
    // whose `content` this switches on, so a treatment that does not want it
    // generates no box at all rather than a hidden one. Nothing about it is
    // derived from the text: it never reads a label, a value or a vertical.
    mark: t.modes.highlight === "rule" || t.modes.card === "tinted" ? '""' : "none",
  };
}

function imageShape(t: TreatmentDefinition, m: Medium) {
  const mode = t.modes.image;
  return {
    radius: mode === "flush" ? "0" : t.radius.inner[m],
    border: mode === "flush" ? "0 none" : `1px solid ${t.colors.line[m]}`,
    aspect: t.imageAspect,
  };
}

function sectionRule(t: TreatmentDefinition, m: Medium) {
  const on = t.modes.sectionDivider === "rule";
  return {
    width: on ? "1px" : "0",
    color: t.colors.rule[m],
    pad: on ? (m === "print" ? "10px" : "0.875rem") : "0",
  };
}

/** The four link-type palettes, after the colour strategy has been applied. */
export function linkPalettes(t: TreatmentDefinition): Record<LinkTypeName, LinkTypePalette> {
  if (t.modes.linkColor === "by-type") return t.linkTypes;
  return uniformLinkTypes(t.colors.chipInk, t.colors.chipGround, t.colors.chipHover, t.colors.chipRule);
}

/** The treatment's web half as CSS custom properties.
 *
 *  Emitted onto the element that wraps a rendered Sendset, so the packet
 *  components read the treatment through the cascade rather than each holding
 *  its own literal. Named `--sg-*` (Sendset guide) so they cannot collide with
 *  Tailwind's own theme variables.
 *
 *  STRUCTURE TRAVELS THE SAME WAY AS COLOUR. A mode resolves to values here and
 *  reaches the renderer as a variable, so the renderer has one markup path and
 *  no knowledge of which treatment it is drawing. */
export function webVars(t: TreatmentDefinition): Record<string, string> {
  const c = t.colors;
  const card = cardShape(t, "web");
  const chip = contactShape(t, "web");
  const hl = highlightShape(t, "web");
  const img = imageShape(t, "web");
  const sec = sectionRule(t, "web");
  const pal = linkPalettes(t);

  const vars: Record<string, string> = {
    "--sg-font-display": t.fonts.display.web,
    "--sg-font-body": t.fonts.body.web,

    "--sg-ink": c.ink.web,
    "--sg-muted": c.muted.web,
    "--sg-prose": c.prose.web,
    "--sg-label": c.label.web,
    "--sg-subtle": c.subtle.web,
    "--sg-faint": c.faint.web,
    "--sg-line": c.line.web,
    "--sg-rule": c.rule.web,
    "--sg-accent": c.accent.web,
    "--sg-accent-hover": c.accentHover.web,
    "--sg-on-accent": c.onAccent.web,
    "--sg-surface": c.surface.web,
    "--sg-image-ground": c.imageGround.web,

    "--sg-chip-ink": c.chipInk.web,
    "--sg-chip-ground": c.chipGround.web,
    "--sg-chip-hover": c.chipHover.web,
    "--sg-chip-rule": c.chipRule.web,

    "--sg-highlight-ink": c.highlightInk.web,
    "--sg-highlight-ground": c.highlightGround.web,
    "--sg-highlight-rule": c.highlightRule.web,

    "--sg-page-title": t.type.pageTitle.web,
    "--sg-section-title": t.type.sectionTitle.web,
    "--sg-item-title": t.type.itemTitle.web,
    "--sg-body": t.type.body.web,
    "--sg-small": t.type.small.web,
    "--sg-title-weight": t.weight.title.web,
    "--sg-item-title-weight": t.weight.itemTitle.web,
    "--sg-section-title-lh": t.leading.sectionTitle.web,
    "--sg-body-lh": t.leading.body.web,
    "--sg-small-lh": t.leading.small.web,
    "--sg-title-tracking": t.tracking.title.web,
    "--sg-eyebrow-weight": t.weight.eyebrow.web,
    "--sg-eyebrow-tracking": t.tracking.eyebrow.web,

    "--sg-page-gutter": t.rhythm.pageGutter.web,
    "--sg-section-gap": t.rhythm.sectionGap.web,
    "--sg-item-gap": t.rhythm.itemGap.web,
    "--sg-radius-card": t.radius.card.web,
    "--sg-radius-inner": t.radius.inner.web,
    "--sg-radius-chip": t.radius.chip.web,

    "--sg-card-ground": card.ground,
    "--sg-card-border": card.border,
    "--sg-card-radius": card.radius,
    "--sg-card-pad": card.pad,
    "--sg-item-rule-width": card.itemRuleWidth,
    "--sg-item-rule-color": card.itemRuleColor,
    "--sg-item-rule-pad": card.itemRulePad,
    "--sg-details-ground": card.detailsGround,
    "--sg-details-border-width": card.detailsBorderWidth,
    "--sg-details-radius": card.detailsRadius,
    "--sg-details-row-pad": card.detailsRowPad,

    "--sg-chip-display": chip.display,
    "--sg-chip-width": chip.width,
    "--sg-chip-min-h": chip.minHeight,
    "--sg-chip-pad": chip.padding,
    "--sg-btn-pad": chip.buttonPadding,
    "--sg-btn-ground": chip.buttonGround,
    "--sg-btn-ink": chip.buttonInk,
    "--sg-btn-hover": chip.buttonHover,
    "--sg-btn-rule": chip.buttonRule,
    "--sg-btn-min-h": chip.buttonMinHeight,
    "--sg-btn-weight": chip.buttonWeight,
    "--sg-chip-radius": chip.radius,
    "--sg-chip-border-width": chip.borderWidth,
    "--sg-chip-row-rule": chip.rowRule,
    "--sg-chip-gap": chip.gap,
    "--sg-chip-justify": chip.justify,

    "--sg-highlight-bg": hl.ground,
    "--sg-highlight-border-width": hl.borderWidth,
    "--sg-highlight-radius": hl.radius,
    "--sg-highlight-pad": hl.padding,
    "--sg-highlight-mark": hl.mark,

    "--sg-image-radius": img.radius,
    "--sg-image-border": img.border,
    "--sg-image-aspect": img.aspect,
    "--sg-thumb-radius": t.modes.image === "flush" ? "0" : t.thumbRadius.web,

    "--sg-section-rule-width": sec.width,
    "--sg-section-rule-color": sec.color,
    "--sg-section-rule-pad": sec.pad,
  };

  for (const name of LINK_TYPE_NAMES) {
    vars[`--sg-link-${name}-ink`] = pal[name].ink.web;
    vars[`--sg-link-${name}-ground`] = pal[name].ground.web;
    vars[`--sg-link-${name}-hover`] = pal[name].hover.web;
    vars[`--sg-link-${name}-rule`] = pal[name].rule.web;
  }
  return vars;
}

/** The same, as the `:root`-style declaration block a print stylesheet needs.
 *  Print CSS is a static file, so the variables are injected by the print page
 *  rather than written into it twice.
 *
 *  PAGINATION IS NOT A TREATMENT DECISION. Page size, margins, orphans/widows
 *  and every break rule stay in the stylesheet: they are how paper works, not
 *  how a Sendset looks, and a treatment has no business moving them. */
export function printVars(t: TreatmentDefinition): string {
  const c = t.colors;
  const card = cardShape(t, "print");
  const chip = contactShape(t, "print");
  const hl = highlightShape(t, "print");
  const img = imageShape(t, "print");
  const sec = sectionRule(t, "print");

  const rows: [string, string][] = [
    // The document's base setting, as the `font` shorthand .pg-doc is written
    // with. A treatment that changes the face also owns its leading.
    ["--pg-doc-font", `${t.printDocSize}/${t.printDocLeading} ${t.fonts.body.print}`],
    ["--pg-font-display", t.fonts.display.print],
    ["--pg-font-body", t.fonts.body.print],

    ["--pg-ink", c.ink.print],
    ["--pg-muted", c.muted.print],
    ["--pg-prose", c.prose.print],
    ["--pg-label", c.label.print],
    ["--pg-faint", c.faint.print],
    ["--pg-line", c.line.print],
    ["--pg-rule", c.rule.print],
    ["--pg-accent", c.accent.print],
    ["--pg-surface", c.surface.print],
    ["--pg-card-ground", card.ground],
    ["--pg-card-border", card.border],
    ["--pg-card-radius", card.radius],
    ["--pg-item-rule-width", card.itemRuleWidth],
    ["--pg-item-rule-color", card.itemRuleColor],
    ["--pg-item-rule-pad", card.itemRulePad],
    ["--pg-details-ground", card.detailsGround],
    ["--pg-details-border-width", card.detailsBorderWidth],
    ["--pg-details-radius", card.detailsRadius],
    ["--pg-details-row-pad", card.detailsRowPad],
    ["--pg-card-pad", card.pad],

    ["--pg-highlight-ink", c.highlightInk.print],
    ["--pg-highlight-ground", hl.ground],
    ["--pg-highlight-rule", c.highlightRule.print],
    ["--pg-highlight-border-width", hl.borderWidth],
    ["--pg-highlight-radius", hl.radius],
    ["--pg-highlight-mark", hl.mark],

    ["--pg-page-title", t.type.pageTitle.print],
    ["--pg-section-title", t.type.sectionTitle.print],
    ["--pg-item-title", t.type.itemTitle.print],
    ["--pg-body", t.type.body.print],
    ["--pg-small", t.type.small.print],
    ["--pg-title-weight", t.weight.title.print],
    ["--pg-item-title-weight", t.weight.itemTitle.print],
    ["--pg-title-tracking", t.tracking.title.print],
    ["--pg-eyebrow-tracking", t.tracking.eyebrow.print],

    ["--pg-section-gap", t.rhythm.sectionGap.print],
    ["--pg-item-gap", t.rhythm.itemGap.print],
    ["--pg-radius-inner", t.radius.inner.print],
    ["--pg-image-radius", img.radius],
    ["--pg-image-border", img.border],
    ["--pg-image-ground", c.imageGround.print],
    ["--pg-hero-height", t.printHeroHeight],
    ["--pg-thumb-radius", t.thumbRadius.print],
    ["--pg-section-rule-width", sec.width],
    ["--pg-section-rule-color", sec.color],
    ["--pg-section-rule-pad", sec.pad],
    ["--pg-contact-pad", chip.padding],
  ];
  return `:root{${rows.map(([k, v]) => `${k}:${v}`).join(";")}}`;
}

/** Everything the HTML email renderer needs, resolved once per render.
 *
 *  Email gets an OBJECT rather than custom properties because it has no
 *  cascade to read them through: Gmail strips <style> and Outlook renders
 *  through Word, so every value has to be written into an inline attribute at
 *  the point it is used. */
export function emailStyle(t: TreatmentDefinition) {
  const c = t.colors;
  const card = cardShape(t, "email");
  const chip = contactShape(t, "email");
  const hl = highlightShape(t, "email");
  const img = imageShape(t, "email");
  const sec = sectionRule(t, "email");
  return {
    FONT: t.fonts.body.email,
    FONT_DISPLAY: t.fonts.display.email,
    INK: c.ink.email,
    MUTED: c.muted.email,
    PROSE: c.prose.email,
    LABEL: c.label.email,
    LINE: c.line.email,
    RULE: c.rule.email,
    LINK: c.accent.email,
    PAGE: c.surface.email,
    ON_ACCENT: c.onAccent.email,
    CHIP_INK: c.chipInk.email,
    CHIP_GROUND: c.chipGround.email,
    CHIP_RULE: c.chipRule.email,
    HL_INK: c.highlightInk.email,
    HL_GROUND: hl.ground,
    HL_RULE: c.highlightRule.email,
    HL_BORDER_WIDTH: hl.borderWidth,
    HL_RADIUS: hl.radius,
    SIZE: {
      pageTitle: t.type.pageTitle.email,
      sectionTitle: t.type.sectionTitle.email,
      itemTitle: t.type.itemTitle.email,
      body: t.type.body.email,
      small: t.type.small.email,
    },
    TITLE_WEIGHT: t.weight.title.email,
    ITEM_TITLE_WEIGHT: t.weight.itemTitle.email,
    EYEBROW_TRACKING: t.tracking.eyebrow.email,
    CARD_GROUND: card.ground,
    CARD_BORDER: card.border,
    CARD_RADIUS: card.radius,
    ITEM_RULE: card.itemRuleWidth === "0" ? "0 none" : `${card.itemRuleWidth} solid ${card.itemRuleColor}`,
    DETAILS_GROUND: card.detailsGround,
    DETAILS_BORDER: `1px solid ${c.line.email}`,
    /** A boxed table gets a border on all four sides; an unboxed one gets the
     *  top and bottom rules only, which is how a bare treatment rules a table. */
    DETAILS_BOXED: card.detailsBorderWidth === "1px",
    DETAILS_RADIUS: card.detailsRadius,
    CARD_PAD: t.modes.card === "bare" ? "0 0 18px" : "20px 24px",
    RADIUS_CARD: t.radius.card.email,
    RADIUS_SHELL: t.radius.shell.email,
    /** A note needs a boundary only where the treatment has taken the card's
     *  away; every other treatment has always drawn it as a tint alone. */
    NOTE_RULE: t.modes.card === "bare"
      ? `border-top:1px solid ${c.line.email};border-bottom:1px solid ${c.line.email};` : "",
    RADIUS_INNER: t.radius.inner.email,
    RADIUS_CHIP: t.radius.chip.email,
    IMAGE_GROUND: c.imageGround.email,
    IMAGE_RADIUS: img.radius,
    THUMB_RADIUS: t.modes.image === "flush" ? "0" : t.thumbRadius.email,
    IMAGE_BORDER: img.border,
    SECTION_RULE: sec.width === "0" ? "0 none" : `${sec.width} solid ${sec.color}`,
    SECTION_RULE_PAD: sec.pad,
    /** Email's one structural fork: a "rows" treatment states its destinations
     *  as underlined links rather than as filled cells, which is also the
     *  safest thing email HTML can do. */
    BUTTONS_AS_LINKS: t.modes.contacts === "rows",
    CHIP_PAD: chip.padding,
  };
}

export type EmailStyle = ReturnType<typeof emailStyle>;
