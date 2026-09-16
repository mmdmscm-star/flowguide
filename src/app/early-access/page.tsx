import type { Metadata } from "next";
import { EarlyAccessForm } from "@/components/early-access-form";

export const metadata: Metadata = { title: "Request an invite · Sendset" };

// Public. No account, no session, no waitlist machinery — one form that lands
// in a table the owner reads.
export default function EarlyAccessPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-5 py-12">
      <div className="w-full max-w-md">
        <h1 className="mb-2 text-2xl font-bold text-foreground">Request an invite</h1>
        <p className="mb-8 text-base text-muted">
          Sendset is currently in early access. Tell us a little about how you&rsquo;d
          use it, and we&rsquo;ll review your request.
        </p>
        <EarlyAccessForm />
      </div>
    </main>
  );
}
