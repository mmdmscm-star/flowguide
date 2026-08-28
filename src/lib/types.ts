export interface ItemContact {
  name?: string;
  role?: string;
  phone?: string;
  email?: string;
  website?: string;
}

export interface ItemDetail {
  label: string;
  value: string;
}

export interface ItemLink {
  url: string;
  label?: string;
}

export interface Item {
  id: string;
  title: string;
  address?: string;
  description?: string;
  /** PRIVATE to the professional. Never assembled into recipient data. */
  notes?: string;
  /** Recipient-facing highlighted callout, written by the professional for this
   *  client. Distinct from `notes`: this one IS shown to the client. */
  highlight?: string;
  photos?: string[];
  details?: ItemDetail[];
  links?: ItemLink[];
  contacts?: ItemContact[];
}

export interface Section {
  id: string;
  title: string;
  description?: string;
  items: Item[];
}

export interface ProfessionalLink {
  label: string;
  url: string;
}

export interface ProfessionalContact {
  name: string;
  email?: string;
  phone?: string;
  businessName?: string;
  logoUrl?: string;
  headshotUrl?: string;
  footerLabel?: string;
  websiteUrl?: string;
  links?: ProfessionalLink[];
}

// A single block in a block-mode packet's ordered body. Headings/subheadings/
// labels carry text; item blocks reference assembled item content. This is the
// canonical shape shared by the production recipient renderer and the hidden
// persisted-block preview, so the two never drift.
export type PacketBlock =
  | { id: string; kind: "heading" | "subheading" | "label"; text: string; subtext?: string }
  | { id: string; kind: "item"; item: Item };

export interface Packet {
  slug: string;
  /** The professional's INTERNAL name for this FlowGuide. Never rendered to a
   *  recipient — that is `clientTitle`. Required before publishing, because a
   *  FlowGuide has to be findable in My FlowGuides. */
  title: string;
  /** The OPTIONAL heading a recipient sees. Blank means the title area is left
   *  out entirely, which is a choice rather than a missing value. */
  clientTitle?: string;
  clientName?: string;
  personalNote?: string;
  mapUrl?: string;
  // Legacy packets carry `sections`; block packets carry an ordered `blocks`
  // body. `compositionMode` selects which the renderer reads. Defaults to
  // "legacy" so every existing code path and packet behaves exactly as before.
  compositionMode?: "legacy" | "blocks";
  /** Recipient PRESENTATION only: render the multi-item section index.
   *  Defaults to true, so an absent value behaves exactly as before. Not
   *  content — see migration 0030 and ingest_bump_packet_self(). */
  showQuickNav?: boolean;
  sections: Section[];
  blocks?: PacketBlock[];
  professional: ProfessionalContact;
}
