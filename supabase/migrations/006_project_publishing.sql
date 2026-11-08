begin;

create table public.facebook_destinations (
  workspace_id uuid primary key references public.workspaces(id),
  page_id text not null check (page_id ~ '^[0-9]+$'),
  page_name text,
  enabled boolean not null default true,
  live_enabled boolean not null default false
);
alter table public.facebook_destinations enable row level security;
revoke all on public.facebook_destinations from public, anon, authenticated;
grant select on public.facebook_destinations to authenticated;
grant all on public.facebook_destinations to service_role;
create policy facebook_destinations_read on public.facebook_destinations for select to authenticated
  using (public.is_workspace_member(workspace_id));

alter table public.posts
  add column project_id uuid references public.content_projects(id),
  add column submission_key uuid,
  add column request_schedule timestamptz,
  add column execution_mode text not null default 'simulation' check (execution_mode in ('simulation','live')),
  add column content_snapshot jsonb,
  add unique (owner_id,submission_key);
alter table public.post_targets
  add column dispatch_started_at timestamptz,
  add column external_post_id text,
  add column delivery_uncertain boolean not null default false;

drop policy targets_insert on public.post_targets;
create policy targets_insert on public.post_targets for insert to authenticated with check (
  status = 'pending' and attempts = 0 and error is null and published_url is null
  and lease_token is null and lease_expires_at is null and dispatch_started_at is null
  and external_post_id is null and not delivery_uncertain
  and exists (select 1 from public.posts where id = post_id and owner_id = auth.uid()
    and status = 'queued' and content_snapshot is null)
);

create function public.submit_content_project(
  p_project_id uuid, p_submission_key uuid, p_scheduled_at timestamptz default null,
  p_execution_mode text default 'simulation'
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.content_projects; old public.posts; d public.facebook_destinations; v_id uuid; v_snapshot jsonb;
begin
  if auth.uid() is null or not exists (select 1 from public.app_owners where user_id = auth.uid()) then
    raise exception 'Access denied';
  end if;
  if p_submission_key is null then raise exception 'Submission key required'; end if;
  if p_execution_mode is null or p_execution_mode not in ('simulation','live') then raise exception 'Invalid execution mode'; end if;
  -- Serialize the request identity before taking any project lock, including conflicting projects.
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || p_submission_key::text,0));
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
  select * into d from public.facebook_destinations where workspace_id = p.workspace_id for share;
  if not found or not d.enabled then raise exception 'Facebook destination not enabled'; end if;
  if p_execution_mode = 'live' and not d.live_enabled then raise exception 'Facebook live publishing not enabled'; end if;
  perform m.id from public.media m join public.content_project_media a on a.media_id = m.id
    where a.project_id = p.id order by m.id for share of m;
  if exists (select 1 from public.content_project_media a join public.media m on m.id = a.media_id
    where a.project_id = p.id and (m.owner_id <> auth.uid() or m.status <> 'ready')) then
    raise exception 'Media must be ready and owned';
  end if;
  v_snapshot := jsonb_build_object('schema_version',1,'project_id',p.id,'workspace_id',p.workspace_id,
    'project_updated_at',p.updated_at,'title',p.title,'description',p.description,'hashtags',p.hashtags,
    'price',p.price,'execution_mode',p_execution_mode,
    'destination',jsonb_build_object('platform','facebook','page_id',d.page_id,'page_name',d.page_name),
    'assets',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'object_path',m.object_path,
      'mime_type',m.mime_type,'size_bytes',m.size_bytes,'role',a.role,'position',a.position)
      order by a.role,a.position,m.id),'[]'::jsonb)
      from public.content_project_media a join public.media m on m.id = a.media_id where a.project_id = p.id));
  insert into public.posts(owner_id,title,description,hashtags,scheduled_at,project_id,submission_key,request_schedule,execution_mode,content_snapshot)
    values(auth.uid(),p.title,p.description,p.hashtags,coalesce(p_scheduled_at,now()),p.id,p_submission_key,p_scheduled_at,p_execution_mode,v_snapshot)
    returning id into v_id;
  insert into public.post_media select distinct v_id,media_id from public.content_project_media where project_id = p.id;
  insert into public.post_targets(post_id,platform) values(v_id,'facebook');
  return v_id;
end $$;

create or replace function public.claim_target(p_lease_seconds int default 300) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.post_targets; p public.posts; v_token uuid;
begin
  if p_lease_seconds is null or p_lease_seconds not between 10 and 3600 then raise exception 'Lease must be 10..3600 seconds'; end if;
  loop
    select p0.* into p from public.posts p0 where p0.scheduled_at <= now() and exists (
      select 1 from public.post_targets t0 where t0.post_id = p0.id and
      (t0.status = 'pending' or (t0.status = 'processing' and coalesce(t0.lease_expires_at,'-infinity'::timestamptz) <= now()))
    ) order by p0.scheduled_at,p0.id for update skip locked limit 1;
    if not found then return null; end if;
    select * into t from public.post_targets where post_id = p.id and
      (status = 'pending' or (status = 'processing' and coalesce(lease_expires_at,'-infinity'::timestamptz) <= now()))
      order by created_at,id for update skip locked limit 1;
    if not found then continue; end if;
    if t.dispatch_started_at is not null or t.delivery_uncertain then
      update public.post_targets set status = 'blocked',delivery_uncertain = true,
        error = 'Delivery uncertain; reconciliation required',lease_token = null,lease_expires_at = null where id = t.id;
      perform public.refresh_post_status(p.id);
      continue;
    end if;
    if t.attempts >= 3 then
      update public.post_targets set status = 'failed',error = 'Maximum attempts exhausted',lease_token = null,lease_expires_at = null where id = t.id;
      perform public.refresh_post_status(p.id);
      continue;
    end if;
    v_token := gen_random_uuid();
    update public.post_targets set status = 'processing',attempts = attempts + 1,error = null,
      lease_token = v_token,lease_expires_at = now() + make_interval(secs => p_lease_seconds) where id = t.id;
    update public.posts set status = 'processing' where id = p.id;
    return jsonb_build_object('id',t.id,'post_id',p.id,'platform',t.platform,'lease_token',v_token,
      'title',p.title,'description',p.description,'hashtags',p.hashtags,'scheduled_at',p.scheduled_at,'attempts',t.attempts + 1,
      'content_snapshot',p.content_snapshot,'execution_mode',p.execution_mode,
      'dispatch_started_at',t.dispatch_started_at,'external_post_id',t.external_post_id,'delivery_uncertain',t.delivery_uncertain,
      'media',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'object_path',m.object_path,
        'mime_type',m.mime_type,'size_bytes',m.size_bytes) order by m.id),'[]'::jsonb)
        from public.post_media pm join public.media m on m.id = pm.media_id where pm.post_id = p.id));
  end loop;
end $$;

create function public.begin_target_dispatch(p_target_id uuid,p_lease_token uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.posts; t public.post_targets;
begin
  select p0.* into p from public.posts p0 join public.post_targets t0 on t0.post_id = p0.id
    where t0.id = p_target_id for update of p0;
  if not found then return false; end if;
  select * into t from public.post_targets where id = p_target_id for update;
  if t.status <> 'processing' or t.lease_token is distinct from p_lease_token or t.lease_expires_at is null
    or t.lease_expires_at <= now() or t.dispatch_started_at is not null or t.delivery_uncertain
    or t.platform <> 'facebook' or p.execution_mode <> 'live'
    or (p.content_snapshot->>'execution_mode') is distinct from 'live'
    or (p.content_snapshot->'destination'->>'platform') is distinct from 'facebook' then return false; end if;
  perform 1 from public.facebook_destinations d where d.workspace_id::text = p.content_snapshot->>'workspace_id'
    and d.page_id = p.content_snapshot->'destination'->>'page_id' and d.enabled and d.live_enabled
    and exists (select 1 from public.content_projects c where c.id = p.project_id and c.workspace_id = d.workspace_id)
    for share of d;
  if not found then return false; end if;
  update public.post_targets set dispatch_started_at = clock_timestamp() where id = t.id;
  return true;
end $$;

drop function public.finish_target(uuid,uuid,text,text,text);
create function public.finish_target(p_target_id uuid,p_lease_token uuid,p_status text,
  p_error text default null,p_published_url text default null,p_external_post_id text default null,
  p_delivery_uncertain boolean default false) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.posts; t public.post_targets;
begin
  if p_status is null or p_status not in ('simulated','published','failed','blocked') then raise exception 'Invalid finish status'; end if;
  select p0.* into p from public.posts p0 join public.post_targets t0 on t0.post_id = p0.id
    where t0.id = p_target_id for update of p0;
  if not found then return false; end if;
  select * into t from public.post_targets where id = p_target_id for update;
  if t.status <> 'processing' or t.lease_token is distinct from p_lease_token
    or t.lease_expires_at is null or t.lease_expires_at <= now() then return false; end if;
  if p.content_snapshot is not null then
    if p_status = 'published' and (p.execution_mode <> 'live'
      or (p.content_snapshot->>'execution_mode') is distinct from 'live' or t.dispatch_started_at is null
      or coalesce(btrim(p_external_post_id),'') = '' or coalesce(p_published_url,'') !~ '^https://[^/[:space:]]+[^[:space:]]*$'
      or coalesce(p_delivery_uncertain,false)) then raise exception 'Invalid published result'; end if;
    if p_status = 'simulated' and (p.execution_mode <> 'simulation'
      or (p.content_snapshot->>'execution_mode') is distinct from 'simulation') then raise exception 'Invalid simulated result'; end if;
  end if;
  if coalesce(p_delivery_uncertain,false) and p_status <> 'blocked' then raise exception 'Uncertain delivery must be blocked'; end if;
  update public.post_targets set status = p_status,error = left(p_error,2000),
    published_url = case when p_status = 'published' then p_published_url else null end,
    external_post_id = p_external_post_id,
    delivery_uncertain = coalesce(p_delivery_uncertain,false),
    dispatch_started_at = case when p_status = 'failed' and not coalesce(p_delivery_uncertain,false) then null else dispatch_started_at end,
    lease_token = null,lease_expires_at = null where id = t.id;
  perform public.refresh_post_status(p.id);
  return true;
end $$;

create or replace function public.retry_target(p_target_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_post uuid; t public.post_targets;
begin
  select p.id into v_post from public.posts p join public.post_targets t0 on t0.post_id = p.id
    where t0.id = p_target_id and p.owner_id = auth.uid()
    and exists (select 1 from public.app_owners where user_id = auth.uid()) for update of p;
  if not found then raise exception 'Target not found or access denied'; end if;
  select * into t from public.post_targets where id = p_target_id for update;
  if t.status not in ('failed','blocked') then raise exception 'Only failed or blocked targets can be retried'; end if;
  if t.delivery_uncertain or t.dispatch_started_at is not null or t.external_post_id is not null then
    raise exception 'Delivery reconciliation required';
  end if;
  update public.post_targets set status = 'pending',attempts = 0,error = null,published_url = null,
    lease_token = null,lease_expires_at = null where id = t.id;
  update public.posts set status = 'queued' where id = v_post;
end $$;

revoke all on function public.submit_content_project(uuid,uuid,timestamptz,text),
  public.claim_target(int),public.begin_target_dispatch(uuid,uuid),
  public.finish_target(uuid,uuid,text,text,text,text,boolean),public.retry_target(uuid) from public,anon,authenticated;
grant execute on function public.submit_content_project(uuid,uuid,timestamptz,text),public.retry_target(uuid) to authenticated;
grant execute on function public.claim_target(int),public.begin_target_dispatch(uuid,uuid),
  public.finish_target(uuid,uuid,text,text,text,text,boolean) to service_role;

commit;
