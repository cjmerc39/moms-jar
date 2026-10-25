-- Removes everything the migrations create, so the privacy tests can rebuild
-- moms-jar-test from scratch. NEVER run this against the real project; the
-- test setup refuses to connect anywhere but moms-jar-test.

drop policy if exists "moms-jar: see photos of visible slips" on storage.objects;
drop policy if exists "moms-jar: authors add photos to waiting slips" on storage.objects;
drop policy if exists "moms-jar: authors replace photos on waiting slips" on storage.objects;
drop policy if exists "moms-jar: authors remove photos from waiting slips" on storage.objects;

drop table if exists public.mom_marks, public.slips, public.prompts, public.settings, public.people cascade;
drop function if exists public.bank_summary();
drop function if exists public.whoami(), public.touch_me(), public.admin_people(),
  public.admin_make_link(uuid), public.admin_turn_off_link(uuid), public.admin_remove_person(uuid),
  public.redeem_invite(text, text), public.link_device(uuid, uuid, uuid, text);
drop schema if exists private cascade;
