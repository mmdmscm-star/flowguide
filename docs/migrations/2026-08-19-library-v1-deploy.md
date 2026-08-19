# Production deploy — Library v1 (legacy composition)

**Shipped 2026-08-19. Commit `e8abbad`. Vercel state: success.**

| | |
|---|---|
| Rollback point | `f8ddd7f` — redeploy from the Vercel dashboard |
| Commits | 20, fast-forward |
| Database | 0017 applied 18 Aug · 0018 applied then dropped by 0019 · **this deploy adds no schema** |

## What shipped

`/library` workspace with full-text search · Save to Library with a duplicate
warning · user-initiated bulk promotion, nothing preselected · Add from Library,
appearing immediately · direct Library editing reusing `BlockItemEditor` ·
**Update saved version** with the tailored-descendant safeguard · optimistic
concurrency on both write paths.

The product loop: **Save → Find → Insert → Edit freely → explicitly update the
saved version.** No synchronization anywhere; insertion is a disconnected
snapshot.

## Post-deploy smoke — 20/20

Run against production on disposable data. No live FlowGuide was read or written.

| Check | Result |
|---|---|
| route live, rejects signed-out | PASS |
| empty Library reads cleanly | PASS |
| Save to Library, entry at revision 1 | PASS |
| search by a term only in a **detail label** | PASS |
| duplicate save **warns**, never merges | PASS |
| Add from Library | PASS |
| lineage recorded, both columns | PASS |
| **no 0014 provenance fabricated** | PASS |
| payload order intact | PASS |
| trimmed detail reported as a **removal** | PASS |
| **Keep both offered first**, not replacement | PASS |
| Keep both creates a second entry | PASS |
| **original entry untouched** | PASS |
| stale revision refused | PASS |
| FlowGuide with a Library item publishes | PASS |
| **block-mode insertion refused** | PASS |
| nothing written — no orphan item | PASS |
| block FlowGuide still consistent | PASS |
| `library_insert_item_block` gone from production | PASS |

Cleanup: 0 packets, 0 library items, 0 users remaining.

## Migration record

- **0017** — `library_items`, lineage columns, coherence CHECK, delete trigger,
  two atomic cross-table writers. Applied 18 Aug, proven 38/38.
- **0018** — `library_insert_item_block`. Applied 18 Aug, then its runtime proof
  showed it could never succeed: `trg_freeze_items` (0007) rejects INSERT for any
  item in a block-mode packet. **The file is unmodified**, byte-for-byte the one
  that was integrity-checked (`sha256 027d6399…3ef29`), because an applied
  migration is a record of what ran.
- **0019** — drops that function and asserts both freeze triggers survive, so a
  correction cannot become a weakening. Applied 19 Aug.

## Known limits

- **Block composition is out of scope.** Library insertion is refused there,
  before any write, and no affordance is offered. See the roadmap entry:
  *Block-mode Library insertion — revisit the block-mode item/section freeze and
  composition ownership model.* A composition project, not a Library patch.
- Not built: groups/categories/reordering, undo/version history, AI import into
  the Library, side-by-side assembly.
- `/p/[slug]` WAF rule remains in **Log** mode, collecting observation data.
