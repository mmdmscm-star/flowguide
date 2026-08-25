-- 0032 - RESTORE THE GRANT 0031 DROPPED ON THE FLOOR.
--
-- SECURITY FIX. 0031 replaced create_organize_run to add p_delimiter_hint:
--
--     drop function if exists public.create_organize_run(uuid, text, text, text,
--                                                        text, integer, text, text, jsonb);
--     CREATE OR REPLACE FUNCTION public.create_organize_run(..., p_delimiter_hint text DEFAULT NULL)
--
-- 0012 had revoked that function from public, anon and authenticated and granted
-- it to service_role alone. Those grants were attached to the NINE-argument
-- signature. Dropping it discarded them, and the ten-argument function created
-- in its place is a NEW function — which PostgreSQL grants EXECUTE to PUBLIC by
-- default. 0031 never re-applied the revoke.
--
-- The function is SECURITY DEFINER, so executing it runs as the owner and
-- bypasses RLS. The anon key ships in every browser. Measured against
-- production before writing this: anon reached the function BODY and was
-- stopped only by a foreign key on packets.user_id — not by any authorization
-- control. Its untouched siblings answered "permission denied for function"
-- in the same breath, which is what correct looks like.
--
-- Nothing about the function's behaviour changes here. This restores exactly
-- the access 0012 established, against the signature that now exists.

begin;

revoke all on function public.create_organize_run(uuid, text, text, text, text, integer, text, text, jsonb, text)
  from public, anon, authenticated, service_role;

grant execute on function public.create_organize_run(uuid, text, text, text, text, integer, text, text, jsonb, text)
  to service_role;

commit;
