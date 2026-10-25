-- 002: invite links, backup codes, and sign-in tracking (spec section 4).
--
-- A link is '<app>#k=<key>&c=<code>'. Only fingerprints (SHA-256) of the key
-- and code are stored. The redeem-invite server function swaps a key or code
-- for a sign-in: each device that uses a link gets its own Supabase account,
-- mapped to the person through private.person_accounts.

alter table private.invites
  add column code_hash text not null unique,
  add column turned_off_at timestamptz;

alter table private.person_accounts
  add column device text,                                  -- 'iPhone', 'Android', ... from the browser
  add column last_seen_at timestamptz not null default now(); -- claimed_at = when the link was used

-- Wrong backup codes, for rate limiting (codes are short; keys are not).
create table private.code_failures (at timestamptz not null default now());
alter table private.code_failures enable row level security;

-- ---------- helpers ----------

create function private.fingerprint(secret text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(secret, 'sha256'), 'hex')
$$;

-- Random text from an alphabet whose length divides 256 (so no bias).
create function private.random_text(len integer, alphabet text) returns text
language plpgsql volatile set search_path = '' as $$
declare
  bytes bytea := extensions.gen_random_bytes(len);
  result text := '';
begin
  for i in 0 .. len - 1 loop
    result := result || substr(alphabet, get_byte(bytes, i) % length(alphabet) + 1, 1);
  end loop;
  return result;
end
$$;

-- Backup codes are typed by hand: ignore case, spaces and dashes.
create function private.normalize_code(code text) returns text
language sql immutable set search_path = '' as $$
  select upper(regexp_replace(coalesce(code, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

-- Makes a new link for a person and turns off their old one, which signs out
-- every device that used it. Returns the key and code; they are never stored.
create function private.issue_invite(p_person uuid) returns table (key text, code text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  new_key text := private.random_text(43, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_');
  new_code text := private.random_text(10, '23456789ABCDEFGHJKLMNPQRSTUVWXYZ');
begin
  if not exists (select 1 from public.people p where p.id = p_person and p.active) then
    raise exception 'That person isn''t in the jar.';
  end if;
  update private.invites set active = false, turned_off_at = now()
  where person_id = p_person and active;
  insert into private.invites (person_id, token_hash, code_hash)
  values (p_person, private.fingerprint(new_key), private.fingerprint(new_code));
  return query select new_key, substr(new_code, 1, 5) || '-' || substr(new_code, 6, 5);
end
$$;

-- One-time setup, run by the owner in the SQL editor: creates the admin and
-- returns their link. Refuses if there is already an admin.
create function private.setup_admin(p_name text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  admin_id uuid;
  link record;
begin
  if exists (select 1 from public.people where role = 'admin' and active) then
    raise exception 'There is already an admin.';
  end if;
  insert into public.people (name, role) values (p_name, 'admin') returning id into admin_id;
  select * into link from private.issue_invite(admin_id);
  return 'https://cjmerc39.github.io/moms-jar/#k=' || link.key || '&c=' || link.code;
end
$$;

-- ---------- for the app ----------

-- Who the signed-in device is, or no row if it has no access.
create function public.whoami() returns table (id uuid, name text, role text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.name, p.role from public.people p where p.id = private.my_person_id()
$$;

-- Called when the app opens, for the admin's "last active".
create function public.touch_me() returns void
language sql volatile security definer set search_path = '' as $$
  update private.person_accounts set last_seen_at = now()
  where user_id = auth.uid() and last_seen_at < now() - interval '5 minutes'
$$;

-- ---------- for the admin ----------

create function private.require_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if private.my_role() is distinct from 'admin' then
    raise exception 'Only the admin can do that.';
  end if;
end
$$;

-- Everyone, with link status and sign-in activity for their current link.
create function public.admin_people() returns table (
  id uuid, name text, role text, active boolean,
  link_on boolean, link_made_at timestamptz,
  devices integer, device_kinds text[],
  link_last_used timestamptz, last_active timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return query
    select p.id, p.name, p.role, p.active,
      i.id is not null, i.created_at,
      count(a.user_id)::integer,
      coalesce(array_agg(distinct a.device) filter (where a.device is not null), '{}'),
      max(a.claimed_at), max(a.last_seen_at)
    from public.people p
    left join private.invites i on i.person_id = p.id and i.active
    left join private.person_accounts a on a.invite_id = i.id
    group by p.id, i.id
    order by p.active desc, p.role = 'mom' desc, p.created_at;
end
$$;

create function public.admin_make_link(p_person uuid) returns table (key text, code text)
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return query select * from private.issue_invite(p_person);
end
$$;

create function public.admin_turn_off_link(p_person uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_admin();
  update private.invites set active = false, turned_off_at = now()
  where person_id = p_person and active;
end
$$;

-- Removes a person: their link stops working; their waiting slips stay in the bank.
create function public.admin_remove_person(p_person uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_admin();
  if p_person = private.my_person_id() then
    raise exception 'You can''t remove yourself.';
  end if;
  update public.people set active = false where id = p_person;
  update private.invites set active = false, turned_off_at = now()
  where person_id = p_person and active;
end
$$;

-- ---------- for the redeem-invite server function only ----------

-- Checks a key or a backup code. Returns the person and invite, or no row.
-- Wrong codes are counted; after 20 in an hour, codes stop working for an hour.
create function public.redeem_invite(p_key text, p_code text)
returns table (person_id uuid, invite_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare
  found_person uuid;
  found_invite uuid;
begin
  delete from private.code_failures where at < now() - interval '1 day';

  if coalesce(p_key, '') <> '' then
    select i.person_id, i.id into found_person, found_invite
    from private.invites i join public.people p on p.id = i.person_id
    where i.token_hash = private.fingerprint(p_key) and i.active and p.active;
  elsif coalesce(p_code, '') <> '' then
    if (select count(*) from private.code_failures where at > now() - interval '1 hour') >= 20 then
      raise exception 'Too many tries. Wait an hour, then try again.';
    end if;
    select i.person_id, i.id into found_person, found_invite
    from private.invites i join public.people p on p.id = i.person_id
    where i.code_hash = private.fingerprint(private.normalize_code(p_code)) and i.active and p.active;
    if found_invite is null then
      insert into private.code_failures default values;
    end if;
  end if;

  if found_invite is not null then
    return query select found_person, found_invite;
  end if;
end
$$;

-- Records a new device for a person, after the server function made its account.
create function public.link_device(p_user uuid, p_person uuid, p_invite uuid, p_device text)
returns void
language sql volatile security definer set search_path = '' as $$
  insert into private.person_accounts (user_id, person_id, invite_id, device)
  values (p_user, p_person, p_invite, left(p_device, 20))
$$;

-- ---------- function permissions ----------
-- Supabase grants new public functions to everyone by default, so be explicit.

revoke execute on all functions in schema private from public;
grant execute on function private.my_person_id(), private.my_role(), private.today(),
  private.valid_time_zone(text), private.pinned_date_taken(date, uuid) to authenticated;

revoke execute on function public.whoami(), public.touch_me(), public.admin_people(),
  public.admin_make_link(uuid), public.admin_turn_off_link(uuid), public.admin_remove_person(uuid),
  public.redeem_invite(text, text), public.link_device(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.whoami(), public.touch_me(), public.admin_people(),
  public.admin_make_link(uuid), public.admin_turn_off_link(uuid), public.admin_remove_person(uuid)
  to authenticated;
grant execute on function public.redeem_invite(text, text), public.link_device(uuid, uuid, uuid, text)
  to service_role;

notify pgrst, 'reload schema';
