// Finding a FlowGuide in a list that only ever grows.
//
// Pure, and separate from the dashboard, so the two properties that are easy to
// break later can be asserted: that filtering never reorders, and that "no
// matches" is not the same state as "no FlowGuides".

export interface FilterablePacket {
  title: string;
  client_name: string;
  slug: string;
  status: string;
}

export type StatusFilter = "all" | "draft" | "published";

/** Anything not published is a draft for this purpose - a status the filter has
 *  not heard of should appear under Drafts rather than vanish from every view. */
export const isPublished = (p: { status: string }) => p.status === "published";

/**
 * Case-insensitive match across the three things a professional would actually
 * remember: what they called it, who it was for, and the link they sent.
 *
 * ORDER IS PRESERVED. The API returns updated_at desc and this only removes
 * entries; re-sorting here would silently override that.
 */
export function filterPackets<T extends FilterablePacket>(
  packets: T[], query: string, status: StatusFilter,
): T[] {
  const needle = query.trim().toLowerCase();
  return packets.filter((p) => {
    if (status === "published" && !isPublished(p)) return false;
    if (status === "draft" && isPublished(p)) return false;
    if (!needle) return true;
    return [p.title, p.client_name, p.slug]
      .some((f) => String(f ?? "").toLowerCase().includes(needle));
  });
}
