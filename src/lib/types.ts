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

export interface ProfessionalContact {
  name: string;
  email?: string;
  phone?: string;
  businessName?: string;
  logoUrl?: string;
}

export interface Packet {
  slug: string;
  title: string;
  clientName?: string;
  personalNote?: string;
  mapUrl?: string;
  sections: Section[];
  professional: ProfessionalContact;
}
