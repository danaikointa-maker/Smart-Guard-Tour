#!/usr/bin/env bash
# ============================================================
# Smart Guard Tour — บิ้ว APK (Flutter + Android SDK + Gradle)
# ใช้บนเครื่องที่ติดตั้ง Flutter SDK + Android Studio แล้วเท่านั้น
#   macOS/Linux:  brew install --cask flutter  +  Android Studio (SDK+cmdline-tools)
#   Windows:      choco install flutter  +  Android Studio
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

echo "== 0) ตรวจ environment =="
command -v java   >/dev/null 2>&1 || { echo "❌ ไม่พบ java — ติดตั้ง JDK 17 ก่อน (Android Studio มากับ JBR)"; exit 1; }
command -v flutter >/dev/null 2>&1 || { echo "❌ ไม่พบ flutter — ติดตั้ง Flutter SDK ก่อน: https://docs.flutter.dev/get-started/install"; exit 1; }
java -version 2>&1 | head -1
flutter --version | head -1

echo "== 1) เตรียมโครง android (ถ้ายังไม่มี gradle-wrapper.jar) =="
if [ ! -f android/gradle/wrapper/gradle-wrapper.jar ]; then
  flutter create --platforms=android --project-name smart_guard_tour .
fi

echo "== 2) pub get =="
flutter pub get

echo "== 3) build APK =="
# เปลี่ยน baseUrl ใน lib/api.dart ให้ชี้เซิร์ฟเวอร์จริงก่อน build ถ้าต้องการ
flutter build apk --release

APK="build/app/outputs/flutter-apk/app-release.apk"
echo
echo "✅ เสร็จ! APK อยู่ที่: $APK"
ls -lh "$APK"
echo
echo "หมายเหตุ: APK นี้เซ็นด้วย debug key — ก่อนขึ้น Google Play ให้สร้าง keystore แล้วแก้ signingConfig ใน android/app/build.gradle"
