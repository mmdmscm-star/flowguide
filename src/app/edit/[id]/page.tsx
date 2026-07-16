import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getBlockEditorData } from "@/lib/block-editor";
import { LegacyPacketEditor } from "@/components/editor/legacy-packet-editor";
import { BlockPacketEditor } from "@/components/editor/block-packet-editor";

// Canonical authenticated packet editor. Branches EXPLICITLY on composition mode:
//   legacy packets  -> the existing editor, unchanged;
//   block packets   -> the flat ordered block editor (R2-A).
// A single owner-scoped query decides; the legacy editor still loads its own
// data exactly as before.
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default async function EditPacketPage({ params, searchParams }: Props) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { id } = await params;
  const sp = await searchParams;
  const data = await getBlockEditorData(id, session.userId);
  if (!data.found) redirect("/dashboard");

  if (data.mode === "blocks") {
    return (
      <BlockPacketEditor
        packetId={id}
        title={data.title}
        status={data.status}
        initialBlocks={data.blocks}
        justConverted={sp.converted === "1"}
      />
    );
  }

  // Legacy editor is a client component that reads the route param and loads its
  // own data; it uses useSearchParams, so it renders under a Suspense boundary.
  return (
    <Suspense fallback={<div className="p-8 text-center text-muted">Loading…</div>}>
      <LegacyPacketEditor />
    </Suspense>
  );
}
