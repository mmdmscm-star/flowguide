import type { Metadata } from "next";
import { samplePacket } from "@/lib/sample-data";
import { getPublishedPacket, markPacketViewed } from "@/lib/queries";
import { PacketHeader } from "@/components/packet-header";
import { PersonalNote } from "@/components/personal-note";
import { SectionGroup } from "@/components/section-group";
import { ProfessionalFooter } from "@/components/professional-footer";
import type { Packet } from "@/lib/types";

type Props = {
  params: Promise<{ slug: string }>;
};

const isSupabaseConfigured =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

async function resolvePacket(slug: string): Promise<Packet | null> {
  // Demo packet always works, even without a database
  if (slug === "demo") return samplePacket;

  // If Supabase is configured, try the database
  if (isSupabaseConfigured) {
    return getPublishedPacket(slug);
  }

  return null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const packet = await resolvePacket(slug);

  if (!packet) {
    return { title: "Packet Not Found — FlowGuide" };
  }

  const description = packet.personalNote
    ? packet.personalNote.slice(0, 150) + "..."
    : `A packet prepared for you by ${packet.professional.name}`;

  // Titles may contain intentional line breaks; collapse them for metadata.
  const metaTitle = packet.title.replace(/\s*\n\s*/g, " ");

  return {
    title: `${metaTitle} — FlowGuide`,
    description,
    openGraph: {
      title: metaTitle,
      description,
      type: "website",
    },
  };
}

function NotFound() {
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

export default async function PacketPage({ params }: Props) {
  const { slug } = await params;
  const packet = await resolvePacket(slug);

  if (!packet) return <NotFound />;

  // Track that this packet was opened (fire and forget)
  if (slug !== "demo" && isSupabaseConfigured) {
    markPacketViewed(slug).catch(() => {});
  }

  return (
    <main className="w-full max-w-lg mx-auto pb-12 overflow-x-hidden break-words">
      <PacketHeader
        title={packet.title}
        clientName={packet.clientName}
        professional={packet.professional}
      />

      {packet.personalNote && <PersonalNote note={packet.personalNote} />}

      {/* Map button */}
      {packet.mapUrl && (
        <div className="mx-5 mb-8">
          <a
            href={packet.mapUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-accent hover:bg-accent-hover text-white text-base font-medium transition-colors"
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

      {packet.professional.name && (
        <ProfessionalFooter professional={packet.professional} />
      )}

      <p className="text-center text-xs text-muted/40 mt-4">
        Powered by FlowGuide
      </p>
    </main>
  );
}
