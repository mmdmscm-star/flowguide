// THE ONE BUTTON.
//
// There were seventeen visual signatures across twenty-seven buttons, thirteen
// of them used exactly once, in eleven different padding pairs. Not because
// anyone was careless — because there was nowhere to put the decision, so each
// package made it again.
//
// PRIMARY IS INK, NOT BLUE. A saturated blue fill is the most recognisable
// "default dashboard" signal an interface can wear, and this product's primary
// actions are ordinary work — save, add, organize — not moments that want
// shouting. Blue is kept for MEANING: links, selection, focus. That makes the
// one blue thing on a screen worth looking at.
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

/** Secondary carries a ground rather than a border, which is the whole move:
 *  a filled-but-quiet surface separates from the page without adding another
 *  outline to a screen that already had too many. */
const VARIANT: Record<ButtonVariant, string> = {
  primary:   "bg-ink text-white hover:bg-ink/90 active:bg-ink",
  secondary: "bg-ground-3 text-ink hover:bg-line/70 active:bg-line",
  ghost:     "text-ink-2 hover:text-ink hover:bg-ground-3",
  /* FINDABLE, NOT DOMINANT. Red at rest made Delete the most visible thing on
   * every row of a list — six destructive actions shouting down the names of
   * the things they destroy. It carries the weight of its neighbours until the
   * pointer is on it, and then says exactly what it is. */
  danger:    "text-ink-2 hover:text-red-700 hover:bg-red-50 active:bg-red-100",
};

/* A FINGER IS NOT A CURSOR. `sm` was 32px tall and `md` 40 — fine under a
 * mouse, both under the ~44px a thumb actually needs, and `sm` is what every
 * row action in the app wears. The desktop proportions are unchanged; the
 * phone gets the height it needs, and the horizontal padding to match so the
 * target is not a wide thin strip. */
const SIZE: Record<ButtonSize, string> = {
  sm: "h-10 sm:h-8 px-3.5 sm:px-3 text-meta gap-1.5",
  md: "h-12 sm:h-10 px-4.5 sm:px-4 text-body gap-2",
};

/* SOME ACTIONS ARE NAVIGATION. "Print / Save as PDF" opens a route, so it has
 * to be an anchor — middle-click, open in a new tab, copy the address. It was
 * therefore the one control on the share step that could not use the component
 * and so wore its own hand-rolled treatment, which is exactly how seventeen
 * signatures happened the first time. The class list is the shared thing; the
 * element is the caller's. */
export function buttonClass(
  variant: ButtonVariant = "secondary", size: ButtonSize = "sm", className = "",
) {
  return `inline-flex flex-none items-center justify-center rounded-[var(--radius-control)]
          font-medium transition-colors
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mark/40
          disabled:pointer-events-none disabled:opacity-40
          ${VARIANT[variant]} ${SIZE[size]} ${className}`;
}

export function Button({
  variant = "secondary", size = "sm", className = "", children, ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className={buttonClass(variant, size, className)}>
      {children}
    </button>
  );
}
