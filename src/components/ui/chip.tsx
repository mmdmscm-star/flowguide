// ONE CHIP, for every "which of these am I looking at" control.
//
// It existed twice: the Library's label and Favorites filters, and the
// Dashboard's All / Drafts / Published. Same job, same shape, two spellings —
// and on a phone the copy that had not been touched was 34px tall while the
// other was 44, which is exactly how a system stops being one.
//
// A chip states a VIEW, so the one in force carries ink and the rest carry
// none. Filled colour on every chip was several controls competing before the
// professional had chosen anything.
import type { ReactNode } from "react";

/** The row a set of chips lives in: one scrolling line on a phone rather than
 *  two stacked ones, bleeding to its container's edge so a half-visible chip
 *  is itself the signal that there are more. `pad` matches the container's own
 *  horizontal padding so the bleed lands on the edge and not past it. */
export const CHIP_ROW =
  `flex items-center gap-2 overflow-x-auto [scrollbar-width:none]
   [&::-webkit-scrollbar]:hidden sm:flex-wrap sm:overflow-visible`;

export function FilterChip({
  active, onClick, children, label,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  /** For a chip whose visible text is not the whole story — a count beside a
   *  word, say — so a screen reader hears the control, not the arithmetic. */
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={`flex h-11 flex-none items-center whitespace-nowrap rounded-full px-3.5
                  text-meta font-medium transition-colors focus-visible:outline-none
                  focus-visible:ring-2 focus-visible:ring-mark/40
                  sm:h-auto sm:px-3 sm:py-1.5 ${
        active ? "bg-ink text-white" : "bg-ground-3 text-ink-2 hover:bg-line/70 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/** The quiet number that rides inside a chip. Tabular so a row of chips does
 *  not reflow as the counts change under it. */
export function ChipCount({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <span className={`ml-1.5 tabular-nums ${active ? "text-white/70" : "text-ink-3"}`}>
      {children}
    </span>
  );
}
