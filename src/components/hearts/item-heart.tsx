"use client";

import { useHearts } from "./hearts-provider";

/** ONE HEART, on one item.
 *
 *  RENDERS NOTHING WITHOUT A PROVIDER. Preview, print and email never mount
 *  HeartsProvider, so this is absent there rather than hidden — a surface
 *  cannot accidentally gain hearts by rendering an item card.
 *
 *  IT SAYS ONLY WHAT THIS BROWSER DID. There is no count beside it and no sign
 *  of anybody else: on a Sendset shared with a family, one person's hearts are
 *  not the others' business. */
export function ItemHeart({ itemId, title }: { itemId: string; title?: string }) {
  const hearts = useHearts();
  if (!hearts) return null;

  const on = hearts.isHearted(itemId);
  const busy = hearts.isPending(itemId);
  const named = String(title ?? "").trim();

  return (
    <button
      type="button"
      onClick={() => hearts.toggle(itemId)}
      disabled={busy || !hearts.ready}
      aria-pressed={on}
      // The item's own name, so a screen reader hears which heart this is
      // rather than forty identical buttons.
      aria-label={named ? (on ? `Remove your heart from ${named}` : `Heart ${named}`) : (on ? "Remove your heart" : "Heart this")}
      className="-m-2 shrink-0 rounded-full p-2 transition-opacity disabled:opacity-50
                 focus-visible:outline-2 focus-visible:outline-offset-2"
      style={{ color: on ? "var(--sg-accent)" : "var(--sg-muted)", lineHeight: 0 }}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-5 w-5"
        aria-hidden="true"
        fill={on ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={on ? 0 : 1.75}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 20.25c-.3 0-.6-.11-.83-.31C7.13 16.4 4.5 14.04 4.5 10.9 4.5 8.4 6.4 6.5 8.8 6.5c1.3 0 2.55.6 3.2 1.56.65-.96 1.9-1.56 3.2-1.56 2.4 0 4.3 1.9 4.3 4.4 0 3.14-2.63 5.5-6.67 9.04-.23.2-.53.31-.83.31Z"
        />
      </svg>
    </button>
  );
}
