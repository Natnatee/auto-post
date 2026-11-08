begin;

alter table public.posts add column description text not null default '' check (length(description) <= 5000);

drop function public.create_post(text,text[],text[],uuid[],timestamptz);
create function public.create_post(p_title text, p_hashtags text[], p_platforms text[], p_media_ids uuid[], p_scheduled_at timestamptz, p_description text default '')
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_count int;
begin
  if auth.uid() is null or not exists (select 1 from public.app_owners where user_id = auth.uid()) then
    raise exception 'Access denied';
  end if;
  if p_title is null or length(btrim(p_title)) not between 1 and 500 or p_scheduled_at is null then
    raise exception 'Title (1..500) and schedule required';
  end if;
  if p_description is null or length(p_description) > 5000 then raise exception 'Invalid description'; end if;
  if p_hashtags is null or cardinality(p_hashtags) > 30 or exists (
    select 1 from unnest(p_hashtags) h where h is null or length(btrim(h)) not between 1 and 100
  ) then raise exception 'Invalid hashtags (maximum 30, 1..100 characters each)'; end if;
  if coalesce(cardinality(p_platforms),0) not between 1 and 4 or exists (
    select 1 from unnest(p_platforms) x where x is null or x not in ('x','facebook','tiktok','youtube')
  ) or (select count(distinct x) from unnest(p_platforms) x) <> cardinality(p_platforms) then
    raise exception 'Invalid or duplicate platforms';
  end if;
  if coalesce(cardinality(p_media_ids),0) not between 1 and 10 then raise exception 'Require 1..10 media'; end if;
  perform 1 from public.media where id = any(p_media_ids) and owner_id = auth.uid() and status = 'ready' for share;
  select count(*) into v_count from public.media where id = any(p_media_ids) and owner_id = auth.uid() and status = 'ready';
  if v_count <> cardinality(p_media_ids) then raise exception 'Media must be distinct, ready and owned'; end if;
  insert into public.posts(owner_id,title,description,hashtags,scheduled_at)
    values(auth.uid(),btrim(p_title),btrim(p_description),p_hashtags,p_scheduled_at) returning id into v_id;
  insert into public.post_media select v_id, unnest(p_media_ids);
  insert into public.post_targets(post_id,platform) select v_id, unnest(p_platforms);
  return v_id;
end $$;
revoke all on function public.create_post(text,text[],text[],uuid[],timestamptz,text) from public, anon, authenticated;
grant execute on function public.create_post(text,text[],text[],uuid[],timestamptz,text) to authenticated;

create or replace function public.claim_target(p_lease_seconds int default 300) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.post_targets; p public.posts; v_token uuid;
begin
  if p_lease_seconds is null or p_lease_seconds not between 10 and 3600 then raise exception 'Lease must be 10..3600 seconds'; end if;
  loop
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
      'title',p.title,'description',p.description,'hashtags',p.hashtags,'scheduled_at',p.scheduled_at,'attempts',t.attempts + 1,
      'media',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'object_path',m.object_path,
        'mime_type',m.mime_type,'size_bytes',m.size_bytes) order by m.id),'[]'::jsonb)
        from public.post_media pm join public.media m on m.id = pm.media_id where pm.post_id = p.id));
  end loop;
end $$;
revoke all on function public.claim_target(int) from public, anon, authenticated;
grant execute on function public.claim_target(int) to service_role;

commit;
