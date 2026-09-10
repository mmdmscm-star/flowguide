import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { CreatorNav } from "@/components/nav/creator-nav";
import ProfileSettings from "@/components/settings/profile-settings";
import type { ProfileFields } from "@/components/editor/professional-profile-fields";

// /settings — the professional's own details, on a page of their own.
//
// They were always editable, but only from inside the legacy packet editor,
// which meant a block-editor user could not reach them at all and a new
// professional had to open a packet to discover they existed. Every renderer
// FlowGuide has — web, email, print — reads this profile.
//
// Read here on the server and handed down; saving stays on the existing
// PATCH /api/profile, so this page adds no API and no schema.
export const dynamic = "force-dynamic";

const EMPTY: ProfileFields = {
  name: "", email: "", phone: "", businessName: "",
  logoUrl: "", headshotUrl: "", footerLabel: "", websiteUrl: "", links: [],
};

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const supabase = createServerClient();
  const { data } = await supabase
    .from("professional_profiles")
    .select("name, email, phone, business_name, logo_url, headshot_url, footer_label, website_url, links")
    .eq("user_id", session.userId)
    .maybeSingle();

  // A professional who has never saved anything has no row at all — that is the
  // brand-new case, and it must render the empty form rather than an error.
  const row = data as Record<string, unknown> | null;
  const initial: ProfileFields = row
    ? {
        name: String(row.name ?? ""),
        email: String(row.email ?? ""),
        phone: String(row.phone ?? ""),
        businessName: String(row.business_name ?? ""),
        logoUrl: String(row.logo_url ?? ""),
        headshotUrl: String(row.headshot_url ?? ""),
        // The editor defaults a blank label to "Your Advisor"; this page shows
        // what is actually stored, so a deliberately empty label stays empty.
        footerLabel: String(row.footer_label ?? ""),
        websiteUrl: String(row.website_url ?? ""),
        links: Array.isArray(row.links)
          ? (row.links as { label?: string; url?: string }[]).map((l) => ({
              label: String(l?.label ?? ""), url: String(l?.url ?? ""),
            }))
          : [],
      }
    : EMPTY;

  return (
    /* The shell the rest of the app wears. This page had the nav in a plain div
       in the page body, so it scrolled away with the content and sat on white
       rather than on the canvas — the last creator surface not on the standard
       chrome. The bar matches this page's own column, so the first tab and the
       heading beneath it share a left edge. */
    <div className="min-h-screen bg-canvas">
      <div className="sticky top-0 z-20 bg-canvas/85 backdrop-blur-sm border-b border-line">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-2 sm:py-3.5 flex items-center gap-2 sm:gap-3">
          <CreatorNav current="settings" />
        </div>
      </div>
      <main className="mx-auto max-w-2xl px-4 sm:px-6 pt-8 pb-20">
        <ProfileSettings initial={initial} />
      </main>
    </div>
  );
}
