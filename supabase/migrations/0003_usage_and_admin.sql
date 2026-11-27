-- Anonymous usage counts and the admin dashboard's read function.
-- Postgres 17 / Supabase. Safe to run twice.
--
-- What is stored: one row per device, UTC day, platform and event, with a counter. The device
-- is a random id made on the device (src/cloud/usage.ts). No IP, email, user id or rocket data.
--
-- Who can do what:
--   anyone (anon key)      -> public.log_usage(...) only. It cannot read anything.
--   signed-in users        -> the same, plus public.admin_stats(), which refuses unless the
--                             caller is listed in public.admins.
--   nobody through the API -> the three tables below (no grants, no policies).

-- ---------------------------------------------------------------- tables

create table if not exists public.usage_daily (
  day date not null,
  install_id uuid not null,
  platform text not null,
  event text not null,
  app_version text not null default '',
  native_version text not null default '',
  signed_in boolean not null default false,
  count int not null default 1,
  primary key (day, install_id, platform, event),
  constraint usage_daily_platform check (platform in ('web', 'android')),
  constraint usage_daily_event check (event in ('open', 'flight', 'mission', 'import')),
  constraint usage_daily_count check (count between 1 and 1000),
  constraint usage_daily_versions check (char_length(app_version) <= 24 and char_length(native_version) <= 24)
);

-- How many devices were counted for the first time on a day. log_usage stops adding new
-- devices at 5,000 a day, so made-up ids cannot fill the database.
create table if not exists public.usage_day_devices (
  day date primary key,
  new_devices int not null default 0
);

-- Accounts allowed to read the statistics. Rows are added by hand in the SQL editor.
create table if not exists public.admins (
  user_id uuid primary key references auth.users on delete cascade,
  added_at timestamptz not null default now()
);

alter table public.usage_daily enable row level security;
alter table public.usage_day_devices enable row level security;
alter table public.admins enable row level security;

-- No policies on purpose: with row level security on, that means no access for API roles.
-- The revokes make it explicit even if a default grant exists.
revoke all on public.usage_daily, public.usage_day_devices, public.admins from public, anon, authenticated;
grant all on public.usage_daily, public.usage_day_devices, public.admins to service_role;

-- ---------------------------------------------------------------- log_usage

-- Counts one event. Called by everyone, signed in or not. Bad input is dropped silently
-- (the client ignores the result anyway). security definer: runs as the owner, because
-- callers have no access to the tables; search_path is empty and every name is qualified.
create or replace function public.log_usage(
  p_install_id uuid,
  p_platform text,
  p_event text,
  p_app_version text default '',
  p_native_version text default ''
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_app text := coalesce(p_app_version, '');
  v_native text := coalesce(p_native_version, '');
  -- From the caller's session, never from an argument.
  v_signed_in boolean := auth.uid() is not null;
  v_counted int;
begin
  if p_install_id is null
     or p_platform is null or p_platform not in ('web', 'android')
     or p_event is null or p_event not in ('open', 'flight', 'mission', 'import') then
    return;
  end if;
  if v_app !~ '^[0-9A-Za-z.+-]{0,24}$' then v_app := ''; end if;
  if v_native !~ '^[0-9A-Za-z.+-]{0,24}$' or p_platform = 'web' then v_native := ''; end if;

  -- The usual case: this device already has this row today.
  update public.usage_daily u
     set count = least(u.count + 1, 1000),
         app_version = v_app,
         native_version = v_native,
         signed_in = u.signed_in or v_signed_in
   where u.day = v_day and u.install_id = p_install_id and u.platform = p_platform and u.event = p_event;
  if found then
    return;
  end if;

  -- A device not seen yet today uses one of the day's 5,000 places. Over the limit the
  -- conditional update matches nothing, v_counted stays null and the event is dropped.
  if not exists (select 1 from public.usage_daily u where u.day = v_day and u.install_id = p_install_id) then
    insert into public.usage_day_devices as d (day, new_devices)
    values (v_day, 1)
    on conflict (day) do update set new_devices = d.new_devices + 1 where d.new_devices < 5000
    returning d.new_devices into v_counted;
    if v_counted is null then
      return;
    end if;
    -- First device of a new day: drop rows older than 400 days.
    if v_counted = 1 then
      delete from public.usage_daily u where u.day < v_day - 400;
      delete from public.usage_day_devices d where d.day < v_day - 400;
    end if;
  end if;

  insert into public.usage_daily as u (day, install_id, platform, event, app_version, native_version, signed_in, count)
  values (v_day, p_install_id, p_platform, p_event, v_app, v_native, v_signed_in, 1)
  on conflict (day, install_id, platform, event)
  do update set count = least(u.count + 1, 1000);
end;
$$;

-- ---------------------------------------------------------------- admin_stats

-- Totals and daily series for the dashboard. Raises unless the caller is in public.admins.
-- Returns no install ids, user ids or emails.
create or replace function public.admin_stats(p_days int default 30) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_days int := least(greatest(coalesce(p_days, 30), 1), 366);
  v_from date := (now() at time zone 'utc')::date - (v_days - 1);
begin
  if v_uid is null or not exists (select 1 from public.admins a where a.user_id = v_uid) then
    raise exception 'not an admin' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'days', v_days,
    'from', to_char(v_from, 'YYYY-MM-DD'),
    'daily', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.day, d.platform)
      from (
        select to_char(u.day, 'YYYY-MM-DD') as day,
               u.platform,
               coalesce(sum(u.count) filter (where u.event = 'open'), 0)::int as opens,
               count(distinct u.install_id)::int as devices,
               (count(distinct u.install_id) filter (where u.signed_in))::int as signed_in_devices,
               coalesce(sum(u.count) filter (where u.event = 'flight'), 0)::int as flights,
               coalesce(sum(u.count) filter (where u.event = 'mission'), 0)::int as missions,
               coalesce(sum(u.count) filter (where u.event = 'import'), 0)::int as imports
        from public.usage_daily u
        where u.day >= v_from
        group by u.day, u.platform
      ) d
    ), '[]'::jsonb),
    'devices', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.platform)
      from (
        select u.platform,
               count(distinct u.install_id)::int as devices,
               (count(distinct u.install_id) filter (where u.signed_in))::int as signed_in_devices
        from public.usage_daily u
        where u.day >= v_from
        group by u.platform
      ) t
    ), '[]'::jsonb),
    'versions', coalesce((
      select jsonb_agg(to_jsonb(v) order by v.platform, v.devices desc)
      from (
        select u.platform,
               case when u.platform = 'android' then u.native_version else u.app_version end as version,
               count(distinct u.install_id)::int as devices
        from public.usage_daily u
        where u.day >= v_from
        group by 1, 2
      ) v
    ), '[]'::jsonb),
    'totals', jsonb_build_object(
      'accounts', (select count(*) from auth.users),
      'designs', (select count(*) from public.designs),
      'uploads', (select count(*) from public.rocket_files),
      'sim_runs', coalesce((
        select jsonb_agg(to_jsonb(s) order by s.kind, s.ran_on)
        from (
          select coalesce(r.kind, '') as kind, coalesce(r.ran_on, '') as ran_on, count(*)::int as count
          from public.sim_runs r
          group by 1, 2
        ) s
      ), '[]'::jsonb)
    )
  );
end;
$$;

-- ---------------------------------------------------------------- privileges

-- 0001 gave schema usage to signed-in users only; guests need it to reach log_usage.
-- It exposes nothing else: every table is revoked from anon and has row level security.
grant usage on schema public to anon, authenticated;

-- Functions are executable by everyone by default. Take that away, then grant exactly.
revoke all on function public.log_usage(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.log_usage(uuid, text, text, text, text) to anon, authenticated, service_role;

revoke all on function public.admin_stats(int) from public, anon, authenticated;
grant execute on function public.admin_stats(int) to authenticated, service_role;

-- After running this file, add yourself as an admin (once):
--   insert into public.admins (user_id)
--   select id from auth.users where email = '<your sign-in email>'
--   on conflict do nothing;
