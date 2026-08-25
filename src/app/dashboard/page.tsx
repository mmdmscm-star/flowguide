import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import DashboardWorkspace from "@/components/dashboard/dashboard-workspace";
import Link from "next/link";
import { identityGap, IDENTITY_GAP_PROMPT } from "@/lib/professional-identity";

// A thin server shell over the existing dashboard, matching how /library is
// already built. Its only job is to answer one question on the server —
// "is this professional's identity ready to publish?" — so the first-run prompt
// needs no new API and no client fetch.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const supabase = createServerClient();
  const { data } = await supabase
    .from("professional_profiles")
    .select("name, email, phone")
    .eq("user_id", session.userId)
    .maybeSingle();

  // No row at all is the brand-new professional: identityGap treats an absent
  // NAME as the first gap, which is exactly what they are missing.
  const row = (data ?? {}) as { name?: string; email?: string; phone?: string };

  const gap = identityGap(row);

  return (
    <>
      {/* ONE LINE, ONCE, AND ONLY WHILE IT IS TRUE.
          The condition is the PUBLISH rule, not a separate "has a name" guess,
          so this can never tell a professional they are set up while publish
          refuses them — nor nag someone publish would accept. It disappears the
          moment the gap closes: no second reminder, nothing to dismiss.

          Rendered HERE rather than inside the workspace because the workspace
          waits on a client fetch before it draws anything. A first-run prompt
          that appears after a spinner is a first-run prompt the new
          professional has already scrolled past. */}
      {gap && (
        <div className="max-w-2xl mx-auto px-5 pt-8">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm text-amber-900">
              {IDENTITY_GAP_PROMPT[gap]}{" "}
              <Link href="/settings" className="font-medium underline underline-offset-2 hover:text-amber-950">
                Add your details
              </Link>
            </p>
          </div>
        </div>
      )}
      <DashboardWorkspace />
    </>
  );
}
