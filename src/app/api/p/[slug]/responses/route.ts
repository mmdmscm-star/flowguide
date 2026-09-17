import { handleRespond } from "@/lib/respond-handler";

// POST /api/p/:slug/responses — THE COMPATIBILITY PATH, kept while bundles
// rendered before the endpoints moved are still open in somebody's browser.
//
// It is the SAME handler as POST /p/:slug/respond, not a copy: one
// implementation behind two paths cannot drift while the old one is retired.
// New code calls the canonical path only, and a test pins that.
//
// THE RETIREMENT SIGNAL is one fixed line with nothing in it — no slug, no
// capability, no name, no message, nothing about who sent it. It answers
// exactly one question, "is anybody still calling this?", and answers it
// without recording anything about them.
type Context = { params: Promise<{ slug: string }> };

export async function POST(request: Request, context: Context) {
  console.log("[responses] legacy endpoint used");
  const { slug } = await context.params;
  return handleRespond(request, slug);
}
