begin;

-- Keep one physical upload while permitting an image in distinct project roles.
alter table public.content_project_media drop constraint content_project_media_pkey;
alter table public.content_project_media add primary key (project_id,media_id,role);

create or replace function public.save_content_project(
  p_title text, p_description text, p_hashtags text[], p_workspace_id uuid,
  p_assets jsonb, p_project_id uuid default null
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_asset jsonb; v_media public.media; v_media_id uuid; v_role text;
begin
  if not public.is_workspace_member(p_workspace_id) or not exists (
    select 1 from public.workspace_members where workspace_id = p_workspace_id and user_id = auth.uid() and role in ('owner','editor')
  ) then raise exception 'Workspace access denied'; end if;
  if p_title is null or length(btrim(p_title)) not between 1 and 500 then raise exception 'Invalid title (1..500)'; end if;
  if p_description is null or length(p_description) > 5000 then raise exception 'Invalid description'; end if;
  if not public.valid_content_hashtags(p_hashtags) then raise exception 'Invalid hashtags'; end if;
  if p_assets is null or jsonb_typeof(p_assets) <> 'array' then raise exception 'Assets must be an array'; end if;
  if jsonb_array_length(p_assets) > 12 then raise exception 'Maximum 12 assets'; end if;
  if p_project_id is not null then
    select id into v_id from public.content_projects where id = p_project_id and workspace_id = p_workspace_id for update;
    if not found then raise exception 'Project not found or access denied'; end if;
  end if;
  for v_asset in select value from jsonb_array_elements(p_assets) loop
    if jsonb_typeof(v_asset) <> 'object'
      or jsonb_typeof(v_asset->'media_id') is distinct from 'string'
      or jsonb_typeof(v_asset->'role') is distinct from 'string'
      or jsonb_typeof(v_asset->'position') is distinct from 'number'
      or (v_asset->>'position') !~ '^[0-9]+$'
      or (v_asset->>'role') not in ('video','cover','gallery') then
      raise exception 'Invalid asset';
    end if;
    v_media_id := (v_asset->>'media_id')::uuid;
    v_role := v_asset->>'role';
    perform (v_asset->>'position')::int;
    select * into v_media from public.media where id = v_media_id and owner_id = auth.uid() and status = 'ready' for share;
    if not found then raise exception 'Media must be ready and owned'; end if;
    if (v_role = 'video' and v_media.mime_type not like 'video/%')
      or (v_role in ('cover','gallery') and v_media.mime_type not like 'image/%') then raise exception 'Media type does not match role'; end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(p_assets) a group by (a->>'media_id')::uuid,a->>'role' having count(*) > 1)
    or exists (select 1 from jsonb_array_elements(p_assets) a group by a->>'role',(a->>'position')::int having count(*) > 1)
    or exists (select 1 from jsonb_array_elements(p_assets) a where a->>'role' in ('video','cover') group by a->>'role' having count(*) > 1)
  then raise exception 'Duplicate media, role or position'; end if;
  if v_id is null then
    insert into public.content_projects(workspace_id,title,description,hashtags,created_by)
      values(p_workspace_id,btrim(p_title),btrim(p_description),p_hashtags,auth.uid()) returning id into v_id;
  else
    update public.content_projects set title = btrim(p_title), description = btrim(p_description), hashtags = p_hashtags,
      updated_at = clock_timestamp() where id = v_id;
    delete from public.content_project_media where project_id = v_id;
  end if;
  insert into public.content_project_media(project_id,media_id,role,position)
    select v_id,(a->>'media_id')::uuid,a->>'role',(a->>'position')::int from jsonb_array_elements(p_assets) a;
  return v_id;
end $$;

revoke all on function public.save_content_project(text,text,text[],uuid,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.save_content_project(text,text,text[],uuid,jsonb,uuid) to authenticated, service_role;

commit;
