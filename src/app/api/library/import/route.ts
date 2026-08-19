import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { buildRunChunks, SEGMENTER_VERSION } from "@/lib/ingestion";
import { segmentHash } from "@/lib/segmentation";

export const maxDuration = 60;
const IMPORT_MAX_CHARS = 200000;

// POST /api/library/import — start (or reconnect to) a Library AI import.
//
// The run row and every chunk are created in ONE transaction by
// create_library_import_run. Doing it here as two calls would let a crash leave
// a run with no chunks: unable to complete, and holding the one-import-per-
// professional slot until someone cleared it by hand.
//
// NO PACKET IS CREATED. This is the whole point of the feature — populating the
// Library has never required a FlowGuide to exist.
// GET /api/library/import — the professional's open import, if there is one.
//
// FOUND WHILE BUILDING THE REOPEN PATH. Reconnecting through POST works only if
// you still have the pasted text, which after closing the tab you do not. A run
// that is durable but unreachable is not resumable, so the open run needs to be
// discoverable on its own.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createServerClient();
  const { data } = await supabase
    .from("ingestion_runs")
    .select("id, status, total_chunks, completed_chunks, created_at")
    .eq("user_id", session.userId).eq("destination", "library")
    .in("status", ["active", "finalizing", "needs_review"])
    .maybeSingle();

  if (!data) return NextResponse.json({ run: null });
  const r = data as Record<string, unknown>;
  return NextResponse.json({
    run: {
      id: r.id, status: r.status,
      totalChunks: Number(r.total_chunks), completedChunks: Number(r.completed_chunks),
      startedAt: r.created_at,
    },
  });
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const rawText = typeof body.rawText === "string" ? body.rawText.trim() : "";
  if (rawText.length < 10) {
    return NextResponse.json({ error: "too_short", message: "Paste more text first." }, { status: 400 });
  }
  if (rawText.length > IMPORT_MAX_CHARS) {
    return NextResponse.json({
      error: "input_too_large",
      message: `Too large (${rawText.length.toLocaleString()} characters; limit ${IMPORT_MAX_CHARS.toLocaleString()}).`,
    }, { status: 413 });
  }

  const supabase = createServerClient();
  const chunks = buildRunChunks(rawText);
  const { data, error } = await supabase.rpc("create_library_import_run", {
    p_owner: session.userId,
    p_source_text: rawText,
    p_source_hash: segmentHash(rawText),
    p_source_len: rawText.length,   // UTF-16 code units, matching chunk offsets
    p_segmenter_version: SEGMENTER_VERSION,
    p_chunks: chunks,
  });

  if (error) {
    // ONE IMPORT AT A TIME, and the useful answer is WHICH one. The RPC raises
    // without the run id — correctly, since it is enforcing a rule rather than
    // reporting state — so the id is looked up here. A professional who pastes
    // something new while an import is open needs to be offered the open one,
    // not told "no".
    if (/already in progress/i.test(error.message)) {
      const { data: open } = await supabase
        .from("ingestion_runs").select("id")
        .eq("user_id", session.userId).eq("destination", "library")
        .in("status", ["active", "finalizing", "needs_review"]).maybeSingle();
      return NextResponse.json({
        error: "import_in_progress",
        message: "You already have an import open. Finish or abandon it before starting another.",
        runId: (open as { id?: string } | null)?.id ?? null,
      }, { status: 409 });
    }
    return NextResponse.json({ error: "create_failed", message: error.message }, { status: 400 });
  }

  const res = data as { run_id: string; reused: boolean };
  return NextResponse.json(
    { runId: res.run_id, reused: res.reused, totalChunks: chunks.length },
    { status: res.reused ? 200 : 201 },
  );
}
