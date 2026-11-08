import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const owner = "550e8400-e29b-41d4-a716-446655440000";
const stranger = "550e8400-e29b-41d4-a716-446655440001";
const media = "650e8400-e29b-41d4-a716-446655440000";

test("migration, owner RLS, storage completion, atomic queue and fenced leases", async () => {
  const db = new PGlite();
  try {
    // Local stand-ins for Supabase-managed schemas; no remote services are contacted.
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
    await db.exec(await readFile(new URL("../supabase/migrations/001_initial.sql", import.meta.url), "utf8"));
        await db.exec(await readFile(new URL("../supabase/migrations/002_post_description.sql", import.meta.url), "utf8"));
    await db.query("insert into auth.users values ($1),($2)", [owner, stranger]);
    await db.query("insert into app_owners values ($1)", [owner]);
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [stranger]);
    assert.equal((await db.query("select * from app_owners")).rows.length, 0);
    await assert.rejects(db.query("insert into app_owners values ($1)", [stranger]));
    await assert.rejects(db.query("insert into media(owner_id,filename,object_path,mime_type,size_bytes) values($1,'a.jpg',$2,'image/jpeg',100)", [stranger, `${stranger}/a.jpg`]));
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await db.query("insert into media(id,owner_id,filename,object_path,mime_type,size_bytes) values($1,$2,'a.jpg',$3,'image/jpeg',100)", [media, owner, `${owner}/a.jpg`]);
    await assert.rejects(db.query("select complete_media($1)", [media]));
    await db.query("insert into storage.objects(bucket_id,name,metadata) values('social-media',$1,$2)", [`${owner}/a.jpg`, { size: 100, mimetype: "image/jpeg" }]);
    await db.query("select complete_media($1)", [media]);
    await assert.rejects(db.query("update media set size_bytes=1 where id=$1", [media]));
    const created = await db.query<{ id: string }>("select create_post('test',array['tag'],array['x','facebook'],array[$1::uuid],now()-interval '1 second','รายละเอียดโพสต์') as id", [media]);
    const post = created.rows[0].id;
    await assert.rejects(db.query("select claim_target(300)"));
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [stranger]);
    assert.equal((await db.query("select * from posts")).rows.length, 0);
    assert.equal((await db.query("select * from post_targets")).rows.length, 0);
    await db.exec("reset role");
    await db.query("insert into app_owners values ($1)", [stranger]);
    await db.exec("set role authenticated");
    await assert.rejects(
      db.query("select create_post('foreign media',array[]::text[],array['x'],array[$1::uuid],now())", [media]),
      /Media must be distinct, ready and owned/,
    );
    await db.exec("reset role; set role service_role");
    assert.equal((await db.query("select * from posts where owner_id=$1", [stranger])).rows.length, 0);
    const first = await db.query<{ target: { id: string; lease_token: string; description: string } }>("select claim_target(300) as target");
    const target = first.rows[0].target;
    assert.ok(target.id);
        assert.equal(target.description, "รายละเอียดโพสต์");
    const stale = await db.query<{ ok: boolean }>("select finish_target($1,$2,'simulated') as ok", [target.id, stranger]);
    assert.equal(stale.rows[0].ok, false);
    await db.query("update post_targets set lease_expires_at=now()-interval '1 second' where id=$1", [target.id]);
    const reclaimed = (await db.query<{ target: { id: string; lease_token: string; attempts: number } }>("select claim_target(300) as target")).rows[0].target;
    assert.equal(reclaimed.id, target.id);
    assert.notEqual(reclaimed.lease_token, target.lease_token);
    assert.equal(reclaimed.attempts, 2);
    assert.equal((await db.query<{ ok: boolean }>("select finish_target($1,$2,'simulated') as ok", [target.id, target.lease_token])).rows[0].ok, false);
    assert.deepEqual((await db.query("select status,lease_token from post_targets where id=$1", [target.id])).rows[0], {
      status: "processing", lease_token: reclaimed.lease_token,
    });
    assert.equal((await db.query<{ ok: boolean }>("select finish_target($1,$2,'simulated') as ok", [target.id, reclaimed.lease_token])).rows[0].ok, true);
    const second = (await db.query<{ target: { id: string; lease_token: string } }>("select claim_target(300) as target")).rows[0].target;
    assert.notEqual(second.id, target.id);
    await db.query("select finish_target($1,$2,'blocked','Adapter pending')", [second.id, second.lease_token]);
    assert.equal((await db.query<{ status: string }>("select status from posts where id=$1", [post])).rows[0].status, "failed");
    await db.exec("reset role; set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await db.query("select retry_target($1)", [second.id]);
    assert.equal((await db.query<{ status: string }>("select status from posts where id=$1", [post])).rows[0].status, "queued");
    await assert.rejects(db.query("select retry_target($1)", [target.id]), /Only failed or blocked targets can be retried/);
    await db.exec("reset role; set role service_role");
    const retried = (await db.query<{ target: { id: string; lease_token: string; attempts: number } }>("select claim_target(300) as target")).rows[0].target;
    assert.equal(retried.id, second.id);
    assert.equal(retried.attempts, 1);
    assert.equal((await db.query<{ ok: boolean }>("select finish_target($1,$2,'published') as ok", [retried.id, retried.lease_token])).rows[0].ok, true);
    await db.exec("reset role; set role authenticated");
    await assert.rejects(db.query("select retry_target($1)", [retried.id]), /Only failed or blocked targets can be retried/);
    assert.deepEqual((await db.query("select status from post_targets where post_id=$1 order by status", [post])).rows, [
      { status: "published" }, { status: "simulated" },
    ]);
    assert.equal((await db.query<{ status: string }>("select status from posts where id=$1", [post])).rows[0].status, "completed");

    const future = (await db.query<{ id: string }>("select create_post('future',array[]::text[],array['x'],array[$1::uuid],now()+interval '1 day') as id", [media])).rows[0].id;
    await db.exec("reset role; set role service_role; set statement_timeout='5s'");
    assert.equal((await db.query<{ target: unknown }>("select claim_target(300) as target")).rows[0].target, null);
    assert.deepEqual((await db.query("select status,attempts,lease_token from post_targets where post_id=$1", [future])).rows[0], {
      status: "pending", attempts: 0, lease_token: null,
    });
    await db.query("update posts set scheduled_at=now()-interval '1 second' where id=$1", [future]);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const claimed = (await db.query<{ target: { id: string; post_id: string; attempts: number } }>("select claim_target(300) as target")).rows[0].target;
      assert.ok(claimed);
      assert.equal(claimed.post_id, future);
      assert.equal(claimed.attempts, attempt);
      await db.query("update post_targets set lease_expires_at=now()-interval '1 second' where id=$1", [claimed.id]);
    }
    for (let claim = 0; claim < 2; claim++) {
      assert.equal((await db.query<{ target: unknown }>("select claim_target(300) as target")).rows[0].target, null);
      assert.deepEqual((await db.query("select status,attempts,error,lease_token,lease_expires_at from post_targets where post_id=$1", [future])).rows[0], {
        status: "failed", attempts: 3, error: "Maximum attempts exhausted", lease_token: null, lease_expires_at: null,
      });
      assert.equal((await db.query<{ status: string }>("select status from posts where id=$1", [future])).rows[0].status, "failed");
    }
  } finally { await db.close(); }
});
