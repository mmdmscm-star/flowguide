// THE DIALOG SHELL, as classes rather than a component.
//
// Deliberately not a <Modal> wrapper. An earlier pass tried that for panels and
// the JSX restructuring it forced caused more breakage than the duplication it
// removed; the thing that actually drifts here is the LOOK, and constants fix
// that without moving a single tag.
//
// A dialog is the same working surface as the rest of the app, lifted: same
// white ground, same radius, a shadow instead of a heavier border, over a scrim
// dark enough to mean "the page behind is not available" and no darker.
export const MODAL_SCRIM =
  "fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-ink/25 backdrop-blur-[2px] p-4";

export const MODAL_PANEL =
  `w-full max-h-[85vh] overflow-y-auto rounded-[var(--radius-panel)]
   border border-line bg-ground shadow-[0_12px_40px_-12px_rgb(26_26_28_/_0.28)]`;

/** The dialog's own title. One size up from body, and the only thing at that
 *  size inside the dialog, so it reads as the dialog's subject rather than as
 *  the first of several equal-weight lines. */
export const MODAL_TITLE = "text-title font-semibold tracking-[-0.01em] text-ink";
export const MODAL_LEDE = "mt-1.5 text-meta text-ink-2";

/** Actions sit on a quiet band at the foot, divided from the content. A row of
 *  buttons floating under a form reads as more form. */
export const MODAL_FOOT =
  "mt-5 -mx-5 -mb-5 flex flex-wrap items-center gap-2 border-t border-line bg-ground-2 px-5 py-3.5";
