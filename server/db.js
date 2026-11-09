const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.SGT_DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'smart-guard-tour.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  pin TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'guard'
);
CREATE TABLE IF NOT EXISTS posts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL,
  radius REAL NOT NULL DEFAULT 30,
  qr TEXT NOT NULL,
  qr_png TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL,
  radius REAL NOT NULL DEFAULT 100,
  seq INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS shifts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guard_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'checked_in', -- checked_in | patrolling | checked_out
  checked_in_at TEXT, started_at TEXT, checked_out_at TEXT
);
CREATE TABLE IF NOT EXISTS gps_tracks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS visits(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL,
  checkpoint_id INTEGER NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL,
  inside INTEGER NOT NULL,
  photo TEXT,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL,
  guard_name TEXT, post_name TEXT,
  started_at TEXT, ended_at TEXT,
  total INTEGER, visited INTEGER,
  detail TEXT,
  sent_to TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notif_groups(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  label TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'webhook', -- webhook | telegram | line
  webhook_url TEXT NOT NULL DEFAULT '',
  bot_token TEXT NOT NULL DEFAULT '',
  chat_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS incidents(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER,
  guard_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  lat REAL, lng REAL, accuracy REAL,
  photo TEXT,
  sent_to TEXT,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sites(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  endpoint TEXT UNIQUE NOT NULL,
  sub_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhooks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL DEFAULT '',
  events TEXT NOT NULL DEFAULT 'sos,incident,visit,missed_cp,shift,report',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_deliveries(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id INTEGER,
  event TEXT NOT NULL,
  status_code INTEGER,
  ok INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS device_status(
  user_id INTEGER PRIMARY KEY,
  battery REAL,
  charging INTEGER,
  ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS shift_schedules(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guard_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);
`);

// ---- migration: เพิ่มคอลัมน์ใหม่ให้ตารางเก่า (ถ้ามี) ----
function addCol(table, col, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch (e) { /* มีอยู่แล้ว */ }
}
addCol('notif_groups', 'channel', "TEXT NOT NULL DEFAULT 'webhook'");
addCol('notif_groups', 'bot_token', "TEXT NOT NULL DEFAULT ''");
addCol('notif_groups', 'chat_id', "TEXT NOT NULL DEFAULT ''");
addCol('users', 'vva_user_id', "TEXT");
addCol('checkpoints', 'require_two_person', 'INTEGER NOT NULL DEFAULT 0');
addCol('visits', 'confirmed', 'INTEGER NOT NULL DEFAULT 1');
addCol('visits', 'flags', "TEXT NOT NULL DEFAULT ''"); // JSON array — AI ตรวจรูปอัตโนมัติ (dark/blurry/lowres)
addCol('visits', 'confirmed_by', 'INTEGER');
addCol('posts', 'site_id', 'INTEGER');
addCol('checkpoints', 'site_id', 'INTEGER');
addCol('incidents', 'status', "TEXT NOT NULL DEFAULT 'open'"); // open | resolved
addCol('incidents', 'resolved_by', 'TEXT');
addCol('posts', 'qr_issued_at', 'TEXT');

const now = () => new Date().toISOString();
const BASE = { lat: 13.7307, lng: 100.5418 }; // ลุมพินี (เดโม่)

// ---- seed ข้อมูลเดโม่ (รันครั้งเดียวเมื่อ DB ว่าง) ----
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  const insUser = db.prepare('INSERT INTO users(name,pin,role) VALUES(?,?,?)');
  insUser.run('admin', 'admin123', 'admin');
  insUser.run('สมชาย', '1234', 'guard');
  insUser.run('วันดี', '1234', 'guard');
  insUser.run('วินัย', '1234', 'supervisor'); // หัวหน้า รปภ.
  insUser.run('ลูกบ้าน A', '1234', 'resident');

  const insPost = db.prepare(
    'INSERT INTO posts(name,lat,lng,radius,qr,qr_png,created_at) VALUES(?,?,?,?,?,?,?)'
  );
  const insCp = db.prepare(
    'INSERT INTO checkpoints(code,name,lat,lng,radius,seq) VALUES(?,?,?,?,?,?)'
  );
  const { makePostQRSync } = require('./qr');
  const qr = makePostQRSync(1);
  insPost.run('ป้อมประตู 1 ลุมพินี', BASE.lat, BASE.lng, 50, qr.payload, qr.png, now());
  insCp.run('CP-01', 'ประตูทางเข้า', BASE.lat + 0.0009, BASE.lng, 100, 1);
  insCp.run('CP-02', 'ทางเดินริมสระน้ำ', BASE.lat, BASE.lng + 0.0012, 100, 2);
  insCp.run('CP-03', 'สระน้ำกลางสวน', BASE.lat - 0.0011, BASE.lng + 0.0006, 100, 3);
  insCp.run('CP-04', 'ศาลาไทย', BASE.lat - 0.0004, BASE.lng - 0.0011, 100, 4);

  const today = new Date().toISOString().slice(0, 10);
  const insSch = db.prepare('INSERT INTO shift_schedules(guard_id,post_id,date,start_time,end_time) VALUES(?,?,?,?,?)');
  insSch.run(2, 1, today, '06:00', '14:00');
  insSch.run(3, 1, today, '14:00', '22:00');
  console.log('[db] seeded demo data (admin/admin123 · สมชาย/1234 · วันดี/1234 · วินัย/1234 หัวหน้า · ลูกบ้าน A/1234)');
}

// QR เดิมให้ issued_at = created_at
db.prepare("UPDATE posts SET qr_issued_at=created_at WHERE qr_issued_at IS NULL").run();

// ---- seed โครงการเดโม่ + ผูกข้อมูลเดิม (idempotent) ----
{
  const c = db.prepare('SELECT COUNT(*) c FROM sites').get().c;
  if (c === 0) db.prepare('INSERT INTO sites(name,address,created_at) VALUES(?,?,?)')
    .run('โครงการลุมพินี (เดโม่)', 'สวนลุมพินี กรุงเทพฯ', now());
  const s = db.prepare('SELECT id FROM sites ORDER BY id LIMIT 1').get();
  if (s) {
    db.prepare('UPDATE posts SET site_id=? WHERE site_id IS NULL').run(s.id);
    db.prepare('UPDATE checkpoints SET site_id=? WHERE site_id IS NULL').run(s.id);
  }
}

// ---- seed บัญชีเดโม่เพิ่ม (idempotent) ----
{
  const insUser = db.prepare('INSERT OR IGNORE INTO users(name,pin,role) VALUES(?,?,?)');
  insUser.run('วินัย', '1234', 'supervisor');
  insUser.run('ลูกบ้าน A', '1234', 'resident');
}

// ---- seed ตารางเวรวันนี้ (idempotent) ----
{
  const today = new Date().toISOString().slice(0, 10);
  const c = db.prepare('SELECT COUNT(*) c FROM shift_schedules WHERE date=?').get(today).c;
  if (c === 0) {
    const g = db.prepare("SELECT id FROM users WHERE name='สมชาย'").get();
    const g2 = db.prepare("SELECT id FROM users WHERE name='วันดี'").get();
    const p = db.prepare('SELECT id FROM posts ORDER BY id LIMIT 1').get();
    if (g && p) db.prepare('INSERT INTO shift_schedules(guard_id,post_id,date,start_time,end_time) VALUES(?,?,?,?,?)').run(g.id, p.id, today, '06:00', '14:00');
    if (g2 && p) db.prepare('INSERT INTO shift_schedules(guard_id,post_id,date,start_time,end_time) VALUES(?,?,?,?,?)').run(g2.id, p.id, today, '14:00', '22:00');
  }
}

// ---- seed ค่าตั้งค่าเริ่มต้น (INSERT OR IGNORE — ไม่ทับค่าที่ admin แก้ไปแล้ว) ----
{
  const insSet = db.prepare('INSERT OR IGNORE INTO settings(key,value,label,updated_at) VALUES(?,?,?,?)');
  const seed = [
    ['gps_interval_sec', '4', 'ความถี่ส่ง GPS (วินาที)'],
    ['gps_min_distance_m', '10', 'ส่ง GPS เมื่อขยับอย่างน้อย (เมตร)'],
    ['default_post_radius_m', '30', 'รัศมีเริ่มต้นของป้อม/QR (เมตร)'],
    ['default_checkpoint_radius_m', '100', 'รัศมีเริ่มต้นของจุดตรวจ (เมตร)'],
    ['photo_jpeg_quality', '0.8', 'คุณภาพรูป JPEG (0-1)'],
    ['resident_see_status', 'true', 'ลูกบ้านเห็นสถานะการตรวจ (true/false)'],
    ['resident_see_live_location', 'false', 'ลูกบ้านเห็นตำแหน่งสด รปภ. (ค่าเริ่มต้นต้องเป็น false)'],
    ['resident_see_history', 'false', 'ลูกบ้านเห็นเส้นทางย้อนหลัง (true/false)'],
    ['public_dashboard', 'true', 'แดชบอร์ดสาธารณะ (ไม่ต้องล็อกอิน) แสดงภาพรวมเท่านั้น (true/false)'],
    ['map_lat', String(BASE.lat), 'แผนที่: ละติจูดเริ่มต้น'],
    ['map_lng', String(BASE.lng), 'แผนที่: ลองจิจูดเริ่มต้น'],
    ['map_zoom', '16', 'แผนที่: ซูมเริ่มต้น'],
    ['timezone', 'Asia/Bangkok', 'โซนเวลา'],
    ['sso_enabled', 'false', 'เปิด SSO ผ่านระบบ VVA (true/false)'],
    ['sso_provider_name', 'VVA SSO', 'ชื่อผู้ให้บริการ SSO (แสดงบนหน้าล็อกอิน)'],
    ['qr_ttl_hours', '0', 'อายุของ QR ป้อม (ชั่วโมง) — 0 = ไม่หมดอายุ'],
    ['session_ttl_hours', '12', 'อายุ session ล็อกอิน (ชั่วโมง)'],
    ['enforce_schedule', 'false', 'บังคับเช็คอินเฉพาะในเวร (true/false) — true = ปฏิเสธถ้านอกเวร'],
    ['gps_retention_days', '90', 'เก็บข้อมูล GPS ย้อนหลัง (วัน) — ลบอัตโนมัติเกินกว่านี้ (PDPA)'],
    ['map_provider', 'osm', 'ผู้ให้บริการแผนที่ (osm/google)'],
    ['google_maps_api_key', '', 'Google Maps API Key (ใช้เมื่อ map_provider=google)'],
    ['map_tile_url', 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', 'แผนที่: Tile URL (Google Maps: https://mt{s}.google.com/vt/lyrs=m&hl=th&x={x}&y={y}&z={z}&key=YOUR_KEY)'],
  ];
  for (const s of seed) insSet.run(...s, now());
}

module.exports = { db, now, UPLOAD_DIR };
