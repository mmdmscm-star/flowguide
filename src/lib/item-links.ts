import type { ItemLink } from "./types";

// ============================================================
// Link identity and labelling for an item card — pure, render-time only.
//
// Two buttons pointing at the SAME destination are noise, so a card shows one.
// Two buttons pointing at DIFFERENT destinations are both real, even when the
// professional labelled both of them "Website" — those must never be collapsed,
// only told apart. So identity is decided by destination, never by label.
//
// Nothing here reads or writes stored data; it decides only what is drawn.
// ============================================================

export type LinkType = "video" | "brochure" | "map" | "website";

export function detectLinkType(url: string): LinkType {
  const lower = (url || "").toLowerCase();
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

export function smartLabel(link: ItemLink): string {
  if (link.label) return link.label;
  switch (detectLinkType(link.url)) {
    case "video": return "Virtual Tour";
    case "brochure": return "Brochure";
    case "map": return "View on Map";
    default: return hostLabel(link.url) ?? "Link";
  }
}

// Normalization is deliberately conservative: it folds only differences that
// cannot change where the link goes.
//
//   folded     scheme (http/https), a leading "www.", case of the host, a
//              trailing slash, and a missing scheme entirely (contact websites
//              are often stored bare, as "example.com")
//
//   PRESERVED  path and its case (paths are case-sensitive on most servers),
//              query string verbatim with order intact, fragment, port, and
//              every subdomain other than www
//
// So example.com/a vs example.com/b, a.example.com vs b.example.com, and
// ?unit=2 vs ?unit=3 all stay distinct. Anything unparseable, or any non-http
// scheme (mailto:, tel:), falls back to exact text comparison rather than
// guessing at equivalence.
export function normalizeDestination(raw: string | undefined | null): string | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  let url: URL;
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return trimmed.toLowerCase(); // unparseable — compare literally
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return trimmed.toLowerCase(); // mailto:/tel:/etc — leave identity alone
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const port = url.port ? `:${url.port}` : "";
  const path = url.pathname.replace(/\/+$/, ""); // case preserved on purpose
  return `${host}${port}${path}${url.search}${url.hash}`;
}

// Bare hostname, used to tell apart distinct destinations that would otherwise
// render the same button text.
export function hostLabel(raw: string | undefined | null): string | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.hostname.replace(/^www\./i, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

export interface ResolvedLink {
  link: ItemLink;
  /** What the button should read — the author's label, or a hostname fallback. */
  label: string;
}

export interface ResolvedCardLinks {
  links: ResolvedLink[];
  /** Aligned to the contacts passed in: whether each contact's website renders. */
  contactWebsiteVisible: boolean[];
}

/**
 * Decides which link buttons a card draws, and what each one reads.
 *
 * Item links are considered before contact websites because they draw above
 * them, so a link keeps its placement and a contact website that resolves to
 * the same destination is the one suppressed.
 *
 * When two surviving links would draw the same text, the label has stopped
 * doing its job and the button falls back to the hostname — the same text an
 * unlabelled link already shows, so nothing new is invented. The fallback is
 * applied only where it actually distinguishes: if the colliding links share a
 * hostname too, the author's label is left alone rather than replaced with text
 * that is equally ambiguous.
 */
export function resolveCardLinks(
  links: ItemLink[] | undefined,
  contactWebsites: Array<string | undefined> | undefined,
): ResolvedCardLinks {
  const shown = new Set<string>();

  const visible: ItemLink[] = [];
  for (const link of links ?? []) {
    const key = normalizeDestination(link.url);
    if (!key || shown.has(key)) continue;
    shown.add(key);
    visible.push(link);
  }

  const contactWebsiteVisible = (contactWebsites ?? []).map((website) => {
    const key = normalizeDestination(website);
    if (!key || shown.has(key)) return false;
    shown.add(key);
    return true;
  });

  const labelCounts = new Map<string, number>();
  const hostCounts = new Map<string, number>();
  for (const link of visible) {
    const label = smartLabel(link).toLowerCase();
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    const host = hostLabel(link.url);
    if (host) hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
  }

  const resolved = visible.map((link) => {
    const label = smartLabel(link);
    if ((labelCounts.get(label.toLowerCase()) ?? 0) < 2) return { link, label };
    const host = hostLabel(link.url);
    if (!host || (hostCounts.get(host) ?? 0) > 1) return { link, label };
    return { link, label: host };
  });

  return { links: resolved, contactWebsiteVisible };
}
