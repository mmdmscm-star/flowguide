-- 0029 - A BUCKET FOR CREATOR-UPLOADED PHOTOS.
--
-- NO TABLE CHANGES, and `item_photos.storage_path` stays '' - it is written by
-- update_item_content (0011), the single atomic writer shared by both editors,
-- and teaching that RPC to carry a path is a large change to a mature write
-- path for a small feature. A creator-uploaded photo is recognised by its URL
-- living under this bucket instead; see src/lib/creator-media.ts.
--
-- PUBLIC READ, on purpose. A recipient opens /p/[slug] anonymously, often weeks
-- after it was sent. A signed URL expires and turns a durable share link into a
-- broken image, which is the opposite of what the link promises. Privacy comes
-- from the path being unguessable, not from the bucket being private:
-- object names carry 32 bytes of crypto-random entropy and never the original
-- filename, the user id or the packet id.
--
-- WRITES ARE SERVICE-ROLE ONLY. There is no client-side upload path and no
-- policy granting insert/update/delete to anon or authenticated. Every object
-- is written by a server route that has already checked the session owns the
-- packet.

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'packet-photos', 'packet-photos', true,
  10485760,                                   -- 10 MB
  -- No image/svg+xml: an SVG is a script container, and this bucket is
  -- public-read on the same origin pattern the recipient page loads from.
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Read is public; nothing else is granted to anon or authenticated. Writes
-- happen only through the service role, which bypasses RLS by design.
drop policy if exists "packet photos are publicly readable" on storage.objects;
create policy "packet photos are publicly readable"
  on storage.objects for select
  using (bucket_id = 'packet-photos');

commit;
