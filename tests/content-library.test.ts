import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const owner = "550e8400-e29b-41d4-a716-446655440000";
const stranger = "550e8400-e29b-41d4-a716-446655440001";

test("content library admission, workspace RLS, asset ownership and atomic updates", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create schema storage;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth, storage to authenticated, service_role;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
      alter table storage.objects enable row level security;
      grant select,insert on storage.objects to authenticated;
      create function storage.foldername(text) returns text[] language sql immutable as
        $$ select string_to_array($1,'/') $$;
    `);
    for (const migration of ["001_initial.sql", "002_post_description.sql", "003_content_library.sql", "004_shared_media_roles.sql", "005_content_price.sql"]) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), "utf8"));
    }
    await db.query("insert into auth.users values ($1),($2)", [owner, stranger]);
    await db.query("insert into app_owners values ($1)", [owner]);
    const login = async (user: string) => {
      await db.exec("reset role; set role authenticated");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
    };
    const workspace = async () => (await db.query<{ id: string }>("select ensure_personal_workspace() as id")).rows[0].id;
    await login(stranger);
    await assert.rejects(workspace(), /Access denied/);
    await login("");
    await assert.rejects(workspace(), /Access denied/);
    await login(owner);
    const ownWorkspace = await workspace();
    assert.equal(await workspace(), ownWorkspace);
    assert.deepEqual((await db.query("select name,owner_id from workspaces")).rows, [{ name: "Personal", owner_id: owner }]);
    assert.equal((await db.query("select * from workspace_members")).rows.length, 1);
    for (const table of ["workspaces", "workspace_members", "content_projects", "content_project_media"]) {
      await assert.rejects(db.query(`delete from ${table}`), /permission denied/);
    }
    await db.exec("reset role");
    await db.query("insert into app_owners values ($1)", [stranger]);
    const addMedia = async (user: string, mime: string, status = "ready") => {
      const id = crypto.randomUUID();
      await db.query("insert into media(id,owner_id,filename,object_path,mime_type,size_bytes,status) values($1,$2,'asset',$3,$4,100,$5)", [id, user, `${user}/${id}`, mime, status]);
      return id;
    };
    const video = await addMedia(owner, "video/mp4");
    const cover = await addMedia(owner, "image/jpeg");
    const gallery = await addMedia(owner, "image/png");
    const foreign = await addMedia(stranger, "image/jpeg");
    const uploading = await addMedia(owner, "image/jpeg", "uploading");
    await login(stranger);
    const foreignWorkspace = await workspace();
    await login(owner);
    const assets = [
      { media_id: video, role: "video", position: 0 },
      { media_id: cover, role: "cover", position: 0 },
      { media_id: gallery, role: "gallery", position: 0 },
    ];
    const save = async (items: unknown, project: string | null = null, ws = ownWorkspace, title = "Project", tags: (string | null)[] = ["tag"], description = "Description") =>
      (await db.query<{ id: string }>("select save_content_project($1,$2,$3::text[],$4,$5::jsonb,$6) as id", [title, description, tags, ws, JSON.stringify(items), project])).rows[0].id;
    const project = await save(assets);
        for (const price of [1234.5, 0, null]) {
          await db.query("select save_content_project('Project','Description',array['tag'],$1,$2::jsonb,$3,$4::numeric)", [ownWorkspace, JSON.stringify(assets), project, price]);
          const stored = (await db.query<{ price: string | null }>("select price from content_projects where id=$1", [project])).rows[0].price;
          assert.equal(stored === null ? null : Number(stored), price);
        }
        for (const price of [-1, 12.345, 10000000000]) {
          await assert.rejects(db.query("select save_content_project('Project','Description',array['tag'],$1,$2::jsonb,$3,$4::numeric)", [ownWorkspace, JSON.stringify(assets), project, price]), /Invalid price/);
        }
    assert.equal((await db.query("select * from content_project_media")).rows.length, 3);
    assert.equal((await db.query("select * from posts")).rows.length, 0);
    await assert.rejects(save([], null, foreignWorkspace), /Workspace access denied/);
    await assert.rejects(save([], project, foreignWorkspace), /Workspace access denied/);
    await save([{ media_id: cover, role: "cover", position: 0 }, { media_id: cover, role: "gallery", position: 0 }], project);
        assert.equal((await db.query("select * from content_project_media where project_id=$1", [project])).rows.length, 2);
        assert.equal((await db.query("select distinct media_id from content_project_media where project_id=$1", [project])).rows.length, 1);
        await assert.rejects(save([{ media_id: cover, role: "gallery", position: 0 }, { media_id: cover, role: "gallery", position: 1 }], project));
        await save(assets, project);
        const before = (await db.query<{ updated_at: Date }>("select * from content_projects where id=$1", [project])).rows;
    const links = (await db.query("select * from content_project_media order by role")).rows;
    for (const invalid of [
      [{ media_id: foreign, role: "gallery", position: 0 }],
      [{ media_id: uploading, role: "gallery", position: 0 }],
      [{ media_id: video, role: "cover", position: 0 }],
      [{ media_id: cover, role: "video", position: 0 }],
      [assets[0], assets[0]],
      [{ ...assets[1], role: "gallery" }, assets[2]],
      [assets[1], { ...assets[2], role: "cover", position: 1 }],
      [{ ...assets[0], role: "invalid" }],
      [{ ...assets[0], position: -1 }],
      [{ media_id: video, role: "video" }],
      Array(13).fill(assets[0]), null, {},
    ]) {
      await assert.rejects(save(invalid, project));
      assert.deepEqual((await db.query("select * from content_projects where id=$1", [project])).rows, before);
      assert.deepEqual((await db.query("select * from content_project_media order by role")).rows, links);
    }
    await assert.rejects(save([], null, ownWorkspace, " "));
    await assert.rejects(save([], null, ownWorkspace, "x".repeat(501)));
    for (const tags of [[null], [" "], ["x".repeat(101)], Array(31).fill("tag")]) {
      await assert.rejects(save([], null, ownWorkspace, "Project", tags));
    }
    await assert.rejects(save([], null, ownWorkspace, "Project", [], "x".repeat(5001)));
    await login(stranger);
    assert.equal((await db.query("select * from content_projects")).rows.length, 0);
    assert.equal((await db.query("select * from content_project_media")).rows.length, 0);
    await assert.rejects(save([], project), /Workspace access denied/);
    await assert.rejects(save([], project, foreignWorkspace), /Project not found/);
    // Membership permits editing, but never borrowing another owner's media.
    await db.exec("reset role");
    await db.query("insert into workspace_members values($1,$2,'editor')", [ownWorkspace, stranger]);
    await login(stranger);
    assert.equal((await db.query("select * from content_projects")).rows.length, 1);
    await assert.rejects(save(assets, project), /Media must be ready and owned/);
    assert.equal(await save([{ media_id: foreign, role: "gallery", position: 0 }], project), project);
    assert.equal((await db.query<{ created_by: string }>("select created_by from content_projects")).rows[0].created_by, owner);
    await db.exec("reset role");
    const unadmitted = "550e8400-e29b-41d4-a716-446655440002";
    await db.query("insert into auth.users values($1)", [unadmitted]);
    await db.query("insert into workspace_members values($1,$2,'editor')", [ownWorkspace, unadmitted]);
    await login(unadmitted);
    assert.equal((await db.query("select * from workspace_members")).rows.length, 0);
    assert.equal((await db.query("select * from workspaces")).rows.length, 0);
    await assert.rejects(save([], project), /Workspace access denied/);
    await login(stranger);
    assert.equal(await save([], project), project);
    assert.equal((await db.query("select * from content_project_media")).rows.length, 0);
    assert.ok(new Date((await db.query<{ updated_at: Date }>("select updated_at from content_projects")).rows[0].updated_at) > new Date(before[0].updated_at));
    await db.exec("reset role; set role anon");
    await assert.rejects(workspace(), /permission denied/);
    await assert.rejects(save([]), /permission denied/);
    await assert.rejects(db.query("select * from workspaces"), /permission denied/);
    await db.exec("reset role; set role service_role");
    assert.equal((await db.query("select * from workspaces")).rows.length, 2);
  } finally { await db.close(); }
});
