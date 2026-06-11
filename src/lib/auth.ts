import { cookies } from "next/headers";
import { createServerClient } from "./supabase";

const SESSION_COOKIE = "flowguide_session";
const SESSION_DURATION_DAYS = 30;

export async function getSession(): Promise<{ userId: string } | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const supabase = createServerClient();
  const { data: session } = await supabase
    .from("sessions")
    .select("user_id, expires_at")
    .eq("token", token)
    .single();

  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    // Expired — clean it up
    await supabase.from("sessions").delete().eq("token", token);
    return null;
  }

  return { userId: session.user_id };
}

export async function createSession(userId: string): Promise<string> {
  const supabase = createServerClient();
  const token = crypto.randomUUID();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_DURATION_DAYS);

  await supabase.from("sessions").insert({
    user_id: userId,
    token,
    expires_at: expiresAt.toISOString(),
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DURATION_DAYS * 24 * 60 * 60,
  });

  return token;
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (token) {
    const supabase = createServerClient();
    await supabase.from("sessions").delete().eq("token", token);
    cookieStore.delete(SESSION_COOKIE);
  }
}

export function requireAuth(session: { userId: string } | null): { userId: string } {
  if (!session) throw new Error("Unauthorized");
  return session;
}
