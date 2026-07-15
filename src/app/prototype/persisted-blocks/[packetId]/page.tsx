import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getPacketBlockPreview, type PreviewBlock } from "@/lib/block-preview";
import { ItemCard } from "@/components/item-card";

// R1B-A: hidden, authenticated, READ-ONLY persisted-block preview. It reads
// packet_blocks for a block-mode packet owned by the signed-in professional and
// renders it. No writes, no conversion, no editing, no public access. It does
// not touch the production editor, packet queries, recipient renderer, AI
// routes, or publish flow.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Persisted-block preview — FlowGuide",
  robots: { index: false, follow: false },
};

type Props = { params: Promise<{ packetId: string }> };

function renderBlock(b: PreviewBlock) {
  if (b.kind === "item") {
    return (
      <div key={b.id} className="px-5 mb-4">
        <ItemCard item={b.item} />
      </div>
    );
  }
  if (b.kind === "label") {
    return (
      <div key={b.id} className="px-5 mt-4 mb-2">
        {b.text && <p className="text-xs font-semibold uppercase tracking-widest text-accent">{b.text}</p>}
      </div>
    );
  }
  if (b.kind === "subheading") {
    return (
      <div key={b.id} className="px-5 mt-5 mb-2.5">
        {b.text && <h3 className="text-base font-semibold text-foreground">{b.text}</h3>}
        {b.subtext && <p className="mt-0.5 text-sm text-gray-500 leading-relaxed">{b.subtext}</p>}
      </div>
    );
  }
  return (
    <div key={b.id} className="px-5 mt-7 mb-4 first:mt-2">
      {b.text && <h2 className="text-xl font-bold text-foreground">{b.text}</h2>}
      {b.subtext && <p className="mt-1 text-base text-gray-600 leading-relaxed">{b.subtext}</p>}
    </div>
  );
}

export default async function PersistedBlockPreviewPage({ params }: Props) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { packetId } = await params;
  const preview = await getPacketBlockPreview(packetId, session.userId);

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-20 bg-amber-500 text-white text-center text-sm font-semibold px-4 py-2 shadow">
        Persisted-block preview — read only
      </div>

      <div className="max-w-lg mx-auto px-5 pb-24">
        {preview.status === "not_found" && (
          <div className="py-16 text-center">
            <div className="text-4xl mb-3">🔒</div>
            <h1 className="text-xl font-bold text-foreground mb-2">Packet not found</h1>
            <p className="text-sm text-muted max-w-xs mx-auto">
              No packet with that id exists for your account.
            </p>
          </div>
        )}

        {preview.status === "legacy" && (
          <div className="py-16 text-center">
            <div className="text-4xl mb-3">🧩</div>
            <h1 className="text-xl font-bold text-foreground mb-2">This packet has not been converted</h1>
            <p className="text-sm text-muted max-w-sm mx-auto">
              This preview only renders packets in block composition mode
              (<code>composition_mode = &apos;blocks&apos;</code>). This packet is still legacy, so there is
              nothing to show here.
            </p>
          </div>
        )}

        {preview.status === "blocks" && (
          <>
            <header className="pt-6 pb-4">
              <p className="text-xs uppercase tracking-widest text-muted mb-1">Persisted block composition</p>
              <h1 className="text-2xl font-bold text-foreground leading-tight whitespace-pre-line">
                {preview.title || "Untitled Packet"}
              </h1>
              <p className="mt-2 text-xs text-muted">
                {preview.blocks.length} block{preview.blocks.length === 1 ? "" : "s"} · read from packet_blocks by position
              </p>
            </header>
            <div className="py-2">
              {preview.blocks.length === 0 ? (
                <p className="text-center text-sm text-muted py-8">This block packet has no blocks.</p>
              ) : (
                preview.blocks.map((b) => renderBlock(b))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
