// COLLAPSING MANY PROPOSALS INTO THE ONE ITEM THE CREATOR ASKED FOR.
//
// keep_together is a statement about the whole ingestion run: this source
// describes one thing. Chunking is an implementation detail — a 26-row pricing
// sheet is only 1,077 characters and still becomes five chunks, because the
// segmenter's budget is six items — and the creator should never have to know
// that. So each chunk proposes what it can and the run's proposals are folded
// together here, once, before anything is written to the packet.
//
// THIS IS AN OPERATION, NOT AN INFERENCE. Nothing here matches titles, guesses
// which items belong together, or decides that two things are the same thing.
// It runs only because the professional explicitly said "keep this together",
// and it folds exactly what it is given, in the order it is given.
//
// NOTHING IS DISCARDED FOR NOT FITTING. An item has one address and one
// description; a run may propose several. The first non-empty value takes the
// canonical field and every DIFFERING one is kept as a detail, verbatim, under
// a mechanical label. A silently chosen winner is how a client ends up reading
// one of two addresses with no sign the other existed.
//
// It is deliberately pure and knows nothing about runs, chunks or the database,
// because the user-facing "Combine items" correction will want this same
// operation and must not have to reach through an ingestion route to get it.

export interface CollapsibleItem {
  title?: unknown;
  address?: unknown;
  description?: unknown;
  notes?: unknown;
  highlight?: unknown;
  details?: unknown;
  links?: unknown;
  photos?: unknown;
  contacts?: unknown;
}

export interface CollapsedItem {
  title: string;
  address: string;
  description: string;
  notes: string;
  highlight: string;
  details: { label: string; value: string }[];
  links: { url: string; label?: string }[];
  photos: string[];
  contacts: Record<string, string>[];
}

const str = (v: unknown) => String(v ?? "").trim();
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The label a displaced scalar is filed under. MECHANICAL: the field's own
 *  name, nothing written about it. A generated sentence here would be this
 *  module inventing recipient-facing prose, which is not its job. */
const SCALAR_LABEL: Record<"address" | "description" | "highlight", string> = {
  address: "Address",
  description: "Description",
  highlight: "Highlight",
};

/**
 * Fold many proposed items into one, under a title the creator owns.
 *
 * ORDER IS THE CALLER'S. Items arrive in source/chunk/item order and are folded
 * in that order, so the first chunk's address is the item's address and later
 * ones queue behind it as details. Nothing is sorted or ranked.
 *
 * IDEMPOTENT. Folding a single already-folded item reproduces it: the title is
 * already the creator's, the canonical scalars are already first, and the
 * duplicate suppression is exact-match, so re-running changes nothing.
 */
export function collapseToOneItem(items: CollapsibleItem[], title: string): CollapsedItem {
  const out: CollapsedItem = {
    title: String(title), address: "", description: "", notes: "", highlight: "",
    details: [], links: [], photos: [], contacts: [],
  };

  // Exact-duplicate suppression only. Two details that differ by a character
  // are two facts; deciding otherwise would be the inference this module refuses.
  const seenDetail = new Set<string>();
  const seenLink = new Set<string>();
  const seenPhoto = new Set<string>();
  const seenContact = new Set<string>();
  const notes: string[] = [];
  // A displaced scalar is only worth keeping if it says something the canonical
  // one does not.
  const scalarSeen: Record<string, Set<string>> = {
    address: new Set(), description: new Set(), highlight: new Set(),
  };

  const pushDetail = (label: string, value: string) => {
    const l = str(label), v = str(value);
    if (!l && !v) return;
    const key = JSON.stringify([l, v]);
    if (seenDetail.has(key)) return;
    seenDetail.add(key);
    out.details.push({ label: l, value: v });
  };

  for (const raw of items) {
    const it = (raw ?? {}) as CollapsibleItem;

    // SCALARS. First non-empty wins the field; anything different is kept.
    for (const field of ["address", "description", "highlight"] as const) {
      const v = str(it[field]);
      if (!v) continue;
      if (!out[field]) { out[field] = v; scalarSeen[field].add(v); continue; }
      if (scalarSeen[field].has(v)) continue;      // the same value twice is one fact
      scalarSeen[field].add(v);
      pushDetail(SCALAR_LABEL[field], v);
    }

    // NOTES ARE PRIVATE and never reach a client, so they simply accumulate.
    // Nothing has to be displaced, because nothing is competing for a field a
    // reader will see.
    const n = str(it.notes);
    if (n && !notes.includes(n)) notes.push(n);

    for (const d of arr(it.details)) {
      const o = (d ?? {}) as { label?: unknown; value?: unknown };
      pushDetail(str(o.label), str(o.value));
    }

    for (const l of arr(it.links)) {
      const o = (l ?? {}) as { url?: unknown; label?: unknown };
      const url = str(o.url);
      if (!url || seenLink.has(url)) continue;
      seenLink.add(url);
      const label = str(o.label);
      out.links.push(label ? { url, label } : { url });
    }

    for (const p of arr(it.photos)) {
      // Both shapes the pipeline uses: a bare url and { url }.
      const url = typeof p === "string" ? str(p) : str((p as { url?: unknown })?.url);
      if (!url || seenPhoto.has(url)) continue;
      seenPhoto.add(url);
      out.photos.push(url);
    }

    for (const c of arr(it.contacts)) {
      const o = (c ?? {}) as Record<string, unknown>;
      const kept: Record<string, string> = {};
      for (const k of ["name", "role", "phone", "email", "website"]) {
        const v = str(o[k]);
        if (v) kept[k] = v;
      }
      if (!Object.keys(kept).length) continue;
      const key = JSON.stringify(kept);
      if (seenContact.has(key)) continue;
      seenContact.add(key);
      out.contacts.push(kept);
    }
  }

  out.notes = notes.join("\n\n");
  return out;
}
