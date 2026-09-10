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
  danger:    "text-red-700 hover:bg-red-50",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-meta gap-1.5",
  md: "h-10 px-4 text-body gap-2",
};

export function Button({
  variant = "secondary", size = "sm", className = "", children, ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`inline-flex flex-none items-center justify-center rounded-[var(--radius-control)]
                  font-medium transition-colors
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mark/40
                  disabled:pointer-events-none disabled:opacity-40
                  ${VARIANT[variant]} ${SIZE[size]} ${className}`}
    >
      {children}
    </button>
  );
}
