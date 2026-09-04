// READING A PICTURE, AND NOTHING MORE.
//
// This is deliberately its OWN module and its own model call. The structuring
// path takes `rawText: string` and turns source material into proposed Sendset
// content; widening it to sometimes accept pixels is how a text contract
// quietly becomes an image contract, and how the guards downstream would start
// receiving material nobody had read.
//
// So the split is total. This function has ONE job — say what is visibly on the
// page — and its output is not content. It is a draft of the SOURCE, which the
// professional then reads and corrects, and only the corrected text becomes
// `source_text`. Everything after that point is the pipeline that already
// exists: segmentation, deterministic claims, the model proposal, reconcile,
// review. There is no image anywhere in it.
//
// WHY THAT MATTERS FOR PRICES. The price gate proves that every figure shown to
// a client appears in the source. If a model both transcribed the picture and
// then structured from its own transcription, that check would verify the
// model against itself and a misread $5,200 would be "source-supported". The
// mandatory human correction step is what keeps a person, not a model, as the
// owner of what the document said.

/** The transcription prompt. Every line here is a rule the review step depends
 *  on: a summary cannot be corrected against the picture, and a reorganised
 *  table cannot be checked for a price that was never in it. */
export const TRANSCRIPTION_PROMPT = [
  "You transcribe images of documents. You do not interpret them.",
  "",
  "Write out the text that is visibly present in the image, and nothing else.",
  "",
  "RULES:",
  "- Preserve the reading order, the line breaks, and the row/column structure.",
  "  For a table, keep one row per line and separate cells with a tab.",
  "- Copy numbers, currency symbols, phone numbers, emails, dates, labels and",
  "  headings EXACTLY as written, including formatting like $5,595-$6,250.",
  "- Do NOT summarise, shorten, or describe the image.",
  "- Do NOT reorganise the content or add headings the image does not have.",
  "- Do NOT infer, complete or calculate a value that is not shown.",
  "- Do NOT normalise or convert prices, units, or phone formats.",
  "- Do NOT attribute a fact to a name or heading unless the image itself places",
  "  them together.",
  "- If something is unreadable, illegible or cut off, write [unclear] in its",
  "  place rather than guessing what it probably says.",
  "",
  "Return only the transcription. No preamble, no commentary, no code fences.",
].join("\n");

/** What went wrong, kept in two buckets on purpose.
 *
 *  `ours` is a rule this application enforced — a type we refuse, an empty
 *  file. `provider` is the model service declining, which includes limits we
 *  have NOT measured. Collapsing the two would let an unverified guess about
 *  somebody else's ceiling be reported as our own rule. */
export type TranscriptionResult =
  | { ok: true; text: string }
  | { ok: false; source: "ours" | "provider"; status: number; error: string; message: string };

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Transcribe one image.
 *
 * TRANSPORT IS A DATA URL, carrying the bytes inside our own request. The
 * alternative — handing the provider the object's public storage URL — would
 * have a third party fetch it, which is outside the zero-retention envelope
 * this call is routed through and hands the object's address to a fetcher we
 * do not control.
 *
 * NO SIZE CEILING IS ASSERTED HERE. The provider's per-image limit has not been
 * measured, and inventing one would fail in both directions: too low silently
 * refuses work that would have succeeded, too high turns a provider rejection
 * into an unexplained error. A refusal is reported as the PROVIDER's, with its
 * own status, so the message can say so.
 */
export async function callTranscriptionModel(opts: {
  bytes: Buffer;
  mime: string;
  apiKey: string;
  model: string;
  maxOutputTokens: number;
}): Promise<TranscriptionResult> {
  const { bytes, mime, apiKey, model, maxOutputTokens } = opts;
  const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;

  let res: Response;
  try {
    res = await fetch(OPENROUTER, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: TRANSCRIPTION_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "Transcribe this image." },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        // Lower than structuring: transcription is a reading task, and
        // creativity here is called a hallucinated price.
        temperature: 0,
        max_tokens: maxOutputTokens,
        // THE SAME PRIVACY ROUTING AS EVERY OTHER CALL. An image is more
        // sensitive than a paste, not less.
        provider: { data_collection: "deny", zdr: true },
      }),
    });
  } catch {
    return { ok: false, source: "provider", status: 502, error: "network",
      message: "Could not reach the AI service. Check your connection and try again." };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[transcribe] OpenRouter HTTP error:", res.status, body.slice(0, 500));
    const lower = body.toLowerCase();
    if (res.status === 404 || lower.includes("no endpoints") || lower.includes("data policy")) {
      return { ok: false, source: "provider", status: 503, error: "no_private_endpoint",
        message: "Reading images is unavailable right now: no AI provider currently meets Sendset's privacy requirements (no logging, zero data retention) for this model. Your image was not sent to a non-compliant provider." };
    }
    // 413, and any provider-specific size or dimension refusal, lands here with
    // the provider's own status. We do not claim to know their limit.
    if (res.status === 413 || lower.includes("too large") || lower.includes("image") && lower.includes("size")) {
      return { ok: false, source: "provider", status: 413, error: "provider_rejected_image",
        message: "The AI service would not accept that image — it may be too large or too high-resolution. Try a smaller or re-saved copy." };
    }
    return { ok: false, source: "provider", status: 502, error: "provider_error",
      message: "The AI service could not read that image. Please try again." };
  }

  let content: string | null = null;
  try {
    const data = await res.json();
    const choice = data?.choices?.[0];
    // FAIL CLOSED ON A CUT-OFF READING, exactly as the structuring path does. A
    // truncated transcription is a document with its end silently removed, and
    // the professional would be correcting a source that is already incomplete.
    if (choice?.finish_reason === "length") {
      return { ok: false, source: "provider", status: 502, error: "truncated",
        message: "That image produced more text than one reading can return. Try photographing it in two halves." };
    }
    content = typeof choice?.message?.content === "string" ? choice.message.content : null;
  } catch {
    return { ok: false, source: "provider", status: 502, error: "unreadable_response",
      message: "The AI service returned something unreadable. Please try again." };
  }

  const text = String(content ?? "").trim();
  if (!text) {
    return { ok: false, source: "provider", status: 422, error: "empty_transcription",
      message: "No readable text was found in that image." };
  }
  return { ok: true, text };
}
