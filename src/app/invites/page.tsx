import { notFound } from "next/navigation";
import { createServerClient } from "@/lib/supabase";
import { founderSession } from "@/lib/invitation-server";
import { InviteRequestList, type RequestRow } from "@/components/invite-request-list";

export const dynamic = "force-dynamic";

// EARLY-ACCESS REQUESTS, AND ONE BUTTON EACH.
//
// Founder-only: anyone else — signed out, or signed in as somebody else — gets
// a 404, so the page does not advertise itself. Every action re-checks on the
// server; this page being reachable is never the authorisation.
export default async function InvitesPage() {
  const db = createServerClient();
  const founder = await founderSession(db);
  if (!founder) notFound();

  const { data } = await db
    .from("early_access_requests")
    .select("id, name, email, use_case, created_at, approved_at, invitation_sent_at")
    .order("created_at", { ascending: false });
  const rows = (data ?? []) as RequestRow[];
  const pending = rows.filter((r) => !r.approved_at);

  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <h1 className="text-2xl font-bold text-foreground">Early access requests</h1>
      <p className="mt-1 text-sm text-muted">
        {pending.length} waiting · {rows.length} in the last 90 days
      </p>
      <div className="mt-8">
        <InviteRequestList rows={rows} />
      </div>
    </main>
  );
}
