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
          <CreatorNav current="packets" />
        </div>
      </div>
      <main className="mx-auto max-w-2xl px-4 sm:px-6 pt-8 pb-20">
        <p className="text-meta text-ink-2">
          <Link href={`/edit/${loaded.packet.id}`} className="underline-offset-4 hover:underline">{title}</Link>
        </p>
        <h1 className="mt-1 mb-5 text-page font-semibold tracking-[-0.02em] text-ink">Responses</h1>
        <ResponseList responses={loaded.responses} responsesEnabled={loaded.packet.responsesEnabled} />
      </main>
    </div>
  );
}
