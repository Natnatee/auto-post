# Autopost — ศูนย์จัดการโพสต์ส่วนตัว

เว็บส่วนตัวแบบเรียบง่าย ธีมฟ้า–ขาว มีสองหน้า: `/` สำหรับอัปโหลด/สร้าง/แก้ไข และ `/library` สำหรับดูโปรเจกต์ทั้งหมด พร้อมวงกลมหมุนระหว่างโหลดข้อมูลหรือบันทึก

**ไม่มี Pi อยู่ในเส้นทางรับส่งไฟล์** มือถือ/คอมอัปโหลดตรงเข้า private cloud storage ส่วนเว็บรับเฉพาะ JSON metadata และ cloud worker ดูแลคิว

## ระบบเก็บคอนเทนต์

ตั้งค่า Supabase ที่ผู้ใช้ให้มาและทดสอบ Auth, PNG/MP4 direct upload, TUS, metadata, signed read URL และ cross-owner RLS กับ cloud จริงแล้ว ดูผลใน `STORAGE_STATUS.md`

- `/`: ฟอร์มอัปโหลดวิดีโอ ภาพปก ภาพรอง ชื่อ แท็ก รายละเอียด และราคาเป็นบาทแบบไม่บังคับ; กดบันทึกแล้วไปหน้าโปรเจกต์ โดยไม่สร้างงานโพสต์
- `/library`: แสดงโปรเจกต์ทั้งหมด เปิดไฟล์ แก้ไขผ่าน `/?edit=<project ID>` และกด **เผยแพร่ Facebook** เพื่อดู caption/สื่อ/เพจ ยืนยันส่ง และติดตามสถานะพร้อมลิงก์โพสต์ได้
- หน้า `/queue`, `/media`, `/settings` และ UI เลือกแพลตฟอร์ม/ตั้งเวลา ถูกนำออกแล้ว ส่วน backend/worker ยังเก็บไว้สำหรับเชื่อมระบบสั่งงานภายหลัง
- แท็กเพิ่มด้วยปุ่ม `+` หรือ Enter ไม่ต้องพิมพ์ `#`; ลบแต่ละแท็กได้ และรองรับแท็กเริ่มต้น
- ราคาเว้นว่างเป็น `null`, รองรับ `0` และทศนิยมไม่เกิน 2 ตำแหน่ง; ภาพเดียวใช้เป็นปกและภาพรองได้โดยอัปโหลดครั้งเดียว
- เลือกไฟล์พักไว้ใน browser ก่อน กดบันทึกจึงอัปโหลดทั้งหมดแล้วบันทึกโปรเจกต์; รีโหลด/ปิดหน้าก่อนบันทึกจะเสียรายการไฟล์ที่เลือก แต่ไม่สร้างไฟล์บน cloud
- หากเริ่มบันทึกแล้วล้มเหลว ไฟล์ที่สำเร็จยังอยู่ในคลัง กดบันทึกซ้ำในหน้าเดิมจะไม่อัปโหลดไฟล์เหล่านั้นซ้ำ ไม่ใช่ธุรกรรม atomic ข้าม Storage กับ DB
- `.env`: ค่าเว็บ / publishable key
- `.env.admin`: secret key และ DB password สำหรับ admin scripts เท่านั้น ไม่ถูกเว็บโหลด
- บัญชีเจ้าของและ personal workspace ตั้งค่าแล้ว ไม่มีบัญชีทดสอบค้างอยู่
- ถ้าเครื่องยังใช้ Node 20 ให้รัน `pnpm dlx node@22 node_modules/next/dist/bin/next dev`

## สถานะรอบแรก

| ส่วน | สถานะ |
|---|---|
| หน้าเว็บภาษาไทย รองรับมือถือ/คอม | หน้าอัปโหลด + หน้าโปรเจกต์เท่านั้น ธีมฟ้า–ขาว มี spinner ระหว่างโหลด |
| แท็ก | เพิ่มด้วย `+`/Enter และลบเป็นรายแท็ก ใช้ค่าเริ่มต้นที่มีอยู่หรือ `สร้างสรรค์`; ไม่มีหน้าตั้งค่าแยก |
| ไม่มี credentials | เปิด UI preview ที่ระบุชัดว่าเป็นข้อมูลตัวอย่าง ปิดการบันทึก/อัปโหลดจริง |
| Login ส่วนตัว | Supabase email/password + `app_owners` allowlist ไม่มีหน้าสมัครสมาชิก |
| อัปโหลด | Browser → Supabase Storage โดยตรง ผ่าน signed token; ภาพเล็กใช้ SDK วิดีโอ/ไฟล์ใหญ่ใช้ TUS chunks 6 MiB |
| Metadata และการตั้งเวลา | PostgreSQL + RLS, บันทึกโพสต์และปลายทางแบบ atomic |
| Worker | Docker, ทำทีละปลายทาง, lease token, reclaim งานค้าง สูงสุด 3 attempts |
| Simulation | ทำงานคิวจริง แต่จบเป็น `simulated` ไม่ใช่ `published` และไม่เรียก social API/ดาวน์โหลดสื่อ |
| Facebook adapter | มีข้อความล้วน/รูป JPEG หรือ PNG ไฟล์เดียว/MP4 แบบ video-first พร้อม snapshot และ dispatch guard; live ปิดอยู่ ดู `PUBLISHING.md` |
| แพลตฟอร์มอื่น | X/TikTok/YouTube live adapters ยังไม่พัฒนา |
| Credentials แพลตฟอร์ม | ค่อยตั้งค่าและเชื่อม API ทีละแห่งในรอบถัดไป เติม key อย่างเดียวยังไม่ทำให้โพสต์ได้ |
| ลบไฟล์ / retention | ยังไม่มีปุ่มลบหรือ cleanup อัตโนมัติ ต้องจัดการผ่าน admin อย่างระวัง |

ข้อมูลตัวอย่างอยู่ใน frontend เท่านั้น ไม่ seed ลงฐานข้อมูลจริง ใช้ Supabase project ที่ผู้ใช้ให้มาและ apply migrations 001–007 แล้ว ทดสอบด้วยบัญชี/ข้อมูลชั่วคราวและล้างออก ไม่ได้ deploy เว็บหรือ worker บน cloud

## สถาปัตยกรรม

```text
มือถือ / คอม ─── อัปโหลดไฟล์ตรง ──→ Supabase private Storage
     │                                      │
     └── title / hashtag / เวลา ──→ Next.js API
                                        │
                                 Supabase PostgreSQL
                                        │
                                 Cloud worker (Docker)
                                        │
                            Facebook adapter / แพลตฟอร์มอื่นในรอบถัดไป
```

เว็บไม่มี service-role key และไม่รับ multipart/file body; API JSON จำกัด 64 KiB ไฟล์ไม่ผ่าน Next.js หรือ Pi

เมื่อพัฒนา live adapter หาก API รับ URL ได้ ให้แพลตฟอร์มดึงจาก storage; หากต้องอัปโหลด bytes ให้ worker บน cloud ทำงาน ไม่ย้ายไฟล์กลับมาที่ Pi

## เปิดดู UI ตอนนี้

ใช้ **Node.js 22+** และ pnpm 9.15.4:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

เปิด `http://localhost:3000` ได้โดยยังไม่ต้องมี `.env.local` จะเป็น preview พร้อมป้าย DEMO ไม่โพสต์จริง ข้อมูล demo ไม่ได้บันทึกหลังรีโหลด

หรือ Docker Desktop / Docker Engine:

```sh
docker compose up --build -d web
```

Docker ใช้ Node 22 และ bind ที่ `127.0.0.1:3000` โดยเริ่มต้น การเปิดจากมือถือจริงต้องตั้ง HTTPS URL, reverse proxy/deployment และ `APP_ORIGIN` ให้ตรง ไม่ควรเปิด HTTP พร้อมรหัสผ่านออกอินเทอร์เน็ต

## ตั้ง Supabase ภายหลัง

ใช้ **Supabase project แยกจาก Elephant Maker** ห้ามนำ migration นี้ไปรันบนฐานข้อมูล Elephant Maker

1. สร้าง project และตรวจโควตา/ค่าใช้จ่ายก่อน ใช้บริการที่รองรับขนาดไฟล์ที่จะอัปโหลด
2. สำหรับ project ใหม่ รัน `supabase/migrations/001_initial.sql`, `002_post_description.sql`, `003_content_library.sql`, `004_shared_media_roles.sql`, `005_content_price.sql` แล้ว `006_project_publishing.sql` ตามลำดับ ใน project ใหม่นั้น **ครั้งเดียวต่อ migration** ผ่าน SQL Editor หรือ migration workflow ของคุณ รันเฉพาะ migration ที่ยังไม่เคย apply; project `xnfoeyadgtzkotdcjzpa` apply ครบแล้ว ห้ามรัน SQL ซ้ำตรง ๆ ใช้ `scripts/migrate.mjs --apply` ที่ตรวจ checksum และข้ามรายการเดิมได้
3. สร้างผู้ใช้เจ้าของใน Supabase Auth ผ่านช่องทาง admin แล้วปิด public signup ไม่ใส่ตัวเลือก signup ในเว็บ
4. เพิ่ม UUID ของผู้ใช้นั้นใน `public.app_owners` ผ่าน SQL Editor เช่น:

```sql
insert into public.app_owners(user_id)
select id from auth.users where email = 'your-owner-email@example.com';
```

ตรวจว่ามีเพียงบัญชีเจ้าของที่ตั้งใจอนุญาต คำสั่งผ่านหน้าเว็บไม่สามารถเพิ่มตัวเองเข้า allowlist ได้

5. ตั้ง Auth Site URL / redirect allowlist ให้ตรง deployment และตรวจ email confirmation / recovery / rate limits
6. สำหรับรันด้วย pnpm: คัดลอก `.env.example` เป็น `.env.local` แล้วใส่ `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `APP_ORIGIN`
7. สำหรับ Docker: คัดลอก `.env.example` เป็น `.env` แล้วใส่ค่าเดียวกัน Compose ส่งให้เฉพาะ web container ตามรายการที่ระบุ
8. รีสตาร์ตเว็บและ login ด้วยบัญชีเจ้าของ

Storage bucket ชื่อ `social-media` เป็น private จำกัด MIME ตามรายการและขนาดสูงสุดที่แอปกำหนด 2 GiB **แต่ขนาดที่ใช้ได้จริงยังขึ้นกับเพดาน Storage ของแผน Supabase และค่าระดับ project** SQL นี้ไม่ได้อัปเกรดแผนหรือขยายโควตาให้โดยอัตโนมัติ

ไฟล์แต่ละรายการใช้ path `<owner UUID>/<random UUID>.<extension>` ไม่ทับไฟล์เดิม ตรวจ MIME/ขนาดจาก storage metadata ก่อนเปลี่ยนเป็น ready การตรวจนี้ไม่ใช่ antivirus หรือการตรวจ codec และยังต้องเพิ่ม platform-specific media validation ก่อนโพสต์จริง

### ลักษณะการอัปโหลด

- ไฟล์เล็กอัปโหลดด้วย `uploadToSignedUrl`
- วิดีโอ/ไฟล์เกิน 6 MiB ใช้ TUS + signed token + publishable apikey + access token ของผู้ใช้ที่ตรวจสอบแล้ว, 6 MiB/chunk และ retry ในหน้าปัจจุบัน; token อยู่เฉพาะหน่วยความจำ ไม่เก็บใน localStorage
- ใช้ direct storage hostname สำหรับ Supabase cloud ตามคำแนะนำของ Supabase
- **ยังไม่มี flow กู้ upload ticket หลังปิดหน้าเว็บ/รีโหลด** อย่าอ้างว่าปิดหน้าแล้วกลับมา resume ได้แล้ว
- ยังไม่มี media thumbnail จริงใน UI ภาพแสดงเป็นสัญลักษณ์/ภาพประกอบที่ติดป้ายชัดเจน
- หากอัปโหลดสำเร็จแต่ complete ล้มเหลว ให้ตรวจ storage/metadata ผ่าน admin; ยังไม่มีปุ่ม recover ใน UI
- ไม่ลบ failed/orphan uploads อัตโนมัติ ต้องติดตาม storage usage และวาง retention ก่อนใช้งานหนัก

## เปิด worker บน cloud

worker ปัจจุบันเป็น **long-running process ที่ poll ทุก 5 วินาที** ไม่ใช่ scale-to-zero/event-driven worker และต้องมีเครื่องหรือบริการ container ที่รันงานนี้ได้ตลอดเวลา ขณะนี้ยังไม่เลือกหรือสร้างผู้ให้บริการ

คัดลอก `.env.worker.example` เป็น `.env.worker` แล้วตั้ง:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` แบบใหม่ หรือ legacy `SUPABASE_SERVICE_ROLE_KEY` เฉพาะ worker; ห้ามใส่ใน web env หรือ frontend
- `WORKER_MODE=simulation`

```sh
docker compose --profile worker up --build -d
```

หรือ build worker แยกเพื่อนำไป deploy บน cloud:

```sh
docker build -f worker/Dockerfile -t auto-post-worker .
```

ไม่จำเป็นต้องรัน web และ worker เครื่องเดียวกัน ทั้งคู่ใช้ฐานข้อมูลเดียวกัน การกำหนด env ของ web ไม่ส่ง service-role key ให้เว็บโดยอัตโนมัติ

โหมดถูกบันทึกใน snapshot ของแต่ละงาน ไม่เปลี่ยนตาม worker env ภายหลัง Facebook ต้องผ่าน live gates ทั้ง API, workspace และ worker รวมถึงการยืนยันเนื้อหา จึงอาจสร้างโพสต์สาธารณะได้จริง ห้ามเปิดเพื่อทดลองโดยไม่ยืนยัน ดู `PUBLISHING.md`; แพลตฟอร์มอื่นยัง blocked

ค่าใช้จ่ายที่ต้องพิจารณา: Storage, database, worker compute และ data egress จากการกระจายไฟล์ไปหลายแพลตฟอร์ม อัปโหลดครั้งเดียวจากมือถือไม่ได้แปลว่าปลายทางทั้งสี่จะไม่ใช้ทราฟฟิกเพิ่ม

## สิทธิ์และการจัดการคิว

- API ตรวจผู้ใช้จริงผ่าน `auth.getUser()` และ allowlist ทุก request ที่เข้าถึงข้อมูล
- RLS แยกข้อมูลตาม owner; browser ไม่มีสิทธิ์แก้สถานะเผยแพร่หรือ lease เอง
- POST ตรวจ Origin เทียบ `APP_ORIGIN` ไม่เชื่อ Host header และตอบข้อมูล private แบบ `no-store`
- Worker เท่านั้นเรียก `claim_target` / `finish_target` ด้วย service role ได้
- ใช้ `FOR UPDATE SKIP LOCKED` และ lease token กัน worker หลายตัว claim งานเดียวกันพร้อมกัน
- งาน lease หมดอายุที่ยังไม่เริ่ม dispatch reclaim ได้สูงสุด 3 attempts; งานที่เริ่มส่งแล้วจะ blocked เพื่อ reconcile ไม่ส่งซ้ำอัตโนมัติ ไม่มี UI คิวงานในเว็บสองหน้า
- สถานะ `completed` ระดับโพสต์ใน simulation หมายถึงจำลองครบปลายทาง ไม่ได้หมายถึงโพสต์จริง ให้ดูสถานะ `simulated` และ banner ประกอบ
- Lease ไม่รับประกัน exactly-once publication กับ API ภายนอก ก่อนทำ live ต้องเพิ่ม remote idempotency / reconciliation และ heartbeat หากอัปโหลดนานกว่า lease
- อย่าเก็บ password, token, private key, `.env` หรือสื่อส่วนตัวใน Git

## โครงสร้าง

```text
src/app/page.tsx               หน้าอัปโหลด/สร้าง/แก้ไข
src/app/library/page.tsx       หน้าโปรเจกต์ทั้งหมด
src/components/content-library.tsx  ฟอร์ม / auth / direct upload / รายการโปรเจกต์
src/app/globals.css            responsive UI
src/app/api/[...path]/route.ts auth, dashboard, upload tickets, posts, retry
src/lib/validation.ts          ข้อจำกัด input
src/lib/http.ts                CSRF origin + JSON size limit
supabase/migrations/           schema, RLS, Storage policy และ queue RPC
worker/main.py                 cloud worker + Facebook adapter + live safety gates
tests/                         frontend contracts, local PostgreSQL RLS/queue, worker
scripts/smoke.mjs               HTTP smoke test แบบเปิด server ชั่วคราวแล้วปิด
Dockerfile                     เว็บ Node 22 non-root
worker/Dockerfile              worker Python 3.12 non-root
compose.yaml                   local/deploy container definition
```

## ตรวจสอบ

```sh
pnpm test
pnpm typecheck
pnpm build
node scripts/smoke.mjs
python -m unittest discover -s tests -p 'worker*' -v
docker compose config --quiet
pnpm exec playwright test
```

Browser tests ใช้ Chromium หลัง `pnpm exec playwright install chromium` หรือใช้ Edge ที่มีอยู่บน Windows ผ่าน Git Bash: `PLAYWRIGHT_CHANNEL=msedge pnpm exec playwright test` ทดสอบจอมือถือและ desktop ว่าไม่ล้นแนวนอน, navigation สองหน้า, staged uploads/retry, แท็ก ราคา login/logout และ loading spinner; หน้าอัปโหลดเลื่อนแนวตั้งได้เพื่อเข้าถึงทุกช่อง

Database tests ใช้ PostgreSQL ใน PGlite พร้อม mock schema `auth`/`storage` ในเครื่อง ไม่ติดต่อหรือแก้ Supabase จริง จึงยังต้องทดสอบ Auth, RLS และ direct upload กับ Supabase project ใหม่หลังตั้ง credentials

## งานถัดไป

ดู `TODO.md` — โดยเฉพาะ OAuth/API สิทธิ์บัญชีและชนิดโพสต์ของแต่ละแพลตฟอร์ม อย่าสมมติว่าบัญชีทุกประเภทโพสต์อัตโนมัติได้
