import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

const owner = "550e8400-e29b-41d4-a716-446655440000";
const stranger = "550e8400-e29b-41d4-a716-446655440001";
type Target = { id: string; lease_token: string; attempts: number; content_snapshot: unknown; dispatch_started_at: string | null; delivery_uncertain: boolean };

test("project publishing snapshots, admission, dispatch fencing and reconciliation", async () => {
  const db = new PGlite();
  const scalar = async <T>(sql: string, args: unknown[] = []) =>
    (await db.query<{ value: T }>(sql, args)).rows[0].value;
  const login = async (user = owner) => {
    await db.exec("reset role; set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  };
  const service = () => db.exec("reset role; set role service_role");
  const claim = () => scalar<Target | null>("select claim_target(300) as value");
  const submit = (project: string, key = randomUUID(), schedule: string | null = null, mode = "simulation") =>
    scalar<string>("select submit_content_project($1,$2,$3,$4) as value", [project, key, schedule, mode]);
  const begin = (t: Target, token = t.lease_token) => scalar<boolean>("select begin_target_dispatch($1,$2) as value", [t.id, token]);
  const finish = (t: Target, status: string, url: string | null = null, external: string | null = null, uncertain = false) =>
    scalar<boolean>("select finish_target($1,$2,$3,null,$4,$5,$6) as value", [t.id, t.lease_token, status, url, external, uncertain]);
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create schema storage;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth,storage to authenticated,service_role;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
      alter table storage.objects enable row level security;
      grant select,insert on storage.objects to authenticated;
      create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
    `);
    for (const migration of ["001_initial", "002_post_description", "003_content_library", "004_shared_media_roles", "005_content_price", "006_project_publishing", "007_checked_publication"]) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${migration}.sql`, import.meta.url), "utf8"));
    }
    await db.query("insert into auth.users values($1),($2);", [owner, stranger]);
    await db.query("insert into app_owners values($1),($2)", [owner, stranger]);
    await login();
    const ws = await scalar<string>("select ensure_personal_workspace() as value");
    await login(stranger);
    const otherWs = await scalar<string>("select ensure_personal_workspace() as value");
    await service();
    await db.query("insert into facebook_destinations(workspace_id,page_id,page_name) values($1,'123456','Test page'),($2,'987654','Other test page')", [ws, otherWs]);
    const image = randomUUID();
    const video = randomUUID();
    for (const [id, mime] of [[image, "image/jpeg"], [video, "video/quicktime"]]) {
      await db.query("insert into media(id,owner_id,filename,object_path,mime_type,size_bytes,status) values($1,$2,'fixture',$3,$4,100,'ready')", [id, owner, `${owner}/${id}`, mime]);
    }
    await login();
    const save = (assets: unknown[], project: string | null = null, title = "Original") => scalar<string>(
      "select save_content_project($1,'Description',array['tag'],$2,$3::jsonb,$4,12.50) as value",
      [title, ws, JSON.stringify(assets), project],
    );
    const assets = [{ media_id: image, role: "gallery", position: 0 }, { media_id: image, role: "cover", position: 0 }, { media_id: video, role: "video", position: 0 }];
    const project = await save(assets);
    for (const sql of ["delete from facebook_destinations", "update facebook_destinations set live_enabled=true", "insert into facebook_destinations(workspace_id,page_id) values(gen_random_uuid(),'1')", "update posts set title='forged'"]) {
      await assert.rejects(db.query(sql), /permission denied/);
    }
    assert.equal((await db.query("select * from facebook_destinations")).rows.length, 1);
    await assert.rejects(db.query("select claim_target()"), /permission denied/);
    await assert.rejects(db.query("select begin_target_dispatch($1,$2)", [randomUUID(), randomUUID()]), /permission denied/);
    await assert.rejects(db.query("select finish_target($1,$2,'simulated')", [randomUUID(), randomUUID()]), /permission denied/);
    await assert.rejects(submit(project, randomUUID(), null, "live"), /live publishing not enabled/);
    const key = randomUUID();
    const post = await submit(project, key);
    const snapshot = await scalar<Record<string, unknown>>("select content_snapshot as value from posts where id=$1", [post]);
    assert.equal(snapshot.schema_version, 1);
    assert.equal(snapshot.price, 12.5);
    assert.equal(snapshot.execution_mode, "simulation");
    assert.deepEqual(snapshot.destination, { platform: "facebook", page_id: "123456", page_name: "Test page" });
    assert.deepEqual((snapshot.assets as { id: string; role: string }[]).map(a => [a.id, a.role]), [[image, "cover"], [image, "gallery"], [video, "video"]]);
    assert.equal(await scalar<number>("select count(*)::int as value from post_media where post_id=$1", [post]), 2);
    assert.deepEqual((await db.query("select platform from post_targets where post_id=$1", [post])).rows, [{ platform: "facebook" }]);
    await save([], project, "Edited");
    assert.deepEqual(await scalar("select content_snapshot as value from posts where id=$1", [post]), snapshot);
    assert.equal(await submit(project, key), post);
    for (const [schedule, mode] of [["2030-01-01T00:00:00Z", "simulation"], [null, "live"]] as const) {
      await assert.rejects(submit(project, key, schedule, mode), /Submission key conflict/);
    }
    const text = await save([]);
    await assert.rejects(submit(text, key), /Submission key conflict/);
    const scheduledKey = randomUUID();
    const scheduled = await submit(text, scheduledKey, "2030-01-01T00:00:00Z");
    assert.equal(await submit(text, scheduledKey, "2030-01-01T00:00:00Z"), scheduled);
    await assert.rejects(submit(text, scheduledKey), /Submission key conflict/);
    await login(stranger);
    await assert.rejects(submit(project), /Workspace access denied/);
    assert.equal((await db.query("select * from posts")).rows.length, 0);
    await service();
    await db.query("insert into workspace_members values($1,$2,'editor')", [ws, stranger]);
    await login();
    await save(assets, project);
    await login(stranger);
    await assert.rejects(submit(project), /Media must be ready and owned/);
    await service();
    await db.query("update media set status='uploading' where id=$1", [image]);
    await login();
    await assert.rejects(submit(project), /Media must be ready and owned/);
    await service();
    await db.query("update media set status='ready' where id=$1", [image]);
    await db.query("update facebook_destinations set enabled=false where workspace_id=$1", [ws]);
    await login();
    await assert.rejects(submit(text), /destination not enabled/);
    await service();
    await db.query("update facebook_destinations set enabled=true,live_enabled=true where workspace_id=$1", [ws]);
    const simulation = (await claim())!;
    assert.deepEqual(simulation.content_snapshot, snapshot);
    assert.equal(await begin(simulation), false);
    await assert.rejects(finish(simulation, "published", "https://facebook.com/123", "123"), /Invalid published result/);
    assert.equal(await finish(simulation, "simulated"), true);
    await login();
    const textPost = await submit(text);
    assert.deepEqual(await scalar("select content_snapshot->'assets' as value from posts where id=$1", [textPost]), []);
    await service();
    assert.equal(await finish((await claim())!, "simulated"), true);
    await login();
    await submit(text, randomUUID(), null, "live");
    await service();
    const live = (await claim())!;
    assert.equal(live.dispatch_started_at, null);
    assert.equal(await begin(live, randomUUID()), false);
    await assert.rejects(finish(live, "simulated"), /Invalid simulated result/);
    await assert.rejects(finish(live, "published", "https://facebook.com/123", "123"), /Invalid published result/);
    for (const change of ["live_enabled=false", "enabled=false", "page_id='999'"]) {
      await db.query(`update facebook_destinations set ${change} where workspace_id=$1`, [ws]);
      assert.equal(await begin(live), false);
      await db.query("update facebook_destinations set enabled=true,live_enabled=true,page_id='123456' where workspace_id=$1", [ws]);
    }
    assert.equal(await begin(live), true);
    assert.equal(await begin(live), false);
    for (const [url, external] of [["http://facebook.com/123", "123"], ["https://facebook.com/123", " "]]) {
      await assert.rejects(finish(live, "published", url, external), /Invalid published result/);
    }
    assert.equal(await finish({ ...live, lease_token: randomUUID() }, "failed"), false);
    assert.equal(await finish(live, "published", "https://facebook.com/123456/posts/789", "123456_789"), true);
    assert.equal(await scalar("select p.status as value from posts p join post_targets t on t.post_id=p.id where t.id=$1", [live.id]), "completed");
    assert.equal(await finish(live, "published", "https://facebook.com/123", "123"), false);
    assert.deepEqual((await db.query("select status,external_post_id,delivery_uncertain from post_targets where id=$1", [live.id])).rows[0], { status: "published", external_post_id: "123456_789", delivery_uncertain: false });
    await login();
    await submit(text, randomUUID(), null, "live");
    await service();
    const uncertain = (await claim())!;
    assert.equal(await begin(uncertain), true);
    await db.query("update post_targets set lease_expires_at=now()-interval '1 second' where id=$1", [uncertain.id]);
    assert.equal(await begin(uncertain), false);
    assert.equal(await finish(uncertain, "failed"), false);
    assert.equal(await claim(), null);
    assert.deepEqual((await db.query("select status,delivery_uncertain,error from post_targets where id=$1", [uncertain.id])).rows[0], { status: "blocked", delivery_uncertain: true, error: "Delivery uncertain; reconciliation required" });
    assert.equal(await scalar("select p.status as value from posts p join post_targets t on t.post_id=p.id where t.id=$1", [uncertain.id]), "failed");
    await login();
    await assert.rejects(db.query("select retry_target($1)", [uncertain.id]), /reconciliation required/);
    // Explicit uncertainty and a blocked dispatch without a result are both non-retryable.
    for (const uncertainFlag of [false, true]) {
      await submit(text, randomUUID(), null, "live");
      await service();
      const t = (await claim())!;
      await begin(t);
      assert.equal(await finish(t, "blocked", null, null, uncertainFlag), true);
      await login();
      await assert.rejects(db.query("select retry_target($1)", [t.id]), /reconciliation required/);
    }
    // A definitive failure clears the dispatch fence; a pre-dispatch block is also safe.
    for (const status of ["failed", "blocked"]) {
      await submit(text, randomUUID(), null, "live");
      await service();
      const t = (await claim())!;
      if (status === "failed") await begin(t);
      await finish(t, status);
      await login();
      await db.query("select retry_target($1)", [t.id]);
      await service();
      const retried = (await claim())!;
      assert.equal(retried.id, t.id);
      assert.equal(retried.attempts, 1);
      await finish(retried, "failed");
      await login();
    }
    // Non-dispatched expired leases retain the original maximum-three-attempts contract.
    await submit(text);
    await service();
    let exhausted: Target | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      exhausted = (await claim())!;
      assert.equal(exhausted.attempts, attempt);
      await db.query("update post_targets set lease_expires_at=now()-interval '1 second' where id=$1", [exhausted.id]);
    }
    assert.equal(await claim(), null);
    assert.equal(await scalar("select status as value from post_targets where id=$1", [exhausted!.id]), "failed");
    // Legacy null-snapshot jobs still accept the original five-argument result contract.
    await login();
    await scalar("select create_post('legacy',array[]::text[],array['facebook'],array[$1::uuid],now()) as value", [image]);
    await service();
    const legacy = (await claim())!;
    assert.equal(await scalar("select finish_target($1,$2,'published',null,null) as value", [legacy.id, legacy.lease_token]), true);
    await login();
    const checkedProject = await save([]);
    const version = await scalar<string>("select updated_at::text as value from content_projects where id=$1", [checkedProject]);
    const checked = (key = randomUUID(), expected = version, mode = "live") => scalar<string>("select submit_content_project_checked($1,$2,null,$3,$4) as value", [checkedProject, key, mode, expected]);
    await assert.rejects(checked(randomUUID(), "2000-01-01T00:00:00Z"), /Project changed/);
    const checkedKey = randomUUID();
    const checkedJob = await checked(checkedKey);
    await assert.rejects(checked(), /Publication already active/);
    await service();
    await db.query("update content_projects set updated_at=now()+interval '1 second' where id=$1", [checkedProject]);
    await login();
    assert.equal(await checked(checkedKey), checkedJob, "Replay must return original job even after edit");
    await service();
    await db.query("delete from workspace_members where workspace_id=$1 and user_id=$2", [ws, stranger]);
    await login(stranger);
    await assert.rejects(checked(), /access denied/i);
    await db.exec("reset role; set role anon");
    await assert.rejects(checked(), /permission denied/);
    await assert.rejects(submit(text), /permission denied/);
  } finally { await db.close(); }
});
