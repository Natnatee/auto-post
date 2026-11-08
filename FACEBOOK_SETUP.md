# Facebook Page connection

## ตรวจสอบแล้ว

- Meta app: **AutoPost**, App ID `2034383707224695`
- Facebook Login for Business configuration: **Elephant-Maker Publishing**, ID `1421009816678788`
- Token type ของ login configuration: User access token; ใช้ขอ Page access token ต่อ
- เพจเป้าหมาย: **Elephant-Maker**, Graph Page ID `1182106911641987`
- Graph API version ที่ใช้ทดสอบ: `v27.0`
- สิทธิ์ที่ผู้ใช้อนุญาต: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `public_profile`
- Page tasks ที่ตรวจพบมี `CREATE_CONTENT` และ `MANAGE`
- เรียกอ่านข้อมูลเพจด้วย Page token จาก server สำเร็จ ยืนยัน id/name ตรงกัน
- ผู้ใช้อนุมัติทดสอบจริง 2026-11-05: **Bat_Halloween** วิดีโอพร้อมข้อความ/ราคา/แท็กเดิม; Meta ยืนยัน ready/published: https://www.facebook.com/reel/1603602201080908/ — ปิด live gate กลับแล้ว; ลบโพสต์ทดสอบแรกที่ภาษาเพี้ยนและส่งใหม่ตามคำสั่งผู้ใช้ ตรวจ caption จาก Graph ตรง snapshot แล้ว

เลข `61589773122607` ใน URL โปรไฟล์ Facebook กับ Graph Page ID ข้างต้นเป็นคนละ identifier; ใช้ ID ที่ตรวจผ่าน Graph API สำหรับการเรียก API

## การเก็บสิทธิ์

Page token อยู่ใน `.env.facebook` สำหรับ server-side development เท่านั้น ไม่ใช้ชื่อ `NEXT_PUBLIC_*` ไม่ถูก Next.js โหลดอัตโนมัติ และถูก `.gitignore` / `.dockerignore` กันไว้แล้ว ไม่เก็บ user access token หรือ Facebook password ในไฟล์นี้

ไฟล์ส่งผ่านชั่วคราวใน Downloads ถูกลบหลังตรวจและบันทึกสำเร็จ ไม่พิมพ์ token ลง console/แชต

ก่อน deploy worker ต้องนำ token เข้า secret manager ของ cloud และฉีดให้เฉพาะ publishing worker ไม่ใส่ใน frontend หรือ Pi

## ตรวจการเชื่อมต่อซ้ำ

```sh
pnpm dlx node@22 scripts/check-facebook.mjs
```

คำสั่งอ่านข้อมูลเท่านั้น ไม่สร้าง/แก้/ลบโพสต์ และไม่พิมพ์ token

## ขอบเขตความพร้อม

- เชื่อมและตรวจสิทธิ์กับ Meta สำเร็จ มี Facebook adapter สำหรับข้อความ/รูปเดียวแล้ว ทดสอบ mock และคิวจริงแบบ simulation ผ่าน แต่ยังไม่ deploy worker และ live gates ยังปิด
- รายละเอียดคำสั่ง snapshot/idempotency และขั้นเปิด live หลังยืนยันเนื้อหา อยู่ใน `PUBLISHING.md`
- วันที่ 2026-11-05 แลก User Token แบบ long-lived (~60 วัน) ฝั่ง server และขอ Page Token ใหม่สำเร็จ; `/debug_token` ยืนยัน `is_valid=true`, `type=PAGE`, App ID ถูกต้อง และ `expires_at=0` (ไม่มีวันหมดอายุที่กำหนดไว้) พร้อมตรวจ `/me` ตรงกับ Elephant-Maker
- Meta รายงาน `data_access_expires_at=1801612879` (2027-02-03 00:01:19 UTC) แยกจากอายุ token; ต้องติดตามสถานะสิทธิ์และอาจต้องอนุญาตใหม่ ไม่ถือว่าใช้งานได้ถาวรโดยไม่มีเงื่อนไข
- บันทึก Page Token ใหม่ใน `.env.facebook` แล้ว ลบไฟล์ส่งผ่าน App Secret/User Token ใน Downloads แล้ว ไม่เก็บสองค่านี้ถาวร; live gates ยังคงปิด
- การถอนสิทธิ์ การเปลี่ยนสิทธิ์เพจ หรือข้อจำกัดบัญชีอาจทำให้ token ใช้ไม่ได้ ต้องมี reconnect/error handling
- การโพสต์จริงครั้งต่อไปยังต้องให้ผู้ใช้ยืนยันเนื้อหาและเพจปลายทางก่อน ไม่เปิด live ค้างไว้
- ยังไม่ได้เปิดแอปให้บุคคลทั่วไปใช้งาน หรือผ่าน App Review สำหรับการใช้บัญชีภายนอก
