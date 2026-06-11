import { createClient } from "@supabase/supabase-js";

// Public client — uses anon key, respects RLS
// Used for recipient-facing reads (published packets)
export function createPublicClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// Server client — uses service role key, bypasses RLS
// Used for creator operations in API routes
export function createServerClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}
