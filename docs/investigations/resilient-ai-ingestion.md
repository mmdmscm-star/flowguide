# Investigation: resilient AI ingestion (Organize/Add with AI timeouts)

Phase 1 — diagnosis + recommendation only. **No feature built.** Branch:
`investigate/resilient-ai-ingestion` from `main @ 318d67b`.

## Symptom
Initial *Organize with AI* sometimes times out on packets that "don't feel
large." Manually splitting the same source into two submissions succeeds. The
sender gets no meaningful progress and a generic "try again" before failure.

## Root cause (proven)
The single all-at-once request generates **every** structured item in one model
call. Generation time scales ~linearly with item count (~2s/item at ordinary
senior-placement density). **Vercel kills the serverless function at
`maxDuration = 60`s** → `FUNCTION_INVOCATION_TIMEOUT` (HTTP 504). The 504 body is
not JSON, so the UI's graceful handlers never run and it falls through to a
generic error. It is a **duration** limit, not input size, model token cap,
parsing, or DB.

### Measured evidence — direct model timing (exact prod prompt, `claude-sonnet-4`, `max_tokens 24000`)
| items | input chars | completion tokens | wall time | finish_reason | >60s |
|------:|------------:|------------------:|----------:|:-------------:|:----:|
| 6  | 2 578  | 1 594  | 15.1s | stop | no |
| 15 | 6 197  | 3 843  | 28.1s | stop | no |
| 25 | 10 237 | 6 361  | 49.6s | stop | no |
| 40 | 16 294 | 10 117 | 83.8s | stop | **YES** |

- Throughput ~120–137 tok/s; ~250 completion tokens/item; parse time ~0ms.
- `finish_reason = stop` at every size → the 24 000-token output cap is **not**
  the boundary. The boundary is pure generation duration.
- **60s crossover ≈ ~30 items / ~12k input chars / ~7 500 completion tokens** —
  all far below the 30 000-char input gate. "Not exceptionally large" confirmed.

### Measured evidence — end-to-end on production (`/api/packets/:id/structure`, N=40)
```
HTTP 504 in 61.5s
body: "FUNCTION_INVOCATION_TIMEOUT ... sfo1::..."
persisted: sections=0 items=0   (orphan empty packet left = true)
```
The model call is killed before any DB write, so nothing persists — but the
packet was already created with `raw_input` set, leaving an **orphan empty
draft**.

## Timeout-boundary map (actual configured values)
- `maxDuration = 60` on all three AI routes (`/structure`, `/append`,
  `/sections/[id]/append`). Effective hard ceiling in production.
- Input gate: reject > `MAX_INPUT_CHARS = 30 000` → 413 (never truncates).
- Model: `anthropic/claude-sonnet-4`, `temperature 0.3`, `max_tokens 24 000`,
  provider `{data_collection:"deny", zdr:true}`. **No client-side fetch timeout /
  AbortController; no streaming; no retry.** Bounded only by the 60s kill.
- Truncation guard: `finish_reason==="length"` → 422 `output_truncated`
  ("split it…"). Distinct from the duration timeout (this case never hit it).
- Persistence: `/structure` and `/append` use `insertStructuredSections` (JS
  compensating rollback — **not a real transaction**; a hard kill mid-write may
  not roll back). `/sections/[id]/append` uses the atomic `insert_items_into_section`
  RPC (real txn; auto-rolls back on abort).

## Current UI / retry shortcomings
- No real progress — indeterminate spinner only; streaming unused.
- Duration timeout is invisible to the app (generic "Something went wrong. Please
  try again."). Graceful 413/422/503 messages don't cover it.
- Retry not idempotent, preserves nothing: Organize creates the packet *first*,
  so a timeout leaves an orphan empty draft; re-clicking makes **another** packet
  and re-runs from scratch.
- Refresh/navigate during processing abandons the request; no resume.

## Recommended smallest architecture
**Client-orchestrated sequential segments + a minimal server-side idempotent
cursor.** (Chosen over both the naive client-only approach — no idempotency — and
a full server-side job/queue model — new tables/infra, more orphan surface, needs
Vercel cron/queue.) Rationale: each segment already **appends into the canonical
packet**, so completed work survives a refresh regardless of orchestrator; the
only server state needed for idempotency + resume is a tiny per-packet cursor.

- **Fast path unchanged.** If deterministic segmentation yields 1 segment
  (≈ < 15 items / < 8k chars), use today's single `/structure` call.
- **Risky inputs detected up front** (estimated items/chars) → segmented mode.
- **Natural-boundary segmentation** (pure, deterministic): split at headings /
  blank-line-separated blocks; never mid-block, so a person + phone stay
  together. Char/estimated-item cap per segment (~8–12 items, target ~25–35s
  generation, comfortably < 60s). Char-based fallback for a wall of text with no
  boundaries.
- **Per-segment bounded request** structures ONE segment and, in a **single
  transaction** (build on `insert_items_into_section`), inserts its items **and**
  advances a packet cursor — exactly-once per segment.
- **Idempotency + resume via a tiny cursor on `packets`:** `ingest_status`
  ('none'|'in_progress'|'done'), `ingest_total int`, `ingest_done int`. A re-POST
  for an already-done index is a no-op (guarded in the txn). Segmentation is a
  pure function of `raw_input` (already persisted in full at Organize time), so a
  refresh recomputes the same plan and **resumes from `ingest_done`** — no plan
  storage, no new table.
- **Partials write directly into the canonical packet** (append path) — no
  separate staging store, preserving the single-source-of-truth rule. Guarded by
  the `ingest_status='in_progress'` flag so a partially-imported packet shows a
  clear "Import in progress — resume" banner and is never mistaken for complete.
  On finalize: set `done`, run a completeness check (`ingest_done == ingest_total`,
  item count sane).

### Proposed UX
"Preparing information…" → "Processing part 2 of 4…" (from `ingest_done/total`) →
"Combining and checking results." Per-segment error → "Part 3 didn't finish —
Retry" retries only that segment; completed parts stay. Reload mid-import → banner
offers Resume.

### Data-model / endpoint changes (minimal)
- `packets`: add `ingest_status text default 'none'`, `ingest_total int default
  0`, `ingest_done int default 0` (additive, backward-compatible; existing packets
  default to 'none').
- One segmented-ingest endpoint (or extend append) that processes segment `k`
  atomically (insert + cursor advance + idempotency guard), reusing the
  `insert_items_into_section` transaction pattern. Fast path (`/structure`)
  unchanged.
- Published render + editor untouched.

## Risks / edge cases
- A single indivisible oversize block (no blank lines) could still exceed 60s →
  char-fallback sub-split + clear message.
- Model non-determinism across retries → cursor makes a committed segment a no-op,
  so no duplicates; a not-yet-committed segment simply re-runs.
- Order preserved (segments processed and appended in order).
- Double-submit / two tabs → cursor serialization in the txn prevents dup inserts.
- Abandoned import → resume banner; optional cleanup of empty abandoned ingests.

## Acceptance-test plan (for the implementation phase)
- The sanitized/synthetic failing fixture completes without manual splitting.
- All items / contacts / links / details preserved; source order deterministic.
- No duplicates across segment boundaries.
- A deliberately failed middle segment retries successfully; completed segments
  not repeated.
- Refresh/resume continues from `ingest_done`.
- Double-submit protection (no dup items).
- Progress reflects actual completed work.
- Ordinary small packets stay on the fast path (single call, fast).
- All three AI entry points behave consistently.
- Cleanup leaves no orphan ingestion/packet/session records.

## Reproduction fixture
`docs/investigations/fixtures/senior-placement-source.mjs` — `makeSource(n)`
returns deterministic, fully-synthetic senior-placement source with natural
boundaries. n≈40 reproduces the 60s timeout; n≤15 is the fast path.
