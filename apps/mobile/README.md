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

## บิ้ว APK (Flutter + Android SDK + Gradle)
โครง `android/` (Gradle 8.10 / AGP 8.7 / Kotlin 2.0) พร้อมใช้แล้ว — ต้องรันบนเครื่องที่มี Flutter SDK + JDK 17 + Android SDK:
```bash
./build-apk.sh          # ตรวจ env → pub get → flutter build apk --release
# หรือเอง:
flutter pub get && flutter build apk --release
# APK: build/app/outputs/flutter-apk/app-release.apk
```
> หมายเหตุ: `android/gradle/wrapper/gradle-wrapper.jar` เป็นไบนารี — ถ้ายังไม่มี ให้รัน `flutter create --platforms=android .` หนึ่งครั้งเพื่อ generate (สคริปต์ทำให้อัตโนมัติ) · ก่อนขึ้น Play: สร้าง keystore แล้วตั้ง `signingConfig release` ใน `android/app/build.gradle`

## สิทธิ์ที่ต้องขอ (AndroidManifest พร้อมแล้ว)
`INTERNET` (ซิม/WiFi) · `ACCESS_FINE/COARSE/BACKGROUND_LOCATION` + `FOREGROUND_SERVICE_LOCATION` (GPS ขณะล็อกจอ) · `CAMERA` (ถ่ายรูปจุดตรวจ) · `POST_NOTIFICATIONS`
