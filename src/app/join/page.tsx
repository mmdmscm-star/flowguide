import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SIGNUP_COOKIE } from "@/lib/auth";
import { JoinForm } from "@/components/join-form";

// Where a VERIFIED email with no account lands. The cookie is the proof that
// this person just opened their own sign-in link; without it there is nothing
// to join with, so this page sends them back to ask for a new one.
export default async function JoinPage() {
  const pending = (await cookies()).get(SIGNUP_COOKIE)?.value;
  if (!pending) redirect("/login?error=signup-expired");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-5">
      <div className="w-full max-w-sm">
        <h1 className="mb-2 text-center text-2xl font-bold text-foreground">Sendset</h1>
        <p className="mb-8 text-center text-base text-muted">
          Sendset is currently in early access. Enter your invite code to continue.
        </p>
        <JoinForm />
      </div>
    </main>
  );
}
