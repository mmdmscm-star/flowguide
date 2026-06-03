"use client";

import { useState } from "react";
import { Item } from "@/lib/types";

function PhotoGallery({ photos }: { photos: string[] }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  return (
    <>
      <div className="mb-4 -mx-5">
        <div className="relative">
          <img
            src={photos[activeIndex]}
            alt=""
            className="w-full h-48 object-cover cursor-pointer"
            onClick={() => setLightboxOpen(true)}
          />
          {photos.length > 1 && (
            <div className="absolute bottom-2 right-3 bg-black/60 text-white text-xs px-2 py-0.5 rounded-full">
              {activeIndex + 1} / {photos.length}
            </div>
          )}
        </div>
        {photos.length > 1 && (
          <div className="flex gap-1.5 px-5 mt-2">
            {photos.map((photo, i) => (
              <button
                key={i}
                onClick={() => setActiveIndex(i)}
                className={`h-12 w-12 rounded-lg overflow-hidden border-2 flex-shrink-0 ${
                  i === activeIndex ? "border-accent" : "border-transparent"
                }`}
              >
                <img
                  src={photo}
                  alt=""
                  className="w-full h-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
      </div>

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

export function ItemCard({ item }: { item: Item }) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="p-5">
        <h3 className="text-base font-semibold text-foreground mb-1">
          {item.title}
        </h3>

        {item.description && (
          <p className="text-sm leading-relaxed text-foreground/80 mb-4">
            {item.description}
          </p>
        )}

        {item.photos && item.photos.length > 0 && (
          <PhotoGallery photos={item.photos} />
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
                <span className="text-muted font-medium">{detail.label}</span>
                <span className="text-foreground text-right ml-4">
                  {detail.value}
                </span>
              </div>
            ))}
          </div>
        )}

        {item.notes && (
          <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg px-3.5 py-3">
            <p className="text-sm text-amber-900 leading-relaxed">
              {item.notes}
            </p>
          </div>
        )}

        {item.links && item.links.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            {item.links.map((link, i) => (
              <a
                key={i}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:text-accent-hover px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-100 transition-colors"
              >
                <svg
                  className="w-3.5 h-3.5 flex-shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                  />
                </svg>
                {link.label || link.url}
              </a>
            ))}
          </div>
        )}

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
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
                    />
                  </svg>
                  {item.contact.phone}
                </a>
              )}
              {item.contact.email && (
                <a
                  href={`mailto:${item.contact.email}`}
                  className="inline-flex items-center gap-1.5 text-sm text-accent font-medium px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-100"
                >
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                    />
                  </svg>
                  Email
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
