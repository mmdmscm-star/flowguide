import type { Packet, Item, Section, PacketBlock } from "@/lib/types";
import { resolveCardLinks } from "@/lib/item-links";
import { packetMapUrl } from "@/lib/maps-url";
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

// A BLOCK-COMPOSED BODY, ON PAPER.
//
// The flat ordered sequence the recipient page renders, printed. Four kinds
// exist and the database says so — `block_type in ('heading','subheading',
// 'label','item')` — so this switch is exhaustive by constraint, not by hope.
//
// IT RENDERS NO ITEM ITSELF. An `item` block delegates to the same ItemBlock a
// legacy section uses, which is the whole reason block support is small: photos,
// address, highlight, details, links and contacts already print correctly, and
// a second item renderer would be a second place for them to drift. A test
// fails if any item markup appears in this function.
//
// `first` exists for one reason — see .pg-block-heading--first in print.css.
function PrintBlockBody({ blocks }: { blocks: PacketBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === "item") return <ItemBlock key={b.id} item={b.item} />;

        if (b.kind === "label") {
          // Paper already had this idiom before blocks existed: the business
          // eyebrow above the title and the footer label both set it. Reusing
          // it rather than inventing a third uppercase style is what keeps a
          // label recognisable as the same thing wherever it appears.
          return has(b.text)
            ? <p key={b.id} className="pg-block-label">{txt(b.text)}</p>
            : null;
        }

        if (b.kind === "subheading") {
          return (
            <div key={b.id} className="pg-block-sub">
              {has(b.text) && <h3 className="pg-block-sub-title">{txt(b.text)}</h3>}
              {has(b.subtext) && <p className="pg-block-sub-desc">{txt(b.subtext)}</p>}
            </div>
          );
        }

        // heading — the section semantics paper already has. A converted packet
        // therefore prints the way its legacy form did, which is the point of
        // the conversion being lossless.
        //
        // THE FIRST HEADING IS DIFFERENT, and deliberately. .pg-section-title
        // carries a top rule and a section gap so a heading separates itself
        // from the block above it. The first block in the body has nothing
        // above it but the document's own <hr>, so the unmodified rule would draw two
        // rules a few millimetres apart and open the body with a gap. The
        // modifier removes both. Legacy has never hit this because a section's
        // rule follows the same <hr> only when the packet has exactly one
        // section — which is why this is a block-body rule, not a change to
        // .pg-section-title.
        const first = i === 0;
        return (
          <div key={b.id} className={`pg-block-head${first ? " pg-block-head--first" : ""}`}>
            {has(b.text) && <h2 className="pg-section-title">{txt(b.text)}</h2>}
            {has(b.subtext) && <p className="pg-section-desc">{txt(b.subtext)}</p>}
          </div>
        );
      })}
    </>
  );
}

export function PrintPacket({ packet, liveUrl }: { packet: Packet; liveUrl: string }) {
  const pro = packet.professional ?? ({} as Packet["professional"]);
  const logo = safeUrl(pro.logoUrl);
  const headshot = safeUrl(pro.headshotUrl);
  const site = safeUrl(pro.websiteUrl)
    ?? (has(pro.websiteUrl) ? `https://${txt(pro.websiteUrl)}` : null);
  // Canonical packet content that paper used to drop silently. The shared rule,
  // not this file's local safeUrl — see @/lib/maps-url.
  const packetMap = packetMapUrl(packet.mapUrl);

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

      {/* THE PACKET'S MAP LINK, in the same place the web page puts it: after
          the note, before the body. Paper cannot open a link, so it gets the
          treatment paper already uses for the live URL above — a label and the
          address itself, readable and typeable, rather than a button that does
          nothing or a bare URL with no clue where it leads.

          Deliberately NOT a QR code in this slice, and deliberately not an
          embedded map image: both would need decisions this package has not
          made. The map stays a link the reader can follow on their own.

          "Map:" and nothing more. The professional pasted a link; what is on
          the other side of it is theirs, not ours to summarise. "Map of these
          locations" would be this renderer asserting something about content
          it has never seen. */}
      {packetMap && (
        <p className="pg-live">Map: <b>{readable(packetMap)}</b></p>
      )}

      {/* THE SAME BRANCH THE RECIPIENT PAGE MAKES, on the same field. Paper
          used to 404 for block packets rather than choose here, which meant a
          professional who converted their Sendset lost the printed copy and
          was told the page did not exist. */}
      {packet.compositionMode === "blocks"
        ? <PrintBlockBody blocks={packet.blocks ?? []} />
        : packet.sections.map((section) => <SectionBlock key={section.id} section={section} />)}

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
