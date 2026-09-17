import { handleRespond } from "@/lib/respond-handler";

// POST /p/:slug/respond — the canonical place a recipient sends a message.
//
// Under the Sendset's own path, beside the item-action endpoint, so one
// path-scoped capability cookie covers this Sendset and nothing else. This
// endpoint does not read that cookie: a message is correspondence, and
// correspondence is not held by a capability.
type Context = { params: Promise<{ slug: string }> };

export async function POST(request: Request, context: Context) {
  const { slug } = await context.params;
  return handleRespond(request, slug);
}
