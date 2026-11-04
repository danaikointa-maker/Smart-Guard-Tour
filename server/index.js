const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { db, now, UPLOAD_DIR } = require('./db');
const { haversineM } = require('./geo');
const { makePostQRWithPng, verifyPostQR } = require('./qr');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/vendor/leaflet', express.static(path.join(__dirname, '..', 'node_modules', 'leaflet', 'dist')));
app.use('/vendor/jsqr', express.static(path.join(__dirname, '..', 'node_modules', 'jsqr', 'dist')));
app.use('/uploads', express.static(UPLOAD_DIR));

// ---------- session (in-memory) ----------
const tokens = new Map(); // token -> {userId, role, name}
function auth(req, res, next) {
  const t = req.headers['x-token'];
  const u = t && tokens.get(t);
  if (!u) return res.status(401).json({ error: 'ต้องเข้าสู่ระบบก่อน' });
  req.user = u;
  next();
}

// ---------- auth ----------
app.post('/api/login', (req, res) => {
  const { name, pin } = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE name=? AND pin=?').get(name, pin);
  if (!row) return res.status(401).json({ error: 'ชื่อหรือ PIN ไม่ถูกต้อง' });
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { userId: row.id, role: row.role, name: row.name });
  res.json({ token, user: { id: row.id, name: row.name, role: row.role } });
});

// ---------- admin: ภาพรวม ----------
app.get('/api/admin/overview', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  res.json({
    posts: db.prepare('SELECT id,name,lat,lng,radius,qr,qr_png,created_at FROM posts ORDER BY id').all(),
    checkpoints: db.prepare('SELECT * FROM checkpoints ORDER BY seq').all(),
    guards: db.prepare("SELECT id,name FROM users WHERE role='guard'").all(),
    shifts: db.prepare(
      `SELECT s.*, u.name guard_name, p.name post_name FROM shifts s
       JOIN users u ON u.id=s.guard_id JOIN posts p ON p.id=s.post_id
       ORDER BY s.id DESC LIMIT 50`
    ).all(),
    reports: db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT 50').all(),
    notif: db.prepare('SELECT * FROM notif_groups ORDER BY id').all(),
  });
});

// ---------- admin: สร้างป้อม + QR ----------
app.post('/api/admin/posts', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  const { name, lat, lng, radius } = req.body || {};
  if (!name || !isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: 'กรอกชื่อและเลือกพิกัดบนแผนที่' });
  const ins = db.prepare('INSERT INTO posts(name,lat,lng,radius,qr,qr_png,created_at) VALUES(?,?,?,?,?,?,?)');
  const info = ins.run(name, lat, lng, Number(radius) || 30, 'temp', 'temp', now());
  const qr = await makePostQRWithPng(info.lastInsertRowid, name);
  db.prepare('UPDATE posts SET qr=?, qr_png=? WHERE id=?').run(qr.payload, qr.png, info.lastInsertRowid);
  res.json({ id: info.lastInsertRowid, qr: qr.payload, qr_png: qr.png });
});

app.delete('/api/admin/posts/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  db.prepare('DELETE FROM posts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- admin: จุดตรวจ ----------
app.post('/api/admin/checkpoints', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  const { name, lat, lng, radius, seq } = req.body || {};
  if (!name || !isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: 'กรอกชื่อและเลือกพิกัดบนแผนที่' });
  const count = db.prepare('SELECT COUNT(*) c FROM checkpoints').get().c;
  const code = `CP-${String(count + 1).padStart(2, '0')}`;
  const ins = db.prepare('INSERT INTO checkpoints(code,name,lat,lng,radius,seq) VALUES(?,?,?,?,?,?)');
  const info = ins.run(code, name, lat, lng, Number(radius) || 100, Number(seq) || count + 1);
  res.json({ id: info.lastInsertRowid, code });
});

app.delete('/api/admin/checkpoints/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  db.prepare('DELETE FROM checkpoints WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- admin: ตั้งค่ากลุ่มแจ้งเตือน ----------
app.post('/api/admin/notif', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  const { event_type, label, webhook_url } = req.body || {};
  if (!event_type || !label) return res.status(400).json({ error: 'กรอกประเภทเหตุการณ์และชื่อกลุ่ม' });
  const info = db.prepare('INSERT INTO notif_groups(event_type,label,webhook_url) VALUES(?,?,?)')
    .run(event_type, label, webhook_url || '');
  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/admin/notif/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  db.prepare('DELETE FROM notif_groups WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/reports/:id', auth, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'ไม่พบรายงาน' });
  const visits = db.prepare(
    `SELECT v.*, c.code, c.name cp_name, c.lat cp_lat, c.lng cp_lng FROM visits v
     JOIN checkpoints c ON c.id=v.checkpoint_id WHERE v.shift_id=? ORDER BY v.id`
  ).all(r.shift_id);
  res.json({ ...r, detail: JSON.parse(r.detail || '{}'), visits });
});

// ---------- guard: สแกน QR เช็คอิน ----------
app.post('/api/guard/checkin', auth, (req, res) => {
  const { qr } = req.body || {};
  const postId = verifyPostQR(qr);
  if (!postId) return res.status(400).json({ error: 'QR ไม่ถูกต้องหรือปลอม — ลองสแกนอีกครั้ง' });
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(postId);
  if (!post) return res.status(404).json({ error: 'ไม่พบป้อมนี้' });
  // ถ้ามีกะที่ยังไม่จบอยู่ ให้ใช้กะนั้นต่อ
  const open = db.prepare(
    "SELECT * FROM shifts WHERE guard_id=? AND status IN ('checked_in','patrolling') ORDER BY id DESC LIMIT 1"
  ).get(req.user.userId);
  let shift;
  if (open && open.post_id === postId) {
    shift = open;
  } else {
    if (open) db.prepare("UPDATE shifts SET status='checked_out', checked_out_at=? WHERE id=?").run(now(), open.id);
    const info = db.prepare('INSERT INTO shifts(guard_id,post_id,status,checked_in_at) VALUES(?,?,?,?)')
      .run(req.user.userId, postId, 'checked_in', now());
    shift = db.prepare('SELECT * FROM shifts WHERE id=?').get(info.lastInsertRowid);
  }
  const checkpoints = db.prepare('SELECT * FROM checkpoints ORDER BY seq').all();
  broadcast({ type: 'shift', shift: { ...shift, guard_name: req.user.name, post_name: post.name } });
  res.json({ shift, post, checkpoints });
});

// ---------- guard: กดเริ่มปฏิบัติงาน ----------
app.post('/api/guard/start', auth, (req, res) => {
  const { shiftId } = req.body || {};
  const s = db.prepare('SELECT * FROM shifts WHERE id=? AND guard_id=?').get(shiftId, req.user.userId);
  if (!s) return res.status(404).json({ error: 'ไม่พบกะนี้' });
  if (s.status === 'checked_out') return res.status(400).json({ error: 'กะนี้จบไปแล้ว' });
  db.prepare("UPDATE shifts SET status='patrolling', started_at=COALESCE(started_at,?) WHERE id=?").run(now(), s.id);
  broadcast({ type: 'shift', shift: { ...db.prepare('SELECT * FROM shifts WHERE id=?').get(s.id), guard_name: req.user.name } });
  res.json({ ok: true, status: 'patrolling' });
});

// ---------- guard: บันทึกตำแหน่ง (REST สำรอง) ----------
app.post('/api/guard/position', auth, (req, res) => {
  const { shiftId, lat, lng, accuracy } = req.body || {};
  const s = db.prepare('SELECT * FROM shifts WHERE id=? AND guard_id=?').get(shiftId, req.user.userId);
  if (!s || s.status === 'checked_out') return res.status(400).json({ error: 'กะไม่Active' });
  savePosition(s, lat, lng, accuracy);
  res.json({ ok: true });
});

function savePosition(shift, lat, lng, accuracy) {
  if (!isFinite(lat) || !isFinite(lng)) return;
  const ts = now();
  db.prepare('INSERT INTO gps_tracks(shift_id,lat,lng,accuracy,ts) VALUES(?,?,?,?,?)')
    .run(shift.id, lat, lng, accuracy ?? null, ts);
  broadcast({ type: 'gps', shiftId: shift.id, guard: shift.guard_id, lat, lng, accuracy, ts });
}

// ---------- guard: ถ่ายรูปเช็คจุดตรวจ + ตรวจ geofence ----------
app.post('/api/guard/visit', auth, (req, res) => {
  const { shiftId, checkpointId, lat, lng, accuracy, photo } = req.body || {};
  const s = db.prepare('SELECT * FROM shifts WHERE id=? AND guard_id=?').get(shiftId, req.user.userId);
  if (!s || s.status === 'checked_out') return res.status(400).json({ error: 'กะไม่ active' });
  const cp = db.prepare('SELECT * FROM checkpoints WHERE id=?').get(checkpointId);
  if (!cp) return res.status(404).json({ error: 'ไม่พบจุดตรวจ' });
  const dist = haversineM(lat, lng, cp.lat, cp.lng);
  const inside = dist <= cp.radius;
  // บันทึกรูป
  let photoPath = null;
  if (photo && typeof photo === 'string' && photo.startsWith('data:image')) {
    const buf = Buffer.from(photo.split(',')[1], 'base64');
    photoPath = `v_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`;
    fs.writeFileSync(path.join(UPLOAD_DIR, photoPath), buf);
  }
  const info = db.prepare(
    'INSERT INTO visits(shift_id,checkpoint_id,lat,lng,accuracy,inside,photo,ts) VALUES(?,?,?,?,?,?,?,?)'
  ).run(s.id, cp.id, lat, lng, accuracy ?? null, inside ? 1 : 0, photoPath, now());
  const visit = db.prepare('SELECT * FROM visits WHERE id=?').get(info.lastInsertRowid);
  broadcast({ type: 'visit', shiftId: s.id, guard: req.user.name, checkpoint: cp.code, inside, dist: Math.round(dist), ts: visit.ts });
  if (!inside) {
    return res.status(409).json({
      error: `ยังอยู่นอกรัศมีจุดตรวจ (ห่าง ${Math.round(dist)} ม. — ต้องไม่เกิน ${cp.radius} ม.)`,
      dist: Math.round(dist), radius: cp.radius, visitId: visit.id,
    });
  }
  res.json({ ok: true, visit, dist: Math.round(dist), radius: cp.radius });
});

// ---------- guard: สแกน QR เช็คเอาต์ + สร้างรายงาน ----------
app.post('/api/guard/checkout', auth, async (req, res) => {
  const { shiftId, qr } = req.body || {};
  const postId = verifyPostQR(qr);
  if (!postId) return res.status(400).json({ error: 'QR ไม่ถูกต้อง — ลองสแกนอีกครั้ง' });
  const s = db.prepare('SELECT * FROM shifts WHERE id=? AND guard_id=?').get(shiftId, req.user.userId);
  if (!s) return res.status(404).json({ error: 'ไม่พบกะนี้' });
  if (s.status === 'checked_out') return res.status(400).json({ error: 'กะนี้เช็คเอาต์ไปแล้ว' });
  db.prepare("UPDATE shifts SET status='checked_out', checked_out_at=? WHERE id=?").run(now(), s.id);

  // สร้างรายงาน
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(s.post_id);
  const total = db.prepare('SELECT COUNT(*) c FROM checkpoints').get().c;
  const visits = db.prepare(
    `SELECT v.*, c.code, c.name cp_name FROM visits v JOIN checkpoints c ON c.id=v.checkpoint_id
     WHERE v.shift_id=? AND v.inside=1 ORDER BY v.id`
  ).all(s.id);
  const trackCount = db.prepare('SELECT COUNT(*) c FROM gps_tracks WHERE shift_id=?').get(s.id).c;
  const detail = {
    guard: req.user.name,
    post: post.name,
    checked_in_at: s.checked_in_at,
    started_at: s.started_at,
    checked_out_at: now(),
    checkpoints_total: total,
    checkpoints_visited: visits.length,
    gps_points: trackCount,
    visits: visits.map((v) => ({
      code: v.code, name: v.cp_name, ts: v.ts,
      lat: v.lat, lng: v.lng, accuracy: v.accuracy, photo: v.photo ? `/uploads/${v.photo}` : null,
    })),
  };
  const info = db.prepare(
    `INSERT INTO reports(shift_id,guard_name,post_name,started_at,ended_at,total,visited,detail,sent_to,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).run(s.id, req.user.name, post.name, s.started_at || s.checked_in_at, now(), total, visits.length,
    JSON.stringify(detail), '', now());
  const reportId = info.lastInsertRowid;

  // ส่งรายงานไปยังกลุ่มที่ตั้งค่าไว้ (webhook — ใช้เป็น LINE/Telegram ได้)
  const groups = db.prepare("SELECT * FROM notif_groups WHERE event_type='shift_report'").all();
  const text = `📋 รายงานจบกะ #${reportId}\nรปภ.: ${req.user.name}\nป้อม: ${post.name}\nเช็คจุดตรวจสำเร็จ ${visits.length}/${total} จุด\nเริ่ม ${s.started_at || s.checked_in_at} — จบ ${now()}`;
  const sent = [];
  for (const g of groups) {
    if (!g.webhook_url) continue;
    try {
      const r = await fetch(g.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group: g.label, text, reportId, detail }),
      });
      sent.push(`${g.label}:${r.ok ? 'ok' : 'http' + r.status}`);
    } catch (e) {
      sent.push(`${g.label}:error`);
    }
  }
  db.prepare('UPDATE reports SET sent_to=? WHERE id=?').run(sent.join(',') || 'inbox', reportId);

  broadcast({ type: 'report', reportId, guard: req.user.name, visited: visits.length, total });
  res.json({ ok: true, reportId, visited: visits.length, total, sent_to: sent });
});

// ---------- admin: เส้นทางย้อนหลังของกะ ----------
app.get('/api/admin/shift/:id/track', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  const track = db.prepare('SELECT lat,lng,accuracy,ts FROM gps_tracks WHERE shift_id=? ORDER BY id').all(req.params.id);
  const s = db.prepare(
    `SELECT s.*, u.name guard_name, p.name post_name FROM shifts s
     JOIN users u ON u.id=s.guard_id JOIN posts p ON p.id=s.post_id WHERE s.id=?`
  ).get(req.params.id);
  res.json({ shift: s, track });
});

// ---------- guard: สถานะกะปัจจุบัน ----------
app.get('/api/guard/shift/:id', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM shifts WHERE id=? AND guard_id=?').get(req.params.id, req.user.userId);
  if (!s) return res.status(404).json({ error: 'ไม่พบกะนี้' });
  const visits = db.prepare(
    `SELECT v.*, c.code, c.name cp_name FROM visits v JOIN checkpoints c ON c.id=v.checkpoint_id
     WHERE v.shift_id=? ORDER BY v.id`
  ).all(s.id);
  const track = db.prepare('SELECT lat,lng,accuracy,ts FROM gps_tracks WHERE shift_id=? ORDER BY id').all(s.id);
  res.json({ shift: s, visits, track });
});

// ---------- WebSocket (Realtime ไปหน้า Admin) ----------
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Smart Guard Tour running: http://0.0.0.0:${PORT}`);
});
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(data);
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const u = tokens.get(url.searchParams.get('token') || '');
  if (!u) { ws.close(4001, 'unauthorized'); return; }
  ws.user = u;
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', user: u.name, role: u.role }));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'pos') {
      const s = db.prepare('SELECT * FROM shifts WHERE id=? AND guard_id=?').get(m.shiftId, u.userId);
      if (s && s.status !== 'checked_out') savePosition(s, m.lat, m.lng, m.accuracy);
    }
  });
  ws.on('close', () => clients.delete(ws));
});
