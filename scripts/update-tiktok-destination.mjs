import { database } from "./cloud-db.mjs";

const client = database();
await client.connect();
await client.query("UPDATE tiktok_destinations SET creator_username = 'Elephant-Maker' WHERE workspace_id = 'ede17758-af13-4f75-98c8-bfb6cb33eead';");
const res = await client.query("SELECT * FROM tiktok_destinations;");
console.log("Updated tiktok_destinations:", res.rows);
await client.end();

