import { database } from "./cloud-db.mjs";

const client = database();
await client.connect();
await client.query(`
  UPDATE public.post_targets
  SET published_url = 'https://www.tiktok.com/@decraych/video/7705740487881281000',
      external_post_id = '7705740487881281000'
  WHERE id = '3c08c44f-fc92-4b3b-a357-294663c3aaa8';
`);
const res = await client.query("SELECT id, platform, status, published_url FROM public.post_targets WHERE id = '3c08c44f-fc92-4b3b-a357-294663c3aaa8';");
console.log("Updated target:", res.rows[0]);
await client.end();

