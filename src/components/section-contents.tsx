import { Item } from "@/lib/types";

// NAVIGATION OVER THE FLOWGUIDE, not a second way of presenting it.
//
// Measured on a phone: one item card is 759-809px against an 812px viewport, so
// a client reads exactly one option per screen and can never see two at once. A
// twenty-community FlowGuide is twenty screens, and the job - "which of these
// fits?" - needs the reader to hold the previous option in their head.
//
// This shows the SET. It lists what is there, in packet order, and jumps to it.
// It deliberately does NOT summarise an item or choose a "key detail": the
// moment it says something ABOUT an option it becomes a second, competing
// account of the packet that can disagree with the card.
//
// Real anchors, not scroll handlers: the back button works, links open in a new
// tab if someone wants that, and keyboard and screen-reader navigation come for
// free.
export function SectionContents({
  items,
  sectionTitle,
}: {
  items: Item[];
  sectionTitle?: string | null;
}) {
  // One item needs no contents page.
  if (items.length < 2) return null;

  return (
    <nav
      aria-label={sectionTitle ? `Contents of ${sectionTitle}` : "Contents"}
      className="px-5 mb-4"
    >
      <ol className="border-y border-border divide-y divide-border">
        {items.map((item, i) => (
          <li key={item.id}>
            <a
              href={`#item-${item.id}`}
              // One line per row, so a twenty-item list stays predictable
              // instead of growing with the length of a title. Kept at the
              // recipient's reading size rather than shrunk to fit - these are
              // often older readers, and a list they cannot read is not a
              // shortcut.
              // ROW HEIGHT IS THE WHOLE DESIGN HERE, and it was wrong first
              // time: py-2.5 with default leading gave 45px rows, so twenty
              // items came to ~900px - taller than the phone viewport it exists
              // to save. Tightened to ~39px so even a twenty-item index fits in
              // one screen, which is the point of showing the set.
              //
              // Not tighter than that: this is a tap target on a phone, often
              // for an older reader, and shrinking it further to win pixels
              // would trade one usability problem for another.
              className="flex items-baseline gap-3 py-2 leading-snug text-base text-foreground
                         hover:text-accent focus:outline-none focus:ring-2 focus:ring-accent rounded-sm"
            >
              <span aria-hidden className="w-5 shrink-0 text-sm text-muted tabular-nums">
                {i + 1}
              </span>
              <span className="truncate">{item.title}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
