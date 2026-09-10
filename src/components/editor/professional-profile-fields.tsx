"use client";

import ImageUploadField from "./image-upload-field";
import { INPUT_SHELL } from "@/components/ui/field";

// THE PROFESSIONAL'S NINE FIELDS, IN ONE PLACE.
//
// Lifted verbatim out of the legacy editor, where they were the only way to
// reach a professional's identity — a block-editor user had no path to them at
// all, and a new professional had to open a packet to discover they existed.
//
// PRESENTATIONAL ONLY. It renders fields and reports changes; it never saves.
// The legacy editor keeps its own debounced PATCH and its own save indicator,
// and Settings keeps its own, so extracting these fields changed no save
// behaviour anywhere. What the extraction buys is that the FIELDS cannot drift:
// a tenth field, or a renamed placeholder, now lands in both surfaces at once.
//
// The chrome around it belongs to the caller. The editor frames these as "your
// default profile, edited in the middle of a packet"; Settings frames them as
// the account's own page. Same fields, different sentence.

export interface ProfileFields {
  name: string;
  email: string;
  phone: string;
  businessName: string;
  logoUrl: string;
  headshotUrl: string;
  footerLabel: string;
  websiteUrl: string;
  links: { label: string; url: string }[];
}

// The shared field shell, so this form gets the phone padding and the 16px
// that stops iOS zooming a focused input — and cannot drift from every other
// field in the app.
const INPUT = INPUT_SHELL;

export default function ProfessionalProfileFields({
  value,
  onField,
  onLinks,
  disabled,
}: {
  value: ProfileFields;
  onField: (field: string, value: string) => void;
  onLinks: (links: { label: string; url: string }[]) => void;
  disabled?: boolean;
}) {
  const links = value.links ?? [];

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input
          type="text"
          value={value.name}
          onChange={(e) => onField("name", e.target.value)}
          placeholder="Your name"
          disabled={disabled}
          className={INPUT}
        />
        <input
          type="text"
          value={value.businessName}
          onChange={(e) => onField("businessName", e.target.value)}
          placeholder="Business name (optional)"
          disabled={disabled}
          className={INPUT}
        />
        <input
          type="email"
          value={value.email}
          onChange={(e) => onField("email", e.target.value)}
          placeholder="Email"
          disabled={disabled}
          className={INPUT}
        />
        <input
          type="tel"
          value={value.phone}
          onChange={(e) => onField("phone", e.target.value)}
          placeholder="Phone"
          disabled={disabled}
          className={INPUT}
        />
      </div>

      <div className="mt-3">
        <input
          type="text"
          value={value.footerLabel}
          onChange={(e) => onField("footerLabel", e.target.value)}
          placeholder="Footer label (e.g. Your Advisor)"
          disabled={disabled}
          className={`w-full ${INPUT}`}
        />
        <p className="mt-1 text-meta text-ink-2">
          Shown above your name on the packet. Leave blank to hide it.
        </p>
      </div>

      <div className="mt-3">
        <ImageUploadField
          value={value.logoUrl}
          onChange={(url) => onField("logoUrl", url)}
          placeholder="Logo URL, or upload"
          disabled={disabled}
          preview={<img src={value.logoUrl} alt="Logo" className="h-10 w-auto max-w-[120px] object-contain rounded" />}
        />
        <div className="mt-2">
          <ImageUploadField
            value={value.headshotUrl}
            onChange={(url) => onField("headshotUrl", url)}
            placeholder="Headshot URL, or upload"
            disabled={disabled}
            preview={<img src={value.headshotUrl} alt="Headshot" className="w-10 h-10 rounded-full object-cover flex-shrink-0 border border-line" />}
          />
        </div>
        <input
          type="url"
          value={value.websiteUrl}
          onChange={(e) => onField("websiteUrl", e.target.value)}
          placeholder="Website URL (optional)"
          disabled={disabled}
          className={`mt-2 w-full ${INPUT}`}
        />
      </div>

      {/* Links (optional) — e.g. Facebook, LinkedIn, Calendly */}
      <div className="mt-4">
        <label className="block text-meta font-medium uppercase tracking-widest text-ink-2 mb-2">
          Links (optional)
        </label>
        {links.length > 0 && (
          <div className="space-y-2 mb-2">
            {links.map((link, index) => (
              /* A LABEL BESIDE A URL IS A DESKTOP ARRANGEMENT. At 390px the
                 fixed 9rem label left the URL box about 150 pixels, which is
                 not enough to read a link in. They stack on a phone; Remove
                 keeps its place at the end of the label's line, where it is a
                 real target rather than a 12px glyph. */
              <div key={index}
                   className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                <input
                  type="text"
                  value={link.label}
                  onChange={(e) =>
                    onLinks(links.map((l, i) => (i === index ? { ...l, label: e.target.value } : l)))}
                  placeholder="Label (e.g. Facebook)"
                  disabled={disabled}
                  className={`${INPUT} min-w-0 flex-1 sm:w-36 sm:flex-none`}
                />
                <button
                  type="button"
                  onClick={() => onLinks(links.filter((_, i) => i !== index))}
                  aria-label="Remove link"
                  className="flex h-11 w-10 flex-none items-center justify-center rounded-[var(--radius-control)]
                             text-title leading-none text-ink-3 transition-colors hover:bg-red-50
                             hover:text-red-700 sm:order-last sm:h-auto sm:w-auto sm:px-1 sm:text-body
                             sm:hover:bg-transparent"
                >
                  ×
                </button>
                <input
                  type="url"
                  value={link.url}
                  onChange={(e) =>
                    onLinks(links.map((l, i) => (i === index ? { ...l, url: e.target.value } : l)))}
                  placeholder="https://..."
                  disabled={disabled}
                  className={`${INPUT} min-w-0 basis-full sm:basis-auto sm:flex-1`}
                />
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => onLinks([...links, { label: "", url: "" }])}
          className="text-body text-mark hover:text-mark-hover font-medium"
        >
          + Add link
        </button>
      </div>
    </>
  );
}
