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
    <main className="mx-auto max-w-2xl px-5 py-8">
      <div className="mb-6">
        <CreatorNav current="settings" />
      </div>
      <ProfileSettings initial={initial} />
    </main>
  );
}
