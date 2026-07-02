-- Add an optional, editable footer/advisor label to professional_profiles.
-- Defaults to 'Your Advisor' so existing profiles keep their current behavior.
-- A blank value hides the eyebrow label entirely. Profile-level (shared across
-- packets), snapshotted at publish.

alter table public.professional_profiles
  add column if not exists footer_label text not null default 'Your Advisor';
