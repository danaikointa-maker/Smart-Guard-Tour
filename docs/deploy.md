# 🚀 คู่มือ Deploy โปรดักชัน (Production)

## ภาพรวมสถาปัตยกรรมโปรดักชัน
```
มือถือ รปภ. (ซิม/4G-5G) ──HTTPS──▶ nginx (Let's Encrypt) ──▶ Smart Guard Tour (Node, port 3000)
                                                          │
                                                          ├─▶ SQLite (dev) หรือ PostgreSQL+PostGIS (prod)
                                                          └─▶ uploads/ (รูป) → S3/MinIO ได้
```

## 1) รันด้วย Docker (เร็วสุด)
```bash
cp .env.example .env 2>/dev/null || true   # ถ้ามี — ไม่งั้นตั้งใน docker-compose ตรง environment
SGT_SECRET=$(openssl rand -hex 32) VVA_SSO_SECRET=$(openssl rand -hex 32) docker compose up -d --build
# เปิด http://localhost:3000
```

## 2) HTTPS (จำเป็นสำหรับมือถือ: GPS/กล้อง/Web NFC ต้องการ secure context)
ใช้ nginx + certbot:
```nginx
server {
  listen 443 ssl; server_name guard.example.com;
  ssl_certificate /etc/letsencrypt/live/guard.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/guard.example.com/privkey.pem;
  location / { proxy_pass http://127.0.0.1:3000; proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; }
}
server { listen 80; server_name guard.example.com; return 301 https://$host$request_uri; }
```
```bash
certbot --nginx -d guard.example.com
```

## 3) ฐานข้อมูล PostgreSQL + PostGIS (แทน SQLite)
```bash
docker run -d --name sgt-pg -e POSTGRES_PASSWORD=secret -p 5432:5432 postgis/postgis:16-3.4
psql "postgres://postgres:secret@localhost:5432/postgres" -f scripts/migrate-to-postgres.sql
# ตั้งค่าแอป: DATABASE_URL=postgres://postgres:secret@localhost:5432/smart_guard_tour
# ย้ายข้อมูลจาก SQLite: pg_dump --data-only หรือสคริปต์ย้าย (คอลัมน์ lat/lng ซ้ำไว้ครบ)
```
หมายเหตุ: `gps_tracks` เป็น partition รายเดือน — retention PDPA แค่ `DROP PARTITION` เดือนเก่า

## 4) ตัวแปรแวดล้อมที่สำคัญ
| ตัวแปร | ค่าเริ่มต้น | หมายเหตุ |
|---|---|---|
| `PORT` | 3000 | พอร์ตเซิร์ฟเวอร์ |
| `SGT_SECRET` | change-me | secretเซ็น QR/โทเค็น — **ต้องเปลี่ยน** |
| `VVA_SSO_SECRET` | change-me | secret SSO กับ VVA |
| `DATABASE_URL` | (ว่าง = SQLite) | ใส่เมื่อใช้ Postgres |
| `S3_*` | — | ถ้าตั้ง → รูปเข้า S3/MinIO อัตโนมัติ |
| `MAP_PROVIDER`/`GOOGLE_MAPS_KEY` | osm | สลับเป็น google ได้ |

## 5) APK (Flutter)
ดู `apps/mobile/README.md` — บนเครื่องที่มี Flutter SDK: `cd apps/mobile && ./build-apk.sh`
ก่อนขึ้น Play: สร้าง keystore + ตั้ง `signingConfig release` ใน `android/app/build.gradle`

## 6)เช็กลิสต์ก่อนขึ้นจริง
- [ ] เปลี่ยน `SGT_SECRET` / `VVA_SSO_SECRET`
- [ ] HTTPS เปิด + WebSocket ผ่าน proxy ได้ (test SOS Realtime)
- [ ] Admin เปลี่ยน PIN บัญชีเดโม่ (`admin/admin123` ฯลฯ)
- [ ] ตั้ง retention (`retention_days`) + `enforce_schedule` ตามนโยบาย
- [ ] ตั้ง `public_dashboard` ตามต้องการ (ค่าเริ่มต้นเปิด — ข้อมูลรวมเท่านั้น)
- [ ] SMS gateway (`sms_gateway_url`...) + webhooks ภายนอกครบ
- [ ] backup อัตโนมัติ: cron `curl -H "x-token:..." /api/admin/backup > backup-$(date).json`
