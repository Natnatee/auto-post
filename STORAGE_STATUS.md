# Content Storage — ผลทดสอบจริง

โปรเจกต์ Supabase: `xnfoeyadgtzkotdcjzpa`

## ตั้งค่าแล้ว

- `.env`: public/เว็บ config; ไม่รวม secret key หรือ DB password
- `.env.admin`: admin scripts เท่านั้น ไม่ถูก Next.js โหลด ไม่เข้า Git/Docker context
- Direct PostgreSQL ผ่าน TLS ที่ตรวจ CA และ hostname โดยใช้ Supabase Root CA 2021
- Apply migrations `001_initial.sql`, `002_post_description.sql`, `003_content_library.sql` พร้อมบันทึก checksum ใน `_app_migrations`
- Private bucket `social-media`
- Workspaces/memberships เตรียมแยกเจ้าของและรองรับการขยายในอนาคต
- คลังคอนเทนต์แยกจากคิวโพสต์ที่ `/library`

## ผลทดสอบแบบ end-to-end กับ cloud จริง

- ผ่าน: สร้างบัญชีทดสอบชั่วคราว Login จริงผ่านหน้าเว็บ และตรวจ allowlist
- ผ่าน: เลือกวิดีโอ/ภาพปก/ภาพรองแล้วไม่มี upload request หรือ media metadata บน cloud จนกดบันทึก
- ผ่าน: กดบันทึกแล้วจึงอัปโหลด MP4 จริงที่สร้างจาก ffmpeg ด้วย TUS จาก browser ไป Storage ตรง
- ผ่าน browser mock: ลบไฟล์ก่อนบันทึกไม่ส่ง request; retry หลัง upload completion หรือบันทึกโปรเจกต์ล้มเหลวไม่อัปโหลดไฟล์ที่สำเร็จซ้ำ
- ผ่าน: อัปโหลด PNG ภาพปกและภาพรองด้วย signed upload จาก browser
- ผ่าน: `complete_media` ตรวจ size/MIME แล้วเปลี่ยนเป็น ready
- ผ่าน: บันทึกและแก้ไขโปรเจกต์พร้อมวิดีโอ ภาพปก ภาพรอง ชื่อ แท็ก และรายละเอียด
- ผ่าน: เปิด signed URL และดาวน์โหลดมาตรวจ SHA-256 ตรงกับไฟล์ต้นฉบับทุกไฟล์
- ผ่าน: อีกบัญชีไม่เห็นโปรเจกต์/สื่อและสร้าง signed read URL ให้ไฟล์เจ้าของอื่นไม่ได้
- ผ่าน: anonymous ดาวน์โหลด private object ไม่ได้
- ผ่าน: บันทึกคอนเทนต์แล้วไม่มี publish job ถูกสร้าง
- ผ่าน: ลบบัญชี ไฟล์ metadata โปรเจกต์ และ workspace ชั่วคราวหลังทดสอบ

ไม่ได้ใช้บัญชีผู้ใช้จริง ไม่ทิ้งข้อมูลตัวอย่างในฐานข้อมูล และยังไม่ได้เรียก social API ใด ๆ

## ประเด็นที่พบและแก้แล้ว

TUS ที่ใช้เฉพาะ signed token ถูกปฏิเสธเมื่อใช้ publishable key แบบใหม่ จึงส่ง `apikey` + access token ของผู้ใช้ที่ตรวจสอบแล้ว + `x-signature` ให้ Storage โดยตรง ไม่เปิด bucket public ไม่ยกเลิก RLS และไม่ส่ง service-role/secret key ให้ browser

Access token สำหรับ upload อยู่ในหน่วยความจำของหน้าเว็บ ไม่เก็บใน localStorage เอกสาร/console ไม่บันทึก token หรือ signed URL

## ใช้งานต่อ

ผู้ใช้สร้างบัญชีเจ้าของจริงใน Supabase Auth แล้ว เพิ่มสิทธิ์ `app_owners` และ personal workspace สำเร็จ ไม่ได้กำหนดหรือเก็บรหัสผ่านบัญชีเจ้าของแทนผู้ใช้

เครื่องนี้มี Node 20 เป็นค่าเริ่มต้น แต่ Supabase SDK ต้องใช้ Node 22 จึงเปิด dev แบบนี้ได้:

```sh
pnpm dlx node@22 node_modules/next/dist/bin/next dev
```

หน้า `/` ใช้อัปโหลดและบันทึกคอนเทนต์; `/library` แสดงโปรเจกต์ทั้งหมดและเปิดแก้ไขได้ ตอนนี้เหลือเพียงสองหน้า ธีมฟ้า–ขาวพร้อมวงกลมหมุนระหว่างโหลด ไม่มีหน้า Deploy/คิวงาน/สื่อ/ตั้งค่าแยกแล้ว

## ตรวจซ้ำ

```sh
pnpm dlx node@22 scripts/check-cloud.mjs
pnpm dlx node@22 scripts/migrate.mjs --apply
pnpm dlx node@22 node_modules/next/dist/bin/next build
pnpm dlx node@22 scripts/test-live-storage.mjs
```

Live test ต้องมี Chrome/Edge และ `ffmpeg` ในเครื่อง ใช้บัญชีชั่วคราวและไฟล์ขนาดเล็ก แต่ยังมี API/storage usage จริงตามแผนบริการ

## ยังต้องทำก่อนใช้งานหนัก

- สร้างเจ้าของจริงและปิด public signup ใน Supabase dashboard
- ทดสอบไฟล์ขนาดใหญ่และเน็ตมือถือจริง ปัจจุบันทดสอบไฟล์เล็กเพื่อยืนยันเส้นทาง TUS ไม่ใช่ load test 2 GiB
- จำกัด Storage ตาม plan/งบ และพัฒนา cleanup/retention
- เปลี่ยน secret key/DB password ก่อน production หากเคยเผยแพร่หรือแชร์เกินผู้ที่จำเป็น
- ตั้ง HTTPS และ APP_ORIGIN ของ deployment จริง
- Publishing worker และ Pi ยังไม่เชื่อม live platform APIs
