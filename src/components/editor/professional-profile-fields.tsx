"use client";

import ImageUploadField from "./image-upload-field";

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

const INPUT =
  "px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent";

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
        <p className="mt-1 text-xs text-muted">
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
            preview={<img src={value.headshotUrl} alt="Headshot" className="w-10 h-10 rounded-full object-cover flex-shrink-0 border border-border" />}
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
        <label className="block text-xs font-medium uppercase tracking-widest text-muted mb-2">
          Links (optional)
        </label>
        {links.length > 0 && (
          <div className="space-y-2 mb-2">
            {links.map((link, index) => (
              <div key={index} className="flex items-center gap-2">
                <input
                  type="text"
                  value={link.label}
                  onChange={(e) =>
                    onLinks(links.map((l, i) => (i === index ? { ...l, label: e.target.value } : l)))}
                  placeholder="Label (e.g. Facebook)"
                  disabled={disabled}
                  className={`w-36 flex-shrink-0 ${INPUT}`}
                />
                <input
                  type="url"
                  value={link.url}
                  onChange={(e) =>
                    onLinks(links.map((l, i) => (i === index ? { ...l, url: e.target.value } : l)))}
                  placeholder="https://..."
                  disabled={disabled}
                  className={`flex-1 min-w-0 ${INPUT}`}
                />
                <button
                  type="button"
                  onClick={() => onLinks(links.filter((_, i) => i !== index))}
                  aria-label="Remove link"
                  className="text-muted hover:text-red-600 px-1 flex-shrink-0"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => onLinks([...links, { label: "", url: "" }])}
          className="text-sm text-accent hover:text-accent-hover font-medium"
        >
          + Add link
        </button>
      </div>
    </>
  );
}
