-- 0033 - HIGHLIGHT FOR CLIENT: a recipient-facing note, beside the private one.
--
-- `items.notes` is the professional's PRIVATE note. It was made invisible to
-- recipients on 2026-08-20 (8bcb0ab) because the UI promised "Only you see
-- this" while the packet showed it to the client. That decision stands. This
-- migration does not touch `notes`, does not copy it, and does not change who
-- can see it.
--
-- What was missing is the OTHER thing a professional wants to write: something
-- personal they specifically want the client to notice — "I checked and they
-- heat their pool to 82 degrees, because you asked." There was no field for it,
-- so the private note was the only place to put it, and putting it there meant
-- the client never saw it.
--
-- NEW COLUMN, NOT A REUSE. Two audiences need two fields. Overloading one field
-- with a visibility flag would mean every renderer has to get the flag right,
-- and getting it wrong once is a privacy incident. A separate column is
-- recipient-visible by its own nature, and `notes` stays private by its own.
--
-- Nullable with no default and NO BACKFILL: every existing item starts with an
-- empty highlight. Copying existing notes across would publish, to clients,
-- text written under the opposite promise.
--
-- NOT ADDED TO library_items, deliberately. A highlight is written for ONE
-- client ("because you asked"). Library items are reused across clients, so
-- carrying a highlight into the Library would leak one family's personalisation
-- into another's FlowGuide. Saving an item back to the Library drops the
-- highlight, which is the correct loss.

begin;

alter table items add column highlight text;

comment on column items.highlight is
  'Recipient-facing highlighted callout, authored by the professional for this client. Distinct from items.notes, which is private to the professional and never rendered to a recipient.';

-- update_item_content gains p_highlight. Adding a DEFAULTed parameter instead
-- would leave both the 12- and 13-argument functions resolvable and the call
-- ambiguous, so the old signature is dropped first.
--
-- AND THE GRANTS ARE RE-APPLIED BELOW. Dropping a function discards its grants,
-- and the replacement is created with EXECUTE granted to PUBLIC by default.
-- 0031 changed this same kind of signature, did not re-grant, and left a
-- SECURITY DEFINER function callable by anon for a day (fixed in 0032). The
-- revoke/grant at the end of this file is not boilerplate; it is the fix for
-- that class of mistake, applied in advance.
drop function if exists public.update_item_content(uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb);

create or replace function public.update_item_content(
  p_item_id uuid,
  p_owner_id uuid,
  p_packet_id uuid,
  p_require_mode text,
  p_title text,
  p_description text,
  p_notes text,
  p_highlight text,
  p_address text,
  p_details jsonb,
  p_links jsonb,
  p_photos jsonb,
  p_contacts jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_packet_id uuid;
  v_user uuid;
  v_status text;
  v_mode text;
  r jsonb;
  i int;
begin
  -- Resolve the item's packet (item -> section -> packet).
  select s.packet_id into v_packet_id
    from public.items it
    join public.sections s on s.id = it.section_id
    where it.id = p_item_id;
  if v_packet_id is null then raise exception 'item content: item % not found', p_item_id; end if;

  -- Optional cross-check: the item must belong to the packet the caller named.
  if p_packet_id is not null and v_packet_id <> p_packet_id then
    raise exception 'item content: item % does not belong to packet %', p_item_id, p_packet_id;
  end if;

  -- Lock the packet row and read owner/status/mode.
  select user_id, status, composition_mode into v_user, v_status, v_mode
    from public.packets where id = v_packet_id for update;
  if v_user is null then raise exception 'item content: packet % not found', v_packet_id; end if;
  if v_user <> p_owner_id then raise exception 'item content: caller does not own packet %', v_packet_id; end if;
  if v_status <> 'draft' then raise exception 'item content: packet % is not draft (status=%)', v_packet_id, v_status; end if;
  if p_require_mode is not null and v_mode <> p_require_mode then
    raise exception 'item content: packet % is not in % mode (mode=%)', v_packet_id, p_require_mode, v_mode;
  end if;

  -- Core content fields (never section_id / sort_order). NULL = leave unchanged.
  update public.items
    set title = coalesce(p_title, title),
        description = coalesce(p_description, description),
        notes = coalesce(p_notes, notes),
        highlight = coalesce(p_highlight, highlight),
        address = coalesce(p_address, address)
    where id = p_item_id;

  -- Replace details when provided.
  if p_details is not null then
    if jsonb_typeof(p_details) <> 'array' then raise exception 'item content: details must be a JSON array'; end if;
    delete from public.item_details where item_id = p_item_id;
    i := 0;
    for r in select value from jsonb_array_elements(p_details) loop
      insert into public.item_details (item_id, label, value, sort_order)
        values (p_item_id, coalesce(r->>'label', ''), coalesce(r->>'value', ''), i);
      i := i + 1;
    end loop;
  end if;

  -- Replace links when provided.
  if p_links is not null then
    if jsonb_typeof(p_links) <> 'array' then raise exception 'item content: links must be a JSON array'; end if;
    delete from public.item_links where item_id = p_item_id;
    i := 0;
    for r in select value from jsonb_array_elements(p_links) loop
      insert into public.item_links (item_id, url, label, sort_order)
        values (p_item_id, coalesce(r->>'url', ''), coalesce(r->>'label', ''), i);
      i := i + 1;
    end loop;
  end if;

  -- Replace photos when provided (only http(s) URLs are stored, mirroring the app).
  if p_photos is not null then
    if jsonb_typeof(p_photos) <> 'array' then raise exception 'item content: photos must be a JSON array'; end if;
    delete from public.item_photos where item_id = p_item_id;
    i := 0;
    for r in select value from jsonb_array_elements(p_photos) loop
      if coalesce(r->>'url', '') like 'http%' then
        insert into public.item_photos (item_id, url, storage_path, sort_order)
          values (p_item_id, r->>'url', '', i);
        i := i + 1;
      end if;
    end loop;
  end if;

  -- Replace contacts when provided (ordered; blank rows dropped; malformed -> rollback).
  if p_contacts is not null then
    if jsonb_typeof(p_contacts) <> 'array' then raise exception 'item content: contacts must be a JSON array'; end if;
    delete from public.item_contacts where item_id = p_item_id;
    i := 0;
    for r in select value from jsonb_array_elements(p_contacts) loop
      if coalesce(r->>'name', '') <> ''
         or coalesce(r->>'phone', '') <> ''
         or coalesce(r->>'email', '') <> ''
         or coalesce(r->>'website', '') <> '' then
        insert into public.item_contacts (item_id, name, role, phone, email, website, sort_order)
          values (
            p_item_id,
            coalesce(r->>'name', ''),
            coalesce(r->>'role', ''),
            coalesce(r->>'phone', ''),
            coalesce(r->>'email', ''),
            coalesce(r->>'website', ''),
            i
          );
        i := i + 1;
      end if;
    end loop;
  end if;
end;
$$;

revoke all on function public.update_item_content(uuid, uuid, uuid, text, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.update_item_content(uuid, uuid, uuid, text, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb)
  to service_role;

commit;
