import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";
import { notificationEmail, storeEarlyAccessRequest, THANKS, validateEarlyAccess } from "@/lib/early-access";

// POST /api/early-access — a request to be let in. Public by necessity.
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const outcome = await storeEarlyAccessRequest(createServerClient(), body);
  if (outcome.status !== 200) {
    return NextResponse.json({ error: outcome.error, message: outcome.message }, { status: outcome.status });
  }

  // BEST EFFORT, AND AFTER THE ROW. The request is already saved; a mail
  // failure must not turn a stored request into an error the person sees.
  if (outcome.stored) {
    const to = process.env.EARLY_ACCESS_NOTIFY_EMAIL;
    const key = process.env.RESEND_API_KEY;
    const valid = validateEarlyAccess(body);
    if (to && key && valid.ok) {
      try {
        const { subject, html } = notificationEmail(valid.value);
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: process.env.RESEND_FROM_EMAIL || "Sendset <onboarding@resend.dev>", to, subject, html }),
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) console.error("[early-access] notification not sent", { status: res.status });
      } catch (e) {
        // The status only. The request's own words stay out of the log.
        console.error("[early-access] notification failed", { error: (e as Error).name });
      }
    }
  }

  return NextResponse.json({ ok: true, message: THANKS });
}
