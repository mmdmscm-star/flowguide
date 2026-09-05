import type { Packet, Item, Section } from "@/lib/types";
import { resolveCardLinks } from "@/lib/item-links";
import { thumbnailUrl, squareThumbnailUrl } from "@/lib/image-source";

// THE PACKET, RENDERED FOR PAPER.
//
// A renderer, like the email version: it reads the packet and presents it, and
// authors nothing. The source is `getPublishedPacket` - the same function the
// live recipient page uses - so paper cannot drift from what the client sees
// online, and `notes` is already gone before the data arrives here. The client
// HIGHLIGHT is the opposite field and does print: it was written for the person
// holding the page.
//
// STATIC BY CONSTRUCTION. No "use client", no carousel, no state. That is not
// only a simplification: PhotoGallery mounts only the slides within two of the
// current index, so a print stylesheet over the live page would have silently
// printed at most five photos per item and looked like it worked. Every photo
// is laid out here instead.
//
// What paper needs that a screen does not:
//   * every destination printed as its URL, because a hyperlink is inert on
//     paper. The same link, said the only way paper can say it.
//   * no contents index. On screen it is a jump target; on paper it would be a
//     list of titles with no page numbers beside them, and page numbers are
//     explicitly out of scope.
//   * the professional's details once, at the end, rather than on every page.

const has = (v: unknown) => String(v ?? "").trim().length > 0;
const txt = (v: unknown) => String(v ?? "").trim();

/** Only http(s) is shown as a destination — the same rule the email renderer
 *  uses, so a javascript: URL in a packet cannot be printed as one. */
const safeUrl = (v: unknown): string | null => {
  const s = txt(v);
  return /^https?:\/\//i.test(s) ? s : null;
};

/** A URL as a reader has to use it: no scheme noise, no trailing slash. */
const readable = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "");

function PhotoBlock({ item }: { item: Item }) {
  const photos = (item.photos ?? []).map(safeUrl).filter((u): u is string => Boolean(u));
  if (!photos.length) return null;
  const [hero, ...rest] = photos;

  return (
    <>
      {/* ~300dpi renditions at the printed size, so paper gets the resolution
          it can actually show without pulling full originals for every tile. */}
      <img className="pg-hero" src={thumbnailUrl(hero, 1600)} alt={item.title} />
      {rest.length > 0 && (
        <div className="pg-photos">
          {rest.map((url, i) => (
            <img key={i} className="pg-photo" src={squareThumbnailUrl(url, 480)} alt="" />
          ))}
        </div>
      )}
    </>
  );
}

function ItemBlock({ item }: { item: Item }) {
  const { links, contactWebsiteVisible } = resolveCardLinks(
    item.links,
    (item.contacts ?? []).map((c) => c.website),
  );
  const details = (item.details ?? []).filter((d) => has(d?.value));
  const contacts = (item.contacts ?? []).filter((c) =>
    [c.name, c.role, c.phone, c.email, c.website].some(has));
  const shownLinks = links
    .map(({ link, label }) => ({ url: safeUrl(link.url), label }))
    .filter((l): l is { url: string; label: string } => Boolean(l.url));

  return (
    <div className="pg-item">
      {/* Title, address and description travel together: a community's name
          stranded at the foot of a page with its photographs overleaf is the
          single worst thing paper can do to this document. */}
      <div className="pg-item-head">
        <h3 className="pg-item-title">{item.title}</h3>
        {has(item.address) && <p className="pg-address">{txt(item.address)}</p>}
        {has(item.description) && <p className="pg-desc">{txt(item.description)}</p>}
      </div>

      {/* Written for this reader, so it belongs on their copy. Guarded on
          has() so an empty value prints no box. */}
      {has(item.highlight) && <p className="pg-highlight">{txt(item.highlight)}</p>}

      <PhotoBlock item={item} />

      {details.length > 0 && (
        <div className="pg-details">
          {details.map((d, i) => (
            // A LABEL-LESS DETAIL IS A SENTENCE. The row below is a
            // space-between pair with a right-aligned value, which reads a
            // whole sentence against the right margin when there is no label
            // to balance it. Full width and left aligned instead — the same
            // decision the web card makes, for the same content.
            <div key={i} className={String(d?.label ?? "").trim() ? "pg-detail-row" : "pg-detail-row pg-detail-row--bare"}>
              {String(d?.label ?? "").trim() && <span className="pg-detail-label">{d.label}</span>}
              <span className="pg-detail-value">{d.value}</span>
            </div>
          ))}
        </div>
      )}

      {shownLinks.length > 0 && (
        <div className="pg-links">
          {shownLinks.map(({ url, label }, i) => (
            <p key={i} className="pg-link">
              <b>{label}:</b> <span className="pg-url">{readable(url)}</span>
            </p>
          ))}
        </div>
      )}

      {contacts.map((c, i) => {
        const site = contactWebsiteVisible[i] === true ? safeUrl(c.website) : null;
        const head = [c.name, c.role].filter(has).map(txt).join(" · ");
        const ways = [c.phone, c.email].filter(has).map(txt);
        if (site) ways.push(readable(site));
        return (
          <div key={i} className="pg-contact">
            {head && <p className="pg-contact-name">{head}</p>}
            {ways.length > 0 && <p className="pg-contact-line">{ways.join("  ·  ")}</p>}
          </div>
        );
      })}
    </div>
  );
}

function SectionBlock({ section }: { section: Section }) {
  return (
    <div className="pg-section">
      {(has(section.title) || has(section.description)) && (
        <div className="pg-section-head">
          {has(section.title) && <h2 className="pg-section-title">{txt(section.title)}</h2>}
          {has(section.description) && <p className="pg-section-desc">{txt(section.description)}</p>}
        </div>
      )}
      {section.items.map((item) => <ItemBlock key={item.id} item={item} />)}
    </div>
  );
}

export function PrintPacket({ packet, liveUrl }: { packet: Packet; liveUrl: string }) {
  const pro = packet.professional ?? ({} as Packet["professional"]);
  const logo = safeUrl(pro.logoUrl);
  const headshot = safeUrl(pro.headshotUrl);
  const site = safeUrl(pro.websiteUrl)
    ?? (has(pro.websiteUrl) ? `https://${txt(pro.websiteUrl)}` : null);

  return (
    <div className="pg-doc">
      {logo && <img className="pg-logo" src={logo} alt={txt(pro.businessName) || "Logo"} />}
      {has(pro.businessName) && <p className="pg-business">{txt(pro.businessName)}</p>}
      {/* The client title, when the professional chose one. Blank omits the
          heading rather than printing an empty line — see packet-header.tsx. */}
      {has(packet.clientTitle) && <h1 className="pg-title">{txt(packet.clientTitle)}</h1>}
      {has(packet.clientName) && <p className="pg-for">Prepared for {txt(packet.clientName)}</p>}
      {/* Paper is a supporting renderer: it exists to lead back to the live
          FlowGuide, so the address is printed where a reader will find it. */}
      <p className="pg-live">The interactive version, with all photos: <b>{readable(liveUrl)}</b></p>

      <hr className="pg-rule" />

      {has(packet.personalNote) && <div className="pg-note">{txt(packet.personalNote)}</div>}

      {packet.sections.map((section) => <SectionBlock key={section.id} section={section} />)}

      {has(pro.name) && (
        <div className="pg-footer">
          {has(pro.footerLabel) && <p className="pg-footer-label">{txt(pro.footerLabel)}</p>}
          <div className="pg-ident">
            {headshot && <img className="pg-headshot" src={thumbnailUrl(headshot, 320)} alt={txt(pro.name)} />}
            <div>
              <p className="pg-pro-name">{txt(pro.name)}</p>
              {has(pro.businessName) && <p className="pg-pro-biz">{txt(pro.businessName)}</p>}
              {[txt(pro.phone), txt(pro.email)].filter(Boolean).length > 0 && (
                <p className="pg-pro-line">{[txt(pro.phone), txt(pro.email)].filter(Boolean).join("  ·  ")}</p>
              )}
              {site && <p className="pg-pro-line">{readable(site)}</p>}
              {(pro.links ?? []).map((l, i) => {
                const target = safeUrl(l?.url) ?? (has(l?.url) ? `https://${txt(l.url)}` : null);
                if (!target) return null;
                return (
                  <p key={i} className="pg-pro-line">
                    {has(l?.label) ? `${txt(l.label)}: ` : ""}{readable(target)}
                  </p>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <p className="pg-tail">{readable(liveUrl)} · Powered by Sendset</p>
    </div>
  );
}
