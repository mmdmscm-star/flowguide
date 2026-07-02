-- Add optional professional links (label + URL pairs) to professional_profiles.
-- Additive and safe: existing rows default to an empty array, so no profile or
-- published packet changes until a professional adds a link.
--
-- Each element is { "label": string, "url": string }.

alter table public.professional_profiles
  add column if not exists links jsonb not null default '[]'::jsonb;
