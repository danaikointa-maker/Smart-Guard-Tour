import 'dart:convert';
import 'package:http/http.dart' as http;

/// Client ของ Core API — baseUrl ชี้ไปเซิร์ฟเวอร์ Smart Guard Tour
class Api {
  static String baseUrl = 'http://10.0.2.2:3000'; // Android emulator → host machine
  static String token = '';

  static Map<String, String> get _h => {
        'Content-Type': 'application/json',
        if (token.isNotEmpty) 'x-token': token,
      };

  static Future<Map<String, dynamic>> post(String path, Map body) async {
    final r = await http.post(Uri.parse('$baseUrl$path'),
        headers: _h, body: jsonEncode(body));
    final j = jsonDecode(r.body);
    if (r.statusCode >= 400) throw Exception(j['error'] ?? 'ผิดพลาด');
    return j;
  }

  static Future<Map<String, dynamic>> get(String path) async {
    final r = await http.get(Uri.parse('$baseUrl$path'), headers: _h);
    final j = jsonDecode(r.body);
    if (r.statusCode >= 400) throw Exception(j['error'] ?? 'ผิดพลาด');
    return j;
  }
}
