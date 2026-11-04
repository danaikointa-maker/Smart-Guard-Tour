const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
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
  webhook_url TEXT NOT NULL DEFAULT ''
);
`);

const now = () => new Date().toISOString();

// ---- seed ข้อมูลเดโม่ (รันครั้งเดียว) ----
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  const insUser = db.prepare('INSERT INTO users(name,pin,role) VALUES(?,?,?)');
  insUser.run('admin', 'admin123', 'admin');
  insUser.run('สมชาย', '1234', 'guard');
  insUser.run('วันดี', '1234', 'guard');

  const insPost = db.prepare(
    'INSERT INTO posts(name,lat,lng,radius,qr,qr_png,created_at) VALUES(?,?,?,?,?,?,?)'
  );
  const insCp = db.prepare(
    'INSERT INTO checkpoints(code,name,lat,lng,radius,seq) VALUES(?,?,?,?,?,?)'
  );
  // จุดเดโม่: ลุมพินี seta 13.7307,100.5418 (รปภ.เดินในรัศมีไม่กี่ร้อยเมตร)
  const { makePostQRSync } = require('./qr');
  const base = { lat: 13.7307, lng: 100.5418 };
  const qr = makePostQRSync(1);
  insPost.run('ป้อมประตู 1 ลุมพินี', base.lat, base.lng, 50, qr.payload, qr.png, now());
  insCp.run('CP-01', 'ประตูทางเข้า', base.lat + 0.0009, base.lng, 100, 1);
  insCp.run('CP-02', 'ทางเดินริมสระน้ำ', base.lat, base.lng + 0.0012, 100, 2);
  insCp.run('CP-03', 'สระน้ำกลางสวน', base.lat - 0.0011, base.lng + 0.0006, 100, 3);
  insCp.run('CP-04', 'ศาลาไทย', base.lat - 0.0004, base.lng - 0.0011, 100, 4);
  console.log('[db] seeded demo data (admin/admin123, สมชาย/1234, วันดี/1234)');
}

module.exports = { db, now, UPLOAD_DIR };
