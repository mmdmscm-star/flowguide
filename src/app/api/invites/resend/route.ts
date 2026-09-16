import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { founderSession, sendInvitation } from "@/lib/invitation-server";

// POST /api/invites/resend — send the invitation again.
//
// A fresh 7-day link for the SAME reserved invite: nothing is reserved, spent
// or revoked here. Whichever link is used first creates the account.
export async function POST(request: Request) {
  const db = createServerClient();
  const founder = await founderSession(db);
  if (!founder) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  if (!requestId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const { data, error } = await db.from("early_access_requests")
    .select("email, approved_at").eq("id", requestId).maybeSingle();
  if (error) return NextResponse.json({ error: "resend_failed" }, { status: 500 });
  const row = data as { email: string; approved_at: string | null } | null;
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!row.approved_at) return NextResponse.json({ error: "not_approved", message: "Approve it first." }, { status: 409 });

  const sent = await sendInvitation(db, row.email);
  if (sent.sent) await db.rpc("record_invitation_sent", { p_request_id: requestId });
  return NextResponse.json({ status: "resent", sent: sent.sent, message: sent.sent ? "Invitation sent again." : "The invitation email did not go out." });
}
