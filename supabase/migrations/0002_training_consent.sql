-- Training export follows each contributor's current research consent.
--
-- 0001 exported every correction marked share_for_training. When a user withdraws consent the
-- client clears that flag on their rows (src/cloud/session.ts), but that request can fail
-- silently or never run (withdrawn on another device), and the rows would stay exported. The
-- view now also requires the owner's profile to say research_consent = true, so withdrawal
-- takes effect in the database itself.
--
-- security_invoker: the view runs with the caller's rights. The service role (team exports)
-- bypasses row level security and keeps seeing every consenting row; anyone else would only
-- ever see their own rows, even if a grant were added by mistake later.
--
-- Safe to run twice.

create or replace view public.training_corrections
with (security_invoker = true) as
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
join public.profiles p on p.user_id = c.user_id and p.research_consent = true
left join public.rocket_files f on f.user_id = c.user_id and f.sha256 = c.file_sha256
where c.share_for_training = true;

revoke all on public.training_corrections from anon, authenticated;
grant select on public.training_corrections to service_role;

-- Signed-in users reach the tables only through the REST API, which needs select, insert,
-- update and delete (granted in 0001). Make sure no wider default grant (truncate ignores row
-- level security) is left on them.
revoke truncate, references, trigger on public.profiles, public.designs, public.rocket_files,
  public.import_corrections, public.sim_runs from anon, authenticated;
