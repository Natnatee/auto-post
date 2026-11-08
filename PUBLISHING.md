# Facebook publishing worker

## สถานะ

- รับคำสั่งเผยแพร่จาก content project ผ่าน API แล้วใช้ queue เดิม
- Snapshot บันทึก title, description, hashtags, price, asset roles/order, object paths และเพจปลายทางแบบ immutable สำหรับผู้ใช้
- Submission key กันการส่งคำสั่งซ้ำ; key เดิมแต่ project/schedule/mode ต่างกันตอบ conflict
- ทดสอบกับ PostgreSQL/REST จริงและ worker simulation แล้ว และผู้ใช้อนุมัติทดสอบวิดีโอจริง Bat_Halloween สำเร็จ 2026-11-05
- รองรับข้อความล้วน, รูป JPEG/PNG หนึ่งไฟล์จริง หรือ MP4 หนึ่งไฟล์ไม่เกิน 2 GiB
- Video-first: ถ้ามี MP4 หนึ่งไฟล์ จะเผยแพร่เฉพาะวิดีโอพร้อม caption; cover/gallery ยังคงใน Library ไม่แนบหรือใช้เป็น thumbnail อัตโนมัติ
- ถ้าไม่มีวิดีโอ ภาพหลายไฟล์ยังถูก blocked; WebP, MOV/WebM และหลายวิดีโอยังไม่รองรับ
- รูปไม่เกิน 10 MiB; Meta ดึงไฟล์จาก signed Storage URL โดย worker/Pi ไม่ดาวน์โหลดไฟล์
- UI ยังคงสองหน้าเดิม; Library มีปุ่มเผยแพร่ Facebook เปิด dialog พรีวิว caption/สื่อ/เพจ ต้องติ๊กยืนยันก่อนส่ง แสดงงาน/ลิงก์และ polling ขณะรอ
- ปุ่มส่งปิดเมื่อ live gates ยังไม่พร้อม, สื่อไม่รองรับ, มีงานค้าง หรือ delivery uncertain; retry หลัง network/5xx ใช้ submission key เดิม ไม่มี auto POST
- Migration 007 เพิ่ม `submit_content_project_checked` ตรวจ `expectedUpdatedAt` ภายใต้ project lock กันพรีวิวเก่าและงาน live ซ้อน; replay key เดิมยังคืน immutable job เดิมแม้โปรเจกต์แก้แล้ว
- **ยังไม่ได้ deploy worker บน cloud และยังไม่เปิด live publishing**
- Page Token แบบ long-lived ตรวจผ่านแล้ว (`expires_at=0`); ข้อจำกัด data access อยู่ใน `FACEBOOK_SETUP.md`
- ทดสอบจริง: job `21da7ed2-03fd-4fa3-816b-a93ac1981674`, submission key `8e9924d8-396b-4fe4-9a49-ebaa4baf2168`, video `2259892561246328`; Meta ยืนยัน ready/published และปิด destination live gate กลับแล้ว
- โพสต์แรก `2259892561246328` มี caption เพี้ยนจาก Python stdin cp1252 บน Windows; แก้ explicit UTF-8 แล้ว และลบโพสต์แรกสำเร็จตามคำสั่งผู้ใช้
- โพสต์ใหม่: https://www.facebook.com/reel/1603602201080908/ — job `6e3c336d-c7f9-4d45-92cd-809a5198c534`, submission key `c4c4e980-efbd-460a-b90e-9d73a43f7bfd`; Graph ยืนยัน ready/published และ description ตรง snapshot ทั้งภาษาไทย/แท็ก/ราคา ปิด live gate กลับแล้ว
- Regression test encoding: `node scripts/test-publishing-encoding.mjs` ตรวจ Thai/emoji ผ่าน cp1252, cp874 และ UTF-8 โดยไม่เรียก API
- สคริปต์ admin `scripts/publish-approved-project.mjs` เปิด gate ชั่วคราว ส่งเฉพาะงานที่อนุมัติ และปิดใน finally; ต้องใช้ submission key เดิมหลัง interruption ห้ามสร้าง key ใหม่เพื่อ retry งาน uncertain

## API

ต้อง login เป็น app owner และมีสิทธิ์ workspace/สื่อ; API ใช้ session ของผู้ใช้และ Origin ที่ตรง `APP_ORIGIN` ไม่มี service key ในเว็บ

### สร้างคำสั่ง

`POST /api/projects/{projectId}/publish`

```json
{
  "submissionKey": "a-new-uuid-for-each-intended-publication",
  "scheduledAt": null,
  "mode": "simulation"
}
```

ตัวอย่าง UUID ข้างต้นต้องแทนด้วย UUID จริงจาก `crypto.randomUUID()` หาก retry คำสั่งเดิมให้ใช้ key เดิมและ payload เดิม ห้ามสร้าง key ใหม่ทุกรอบ retry

`scheduledAt: null` หมายถึงเข้าคิวทันที หรือส่ง ISO timestamp ที่มี timezone

ตอบ HTTP 202:

```json
{
  "id": "publishing-job-uuid",
  "mode": "simulation",
  "published": false
}
```

การตอบรับเป็นเพียงเข้าคิว ไม่ใช่ยืนยันว่า Facebook เผยแพร่แล้ว

คำสั่ง live จาก UI ต้องเพิ่ม `confirmLive:true` และ `expectedUpdatedAt` ตรง `updated_at` ล่าสุด; หากข้อมูลเปลี่ยนตอบ 409 ให้โหลดโปรเจกต์ใหม่ก่อนยืนยัน

### ดูสถานะ

`GET /api/projects/{projectId}/publishing`

ตรวจสิทธิ์โปรเจกต์ก่อนอ่านงานและสถานะรายปลายทาง รวม external post ID, URL และ `delivery_uncertain`; ตอบ `destination` (Page ID/name, enabled/live_enabled) และ `liveEnabled` ของ web API โดยไม่ส่ง token กลับมา

UI ยังไม่ทำให้ worker เริ่มเอง: ต้อง deploy/run worker และเปิด live gates โดย admin เมื่อพร้อมใช้งาน ปัจจุบันยังปิดอยู่ ไม่มีการเปิด flag อัตโนมัติจาก browser

### Live publishing — ยังปิดไว้

ต้องเปิดครบทุกชั้นหลังผู้ใช้ยืนยัน **เนื้อหา snapshot และเพจปลายทาง**:

1. Workspace destination: `enabled=true`, `live_enabled=true` (admin เท่านั้น)
2. Web API: `FACEBOOK_LIVE_ENABLED=true`
3. คำสั่ง: `mode=live`, `confirmLive=true`
4. Worker: `WORKER_MODE=live`, `FACEBOOK_LIVE_ENABLED=true` และ Page token/Page ID ตรงกับ snapshot
5. Lease อย่างน้อย 120 วินาที; ค่าแนะนำ 300 วินาที

คำสั่ง simulation ไม่เปลี่ยนเป็น live แม้เปลี่ยน config worker ทีหลัง หากต้องเผยแพร่จริงต้องสร้างคำสั่ง live ที่ได้รับการยืนยันแยกใหม่

อย่าเปิด flag เหล่านี้เพื่อทดลองแบบไม่ตั้งใจ API จะสามารถสร้างโพสต์สาธารณะได้เมื่อทุกชั้นเปิดครบ

## เพจและ workspace

ตาราง `facebook_destinations` เก็บเฉพาะ workspace/Page ID/ชื่อและ flags ไม่เก็บ token ผู้ใช้เปลี่ยนปลายทางเองไม่ได้

ตั้งค่าครั้งนี้ผูก personal workspace ของเจ้าของกับ **Elephant-Maker**, Page ID `1182106911641987`; `live_enabled=false`

คำสั่ง admin ต่อไปนี้จะตั้งปลายทางจาก `.env.facebook` และ **ปิด live ทุกครั้ง**:

```sh
pnpm dlx node@22 scripts/configure-facebook-destination.mjs --owner-email your-owner-email@example.com
```

## Worker และ Docker

`worker/main.py` ใช้ Python standard library และรันแบบ bounded ได้:

```sh
python -m worker.main --once
```

ต้อง inject config เฉพาะฝั่ง server:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` แบบใหม่ **หรือ** legacy `SUPABASE_SERVICE_ROLE_KEY`
- `WORKER_MODE=simulation` เป็นค่าเริ่มต้น
- `POLL_SECONDS=5`, `LEASE_SECONDS=300`
- เฉพาะเมื่อเตรียม live: `FACEBOOK_PAGE_ACCESS_TOKEN`, `FACEBOOK_PAGE_ID`, `FACEBOOK_GRAPH_VERSION=v27.0`
- `FACEBOOK_LIVE_ENABLED=false` เป็นค่าเริ่มต้น

ไม่ส่ง Supabase secret หรือ Page token ไป frontend หรือ Pi ห้ามใช้ secret key แบบ `sb_secret_...` เป็น JWT; transport แยก modern apikey กับ legacy Bearer JWT แล้ว

`.env.worker` ยังต้องเตรียมสำหรับ deployment โดยคัดลอก template และใส่ค่าบนเครื่อง/secret manager ที่จะรัน worker อย่านำ DB password จาก `.env.admin` ไปใส่ worker

ใช้ override สำหรับการฉีด Facebook env เฉพาะ worker:

```sh
docker compose -f compose.yaml -f compose.facebook.yaml --profile worker up --build -d
```

Override ตั้งโหมด simulation และ `FACEBOOK_LIVE_ENABLED=false` ชัดเจน เว็บไม่โหลด `.env.facebook` จาก override นี้ ส่วน cloud production ควรใช้ secret manager แทนไฟล์ dotenv

ยังไม่ได้ทดสอบ build/run Docker image ในรอบนี้ และยังไม่ได้เลือกหรือสร้างบริการ cloud ที่มีค่าใช้จ่าย

## การกันโพสต์ซ้ำและผลไม่แน่นอน

- Queue claim ใช้ parent-first row locks + `SKIP LOCKED` และ lease token
- ก่อนส่งจริง worker ต้องบันทึก dispatch marker ผ่าน fenced `begin_target_dispatch`
- HTTP 400 กลุ่ม auth/validation ที่ระบุได้แน่ชัดเป็น failed; แสดง error code โดยไม่แสดง token/response body
- Network timeout, HTTP 5xx หรือ response สำเร็จแต่หา post ID ไม่ได้ เป็น `blocked` และ `delivery_uncertain=true`
- หาก worker หายหลังเริ่มส่งหรือบันทึกผลไม่ได้ เมื่อ lease หมดระบบจะบล็อกเพื่อ reconcile ไม่เรียก Facebook ซ้ำอัตโนมัติ
- Manual retry ของงาน uncertain หรือมี dispatch marker ถูกปฏิเสธ ต้องตรวจผลที่ Facebook ก่อน ผู้ใช้ทั่วไปไม่มีสิทธิ์เคลียร์ marker เอง
- ระบบไม่ได้อ้างว่ารับประกัน exactly-once กับ API ภายนอกทุกกรณี

## ทดสอบ

```sh
pnpm test
python -m unittest discover -s tests -p 'worker*test.py' -v
pnpm dlx node@22 node_modules/next/dist/bin/next build
pnpm dlx node@22 scripts/test-publishing-simulation.mjs
```

Live-database simulation test สร้างบัญชีชั่วคราวและ content แบบไม่มีไฟล์ ทดสอบ auth/Origin/live gates, idempotency, snapshot แล้วรัน worker simulation หนึ่งงานก่อนล้างข้อมูลทั้งหมด ไม่โหลด Page token และไม่เรียก Facebook API

หากมี pending/processing targets ของคนอื่น สคริปต์จะข้ามการรัน worker เพื่อไม่หยิบงานของผู้อื่น

## ขั้นต่อไป

- เลือก cloud container provider และยืนยันงบก่อน deploy
- ตรวจอายุและกระบวนการต่ออายุ/reconnect Page token
- ให้ผู้ใช้เลือก content project ที่จะทดสอบ และยืนยันข้อความ/รูป/เพจ ก่อนเปิด live ชั่วคราว
- ตรวจผลโพสต์จริงและบันทึก external ID/permalink
- เพิ่มหลายรูป, custom video thumbnail และการติดตาม processing status ใน worker ภายหลัง (การทดสอบครั้งนี้ตรวจ ready/published แยกผ่าน Graph)
- เชื่อม Pi ผ่าน credential แบบจำกัด workspace ไม่ให้ Pi ถือ service role หรือ Page token
