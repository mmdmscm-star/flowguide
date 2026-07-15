import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getPacketForEditor } from "@/lib/queries";
import { BlockPrototype } from "./block-prototype";

// Disposable Phase-0 prototype. READ-ONLY: it reuses the existing authenticated
// packet-reading path (getPacketForEditor, ownership-checked) and never calls a
// write API or persists anything. Not linked from anywhere; hidden by URL.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Block Prototype — FlowGuide",
  robots: { index: false, follow: false },
};

type Props = { params: Promise<{ packetId: string }> };

export default async function BlockPrototypePage({ params }: Props) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { packetId } = await params;
  const packet = await getPacketForEditor(packetId, session.userId);

  if (!packet) {
    return (
      <div className="max-w-lg mx-auto px-5 py-16 text-center">
        <div className="text-4xl mb-3">🧪</div>
        <h1 className="text-xl font-bold text-foreground mb-2">Prototype: packet not found</h1>
        <p className="text-sm text-muted">
          No packet with that id exists for your account. Open the editor for one of your
          packets and copy its id from the URL, then visit
          <code className="mx-1">/prototype/blocks/&lt;packetId&gt;</code>.
        </p>
      </div>
    );
  }

  return <BlockPrototype packetTitle={packet.title} sections={packet.sections} />;
}
