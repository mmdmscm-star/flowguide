-- ============================================================================
-- 0038 — THE FIRST ORGANIZATION LAYER FOR THE LIBRARY.
--
-- The Library is one long searchable stream. At 65 saved items that is already
-- awkward, and it is meant to hold services, organizations, people, documents
-- and whatever else a profession reuses. A flat list does not survive that.
--
-- Three primitives, all named by the professional, none of them ours:
--
--   category     ONE optional broad grouping.   '' means ungrouped.
--   labels       ZERO OR MORE descriptors.      '{}' means unlabelled.
--   is_favorite  a star for what gets reached for constantly.
--
-- Deliberately generic. "Communities", "Services", "Santa Rosa", "Memory Care"
-- are one professional's vocabulary, not a taxonomy FlowGuide ships. Another
-- profession fills the same three fields with entirely different words, and
-- nothing in the schema knows the difference. Geography, specialty, type and
-- topic are all just labels.
--
-- ---------------------------------------------------------------------------
-- WHY COLUMNS AND NOT A TAXONOMY TABLE.
--
-- The normalised answer is a categories table, a labels table and a join table.
-- It is also the wrong answer here: three tables, a join on every list query,
-- orphaned-term cleanup, rename semantics, and — worst — a vocabulary
-- administration screen. The professional came to organize their material, not
-- to administer a controlled vocabulary.
--
-- A text[] with a GIN index answers `labels @> '{"Santa Rosa","Memory Care"}'`
-- in one indexed scan with no joins. The set of categories in use is
-- `select distinct category`, so the vocabulary is DERIVED FROM USE rather than
-- maintained. Spelling consistency is a write-time concern (trim, dedupe within
-- an item, reuse existing spelling case-insensitively), not a table.
--
-- ---------------------------------------------------------------------------
-- ORGANIZATION IS NOT CONTENT. THIS IS THE LOAD-BEARING PART.
--
-- library_items.revision is the save-back comparator: a copied item records the
-- revision it came from, and a mismatch means "the base moved on, replacing
-- would overwrite newer edits". So if categorising an item bumped revision,
-- bulk-organising a 65-item Library would put EVERY descendant FlowGuide into a
-- false conflict at once — a professional told that 65 FlowGuides had diverged
-- because they filed things into folders.
--
-- updated_at is the Library's ordering. Bulk-organising must not reshuffle the
-- list into migration order either.
--
-- Neither is a risk from the schema, and that is verified rather than assumed:
--
--   * library_items carries exactly ONE trigger, trg_library_clear_lineage,
--     which is BEFORE DELETE. It cannot fire on insert or update.
--   * revision and updated_at are advanced by explicit SQL in exactly two
--     places — updateLibraryItem (application) and library_update_from_item
--     (0017) — both of which set them by name.
--   * `add column ... default` is metadata-only in modern postgres: no table
--     rewrite, no UPDATE, no row trigger, nothing stamped.
--
-- So an organizational write simply omits revision and updated_at, and there is
-- no mechanism that can add them back. Content semantics are untouched.
--
-- ---------------------------------------------------------------------------
-- THESE COLUMNS NEVER REACH A RECIPIENT.
--
-- library_copy_into_section (0036) enumerates the fields it copies — title,
-- description, notes, highlight, address, details, links, photos, contacts.
-- These three are not among them, so they cannot travel into a FlowGuide, and
-- nothing has to be changed to keep them out. How a professional files their
-- own reference shelf is not information about a community.
--
-- ---------------------------------------------------------------------------
-- NO BACKFILL. The existing 65 items begin honestly unorganized: no category,
-- no labels, not favorited. Inferring "Communities" from the fact that they
-- happen to be communities would be inventing a taxonomy on the professional's
-- behalf and calling it their choice. They organize it themselves, in bulk,
-- because bulk is part of the first version for exactly this reason.
--
-- Runs as a single explicit transaction.
-- ============================================================================

begin;

alter table public.library_items
  add column category    text    not null default '',
  add column labels      text[]  not null default '{}',
  add column is_favorite boolean not null default false;

comment on column public.library_items.category is
  'One optional broad grouping, named by the professional (e.g. Communities, Services, Documents). Empty string means ungrouped. Library organization only: never copied into a FlowGuide and never shown to a recipient.';

comment on column public.library_items.labels is
  'Zero or more descriptors, named by the professional (e.g. Santa Rosa, Memory Care, Moving). Order is not meaningful. Trimmed and de-duplicated within an item at write time. Library organization only: never copied into a FlowGuide and never shown to a recipient.';

comment on column public.library_items.is_favorite is
  'The professional''s own star, for material they reach for constantly. Library organization only: never copied into a FlowGuide and never shown to a recipient.';

-- ---------------------------------------------------------------------------
-- Cheap boundary guards. Not a substitute for write-time normalisation — they
-- catch the junk that normalisation failing would otherwise store silently.
--
-- A label of '' would render as an unnamed filter chip nobody can select or
-- remove, so it is refused outright. Category is required to arrive trimmed,
-- which is checkable for a scalar; the equivalent for every array element needs
-- a subquery and cannot be expressed as a CHECK, so trimming labels stays the
-- writer's job.
-- ---------------------------------------------------------------------------
alter table public.library_items
  add constraint library_items_category_trimmed check (category = btrim(category)),
  add constraint library_items_labels_no_blank  check (array_position(labels, '') is null);

-- ---------------------------------------------------------------------------
-- PAGINATION IS PART OF THIS MIGRATION, because the ordering it needs is an
-- index shape and not just application code.
--
-- searchLibrary caps at 50 rows and never says so. With 65 saved items, fifteen
-- of them are already unreachable except by searching for something you already
-- know is there. A bigger cap is the same defect further away, so the list pages
-- instead — and paging demands a TOTAL order.
--
-- updated_at alone is not one. Two items saved in the same transaction, or in
-- the same microsecond, tie; a cursor that compares only updated_at then either
-- skips the tied row or returns it twice, depending on which side of the
-- comparison it falls. The tiebreak is id: it is the primary key, so
-- (updated_at, id) is unique by construction and the order is total.
--
--   ORDER BY updated_at DESC, id DESC
--   ...WHERE (updated_at, id) < (cursor_updated_at, cursor_id)
--
-- The index below matches that ordering column for column and direction for
-- direction, so a page is a range scan rather than a sort of everything older.
--
-- ---------------------------------------------------------------------------
-- THE 0017 INDEX IS SUPERSEDED, NOT DUPLICATED.
--
-- library_items_user_idx is (user_id, updated_at desc). The new index is
-- (user_id, updated_at desc, id desc) — the same leading columns in the same
-- directions, with a tiebreak appended. Every query the old index served, the
-- new one serves identically, including `user_id = ?` alone. Keeping both would
-- mean paying for two index writes on every save to answer the same questions,
-- so the old one is dropped rather than left behind.
-- ---------------------------------------------------------------------------
drop index if exists public.library_items_user_idx;

create index if not exists library_items_page_idx
  on public.library_items (user_id, updated_at desc, id desc);

-- Category is a top-level destination — All / Favorites / one category — so it
-- gets the ordering columns too and pages without sorting. This also supersedes
-- the plain (user_id, category) an equality filter alone would have needed.
create index if not exists library_items_category_page_idx
  on public.library_items (user_id, category, updated_at desc, id desc);

-- Favorites is the other permanent destination. Partial, because the starred
-- set is small by nature and the predicate is trivially implied by the query.
create index if not exists library_items_favorite_page_idx
  on public.library_items (user_id, updated_at desc, id desc)
  where is_favorite;

-- `labels @> '{...}'` — containment, which is what AND-ing several labels is.
-- Plain rather than partial: a partial index would need the planner to prove
-- that containment implies a non-empty array, and an index that is silently
-- never used is worse than one that is merely small.
--
-- No ordering columns here, deliberately. Label combinations are combinatorial
-- and cannot each have an index, so a label-filtered page filters through this
-- index and then sorts. That is the right trade for a filter whose result set
-- is already narrow — unlike category, which is a permanent view of a possibly
-- large slice.
create index if not exists library_items_labels_idx
  on public.library_items using gin (labels);

commit;
