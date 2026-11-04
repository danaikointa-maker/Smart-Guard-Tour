import 'dart:async';
import 'dart:convert';
import 'package:background_locator/background_locator.dart';
import 'package:background_locator/settings/android_settings.dart';
import 'package:background_locator/settings/ios_settings.dart';
import 'package:background_locator/settings/location_settings.dart';
import 'package:geolocator/geolocator.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'api.dart';

/// ติดตาม GPS ขณะปฏิบัติงาน — ใช้ Foreground/Background Service (Native)
/// ตรงตามนโยบาย Google Play: background location ต้องมาจากฟีเจอร์หลักของแอป
/// (ติดตาม รปภ. ระหว่างกะตรวจ) + ต้องขอ ACCESS_BACKGROUND_LOCATION อย่างโปร่งใส
class LocationService {
  static WebSocketChannel? _ws;
  static int shiftId = 0;
  static Timer? _fgTimer;

  /// เริ่มติดตามเมื่อกด "เริ่มปฏิบัติงาน" — ส่งตำแหน่งเข้า WS ของเราเอง
  static Future<void> start(int sid) async {
    shiftId = sid;
    await Geolocator.requestPermission();
    final loc = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.high);
    _send(loc.latitude, loc.longitude, loc.accuracy);

    // background (ล็อกจอ) ผ่าน background_locator + Foreground Service
    await BackgroundLocator.registerLocationUpdate(_onBgLocation,
        settings: LocationSettings(
          androidSettings: AndroidSettings(
            accuracy: LocationAccuracy.high,
            interval: 10, // วินาที (อ่านค่าจริงจาก /api/settings ได้)
            distanceFilter: 10,
            foregroundService: true, // แจ้งผู้ใช้ชัดเจนว่า "กำลังตรวจตรา"
          ),
          iosSettings: IOSSettings(accuracy: LocationAccuracy.high),
        ));

    // foreground: ส่งผ่าน WebSocket ทุก 4 วินาที (ตามตั้งค่า gps_interval_sec)
    _ws = WebSocketChannel.connect(
        Uri.parse('${Api.baseUrl.replaceFirst('http', 'ws')}/ws?token=${Api.token}'));
    _fgTimer = Timer.periodic(const Duration(seconds: 4), (_) async {
      if (!await Geolocator.isLocationServiceEnabled()) return;
      final p = await Geolocator.getCurrentPosition(
          desiredAccuracy: LocationAccuracy.high);
      _send(p.latitude, p.longitude, p.accuracy);
    });
  }

  static void _onBgLocation(dynamic data) {
    // data = ตำแหน่งจาก background service → ส่งเข้า WS/คิว
    _send(data.latitude, data.longitude, data.accuracy);
  }

  static void _send(double lat, double lng, double acc) {
    final msg = jsonEncode(
        {'type': 'pos', 'shiftId': shiftId, 'lat': lat, 'lng': lng, 'accuracy': acc});
    if (_ws != null) {
      _ws!.sink.add(msg);
    } else {
      // ออฟไลน์ → เก็บคิวไว้ในเครื่อง (sync ภายหลังผ่าน /api/guard/sync)
      Api.post('/api/guard/sync', {
        'positions': [
          {'lat': lat, 'lng': lng, 'accuracy': acc, 'ts': DateTime.now().toIso8601String()}
        ]
      }).catchError((_) => OfflineQueue.add(msg));
    }
  }

  static Future<void> stop() async {
    _fgTimer?.cancel();
    await BackgroundLocator.unRegisterLocationUpdate(_onBgLocation);
    await _ws?.sink.close();
  }
}

class OfflineQueue {
  static final List<String> _items = [];
  static void add(String msg) => _items.add(msg);
}
