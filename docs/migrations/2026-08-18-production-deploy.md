# Production deploy — segmentation, provenance, ownership

**Shipped 2026-08-18. Commit `3bc03e8`. Vercel deployment state: success.**

The stack `aa87636` deliberately withheld — seg-v4 record detection,
media-ownership verification, ownership recomputation — plus everything built on
top of it. 33 commits, 41 files, fast-forward from `aa87636`.

| | |
|---|---|
| Rollback point | `aa87636` — redeploy from the Vercel dashboard |
| Runtime surface | 30 files, +3437/−73 (`src/`, `tsconfig.json`) |
| Non-runtime | 11 files (docs, scripts, migration record) |
| Database | migration 0016, applied 2026-08-17 — **no change in this deploy** |
| Pre-deploy gate | 243/243 unit tests, tsc clean, production build clean |

`SEGMENTER_VERSION` moved **seg-v3 → seg-v4**. Nothing in this deploy alters the
database; 0016 was applied the day before and verified separately.

---

## Proofs that gated it

| Proof | Result |
|---|---|
| [0016 migration](0016-deployment.md) §12 | preflight 1-5 clean, applied first attempt, post-apply 12/12, E2E 25/25 |
| [seg-v4 runtime](../investigations/seg-v4-runtime-proof.md) | 21/21 locally, real model and database |

---

## Post-deploy smoke — 31 checks, all passed

Run against production on **disposable data only**. No live client packet was
read or written; the pre-seg-v4 case was *constructed* as a disposable packet
carrying a run recorded as `seg-v3`, rather than borrowing a real one.

### `smoke-post-deploy.mts` — 10/10

| Check | Result |
|---|---|
| ownership route exists in production (not 404) | PASS |
| rejects signed-out access **on a real packet we own** | PASS — 401 |
| the owner can read it | PASS — 200 |
| a packet with no decisions reports `kept: []` — editor panel stays hidden | PASS |
| the check is not silently unavailable | PASS |
| a seg-v3 packet's ownership route answers rather than erroring | PASS |
| a seg-v3 packet **declines** rather than being checked | PASS — `checked: false` |
| a decline produces no findings and nothing blocking | PASS |
| **a pre-seg-v4 packet publishes normally** | PASS — 200 |
| and was not blocked by an unavailable check | PASS |

The signed-out probe uses a real owned packet id deliberately: a random uuid
returns 401 whether or not the route can see the row, so it proves nothing.

### `verify-seg-v4.mts` against production — 21/21

The sanitized incident fixture, imported through the live production routes and
model. `chars=9885 initialChunks=4 leaves=4 splits=0 retries=0`, 4 model calls,
44.1s. Records survived the separator rows; no chunk boundary fell inside a
record; all 24 media occurrences stayed with their record; no media-only chunk;
one item per record with complete provenance and dense emit indices; ownership
**available and checked**, zero findings; the packet published.

### Cleanup

Both scripts reported clean, and a separate sweep confirmed it:

```
disposable users remaining:   0
disposable packets remaining: 0
item_media_decisions rows:    0
```

---

## What is now true in production

- **New imports are record-atomic.** The segmentation defect that caused the
  2026-08-14 incident cannot recur in the shape that caused it.
- **The ownership gate is live**, and it works on new imports: recomputation
  answers rather than declining, so a real misplacement would block publishing
  with Move/Keep offered.
- **Existing packets are unaffected.** Every pre-deploy packet is seg-v3 and
  declines on a version mismatch — nonblocking by design, verified in production.
  The gate protects future imports, not the existing library.
- **A consolidated repeat no longer parks a run.** A source listing one photo
  twice inside a record reports an advisory, not "1 photo is missing".

## What to watch

`[publish] ownership verification unavailable` should never appear now that 0016
is applied. If it does, check the `service_role` grant on
`item_media_decisions` first — see [0016-deployment.md](0016-deployment.md) §3.

`[publish] ownership not establishable` is expected on every pre-deploy packet
and is not a fault.

## Not covered

- Only the tabular-with-separator-rows shape was proven at runtime. The Drake
  shape (quoted photo cells containing blank lines) is covered by unit tests.
- Historical packets. If revisited, the framing is **historical ownership
  recovery where provable** — never a backfill.
