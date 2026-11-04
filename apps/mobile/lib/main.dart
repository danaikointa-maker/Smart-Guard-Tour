import 'package:flutter/material.dart';
import 'api.dart';
import 'location_service.dart';

/// Smart Guard Tour — แอป รปภ. (4 ขั้นตอนเหมือนเว็บ: เช็คอิน → เริ่มกะ → ถ่ายรูปตามจุด → เช็คเอาต์)
void main() => runApp(const SGTApp());

class SGTApp extends StatelessWidget {
  const SGTApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Smart Guard Tour', debugShowCheckedModeBanner: false,
        theme: ThemeData.dark(useMaterial3: true),
        home: const LoginScreen());
}

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final name = TextEditingController();
  final pin = TextEditingController();
  bool sso = false;

  Future<void> _login({bool viaSso = false}) async {
    try {
      final j = viaSso
          ? await Api.post('/api/sso/login', {'vva_token': await _mockVvaToken()})
          : await Api.post('/api/login', {'name': name.text, 'pin': pin.text});
      Api.token = j['token'];
      if (!mounted) return;
      Navigator.pushReplacement(context,
          MaterialPageRoute(builder: (_) => const ScanQrScreen(checkout: false)));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<String> _mockVvaToken() async {
    final r = await Api.get('/api/sso/mock-issue?name=${name.text}');
    return r['vva_token'];
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('🛡️ Smart Guard Tour')),
        body: Padding(padding: const EdgeInsets.all(16), child: Column(children: [
          TextField(controller: name, decoration: const InputDecoration(labelText: 'ชื่อ')),
          TextField(controller: pin, decoration: const InputDecoration(labelText: 'PIN'), obscureText: true),
          const SizedBox(height: 16),
          SizedBox(width: double.infinity, child: ElevatedButton(
              onPressed: () => _login(), child: const Text('เข้าสู่ระบบ'))),
          FutureBuilder(
              future: Api.get('/api/settings'),
              builder: (c, s) {
                if (s.data?['sso_enabled'] == 'true') {
                  return TextButton(
                      onPressed: () => _login(viaSso: true),
                      child: Text('🔐 เข้าด้วย SSO (${s.data?['sso_provider_name'] ?? 'VVA'})'));
                }
                return const SizedBox();
              }),
        ])));
}

/// สแกน QR (เช็คอิน/เช็คเอาต์) — ใช้ mobile_scanner
class ScanQrScreen extends StatelessWidget {
  final bool checkout;
  const ScanQrScreen({super.key, required this.checkout});
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text(checkout ? '🏁 สแกน QR จบงาน' : '① สแกน QR ที่ป้อม')),
        body: Center(child: Text('กล้องสแกน QR — mobile_scanner\n(โค้ด flow เหมือน guard.js)')),
      );
}

/// หน้าตรวจตรา: เริ่มกะ → GPS → ถ่ายรูปตามจุด (geofence server-side)
class PatrolScreen extends StatefulWidget {
  final int shiftId;
  const PatrolScreen({super.key, required this.shiftId});
  @override
  State<PatrolScreen> createState() => _PatrolScreenState();
}

class _PatrolScreenState extends State<PatrolScreen> {
  @override
  void initState() {
    super.initState();
    LocationService.start(widget.shiftId); // เริ่ม GPS + Background Service
  }

  @override
  void dispose() {
    LocationService.stop();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('🚶 กำลังตรวจตรา')),
        body: const Center(child: Text('รายการจุดตรวจ + แผนที่ + ปุ่มถ่ายรูป (camera)\n→ POST /api/guard/visit')),
        floatingActionButton: FloatingActionButton.extended(
          backgroundColor: Colors.red,
          onPressed: () => Api.post('/api/guard/sos', {
            'shiftId': widget.shiftId, 'lat': 0, 'lng': 0 // ใส่ตำแหน่งจริงจาก Geolocator
          }),
          label: const Text('🚨 SOS'),
        ),
      );
}
