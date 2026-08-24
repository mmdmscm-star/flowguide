"use client";

import { useState } from "react";
import { PHOTO_ACCEPT_ATTR } from "@/lib/photo-upload";

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
      <div className="flex items-center gap-3">
        {value && preview}
        <input
          type="url"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className="flex-1 px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <label
          className={`shrink-0 px-3 py-2 rounded-lg border border-border text-sm cursor-pointer
                      hover:bg-gray-50 ${busy || disabled ? "opacity-60 pointer-events-none" : ""}`}
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
      </div>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}
