-- 009_facebook_media_type.sql
-- Adds configurable media selection for Facebook (default to photo, optional video)

drop function if exists public.submit_content_project(uuid, uuid, timestamptz, text, text[]);
drop function if exists public.submit_content_project_checked(uuid, uuid, timestamptz, text, timestamptz, text[]);

create or replace function public.submit_content_project(
  p_project_id uuid,
  p_submission_key uuid,
  p_scheduled_at timestamptz default null,
  p_execution_mode text default 'simulation',
  p_platforms text[] default array['facebook', 'youtube', 'tiktok', 'x']::text[],
  p_facebook_media_type text default 'photo'
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.content_projects;
  old public.posts;
  d_fb public.facebook_destinations;
  d_yt public.youtube_destinations;
  d_tt public.tiktok_destinations;
  d_x public.x_destinations;
  v_id uuid;
  v_snapshot jsonb;
  plat text;
  v_platforms text[];
  v_fb_media text;
begin
  if auth.uid() is null or not exists (select 1 from public.app_owners where user_id = auth.uid()) then
    raise exception 'Access denied';
  end if;
  if p_submission_key is null then raise exception 'Submission key required'; end if;
  if p_execution_mode is null or p_execution_mode not in ('simulation','live') then raise exception 'Invalid execution mode'; end if;
  
  v_platforms := coalesce(p_platforms, array['facebook', 'youtube', 'tiktok', 'x']::text[]);
  if array_length(v_platforms, 1) is null or array_length(v_platforms, 1) = 0 then
    raise exception 'At least one platform required';
  end if;

  v_fb_media := coalesce(p_facebook_media_type, 'photo');
  if v_fb_media not in ('photo', 'video') then
    v_fb_media := 'photo';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || p_submission_key::text, 0));
  select * into old from public.posts where owner_id = auth.uid() and submission_key = p_submission_key;
  if found then
    if old.project_id is distinct from p_project_id or old.request_schedule is distinct from p_scheduled_at
      or old.execution_mode is distinct from p_execution_mode then raise exception 'Submission key conflict'; end if;
    return old.id;
  end if;

  select * into p from public.content_projects where id = p_project_id for update;
  if not found then raise exception 'Project not found or access denied'; end if;
  if not public.is_workspace_member(p.workspace_id) or not exists (
    select 1 from public.workspace_members where workspace_id = p.workspace_id and user_id = auth.uid() and role in ('owner','editor')
  ) then raise exception 'Workspace access denied'; end if;

  -- Validate destinations for selected platforms
  foreach plat in array v_platforms loop
    if plat = 'facebook' then
      select * into d_fb from public.facebook_destinations where workspace_id = p.workspace_id for share;
      if not found or not d_fb.enabled then raise exception 'Facebook destination not enabled'; end if;
      if p_execution_mode = 'live' and not d_fb.live_enabled then raise exception 'Facebook live publishing not enabled'; end if;
    elsif plat = 'youtube' then
      select * into d_yt from public.youtube_destinations where workspace_id = p.workspace_id for share;
      if not found or not d_yt.enabled then raise exception 'YouTube destination not enabled'; end if;
      if p_execution_mode = 'live' and not d_yt.live_enabled then raise exception 'YouTube live publishing not enabled'; end if;
    elsif plat = 'tiktok' then
      select * into d_tt from public.tiktok_destinations where workspace_id = p.workspace_id for share;
      if not found or not d_tt.enabled then raise exception 'TikTok destination not enabled'; end if;
      if p_execution_mode = 'live' and not d_tt.live_enabled then raise exception 'TikTok live publishing not enabled'; end if;
    elsif plat = 'x' then
      select * into d_x from public.x_destinations where workspace_id = p.workspace_id for share;
      if not found or not d_x.enabled then raise exception 'X destination not enabled'; end if;
      if p_execution_mode = 'live' and not d_x.live_enabled then raise exception 'X live publishing not enabled'; end if;
    end if;
  end loop;

  perform m.id from public.media m join public.content_project_media a on a.media_id = m.id
    where a.project_id = p.id order by m.id for share of m;
  if exists (select 1 from public.content_project_media a join public.media m on m.id = a.media_id
    where a.project_id = p.id and (m.owner_id <> auth.uid() or m.status <> 'ready')) then
    raise exception 'Media must be ready and owned';
  end if;

  v_snapshot := jsonb_build_object(
    'schema_version', 1,
    'project_id', p.id,
    'workspace_id', p.workspace_id,
    'project_updated_at', p.updated_at,
    'title', p.title,
    'description', p.description,
    'hashtags', p.hashtags,
    'price', p.price,
    'execution_mode', p_execution_mode,
    'platforms', v_platforms,
    'facebook_media_type', v_fb_media,
    'destination', jsonb_build_object('platform', 'facebook', 'page_id', coalesce(d_fb.page_id, '1182106911641987'), 'page_name', d_fb.page_name),
    'destinations', jsonb_build_object(
      'facebook', jsonb_build_object('page_id', d_fb.page_id, 'page_name', d_fb.page_name),
      'youtube', jsonb_build_object('channel_id', d_yt.channel_id, 'channel_title', d_yt.channel_title),
      'tiktok', jsonb_build_object('creator_username', d_tt.creator_username),
      'x', jsonb_build_object('screen_name', d_x.screen_name)
    ),
    'assets', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', m.id, 'object_path', m.object_path,
        'mime_type', m.mime_type, 'size_bytes', m.size_bytes,
        'role', a.role, 'position', a.position
      ) order by a.role, a.position, m.id), '[]'::jsonb)
      from public.content_project_media a join public.media m on m.id = a.media_id
      where a.project_id = p.id
    )
  );

  insert into public.posts(
    owner_id, title, description, hashtags, scheduled_at,
    project_id, submission_key, request_schedule, execution_mode, content_snapshot
  ) values (
    auth.uid(), p.title, p.description, p.hashtags, coalesce(p_scheduled_at, now()),
    p.id, p_submission_key, p_scheduled_at, p_execution_mode, v_snapshot
  ) returning id into v_id;

  insert into public.post_media select distinct v_id, media_id from public.content_project_media where project_id = p.id;

  foreach plat in array v_platforms loop
    insert into public.post_targets(post_id, platform) values (v_id, plat);
  end loop;

  return v_id;
end;
$$;

-- Overload for 5 arguments (backwards compatibility)
create or replace function public.submit_content_project(
  p_project_id uuid,
  p_submission_key uuid,
  p_scheduled_at timestamptz default null,
  p_execution_mode text default 'simulation',
  p_platforms text[] default array['facebook', 'youtube', 'tiktok', 'x']::text[]
) returns uuid language sql security definer as $$
  select public.submit_content_project(p_project_id, p_submission_key, p_scheduled_at, p_execution_mode, p_platforms, 'photo');
$$;

-- submit_content_project_checked with p_facebook_media_type
create or replace function public.submit_content_project_checked(
  p_project_id uuid,
  p_submission_key uuid,
  p_scheduled_at timestamptz default null,
  p_execution_mode text default 'simulation',
  p_expected_updated_at timestamptz default null,
  p_platforms text[] default array['facebook', 'youtube', 'tiktok', 'x']::text[],
  p_facebook_media_type text default 'photo'
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  curr_updated_at timestamptz;
begin
  if auth.uid() is null or not exists (select 1 from public.app_owners where user_id = auth.uid()) then
    raise exception 'Access denied';
  end if;
  if p_expected_updated_at is null then
    return public.submit_content_project(p_project_id, p_submission_key, p_scheduled_at, p_execution_mode, p_platforms, p_facebook_media_type);
  end if;

  select updated_at into curr_updated_at from public.content_projects where id = p_project_id;
  if not found then raise exception 'Project not found or access denied'; end if;
  if curr_updated_at is distinct from p_expected_updated_at then
    raise exception 'Project changed';
  end if;

  return public.submit_content_project(p_project_id, p_submission_key, p_scheduled_at, p_execution_mode, p_platforms, p_facebook_media_type);
end;
$$;

-- Overload for 6 arguments (backwards compatibility)
create or replace function public.submit_content_project_checked(
  p_project_id uuid,
  p_submission_key uuid,
  p_scheduled_at timestamptz default null,
  p_execution_mode text default 'simulation',
  p_expected_updated_at timestamptz default null,
  p_platforms text[] default array['facebook', 'youtube', 'tiktok', 'x']::text[]
) returns uuid language sql security definer as $$
  select public.submit_content_project_checked(p_project_id, p_submission_key, p_scheduled_at, p_execution_mode, p_expected_updated_at, p_platforms, 'photo');
$$;

revoke all on function public.submit_content_project(uuid,uuid,timestamptz,text,text[],text) from public,anon;
grant execute on function public.submit_content_project(uuid,uuid,timestamptz,text,text[],text) to authenticated;
revoke all on function public.submit_content_project_checked(uuid,uuid,timestamptz,text,timestamptz,text[],text) from public,anon;
grant execute on function public.submit_content_project_checked(uuid,uuid,timestamptz,text,timestamptz,text[],text) to authenticated;
