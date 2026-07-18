// Deterministic fault injection for acceptance testing of the ingestion
// orchestrator. Retry, adaptive-split and wrong-shape paths cannot be exercised
// reliably against a real provider — they depend on the provider misbehaving on
// a specific chunk at a specific attempt.
//
// INERT BY DEFAULT AND IN PRODUCTION. Every call returns null unless BOTH:
//   - NODE_ENV !== "production", and
//   - FLOWGUIDE_TEST_FAULT_FILE points at a readable JSON spec.
// The spec is re-read per call so a test can change faults between runs without
// restarting the dev server.
//
// Spec shape (all keys optional; ordinals are chunk ordinals):
//   {
//     "runId":      "<only apply to this run>",
//     "failAttempts":  { "2": 1 },   // ordinal 2 fails its first 1 attempt(s)
//     "truncate":      [3],          // ordinal 3 reports truncation -> split
//     "wrongShape":    [4],          // ordinal 4 returns the OTHER entry point's shape
//     "emptyResult":   [5]           // ordinal 5 returns a structurally empty result
//   }
import { readFileSync } from "node:fs";

export type Fault =
  | { kind: "error"; status: number; message: string }
  | { kind: "split" }
  | { kind: "wrongShape" }
  | { kind: "emptyResult" };

type Spec = {
  /** Must be exactly true or the spec is ignored entirely. */
  flowguideFaultInjection?: boolean;
  runId?: string;
  failAttempts?: Record<string, number>;
  truncate?: number[];
  wrongShape?: number[];
  emptyResult?: number[];
  /** ordinal -> HTTP status (401/402/403): a permanent provider rejection. */
  permanent?: Record<string, number>;
};

// Marks an injected permanent failure so an acceptance harness can tell it apart
// from a REAL provider 402 (which must halt the whole pass immediately).
export const INJECTED_PERMANENT = "Injected permanent provider failure";

// A spec must OPT IN explicitly with this key. An env var pointing at some other
// JSON file — or a stale/misconfigured path — is therefore not enough to turn
// fault injection on anywhere.
const OPT_IN_KEY = "flowguideFaultInjection";

/**
 * Fault injection requires ALL THREE, checked on every call:
 *   1. NODE_ENV !== "production"
 *   2. FLOWGUIDE_TEST_FAULT_FILE set to a readable JSON file
 *   3. that file explicitly setting flowguideFaultInjection: true
 *
 * Callers additionally guard the call site with a literal NODE_ENV comparison so
 * the production bundle drops it entirely (see the chunk route). This function
 * is the runtime backstop for that build-time elimination.
 */
function loadSpec(): Spec | null {
  // Checked first and read directly from process.env (not cached at module load)
  // so it cannot be bypassed by import order or a mutated cached value.
  if (process.env.NODE_ENV === "production") return null;
  const path = process.env.FLOWGUIDE_TEST_FAULT_FILE;
  if (!path) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // absent/unparseable spec means "no faults"
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  if ((parsed as Record<string, unknown>)[OPT_IN_KEY] !== true) return null;
  return parsed as Spec;
}

export function nextFault(runId: string, ordinal: number, attempt: number): Fault | null {
  const spec = loadSpec();
  if (!spec) return null;
  if (spec.runId && spec.runId !== runId) return null;

  // Permanent rejections are checked first: they must not be masked by a
  // transient rule on the same ordinal.
  const permStatus = spec.permanent?.[String(ordinal)];
  if (typeof permStatus === "number") {
    return { kind: "error", status: permStatus, message: `${INJECTED_PERMANENT} (${permStatus}).` };
  }

  const failFor = spec.failAttempts?.[String(ordinal)];
  if (typeof failFor === "number" && attempt <= failFor) {
    return { kind: "error", status: 502, message: `Injected provider failure (ordinal ${ordinal}, attempt ${attempt}).` };
  }
  if (spec.truncate?.includes(ordinal)) return { kind: "split" };
  if (spec.wrongShape?.includes(ordinal)) return { kind: "wrongShape" };
  if (spec.emptyResult?.includes(ordinal)) return { kind: "emptyResult" };
  return null;
}

export const faultsEnabled = () => loadSpec() !== null;
