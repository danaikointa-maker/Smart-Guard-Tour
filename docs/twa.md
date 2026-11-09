# 📱 TWA — แปลงเว็บแอปเป็น APK/AAB ขึ้น Google Play (ไม่ต้องเขียนโค้ดใหม่)

ใช้กับหน้า `/guard.html` (มี `manifest.webmanifest` + ไอคอน 512px พร้อมแล้วใน repo)

## ขั้นตอน

### 1) ต้องมีก่อน
- โดเมนจริง + **HTTPS** (ดู `docs/deploy.md`) — Play บังคับ secure origin
- บัญชี Google Play Developer ($25 ครั้งเดียว)

### 2) ติดตั้ง Bubblewrap (เครื่องที่มี Node + JDK 17 + Android SDK)
```bash
npm install -g @bubblewrap/cli
bubblewrap init --manifest https://guard.example.com/manifest.webmanifest
# ตอบคำถาม: package id = com.smartguardtour.smart_guard_tour (ต้องตรง assetlinks.json)
```

### 3) Digital Asset Links (พิสูจน์ว่าแอปเป็นเจ้าของโดเมน)
- เอา SHA-256 fingerprint ของ signing key (จาก Play Console → App signing หรือ `keytool -list -print -keystore ...`)
- ตั้งที่เซิร์ฟเวอร์: env `TWA_SHA256_FINGERPRINT=AA:BB:...` (หรือ setting `twa_sha256_fingerprint`)
- แอปเสิร์ฟ `/.well-known/assetlinks.json` ให้เอง ✅ (route พร้อมแล้ว)

### 4) บิ้ว
```bash
bubblewrap build
# ได้ app-release-bundle.aab → อัปโหลดใน Play Console
# build แบบ debug: bubblewrap build --skipPwaValidation (ทดสอบในเครื่องก่อน)
```

### 5) Tos/นโยบาย Play
- ขอสิทธิ์ `ACCESS_BACKGROUND_LOCATION` ต้องอธิบายใน Play Console: "ติดตามตำแหน่ง รปภ. ระหว่างกะตรวจ" (เป็นฟีเจอร์หลักของแอป — ผ่านตามนโยบาย)
- ประกาศ Data safety:เก็บพิกัด/รูป →ใช้เพื่อ core feature เท่านั้น

## หมายเหตุ
- TWA = открытьเว็บใน WebView แบบ fullscreen — ฟีเจอร์ทั้งหมด (GPS, กล้อง, Web NFC, Web Push, คิวออฟไลน์) ใช้ได้เหมือน PWA
- ถ้าอนาคตต้องการ background GPS เต็มรูปแบบแม้ปิดแอป 100% → ใช้ Flutter app ที่ `apps/mobile/` (`./build-apk.sh`)
