import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { samplePacket } from "@/lib/sample-data";
import { getPublishedPacket, markPacketViewed } from "@/lib/queries";
import { PacketHeader } from "@/components/packet-header";
import { PersonalNote } from "@/components/personal-note";
import { SectionGroup } from "@/components/section-group";
import { PacketBlockBody } from "@/components/packet-block-body";
import { ProfessionalFooter } from "@/components/professional-footer";
import type { Packet } from "@/lib/types";

// Render on every request — never serve a cached copy. This is what makes
// unpublish/delete take effect immediately: there is no stored HTML that could
// keep showing an unpublished packet after status flips to draft.
export const dynamic = "force-dynamic";

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

// Recipient packet pages are private-by-link and may contain a client's name and
// a personal note. Metadata is therefore ENTIRELY generic — no packet or client
// content ever reaches page titles, descriptions, or OpenGraph tags (which are
// exactly what search crawlers and link-unfurl bots ingest). `robots: noindex`
// tells any crawler that does reach the URL not to index it. This is a static
// export (not a per-packet generateMetadata) so it can never leak content and
// avoids a duplicate packet fetch on every render.
export const metadata: Metadata = {
  title: "FlowGuide",
  description: "A packet prepared for you.",
  robots: { index: false, follow: false },
};

export default async function PacketPage({ params }: Props) {
  const { slug } = await params;
  const packet = await resolvePacket(slug);

  // A missing OR unpublished packet must return a real HTTP 404 — not a 200 with
  // a "not found" body. notFound() renders the not-found.tsx boundary with a 404
  // status. Because the page is force-dynamic, an unpublished packet 404s on the
  // very next request (getPublishedPacket filters status='published').
  if (!packet) notFound();

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

      {/* Body renderer selected by composition mode. Legacy packets render the
          exact section/item path (unchanged); block packets render the ordered
          block body. Both present the same packet shell, header, and footer. */}
      {packet.compositionMode === "blocks" ? (
        <PacketBlockBody blocks={packet.blocks ?? []} />
      ) : (
        packet.sections.map((section) => (
          <SectionGroup key={section.id} section={section} />
        ))
      )}

      {packet.professional.name && (
        <ProfessionalFooter professional={packet.professional} />
      )}

      <p className="text-center text-xs text-muted/40 mt-4">
        Powered by FlowGuide
      </p>
    </main>
  );
}
