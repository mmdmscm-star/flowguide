-- Add an optional professional headshot (image URL) to professional_profiles.
-- Mirrors logo_url: stored on the profile, snapshotted at publish, rendered in
-- the advisor footer. Additive and safe — existing rows default to '', so no
-- profile or published packet changes until a professional adds a headshot.

alter table public.professional_profiles
  add column if not exists headshot_url text not null default '';
