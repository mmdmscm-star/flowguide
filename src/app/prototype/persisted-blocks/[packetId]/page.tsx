import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getPacketBlockPreview } from "@/lib/block-preview";
import { PacketHeader } from "@/components/packet-header";
import { ProfessionalFooter } from "@/components/professional-footer";
import { PacketBlockBody } from "@/components/packet-block-body";

// R1B-A: hidden, authenticated, READ-ONLY persisted-block preview. It reads
// packet_blocks for a block-mode packet owned by the signed-in professional and
// renders it with the SAME block-body renderer the production recipient page
// uses. No writes, no conversion, no editing, no public access. It does not
// touch the production editor, packet queries, recipient renderer, AI routes,
// or publish flow.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Persisted-block preview — FlowGuide",
  robots: { index: false, follow: false },
};

type Props = { params: Promise<{ packetId: string }> };

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

      <div className="max-w-lg mx-auto pb-24">
        {preview.status === "not_found" && (
          <div className="py-16 text-center px-5">
            <div className="text-4xl mb-3">🔒</div>
            <h1 className="text-xl font-bold text-foreground mb-2">Packet not found</h1>
            <p className="text-sm text-muted max-w-xs mx-auto">
              No packet with that id exists for your account.
            </p>
          </div>
        )}

        {preview.status === "legacy" && (
          <div className="py-16 text-center px-5">
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
            {/* Packet-level header (branding/logo) — reused from the recipient
                renderer. Identity comes from the packet's identity selections,
                not from packet_blocks. */}
            <PacketHeader
              title={preview.title || "Untitled Packet"}
              clientName={preview.clientName}
              professional={preview.professional}
            />
            <p className="px-5 -mt-3 mb-2 text-xs text-muted">
              {preview.blocks.length} block{preview.blocks.length === 1 ? "" : "s"} · body read from packet_blocks by position
            </p>
            <div className="py-2">
              {preview.blocks.length === 0 ? (
                <p className="text-center text-sm text-muted py-8">This block packet has no blocks.</p>
              ) : (
                <PacketBlockBody blocks={preview.blocks} />
              )}
            </div>
            {/* Packet-level footer (advisor signature) — reused from the
                recipient renderer, gated the same way. */}
            {preview.professional.name && (
              <ProfessionalFooter professional={preview.professional} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
