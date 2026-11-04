# 📱 Smart Guard Tour — Mobile App (Flutter, Native)

แอป รปภ./ลูกบ้าน ตัวจริงสำหรับขึ้น Google Play / App Store
**จุดเด่นตามนโยบาย Google Play:** ใช้ `background_locator` + **Foreground Service** ติดตาม GPS ขณะล็อกจอ
(ต้องขอ `ACCESS_BACKGROUND_LOCATION` และอธิบายใน Play Console ว่า "ติดตามตำแหน่ง รปภ. ระหว่างกะตรวจ" ซึ่งเป็นฟีเจอร์หลักของแอป)

## โครงสร้าง
```
lib/
├── main.dart             # 4 ขั้นตอน: ล็อกอิน(+SSO) → สแกน QR → ตรวจตรา →เช็คเอาต์
├── api.dart              # REST client (x-token) — baseUrl ชี้ Core API
└── location_service.dart # GPS foreground (WS ทุก 4 วินาที) + background service + คิวออฟไลน์
```

## API ที่ใช้ (เหมือนเว็บ)
`POST /api/login` · `POST /api/sso/login` · `POST /api/guard/checkin|start|visit|checkout|sos|sync` · `WS /ws`

## รัน
```bash
flutter pub get
flutter run   # Android: baseUrl default 10.0.2.2:3000 คือ host machine
```
