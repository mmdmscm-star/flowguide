import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { publicDemo } from "@/lib/public-demos";
import { publicSendsetUrl } from "@/lib/public-url";
import { getPublishedPacket, publishedSenderIdentity } from "@/lib/queries";
import { PrintPacket } from "@/components/print/print-packet";
import PrintToolbar from "@/components/print/print-toolbar";
import type { Packet } from "@/lib/types";
import "./print.css";
import { recipientMetadata } from "@/lib/recipient-metadata";
import { treatmentFor, printVars } from "@/lib/style/treatment";

// /p/[slug]/print — the same published packet, rendered for paper.
//
// A RENDERER, not a second packet: it loads through `getPublishedPacket`, the
// same function the live page and the email version use. Nothing is generated,
// stored or cached, so paper can never disagree with the live FlowGuide, and
// private notes are already stripped before the data reaches this file.
//
// force-dynamic for the same reason the live page is: unpublishing must take
// effect on the next request, and a cached print page would keep serving a
// packet its owner had withdrawn.
//
// BOTH COMPOSITION MODES PRINT. This route used to 404 for block-composed
// packets, which meant converting a Sendset silently cost its printed copy and
// said the page did not exist. PrintPacket now branches on compositionMode the
// same way the recipient page does; a 404 here means the packet is missing or
// unpublished, and nothing else.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

const isSupabaseConfigured =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// The SAME builder the live recipient page uses, given the same sender. This
// URL is shareable and carries a client's name and a personal note, so it
// inherited the marketing OpenGraph card for exactly the same reason /p/[slug]
// did — and it must not drift from the live page's preview now that the
// preview says something.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const sender = isSupabaseConfigured && !publicDemo(slug)
    ? await publishedSenderIdentity(slug)
    : null;
  return recipientMetadata(sender, slug);
}

async function resolvePacket(slug: string): Promise<Packet | null> {
  const demo = publicDemo(slug);
  if (demo) return demo;
  return isSupabaseConfigured ? getPublishedPacket(slug) : null;
}

export default async function PrintPage({ params }: Props) {
  const { slug } = await params;
  const packet = await resolvePacket(slug);
  if (!packet) notFound();

  // Deliberately NOT marking the packet viewed. `viewed` means "the client has
  // seen this", and it is the professional who opens the print route.

  // The printed address has to be one a reader can TYPE, so it is absolute —
  // and canonical, because paper outlives whichever host it was printed from.

  // THE TREATMENT, AS THE VARIABLES print.css READS. The stylesheet is a static
  // file and cannot import; injecting the values here is what makes the
  // treatment layer — rather than the stylesheet — the place ink, rule and
  // hierarchy are decided. Page geometry, break rules and the screen-preview
  // ground stay in the stylesheet: they are how paper works, not how a Sendset
  // looks.
  // Paper wears the packet's own treatment — the same resolution the recipient
  // page and the email version use, from the same stored name.
  const treatment = treatmentFor(packet);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: printVars(treatment) }} />
      <PrintToolbar />
      <PrintPacket packet={packet} liveUrl={publicSendsetUrl(slug)} />
    </>
  );
}
