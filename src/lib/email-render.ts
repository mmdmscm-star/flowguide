import type { Packet, Item, Section } from "./types.ts";
import { resolveCardLinks } from "./item-links.ts";

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

const FONT = "-apple-system, 'Segoe UI', Roboto, Arial, Helvetica, sans-serif";
const INK = "#1f2328";
const MUTED = "#5b6570";
const LINE = "#e3e6ea";
const LINK = "#1a56db";
const PAGE = "#f4f5f7";
const W = 600;

const p = (text: string, style = "") =>
  `<p style="margin:0 0 12px;font-family:${FONT};font-size:16px;line-height:1.5;color:${INK};${style}">${text}</p>`;

function photoBlock(item: Item): string {
  const url = safeUrl(item.photos?.[0]);
  if (!url) return "";
  // width is an ATTRIBUTE as well as a style: Outlook ignores the style.
  // alt carries the item's own name, so a blocked image still says what it is.
  return `<tr><td style="padding:0 0 14px">
    <img src="${esc(url)}" alt="${esc(item.title)}" width="${W - 48}"
         style="display:block;width:100%;max-width:${W - 48}px;height:auto;border:1px solid ${LINE};border-radius:4px" />
  </td></tr>`;
}

function detailsTable(item: Item): string {
  const rows = (item.details ?? []).filter((d) => String(d?.value ?? "").trim());
  if (!rows.length) return "";
  const body = rows.map((d, i) => {
    const border = i ? `border-top:1px solid ${LINE};` : "";
    return `<tr>
      <td style="${border}padding:8px 12px 8px 0;font-family:${FONT};font-size:15px;line-height:1.45;color:${MUTED};vertical-align:top;width:45%">${esc(d.label)}</td>
      <td style="${border}padding:8px 0;font-family:${FONT};font-size:15px;line-height:1.45;color:${INK};vertical-align:top">${esc(d.value)}</td>
    </tr>`;
  }).join("");
  return `<tr><td style="padding:0 0 14px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
           style="border-collapse:collapse;border:1px solid ${LINE};border-radius:4px">
      <tr><td style="padding:0 12px"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">${body}</table></td></tr>
    </table>
  </td></tr>`;
}

function linksBlock(item: Item): string {
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
  return `<tr><td style="padding:0 0 14px">${p(shown.join(" &nbsp;·&nbsp; "), `font-size:15px;margin:0`)}</td></tr>`;
}

function contactsBlock(item: Item): string {
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
    return `${head ? p(head, "font-size:15px;font-weight:600;margin:0 0 2px") : ""}${ways.length ? p(ways.join(" &nbsp;·&nbsp; "), "font-size:15px;margin:0") : ""}`;
  }).join(`<div style="height:10px;line-height:10px">&nbsp;</div>`);
  return `<tr><td style="padding:0 0 14px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid ${LINE};border-radius:4px">
      <tr><td style="padding:12px">${rows}</td></tr>
    </table>
  </td></tr>`;
}

function itemBlock(item: Item): string {
  const address = String(item.address ?? "").trim();
  const mapHref = address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : null;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
     style="border-collapse:collapse;border:1px solid ${LINE};border-radius:6px;margin:0 0 16px">
    <tr><td style="padding:20px 24px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
        ${photoBlock(item)}
        <tr><td style="padding:0 0 6px">
          <h3 style="margin:0;font-family:${FONT};font-size:19px;line-height:1.3;color:${INK};font-weight:700">${esc(item.title)}</h3>
        </td></tr>
        ${address ? `<tr><td style="padding:0 0 10px">${p(
          mapHref ? `<a href="${esc(mapHref)}" style="color:${LINK};text-decoration:underline">${esc(address)}</a>` : esc(address),
          "font-size:15px;margin:0")}</td></tr>` : ""}
        ${String(item.description ?? "").trim()
          ? `<tr><td style="padding:0 0 14px">${p(esc(item.description).replace(/\n/g, "<br />"), "margin:0")}</td></tr>` : ""}
        ${detailsTable(item)}
        ${linksBlock(item)}
        ${contactsBlock(item)}
      </table>
    </td></tr>
  </table>`;
}

function sectionBlock(section: Section): string {
  const head = [
    String(section.title ?? "").trim()
      ? `<h2 style="margin:0 0 4px;font-family:${FONT};font-size:22px;line-height:1.25;color:${INK};font-weight:700">${esc(section.title)}</h2>` : "",
    String(section.description ?? "").trim() ? p(esc(section.description), `color:${MUTED};margin:0 0 14px`) : "",
  ].join("");
  return `${head ? `<tr><td style="padding:8px 0 10px">${head}</td></tr>` : ""}
    <tr><td>${section.items.map(itemBlock).join("")}</td></tr>`;
}

export interface EmailRenderOptions {
  /** Absolute URL of the live FlowGuide, e.g. https://host/p/slug. */
  liveUrl: string;
}

/** The email-ready HTML. Self-contained, inline-styled, single column. */
export function renderPacketEmail(packet: Packet, opts: EmailRenderOptions): string {
  const pro = packet.professional ?? ({} as Packet["professional"]);
  const live = safeUrl(opts.liveUrl);
  const business = String(pro.businessName ?? "").trim();
  const client = String(packet.clientName ?? "").trim();

  const header = `<tr><td style="padding:28px 24px 8px">
    ${business ? p(esc(business).toUpperCase(), `font-size:12px;letter-spacing:1px;color:${MUTED};margin:0 0 6px`) : ""}
    <h1 style="margin:0;font-family:${FONT};font-size:26px;line-height:1.2;color:${INK};font-weight:700">${esc(packet.title)}</h1>
    ${client ? p(`Prepared for ${esc(client)}`, `color:${MUTED};margin:6px 0 0`) : ""}
    ${live ? p(`<a href="${esc(live)}" style="color:${LINK};text-decoration:underline">Open the interactive version</a>`, "font-size:15px;margin:10px 0 0") : ""}
  </td></tr>`;

  const note = String(packet.personalNote ?? "").trim()
    ? `<tr><td style="padding:14px 24px 0">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background:${PAGE};border-radius:6px">
          <tr><td style="padding:14px 16px">${p(esc(packet.personalNote).replace(/\n/g, "<br />"), "margin:0")}</td></tr>
        </table>
      </td></tr>` : "";

  const body = `<tr><td style="padding:18px 24px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
        ${packet.sections.map(sectionBlock).join("")}
      </table>
    </td></tr>`;

  const contactLines = [
    String(pro.name ?? "").trim() ? esc(pro.name) : "",
    String(pro.phone ?? "").trim() ? `<a href="tel:${esc(String(pro.phone).replace(/[^\d+]/g, ""))}" style="color:${LINK};text-decoration:underline">${esc(pro.phone)}</a>` : "",
    String(pro.email ?? "").trim() ? `<a href="mailto:${esc(pro.email)}" style="color:${LINK};text-decoration:underline">${esc(pro.email)}</a>` : "",
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");

  const footer = `<tr><td style="padding:8px 24px 28px;border-top:1px solid ${LINE}">
    ${String(pro.footerLabel ?? "").trim() ? p(esc(pro.footerLabel).toUpperCase(), `font-size:12px;letter-spacing:1px;color:${MUTED};margin:14px 0 6px`) : `<div style="height:14px;line-height:14px">&nbsp;</div>`}
    ${contactLines ? p(contactLines, "font-size:15px;margin:0 0 10px") : ""}
    ${live ? p(`<a href="${esc(live)}" style="color:${LINK};text-decoration:underline">View this FlowGuide online</a>`, `font-size:14px;color:${MUTED};margin:0`) : ""}
  </td></tr>`;

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background:${PAGE}">
  <tr><td align="center" style="padding:20px 10px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${W}"
           style="border-collapse:collapse;width:100%;max-width:${W}px;background:#ffffff;border:1px solid ${LINE};border-radius:8px">
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
  out.push(packet.title);
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
      for (const d of item.details ?? []) {
        if (String(d?.value ?? "").trim()) out.push(`  ${d.label}: ${d.value}`);
      }
      const { links } = resolveCardLinks(item.links, (item.contacts ?? []).map((c) => c.website));
      for (const { link, label } of links) if (safeUrl(link.url)) out.push(`  ${label}: ${link.url}`);
      for (const c of item.contacts ?? []) {
        const line = [c.name, c.role, c.phone, c.email].map((v) => String(v ?? "").trim()).filter(Boolean).join(" · ");
        if (line) out.push(`  ${line}`);
      }
    }
  }
  const tail = [pro.name, pro.phone, pro.email].map((v) => String(v ?? "").trim()).filter(Boolean).join(" · ");
  if (tail) out.push("", "", tail);
  if (opts.liveUrl) out.push(opts.liveUrl);
  return out.join("\n");
}
