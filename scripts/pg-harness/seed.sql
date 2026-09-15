-- The smallest data set the migrations' own proofs need (0049 probes a real
-- packet). Applied right after schema.sql, so every later migration sees rows
-- the way it does in production. Invented values only.
insert into public.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'harness-owner@example.com');
insert into public.professional_profiles (user_id, name, email, phone) values
  ('00000000-0000-4000-8000-000000000001', 'Harness Owner', 'harness-owner@example.com', '555-0100');
insert into public.packets (id, user_id, slug, title, status) values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'harness-seed-packet', 'Harness seed', 'draft');
insert into public.sections (id, packet_id, title, sort_order) values
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'Seed section', 0);
insert into public.items (id, section_id, title, sort_order) values
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000b1', 'Seed item', 0);
