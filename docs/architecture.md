# 🏛️ Smart Guard Tour — สถาปัตยกรรม & โครงสร้างโปรเจกต์ (Architecture & Project Structure)

เอกสารนี้เป็นแผนที่นำทางสำหรับพัฒนาต่อจากต้นแบบ (prototype) ไปสู่ระบบโปรดักชัน — อ่านคู่กับ [smart-guard-tour-design.md](./smart-guard-tour-design.md)

---

## 1. C4 — ภาพรวม 4 ระดับ

### Level 1: Context — ใครใช้ระบบนี้บ้าง
```
                    ┌──────────────┐
   ลูกบ้าน ────────▶│              │◀──── รปภ. (มือถือ)
   (ดูสถานะ)        │ Smart Guard  │      (QR/GPS/รูป/SOS)
                    │    Tour      │◀──── หัวหน้า รปภ. (ดูเรียลไทม์)
   Admin ──────────▶│   System     │◀──── ระบบเดิม VVA (SSO เท่านั้น)
   (ตั้งค่าทั้งหมด) │              │────▶ LINE / Telegram (แจ้งเตือน)
                    └──────┬───────┘
                           │ GPS/รูป/รายงาน
                    แผนที่ (Google Maps แสดงผลอย่างเดียว)
```

### Level 2: Containers — 3 ส่วนตามที่ออกแบบ
| Container | หน้าที่ | เทคโนโลยี (โปรดักชัน) | ของต้นแบบตอนนี้ |
|---|---|---|---|
| **Admin Web** | ตั้งค่าทั้งหมด แผนที่สด รายงาน | Next.js + Google Maps JS | หน้า `admin.html` บน Express |
| **Mobile App** | รปภ./ลูกบ้าน — QR, GPS, รูป, SOS | **Flutter (Native)** + background location | หน้าเว็บมือถือ `guard.html`/`resident.html` |
| **Core API** | REST + business logic | NestJS/Go + JWT | `server/index.js` (Express) |
| **Realtime Server** | WebSocket broadcast ตำแหน่ง/อีเวนต์ | Socket.IO + Redis adapter | `ws` ใน `server/index.js` |
| **Database** | เก็บทุกอย่างของระบบนี้ (แยกจาก VVA) | PostgreSQL + PostGIS + Redis + S3/MinIO | SQLite ใน `data/` + ไฟล์รูปใน `uploads/` |

### Level 3: Components (ภายใน Core API)
```
Auth/SSO ─▶ Guard Flow ─▶ Geofence Engine ─▶ Report Builder ─▶ Notifier (LINE/TG/Webhook)
                │                  │                  │
                ▼                  ▼                  ▼
           Shift state      Haversine/PostGIS    Realtime broadcast
           machine          check (inside/out)   + เก็บ audit log
                │
                ▼
           GPS Ingestion (รับจากมือถือทุก N วินาทีตามตั้งค่า)
```

### Level 4: โฟลว์ข้อมูลหลัก (Guard patrol flow)
```
มือถือ รปภ. ──QR──▶ check-in ──▶ start ──▶ GPS ─┬─▶ WS ─▶ Admin/HF แผนที่สด
   │                                            ├─▶ gps_tracks (เก็บ)
   └─▶ ถ่ายรูปที่จุด ──▶ geofence check ──▶ visits ──▶ checkout ──▶ report ──▶ Notifier
```

---

## 2. โครงสร้างโปรเจกต์สำหรับพัฒนาต่อ (Monorepo แนะนำ)

```
smart-guard-tour/
├── apps/
│   ├── admin-web/            # Next.js — ตั้งค่าทั้งหมด แผนที่สด รายงาน (ของเดิม: public/admin.*)
│   ├── mobile/               # Flutter — รปภ. + ลูกบ้าน (native background GPS!)
│   └── resident-web/         # (ถ้าอยากให้ลูกบ้านใช้เว็บ) หรือรวมใน mobile
├── services/
│   ├── api/                  # NestJS/Go — REST ทั้งหมด (ของเดิม: server/index.js)
│   ├── realtime/             # WebSocket server แยก + Redis pub/sub
│   └── notifier/             # LINE/Telegram/webhook + คิว retry (BullMQ)
├── packages/
│   ├── shared-types/         # TypeScript types ร่วม (Shift, Checkpoint, Visit…)
│   ├── geofence/             # haversine/PostGIS wrapper (ของเดิม: server/geo.js)
│   └── qr/                   # สร้าง/ตรวจ QR ลงลายเซ็น (ของเดิม: server/qr.js)
├── infra/
│   ├── docker-compose.yml    # postgres+postgis, redis, minio, api, realtime
│   └── k8s/                  # สำหรับขึ้น production
├── docs/
│   ├── smart-guard-tour-design.md
│   └── architecture.md       # ไฟล์นี้
└── README.md
```

**หลักการย้ายโค้ดจากต้นแบบ:** business logic ใน `server/` แยกเป็น service ล balkon — อย่าเอา Expressทั้งก้อนไป production ให้เริ่มจากย้าย `geo.js`, `qr.js` ไปเป็น package ก่อน แล้วค่อยย้าย flow ต่อ

---

## 3. โมเดลข้อมูล (สรุปจากที่ implement แล้ว)

```
users(id, name, pin, role[guard|supervisor|resident|admin])
posts(id, name, lat, lng, radius, qr, qr_png)          ← QR = HMAC-signed payload
checkpoints(id, code, name, lat, lng, radius, seq)
shift_schedules(id, guard_id, post_id, date, start, end)
shifts(id, guard_id, post_id, status, checked_in_at, started_at, checked_out_at)
gps_tracks(id, shift_id, lat, lng, accuracy, ts)       ← partition ตามเดือนในโปรดักชัน
visits(id, shift_id, checkpoint_id, lat, lng, accuracy, inside, photo, ts)
reports(id, shift_id, …, detail JSON, sent_to)
notif_groups(id, event_type, label, channel[webhook|telegram|line], webhook_url, bot_token, chat_id)
settings(key, value, label)                            ← GPS interval, radii, privacy flags…
```

## 4. สัญญา API (Endpoint หลักที่มีแล้ว)

| Method | Path | ใคร | ทำอะไร |
|---|---|---|---|
| POST | `/api/login` | ทุกคน | ล็อกอินด้วยชื่อ+PIN (ต่อ SSO ภายหลัง) |
| GET | `/api/settings` | สาธารณะ | ค่าตั้งค่า (ไม่มีความลับ) |
| POST | `/api/guard/checkin` | guard | สแกน QR → สร้างกะ + ได้ตารางเวร |
| POST | `/api/guard/start` | guard | เริ่มกะ → GPS อน |
| POST | `/api/guard/position` | guard | รับตำแหน่ง (สำรองของ WS) |
| POST | `/api/guard/visit` | guard | รูป+GPS+geofence → เช็คจุด (409 ถ้านอกรัศมี) |
| POST | `/api/guard/sos` | guard | 🚨 ฉุกเฉิน → broadcast + แจ้งกลุ่ม sos |
| POST | `/api/guard/checkout` | guard | จบกะ → สร้างรายงาน + ส่งแจ้งเตือน |
| GET | `/api/resident/status` | resident | สถานะตามสิทธิ์ (ไม่มี GPS สดถ้าไม่อนุญาต) |
| GET/POST/DELETE | `/api/admin/*` | admin | ตั้งค่าทั้งหมด (supervisor อ่านได้อย่างเดียว) |
| WS | `/ws?token=` | admin/supervisor | Realtime: gps / visit / sos / report / shift |

## 5. Realtime protocol (WebSocket)

- **Client→Server:** `{type:'pos', shiftId, lat, lng, accuracy}`
- **Server→Client:** `{type:'gps'|'visit'|'sos'|'report'|'shift'|'missed_cp', …}`
- Adminรับ `gps` → อัปเดต Marker บนแผนที่ + แสดงเวลาล่าสุด; Google Maps ใช้แสดงผลอย่างเดียว

## 6. นโยบายความเป็นส่วนตัว (Privacy by default — implemented)

ตั้งค่าในแท็บ ⚙️: `resident_see_status` (เปิด), `resident_see_live_location` (**ปิดเริ่มต้น**), `resident_see_history` (ปิด) — `/api/resident/status`กรองข้อมูลตามค่าเหล่านี้อัตโนมัติ

## 7. Roadmap — งานที่เหลือจากแผนเดิม

| สถานะ | งาน |
|---|---|
| ✅ ทำแล้วในต้นแบบ | QRเช็คอิน/เอาต์, GPS+WS สด, รูป+geofence, รายงาน, ตั้งค่าทั้งหมด, ลูกบ้านตามสิทธิ์, SOS, หัวหน้าอ่านอย่างเดียว, แจ้งจุดที่ขาด, ออฟラインซิงก์, แดชบอร์ดสถิติ+audit log, สลับ tile แผนที่ (Google Maps), **SSO (mock VVA, เปิด/ปิดได้ใน ⚙️)** |
| 🚧 โครงสร้างพร้อม | **Flutter native app** — โค้ดอยู่ที่ `apps/mobile/` (background_locator + Foreground Service + คิวออฟライン) — เหลือแค่ `flutter pub get && flutter run` |
| 🚧 ต่อของจริง | SSO VVA — ต้นแบบรองรับแล้ว (`/api/sso/login`, ผูก `vva_user_id`) — โปรดักชันแค่สลับ mock-issue เป็น OAuth2/OIDC จริงของ VVA |
| 🔲 ต่อไป | PostgreSQL+PostGIS, รูปเข้า S3/MinIO, Google Maps JS API เต็มรูปแบบ (marker แบบ native) |

| 🔲 ต่อไป | ส่งออก PDF/Excel, Heatmap บนแผนที่ (ข้อมูลพร้อมแล้วใน /api/admin/stats) |
| 🔲 ต่อไป | แจ้งเตือน push ในแอป, 2-person verification จุดสำคัญ |

## 8. การรันต้นแบบ (Prototype)

```bash
npm install
npm start        # http://localhost:3000
```
บัญชีเดโม่: รปภ. `สมชาย/1234` · หัวหน้า `วินัย/1234` · ลูกบ้าน `ลูกบ้าน A/1234` · Admin `admin/admin123`
