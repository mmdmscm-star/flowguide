// ============================================================
// Single-flight, in-order mutation runner with optimistic apply + rollback.
//
// Only one mutation runs at a time. A mutation started while another is in
// flight is REJECTED (not queued), so there is never an overlap and a late
// failed request can never roll back a newer successful mutation — there is no
// newer mutation while one is pending. Callers pair this with disabled editing
// controls so the rejected path is rarely hit in practice.
//
// The runner OWNS the persisted baseline (last state known to be saved). Each
// mutation optionally applies an optimistic state immediately, then runs an
// async save. On success the (optimistic or save-produced) state becomes the new
// baseline. On failure the state is rolled back to the baseline. The logic is
// framework-agnostic and unit-tested.
// ============================================================

export type MutationResult = "ok" | "rejected" | "failed";

export class SerialMutations<S> {
  private busy = false;
  private saved: S;
  private readonly apply: (s: S) => void;
  private readonly onBusyChange: (busy: boolean) => void;

  constructor(initial: S, apply: (s: S) => void, onBusyChange: (busy: boolean) => void) {
    this.saved = initial;
    this.apply = apply;
    this.onBusyChange = onBusyChange;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  // The last state known to be persisted (the rollback target).
  getSaved(): S {
    return this.saved;
  }

  // Run one mutation. `optimistic` (if not null) is applied immediately. `save`
  // performs the persistence and may return the definitive next state (used by
  // add, whose final ids are only known after the server responds); if it
  // returns void, `optimistic` is the committed state.
  async run(optimistic: S | null, save: (prev: S) => Promise<S | void>): Promise<MutationResult> {
    if (this.busy) return "rejected";
    this.busy = true;
    this.onBusyChange(true);
    const prev = this.saved;
    if (optimistic !== null) this.apply(optimistic);
    try {
      const produced = await save(prev);
      const next = (produced ?? optimistic ?? prev) as S;
      this.saved = next;
      this.apply(next);
      return "ok";
    } catch {
      this.apply(prev);
      this.saved = prev;
      return "failed";
    } finally {
      this.busy = false;
      this.onBusyChange(false);
    }
  }
}
