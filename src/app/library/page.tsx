import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import LibraryWorkspace from "@/components/library/library-workspace";

// The Library is professional-private: owner-scoped on every route, and never
// rendered to a recipient. It sits on the INPUT side of the packet, so nothing
// here is ever part of what a client sees.
export const dynamic = "force-dynamic";

export default async function LibraryPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  return <LibraryWorkspace />;
}
