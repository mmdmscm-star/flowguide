import { normalizeLinkUrl } from "./canonical.ts";

// SUPPLY THE SCHEME BEFORE THE WRITER ASKS FOR IT.
//
// `finalize_ingestion_run` persists a link only when its url is `LIKE 'http%'`,
// in both of its branches. That strictness is correct — it is what keeps
// arbitrary strings, `javascript:` and stray prose out of item_links — but
// nothing supplied the scheme a professional did not type, so a bare hostname
// the model had placed correctly at `links[].url` was written nowhere and
// reported nowhere. That is the demonstrated silent loss: the model extracted
// it, enforcement saw it and counted it present, and it never reached the
// packet.
//
// FIXED HERE RATHER THAN IN THE WRITER, deliberately. The rule for what counts
// as a hostname is backed by the Public Suffix List through tldts and by the
// filename guard beside it; re-expressing that in plpgsql would be a second
// definition of "is this a URL" that could disagree with the first. Normalizing
// the staged result instead means the writer keeps its strict gate, both
// branches are covered without either being touched, and there is one
// implementation of the rule.
//
// LINKS ONLY. Photos carry the same `LIKE 'http%'` gate and are deliberately
// left alone: `mediaOccurrences` recognises media in the SOURCE only when it is
// scheme-qualified, so packet-side and source-side currently agree. Qualifying a
// photo here and not there would produce a photo the ledger cannot account for,
// and `media_not_in_source` BLOCKS publishing — turning a silent drop into a
// blocked packet. Changing photos requires changing both together.

type Item = Record<string, unknown>;

function normalizeItem(item: Item): Item {
  const links = item.links;
  if (!Array.isArray(links) || links.length === 0) return item;
  let changed = false;
  const next = links.map((l) => {
    if (!l || typeof l !== "object") return l;
    const link = l as Record<string, unknown>;
    const url = normalizeLinkUrl(link.url);
    // null means "not a link we can store" — left exactly as it was so the
    // writer rejects it as it does today. This function only ever qualifies a
    // hostname; it never removes anything and never invents a link.
    if (url === null || url === link.url) return l;
    changed = true;
    return { ...link, url };
  });
  return changed ? { ...item, links: next } : item;
}

/**
 * The staged chunk result with every storable bare hostname qualified.
 *
 * Shape-preserving and total: a result with no items, no links, or nothing to
 * change comes back untouched, so this is safe to run on every chunk whether or
 * not contract enforcement is enabled.
 */
export function normalizeStagedLinks(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as { items?: unknown; sections?: unknown };

  const items = Array.isArray(r.items)
    ? r.items.map((i) => (i && typeof i === "object" ? normalizeItem(i as Item) : i))
    : r.items;

  const sections = Array.isArray(r.sections)
    ? r.sections.map((s) => {
        if (!s || typeof s !== "object") return s;
        const sec = s as { items?: unknown };
        if (!Array.isArray(sec.items)) return s;
        return { ...sec, items: sec.items.map((i) => (i && typeof i === "object" ? normalizeItem(i as Item) : i)) };
      })
    : r.sections;

  return { ...r, ...(items !== undefined ? { items } : {}), ...(sections !== undefined ? { sections } : {}) };
}
