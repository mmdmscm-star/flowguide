import Link from "next/link";
import type { Metadata } from "next";
import { createServerClient } from "@/lib/supabase";
import { INVITATION_FALLBACK, INVITATION_LINE } from "@/lib/invitation";
import { AcceptInvitation } from "@/components/accept-invitation";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "You're invited · Sendset", robots: { index: false, follow: false } };

// THE INVITATION LANDING PAGE — AND IT ONLY READS.
//
// The emailed link is a GET, and GETs are fetched by things that are not the
// person: mail scanners, link checkers, prefetchers. So opening this page
// creates no account, spends no magic link and consumes no invitation. It looks
// the token up to decide what to show; the button below POSTs, and THAT is what
// accepts. The route sends Referrer-Policy: no-referrer (next.config.ts) so the
// token in this URL never travels to another site.
export default async function InvitedPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  let state: "ready" | "expired" | "unknown" = "unknown";

  if (token) {
    const { data } = await createServerClient()
      .from("magic_links")
      .select("used, expires_at")
      .eq("token", token)
      .maybeSingle();
    const link = data as { used: boolean; expires_at: string } | null;
    if (link) state = !link.used && new Date(link.expires_at) > new Date() ? "ready" : "expired";
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-5">
      <div className="w-full max-w-sm">
        <h1 className="mb-2 text-center text-2xl font-bold text-foreground">Sendset</h1>
        {state === "ready" ? (
          <>
            <p className="mb-8 text-center text-base text-muted">{INVITATION_LINE}</p>
            <AcceptInvitation token={token!} />
          </>
        ) : (
          <>
            <p className="mb-6 text-center text-base text-muted">
              {state === "expired"
                ? "This invitation link has already been used or has expired."
                : "This invitation link isn't valid."}
            </p>
            <p className="text-center text-sm text-muted">{INVITATION_FALLBACK}</p>
            <p className="mt-6 text-center text-sm">
              <Link href="/login" className="font-medium text-accent underline-offset-4 hover:underline">
                Go to sign in
              </Link>
            </p>
          </>
        )}
      </div>
    </main>
  );
}
