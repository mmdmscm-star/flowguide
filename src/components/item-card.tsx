"use client";

import { useState } from "react";
import { Item, ItemLink } from "@/lib/types";

// ============================================================
// Photo gallery with lightbox
// ============================================================
function PhotoGallery({ photos }: { photos: string[] }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  return (
    <>
      <div className="relative">
        <img
          src={photos[activeIndex]}
          alt=""
          className="w-full max-h-[28rem] object-contain cursor-pointer"
          onClick={() => setLightboxOpen(true)}
        />
        {photos.length > 1 && (
          <div className="absolute bottom-2 right-3 bg-black/60 text-white text-xs px-2 py-0.5 rounded-full">
            {activeIndex + 1} / {photos.length}
          </div>
        )}
      </div>
      {photos.length > 1 && (
        <div className="flex gap-1.5 px-5 mt-2 mb-1">
          {photos.map((photo, i) => (
            <button
              key={i}
              onClick={() => setActiveIndex(i)}
              className={`h-12 w-12 rounded-lg overflow-hidden border-2 flex-shrink-0 ${
                i === activeIndex ? "border-accent" : "border-transparent"
              }`}
            >
              <img src={photo} alt="" className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      )}

      {lightboxOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
          onClick={() => setLightboxOpen(false)}
        >
          <button
            className="absolute top-4 right-4 text-white/80 hover:text-white text-3xl leading-none"
            onClick={() => setLightboxOpen(false)}
          >
            &times;
          </button>
          <img
            src={photos[activeIndex]}
            alt=""
            className="max-w-full max-h-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

// ============================================================
// URL type detection and smart labels
// ============================================================
type LinkType = "video" | "brochure" | "map" | "website";

function detectLinkType(url: string): LinkType {
  const lower = url.toLowerCase();
  if (lower.includes("youtube.com") || lower.includes("youtu.be") || lower.includes("vimeo.com") || lower.endsWith(".mp4")) {
    return "video";
  }
  if (lower.endsWith(".pdf") || lower.includes("/brochure") || lower.includes("/flyer")) {
    return "brochure";
  }
  if (lower.includes("google.com/maps") || lower.includes("goo.gl/maps") || lower.includes("maps.app.goo.gl")) {
    return "map";
  }
  return "website";
}

function smartLabel(link: ItemLink): string {
  if (link.label) return link.label;
  const type = detectLinkType(link.url);
  switch (type) {
    case "video": return "Virtual Tour";
    case "brochure": return "Brochure";
    case "map": return "View on Map";
    default:
      try { return new URL(link.url).hostname.replace("www.", ""); }
      catch { return "Link"; }
  }
}

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

// Link style variations
function linkStyles(type: LinkType): string {
  switch (type) {
    case "video":
      return "text-red-600 bg-red-50 border-red-100 hover:bg-red-100";
    case "brochure":
      return "text-amber-700 bg-amber-50 border-amber-100 hover:bg-amber-100";
    case "map":
      return "text-green-700 bg-green-50 border-green-100 hover:bg-green-100";
    default:
      return "text-accent bg-blue-50 border-blue-100 hover:bg-blue-100";
  }
}

function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("/")[0] || null;
    if (u.hostname.includes("youtube.com") && u.searchParams.has("v")) return u.searchParams.get("v");
  } catch { /* not a valid URL */ }
  return null;
}

function mapsUrl(address: string): string {
  return `https://www.google.com/maps/search/${encodeURIComponent(address)}`;
}

// ============================================================
// Item Card
// ============================================================
export function ItemCard({ item }: { item: Item }) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      {/* Photos at the top */}
      {item.photos && item.photos.length > 0 && (
        <PhotoGallery photos={item.photos} />
      )}

      <div className="p-5 min-w-0">
        <h3 className="text-base font-semibold text-foreground mb-1">
          {item.title}
        </h3>

        {/* Address with Google Maps link */}
        {item.address && (
          <a
            href={mapsUrl(item.address)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-start gap-1.5 text-sm text-accent hover:text-accent-hover mb-3 group"
          >
            <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="group-hover:underline min-w-0 break-words">{item.address}</span>
          </a>
        )}

        {item.description && (
          <p className="text-sm leading-relaxed text-foreground/80 mb-4">
            {item.description}
          </p>
        )}

        {item.details && item.details.length > 0 && (
          <div className="mb-4 rounded-lg bg-surface border border-border overflow-hidden">
            {item.details.map((detail, i) => (
              <div
                key={i}
                className={`flex justify-between px-3.5 py-2.5 text-sm ${
                  i !== item.details!.length - 1 ? "border-b border-border" : ""
                }`}
              >
                <span className="text-muted font-medium flex-shrink-0">{detail.label}</span>
                <span className="text-foreground text-right ml-4 min-w-0 break-words">{detail.value}</span>
              </div>
            ))}
          </div>
        )}

        {item.notes && (
          <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg px-3.5 py-3">
            <p className="text-sm text-amber-900 leading-relaxed">{item.notes}</p>
          </div>
        )}

        {item.links && item.links.length > 0 && (() => {
          const youtubeLinks = item.links.filter(l => extractYouTubeId(l.url));
          const otherLinks = item.links.filter(l => !extractYouTubeId(l.url));
          return (
            <>
              {youtubeLinks.map((link, i) => {
                const videoId = extractYouTubeId(link.url)!;
                return (
                  <a
                    key={`yt-${i}`}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block relative mb-4 rounded-lg overflow-hidden group"
                  >
                    <img
                      src={`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`}
                      alt={smartLabel(link)}
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
                      {smartLabel(link)}
                    </div>
                  </a>
                );
              })}
              {otherLinks.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-4">
                  {otherLinks.map((link, i) => {
                    const type = detectLinkType(link.url);
                    return (
                      <a
                        key={i}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg border transition-colors ${linkStyles(type)}`}
                      >
                        <LinkIcon type={type} />
                        {smartLabel(link)}
                      </a>
                    );
                  })}
                </div>
              )}
            </>
          );
        })()}

        {item.contact && (
          <div className="border-t border-border pt-3 mt-1">
            {item.contact.name && (
              <p className="text-sm font-medium text-foreground mb-1.5">
                {item.contact.name}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {item.contact.phone && (
                <a
                  href={`tel:${item.contact.phone}`}
                  className="inline-flex items-center gap-1.5 text-sm text-accent font-medium px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-100"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                  </svg>
                  {item.contact.phone}
                </a>
              )}
              {item.contact.email && (
                <a
                  href={`mailto:${item.contact.email}`}
                  className="inline-flex items-center gap-1.5 text-sm text-accent font-medium px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-100"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  Email
                </a>
              )}
              {item.contact.website && (
                <a
                  href={item.contact.website.startsWith("http") ? item.contact.website : `https://${item.contact.website}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-accent font-medium px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-100"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9" />
                  </svg>
                  Website
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
