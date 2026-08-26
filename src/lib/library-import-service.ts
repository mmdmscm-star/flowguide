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

/**
 * Chunk TEXT, for the price gate only.
 *
 * Deliberately separate from `loadImportChunks`, which deliberately does not
 * select `segment_text`: phase and ordering do not need it, and every caller
 * would otherwise pull the entire pasted source on every poll.
 *
 * The separation is also why this is worth stating out loud — auditing a price
 * against a chunk list that carries no text finds NO supporting value and
 * condemns every price in the import. An empty result here is a broken audit,
 * not a clean one.
 */
export async function loadChunkTexts(
  db: Db, runId: string,
): Promise<Array<{ ordinal: number; segment_text: string }>> {
  const { data } = await db
    .from("ingestion_chunks")
    .select("ordinal, segment_text")
    .eq("run_id", runId)
    .order("ordinal");
  return (data ?? []).map((c: Record<string, unknown>) => ({
    ordinal: Number(c.ordinal),
    segment_text: String(c.segment_text ?? ""),
  }));
}
