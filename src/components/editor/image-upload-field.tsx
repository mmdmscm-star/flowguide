"use client";

import { useState } from "react";
import { PHOTO_ACCEPT_ATTR } from "@/lib/photo-upload";
import { INPUT_SHELL } from "@/components/ui/field";

// One field, four places: the account profile's logo and headshot, and the
// per-packet custom identity's logo and headshot. All four were a preview plus
// a URL box; leaving any of them paste-only would be exactly the gap this
// feature exists to close.
//
// UPLOAD SITS BESIDE THE URL BOX, never instead of it. A professional whose logo
// already lives somewhere should not have to re-upload it to keep working.
//
// The component STORES nothing itself: it hands the resulting URL to onChange,
// and the existing profile save path persists it exactly as a pasted URL would
// be. Which field it lands in, and when it saves, are decisions this component
// does not make.
export default function ImageUploadField({
  value,
  onChange,
  placeholder,
  preview,
  disabled,
}: {
  value: string;
  onChange: (url: string) => void;
  placeholder: string;
  /** Rendered when there is a value — shapes differ (logo is wide, headshot is
   *  a circle), so the caller owns it. */
  preview?: React.ReactNode;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function upload(file: File) {
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/profile/images", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.url) {
        setError(data?.message || "Could not upload that image.");
        return;
      }
      onChange(data.url as string);
    } catch {
      setError("Could not upload that image. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {/* THREE THINGS DO NOT FIT ON ONE LINE OF A PHONE, and this row was the
          reason the whole page overflowed. Two faults, one visible:

          `flex-1` WITHOUT `min-w-0` — a flex item's automatic minimum is its
          content, so the URL box refused to shrink below the width of the URL
          in it, pushed Upload off the right edge, and widened the PAGE. That is
          why the paragraph above was clipped too: one overflowing row makes
          every well-behaved element beside it look broken.

          And even shrinking correctly, a preview, a URL and an Upload button
          leave a phone about ninety pixels of URL. So below `sm` the row
          becomes: preview and Upload together on one line, the URL box full
          width beneath them. Same three controls, same order, nothing hidden. */}
      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-3">
        {value && preview}
        <label
          /* DOM order is Upload-then-URL so the phone can put Upload beside the
             preview; `sm:order-2` puts the URL back in front of it on a wider
             screen, where it always was. Order is stated on BOTH sides rather
             than left to the DOM on one of them. */
          className={`order-1 flex h-11 shrink-0 cursor-pointer items-center rounded-[var(--radius-control)]
                      border border-line px-3.5 text-meta transition-colors hover:bg-ground-3
                      sm:order-2 sm:h-auto sm:px-3 sm:py-2
                      ${busy || disabled ? "opacity-60 pointer-events-none" : ""}`}
        >
          {busy ? "Uploading…" : "Upload"}
          <input
            type="file"
            accept={PHOTO_ACCEPT_ATTR}
            className="hidden"
            disabled={busy || disabled}
            onChange={(e) => {
              const f = e.target.files?.[0];
              // Cleared so choosing the same file twice still fires.
              e.target.value = "";
              if (f) upload(f);
            }}
          />
        </label>
        <input
          type="url"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className={`${INPUT_SHELL} order-2 min-w-0 basis-full sm:order-1 sm:basis-auto sm:flex-1`}
        />
      </div>
      {error && <p className="mt-1 text-meta text-red-700">{error}</p>}
    </div>
  );
}
