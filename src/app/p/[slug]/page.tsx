import type { Metadata } from "next";
import { samplePacket } from "@/lib/sample-data";
import { PacketHeader } from "@/components/packet-header";
import { PersonalNote } from "@/components/personal-note";
import { SectionGroup } from "@/components/section-group";
import { ProfessionalFooter } from "@/components/professional-footer";

type Props = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;

  if (slug !== samplePacket.slug) {
    return { title: "Packet Not Found — FlowGuide" };
  }

  const description = samplePacket.personalNote
    ? samplePacket.personalNote.slice(0, 150) + "..."
    : `A packet prepared for you by ${samplePacket.professional.name}`;

  return {
    title: `${samplePacket.title} — FlowGuide`,
    description,
    openGraph: {
      title: samplePacket.title,
      description,
      type: "website",
    },
  };
}

export default async function PacketPage({ params }: Props) {
  const { slug } = await params;

  if (slug !== samplePacket.slug) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-5 text-center">
        <div className="text-5xl mb-4">📄</div>
        <h1 className="text-xl font-bold text-foreground mb-2">
          Packet not found
        </h1>
        <p className="text-sm text-muted max-w-xs">
          This link doesn&apos;t match any packet. Check the URL and try again.
        </p>
        <p className="mt-8 text-xs text-muted/60">FlowGuide</p>
      </div>
    );
  }

  const packet = samplePacket;

  return (
    <main className="max-w-lg mx-auto pb-12">
      <PacketHeader
        title={packet.title}
        clientName={packet.clientName}
        professional={packet.professional}
      />

      {packet.personalNote && <PersonalNote note={packet.personalNote} />}

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
