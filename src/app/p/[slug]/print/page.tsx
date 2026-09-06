import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { samplePacket } from "@/lib/sample-data";
import { getPublishedPacket } from "@/lib/queries";
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
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

const isSupabaseConfigured =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// The SAME constant the live recipient page uses. This URL is shareable and
// carries a client's name and a personal note, so it inherited the marketing
// OpenGraph card for exactly the same reason /p/[slug] did.
export const metadata: Metadata = recipientMetadata;

async function resolvePacket(slug: string): Promise<Packet | null> {
  if (slug === "demo") return samplePacket;
  return isSupabaseConfigured ? getPublishedPacket(slug) : null;
}

export default async function PrintPage({ params }: Props) {
  const { slug } = await params;
  const packet = await resolvePacket(slug);
  if (!packet) notFound();

  // Block-composed packets render through a different component tree and are
  // not covered here. One prototype packet uses that mode; printing something
  // half-right would be worse than saying no.
  if (packet.compositionMode === "blocks") notFound();

  // Deliberately NOT marking the packet viewed. `viewed` means "the client has
  // seen this", and it is the professional who opens the print route.

  // The printed address has to be one a reader can TYPE, so it is absolute.
  // Taken from the request rather than an env var so the same code prints the
  // right host in production, in preview deployments and locally.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");

  // THE TREATMENT, AS THE VARIABLES print.css READS. The stylesheet is a static
  // file and cannot import; injecting the values here is what makes the
  // treatment layer — rather than the stylesheet — the place ink, rule and
  // hierarchy are decided. Page geometry, break rules and the screen-preview
  // ground stay in the stylesheet: they are how paper works, not how a Sendset
  // looks.
  const treatment = treatmentFor(packet);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: printVars(treatment) }} />
      <PrintToolbar />
      <PrintPacket packet={packet} liveUrl={host ? `${proto}://${host}/p/${slug}` : `/p/${slug}`} />
    </>
  );
}
