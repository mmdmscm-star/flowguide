// KEEPING A USER-DEFINED VOCABULARY CLEAN WITHOUT ADMINISTERING ONE.
//
// Categories and labels are whatever the professional types. That is the point:
// another profession fills the same fields with entirely different words. But
// free text drifts — "Santa Rosa" typed once and "santa rosa" typed later
// become two filter chips for one idea, and the Library quietly fragments.
//
// The fix is not a taxonomy table. It is to REUSE what they have already said:
// a new term that matches an existing one case-insensitively adopts the
// existing spelling. The vocabulary converges by itself, with nothing to
// administer and no screen to visit.
//
// Pure, so the rules are testable without a database.

/** Collapse internal runs of whitespace too: "Memory   Care" and "Memory Care"
 *  are the same idea typed twice, and two chips would be a bug either way. */
function tidy(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

const fold = (s: string) => s.toLowerCase();

/**
 * One category, trimmed, adopting an existing spelling when there is one.
 *
 * `existing` is the professional's own vocabulary — the distinct categories
 * already in their Library. Nothing is invented for them.
 */
export function normalizeCategory(raw: unknown, existing: string[] = []): string {
  const wanted = tidy(raw);
  if (!wanted) return "";
  const match = existing.map(tidy).find((e) => e && fold(e) === fold(wanted));
  return match ?? wanted;
}

/**
 * Labels: trimmed, blanks dropped, de-duplicated within the item, and matched
 * to existing spelling where the professional already has one.
 *
 * Order is preserved as typed. It carries no meaning, but reordering someone's
 * input for no reason is the kind of small surprise that makes software feel
 * like it is arguing with you.
 */
export function normalizeLabels(raw: unknown, existing: string[] = []): string[] {
  const source = Array.isArray(raw) ? raw : [];
  const known = new Map<string, string>();
  for (const e of existing.map(tidy)) if (e && !known.has(fold(e))) known.set(fold(e), e);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of source) {
    const wanted = tidy(entry);
    if (!wanted) continue;                       // a blank chip cannot be selected or removed
    const key = fold(wanted);
    if (seen.has(key)) continue;                 // the same label twice on one item is not two labels
    seen.add(key);
    out.push(known.get(key) ?? wanted);
  }
  return out;
}

/** The distinct vocabulary in use, for filter chips and for spelling reuse.
 *  Derived from the material rather than maintained beside it. */
export function vocabularyOf(
  rows: Array<{ category?: unknown; labels?: unknown }>,
): { categories: string[]; labels: string[] } {
  const cats = new Map<string, string>();
  const labs = new Map<string, string>();
  for (const r of rows) {
    const c = tidy(r.category);
    if (c && !cats.has(fold(c))) cats.set(fold(c), c);
    for (const l of (Array.isArray(r.labels) ? r.labels : [])) {
      const t = tidy(l);
      if (t && !labs.has(fold(t))) labs.set(fold(t), t);
    }
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
  return { categories: [...cats.values()].sort(byName), labels: [...labs.values()].sort(byName) };
}

// ---------------------------------------------------------------------------
// KEYSET PAGINATION
//
// searchLibrary capped at 50 rows and never said so, which with 65 saved items
// meant fifteen were unreachable unless you already knew to search for them. A
// larger cap is the same defect further away.
//
// The order is `updated_at desc, id desc`. updated_at ALONE IS NOT A TOTAL
// ORDER — two items saved in one transaction tie, and a cursor comparing only
// updated_at then skips the tied row or repeats it, depending on which side of
// the comparison it lands. id is the primary key, so the pair is unique.
// ---------------------------------------------------------------------------

export interface LibraryCursor {
  /** The RAW postgres timestamp string, never a Date round-trip: timestamptz is
   *  microsecond precision and a JS Date is milliseconds, so a round-trip
   *  truncates and the page boundary silently repeats or skips a row. */
  updatedAt: string;
  id: string;
}

export function cursorFrom(row: { updatedAt?: unknown; updated_at?: unknown; id: unknown }): LibraryCursor {
  return { updatedAt: String(row.updatedAt ?? row.updated_at ?? ""), id: String(row.id) };
}

/** `(updated_at, id) < (cursor.updatedAt, cursor.id)`, as PostgREST spells it.
 *  Values are quoted because a timestamp carries `+` and `:`. */
export function cursorFilter(cursor: LibraryCursor): string {
  const ts = cursor.updatedAt.replace(/"/g, "");
  const id = cursor.id.replace(/"/g, "");
  return `updated_at.lt."${ts}",and(updated_at.eq."${ts}",id.lt."${id}")`;
}
