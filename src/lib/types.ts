export interface ItemContact {
  name?: string;
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
  notes?: string;
  photos?: string[];
  details?: ItemDetail[];
  links?: ItemLink[];
  contact?: ItemContact;
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
  title: string;
  clientName?: string;
  personalNote?: string;
  mapUrl?: string;
  // Legacy packets carry `sections`; block packets carry an ordered `blocks`
  // body. `compositionMode` selects which the renderer reads. Defaults to
  // "legacy" so every existing code path and packet behaves exactly as before.
  compositionMode?: "legacy" | "blocks";
  sections: Section[];
  blocks?: PacketBlock[];
  professional: ProfessionalContact;
}
