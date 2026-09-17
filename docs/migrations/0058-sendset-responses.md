# 0058 — Sendset responses

**Applied to production 2026-09-17. No app change deployed yet.**

A recipient can send the professional a message about a published Sendset. 0058
is the storage and the two database doors; nothing writes to it until the app
half deploys.

## Objects

- `packets.response_actions text[] not null default '{}'` — CHECK `<@ {respond}`.
  Every existing Sendset reads `{}` (off). Outside `draft_rev`/`content_rev` and
  the frozen publication: switching it is live on the next request.
- `sendset_responses` — one per message. `packet_id` and `owner_user_id` are
  **ON DELETE RESTRICT**. Stores the rendered publication marker
  (`live_publication_published_at`, `rendered_publication_was_current`), the
  optional responder name/contact, and the notification state.
- `sendset_response_lines` — v1 writes exactly one `sendset`/`respond` line.
- RLS enabled, **no policies**; no table privilege for PUBLIC/anon/authenticated;
  `service_role` has SELECT only. All writes go through the functions.
- `record_sendset_response(slug, rendered_published_at, name, contact, note)` —
  validates before lookup; `PT400 marker_invalid|note_required`,
  `PT404 not_accepting` (unknown, draft, unpublished and off are indistinguishable),
  `PT429 rate_limited`. v1 abuse and cost controls: 20 per Sendset per hour,
  300 per hour overall, 5 due notification emails per Sendset per hour.
- `mark_sendset_response_notified(id)`.
- `delete_sendset(owner, packet, acknowledged_responses)` — the one deliberate
  delete. Locks the packet; `PT404 not_found`; `PT409 responses_changed` (hint =
  the current count) unless the acknowledgement equals the count exactly.
- All three functions: SECURITY DEFINER, `search_path=''`, EXECUTE for
  `service_role` only.

## Deploy order

The block editor selects `response_actions` by name, so **0058 must be live
before the app deploys** (it now is). The DELETE route must use `delete_sendset`
before any deployed code can create a response: a plain delete of a Sendset with
responses is refused by RESTRICT (23503).

## Verification (2026-09-17)

- File SHA-256 `e4435624d75f07c50fbd344a2ec1b953d0e9946ee70d599f86d1b0aa4293bbb6`
  = reviewed; harness `scripts/pg-harness/test-0058.mjs` 128 pass, 0 fail.
- Applied once with `db query --linked -f`; no error.
- Baseline before/after: all 22 public tables, row count and full-row digest
  (excluding `view_count` and the new column) — identical. 60 packets, 34
  publications, revisions unchanged.
- After: 60/60 packets `response_actions = '{}'`; 0 responses; 0 lines; no
  proof rows survived.
- Catalog query (columns, constraints, indexes, RLS, policies, table grants,
  function signature/secdef/config/source md5/ACL) — 50 rows, **identical** to
  the same query on a local replay of 0013..0058.
- `migration repair --status applied 0058`; `migration list` matches all 57
  versions; `db push --dry-run` reports up to date.

## Rollback

`supabase/rollbacks/0058_sendset_responses_down.sql`. Revert and deploy the app
first. It **refuses while any response exists**.
