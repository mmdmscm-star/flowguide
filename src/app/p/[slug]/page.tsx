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
import { ownedPacketId } from "@/lib/packet-owner";
import { OwnerBar } from "@/components/nav/owner-bar";
import { recipientMetadata } from "@/lib/recipient-metadata";
import { treatmentFor, webVars } from "@/lib/style/treatment";

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
// a personal note. The metadata is a shared CONSTANT — see recipient-metadata.ts
// for why it takes no packet and why openGraph/twitter are declared there in
// full rather than partially. Setting title and description here without
// openGraph is what let the marketing card unfurl on a client's text message.
export const metadata: Metadata = recipientMetadata;

export default async function PacketPage({ params }: Props) {
  const { slug } = await params;
  const packet = await resolvePacket(slug);

  // A missing OR unpublished packet must return a real HTTP 404 — not a 200 with
  // a "not found" body. notFound() renders the not-found.tsx boundary with a 404
  // status. Because the page is force-dynamic, an unpublished packet 404s on the
  // very next request (getPublishedPacket filters status='published').
  if (!packet) notFound();

  // Is the person reading this its author? Costs a recipient nothing: with no
  // session cookie this returns null without a query. Everything below renders
  // identically either way — the only difference is one bar ABOVE the packet.
  const ownedId = isSupabaseConfigured && slug !== "demo" ? await ownedPacketId(slug) : null;

  // Track that this packet was opened (fire and forget).
  //
  // NOT WHEN THE OWNER OPENS IT. `viewed` means "the client has seen this", and
  // a professional checking their own link was silently setting it — which turns
  // a genuinely useful signal into one that cannot be trusted. Only possible to
  // fix now that the page knows who is looking; no backfill, since there is no
  // way to tell which past views were the owner's.
  if (slug !== "demo" && isSupabaseConfigured && !ownedId) {
    markPacketViewed(slug).catch(() => {});
  }

  return (
    <>
      {ownedId && <OwnerBar packetId={ownedId} />}
      {/* THE TREATMENT, ON THE ELEMENT THAT WRAPS THE SENDSET. Every packet
          component below reads ink, rule, hierarchy and rhythm through these
          rather than holding its own literal, so the same intent reaches the
          screen, the page and the inbox from one place. Scoped here rather than
          to :root so the creator's own surfaces are untouched by it. */}
      <main
        style={webVars(treatmentFor(packet)) as React.CSSProperties}
        className="sg-packet w-full max-w-lg mx-auto pb-12 overflow-x-hidden break-words"
      >
        <PacketHeader
          title={packet.clientTitle}
          clientName={packet.clientName}
          professional={packet.professional}
        />

        {packet.personalNote && <PersonalNote note={packet.personalNote} />}

        {/* Map button */}
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

        {/* Body renderer selected by composition mode. Legacy packets render the
            exact section/item path (unchanged); block packets render the ordered
            block body. Both present the same packet shell, header, and footer. */}
        {packet.compositionMode === "blocks" ? (
          <PacketBlockBody blocks={packet.blocks ?? []} />
        ) : (
          packet.sections.map((section) => (
            <SectionGroup key={section.id} section={section} showQuickNav={packet.showQuickNav !== false} />
          ))
        )}

        {packet.professional.name && (
          <ProfessionalFooter professional={packet.professional} />
        )}

        <p className="text-center text-xs mt-4" style={{ color: "var(--sg-faint)" }}>
          Powered by Sendset
        </p>
      </main>
    </>
  );
}
