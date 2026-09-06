"use client";

// ============================================================
// The recipient's photo experience.
//
// Shared by every packet renderer (legacy sections, block mode, and the editor
// preview) via ItemCard, so a change here reaches every surface at once. This is
// a RENDERER concern only: it reads `item.photos` and changes nothing about the
// canonical item/photo model.
//
// Four decisions carry most of the behaviour, each validated on a real iPhone:
//
//   1. GEOMETRY. Every slide is `w-full shrink-0 grow-0 basis-full` and every
//      image is ABSOLUTELY POSITIONED. `min-width` is only a floor, and with
//      `flex-basis: auto` an image's intrinsic width can win — which iOS Safari
//      did, making slides wider than the track. The settled result showed a
//      slice of the neighbouring photo while the counter, derived from
//      scrollLeft/clientWidth, insisted otherwise. Stating the width four ways
//      and keeping content out of layout is what makes "exactly one photo owns
//      the viewport" true rather than approximately true.
//
//   2. WHOLE PHOTOGRAPHS. The frame has a fixed height so the card never jumps,
//      but the photo is contained, never cropped. Measured across the real
//      corpus, stored aspect ratios run 1.00–1.87 and 60% are square, so a
//      cover-crop to 4:3 was cutting the top and bottom off entire rooms. The
//      leftover area is filled with a softly blurred copy of the SAME image —
//      the identical URL, so it costs no extra request.
//
//   3. AN INDEX ON DEMAND. A permanently expanded thumbnail grid pushed the
//      community's name and price down the page, read as an image manager, and
//      downloaded every photo on every packet view. The index now lives behind
//      one restrained affordance and opens full screen.
//
//   4. BOUNDED LOADING. The carousel keeps only a small window of images
//      mounted, and index tiles ask their source for a small rendition, so a
//      36-photo listing does not pull 36 full-size images over cellular.
// ============================================================

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { thumbnailUrl } from "@/lib/image-source";

// Slides outside this distance keep their geometry but not their `src`. Bounded
// by design: the cost is the same whether an item has 12 photos or 60.
const PRELOAD_RADIUS = 2;

// Index tiles render ~114px wide on a phone; 240 covers a 2x display.
const INDEX_THUMB_PX = 240;

const NO_SCROLLBAR = "[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden";

// Read as an external store rather than mirrored into state: no synchronous
// setState in an effect, and it stays correct if the OS setting changes.
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const subscribeMotion = (cb: () => void) => {
  const mq = window.matchMedia(REDUCED_MOTION);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const getMotionSnapshot = () => window.matchMedia(REDUCED_MOTION).matches;
const getMotionServerSnapshot = () => false;
const useReducedMotion = () =>
  useSyncExternalStore(subscribeMotion, getMotionSnapshot, getMotionServerSnapshot);

/** One photograph, shown whole, inside a frame of fixed size. */
function Plate({ src, eager, sizes, backdrop, tone = "light" }: {
  src: string;
  eager: boolean;
  sizes?: string;
  tone?: "light" | "dark";
  /** always = the small framed plate; auto = only when the photo leaves a lot
   *  of empty screen; never = plain surround. */
  backdrop: "always" | "auto" | "never";
}) {
  const loading = eager ? "eager" : "lazy";
  const hostRef = useRef<HTMLDivElement>(null);
  const [fill, setFill] = useState(backdrop === "always");

  // Decide from the real photo against the real container. A 1.5:1 room photo
  // covers ~95% of a desktop viewport (plain black is right there) but only
  // ~26% of a portrait phone, where a blurred surround beats a void.
  const measure = useCallback((img: HTMLImageElement) => {
    if (backdrop !== "auto") return;
    const host = hostRef.current;
    if (!host || !img.naturalWidth || !img.naturalHeight) return;
    const box = host.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const imgAR = img.naturalWidth / img.naturalHeight;
    const boxAR = box.width / box.height;
    setFill(Math.min(imgAR, boxAR) / Math.max(imgAR, boxAR) < 0.62);
  }, [backdrop]);

  return (
    <div ref={hostRef} className="absolute inset-0">
      {fill && (
        <>
          <img
            src={src}
            alt=""
            aria-hidden="true"
            loading={loading}
            decoding="async"
            draggable={false}
            className={`absolute inset-0 h-full w-full scale-110 object-cover blur-2xl ${
              tone === "dark" ? "opacity-60" : ""
            }`}
          />
          {/* The wash must match the surface it sits on. A light wash suits the
              card; in full screen it washes the surround out and leaves the
              photograph looking subordinate to its own blur. */}
          <div className={`absolute inset-0 ${tone === "dark" ? "bg-black/65" : "bg-white/25"}`} />
        </>
      )}
      <img
        src={src}
        alt=""
        sizes={sizes}
        loading={loading}
        fetchPriority={eager ? "high" : "auto"}
        decoding="async"
        draggable={false}
        onLoad={(e) => measure(e.currentTarget)}
        className="absolute inset-0 h-full w-full object-contain"
      />
    </div>
  );
}

/**
 * A horizontal scroll-snap track. Scroll position is the source of truth — the
 * index follows the thumb rather than the thumb chasing state, which is what
 * makes it feel native rather than animated-at.
 */
function PhotoTrack({
  photos, index, onIndexChange, className, backdrop, tone, sizes, eagerFirst,
}: {
  photos: string[];
  index: number;
  onIndexChange: (i: number) => void;
  className?: string;
  backdrop: "always" | "auto" | "never";
  tone?: "light" | "dark";
  sizes?: string;
  eagerFirst?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const settling = useRef(false);
  const firstRun = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = index * el.clientWidth;
    if (Math.abs(el.scrollLeft - target) < 2) return;
    // A neighbouring move glides; a jump from the index to photo 31 CUTS.
    // Panning through thirty photos to arrive somewhere is slow, faintly
    // seasick, and defeats the point of random access.
    const isJump = Math.abs(target - el.scrollLeft) > el.clientWidth * 2.5;
    const instant = firstRun.current || reduced || isJump;
    firstRun.current = false;
    settling.current = true;
    el.scrollTo({ left: target, behavior: instant ? "auto" : "smooth" });
    const done = window.setTimeout(() => { settling.current = false; }, instant ? 0 : 400);
    return () => window.clearTimeout(done);
  }, [index, reduced]);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el || settling.current) return;
    const i = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
    if (i !== index && i >= 0 && i < photos.length) onIndexChange(i);
  }, [index, onIndexChange, photos.length]);

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className={`flex overflow-x-auto snap-x snap-mandatory overscroll-x-contain ${NO_SCROLLBAR} ${className ?? ""}`}
    >
      {photos.map((src, i) => (
        <div
          key={i}
          // The width is stated four ways so no engine can derive it from the
          // content instead. `snap-always` stops a fast flick skipping a stop.
          className="relative h-full w-full shrink-0 grow-0 basis-full snap-center snap-always overflow-hidden"
          role="group"
          aria-roledescription="slide"
          aria-label={`Photo ${i + 1} of ${photos.length}`}
        >
          {Math.abs(i - index) <= PRELOAD_RADIUS && (
            <Plate src={src} eager={i === 0 && Boolean(eagerFirst)} sizes={sizes} backdrop={backdrop} tone={tone} />
          )}
        </div>
      ))}
    </div>
  );
}

function Chevron({ dir }: { dir: "prev" | "next" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25}
      strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
      <path d={dir === "prev" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"} />
    </svg>
  );
}

function GridGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.6" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" />
    </svg>
  );
}

/** Edge affordance. Present on touch too — swipe is never the only way through. */
function EdgeButton({ dir, onClick, disabled, tone = "light" }: {
  dir: "prev" | "next"; onClick: () => void; disabled: boolean; tone?: "light" | "dark";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === "prev" ? "Previous photo" : "Next photo"}
      className={[
        "absolute top-1/2 -translate-y-1/2 z-20 grid place-items-center rounded-full",
        "h-10 w-10 backdrop-blur-md transition-all duration-200",
        dir === "prev" ? "left-2" : "right-2",
        tone === "light"
          ? "bg-white/75 text-gray-900 shadow-sm hover:bg-white"
          : "bg-white/10 text-white hover:bg-white/20",
        disabled ? "opacity-0 pointer-events-none" : "opacity-100",
      ].join(" ")}
    >
      <Chevron dir={dir} />
    </button>
  );
}

/** "3 of 12" — a quiet caption, not a badge sticker. */
function Counter({ index, total, tone = "light" }: { index: number; total: number; tone?: "light" | "dark" }) {
  return (
    <div
      aria-live="polite"
      className={[
        "rounded-full px-2.5 py-1 text-xs font-medium tabular-nums backdrop-blur-md",
        tone === "light" ? "bg-black/55 text-white" : "bg-white/10 text-white/90",
      ].join(" ")}
    >
      {index + 1} of {total}
    </div>
  );
}

/**
 * The photo index, as a temporary full-screen surface rather than a permanent
 * fixture. Because it is temporary it can afford to be generous: tiles are
 * ~114px, which is the difference between recognising a room and squinting at
 * one. Tiles are square and cropped on purpose — a thumbnail is a signpost, not
 * the photograph, and the whole image is one tap away.
 */
function PhotoIndex({ photos, index, onPick, onClose }: {
  photos: string[]; index: number; onPick: (i: number) => void; onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);

  return (
    <div className="absolute inset-0 z-30 overflow-y-auto overscroll-contain bg-black">
      <div className="sticky top-0 z-10 flex items-center justify-between bg-black/85 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-md">
        <h2 className="text-sm font-medium text-white/90">{photos.length} photos</h2>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close photo index"
          className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" className="h-5 w-5" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:grid-cols-4 lg:grid-cols-6">
        {photos.map((src, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onPick(i)}
            aria-label={`Show photo ${i + 1} of ${photos.length}`}
            aria-current={i === index}
            style={{ borderRadius: "var(--sg-thumb-radius)" }}
            className={`relative aspect-square overflow-hidden bg-white/5 transition duration-200 ${
              i === index ? "ring-2 ring-inset ring-white" : "opacity-80 hover:opacity-100"
            }`}
          >
            {/* A small rendition where the source can produce one, so a 40-photo
                listing stays reasonable on cellular. See lib/image-source.ts. */}
            <img
              src={thumbnailUrl(src, INDEX_THUMB_PX)}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              className="absolute inset-0 h-full w-full object-cover"
            />
          </button>
        ))}
      </div>
    </div>
  );
}

function Viewer({ photos, index, setIndex, onClose, mode, setMode }: {
  photos: string[]; index: number; setIndex: (i: number) => void; onClose: () => void;
  mode: "photo" | "index"; setMode: (m: "photo" | "index") => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => { closeRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape unwinds one layer at a time: index -> photo -> packet.
      if (e.key === "Escape") { e.preventDefault(); if (mode === "index") setMode("photo"); else onClose(); }
      else if (mode === "photo" && e.key === "ArrowRight") { e.preventDefault(); setIndex(Math.min(photos.length - 1, index + 1)); }
      else if (mode === "photo" && e.key === "ArrowLeft") { e.preventDefault(); setIndex(Math.max(0, index - 1)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, photos.length, onClose, setIndex, mode, setMode]);

  const single = photos.length === 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Photos, ${index + 1} of ${photos.length}`}
      className="fixed inset-0 z-50 bg-black"
      onClick={onClose}
    >
      <div
        className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-3 pt-[max(0.75rem,env(safe-area-inset-top))]"
        onClick={(e) => e.stopPropagation()}
      >
        {single ? (
          <div className="w-10" />
        ) : (
          <button
            type="button"
            onClick={() => setMode("index")}
            aria-label={`Show all ${photos.length} photos`}
            className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white backdrop-blur-md transition hover:bg-white/20"
          >
            <GridGlyph />
          </button>
        )}
        {!single && <Counter index={index} total={photos.length} tone="dark" />}
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close photos"
          className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white backdrop-blur-md transition hover:bg-white/20"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" className="h-5 w-5" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="relative h-full w-full" onClick={(e) => e.stopPropagation()}>
        <PhotoTrack
          photos={photos}
          index={index}
          onIndexChange={setIndex}
          backdrop="auto"
          tone="dark"
          eagerFirst
          sizes="100vw"
          className="h-full w-full"
        />
        {!single && (
          <>
            <EdgeButton dir="prev" tone="dark" onClick={() => setIndex(Math.max(0, index - 1))} disabled={index === 0} />
            <EdgeButton dir="next" tone="dark" onClick={() => setIndex(Math.min(photos.length - 1, index + 1))} disabled={index >= photos.length - 1} />
          </>
        )}
      </div>

      {mode === "index" && (
        <div onClick={(e) => e.stopPropagation()}>
          <PhotoIndex
            photos={photos}
            index={index}
            onPick={(i) => { setIndex(i); setMode("photo"); }}
            onClose={() => setMode("photo")}
          />
        </div>
      )}
    </div>
  );
}

export function PhotoGallery({ photos }: { photos: string[] }) {
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"photo" | "index">("photo");
  const triggerRef = useRef<HTMLButtonElement>(null);

  const openViewer = useCallback((m: "photo" | "index") => { setMode(m); setOpen(true); }, []);
  const close = useCallback(() => setOpen(false), []);

  // Restore focus AFTER React commits the viewer's removal. A
  // requestAnimationFrame here is too early: unmounting the dialog resets focus
  // to <body> afterwards, so focus is silently lost.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) triggerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  if (photos.length === 0) return null;
  const single = photos.length === 1;

  return (
    <>
      {/* THE FRAME IS THE TREATMENT'S; the photograph is the packet's. Aspect
          and backdrop are how a picture is presented, so they come from the
          treatment — nothing here crops, reorders or drops a photograph. */}
      <div
        className="relative w-full overflow-hidden sm:aspect-auto sm:h-[460px]"
        style={{ aspectRatio: "var(--sg-image-aspect)", background: "var(--sg-image-ground)" }}
      >
        <PhotoTrack
          photos={photos}
          index={index}
          onIndexChange={setIndex}
          backdrop="always"
          eagerFirst
          sizes="(min-width: 640px) 640px, 100vw"
          className="h-full w-full"
        />

        {/* The frame is the tap target, behind the controls so swipe and the
            chevrons still work. */}
        <button
          ref={triggerRef}
          type="button"
          onClick={() => openViewer("photo")}
          aria-label={`View photo ${index + 1} of ${photos.length} full screen`}
          className="absolute inset-0 z-10 cursor-zoom-in"
        />

        {!single && (
          <>
            <EdgeButton dir="prev" onClick={() => setIndex(Math.max(0, index - 1))} disabled={index === 0} />
            <EdgeButton dir="next" onClick={() => setIndex(Math.min(photos.length - 1, index + 1))} disabled={index >= photos.length - 1} />
            <div className="pointer-events-none absolute bottom-2.5 right-3 z-20">
              <Counter index={index} total={photos.length} />
            </div>
            {/* Sits ON the photograph, opposite the counter, so the index costs
                the packet zero vertical space and the item's name stays beside
                its picture. */}
            <button
              type="button"
              onClick={() => openViewer("index")}
              aria-label={`View all ${photos.length} photos`}
              className="absolute bottom-2.5 left-3 z-20 inline-flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-xs font-medium text-white backdrop-blur-md transition hover:bg-black/70"
            >
              <GridGlyph />
              View all {photos.length}
            </button>
          </>
        )}
      </div>

      {open && (
        <Viewer photos={photos} index={index} setIndex={setIndex} onClose={close} mode={mode} setMode={setMode} />
      )}
    </>
  );
}
