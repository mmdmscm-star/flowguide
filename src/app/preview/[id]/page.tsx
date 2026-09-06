import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getPacketForEditor } from "@/lib/queries";
import { PacketHeader } from "@/components/packet-header";
import { PersonalNote } from "@/components/personal-note";
import { SectionGroup } from "@/components/section-group";
import { ProfessionalFooter } from "@/components/professional-footer";
import { PacketBlockBody } from "@/components/packet-block-body";
import { PreviewActions } from "@/components/preview-actions";
import { PreviewSurface } from "@/components/preview-surface";

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

  // THE SURFACE IS A CLIENT COMPONENT so a style click can re-publish the
  // treatment variables without a round trip. The Sendset below is still
  // server-rendered and passes through as children — nothing about the packet
  // crosses into the browser because of this.
  return (
    <PreviewSurface
      packetId={id}
      persisted={packet.styleTreatment}
      banner={
        <PreviewActions
          packetId={id}
          slug={packet.slug}
          initialStatus={packet.status}
          title={packet.clientTitle}
          clientName={packet.clientName}
          professionalName={packet.professional?.name}
        />
      }
    >
      <PacketHeader
        title={packet.clientTitle}
        clientName={packet.clientName}
        professional={packet.professional}
      />

      {packet.personalNote && <PersonalNote note={packet.personalNote} />}

      {packet.mapUrl && (
        <div className="mx-[var(--sg-page-gutter)] mb-8">
          <a
            href={packet.mapUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="sg-btn-primary flex items-center justify-center gap-2 w-full py-3 font-medium transition-colors"
            style={{ borderRadius: "var(--sg-card-radius)", fontSize: "var(--sg-body)", lineHeight: "var(--sg-body-lh)" }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
            </svg>
            View Map
          </a>
        </div>
      )}

      {/* THE SAME COMPOSITION THE RECIPIENT PAGE RENDERS. Preview mapped
          `sections` unconditionally, so a block-composed packet previewed as
          its sections — or as nothing — and the professional was approving
          something their client would never see. The branch is the recipient
          page's, verbatim.

          PROFESSIONAL SURFACE, still. The section path declares itself and
          shows the private note alongside the client highlight; every recipient
          surface leaves that prop off and gets the safe default. The block body
          has no such distinction to make. */}
      {packet.compositionMode === "blocks" ? (
        <PacketBlockBody blocks={packet.blocks ?? []} />
      ) : (
        packet.sections.map((section) => (
          <SectionGroup key={section.id} section={section} showQuickNav={packet.showQuickNav !== false} audience="professional" />
        ))
      )}

      {packet.professional.name && (
        <ProfessionalFooter professional={packet.professional} />
      )}

      <p className="text-center text-xs mt-4" style={{ color: "var(--sg-faint)" }}>
        Powered by Sendset
      </p>
    </PreviewSurface>
  );
}
