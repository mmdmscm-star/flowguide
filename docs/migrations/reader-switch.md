# Reader switch — recipients read the frozen publication

**Prepared on branch `reader-switch`; not merged, not deployed. Backfill APPLIED
2026-09-15 22:11Z: 33 published → 33 publications, all equal to the live render by
value; manifest at `~/.sendset-backfill/0054-manifest-2026-09-15.json`.**

Decisions (2026-09-15): keep the logged fallback for the initial rollout; the 4
old-card Sendsets correctly show "Changes not published"; the 9 live-profile
Sendsets stay frozen at backfill (profile edits need Republish); Republish stays
in the editor; photo-ownership restriction unchanged; no dashboard indicator in v1.

## What changes

- `getPublishedPacket` (web page, print, email) returns the Sendset's
  `packet_publications` copy. The working rows become the draft. The internal
  title is blank on every recipient path.
- A failed publication read or an unknown `format_version` throws (500) — never
  the working rows.
- **Temporary fallback:** a published Sendset with no publication row renders its
  live rows and logs `[publication-reader] published Sendset has no publication`.
  That is only the state of pre-0052 Sendsets before the backfill; after a
  complete backfill it cannot occur (publish writes both, unpublish deletes both,
  0053 refuses other status changes), so any log line is an alarm. Removed after a
  clean period, alongside a status ⇔ publication invariant.
- `getLiveRowsPublishedPacket` keeps the pre-switch assembly for the fallback and
  the backfill only.
- `GET /api/packets/:id/publication-state` (owner session): builds the copy a
  Republish would freeze (`buildPublicationSnapshot` + `republishIdentity`) and
  compares it with the stored copy by value (`canonicalJson`). 503 when it cannot
  tell; the UI then claims nothing.
- Editors: autosave unchanged, no Save button. Legacy bar: "Saved" /
  "Saved · Changes not published"; bottom bar adds a primary **Republish**
  (stays in the editor; "Republishing…" → inert "Republished" for 1.5 s). Block
  editor pill says it and links to Preview; published block structure stays
  locked. Preview share step, when changes exist: "You have unpublished changes.
  This preview shows your current draft; email and print use the last published
  version until you republish." + Republish; style choices re-check.
- Public 404: "This Sendset is no longer available." / "If you were expecting to
  see it, contact the person who shared the link."
- Identity rule extracted to `lib/publish-identity.ts` (publish route and state
  check share it). No migration. Draft-only guards untouched.

## Rollout order

1. Fresh backfill dry run: 31 candidates, all match, nothing changed.
2. `cli.mts --apply --manifest <file>` (needs approval).
3. `verify-readers.mts`: `published 33, same 33, differs 0, missing 0`; the two
   original publications byte-identical.
4. Re-run `verify-readers.mts` immediately before merging; then merge
   `reader-switch` to `main`, push, confirm Vercel Ready (needs approval). Any
   `differs` means live rows changed after the backfill: stop, and re-freeze that
   Sendset (manifest rollback SQL for that id + backfill again) before deploying.
5. After deploy: no `[publication-reader]` log lines; signed-in test — edit a
   published Sendset, see "Saved · Changes not published", public page/print/email
   unchanged, Republish, public page updated, "Published".

**Rollback:** revert the merge and redeploy — readers return to live rows.
Publications stay (publish keeps writing them); backfilled rows are removed only
with the manifest SQL, if ever.

## Evidence (read-only, 2026-09-15)

- Production: the 2 existing publications render identically to their live rows
  (data and markup); editors would say "current". 31 await the backfill.
- Simulated day one after backfill: 27 "Published", 4 "Changes not published"
  (`32ad3654`, `38c68f1c`, `49741f86`, `8ee536ad` — cards frozen before the
  2026-07-09 profile edit).
