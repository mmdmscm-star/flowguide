// How a client should react to one chunk-processing response.
//
// FOUND BY THE RUNTIME PROOF. A real provider hiccup returned
//   { error: "chunk_failed", message: "AI service error...", permanent: false }
// and both drive loops treated it as terminal — stranding the import — even
// though the server had already marked the chunk `failed` and tagged it
// `[transient]` precisely so the NEXT attempt would retry the same segment
// rather than subdivide it. The server's recovery was correct; the clients threw
// it away.
//
// `permanent` is the authoritative signal, computed server-side from the
// provider's status. Sniffing HTTP codes on the client is a second, weaker copy
// of that judgement — which is how the two disagreed.

export type ChunkOutcome =
  | { kind: "split" }
  | { kind: "completed" }
  | { kind: "retry" }
  | { kind: "fatal"; message: string };

/** A network failure or client-side timeout: the lease expires and another
 *  attempt reclaims the chunk, so this is always worth retrying. */
export const CHUNK_NETWORK_FAILURE: ChunkOutcome = { kind: "retry" };

export function classifyChunkResponse(
  status: number,
  ok: boolean,
  data: Record<string, unknown>,
): ChunkOutcome {
  // Platform-level failures never reached the model.
  if (status === 500 || status === 502 || status === 504) return { kind: "retry" };

  if (ok) {
    const s = data.status;
    if (s === "split") return { kind: "split" };
    if (s === "completed") return { kind: "completed" };
    // "processing" means another attempt holds the claim; anything unrecognised
    // is treated the same way, because looping is recoverable and stopping is not.
    return { kind: "retry" };
  }

  // THE FIX. A chunk the server judged transient must be retried: it escalates
  // on its own — subdividing at AUTO_SPLIT_AT_ATTEMPT and reporting
  // permanent:true past MAX_TRANSIENT_ATTEMPTS — so this cannot loop forever.
  if (data.error === "chunk_failed" && data.permanent !== true) return { kind: "retry" };

  return {
    kind: "fatal",
    message: String(data.message ?? data.error ?? "A part failed. You can retry."),
  };
}
