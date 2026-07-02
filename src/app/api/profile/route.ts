import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

// PATCH /api/profile — update professional profile (upsert)
export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { name, email, phone, businessName, logoUrl, websiteUrl, links } = body;

  const supabase = createServerClient();

  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email;
  if (phone !== undefined) updates.phone = phone;
  if (businessName !== undefined) updates.business_name = businessName;
  if (logoUrl !== undefined) updates.logo_url = logoUrl;
  if (websiteUrl !== undefined) updates.website_url = websiteUrl;
  if (Array.isArray(links)) {
    updates.links = links
      .filter((l) => l && typeof l === "object")
      .map((l) => ({ label: String(l.label ?? ""), url: String(l.url ?? "") }));
  }

  // Upsert — create if doesn't exist, update if it does
  const { error } = await supabase.from("professional_profiles").upsert(
    {
      user_id: session.userId,
      ...updates,
    },
    { onConflict: "user_id" }
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
