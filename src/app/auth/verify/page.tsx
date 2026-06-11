import { redirect } from "next/navigation";

// This page exists as a fallback. The actual verification happens
// in the API route /api/auth/verify which redirects to /dashboard.
// If someone lands here without going through the API, send them to login.
export default function VerifyPage() {
  redirect("/login");
}
