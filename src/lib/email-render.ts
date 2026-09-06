import type { Packet, Item, Section } from "./types.ts";
import { resolveCardLinks } from "./item-links.ts";
import { thumbnailUrl, squareThumbnailUrl } from "./image-source.ts";
import { treatmentFor, emailStyle, type EmailStyle } from "./style/treatment.ts";

// AN EMAIL-READY RENDERING OF THE SAME PACKET.
//
// A renderer, not a second copy. Nothing here authors content: every string
// comes from the packet, in the packet's order, and the live FlowGuide stays
// the source of truth. If this file ever starts deciding what to say rather
// than how to present it, it has become the thing the architecture forbids.
//
// WRITTEN FOR HOSTILE CLIENTS, deliberately unfashionably:
//
//   * tables and inlined styles only. Gmail strips <style> blocks and drops
//     classes; Outlook renders through Word and has no flexbox or grid. Modern
//     CSS here does not degrade, it disappears.
//   * ONE COLUMN at 600px, always. Not a desktop grid that collapses - a single
//     column needs no media queries, which is exactly why it survives Outlook,
//     and it reads as a document on desktop and fills the width on a phone.
//   * no image carries meaning. Photos are decorative; every fact is text, so a
//     client that blocks images loses nothing.
//
// PRIVATE NOTES ARE NEVER RENDERED. `item.notes` is professional-only on the
// web card (audience === "professional"), and this is a recipient surface. The
// field is not read anywhere in this file, and a test enforces that.
//
// `item.highlight` IS rendered, and the two must not be confused: it is the
// note the professional wrote FOR this reader. It is escaped first and only
// then given <br />, so authored line breaks survive and authored markup
// cannot.

const esc = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Only http(s) may become an href. Anything else is rendered as plain text so
 *  a javascript: or data: URL in the packet cannot become a live link. */
const safeUrl = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return /^https?:\/\//i.test(s) ? s : null;
};

/** As tolerant as the live footer, which accepts a bare domain typed into the
 *  profile form ("example.com") and prefixes it. Anything carrying some OTHER
 *  scheme is refused outright rather than prefixed, so `javascript:alert(1)`
 *  cannot become `https://javascript:alert(1)` or survive as itself. */
const href = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
  return `https://${s}`;
};

// THE PALETTE, THE SCALE AND THE STRUCTURE COME FROM THE TREATMENT LAYER.
//
// They were hex literals and pixel sizes chosen in this file, and they had
// drifted from the web page's — #1f2328 against #1a1a1a, #5b6570 against
// #6b7280 — with nothing recording that they were meant to be one decision.
//
// RESOLVED PER RENDER, not at module scope. A treatment is a per-packet choice,
// so every helper below takes the resolved style as its first argument and
// destructures the names it uses. Email gets an object rather than custom
// properties because it has no cascade to read them through: Gmail strips
// <style>, Outlook renders through Word, and every value has to be written into
// an inline attribute at the point it is used.
//
// THE FONT IS A TREATMENT ROLE, resolved to a WEB-SAFE STACK. Georgia and the
// system sans are the two faces genuinely present across Windows, macOS, iOS,
// Android and Outlook-through-Word; a webfont here does not degrade, it
// disappears, so the treatment names a stack rather than a face.
const W = 600;

/** Escaped text with authored newlines turned into <br />.
 *
 *  ORDER MATTERS: esc() first, THEN the <br />. Escaping afterwards would
 *  escape the tags we just inserted; inserting before escaping is how a
 *  description becomes an injection point. Email has no white-space:pre-line
 *  worth trusting across clients, so the break has to be a real tag. */
const escLines = (v: unknown) => esc(v).replace(/\r\n?|\n/g, "<br />");

const p = (s: EmailStyle, text: string, style = "") =>
  `<p style="margin:0 0 12px;font-family:${s.FONT};font-size:${s.SIZE.body};line-height:1.5;color:${s.INK};${style}">${text}</p>`;

const CONTENT = W - 48;   // 552px, inside the card's padding
const COLS = 4;           // three columns makes an eight-photo item ~530px taller
const GAP = 8;
const THUMB = Math.floor((CONTENT - GAP * (COLS - 1)) / COLS);   // 132px

// EVERY RECIPIENT-VISIBLE PHOTO, in packet order.
//
// Showing photos[0] alone was not a smaller gallery, it was a different packet:
// eight photographs of a community reduced to one is the renderer deciding what
// the client gets to see.
//
// The shape mirrors the live gallery rather than inventing an email-only one.
// PhotoGallery shows ONE photo prominently and puts the rest behind "View all
// N"; this shows one photo prominently and lays the rest out as an index. Same
// information architecture, expressed in the only vocabulary email has.
//
// Stacking all of them full-width was the obvious alternative and is much
// worse: measured on this packet it would add ~14,500px of phone scrolling,
// roughly eighteen extra screens, and bury the prices and phone numbers under
// the pictures.
function photoBlock(s: EmailStyle, item: Item, liveUrl: string | null): string {
  const { LINE, LINK, IMAGE_RADIUS, IMAGE_BORDER, THUMB_RADIUS } = s;
  const photos = (item.photos ?? []).map(safeUrl).filter((u): u is string => Boolean(u));
  if (!photos.length) return "";

  const [hero, ...rest] = photos;

  // width is an ATTRIBUTE as well as a style: Outlook ignores the style.
  // alt carries the item's own name, so a blocked image still says what it is.
  // The rendition is bounded at 2x the display width - the same pixels a
  // recipient could see, at a quarter of the bytes of the stored original.
  const heroRow = `<tr><td style="padding:0 0 ${rest.length ? 8 : 14}px">
    <img src="${esc(thumbnailUrl(hero, CONTENT * 2))}" alt="${esc(item.title)}" width="${CONTENT}"
         style="display:block;width:100%;max-width:${CONTENT}px;height:auto;border:${IMAGE_BORDER === "0 none" ? "0" : `1px solid ${LINE}`};border-radius:${IMAGE_RADIUS}" />
  </td></tr>`;

  if (!rest.length) return heroRow;

  const rows: string[] = [];
  for (let i = 0; i < rest.length; i += COLS) {
    const slice = rest.slice(i, i + COLS);
    // The tile is square because the SOURCE cropped it. Squaring it here with
    // object-fit would look right in Gmail and arrive stretched in Outlook.
    // Not linked individually: forty-two hrefs are real bytes against Gmail's
    // clipping threshold, and a thumbnail that is silently tappable is not an
    // affordance. One stated link below leads better than forty-two hidden ones.
    const cells = slice.map((url, k) => `<td width="${THUMB}" style="padding:0 ${
      k === COLS - 1 ? 0 : GAP}px ${GAP}px 0"><img src="${esc(squareThumbnailUrl(url, THUMB * 2))}" alt="" width="${THUMB}" height="${THUMB}"
      style="display:block;border:${IMAGE_BORDER === "0 none" ? "0" : `1px solid ${LINE}`};border-radius:${THUMB_RADIUS}" /></td>`);
    // Pad the short row so its tiles keep their width instead of stretching.
    while (cells.length < COLS) cells.push(`<td width="${THUMB}">&nbsp;</td>`);
    rows.push(`<tr>${cells.join("")}</tr>`);
  }

  const anchor = liveUrl ? `${liveUrl}#item-${item.id}` : null;
  const more = anchor
    ? `<tr><td colspan="${COLS}" style="padding:2px 0 0">${p(s,
        `<a href="${esc(anchor)}" style="color:${LINK};text-decoration:underline">View all ${photos.length} photos</a>`,
        "font-size:14px;margin:0")}</td></tr>`
    : "";

  return `${heroRow}<tr><td style="padding:0 0 14px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"
           style="border-collapse:collapse">${rows.join("")}${more}</table>
  </td></tr>`;
}

function detailsTable(s: EmailStyle, item: Item): string {
  const { LINE, INK, MUTED, FONT, SIZE, DETAILS_GROUND, DETAILS_BOXED, DETAILS_RADIUS } = s;
  const rows = (item.details ?? []).filter((d) => String(d?.value ?? "").trim());
  if (!rows.length) return "";
  const body = rows.map((d, i) => {
    const border = i ? `border-top:1px solid ${LINE};` : "";
    // A DETAIL WITH NO LABEL IS A SENTENCE. Left as a pair it takes the 55%
    // column beside an empty 45% gutter, which in a mail client reads as a
    // broken table rather than as the source line it is. One full-width cell —
    // colspan, because that is the one thing every mail client agrees on.
    if (!String(d?.label ?? "").trim()) {
      return `<tr>
      <td colspan="2" style="${border}padding:8px 0;font-family:${FONT};font-size:${SIZE.small};line-height:1.45;color:${INK};vertical-align:top">${esc(d.value)}</td>
    </tr>`;
    }
    return `<tr>
      <td style="${border}padding:8px 12px 8px 0;font-family:${FONT};font-size:${SIZE.small};line-height:1.45;color:${MUTED};vertical-align:top;width:45%">${esc(d.label)}</td>
      <td style="${border}padding:8px 0;font-family:${FONT};font-size:${SIZE.small};line-height:1.45;color:${INK};vertical-align:top">${esc(d.value)}</td>
    </tr>`;
  }).join("");
  return `<tr><td style="padding:0 0 14px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
           style="border-collapse:collapse;${DETAILS_GROUND === "transparent" ? "" : `background:${DETAILS_GROUND};`}${
             DETAILS_BOXED
               ? `border:1px solid ${LINE};border-radius:${DETAILS_RADIUS}`
               : `border-top:1px solid ${LINE};border-bottom:1px solid ${LINE}`}">
      <tr><td style="padding:${DETAILS_BOXED ? "0 12px" : "0"}"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">${body}</table></td></tr>
    </table>
  </td></tr>`;
}

function linksBlock(s: EmailStyle, item: Item): string {
  const { LINK, SIZE } = s;
  // The SAME dedupe AND the same labelling the web card uses, so the two
  // renderers never disagree about which links exist or what they read.
  // resolveCardLinks returns {link, label} pairs - the resolved label already
  // carries the hostname fallback for two links that would otherwise read
  // alike, so it is used rather than re-deriving one here.
  const { links } = resolveCardLinks(item.links, (item.contacts ?? []).map((c) => c.website));
  const shown = links.map(({ link, label }) => {
    const url = safeUrl(link.url);
    if (!url) return "";
    return `<a href="${esc(url)}" style="color:${LINK};text-decoration:underline">${esc(label)}</a>`;
  }).filter(Boolean);
  if (!shown.length) return "";
  return `<tr><td style="padding:0 0 14px">${p(s, shown.join(" &nbsp;·&nbsp; "), `font-size:${SIZE.small};margin:0`)}</td></tr>`;
}

function contactsBlock(s: EmailStyle, item: Item): string {
  const { LINE, LINK, SIZE, DETAILS_BOXED, DETAILS_RADIUS } = s;
  const all = item.contacts ?? [];
  // Which contact websites the web card shows - the same call, so a site that
  // is a duplicate of an item link is hidden in both places.
  const { contactWebsiteVisible } = resolveCardLinks(item.links, all.map((c) => c.website));
  const contacts = all
    .map((c, i) => ({ c, showSite: contactWebsiteVisible[i] === true }))
    .filter(({ c }) => [c.name, c.phone, c.email, c.website].some((v) => String(v ?? "").trim()));
  if (!contacts.length) return "";
  const rows = contacts.map(({ c, showSite }) => {
    const head = [c.name, c.role].map((v) => String(v ?? "").trim()).filter(Boolean).map(esc).join(" &nbsp;·&nbsp; ");
    const ways: string[] = [];
    const phone = String(c.phone ?? "").trim();
    const email = String(c.email ?? "").trim();
    if (phone) ways.push(`<a href="tel:${esc(phone.replace(/[^\d+]/g, ""))}" style="color:${LINK};text-decoration:underline">${esc(phone)}</a>`);
    if (email) ways.push(`<a href="mailto:${esc(email)}" style="color:${LINK};text-decoration:underline">${esc(email)}</a>`);
    const site = showSite ? safeUrl(c.website) : null;
    if (site) ways.push(`<a href="${esc(site)}" style="color:${LINK};text-decoration:underline">${esc(site.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, ""))}</a>`);
    return `${head ? p(s, head, `font-size:${SIZE.small};font-weight:600;margin:0 0 2px`) : ""}${ways.length ? p(s, ways.join(" &nbsp;·&nbsp; "), `font-size:${SIZE.small};margin:0`) : ""}`;
  }).join(`<div style="height:10px;line-height:10px">&nbsp;</div>`);
  return `<tr><td style="padding:0 0 14px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;${
      DETAILS_BOXED
        ? `border:1px solid ${LINE};border-radius:${DETAILS_RADIUS}`
        : `border-top:1px solid ${LINE};border-bottom:1px solid ${LINE}`}">
      <tr><td style="padding:${DETAILS_BOXED ? "12px" : "12px 0"}">${rows}</td></tr>
    </table>
  </td></tr>`;
}

function itemBlock(s: EmailStyle, item: Item, liveUrl: string | null, first: boolean): string {
  const { LINE, INK, LINK, FONT_DISPLAY, SIZE, ITEM_TITLE_WEIGHT, PROSE,
          CARD_BORDER, CARD_RADIUS, CARD_GROUND, CARD_PAD, ITEM_RULE,
          HL_GROUND, HL_RULE, HL_INK, HL_BORDER_WIDTH, HL_RADIUS } = s;
  const address = String(item.address ?? "").trim();
  const mapHref = address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : null;
  // A treatment that removes the box separates items with a rule instead — and
  // never before the first one, which is why `first` is passed rather than
  // guessed from the markup.
  const boxed = CARD_BORDER !== "0 none";
  const shell = boxed
    ? `border:1px solid ${LINE};border-radius:${CARD_RADIUS};${CARD_GROUND === "transparent" ? "" : `background:${CARD_GROUND};`}margin:0 0 16px`
    : `border:0;margin:0;${first || ITEM_RULE === "0 none" ? "" : `border-top:1px solid ${LINE};padding-top:18px;`}`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
     style="border-collapse:collapse;${shell}">
    <tr><td style="padding:${CARD_PAD}">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
        ${photoBlock(s, item, liveUrl)}
        <tr><td style="padding:0 0 6px">
          <h3 style="margin:0;font-family:${FONT_DISPLAY};font-size:${SIZE.itemTitle};line-height:1.3;color:${INK};font-weight:${ITEM_TITLE_WEIGHT}">${esc(item.title)}</h3>
        </td></tr>
        ${address ? `<tr><td style="padding:0 0 10px">${p(s,
          mapHref ? `<a href="${esc(mapHref)}" style="color:${LINK};text-decoration:underline">${esc(address)}</a>` : esc(address),
          `font-size:${SIZE.small};margin:0`)}</td></tr>` : ""}
        ${String(item.description ?? "").trim()
          ? `<tr><td style="padding:0 0 14px">${p(s, escLines(item.description), PROSE === INK ? "margin:0" : `color:${PROSE};margin:0`)}</td></tr>` : ""}
        ${String(item.highlight ?? "").trim()
          ? `<tr><td style="padding:0 0 14px">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
                <tr><td style="background:${HL_GROUND};border-style:solid;border-width:${HL_BORDER_WIDTH};border-color:${HL_RULE};border-radius:${HL_RADIUS};padding:${HL_BORDER_WIDTH === "0 0 0 3px" ? "2px 0 2px 13px" : "10px 13px"}">
                  ${p(s, escLines(item.highlight), `color:${HL_INK};margin:0`)}
                </td></tr>
              </table>
            </td></tr>` : ""}
        ${detailsTable(s, item)}
        ${linksBlock(s, item)}
        ${contactsBlock(s, item)}
      </table>
    </td></tr>
  </table>`;
}

function sectionBlock(s: EmailStyle, section: Section, liveUrl: string | null): string {
  const { INK, LABEL, FONT_DISPLAY, SIZE, TITLE_WEIGHT, SECTION_RULE, SECTION_RULE_PAD } = s;
  const rule = SECTION_RULE === "0 none" ? "" : `border-top:${SECTION_RULE};padding-top:${SECTION_RULE_PAD};`;
  const head = [
    String(section.title ?? "").trim()
      ? `<h2 style="margin:0 0 4px;font-family:${FONT_DISPLAY};font-size:${SIZE.sectionTitle};line-height:1.25;color:${INK};font-weight:${TITLE_WEIGHT}">${esc(section.title)}</h2>` : "",
    String(section.description ?? "").trim() ? p(s, escLines(section.description), `color:${LABEL};margin:0 0 14px`) : "",
  ].join("");
  return `${head ? `<tr><td style="${rule}padding:8px 0 10px">${head}</td></tr>` : ""}
    <tr><td>${section.items.map((it, i) => itemBlock(s, it, liveUrl, i === 0)).join("")}</td></tr>`;
}

export interface EmailRenderOptions {
  /** Absolute URL of the live FlowGuide, e.g. https://host/p/slug. */
  liveUrl: string;
}

/** The email-ready HTML. Self-contained, inline-styled, single column.
 *
 *  The treatment is the PACKET'S — `packets.style_treatment`, resolved through
 *  the same registry the recipient page and the print route use. There is no
 *  override: one packet, one stored look, four renderers. */
export function renderPacketEmail(packet: Packet, opts: EmailRenderOptions): string {
  const s = emailStyle(treatmentFor(packet));
  const { FONT, FONT_DISPLAY, INK, MUTED, LINE, LINK, PAGE, SIZE, TITLE_WEIGHT,
          ON_ACCENT, CHIP_GROUND, CHIP_RULE, CHIP_INK, RADIUS_CARD, RADIUS_CHIP,
          RADIUS_SHELL, NOTE_RULE, BUTTONS_AS_LINKS, EYEBROW_TRACKING } = s;
  const pro = packet.professional ?? ({} as Packet["professional"]);
  const live = safeUrl(opts.liveUrl);
  const business = String(pro.businessName ?? "").trim();
  const client = String(packet.clientName ?? "").trim();

  // The logo the live PacketHeader leads with. It was dropped here, which made
  // the email the one place the professional's brand did not appear.
  const logo = safeUrl(pro.logoUrl);

  // The CLIENT title, not the professional's internal name for the FlowGuide.
  // Blank omits the heading rather than emitting an empty <h1>, which in an
  // email client is a visible band of whitespace rather than nothing.
  const heading = String(packet.clientTitle ?? "").trim();
  const header = `<tr><td style="padding:28px 24px 8px">
    ${logo ? `<img src="${esc(logo)}" alt="${esc(business || "Logo")}" height="40"
         style="display:block;height:40px;width:auto;max-width:180px;margin:0 0 14px" />` : ""}
    ${business ? p(s, esc(business).toUpperCase(), `font-size:12px;letter-spacing:${EYEBROW_TRACKING};color:${MUTED};margin:0 0 6px`) : ""}
    ${heading ? `<h1 style="margin:0;font-family:${FONT_DISPLAY};font-size:${SIZE.pageTitle};line-height:1.2;color:${INK};font-weight:${TITLE_WEIGHT}">${esc(heading)}</h1>` : ""}
    ${client ? p(s, `Prepared for ${esc(client)}`, `color:${MUTED};margin:6px 0 0`) : ""}
    ${live ? p(s, `<a href="${esc(live)}" style="color:${LINK};text-decoration:underline">Open the interactive version</a>`, `font-size:${SIZE.small};margin:10px 0 0`) : ""}
  </td></tr>`;

  const note = String(packet.personalNote ?? "").trim()
    ? `<tr><td style="padding:14px 24px 0">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background:${PAGE};${NOTE_RULE}border-radius:${RADIUS_CARD}">
          <tr><td style="padding:14px 16px">${p(s, esc(packet.personalNote).replace(/\n/g, "<br />"), "margin:0")}</td></tr>
        </table>
      </td></tr>` : "";

  const body = `<tr><td style="padding:18px 24px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
        ${packet.sections.map((sec) => sectionBlock(s, sec, live)).join("")}
      </table>
    </td></tr>`;

  // THE SAME IDENTITY THE LIVE PAGE SHOWS, in email-safe HTML - not a second,
  // email-only signature. Field for field this mirrors ProfessionalFooter:
  // label, headshot, name, business, then every way to make contact.
  //
  // It is a CONTACT CARD, and that shape is the point. A bare
  // "Ramona Maurer - phone - email" line at the foot of an email is shaped
  // exactly like an email signature, so a personal note that already ends
  // "Thank you, Ramona" reads as signed twice. The note is not the problem and
  // is never touched; the footer just has to stop imitating a sign-off. A
  // labelled card with a photograph and buttons reads as what it is - how to
  // reach this person - which is also how it reads on the live page.
  const headshot = safeUrl(pro.headshotUrl);
  const proName = String(pro.name ?? "").trim();
  const proPhone = String(pro.phone ?? "").trim();
  const proEmail = String(pro.email ?? "").trim();
  const proSite = href(pro.websiteUrl);
  const tel = proPhone.replace(/[^\d+]/g, "");

  // A table cell IS the button: no border-radius in Outlook, which squares the
  // corners and changes nothing else.
  //
  // A "rows" TREATMENT STATES ITS DESTINATIONS AS LINKS instead — which is both
  // what that treatment does everywhere else and the safest thing email HTML
  // can do. Same destinations, same labels, same order; only the drawing
  // changes.
  const btn = (target: string, label: string, primary: boolean) =>
    BUTTONS_AS_LINKS
      ? `<td style="padding:0 18px 8px 0"><a href="${esc(target)}" style="font-family:${FONT};font-size:${SIZE.small};font-weight:600;color:${LINK};text-decoration:underline">${esc(label)}</a></td>`
      : `<td style="padding:0 8px 8px 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate">
      <tr><td style="background:${primary ? LINK : CHIP_GROUND};border:1px solid ${primary ? LINK : CHIP_RULE};border-radius:${RADIUS_CHIP}">
        <a href="${esc(target)}" style="display:inline-block;padding:9px 16px;font-family:${FONT};font-size:${SIZE.small};font-weight:600;line-height:1;color:${primary ? ON_ACCENT : CHIP_INK};text-decoration:none">${esc(label)}</a>
      </td></tr></table></td>`;

  const buttons: string[] = [];
  if (tel) buttons.push(btn(`tel:${tel}`, proName ? `Call ${proName.split(" ")[0]}` : "Call", true));
  // NO TEXT BUTTON IN EMAIL. This previously rendered `sms:` on the reasoning
  // that "a dead button costs less than a missing one". Tested on a real phone,
  // in a real mail client, that reasoning was wrong: tapping Text did nothing.
  // A control that looks live and does nothing spends the recipient's trust at
  // the exact moment they are trying to reach their advisor, and they cannot
  // tell it is the medium's fault rather than the professional's.
  //
  // RENDERER-SPECIFIC, deliberately. `sms:` works on the live FlowGuide, so the
  // live footer keeps Text and the professional's profile is untouched. This is
  // one packet shown many ways: a renderer may present less than the packet
  // holds when its medium cannot honour it — it may never present something
  // different. Nothing here removes a fact; it removes a broken affordance.
  if (proEmail) buttons.push(btn(`mailto:${proEmail}`, "Email", false));
  if (proSite) buttons.push(btn(proSite, "Website", false));
  for (const l of pro.links ?? []) {
    const target = href(l?.url);
    if (target) buttons.push(btn(target, String(l?.label ?? "").trim() || target, false));
  }
  const buttonRows = buttons.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>${buttons.join("")}</tr></table>`
    : "";

  // Sized by HEIGHT ALONE, keeping the photo's own proportions. The live page
  // crops a circle with object-fit, which Outlook does not implement - forcing
  // 56x56 there would squash a 920x560 portrait into a distorted face. A
  // rounded rectangle is a small departure from the live shape; a stretched
  // photograph of someone is not a small departure.
  const identity = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">
      <tr>
        ${headshot ? `<td style="padding:0 14px 0 0;vertical-align:top">
          <img src="${esc(thumbnailUrl(headshot, 168))}" alt="${esc(proName)}" height="56"
               style="display:block;height:56px;width:auto;border-radius:${RADIUS_CHIP};border:1px solid ${LINE}" />
        </td>` : ""}
        <td style="vertical-align:top">
          ${proName ? p(s, esc(proName), "font-size:16px;font-weight:600;margin:0") : ""}
          ${business ? p(s, esc(business), `font-size:14px;color:${MUTED};margin:2px 0 0`) : ""}
        </td>
      </tr>
    </table>`;

  const footer = `<tr><td style="padding:8px 24px 28px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
           style="border-collapse:collapse;background:${PAGE};border:1px solid ${LINE};border-radius:${RADIUS_SHELL}">
      <tr><td style="padding:16px 18px">
        ${String(pro.footerLabel ?? "").trim() ? p(s, esc(pro.footerLabel).toUpperCase(), `font-size:12px;letter-spacing:${EYEBROW_TRACKING};color:${MUTED};margin:0 0 10px`) : ""}
        ${identity}
        ${buttonRows ? `<div style="height:14px;line-height:14px">&nbsp;</div>${buttonRows}` : ""}
      </td></tr>
    </table>
    ${live ? p(s, `<a href="${esc(live)}" style="color:${LINK};text-decoration:underline">View this Sendset online</a>`, `font-size:14px;color:${MUTED};margin:12px 0 0`) : ""}
  </td></tr>`;

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background:${PAGE}">
  <tr><td align="center" style="padding:20px 10px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${W}"
           style="border-collapse:collapse;width:100%;max-width:${W}px;background:#ffffff;border:1px solid ${LINE};border-radius:${RADIUS_SHELL}">
      ${header}${note}${body}${footer}
    </table>
  </td></tr>
</table>`;
}

/** The plain-text flavour written alongside the HTML, so a text-only composer
 *  gets something readable rather than a wall of markup. */
export function renderPacketEmailText(packet: Packet, opts: EmailRenderOptions): string {
  const out: string[] = [];
  const pro = packet.professional ?? ({} as Packet["professional"]);
  if (String(pro.businessName ?? "").trim()) out.push(String(pro.businessName).toUpperCase());
  // Same rule as the HTML: no client title means no heading line at all, rather
  // than a blank one the reader has to interpret.
  if (String(packet.clientTitle ?? "").trim()) out.push(String(packet.clientTitle).trim());
  if (String(packet.clientName ?? "").trim()) out.push(`Prepared for ${packet.clientName}`);
  if (opts.liveUrl) out.push("", opts.liveUrl);
  if (String(packet.personalNote ?? "").trim()) out.push("", String(packet.personalNote).trim());
  for (const section of packet.sections) {
    out.push("", "");
    if (String(section.title ?? "").trim()) out.push(String(section.title).toUpperCase());
    if (String(section.description ?? "").trim()) out.push(String(section.description));
    for (const item of section.items) {
      out.push("", item.title);
      if (String(item.address ?? "").trim()) out.push(String(item.address));
      if (String(item.description ?? "").trim()) out.push(String(item.description));
      // The client highlight travels in the plain-text flavour too, or a
      // recipient whose client strips HTML loses a note written for them.
      if (String(item.highlight ?? "").trim()) out.push(String(item.highlight).trim());
      for (const d of item.details ?? []) {
        // A DETAIL WITH NO LABEL IS A SENTENCE HERE TOO. "`  ${label}: ${value}`"
        // renders a label-less line as "  : **The Community Fee is refundable
        // ..." — a stray colon in front of the professional's own source
        // wording. Same content, same decision as the other three renderers:
        // stand it on its own, at the same indent as every other item line.
        if (!String(d?.value ?? "").trim()) continue;
        out.push(String(d?.label ?? "").trim() ? `  ${d.label}: ${d.value}` : `  ${d.value}`);
      }
      const { links } = resolveCardLinks(item.links, (item.contacts ?? []).map((c) => c.website));
      for (const { link, label } of links) if (safeUrl(link.url)) out.push(`  ${label}: ${link.url}`);
      for (const c of item.contacts ?? []) {
        const line = [c.name, c.role, c.phone, c.email].map((v) => String(v ?? "").trim()).filter(Boolean).join(" · ");
        if (line) out.push(`  ${line}`);
      }
    }
  }
  // The same identity fields the HTML footer carries, so the two flavours of
  // one email do not introduce the professional differently.
  const tail = [pro.name, pro.businessName, pro.phone, pro.email]
    .map((v) => String(v ?? "").trim()).filter(Boolean).join(" · ");
  if (tail) out.push("", "", tail);
  const site = href(pro.websiteUrl);
  if (site) out.push(site);
  for (const l of pro.links ?? []) {
    const target = href(l?.url);
    if (target) out.push(`${String(l?.label ?? "").trim() || target}: ${target}`);
  }
  if (opts.liveUrl) out.push(opts.liveUrl);
  return out.join("\n");
}
