// THE CLIENT MESSAGE — a wrapper around the live FlowGuide, nothing more.
//
// It carries the professional's own framing and the link. It deliberately does
// NOT describe what is inside the packet: a sentence like "12 communities with
// photos and pricing" is a second, generated account of the content that goes
// stale the moment an item is added or removed, and it competes with the link
// instead of driving to it. The FlowGuide is the source of truth; this is an
// envelope.
//
// Deterministic, for reasons the ingestion work made concrete: a four-sentence
// message is the first thing a client reads, and a model that varies run to run
// has no contract behind it here. The same input always produces the same text.

export interface ClientMessageInput {
  /** packets.client_name — absent on 85% of real packets, so the no-name path
   *  is the common case rather than an edge case. */
  clientName?: string | null;
  title?: string | null;
  /** The live share URL. Always present: this is only offered after publish. */
  url: string;
  /** The professional's own name, from the packet's profile snapshot. */
  professionalName?: string | null;
}

const clean = (v: unknown) => String(v ?? "").trim();

/** Every value is optional except the link, and each missing one removes its
 *  own line rather than leaving a gap or a placeholder. */
export function buildClientMessage(input: ClientMessageInput): string {
  const client = clean(input.clientName);
  const title = clean(input.title);
  const pro = clean(input.professionalName);
  const url = clean(input.url);

  const lines: string[] = [];
  if (client) lines.push(`Hi ${client},`, "");

  lines.push(
    title
      ? `I've put together ${title} for you so everything is easy to review in one place.`
      : `I've put this together for you so everything is easy to review in one place.`,
    "",
    "You can view it here:",
    url,
    "",
    "Any questions, just reply.",
  );

  if (pro) lines.push("", pro);
  return lines.join("\n");
}
