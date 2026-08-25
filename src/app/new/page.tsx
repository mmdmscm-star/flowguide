import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import NewPacketWorkspace from "@/components/new/new-packet-workspace";

// GATE BEFORE DATA ENTRY, not after it.
//
// This page used to render for anyone. A signed-out visitor could paste real
// client notes into the box, press Organize, and have the API answer 401 —
// at which point the client component pushed them to /login and their work was
// gone. No return path, no preserved text. An invitation that throws away what
// it invited.
//
// Preserving the draft through sign-in was considered and rejected as the wrong
// shape for THIS auth: it is a magic link, so the realistic flow is request →
// open email → often on a different device → click. A draft held in the
// original tab's storage is orphaned the moment the link is opened elsewhere,
// and carrying it through the token would mean redesigning the token.
//
// So the box never appears until there is a session to save it to. The same
// server-shell pattern /dashboard and /library already use.
export const dynamic = "force-dynamic";

export default async function NewPacketPage() {
  const session = await getSession();
  if (!session) redirect("/login?next=new");
  return <NewPacketWorkspace />;
}
