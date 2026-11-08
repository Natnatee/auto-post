begin;

-- Lock the same request identity as the original RPC before the project row.
-- Replays return their immutable job even if the project has since changed.
create function public.submit_content_project_checked(
  p_project_id uuid, p_submission_key uuid, p_scheduled_at timestamptz,
  p_execution_mode text, p_expected_updated_at timestamptz
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.content_projects; old public.posts;
begin
  if auth.uid() is null or not exists (select 1 from public.app_owners where user_id=auth.uid()) then
    raise exception 'Access denied';
  end if;
  if p_submission_key is null then raise exception 'Submission key required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || p_submission_key::text,0));
  select * into old from public.posts where owner_id=auth.uid() and submission_key=p_submission_key;
  if found then
    return public.submit_content_project(p_project_id,p_submission_key,p_scheduled_at,p_execution_mode);
  end if;
  select * into p from public.content_projects where id=p_project_id for update;
  if not found or not public.is_workspace_member(p.workspace_id) then raise exception 'Project access denied'; end if;
  if p_expected_updated_at is null or p.updated_at is distinct from p_expected_updated_at then
    raise exception 'Project changed';
  end if;
  if p_execution_mode='live' then
    if exists (select 1 from public.posts j join public.post_targets t on t.post_id=j.id
      where j.project_id=p.id and j.execution_mode='live' and t.delivery_uncertain) then
      raise exception 'Delivery reconciliation required';
    end if;
    if exists (select 1 from public.posts j join public.post_targets t on t.post_id=j.id
      where j.project_id=p.id and j.execution_mode='live' and t.status in ('pending','processing')) then
      raise exception 'Publication already active';
    end if;
  end if;
  return public.submit_content_project(p_project_id,p_submission_key,p_scheduled_at,p_execution_mode);
end $$;
revoke all on function public.submit_content_project_checked(uuid,uuid,timestamptz,text,timestamptz) from public,anon;
grant execute on function public.submit_content_project_checked(uuid,uuid,timestamptz,text,timestamptz) to authenticated;

commit;
