-- Caps so one free account cannot fill the database: per-row size limits on the JSON columns
-- that had none, and a per-user row count on the tables a client can insert into freely.
-- Plus small hardening found in review: own-folder storage paths, a missing FK index and
-- function search_path / EXECUTE grants.
-- Postgres 17 / Supabase. Safe to run twice. Constraints are added NOT VALID, so rows that
-- already exist are left alone and only new or updated rows are checked.
--
-- Not covered here (Supabase dashboard): CAPTCHA and email confirmation on sign-up. Without
-- them many free accounts can still add up; per-account caps only bound each one.

-- ---------------------------------------------------------------- size limits

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'sim_runs_config_size' and conrelid = 'public.sim_runs'::regclass) then
    alter table public.sim_runs add constraint sim_runs_config_size
      check (config is null or pg_column_size(config) < 100000) not valid;
  end if;
  if not exists (select 1 from pg_constraint
                 where conname = 'sim_runs_summary_size' and conrelid = 'public.sim_runs'::regclass) then
    alter table public.sim_runs add constraint sim_runs_summary_size
      check (summary is null or pg_column_size(summary) < 100000) not valid;
  end if;
  if not exists (select 1 from pg_constraint
                 where conname = 'import_corrections_changes_size' and conrelid = 'public.import_corrections'::regclass) then
    alter table public.import_corrections add constraint import_corrections_changes_size
      check (pg_column_size(changes) < 500000) not valid;
  end if;
  -- storage_path is client-supplied: it must point inside the user's own folder, as the
  -- storage policies require for the object itself.
  if not exists (select 1 from pg_constraint
                 where conname = 'rocket_files_path_own' and conrelid = 'public.rocket_files'::regclass) then
    alter table public.rocket_files add constraint rocket_files_path_own
      check (storage_path is null or (storage_path like user_id::text || '/%' and storage_path not like '%..%')) not valid;
  end if;
end
$$;

-- ---------------------------------------------------------------- row counts per user

-- Runs as the inserting user (RLS lets them see exactly their own rows, which is what is
-- counted). Limits: 200 designs, 2000 sim runs, 200 import corrections, 200 rocket files.
-- An upsert also fires BEFORE INSERT; re-saving a row that already exists (same key) is
-- let through so it can still be updated at the cap.
create or replace function public.enforce_user_row_cap()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  cap int := tg_argv[0]::int;
  n int;
begin
  if tg_table_name = 'import_corrections' and exists (
       select 1 from public.import_corrections
        where user_id = new.user_id and file_sha256 = new.file_sha256) then
    return new;
  end if;
  if tg_table_name = 'rocket_files' and exists (
       select 1 from public.rocket_files
        where user_id = new.user_id and sha256 = new.sha256) then
    return new;
  end if;
  execute format('select count(*) from %I.%I where user_id = $1', tg_table_schema, tg_table_name)
    into n
    using new.user_id;
  if n >= cap then
    raise exception 'Storage limit reached: at most % rows in %', cap, tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

revoke all on function public.enforce_user_row_cap() from public, anon, authenticated;

drop trigger if exists designs_row_cap on public.designs;
create trigger designs_row_cap before insert on public.designs
  for each row execute function public.enforce_user_row_cap('200');

drop trigger if exists sim_runs_row_cap on public.sim_runs;
create trigger sim_runs_row_cap before insert on public.sim_runs
  for each row execute function public.enforce_user_row_cap('2000');

drop trigger if exists import_corrections_row_cap on public.import_corrections;
create trigger import_corrections_row_cap before insert on public.import_corrections
  for each row execute function public.enforce_user_row_cap('200');

drop trigger if exists rocket_files_row_cap on public.rocket_files;
create trigger rocket_files_row_cap before insert on public.rocket_files
  for each row execute function public.enforce_user_row_cap('200');

-- ---------------------------------------------------------------- small hardening

-- Deleting a design sets sim_runs.design_id to null; without an index that is a full scan.
create index if not exists sim_runs_design_idx on public.sim_runs (design_id) where design_id is not null;

-- Supabase advisor: function_search_path_mutable. Trigger functions need no EXECUTE grant.
alter function public.set_updated_at() set search_path = '';
revoke all on function public.set_updated_at() from public, anon, authenticated;
