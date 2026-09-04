"use client";
import { type LibrarySnapshot, subtitleFor, heroPhoto } from "@/lib/library-adapter";

// ONE ROW, wherever a Library entry appears — the flat list, the structured
// view, and both pickers.
//
// Extracted so the two lists cannot drift. A row that looked slightly different
// depending on which surface you reached it through would teach the
// professional that they are two different things, and they are not.

/** Quiet location context: "Communities › Santa Rosa".
 *
 *  DELIBERATELY ABSENT WHEN THE HIERARCHY IS ON SCREEN. Under a heading that
 *  already says Communities › Santa Rosa, repeating it on every row proves the
 *  metadata exists and tells the reader nothing. In a search result or a
 *  Favorites view, where the structure is suspended, it is the one thing the
 *  row cannot otherwise say — so it appears exactly there. */
export function LocationLine({ location }: { location: string }) {
  return <span className="truncate text-[11px] text-muted/80">{location}</span>;
}

export interface LibraryRowProps {
  item: LibrarySnapshot;
  selectable: boolean;
  selected: boolean;
  onToggle?: (id: string) => void;
  onOpen?: (s: LibrarySnapshot) => void;
  star?: React.ReactNode;
  /** Shown only where the surrounding hierarchy does NOT already say it. */
  location?: string;
  /** Move up / Move down / Move…, when the stored sequence is what is on
   *  screen. Pickers never pass these: choosing is not filing. */
  controls?: React.ReactNode;
  /** The drag grip, when this row can be dragged. Rendered OUTSIDE the row's own
   *  button for the same reason `controls` is: a button inside a button is not
   *  valid markup, and the row's button is what opens the item. */
  handle?: React.ReactNode;
  innerRef?: (node: HTMLElement | null) => void;
  style?: React.CSSProperties;
  className?: string;
  /** Already added to the FlowGuide being composed. Kept visible and quietly
   *  stepped back rather than removed: a row that vanishes when you add it
   *  makes the Library look like it lost something. */
  muted?: boolean;
}

export function LibraryRow({
  item, selectable, selected, onToggle, onOpen, star, location, controls,
  handle, innerRef, style, className, muted,
}: LibraryRowProps) {
  return (
    <li ref={innerRef} style={style}
        className={`flex items-center gap-1 ${muted ? "opacity-55" : ""} ${className ?? ""}`}>
      {handle}
      {selectable ? (
        <label className={`${ROW_SHELL} ${selected ? ROW_SELECTED : ROW_PLAIN} cursor-pointer`}>
          <input type="checkbox" checked={selected}
                 onChange={() => onToggle?.(item.id)} className="flex-none" />
          <LibraryRowBody item={item} location={location} />
        </label>
      ) : (
        <button type="button" onClick={() => onOpen?.(item)} disabled={!onOpen}
                className={`${ROW_SHELL} ${selected ? ROW_SELECTED : ROW_PLAIN} ${
                  onOpen ? "cursor-pointer hover:border-accent" : ""}`}>
          <LibraryRowBody item={item} location={location} />
        </button>
      )}
      {/* Outside the row's own control on purpose: a label wrapping a checkbox
          would swallow the click and select the row, and a button inside a
          button is not valid markup. */}
      {star}
      {controls}
    </li>
  );
}

/** The row's shell, as classes rather than an element, so a drag preview can
 *  wear the same one without also inheriting the <li> a list item needs. */
export const ROW_SHELL = "flex w-full items-center gap-3 rounded-lg border p-3";
export const ROW_SELECTED = "border-accent bg-accent/5";
export const ROW_PLAIN = "border-border bg-white";

/** EVERYTHING INSIDE THE ROW: thumbnail, title, subtitle, location, labels.
 *
 *  Its own component because the drag preview shows the same thing. Copying
 *  this markup into the overlay is how a preview starts looking like something
 *  slightly other than the row it came from. */
export function LibraryRowBody({
  item, location,
}: { item: LibrarySnapshot; location?: string }) {
  const photo = heroPhoto(item);
  return (
    <>
      {photo
        /* eslint-disable-next-line @next/next/no-img-element */
        ? <img src={photo} alt="" className="h-10 w-10 flex-none rounded object-cover bg-gray-100" />
        : <div className="h-10 w-10 flex-none rounded bg-gray-100 flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="h-4 w-4 text-gray-300" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <circle cx="8.5" cy="9.5" r="1.5" />
              <path d="M21 16l-5-5-4 4-2-2-4 4" />
            </svg>
          </div>}
      <div className="min-w-0 flex-1 text-left">
        <p className="text-sm font-medium text-foreground truncate">{item.title || "Untitled"}</p>
        <p className="text-sm text-muted truncate">{subtitleFor(item)}</p>
        {(location || (item.labels ?? []).length > 0) && (
          <p className="mt-1 flex flex-wrap items-center gap-1 text-[11px] leading-none">
            {location && <LocationLine location={location} />}
            {/* Labels stay on the row in BOTH views. They cut across the
                structure, so position never implies them. */}
            {(item.labels ?? []).map((l) => (
              <span key={l} className="rounded-full bg-gray-100 px-1.5 py-0.5 text-muted">{l}</span>
            ))}
          </p>
        )}
      </div>
    </>
  );
}
