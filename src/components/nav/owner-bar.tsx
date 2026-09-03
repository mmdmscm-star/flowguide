import Link from "next/link";

// The one creator-side affordance on a recipient's page — shown ONLY to the
// signed-in professional who owns this published FlowGuide.
//
// WHY THIS IS NOT "ADMIN UI ON THE PUBLIC PAGE":
// it carries no packet controls, no editing, no publish state, no client
// information, and nothing that mutates anything. It is three links out of a
// page a professional arrived at by opening their own link, plus a sentence
// telling them what they are looking at. Every actual authoring action still
// lives behind /edit — the public page gained a way OUT, not a way IN.
//
// It renders above the packet and is visually separate from it, so a
// professional checking their own link is never confused about where their
// FlowGuide starts or what a client will see.
export function OwnerBar({ packetId }: { packetId: string }) {
  return (
    <div className="w-full border-b border-amber-200 bg-amber-50/80 print:hidden">
      <div className="mx-auto flex max-w-lg flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2">
        <span className="text-xs text-amber-900">
          This is your own Sendset. Your client does not see this bar.
        </span>
        <span className="ml-auto flex items-center gap-3 text-xs font-medium">
          <Link href={`/edit/${packetId}`} className="text-amber-900 underline underline-offset-2 hover:text-amber-950">
            Edit
          </Link>
          <Link href="/library" className="text-amber-900 underline underline-offset-2 hover:text-amber-950">
            Library
          </Link>
          <Link href="/dashboard" className="text-amber-900 underline underline-offset-2 hover:text-amber-950">
            My Packets
          </Link>
        </span>
      </div>
    </div>
  );
}
