import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { founderSession, sendInvitation } from "@/lib/invitation-server";

// POST /api/invites/approve — approve one request and send its invitation.
//
// Approval is idempotent in the database: pressed twice, the second call sees
// the same reserved invite and NO second invitation is sent. Sending again is a
// separate, deliberate action.
export async function POST(request: Request) {
  const db = createServerClient();
  const founder = await founderSession(db);
  if (!founder) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  if (!requestId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const { data, error } = await db.rpc("approve_early_access_request", { p_request_id: requestId });
  if (error) {
    const detail = (error as { details?: string | null }).details;
    if (detail === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    console.error("[invites] approve failed", { sqlstate: error.code, detail });
    return NextResponse.json({ error: "approve_failed" }, { status: 500 });
  }

  const result = data as { status: string; email: string; inviteId?: string };
  if (result.status === "has_account") {
    return NextResponse.json({ status: "has_account", message: "That address can already sign in — no invitation needed." });
  }
  if (result.status === "already_approved") {
    return NextResponse.json({ status: "already_approved", message: "Already approved. Use Send again to re-send the invitation." });
  }

  const sent = await sendInvitation(db, result.email);
  if (sent.sent) await db.rpc("record_invitation_sent", { p_request_id: requestId });
  return NextResponse.json({
    status: "approved",
    sent: sent.sent,
    message: sent.sent ? "Approved — invitation sent." : "Approved, but the invitation email did not go out. Use Send again.",
  });
}
