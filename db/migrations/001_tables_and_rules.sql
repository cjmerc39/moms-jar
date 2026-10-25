-- 001: tables and access rules (spec sections 5 and 6).
--
-- The privacy tests apply this file to moms-jar-test from scratch on every run.
-- The same file is pasted once into the real moms-jar project's SQL editor.
--
-- Who is who: a signed-in Supabase account maps to a person through
-- private.person_accounts, created when someone opens their invite link
-- (step 4). An account with no mapping, a turned-off invite, or a removed
-- person gets nothing from any rule below.

-- ---------- private schema (not reachable through the API) ----------

create schema private;
revoke all on schema private from public;
grant usage on schema private to authenticated; -- so access rules can call the helpers

-- ---------- people ----------

create table public.people (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  role text not null check (role in ('mom', 'contributor', 'admin')),
  active boolean not null default true, -- false = removed by admin
  created_at timestamptz not null default now()
);
create unique index people_one_mom on public.people (role) where role = 'mom' and active;

-- Invite links. Only a hash of each link's secret is stored.
create table private.invites (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.people (id) on delete cascade,
  token_hash text not null unique,
  active boolean not null default true, -- false = turned off by admin
  created_at timestamptz not null default now()
);

-- Which signed-in account is which person, and through which invite.
create table private.person_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  person_id uuid not null references public.people (id) on delete cascade,
  invite_id uuid not null references private.invites (id) on delete cascade,
  claimed_at timestamptz not null default now()
);

-- The current person, or null. Checks the person is active and their invite is on.
create function private.my_person_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.id
  from private.person_accounts a
  join public.people p on p.id = a.person_id
  join private.invites i on i.id = a.invite_id
  where a.user_id = auth.uid() and p.active and i.active
$$;

create function private.my_role() returns text
language sql stable security definer set search_path = '' as $$
  select p.role from public.people p where p.id = private.my_person_id()
$$;

-- ---------- settings ----------

create function private.valid_time_zone(tz text) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from pg_catalog.pg_timezone_names where name = tz)
$$;

create table public.settings (
  id integer primary key default 1 check (id = 1),
  start_date date,
  time_zone text not null default 'America/New_York' check (private.valid_time_zone(time_zone))
);
insert into public.settings (id) values (1);

-- Today in Mom's time zone. Never derived from UTC.
create function private.today() returns date
language sql stable security definer set search_path = '' as $$
  select (now() at time zone s.time_zone)::date from public.settings s where s.id = 1
$$;

-- ---------- prompts ----------

create table public.prompts (
  id uuid primary key default gen_random_uuid(),
  text text not null unique check (length(trim(text)) > 0),
  created_by uuid references public.people (id) on delete set null default private.my_person_id(),
  created_at timestamptz not null default now()
);

-- ---------- slips ----------

create table public.slips (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.people (id) default private.my_person_id(),
  prompt text not null check (length(trim(prompt)) > 0),
  answer text not null check (length(trim(answer)) > 0),
  from_name text not null check (length(trim(from_name)) > 0),
  photo_path text,
  pinned_date date unique,  -- one slip per pinned date
  private boolean not null default false,
  created_at timestamptz not null default now(),
  released_on date unique,  -- a day can never get two slips
  hidden boolean not null default false -- admin hid it after release
);

-- True if another slip (anyone's, private or not) holds this pinned date.
create function private.pinned_date_taken(d date, except_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.slips where pinned_date = d and id <> except_id)
$$;

-- Checks on changes made from the app. The release job and admin functions
-- run as the table owner, not as 'authenticated', and skip these.
create function private.slips_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  start date;
begin
  if current_user <> 'authenticated' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.author_id is distinct from private.my_person_id() then
      raise exception 'You can only add your own slips.';
    end if;
    if new.released_on is not null or new.hidden then
      raise exception 'A new slip starts out waiting.';
    end if;
    new.created_at := now();
  else
    if new.author_id is distinct from old.author_id
      or new.created_at is distinct from old.created_at
      or new.released_on is distinct from old.released_on
      or new.hidden is distinct from old.hidden then
      raise exception 'That part of a slip can''t be changed.';
    end if;
  end if;

  if new.pinned_date is not null
    and (tg_op = 'INSERT' or new.pinned_date is distinct from old.pinned_date) then
    if new.pinned_date <= private.today() then
      raise exception 'Pick a date after today.';
    end if;
    select s.start_date into start from public.settings s where s.id = 1;
    if start is not null and new.pinned_date < start then
      raise exception 'Pick a date on or after the start date.';
    end if;
    if private.pinned_date_taken(new.pinned_date, new.id) then
      raise exception 'That date is already taken.';
    end if;
  end if;

  return new;
end
$$;

create trigger slips_guard before insert or update on public.slips
for each row execute function private.slips_guard();

-- ---------- Mom's stars and read flags ----------

create table public.mom_marks (
  slip_id uuid primary key references public.slips (id) on delete cascade,
  starred boolean not null default false,
  read_at timestamptz
);

-- ---------- access rules ----------

alter table public.people enable row level security;
alter table public.settings enable row level security;
alter table public.prompts enable row level security;
alter table public.slips enable row level security;
alter table public.mom_marks enable row level security;
alter table private.invites enable row level security;
alter table private.person_accounts enable row level security;

-- Nothing here is for visitors who aren't signed in.
revoke all on public.people, public.settings, public.prompts, public.slips, public.mom_marks from anon;

-- people: everyone in the family can see names; only admin adds or changes people.
create policy "family reads people" on public.people for select to authenticated
  using ((select private.my_person_id()) is not null);
create policy "admin adds people" on public.people for insert to authenticated
  with check ((select private.my_role()) = 'admin');
create policy "admin changes people" on public.people for update to authenticated
  using ((select private.my_role()) = 'admin')
  with check ((select private.my_role()) = 'admin');

-- settings: everyone in the family reads; admin changes.
create policy "family reads settings" on public.settings for select to authenticated
  using ((select private.my_person_id()) is not null);
create policy "admin changes settings" on public.settings for update to authenticated
  using ((select private.my_role()) = 'admin')
  with check ((select private.my_role()) = 'admin');

-- prompts: contributors read and add; admin removes. Mom has no use for them.
create policy "contributors read prompts" on public.prompts for select to authenticated
  using ((select private.my_role()) in ('contributor', 'admin'));
create policy "contributors add prompts" on public.prompts for insert to authenticated
  with check ((select private.my_role()) in ('contributor', 'admin'));
create policy "admin removes prompts" on public.prompts for delete to authenticated
  using ((select private.my_role()) = 'admin');

-- slips: contributors see everything that isn't private, plus their own
-- private slips. Admin gets no extra access.
create policy "contributors read slips" on public.slips for select to authenticated
  using (
    (select private.my_role()) in ('contributor', 'admin')
    and (not private or author_id = (select private.my_person_id()))
  );
-- Mom sees released slips only, private or not, unless hidden.
create policy "mom reads released slips" on public.slips for select to authenticated
  using (
    (select private.my_role()) = 'mom'
    and released_on is not null
    and released_on <= (select private.today())
    and not hidden
  );
create policy "contributors add their own slips" on public.slips for insert to authenticated
  with check (
    (select private.my_role()) in ('contributor', 'admin')
    and author_id = (select private.my_person_id())
  );
-- Authors edit and delete their own slips until released; then locked for everyone.
create policy "authors edit waiting slips" on public.slips for update to authenticated
  using (
    (select private.my_role()) in ('contributor', 'admin')
    and author_id = (select private.my_person_id())
    and released_on is null
  )
  with check (author_id = (select private.my_person_id()) and released_on is null);
create policy "authors delete waiting slips" on public.slips for delete to authenticated
  using (
    (select private.my_role()) in ('contributor', 'admin')
    and author_id = (select private.my_person_id())
    and released_on is null
  );

-- mom_marks: Mom only, and only on slips she can see. Contributors never see these.
create policy "mom manages her marks" on public.mom_marks for all to authenticated
  using ((select private.my_role()) = 'mom' and exists (select 1 from public.slips s where s.id = slip_id))
  with check ((select private.my_role()) = 'mom' and exists (select 1 from public.slips s where s.id = slip_id));

-- private.invites and private.person_accounts have no policies: only the
-- database owner and (in step 4) owner-run functions can touch them.

-- ---------- bank summary ----------

-- How many slips are waiting and which dates are pinned, counting everyone's
-- private slips, without revealing any content. Contributors only.
create function public.bank_summary() returns table (waiting integer, pinned_dates date[])
language sql stable security definer set search_path = '' as $$
  select
    count(*)::integer,
    coalesce(array_agg(s.pinned_date order by s.pinned_date) filter (where s.pinned_date is not null), '{}')
  from public.slips s
  where s.released_on is null
    and private.my_role() in ('contributor', 'admin')
$$;

-- ---------- function permissions ----------

revoke execute on all functions in schema private from public;
grant execute on function private.my_person_id(), private.my_role(), private.today(),
  private.valid_time_zone(text), private.pinned_date_taken(date, uuid) to authenticated;
revoke execute on function public.bank_summary() from public, anon;
grant execute on function public.bank_summary() to authenticated;

-- ---------- photos ----------

-- Private bucket: no public web addresses. Photos are stored as
-- '<slip id>/<file name>' and follow their slip's access rules.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 2097152, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 2097152, allowed_mime_types = array['image/jpeg'];

-- The slips subquery runs under the viewer's own slip rules, so a photo is
-- visible exactly when its slip is.
create policy "moms-jar: see photos of visible slips" on storage.objects for select to authenticated
  using (
    bucket_id = 'photos'
    and exists (select 1 from public.slips s where s.id::text = (storage.foldername(name))[1])
  );
create policy "moms-jar: authors add photos to waiting slips" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'photos'
    and exists (
      select 1 from public.slips s
      where s.id::text = (storage.foldername(name))[1]
        and s.author_id = (select private.my_person_id())
        and s.released_on is null
    )
  );
create policy "moms-jar: authors replace photos on waiting slips" on storage.objects for update to authenticated
  using (
    bucket_id = 'photos'
    and exists (
      select 1 from public.slips s
      where s.id::text = (storage.foldername(name))[1]
        and s.author_id = (select private.my_person_id())
        and s.released_on is null
    )
  );
create policy "moms-jar: authors remove photos from waiting slips" on storage.objects for delete to authenticated
  using (
    bucket_id = 'photos'
    and exists (
      select 1 from public.slips s
      where s.id::text = (storage.foldername(name))[1]
        and s.author_id = (select private.my_person_id())
        and s.released_on is null
    )
  );

notify pgrst, 'reload schema';
