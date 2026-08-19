import { createServerClient } from "./supabase.ts";
import type { ImportChunk } from "./library-import.ts";

type Db = ReturnType<typeof createServerClient>;

export interface ImportRunRow {
  id: string;
  status: string;
  destination: string;
  totalChunks: number;
  completedChunks: number;
}

/**
 * Load a run and confirm it is THIS professional's LIBRARY import.
 *
 * One function so ownership and destination are checked identically on every
 * route. The RPCs check both again; that is not redundancy to remove, because
 * the routes need to return a 404/409 a person can read rather than surfacing a
 * raised database exception.
 */
export async function loadImportRun(
  db: Db, userId: string, runId: string,
): Promise<{ run?: ImportRunRow; error?: "not_found" | "wrong_destination" }> {
  const { data } = await db
    .from("ingestion_runs")
    .select("id, status, destination, total_chunks, completed_chunks")
    .eq("id", runId).eq("user_id", userId).maybeSingle();
  if (!data) return { error: "not_found" };
  const r = data as Record<string, unknown>;
  if (r.destination !== "library") return { error: "wrong_destination" };
  return { run: {
    id: r.id as string, status: r.status as string, destination: r.destination as string,
    totalChunks: Number(r.total_chunks), completedChunks: Number(r.completed_chunks),
  } };
}

/** Leaf chunks, which is what phase and ordering are both derived from. */
export async function loadImportChunks(db: Db, runId: string): Promise<ImportChunk[]> {
  const { data } = await db
    .from("ingestion_chunks")
    .select("ordinal, source_start, status")
    .eq("run_id", runId)
    .order("source_start");
  return (data ?? []).map((c: Record<string, unknown>) => ({
    ordinal: Number(c.ordinal),
    sourceStart: Number(c.source_start),
    status: c.status as string,
  }));
}
