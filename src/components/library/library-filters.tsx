"use client";
import type { LibraryVocabulary } from "@/lib/library-organization";

// ONE FILTER SURFACE, wherever the Library is shown.
//
// The workspace and both pickers use this same component, so filtering while
// assembling a FlowGuide is the thing already learned in the Library rather
// than a second system that happens to look similar.
//
// VIEWS, NOT MODES. All / Favorites / a category / labels narrow one list and
// compose with the search box and with each other. Nothing here switches
// between separate collections.
//
// CALM WHEN THERE IS NOTHING TO SAY. A Library with no categories and no labels
// yet renders nothing at all — not an empty row of controls explaining what
// could exist. The vocabulary comes from the professional's own material, so
// the surface appears as they create it.

export interface LibraryFilterState {
  category: string;
  labels: string[];
  favorite: boolean;
}

export const EMPTY_FILTERS: LibraryFilterState = { category: "", labels: [], favorite: false };

export function filtersActive(f: LibraryFilterState): boolean {
  return !!f.category || f.labels.length > 0 || f.favorite;
}

/**
 * Is there anything worth showing?
 *
 * Extracted so the rule can be tested directly rather than inferred from a
 * render that returns null.
 *
 * FAVORITES DOES NOT DEPEND ON CATEGORY OR LABEL VOCABULARY. The first version
 * gated the whole surface on categories and labels existing, with `value.favorite`
 * as the only other way in — and that is the filter's own state, not whether
 * anything is starred. So a professional who starred an item and had filed
 * nothing saw no Favorites chip, and the only way to reveal it was a filter they
 * could not switch on because the chip was not rendered. A closed loop.
 *
 * `hasFavorites` comes from the material, so starring one thing is enough. The
 * chip also stays while the filter is ON, so unstarring the last item cannot
 * strand someone inside a view with no way out.
 */
export function shouldShowFilters(vocabulary: LibraryVocabulary, value: LibraryFilterState): boolean {
  return vocabulary.categories.length > 0
    || vocabulary.labels.length > 0
    || vocabulary.hasFavorites
    || value.favorite;
}

export function LibraryFilters({
  vocabulary, value, onChange, className = "",
}: {
  vocabulary: LibraryVocabulary;
  value: LibraryFilterState;
  onChange: (next: LibraryFilterState) => void;
  className?: string;
}) {
  if (!shouldShowFilters(vocabulary, value)) return null;

  const toggleLabel = (l: string) =>
    onChange({ ...value, labels: value.labels.includes(l)
      ? value.labels.filter((x) => x !== l)
      : [...value.labels, l] });

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      <Chip active={!filtersActive(value)} onClick={() => onChange(EMPTY_FILTERS)}>All</Chip>
      <Chip active={value.favorite} onClick={() => onChange({ ...value, favorite: !value.favorite })}>
        ★ Favorites
      </Chip>
      {vocabulary.categories.map((c) => (
        <Chip key={`c:${c}`} active={value.category === c}
          onClick={() => onChange({ ...value, category: value.category === c ? "" : c })}>
          {c}
        </Chip>
      ))}
      {vocabulary.labels.map((l) => (
        <Chip key={`l:${l}`} active={value.labels.includes(l)} subtle onClick={() => toggleLabel(l)}>
          {l}
        </Chip>
      ))}
    </div>
  );
}

/** One chip. The same control for categories and labels, because they narrow
 *  the same list in the same way; only the emphasis differs, since a category
 *  is where something lives and a label is something it happens to be. */
function Chip({
  active, subtle = false, onClick, children,
}: {
  active: boolean; subtle?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-accent bg-accent text-white"
          : subtle
            ? "border-border bg-white text-muted hover:border-accent"
            : "border-border bg-white text-foreground hover:border-accent"
      }`}
    >
      {children}
    </button>
  );
}
