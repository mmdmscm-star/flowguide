import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getPacketForEditor } from "@/lib/queries";
import { PacketHeader } from "@/components/packet-header";
import { PersonalNote } from "@/components/personal-note";
import { SectionGroup } from "@/components/section-group";
import { ProfessionalFooter } from "@/components/professional-footer";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function PreviewPage({ params }: Props) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { id } = await params;
  const packet = await getPacketForEditor(id, session.userId);

  if (!packet) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-5 text-center">
        <div className="text-5xl mb-4">📄</div>
        <h1 className="text-xl font-bold text-foreground mb-2">
          Packet not found
        </h1>
        <p className="text-sm text-muted max-w-xs">
          This packet doesn&apos;t exist or you don&apos;t have access.
        </p>
      </div>
    );
  }

  return (
    <main className="max-w-lg mx-auto pb-12 overflow-x-hidden">
      {/* Preview banner */}
      <div className="bg-amber-50 border-b border-amber-200 px-5 py-3 text-center">
        <p className="text-sm text-amber-800 font-medium">
          Preview — this is how your client will see it
        </p>
        <a
          href={`/edit/${id}`}
          className="text-xs text-amber-600 hover:text-amber-800 underline"
        >
          ← Back to editor
        </a>
      </div>

      <PacketHeader
        title={packet.title}
        clientName={packet.clientName}
        professional={packet.professional}
      />

      {packet.personalNote && <PersonalNote note={packet.personalNote} />}

      {packet.mapUrl && (
        <div className="mx-5 mb-8">
          <a
            href={packet.mapUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
            </svg>
            View Map
          </a>
        </div>
      )}

      {packet.sections.map((section) => (
        <SectionGroup key={section.id} section={section} />
      ))}

      <ProfessionalFooter professional={packet.professional} />

      <p className="text-center text-xs text-muted/40 mt-4">
        Powered by FlowGuide
      </p>
    </main>
  );
}
