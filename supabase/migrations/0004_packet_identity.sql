-- Packet-level identity: choose which identity a packet presents.
--   'default' = use the account professional profile (current behavior)
--   'none'    = hide the author identity entirely
--   'custom'  = use packet-specific identity stored in custom_identity
-- Defaults to 'default' so every existing packet keeps its current behavior.
-- custom_identity is a ProfessionalContact-shaped JSON blob authored on the
-- packet. It is seeded once and lives on the packet; it never syncs back to the
-- account profile (no second source of truth). At publish time the resolved
-- identity is frozen into professional_snapshot, so the recipient render path
-- stays a single source.

alter table public.packets
  add column if not exists identity_mode text not null default 'default'
    check (identity_mode in ('default', 'none', 'custom'));

alter table public.packets
  add column if not exists custom_identity jsonb;
