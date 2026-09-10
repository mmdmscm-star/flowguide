"use client";
import Link from "next/link";
import type { ReactNode } from "react";

// The places a professional moves between while authoring: their packets,
// their Library, starting a new FlowGuide — and their own details, which used
// to be reachable only by opening a packet in the legacy editor and scrolling
// to the bottom.
//
// CREATOR-SIDE ONLY. This is never rendered on /p/[slug] — a recipient's page is
// the client's view of one FlowGuide, and putting authoring navigation on it
// would turn a shared link into a half-visible admin surface.
//
// Deliberately plain links rather than a chrome bar with a logo, account menu
// and sections. The Library was reachable from the dashboard and nowhere
// else, which meant that from inside an editor — where saving to the Library
// actually happens — there was no way to go look at it.
const TABS = [
  { key: "packets", href: "/dashboard", label: "My Sendsets" },
  { key: "library", href: "/library", label: "Library" },
  { key: "new", href: "/new", label: "New Sendset" },
  { key: "settings", href: "/settings", label: "Your details" },
] as const;

export type CreatorNavTab = (typeof TABS)[number]["key"];

// ON A PHONE THIS IS FOUR DESTINATIONS, NOT A LINE OF TEXT.
//
// At a readable size the four labels plus their separators come to roughly
// 360px before the bar's own padding, so on a 390px screen they wrapped to two
// rows of 14px links — a sticky header eating twice the height while being
// harder to hit and harder to read. Neither shrinking them nor stacking them is
// the answer.
//
// So below `sm` it becomes one scrolling row of real targets: no separators
// (they cost width and say nothing a gap does not), each item at least 44px
// tall, and the row bleeding to the edges of its container so a half-visible
// fourth label is itself the signal that there is more to the right. Above
// `sm` it is exactly the quiet line of links it always was.
//
// CAPABILITY IS UNCHANGED at every width: the same four places, in the same
// order, with the same names.
export function CreatorNav({
  current, trailing, pinned,
}: {
  current?: CreatorNavTab;
  /** An action belonging to the bar rather than to the tabs — Sign out, on the
   *  Dashboard. It rides INSIDE the scrolling row on a phone. Left outside it,
   *  the row simply clipped its last tab at the scroller's edge and this began
   *  immediately after, so "New Sendset" read as "New SendsSign out"; pushed to
   *  the far right on a wider screen, where there is room for both. */
  trailing?: ReactNode;
  /** Same slot, PINNED rather than scrolling: for something that has to stay
   *  visible. The editors put save status here — a signal you have to scroll a
   *  navigation bar sideways to find is not a signal. The nav's own edge fade
   *  is what keeps this from looking like a tab cut in half. */
  pinned?: ReactNode;
}) {
  return (
    <>
    <nav
      aria-label="Your Sendset workspace"
      /* The fade is not decoration. Without it the scroll container simply
         cuts a label off at its edge, and the next thing in the bar — Sign out
         on the Dashboard — begins immediately after, so "New Sendset" read as
         "New SendsSign out". A label that fades has obviously been scrolled;
         one that stops dead looks like a rendering fault. */
      className="-mx-4 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-4
                 [mask-image:linear-gradient(to_right,transparent_0,black_16px,black_calc(100%-40px),transparent_100%)]
                 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden
                 sm:mx-0 sm:gap-3 sm:overflow-visible sm:px-0 sm:[mask-image:none]"
    >
      {TABS.map((t, i) => (
        <span key={t.key} className="flex flex-none items-center gap-1 sm:gap-3">
          {i > 0 && <span aria-hidden className="hidden text-line-3 sm:inline">·</span>}
          {t.key === current ? (
            <span
              aria-current="page"
              className="flex h-11 items-center whitespace-nowrap rounded-[var(--radius-control)]
                         bg-ground-3 px-3 text-body font-medium text-ink
                         sm:h-auto sm:bg-transparent sm:px-0 sm:text-meta"
            >
              {t.label}
            </span>
          ) : (
            <Link
              href={t.href}
              className="flex h-11 items-center whitespace-nowrap rounded-[var(--radius-control)]
                         px-3 text-body text-ink-2 transition-colors hover:bg-ground-3 hover:text-ink
                         sm:h-auto sm:px-0 sm:text-meta sm:hover:bg-transparent"
            >
              {t.label}
            </Link>
          )}
        </span>
      ))}
      {trailing && <span className="flex flex-none items-center sm:ml-auto">{trailing}</span>}
    </nav>
    {/* The gap is doing real work: the nav clips its last tab at the scroller's
        edge, and without space after it this reads as one broken word. */}
    {pinned && <span className="flex flex-none items-center pl-1 sm:pl-0">{pinned}</span>}
    </>
  );
}
