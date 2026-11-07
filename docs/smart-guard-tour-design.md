# 🛡️ Smart Guard Tour — เอกสารออกแบบระบบ (System Design)

เอกสารนี้อธิบายการออกแบบระบบ **Smart Guard Tour รุ่นใหม่** ซึ่งเชื่อมโยงกับระบบ VVA และแอปที่พัฒนาไว้แล้วเป็นฐานการเชื่อมต่อ แต่ใช้ **ฐานข้อมูลแยกส่วนของตัวเอง** (ไม่ปนกับข้อมูล VVA)

---

## 1. ภาพรวมสถาปัตยกรรม (High-Level Architecture)

ระบบแบ่งเป็น 3 ส่วนหลัก เชื่อมโยงกันผ่าน APIกลาง:

```
┌─────────────────┐     ┌────────────────────────────────────────────┐     ┌─────────────────────┐
│  1) Admin Web   │────▶│  3) บริการกลาง (Core Services)             │◀────│  2) Mobile App      │
│  (Next.js/React)│◀────│  • REST API (Node.js/NestJS หรือ Go)       │────▶│  (Flutter/React     │
│  - จัดการ QR    │     │  • WebSocket Server (Realtime)             │     │   Native)           │
│  - แผนที่/จุดตรวจ│     │  • GPS Ingestion Service                   │     │  - Resident         │
│  - กลุ่มแจ้งเตือน│    │  • Notification Service (LINE/Telegram)    │     │  - Guard            │
│  - รายงาน       │     │  • Scheduler / Job Queue                   │     │  - Staff            │
│  - สิทธิ์ผู้ใช้ │     └──────────────┬─────────────────────────────┘     └─────────────────────┘
┌─────────────────┐                  │                                        ▲
│  ฐานข้อมูลแยกของ Smart Guard Tour     │◀───────────────────────────────────────┘
│  PostgreSQL + PostGIS + Redis + S3/MinIO │   (ตำแหน่ง GPS ส่งจากมือถือเข้าระบบของเราเอง)
└─────────────────┘
```

### หลักการสำคัญ
- **Google Maps ใช้ "แสดงผล" เท่านั้น** — รับ Marker/Polyline ที่อัปเดตมาจาก WebSocket ของเราเอง ไม่ใช้ Google Maps เป็นที่เก็บ/ติดตามตำแหน่ง
- **ตำแหน่ง GPS ทั้งหมดไหลเข้าระบบของเรา**: App → GPS Ingestion API → WebSocket broadcast → แผนที่ (Realtime)
- **ดาต้าเบสแยก**: ฐานข้อมูล `smart_guard_tour` แยก schema/DB จากระบบ VVA เชื่อมต่อกันเฉพาะผ่าน **SSO/Tokenกลาง** (เช่นเดียวกันกับแอปเดิม) ไม่แชร์ตารางข้อมูล

---

## 2. โมเดลข้อมูลหลัก (Database Schema — ฐานข้อมูลแยกของระบบนี้)

### 2.1 ตารางหลัก (PostgreSQL + PostGIS)

| ตาราง | รายละเอียด |
|---|---|
| `users` | บัญชีผู้ใช้ทั้งหมด ผูกกับบัญชี VVA ผ่าน `vva_user_id` (SSO) |
| `roles` / `user_roles` | resident, guard, supervisor (หัวหน้า รปภ.), staff, admin |
| `guard_posts` | ป้อม รปภ. (พิกัด, รัศมี, QR code payload) |
| `checkpoints` | จุดตรวจ (พิกัด `GEOGRAPHY(POINT)`, รัศมีที่ยอมรับ (เช่น 20–50 ม.), ลำดับในเส้นทาง, รหัสจุด `checkpoint_code`) |
| `qr_codes` | QR ที่ระบบหลังบ้านสร้าง (payload ลงลายเซ็นดิจิทัล ป้องกันปลอม)ผูกกับ `guard_post` หรือ `checkpoint` |
| `shifts` | กะตรวจของ รปภ. (เวลาเริ่ม/จบจริง, สถานะ: pending → checked_in → patrolling → checked_out) |
| `gps_tracks` | บันทึกตำแหน่ง (shift_id, lat, lng, accuracy, speed, timestamp, แหล่งที่มา app/background) — partition ตามเดือน |
| `checkpoint_visits` | การเช็คอินจุดตรวจ (รูปภาพ, เวลา, พิกัดตอนถ่าย, ค่า accuracy, checkpoint_code,ผล geofence) |
| `photos` | เก็บเมตาดาต้ารูป (URL ไปยัง S3/MinIO) |
| `reports` / `incidents` | เหตุการณ์/รายงาน พร้อมกลุ่มปลายทาง (LINE/Telegram) ที่กำหนด |
| `notification_groups` | แมปเหตุการณ์ → กลุ่ม LINE/Telegram (เช่น "ไฟดับ" → กลุ่ม A, "คนแปลกหน้า" → กลุ่ม B) |
| `audit_logs` | บันทึกการกระทำทั้งหมด (ใคร ทำอะไร เมื่อไหร่) |

### 2.2 QR Code ที่ระบบหลังบ้านสร้าง
- Admin เลือก **พิกัดแรกบนแผนที่** (Google Maps ใน Admin Web) → ระบบสร้าง `guard_post` พร้อม payload เช่น
  `SGT://post/{post_id}?sig={HMAC-SHA256}` → แปลงเป็น **ภาพ QR** สำหรับปริ้น/พิมพ์ติดที่ป้อม
- สแกนครั้งที่ 1 ที่ป้อม = **เช็คอินเริ่มกะ**, สแกนครั้งที่ 2 = **จบกะ/ส่งงาน** (หรือสแกน QR จุดตรวจท้ายสุดตามที่ออกแบบ)
- ตรวจสอบลายเซ็นดิจิทัลก่อนเสมอ ป้องกัน QR ปลอม

---

## 3. โฟลว์การปฏิบัติงานของ รปภ. (Guard Flow) — ตรงตามเงื่อนไขข้อ 1–5

```
1. ล็อกอิน + ยืนยันตัวตน (OTP/SSO กับ VVA)
        │
2. แสกน QR ที่ป้อม (จุดแรก) ──▶ เช็คอินกะสำเร็จ (shift.status = checked_in)
        │
3. กด "เริ่มปฏิบัติงาน" ──▶ ได้รับสิทธิ์ตามนโยบาย (role/policy check)
   └──▶ เริ่มส่ง GPS ขึ้นระบบทุก N วินาที ( foreground + background service )
        │
4. เดินตรวจตามจุดตรวจ ──▶ เมื่อถึงจุดตรวจ:
   • ถ่ายรูปผ่านแอป → บันทึก (รูป, เวลา, พิกัด GPS, ค่า accuracy, checkpoint_code)
   • ระบบเช็ค geofence: อยู่ในรัศมีจุดตรวจ (เช่น ≤ 50 ม.) ?
        - ใช่  ▶ เช็คอินจุดตรวจ "สำเร็จ" + แจ้ง Realtime
        - ไม่ใช่ ▶ แจ้งเตือน "ออกนอกรัศมี" รอจนเข้าในรัศมี (หรือแจ้งหัวหน้ากรณีผิดปกติ)
        │
5. แสกน QR อีกครั้งเพื่อจบงาน/ส่งกะ ──▶ shift.status = checked_out
   └──▶ สรุปเส้นทาง + รายงานประจำกะ
```

**ข้อ 5 — Geofence check:** ใช้ PostGIS `ST_DWithin(geography)` เทียบระยะจริงบนทรงกลม (ไม่ใช่ระยะบนแผนที่ราบ) พร้อมบันทึกผล `inside_radius: true/false` ลง `checkpoint_visits`

---

## 4. สถาปัตยกรรม Realtime (ข้อ 3) — ไม่พึ่ง Google Maps เป็นแหล่งข้อมูล

```
มือถือ รปภ. ──GPS──▶ GPS Ingestion API ──▶ Redis Stream ──▶ WebSocket Server ──┬─▶ หัวหน้า รปภ. (แผนที่ Realtime)
                                                                              └─▶ Admin Web (แผนที่ Realtime)
                                                                                    │
                                                    Google Maps แสดงผลรับ Marker/Polyline ◀─┘
                                                    ที่อัปเดตจาก WebSocket ของเราเท่านั้น
```

- หัวหน้า รปภ. เห็น **ไอคอนตำแหน่งล่าสุด** ของลูกทีมบนแผนที่ พร้อม **เวลาที่ได้รับตำแหน่ง** (แสดงเป็นป้ายบน Marker เช่น "14:32:05 น.")
- ใช้ **Socket.IO หรือ native WebSocket (ws)** + Redis Adapter (รองรับหลาย instance)
- Track history เก็บลง `gps_tracks` (PostGIS) สำหรับ replay เส้นทางย้อนหลัง

---

## 5. การติดตามตำแหน่งขณะล็อกหน้าจอ / อยู่เบื้องหลัง (Android/iOS)

ตามที่ระบุ: **ต้องใช้ Native Mobile Location Service ไม่ใช่ PWA อย่างเดียว**

### Android
- ขอสิทธิ์ `ACCESS_FINE_LOCATION` + `ACCESS_BACKGROUND_LOCATION` (Android 10+) แบบ runtime พร้อมคำอธิบาย
- ใช้ **Foreground Service** (ชนิด `location`) พร้อม Notification ถาวรขณะปฏิบัติงาน ("กำลังตรวจตรา…") — เป็นข้อบังคับของ Google Play
- FusedLocationProviderClient ส่งตำแหน่งทุก ~10–30 วินาที (ปรับตามความเร็ว/แบตเตอรี่) พร้อม `accuracy`
- Grades: `PRIORITY_HIGH_ACCURACY` ขณะอยู่หน้าแอป, ประหยัดแบตเมื่ออยู่เบื้องหลังแต่ยังอยู่ในกะ
- นโยบาย Google Play: background location ต้องสอดคล้องกับวัตถุประสงค์หลักของแอป (Core App Functionality) — Guard Tour เข้าข่ายเพราะติดตาม รปภ. คือฟีเจอร์หลัก

### iOS
- `Background Modes: Location updates` + Significant Location Change
- ไม่สามารถ guarantee ความถี่สูงเหมือน Android — ออกแบบให้รับได้ว่าบางช่วงจะได้ตำแหน่งห่างขึ้น

### ทางเลือก Native: Flutter + `geolocator`/`background_locator` หรือ React Native + module พื้นเมือง — แนะนำ **Flutter** เพราะ community plugin สำหรับ background location ecosystem ที่ดี

---

## 6. การส่งรายงานไป LINE / Telegram (ข้อ 6)

- ตาราง `notification_groups`: ผูก **ประเภทเหตุการณ์** → **กลุ่ม LINE/Telegram** (เก็บ `line_group_id` / `telegram_chat_id` + bot token)
- Notification Service ส่งเฉพาะกลุ่มที่กำหนดสำหรับเหตุการณ์นั้น เช่น
  - "พบคนแปลกหน้า" → กลุ่มเวรSecurity
  - "อุปกรณ์ชำรุด" → กลุ่ม Maintenance
  - "เริ่ม/จบกะ" → กลุ่มหัวหน้า
- ส่งผ่าน **LINE Messaging API (Push)** และ **Telegram Bot API** พร้อม retry queue (Bull/BullMQ)
- แนบรูปจาก `checkpoint_visits` ได้ (LINE ส่งรูปได้, Telegram ส่งได้เช่นกัน)

---

## 7. สิทธิ์การเข้าถึงของลูกบ้าน (ข้อ 7 — Privacy by Default)

| ข้อมูล | ลูกบ้าน (ค่าเริ่มต้น) | ลูกบ้านที่ได้รับสิทธิ์พิเศษ | หัวหน้า รปภ. | Admin |
|---|---|---|---|---|
| สถานะการตรวจ (กำลังตรวจ/จุดที่เช็คแล้ว/เวลา) | ✅ เห็น | ✅ | ✅ | ✅ |
| ตำแหน่งสด (live GPS) ของ รปภ. | ❌ **ไม่เปิดเผย** | ✅ เฉพาะที่ได้รับอนุญาต | ✅ ทีมตัวเอง | ✅ |
| เส้นทางย้อนหลัง | ❌ | ✅ บางช่วงตามนโยบาย | ✅ ทีมตัวเอง | ✅ |
| รูปถ่ายจุดตรวจ | ตามนโยบาย | ✅ | ✅ | ✅ |

- ใช้ **RBAC + Policy Engine** (เช่น OPA หรือ logic ใน API) ตรวจทุก endpoint
- ค่าเริ่มต้น `share_live_location = false` สำหรับ role `resident` ทุกคน
- ทุกการเข้าถึงตำแหน่งถูกบันทึก `audit_logs`

---

## 8. ความปลอดภัย (Security)

- JWT (access สั้น + refresh) ผ่าน SSO ของระบบเดิม, TLS ทุกการสื่อสาร
- QR payload ลงลายเซ็น HMAC + มีอายุการใช้งาน ป้องกัน replay
- รูปภาพเก็บ S3/MinIO (private bucket) ให้ URL แบบ signed URL อายุสั้น
- Rate limit API ตำแหน่ง (กันส่งถี่เกิน) และตรวจความสมเหตุสมผลของพิกัด (teleport detection: ความเร็วผิดปกติ → flag ให้หัวหน้าตรวจ)
- PDPA: แจ้งนโยบายการเก็บตำแหน่ง Consent ชัดเจน, ลบข้อมูลตามอายุที่กำหนด

---

## 9. ข้อเสนอแนะเพิ่มเติม (Beyond the 7 เงื่อนไข)

1. **SOS / ปุ่มฉุกเฉินในแอป รปภ.** — กดแล้วส่งตำแหน่งสด + แจ้งเตือนกลุ่ม LINE/Telegram ทันที + เปิดเส้นทาง Realtime ให้หัวหน้า
2. **ตรวจ "ไม่ถึงจุดตรวจตามกำหนด" (Missed checkpoint)** — Scheduler คอยเช็คว่าในแต่ละกะมีจุดตรวจใดที่ยังไม่ถูกเช็คภายในเวลาที่กำหนด → แจ้งหัวหน้า
3. **โหมดออフライン**: ถ้าเน็ตขาด เก็บ GPS + รูปไว้ในเครื่อง (queue) แล้ว sync อัตโนมัติเมื่อกลับมาออนไลน์ พร้อมกำกับเวลาจริงที่ถ่าย
4. **Heatmap/สถิติ**: แผนที่ความถี่เหตุการณ์, เวลาตอบสนองเฉลี่ยต่อจุดตรวจ, รายงานประจำสัปดาห์ให้ Admin
5. **Two-person verification** สำหรับจุดสำคัญมาก: ต้องมี รปภ. 2 นายเช็คอินจุดเดียวกัน
6. **Batary/ความพร้อมอุปกรณ์**: รายงาน % แบตของเครื่อง รปภ. บนแดชบอร์ดหัวหน้า
7. **Webhook / API เปิด** ให้เชื่อมกับระบบอื่น (VVA, กล้อง CCTV) ได้ในอนาคต
8. **Multi-site / หลายโครงการ**: ออกแบบ schema รองรับหลาย site ตั้งแต่ต้น (`site_id` ในทุกตาราง)

---

## 10. ไอเดียเสริมที่อยากชวนคิดต่อ

- **AI ตรวจรูปอัตโนมัติ**: วิเคราะห์รูปถ่ายจุดตรวจ (เช่น ตรวจไฟสว่าง, ประตูปิด) แล้ว flag ผิดปกติอัตโนมัติ
- **NFC แทน/เสริม QR** สำหรับจุดที่ QR เสียหายหรือแสงไม่ดี
- **เส้นทางตรวจแบบไดนามิก**: ปรับลำดับจุดตรวจอัตโนมัติตามเหตุการณ์ (เช่น มีแจ้งเตือนที่จุดหนึ่ง → สลับลำดับให้ไปจุดนั้นก่อน)
- **Dashboard สาธารณะ (read-only)** ให้ลูกบ้านดู "สถานะภาพรวม" (เช่น ตรวจครบ 12/15 จุด) โดยไม่ต้องเห็นตำแหน่ง — เพิ่มความโปร่งใสและความรู้สึกปลอดภัย
- **Gamification เล็กน้อย**: ให้คะแนนความสม่ำเสมอของ รปภ. แต่ต้องระวังเรื่องความเป็นส่วนตัว — แนะนำให้แสดงเฉพาะสถิติรวม

---

## 11. เทคโนโลยีที่เสนอ (Technology Stack)

| ส่วน | เสนอ |
|---|---|
| Admin Web | Next.js (React) + Google Maps JS API + Socket.IO client |
| Mobile App | Flutter (Android/iOS ตัวเดียว) + background location plugin |
| API | NestJS (Node.js) หรือ Go (Fiber/Echo) — REST + validation เข้ม |
| Realtime | Socket.IO + Redis Adapter |
| Database | PostgreSQL + PostGIS, Redis (cache/queue/pub-sub), MinIO/S3 (รูป) |
| แจ้งเตือน | LINE Messaging API + Telegram Bot API (BullMQ retry) |
| DevOps | Docker Compose → Kubernetes, CI/CD, Monitoring (Prometheus/Grafana) |

*หมายเหตุ: เลือกตามความถนัดของทีม — สถาปัตยกรรมเดียวกันใช้ได้กับ stack อื่น*

---

เอกสารนี้เป็นจุดเริ่มต้น — เลือกหัวข้อที่อยากเจาะลึก (เช่น สคีมาละเอียด, โค้ดตัวอย่าง geofence, หรือหน้าจอแอป) แล้วผมจะขยายให้ต่อได้เลยครับ 🙌
