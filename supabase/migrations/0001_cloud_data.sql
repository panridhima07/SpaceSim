-- Astra cloud data layer: per-user designs, uploaded rocket files, remembered import
-- corrections, simulation runs and the research-consent flag that gates data collection.
-- Postgres 17 / Supabase. Safe to run twice: tables, policies, triggers and the bucket are
-- all guarded so a second run changes nothing.
--
-- Every table has Row Level Security on and only an authenticated user's own rows are
-- reachable. Anonymous visitors have no access at all. The `training_corrections` view is
-- for the team (service role) only.

-- ---------------------------------------------------------------- tables

create table if not exists public.profiles (
  user_id uuid primary key references auth.users on delete cascade,
  research_consent boolean not null default false,
  consent_version int not null default 0,
  consented_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists public.designs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  name text not null,
  design jsonb not null,
  thumbnail text,
  source_file_sha256 text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint designs_design_size check (pg_column_size(design) < 2000000),
  constraint designs_thumbnail_size check (thumbnail is null or char_length(thumbnail) < 400000)
);
create index if not exists designs_user_updated_idx on public.designs (user_id, updated_at desc);

create table if not exists public.rocket_files (
  user_id uuid not null references auth.users on delete cascade,
  sha256 text not null,
  filename text,
  size_bytes int,
  format text,
  storage_path text,
  created_at timestamptz default now(),
  primary key (user_id, sha256),
  constraint rocket_files_size check (size_bytes between 1 and 20000000),
  constraint rocket_files_format check (format in ('ork', 'rocksim', 'sfb-json'))
);

create table if not exists public.import_corrections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  file_sha256 text not null,
  filename text,
  parsed_model jsonb not null,
  corrected_design jsonb not null,
  changes jsonb not null default '[]',
  note text not null default '',
  share_for_training boolean not null default false,
  importer_version text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, file_sha256),
  constraint import_corrections_parsed_size check (pg_column_size(parsed_model) < 2000000),
  constraint import_corrections_corrected_size check (pg_column_size(corrected_design) < 2000000),
  constraint import_corrections_note_len check (char_length(note) <= 2000)
);

create table if not exists public.sim_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  design_id uuid references public.designs on delete set null,
  kind text,
  config jsonb,
  summary jsonb,
  duration_ms int,
  ran_on text,
  created_at timestamptz default now(),
  constraint sim_runs_kind check (kind in ('flight', 'stress')),
  constraint sim_runs_ran_on check (ran_on in ('server', 'browser'))
);
create index if not exists sim_runs_user_created_idx on public.sim_runs (user_id, created_at desc);

-- ---------------------------------------------------------------- updated_at trigger

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists designs_set_updated_at on public.designs;
create trigger designs_set_updated_at before update on public.designs
  for each row execute function public.set_updated_at();

drop trigger if exists import_corrections_set_updated_at on public.import_corrections;
create trigger import_corrections_set_updated_at before update on public.import_corrections
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- row level security

alter table public.profiles enable row level security;
alter table public.designs enable row level security;
alter table public.rocket_files enable row level security;
alter table public.import_corrections enable row level security;
alter table public.sim_runs enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['profiles', 'designs', 'rocket_files', 'import_corrections', 'sim_runs'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('create policy %I on public.%I for select to authenticated using (user_id = auth.uid())', t || '_select_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (user_id = auth.uid())', t || '_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format('create policy %I on public.%I for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t || '_update_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);
    execute format('create policy %I on public.%I for delete to authenticated using (user_id = auth.uid())', t || '_delete_own', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------- storage

insert into storage.buckets (id, name, public, file_size_limit)
values ('rocket-files', 'rocket-files', false, 20000000)
on conflict (id) do nothing;

drop policy if exists rocket_files_obj_select_own on storage.objects;
create policy rocket_files_obj_select_own on storage.objects for select to authenticated
  using (bucket_id = 'rocket-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists rocket_files_obj_insert_own on storage.objects;
create policy rocket_files_obj_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'rocket-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists rocket_files_obj_update_own on storage.objects;
create policy rocket_files_obj_update_own on storage.objects for update to authenticated
  using (bucket_id = 'rocket-files' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'rocket-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists rocket_files_obj_delete_own on storage.objects;
create policy rocket_files_obj_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'rocket-files' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------- training export

-- Plain view owned by postgres (bypasses RLS on purpose). Exposes no user id, only a
-- stable anonymised contributor hash. Reachable with the service role only.
create or replace view public.training_corrections as
select
  md5(c.user_id::text) as contributor,
  c.file_sha256,
  c.filename,
  c.parsed_model,
  c.corrected_design,
  c.changes,
  c.note,
  c.importer_version,
  c.created_at,
  c.updated_at,
  f.storage_path,
  f.format
from public.import_corrections c
left join public.rocket_files f on f.user_id = c.user_id and f.sha256 = c.file_sha256
where c.share_for_training = true;

revoke all on public.training_corrections from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Base privileges. This project does not grant table access by default, so without
-- these every request is refused before row level security is even consulted.
-- Signed-in users may touch the tables (the policies above limit them to their own
-- rows); anonymous visitors get nothing; the service role (team exports) gets all.
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on public.profiles, public.designs, public.rocket_files, public.import_corrections, public.sim_runs to authenticated;
grant all on public.profiles, public.designs, public.rocket_files, public.import_corrections, public.sim_runs to service_role;
grant select on public.training_corrections to service_role;
