import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export async function POST(request: Request) {
  const body = await request.json();
  const { email } = body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Please enter a valid email address" }, { status: 400 });
  }

  const supabase = createServerClient();
  const normalizedEmail = email.toLowerCase().trim();

  // Rate limit: max 5 requests per email per hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("magic_links")
    .select("id", { count: "exact", head: true })
    .eq("email", normalizedEmail)
    .gte("created_at", oneHourAgo);

  if ((count || 0) >= 5) {
    return NextResponse.json(
      { error: "Too many requests. Please try again in a few minutes." },
      { status: 429 }
    );
  }

  // Generate token
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  await supabase.from("magic_links").insert({
    email: normalizedEmail,
    token,
    expires_at: expiresAt.toISOString(),
  });

  // Build the magic link URL
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const magicLinkUrl = `${appUrl}/api/auth/verify?token=${token}`;

  // Send email via Resend
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || "FlowGuide <onboarding@resend.dev>",
        to: normalizedEmail,
        subject: "Sign in to FlowGuide",
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 400px; margin: 0 auto; padding: 40px 20px;">
            <h1 style="font-size: 24px; font-weight: 700; margin-bottom: 8px;">FlowGuide</h1>
            <p style="color: #6b7280; margin-bottom: 24px;">Sign in to your account</p>
            <a href="${magicLinkUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 500;">
              Sign In
            </a>
            <p style="color: #9ca3af; font-size: 14px; margin-top: 24px;">
              This link expires in 15 minutes. If you didn't request this, you can ignore this email.
            </p>
          </div>
        `,
      }),
    });

    if (!res.ok) {
      console.error("Failed to send email:", await res.text());
      // Don't expose email delivery failure to user — they can retry
    }
  } else {
    // Dev mode: log the link
    console.log(`\n🔗 Magic link for ${normalizedEmail}:\n${magicLinkUrl}\n`);
  }

  return NextResponse.json({ ok: true });
}
