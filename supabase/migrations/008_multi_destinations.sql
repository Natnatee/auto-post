begin;

-- 1. YouTube destination per workspace
create table if not exists public.youtube_destinations (
  workspace_id uuid primary key references public.workspaces(id),
  channel_id text not null,
  channel_title text,
  enabled boolean not null default true,
  live_enabled boolean not null default false
);
alter table public.youtube_destinations enable row level security;
revoke all on public.youtube_destinations from public, anon, authenticated;
grant select on public.youtube_destinations to authenticated;
grant all on public.youtube_destinations to service_role;
drop policy if exists youtube_destinations_read on public.youtube_destinations;
create policy youtube_destinations_read on public.youtube_destinations for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- 2. TikTok destination per workspace
create table if not exists public.tiktok_destinations (
  workspace_id uuid primary key references public.workspaces(id),
  creator_username text,
  enabled boolean not null default true,
  live_enabled boolean not null default false
);
alter table public.tiktok_destinations enable row level security;
revoke all on public.tiktok_destinations from public, anon, authenticated;
grant select on public.tiktok_destinations to authenticated;
grant all on public.tiktok_destinations to service_role;
drop policy if exists tiktok_destinations_read on public.tiktok_destinations;
create policy tiktok_destinations_read on public.tiktok_destinations for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- 3. X (Twitter) destination per workspace
create table if not exists public.x_destinations (
  workspace_id uuid primary key references public.workspaces(id),
  screen_name text not null default 'elephant_maker',
  enabled boolean not null default true,
  live_enabled boolean not null default false
);
alter table public.x_destinations enable row level security;
revoke all on public.x_destinations from public, anon, authenticated;
grant select on public.x_destinations to authenticated;
grant all on public.x_destinations to service_role;
drop policy if exists x_destinations_read on public.x_destinations;
create policy x_destinations_read on public.x_destinations for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- 4. Seed destinations for existing active workspaces
insert into public.youtube_destinations(workspace_id, channel_id, channel_title, enabled, live_enabled)
select id, 'UC_oeXyIBxtatQC8RABp9ffw', 'Elephant-Maker (@mondmaker)', true, true
from public.workspaces
on conflict (workspace_id) do update set channel_id = excluded.channel_id, channel_title = excluded.channel_title, enabled = true, live_enabled = true;

insert into public.tiktok_destinations(workspace_id, creator_username, enabled, live_enabled)
select id, 'AutoPost Studio', true, true
from public.workspaces
on conflict (workspace_id) do update set creator_username = excluded.creator_username, enabled = true, live_enabled = true;

insert into public.x_destinations(workspace_id, screen_name, enabled, live_enabled)
select id, 'elephant_maker', true, true
from public.workspaces
on conflict (workspace_id) do update set screen_name = excluded.screen_name, enabled = true, live_enabled = true;

-- 5. Multi-platform submit_content_project
create or replace function public.submit_content_project(
  p_project_id uuid,
  p_submission_key uuid,
  p_scheduled_at timestamptz default null,
  p_execution_mode text default 'simulation',
  p_platforms text[] default array['facebook', 'youtube', 'tiktok', 'x']::text[]
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
end $$;

-- 6. submit_content_project 4-arg overload for backwards compatibility
create or replace function public.submit_content_project(
  p_project_id uuid, p_submission_key uuid, p_scheduled_at timestamptz default null,
  p_execution_mode text default 'simulation'
) returns uuid language sql security definer set search_path = public, pg_temp as $$
  select public.submit_content_project(p_project_id, p_submission_key, p_scheduled_at, p_execution_mode, array['facebook', 'youtube', 'tiktok', 'x']::text[]);
$$;

-- 7. submit_content_project_checked with p_platforms
create or replace function public.submit_content_project_checked(
  p_project_id uuid,
  p_submission_key uuid,
  p_scheduled_at timestamptz,
  p_execution_mode text,
  p_expected_updated_at timestamptz,
  p_platforms text[] default array['facebook', 'youtube', 'tiktok', 'x']::text[]
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.content_projects; old public.posts;
begin
  if auth.uid() is null or not exists (select 1 from public.app_owners where user_id=auth.uid()) then
    raise exception 'Access denied';
  end if;
  if p_submission_key is null then raise exception 'Submission key required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || p_submission_key::text, 0));
  select * into old from public.posts where owner_id=auth.uid() and submission_key=p_submission_key;
  if found then
    return public.submit_content_project(p_project_id, p_submission_key, p_scheduled_at, p_execution_mode, p_platforms);
  end if;
  select * into p from public.content_projects where id=p_project_id for update;
  if not found or not public.is_workspace_member(p.workspace_id) then raise exception 'Project access denied'; end if;
  if p_expected_updated_at is null or abs(extract(epoch from (p.updated_at - p_expected_updated_at))) > 0.01 then
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
  return public.submit_content_project(p_project_id, p_submission_key, p_scheduled_at, p_execution_mode, p_platforms);
end $$;

-- 8. submit_content_project_checked 5-arg overload for backwards compatibility
create or replace function public.submit_content_project_checked(
  p_project_id uuid, p_submission_key uuid, p_scheduled_at timestamptz,
  p_execution_mode text, p_expected_updated_at timestamptz
) returns uuid language sql security definer set search_path = public, pg_temp as $$
  select public.submit_content_project_checked(p_project_id, p_submission_key, p_scheduled_at, p_execution_mode, p_expected_updated_at, array['facebook', 'youtube', 'tiktok', 'x']::text[]);
$$;

-- 9. begin_target_dispatch supporting all platforms
create or replace function public.begin_target_dispatch(p_target_id uuid, p_lease_token uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.posts; t public.post_targets;
begin
  select p0.* into p from public.posts p0 join public.post_targets t0 on t0.post_id = p0.id
    where t0.id = p_target_id for update of p0;
  if not found then return false; end if;
  select * into t from public.post_targets where id = p_target_id for update;
  if t.status <> 'processing' or t.lease_token is distinct from p_lease_token or t.lease_expires_at is null
    or t.lease_expires_at <= now() or t.dispatch_started_at is not null or t.delivery_uncertain
    or t.platform not in ('facebook', 'youtube', 'tiktok', 'x') or p.execution_mode <> 'live'
    or (p.content_snapshot->>'execution_mode') is distinct from 'live' then return false; end if;

  if t.platform = 'facebook' then
    perform 1 from public.facebook_destinations d where d.workspace_id::text = p.content_snapshot->>'workspace_id'
      and d.enabled and d.live_enabled
      and exists (select 1 from public.content_projects c where c.id = p.project_id and c.workspace_id = d.workspace_id)
      for share of d;
    if not found then return false; end if;
  elsif t.platform = 'youtube' then
    perform 1 from public.youtube_destinations d where d.workspace_id::text = p.content_snapshot->>'workspace_id'
      and d.enabled and d.live_enabled
      and exists (select 1 from public.content_projects c where c.id = p.project_id and c.workspace_id = d.workspace_id)
      for share of d;
    if not found then return false; end if;
  elsif t.platform = 'tiktok' then
    perform 1 from public.tiktok_destinations d where d.workspace_id::text = p.content_snapshot->>'workspace_id'
      and d.enabled and d.live_enabled
      and exists (select 1 from public.content_projects c where c.id = p.project_id and c.workspace_id = d.workspace_id)
      for share of d;
    if not found then return false; end if;
  elsif t.platform = 'x' then
    perform 1 from public.x_destinations d where d.workspace_id::text = p.content_snapshot->>'workspace_id'
      and d.enabled and d.live_enabled
      and exists (select 1 from public.content_projects c where c.id = p.project_id and c.workspace_id = d.workspace_id)
      for share of d;
    if not found then return false; end if;
  end if;

  update public.post_targets set dispatch_started_at = clock_timestamp() where id = t.id;
  return true;
end $$;

commit;
