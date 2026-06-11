import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ user: null });

  const supabase = createServerClient();
  const { data: user } = await supabase
    .from("users")
    .select("id, email")
    .eq("id", session.userId)
    .single();

  return NextResponse.json({ user: user || null });
}
