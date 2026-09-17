import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { loadOwnerResponses } from "@/lib/owner-responses";
import { CreatorNav } from "@/components/nav/creator-nav";
import { ResponseList } from "@/components/responses/response-list";

// /responses/[id] — what people sent the professional about one Sendset.
//
// PRIVATE. Owner only, read on the server; a Sendset that is not yours sends
// you back to your own list exactly as a missing one does. Nothing here is ever
// reachable from a recipient page.
//
// THE NAV CLAIMS NO TAB. CreatorNav renders the CURRENT tab as plain text
// rather than a link — correct on the Dashboard, where the link would go
// nowhere — so a page that says `current="packets"` without being My Sendsets
// leaves the only way back as the browser's own Back button. This is a page
// ABOUT one Sendset, like the editors and Preview, and like them it highlights
// nothing. The way back is stated below instead, as a real link.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export default async function ResponsesPage({ params }: Props) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { id } = await params;
  const loaded = await loadOwnerResponses(id, session.userId);
  if (!loaded) redirect("/dashboard");

  const title = loaded.packet.title.trim() || "Untitled Sendset";

  return (
    <div className="min-h-screen bg-canvas">
      <div className="sticky top-0 z-20 bg-canvas/85 backdrop-blur-sm border-b border-line">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-2 sm:py-3.5 flex items-center gap-2 sm:gap-3">
          <CreatorNav />
        </div>
      </div>
      <main className="mx-auto max-w-2xl px-4 sm:px-6 pt-8 pb-20">
        {/* A LINK, NOT history.back(): somebody can arrive here from a direct
            link, a bookmark or an email, and "back" would then be wherever they
            came from — or nowhere at all. */}
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-meta text-ink-2 underline-offset-4 hover:text-ink hover:underline"
        >
          <span aria-hidden>&larr;</span> Back to My Sendsets
        </Link>
        {/* The Sendset's own name is NOT a link. "Back to the list" and "open
            this Sendset" are two different intentions, and one line cannot mean
            both without the reader guessing which they are about to get. */}
        <p className="mt-2 text-meta text-ink-2">{title}</p>
        <h1 className="mt-0.5 mb-5 text-page font-semibold tracking-[-0.02em] text-ink">Responses</h1>
        <ResponseList responses={loaded.responses} responsesEnabled={loaded.packet.responsesEnabled} />
      </main>
    </div>
  );
}
