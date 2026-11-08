# Auto-post — Roadmap

## รอบแรก: โครงระบบและ simulation

- [x] Mobile-first แบบสองหน้า: อัปโหลด / โปรเจกต์ทั้งหมด
- [x] ธีมฟ้า–ขาวและวงกลมหมุนระหว่างโหลด
- [x] แท็กเริ่มต้นและปุ่ม + เพิ่มแท็ก โดยไม่มีหน้าตั้งค่าแยก
- [x] รายละเอียดโพสต์ส่งผ่าน API / PostgreSQL / worker claim
- [x] UI preview เมื่อยังไม่มี credentials แยกจากข้อมูลจริง
- [x] Login ส่วนตัว + owner allowlist + RLS
- [x] Signed direct upload และ TUS retry ในหน้าปัจจุบัน
- [x] Title + hashtag ร่วมกันสำหรับโพสต์หนึ่งงาน
- [x] เข้าคิวทันที / ตั้งเวลา Asia/Bangkok
- [x] Backend เก็บสถานะแยกปลายทาง + retry failed/blocked (ไม่มี UI คิวงานในรอบสองหน้า)
- [x] Atomic queue, lease fencing และ reclaim สูงสุด 3 attempts
- [x] Worker simulation ไม่แอบโพสต์หรือโหลดสื่อ
- [x] Docker web/worker และ env templates แยก secrets
- [x] Input / RLS / lease / worker tests และ production build

## ตั้งบริการและทดสอบกับบัญชีจริง — ให้ผู้ใช้เติม credentials ภายหลัง

- [ ] เลือก Supabase project ใหม่ แผน Storage และงบ egress
- [ ] Apply migration เฉพาะ project ใหม่ แล้วตั้ง owner / ปิด public signup
- [ ] ทดสอบ login, cross-owner denial, signed upload และ TUS บนมือถือจริง
- [ ] ทดสอบขนาดไฟล์ตาม plan รวมเน็ตหลุดและล้มเหลวระหว่าง complete
- [x] เลือก cloud container provider สำหรับ worker / HTTPS deployment สำหรับเว็บ
- [ ] ทดสอบ Docker build/run บนเครื่องที่ Docker daemon พร้อมใช้งาน
- [ ] ตรวจค่าใช้จ่ายและขีดจำกัด polling/connection ของฐานข้อมูล

## Live adapters — Facebook รุ่นข้อความ/รูปเดียวพร้อมในโค้ด แต่ยังไม่เปิด live

สำหรับทุกแพลตฟอร์ม: ตรวจเอกสาร API ปัจจุบัน สิทธิ์บัญชี/app review, OAuth + refresh/revoke token, เก็บ token ฝั่ง backend แบบปลอดภัย, ตรวจ MIME/codec/duration/size, API rate limits, upload session และตรวจผลโพสต์จริงก่อน mark published

- [x] Facebook: เชื่อมเพจ Elephant-Maker และ adapter ข้อความ/รูป JPEG/PNG ไฟล์เดียว
- [x] API ส่งโปรเจกต์เข้า queue พร้อม immutable snapshot และ submission key
- [x] ทดสอบคิวและ worker จริงแบบ simulation โดยไม่เรียก Facebook POST
- [x] Dispatch marker/fencing และบล็อก retry ผลเผยแพร่ที่ไม่แน่นอน
- [x] Cloudflare Worker publisher (`worker/cloudflare.ts`) พร้อม Cron Trigger ทุก 1 นาที
- [ ] ตรวจ token lifetime, ให้ผู้ใช้ยืนยันเนื้อหา และทดสอบโพสต์แรกจริง
- [x] Deploy worker บน cloud หลังเลือกบริการและงบ (Cloudflare Workers: `auto-post-worker`)
- [ ] Facebook หลายรูป/วิดีโอ
- [x] X: สร้างแอป AutoPost-Studio, ตั้งสิทธิ์ Read and Write, ดึง OAuth 1.0a & OAuth 2.0 Credentials เรียบร้อย (`.env.x`)
- [x] X: พัฒนา X API v2 Publishing Adapter พร้อม HMAC-SHA1 Signer (`src/lib/x.ts` + `tests/x.test.ts`)
- [x] X: ตรวจสอบการยืนยันตัวตนสำเร็จกับบัญชี Decray CH (`@elephant_maker`)
- [x] TikTok: สร้างแอป AutoPost Studio, เปิดสิทธิ์ Content Posting API (Direct Post/Draft), ดึง Client Key/Secret เรียบร้อย (`.env.tiktok`)
- [x] TikTok: Adapter สำหรับอัปโหลดวิดีโอ Direct Post (`src/lib/tiktok.ts` + `tests/tiktok.test.ts`)
- [ ] TikTok: เชื่อมต่อ OAuth สิทธิ์บัญชีเป้าหมาย และทดสอบโพสต์วิดีโอแรกใน Sandbox
- [x] YouTube: ตั้งค่า Google Cloud App, เปิด YouTube Data API v3 และแลก Long-lived OAuth Refresh Token สำเร็จ (`.env.youtube`)
- [x] YouTube: Adapter สำหรับอัปโหลดวิดีโอ/Shorts จริงจากคลัง Supabase (`src/lib/youtube.ts` + `tests/youtube.test.ts`)
- [x] Facebook Affiliate: เชื่อมต่อ Shopee Affiliate สำเร็จบนเพจ Elephant-Maker
- [ ] Remote idempotency/reconciliation กันโพสต์ซ้ำเมื่อคำตอบ API หรือ network หาย
- [ ] Lease heartbeat / resume upload สำหรับงานที่เกิน 300 วินาที
- [ ] Rate-limit backoff และ retry classification แยกแต่ละแพลตฟอร์ม
- [ ] อนุญาตแก้ title/hashtag แยกปลายทางเมื่อจำเป็น (รอบแรกใช้ข้อความร่วม)

## ความทนทานและ UX

- [ ] Signed thumbnail preview ที่ตรวจ owner ไม่เปิด bucket public
- [ ] กู้ upload ticket / resume หลัง browser restart
- [ ] จัดการไฟล์ที่อัปโหลดแล้วแต่ complete ไม่สำเร็จ
- [ ] ลบสื่อโดยตรวจว่าไม่มีงานค้างอ้างอิง / orphan cleanup / retention
- [ ] Pagination เกิน 100 รายการ, ค้นหาและกรองคิว
- [ ] แก้ไข / ยกเลิกงานที่ยังไม่เริ่ม
- [ ] Telegram แจ้งผลและแจ้งปัญหา credential หมดอายุ
- [ ] Audit log และ backup metadata
- [x] Browser E2E: ขนาดจอมือถือ, แยกหน้า, แท็กเริ่มต้น และฟอร์ม Deploy (mock API)
- [ ] Accessibility และอุปกรณ์มือถือจริง
