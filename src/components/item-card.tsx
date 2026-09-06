"use client";

import { Item } from "@/lib/types";
import { detectLinkType, resolveCardLinks, type LinkType } from "@/lib/item-links";
import { PhotoGallery } from "./photo-gallery";

// URL type detection, labelling, and link identity live in @/lib/item-links so
// the rules are pure and unit-testable; this file keeps only presentation.

// SVG icons per link type
function LinkIcon({ type }: { type: LinkType }) {
  switch (type) {
    case "video":
      return (
        <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      );
    case "brochure":
      return (
        <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
      );
    case "map":
      return (
        <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      );
    default:
      return (
        <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      );
  }
}

// THE COLOUR OF ONE LINK TYPE, taken from the treatment rather than chosen
// here. The four palettes used to be a switch of Tailwind literals; they are now
// four variables the treatment emits, and a treatment that unifies its link
// colours emits the same values for all four. The ICON is untouched either way
// — nothing the packet distinguishes is lost, only the hue.
//
// The var NAME is composed from the type the packet already carries, so there
// is no branch here and no treatment is ever named.
function linkChipVars(type: LinkType): React.CSSProperties {
  return {
    "--sg-chip-ink": `var(--sg-link-${type}-ink)`,
    "--sg-chip-ground": `var(--sg-link-${type}-ground)`,
    "--sg-chip-hover": `var(--sg-link-${type}-hover)`,
    "--sg-chip-rule": `var(--sg-link-${type}-rule)`,
  } as React.CSSProperties;
}

function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("/")[0] || null;
    if (u.hostname.includes("youtube.com") && u.searchParams.has("v")) return u.searchParams.get("v");
    const shortsMatch = u.hostname.includes("youtube.com") && u.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]+)/);
    if (shortsMatch) return shortsMatch[1];
  } catch { /* not a valid URL */ }
  return null;
}

function mapsUrl(address: string): string {
  return `https://www.google.com/maps/search/${encodeURIComponent(address)}`;
}

// ============================================================
// Detail row treatment
//
// A detail is a generic label/value pair, but the two shapes it takes want
// opposite layouts, so the renderer classifies each row by the length of its
// VALUE — not by what the value means. This is deliberately content-shape based,
// not domain based: nothing here knows about prices or any vertical.
//
//   atomic  (short value)  — an indivisible token: a price, a count, a range,
//                            a short phrase. Anchored top-right in a stable
//                            value column and never wrapped or shrunk; the
//                            label flows around it. Keeps a column of values
//                            scannable down the card even when labels are long
//                            enough to wrap onto two or three lines.
//
//   block   (long value)   — a phrase, a sentence, a URL. Sits inline when it
//                            genuinely fits, and stacks to full width when it
//                            does not (see the row comment below).
//
// The threshold is a rendering judgement about what still reads as one token at
// mobile width, not a limit on what may be authored — every value renders in
// full either way, and nothing is ever truncated.
// ============================================================
const SHORT_VALUE_MAX_CHARS = 20;

const isAtomicValue = (value: string) => value.trim().length <= SHORT_VALUE_MAX_CHARS;

// ============================================================
// Item Card
// ============================================================
// AUDIENCE DEFAULTS TO "recipient". A caller that forgets the prop gets the
// private behaviour, so a new surface cannot leak the professional's note by
// omission. Only the editor opts in.
export function ItemCard({ item, audience = "recipient" }: { item: Item; audience?: "recipient" | "professional" }) {
  // One destination, one button — decided in @/lib/item-links, which also picks
  // the hostname fallback when two surviving links would read the same. Item
  // links win placement over a contact website with the same destination,
  // because they draw first. Nothing is removed from the packet.
  const { links: visibleLinks, contactWebsiteVisible } = resolveCardLinks(
    item.links,
    (item.contacts ?? []).map((contact) => contact.website),
  );

  return (
    <div
      className="overflow-hidden"
      style={{
        background: "var(--sg-card-ground)",
        border: "var(--sg-card-border)",
        borderRadius: "var(--sg-card-radius)",
      }}
    >
      {/* Photos at the top */}
      {item.photos && item.photos.length > 0 && (
        <PhotoGallery photos={item.photos} />
      )}

      <div className="min-w-0" style={{ padding: "var(--sg-card-pad)" }}>
        <h3
          className="text-[length:var(--sg-item-title)] text-[color:var(--sg-ink)] mb-1"
          style={{
            fontFamily: "var(--sg-font-display)",
            fontWeight: "var(--sg-item-title-weight)",
            letterSpacing: "var(--sg-title-tracking)",
          }}
        >
          {item.title}
        </h3>

        {/* Address with Google Maps link */}
        {item.address && (
          <a
            href={mapsUrl(item.address)}
            target="_blank"
            rel="noopener noreferrer"
            className="sg-link flex items-start gap-1.5 mb-3 group"
            style={{ fontSize: "var(--sg-body)", lineHeight: "var(--sg-body-lh)" }}
          >
            <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="group-hover:underline min-w-0 break-words">{item.address}</span>
          </a>
        )}

        {/* whitespace-pre-line keeps the paragraph breaks the professional
            typed. Without it HTML collapses every newline to a space and three
            paragraphs arrive as one block. `pre-line` (not `pre-wrap`) also
            collapses runs of spaces, which is what prose wants. */}
        {item.description && (
          <p
            className="text-[length:var(--sg-body)] leading-relaxed mb-4 whitespace-pre-line"
            style={{ color: "var(--sg-prose)" }}
          >
            {item.description}
          </p>
        )}

        {item.details && item.details.length > 0 && (
          <div
            className="mb-4 overflow-hidden"
            style={{
              background: "var(--sg-details-ground)",
              borderStyle: "solid",
              borderWidth: "var(--sg-details-border-width)",
              borderColor: "var(--sg-line)",
              borderRadius: "var(--sg-details-radius)",
            }}
          >
            {item.details.map((detail, i) => {
              const atomic = isAtomicValue(detail.value);
              const divider = i !== item.details!.length - 1 ? "border-b border-[color:var(--sg-line)]" : "";

              // A DETAIL WITH NO LABEL IS A STATEMENT, NOT A KEY AND A VALUE.
              //
              // Every layout below is a two-column one, and the value column is
              // right-aligned so a run of short values reads as a column. Hand
              // that an empty label and a whole sentence is shoved against the
              // right edge with nothing beside it — which is exactly what a line
              // accepted from "Add these to the item" is: source prose with no
              // label, because the source gave it none and nothing here invents
              // one. So it gets its own row: full width, left aligned, read as
              // the sentence it is.
              if (!String(detail.label ?? "").trim()) {
                return (
                  <div
                    key={i}
                    className={divider}
                    style={{ padding: "var(--sg-details-row-pad)", fontSize: "var(--sg-body)", lineHeight: "var(--sg-body-lh)", color: "var(--sg-ink)" }}
                  >
                    <span className="[overflow-wrap:anywhere]">{detail.value}</span>
                  </div>
                );
              }

              // ATOMIC ROW — never wraps or stacks, at any width. The value is
              // flex-shrink-0, so it always keeps its full natural width and the
              // label absorbs every bit of the pressure by wrapping. items-start
              // keeps the value on the first line, so values stay aligned across
              // rows regardless of how tall their labels grow. This is what makes
              // a run of short values scannable as a column.
              if (atomic) {
                return (
                  <div
                    key={i}
                    className={`flex items-start gap-x-6 ${divider}`}
                    style={{ padding: "var(--sg-details-row-pad)", fontSize: "var(--sg-body)", lineHeight: "var(--sg-body-lh)" }}
                  >
                    {/* flex-1 + min-w-0 lets the label take the remaining space
                        and wrap inside it; overflow-wrap:anywhere guarantees even
                        a single unbroken word yields rather than pushing the
                        value out of the card. */}
                    <span
                      className="flex-1 min-w-0 font-medium [overflow-wrap:anywhere]"
                      style={{ color: "var(--sg-label)" }}
                    >
                      {detail.label}
                    </span>
                    <span className="flex-shrink-0 whitespace-nowrap text-right text-[color:var(--sg-ink)]">
                      {detail.value}
                    </span>
                  </div>
                );
              }

              // BLOCK ROW — a long value cannot be an anchor, so this row stays
              // space-adaptive instead. `flex-wrap` makes it content-driven:
              // flexbox breaks a line using each item's max-content width, so the
              // value moves to its own row exactly when it cannot sit beside the
              // label at natural width, and only shrinks once it is down there
              // with the full row to use. Inline on a wide card, stacked on a
              // narrow one — no breakpoints, no measurement, no JS.
              //
              // Alignment falls out of the layout rather than being asserted:
              // justify-between pushes an inline value to the right edge, while a
              // stacked value is alone on its line and therefore starts at the
              // left, which is what prose needs. A literal text-right would keep
              // right-aligning a paragraph after it stacked.
              //
              // gap-x-6 is the "comfortably" threshold — a value that would fit
              // beside its label with under 1.5rem of clearance stacks instead of
              // being crammed.
              return (
                <div
                  key={i}
                  className={`flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 ${divider}`}
                  style={{ padding: "var(--sg-details-row-pad)", fontSize: "var(--sg-body)", lineHeight: "var(--sg-body-lh)" }}
                >
                  <span className="min-w-0 font-medium break-words" style={{ color: "var(--sg-label)" }}>
                    {detail.label}
                  </span>
                  {/* overflow-wrap:anywhere (not break-words) so an unbroken token
                      — a long URL — can shrink instead of overflowing the card. It
                      lowers min-content only, leaving the max-content width that
                      drives the stack decision untouched. */}
                  <span className="min-w-0 text-[color:var(--sg-ink)] [overflow-wrap:anywhere]">{detail.value}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* HIGHLIGHT FOR CLIENT — the opposite of the private note below it.
            Written by the professional FOR this reader, so it renders on every
            audience including the recipient. Guarded on trim() so an empty or
            whitespace-only value produces no callout at all rather than an
            empty amber box. React escapes the text; it is never HTML. */}
        {item.highlight?.trim() && (
          <div
            className="sg-highlight mb-4"
            style={{
              background: "var(--sg-highlight-bg)",
              borderStyle: "solid",
              borderWidth: "var(--sg-highlight-border-width)",
              borderColor: "var(--sg-highlight-rule)",
              borderRadius: "var(--sg-highlight-radius)",
              padding: "var(--sg-highlight-pad)",
              color: "var(--sg-highlight-ink)",
            }}
          >
            <p className="text-[length:var(--sg-small)] leading-relaxed whitespace-pre-line">{item.highlight}</p>
          </div>
        )}

        {/* PRIVATE. Shown only on an explicitly professional surface, and said
            out loud there, because the Library promises "Only you see this" and
            that promise has to be true wherever the note appears. The recipient
            never receives this field — queries.ts drops it before the data
            reaches the page — so this guard is defence in depth, not the fix. */}
        {audience === "professional" && item.notes?.trim() && (
          <div
            className="mb-4 border border-[color:var(--sg-line)] bg-[color:var(--sg-surface)] px-3.5 py-3"
            style={{ borderRadius: "var(--sg-radius-inner)" }}
          >
            <p className="text-xs font-medium text-[color:var(--sg-muted)]">Private note · only you see this</p>
            <p className="mt-1 text-sm text-[color:var(--sg-ink)] leading-relaxed whitespace-pre-wrap">{item.notes}</p>
          </div>
        )}

        {visibleLinks.length > 0 && (() => {
          const youtubeLinks = visibleLinks.filter(l => extractYouTubeId(l.link.url));
          const otherLinks = visibleLinks.filter(l => !extractYouTubeId(l.link.url));
          return (
            <>
              {youtubeLinks.map(({ link, label }, i) => {
                const videoId = extractYouTubeId(link.url)!;
                return (
                  <a
                    key={`yt-${i}`}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block relative mb-4 overflow-hidden group"
                    style={{ borderRadius: "var(--sg-image-radius)" }}
                  >
                    <img
                      src={`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`}
                      alt={label}
                      className="w-full aspect-video object-cover"
                    />
                    <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
                      <div className="w-14 h-14 rounded-full bg-red-600 flex items-center justify-center shadow-lg">
                        <svg className="w-6 h-6 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </div>
                    </div>
                    <div className="absolute bottom-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded">
                      {label}
                    </div>
                  </a>
                );
              })}
              {otherLinks.length > 0 && (
                <div className="flex flex-wrap gap-[var(--sg-chip-gap)] mb-4">
                  {otherLinks.map(({ link, label }, i) => {
                    const type = detectLinkType(link.url);
                    return (
                      <a
                        key={i}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="sg-chip items-center gap-1.5 max-w-full min-w-0 font-medium"
                        style={{ ...linkChipVars(type), fontSize: "var(--sg-body)" }}
                      >
                        <LinkIcon type={type} />
                        {/* min-w-0 + anywhere so a long hostname fallback shrinks
                            inside the card instead of overflowing it. */}
                        <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
                      </a>
                    );
                  })}
                </div>
              )}
            </>
          );
        })()}

        {item.contacts && item.contacts.length > 0 && (
          <div className="border-t border-[color:var(--sg-line)] pt-3 mt-1 space-y-3">
            {item.contacts.map((contact, ci) => (
              <div key={ci}>
                {(contact.name || contact.role) && (
                  <p
                    className="font-medium text-[color:var(--sg-ink)] mb-1.5"
                    style={{ fontSize: "var(--sg-body)", lineHeight: "var(--sg-body-lh)" }}
                  >
                    {contact.name}
                    {contact.role && (
                      <span className="text-[color:var(--sg-muted)] font-normal">{contact.name ? " — " : ""}{contact.role}</span>
                    )}
                  </p>
                )}
                <div className="flex flex-wrap gap-[var(--sg-chip-gap)]">
                  {contact.phone && (
                    <a
                      href={`tel:${contact.phone}`}
                      className="sg-chip items-center gap-1.5 font-medium"
                      style={{ fontSize: "var(--sg-body)" }}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                      </svg>
                      {contact.phone}
                    </a>
                  )}
                  {contact.email && (
                    <a
                      href={`mailto:${contact.email}`}
                      className="sg-chip items-center gap-1.5 font-medium"
                      style={{ fontSize: "var(--sg-body)" }}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                      </svg>
                      Email
                    </a>
                  )}
                  {/* Suppressed only when this exact destination is already on
                      the card — most often the same URL also stored as an item
                      link, or a second contact sharing one website. A contact
                      website that goes somewhere new still renders. */}
                  {contact.website && contactWebsiteVisible[ci] && (
                    <a
                      href={contact.website.startsWith("http") ? contact.website : `https://${contact.website}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="sg-chip items-center gap-1.5 font-medium"
                      style={{ fontSize: "var(--sg-body)" }}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9" />
                      </svg>
                      Website
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
