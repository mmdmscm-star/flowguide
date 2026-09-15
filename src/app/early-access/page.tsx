import type { Metadata } from "next";
import { EarlyAccessForm } from "@/components/early-access-form";

export const metadata: Metadata = { title: "Request early access · Sendset" };

// Public. No account, no session, no waitlist machinery — one form that lands
// in a table the owner reads.
export default function EarlyAccessPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-5 py-12">
      <div className="w-full max-w-md">
        <h1 className="mb-2 text-2xl font-bold text-foreground">Request early access</h1>
        <p className="mb-8 text-base text-muted">
          I&rsquo;m opening Sendset gradually while I work closely with the first users.
        </p>
        <EarlyAccessForm />
      </div>
    </main>
  );
}
