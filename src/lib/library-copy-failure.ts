// WHAT A FAILED LIBRARY COPY IS ALLOWED TO SAY.
//
// Both Library entry points returned the database's own message straight to the
// professional. When library_copy_into_section called a signature 0033 had
// dropped, the modal read:
//
//   function public.update_item_content(uuid, uuid, uuid, unknown, text, text,
//   text, text, jsonb, jsonb, jsonb, jsonb) does not exist
//
// That tells someone trying to build a FlowGuide nothing they can act on, and
// it publishes the shape of the schema to anyone who can make the call fail.
//
// Refusals a professional CAN act on keep their own wording — a missing item, an
// empty selection, the wrong section. Everything else is a fault on our side:
// the professional gets one plain sentence, and the detail goes to the server
// log, where diagnosing it belongs.

export interface CopyFailure {
  error: string;
  message: string;
  status: number;
}

// Matched on the exception text raised by library_copy_into_section (0023).
// Each of these is a state the professional can resolve themselves.
const ACTIONABLE: Array<{ match: RegExp; error: string; message: string; status: number }> = [
  {
    match: /missing or not yours/i,
    error: "entries_unavailable",
    message: "Some of those Library items are no longer available. Refresh and try again.",
    status: 409,
  },
  {
    match: /choose at least one/i,
    error: "bad_request",
    message: "Choose something from your Library first.",
    status: 400,
  },
  {
    match: /section does not belong/i,
    error: "bad_request",
    message: "That section is not part of this FlowGuide.",
    status: 400,
  },
];

/**
 * Turn a raw database error into something safe to show.
 *
 * `where` and the raw text are logged every time, including for the actionable
 * cases — a refusal that fires more often than expected is worth seeing.
 */
export function libraryCopyFailure(
  raw: unknown,
  where: string,
  fallback: { error: string; message: string; status?: number },
): CopyFailure {
  const text = typeof raw === "string" ? raw : String((raw as { message?: unknown })?.message ?? raw ?? "");
  console.error(`[library-copy] ${where}: ${text}`);

  for (const rule of ACTIONABLE) {
    if (rule.match.test(text)) {
      return { error: rule.error, message: rule.message, status: rule.status };
    }
  }
  return { error: fallback.error, message: fallback.message, status: fallback.status ?? 400 };
}

/** Shown when the failure is ours, not the professional's. */
export const CREATE_FAILED_MESSAGE =
  "FlowGuide could not create this from your Library. Nothing was created — please try again.";

export const ADD_FAILED_MESSAGE =
  "FlowGuide could not add those Library items. Nothing was changed — please try again.";
