begin;

create table public.app_owners (
  user_id uuid primary key references auth.users(id)
);
create table public.media (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.app_owners(user_id),
  filename text not null check (length(filename) between 1 and 500),
  object_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime')),
  size_bytes bigint not null check (size_bytes between 1 and 2147483648),
  status text not null default 'uploading' check (status in ('uploading','ready')),
  created_at timestamptz not null default now(),
  check (split_part(object_path, '/', 1) = owner_id::text and length(object_path) > 37)
);
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.app_owners(user_id),
  title text not null check (length(btrim(title)) between 1 and 500),
  hashtags text[] not null default '{}',
  scheduled_at timestamptz not null,
  status text not null default 'queued' check (status in ('queued','processing','completed','failed')),
  created_at timestamptz not null default now()
);
create table public.post_media (
  post_id uuid not null references public.posts(id) on delete cascade,
  media_id uuid not null references public.media(id),
  primary key (post_id, media_id)
);
create table public.post_targets (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  platform text not null check (platform in ('x','facebook','tiktok','youtube')),
  status text not null default 'pending' check (status in ('pending','processing','simulated','published','failed','blocked')),
  attempts int not null default 0 check (attempts >= 0),
  error text,
  published_url text,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (post_id, platform)
);
create index posts_due_idx on public.posts(scheduled_at);
create index posts_owner_idx on public.posts(owner_id);
create index media_owner_idx on public.media(owner_id);
create index post_media_media_idx on public.post_media(media_id);
create index targets_claim_idx on public.post_targets(status, lease_expires_at, post_id);

alter table public.app_owners enable row level security;
alter table public.media enable row level security;
alter table public.posts enable row level security;
alter table public.post_media enable row level security;
alter table public.post_targets enable row level security;
revoke all on public.app_owners, public.media, public.posts, public.post_media, public.post_targets from anon, authenticated;
grant select on public.app_owners, public.media, public.posts, public.post_media, public.post_targets to authenticated;
grant insert on public.media, public.post_targets to authenticated;
grant all on public.app_owners, public.media, public.posts, public.post_media, public.post_targets to service_role;
create policy owners_read on public.app_owners for select to authenticated using (user_id = (select auth.uid()));
create policy media_read on public.media for select to authenticated using (owner_id = (select auth.uid()) and exists (select 1 from public.app_owners where user_id = auth.uid()));
create policy media_insert on public.media for insert to authenticated with check (owner_id = (select auth.uid()) and status = 'uploading' and exists (select 1 from public.app_owners where user_id = auth.uid()));
create policy posts_read on public.posts for select to authenticated using (owner_id = (select auth.uid()) and exists (select 1 from public.app_owners where user_id = auth.uid()));
create policy joins_read on public.post_media for select to authenticated using (exists (select 1 from public.posts p join public.media m on m.id = media_id where p.id = post_id and p.owner_id = auth.uid() and m.owner_id = auth.uid()));
create policy targets_read on public.post_targets for select to authenticated using (exists (select 1 from public.posts where id = post_id and owner_id = auth.uid()));
-- Direct insertion cannot manufacture a result or a lease, or mutate an active post.
create policy targets_insert on public.post_targets for insert to authenticated with check (
  status = 'pending' and attempts = 0 and error is null and published_url is null
  and lease_token is null and lease_expires_at is null
  and exists (select 1 from public.posts where id = post_id and owner_id = auth.uid() and status = 'queued')
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('social-media', 'social-media', false, 2147483648,
  array['image/jpeg','image/png','image/webp','video/mp4','video/webm','video/quicktime']);
create policy social_media_read on storage.objects for select to authenticated using (
  bucket_id = 'social-media' and (storage.foldername(name))[1] = auth.uid()::text
  and exists (select 1 from public.app_owners where user_id = auth.uid())
);
create policy social_media_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'social-media' and (storage.foldername(name))[1] = auth.uid()::text
  and exists (select 1 from public.app_owners where user_id = auth.uid())
  and exists (select 1 from public.media where object_path = name and owner_id = auth.uid() and status = 'uploading')
);

create function public.complete_media(p_media_id uuid) returns public.media
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.media; obj storage.objects;
begin
  select * into m from public.media where id = p_media_id and owner_id = auth.uid()
    and exists (select 1 from public.app_owners where user_id = auth.uid()) for update;
  if not found then raise exception 'Media not found or access denied'; end if;
  select * into obj from storage.objects where bucket_id = 'social-media' and name = m.object_path;
  if not found or split_part(m.object_path, '/', 1) <> auth.uid()::text then
    raise exception 'Uploaded object not found';
  end if;
  if obj.metadata->>'size' is null or (obj.metadata->>'size')::bigint <> m.size_bytes then
    raise exception 'Uploaded size mismatch';
  end if;
  if obj.metadata->>'mimetype' is distinct from m.mime_type then raise exception 'Uploaded MIME mismatch'; end if;
  update public.media set status = 'ready' where id = m.id returning * into m;
  return m;
end $$;

create function public.create_post(p_title text, p_hashtags text[], p_platforms text[], p_media_ids uuid[], p_scheduled_at timestamptz)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_count int;
begin
  if auth.uid() is null or not exists (select 1 from public.app_owners where user_id = auth.uid()) then
    raise exception 'Access denied';
  end if;
  if p_title is null or length(btrim(p_title)) not between 1 and 500 or p_scheduled_at is null then
    raise exception 'Title (1..500) and schedule required';
  end if;
  if p_hashtags is null or cardinality(p_hashtags) > 30 or exists (
    select 1 from unnest(p_hashtags) h where h is null or length(btrim(h)) not between 1 and 100
  ) then raise exception 'Invalid hashtags (maximum 30, 1..100 characters each)'; end if;
  if coalesce(cardinality(p_platforms),0) not between 1 and 4 or exists (
    select 1 from unnest(p_platforms) x where x is null or x not in ('x','facebook','tiktok','youtube')
  ) or (select count(distinct x) from unnest(p_platforms) x) <> cardinality(p_platforms) then
    raise exception 'Invalid or duplicate platforms';
  end if;
  if coalesce(cardinality(p_media_ids),0) not between 1 and 10 then raise exception 'Require 1..10 media'; end if;
  -- Locks prevent service-side mutation between validation and insertion.
  perform 1 from public.media where id = any(p_media_ids) and owner_id = auth.uid() and status = 'ready' for share;
  select count(*) into v_count from public.media where id = any(p_media_ids) and owner_id = auth.uid() and status = 'ready';
  if v_count <> cardinality(p_media_ids) then raise exception 'Media must be distinct, ready and owned'; end if;
  insert into public.posts(owner_id,title,hashtags,scheduled_at) values(auth.uid(),btrim(p_title),p_hashtags,p_scheduled_at) returning id into v_id;
  insert into public.post_media select v_id, unnest(p_media_ids);
  insert into public.post_targets(post_id,platform) select v_id, unnest(p_platforms);
  return v_id;
end $$;

-- Internal helper: callers serialize state transitions by locking the parent post.
create function public.refresh_post_status(p_post_id uuid) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.posts set status = case
    when not exists(select 1 from public.post_targets where post_id = p_post_id and status not in ('simulated','published')) then 'completed'
    when not exists(select 1 from public.post_targets where post_id = p_post_id and status in ('pending','processing')) then 'failed'
    else 'processing' end where id = p_post_id;
$$;

create function public.retry_target(p_target_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_post uuid;
begin
  select p.id into v_post from public.posts p join public.post_targets t on t.post_id = p.id
    where t.id = p_target_id and p.owner_id = auth.uid()
    and exists(select 1 from public.app_owners where user_id = auth.uid()) for update of p;
  if not found then raise exception 'Target not found or access denied'; end if;
  update public.post_targets set status = 'pending', attempts = 0, error = null, published_url = null,
    lease_token = null, lease_expires_at = null where id = p_target_id and status in ('failed','blocked');
  if not found then raise exception 'Only failed or blocked targets can be retried'; end if;
  update public.posts set status = 'queued' where id = v_post;
end $$;

create function public.claim_target(p_lease_seconds int default 300) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.post_targets; p public.posts; v_token uuid;
begin
  if p_lease_seconds is null or p_lease_seconds not between 10 and 3600 then raise exception 'Lease must be 10..3600 seconds'; end if;
  loop
    -- Parent-first locking also serializes aggregate state and manual retries.
    select p0.* into p from public.posts p0 where p0.scheduled_at <= now() and exists (
      select 1 from public.post_targets t0 where t0.post_id = p0.id and
      (t0.status = 'pending' or (t0.status = 'processing' and coalesce(t0.lease_expires_at, '-infinity'::timestamptz) <= now()))
    ) order by p0.scheduled_at, p0.id for update skip locked limit 1;
    if not found then return null; end if;
    select * into t from public.post_targets where post_id = p.id and
      (status = 'pending' or (status = 'processing' and coalesce(lease_expires_at, '-infinity'::timestamptz) <= now()))
      order by created_at,id for update skip locked limit 1;
    if not found then continue; end if;
    if t.attempts >= 3 then
      update public.post_targets set status = 'failed', error = 'Maximum attempts exhausted', lease_token = null, lease_expires_at = null where id = t.id;
      perform public.refresh_post_status(p.id);
      continue;
    end if;
    v_token := gen_random_uuid();
    update public.post_targets set status = 'processing', attempts = attempts + 1, error = null,
      lease_token = v_token, lease_expires_at = now() + make_interval(secs => p_lease_seconds) where id = t.id;
    update public.posts set status = 'processing' where id = p.id;
    return jsonb_build_object('id',t.id,'post_id',p.id,'platform',t.platform,'lease_token',v_token,
      'title',p.title,'hashtags',p.hashtags,'scheduled_at',p.scheduled_at,'attempts',t.attempts + 1,
      'media',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'object_path',m.object_path,
        'mime_type',m.mime_type,'size_bytes',m.size_bytes) order by m.id),'[]'::jsonb)
        from public.post_media pm join public.media m on m.id = pm.media_id where pm.post_id = p.id));
  end loop;
end $$;

create function public.finish_target(p_target_id uuid, p_lease_token uuid, p_status text, p_error text default null, p_published_url text default null)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_post uuid;
begin
  if p_status is null or p_status not in ('simulated','published','failed','blocked') then raise exception 'Invalid finish status'; end if;
  select p.id into v_post from public.posts p join public.post_targets t on t.post_id = p.id where t.id = p_target_id for update of p;
  if not found then return false; end if;
  update public.post_targets set status = p_status, error = left(p_error,2000),
    published_url = case when p_status = 'published' then p_published_url else null end,
    lease_token = null, lease_expires_at = null
    where id = p_target_id and status = 'processing' and lease_token = p_lease_token and lease_expires_at > now();
  if not found then return false; end if;
  perform public.refresh_post_status(v_post);
  return true;
end $$;

revoke all on function public.complete_media(uuid), public.create_post(text,text[],text[],uuid[],timestamptz), public.retry_target(uuid), public.refresh_post_status(uuid), public.claim_target(int), public.finish_target(uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.complete_media(uuid), public.create_post(text,text[],text[],uuid[],timestamptz), public.retry_target(uuid) to authenticated;
grant execute on function public.claim_target(int), public.finish_target(uuid,uuid,text,text,text) to service_role;
commit;
