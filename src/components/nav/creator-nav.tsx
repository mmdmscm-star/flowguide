"use client";
import Link from "next/link";

// The three places a professional moves between while authoring: their packets,
// their Library, and starting a new FlowGuide.
//
// CREATOR-SIDE ONLY. This is never rendered on /p/[slug] — a recipient's page is
// the client's view of one FlowGuide, and putting authoring navigation on it
// would turn a shared link into a half-visible admin surface.
//
// Deliberately three plain links rather than a chrome bar with a logo, account
// menu and sections. The Library was reachable from the dashboard and nowhere
// else, which meant that from inside an editor — where saving to the Library
// actually happens — there was no way to go look at it.
const TABS = [
  { key: "packets", href: "/dashboard", label: "My Packets" },
  { key: "library", href: "/library", label: "Library" },
  { key: "new", href: "/new", label: "+ New" },
] as const;

export type CreatorNavTab = (typeof TABS)[number]["key"];

export function CreatorNav({ current }: { current?: CreatorNavTab }) {
  return (
    <nav aria-label="Your FlowGuide workspace" className="flex items-center gap-3 text-sm">
      {TABS.map((t, i) => (
        <span key={t.key} className="flex items-center gap-3">
          {i > 0 && <span aria-hidden className="text-gray-300">·</span>}
          {t.key === current ? (
            <span aria-current="page" className="font-medium text-foreground">{t.label}</span>
          ) : (
            <Link href={t.href} className="text-muted hover:text-foreground transition-colors">
              {t.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
