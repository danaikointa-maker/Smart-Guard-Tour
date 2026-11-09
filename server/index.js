const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { db, now, UPLOAD_DIR } = require('./db');
const { haversineM } = require('./geo');
const { makePostQRWithPng, verifyPostQR } = require('./qr');
const { savePhoto } = require('./storage');
const XLSX = require('xlsx');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '15mb' }));

// ----------ความปลอดภัยพื้นฐาน ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https:; script-src 'self' https://maps.googleapis.com; connect-src 'self' ws: wss: https:");
  next();
});

// rate limit หน้า login (กัน brute-force PIN) — 10 ครั้ง/5 นาที/IP
const loginHits = new Map();
app.use('/api/login', (req, res, next) => {
  const ip = req.ip;
  const nowT = Date.now();
  const arr = (loginHits.get(ip) || []).filter(t => nowT - t < 5 * 60 * 1000);
  if (arr.length >= 10) return res.status(429).json({ error: 'ล็อกอินผิดบ่อยเกินไป — ลองใหม่ใน 5 นาที' });
  res.on('finish', () => { if (res.statusCode === 401) { arr.push(nowT); loginHits.set(ip, arr); } });
  next();
});

// ---------- สาธารณะ: ภาพรวมสถานะ (ไม่ต้องล็อกอิน — ข้อมูลรวมอย่างเดียว ไม่มีพิกัด/ชื่อ รปภ.) ----------
app.get('/api/public/summary', (req, res) => {
  const get = (k, dflt) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : dflt; };
  if (get('public_dashboard', 'true') !== 'true')
    return res.status(403).json({ error: 'ผู้ดูแลปิดแดชบอร์ดสาธารณะอยู่', public_dashboard: false });
  const today = new Date().toISOString().slice(0, 10);
  const posts = db.prepare('SELECT id, name, lat, lng FROM posts ORDER BY id').all().map(p => {
    //ความคืบหน้าวันนี้ของป้อมนี้: จุดที่ถูกเช็คแล้ว (inside) ในกะของป้อมนี้วันนี้
    const row = db.prepare(`
      SELECT COUNT(DISTINCT v.checkpoint_id) c
      FROM visits v JOIN shifts s ON s.id=v.shift_id
      WHERE s.post_id=? AND v.inside=1 AND substr(v.ts,1,10)=?`).get(p.id, today);
    const total = db.prepare('SELECT COUNT(*) c FROM checkpoints WHERE COALESCE(site_id,0)=COALESCE((SELECT site_id FROM posts WHERE id=?),0)').get(p.id).c;
    return { post_id: p.id, name: p.name, visited_today: row.c, total };
  });
  const active = db.prepare("SELECT COUNT(*) c FROM shifts WHERE status IN ('checked_in','patrolling')").get().c;
  const patrolNow = db.prepare("SELECT COUNT(*) c FROM shifts WHERE status='patrolling'").get().c;
  const openInc = db.prepare("SELECT COUNT(*) c FROM incidents WHERE status='open'").get().c;
  const sosToday = db.prepare('SELECT COUNT(*) c FROM audit_logs WHERE action=\'sos\' AND substr(ts,1,10)=?').get(today).c;
  const lastAct = db.prepare('SELECT MAX(ts) ts FROM gps_tracks').get();
  const shiftsToday = db.prepare('SELECT COUNT(*) c FROM shifts WHERE substr(checked_in_at,1,10)=?').get(today).c;
  res.json({
    public_dashboard: true, site_name: get('site_name', 'Smart Guard Tour'),
    as_of: now(), active_shifts: active, patrolling_now: patrolNow,
    shifts_today: shiftsToday, open_incidents: openInc, sos_today: sosToday,
    last_activity: lastAct ? lastAct.ts : null, posts,
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true, ts: now(), uptime: process.uptime() }));
app.get('/api/openapi.json', (req, res) => res.sendFile(path.join(__dirname, '..', 'docs', 'openapi.json')));
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
  const ttlH = parseFloat(db.prepare("SELECT value FROM settings WHERE key='session_ttl_hours'").get()?.value || '12');
  if (ttlH > 0 && u.ts && Date.now() - u.ts > ttlH * 3600 * 1000) {
    tokens.delete(t);
    return res.status(401).json({ error: 'เซสชันหมดอายุ — ล็อกอินใหม่' });
  }
  req.user = u;
  next();
}
const canView = (u) => u.role === 'admin' || u.role === 'supervisor'; // หัวหน้า รปภ. อ่านได้
function audit(actor, action, detail) {
  try { db.prepare('INSERT INTO audit_logs(ts,actor,action,detail) VALUES(?,?,?,?)')
    .run(now(), String(actor), action, typeof detail === 'string' ? detail : JSON.stringify(detail || {})); } catch {}
}


// ---------- SSO ผ่านระบบ VVA ----------
// ในโปรดักชัน: VVA redirect กลับมาพร้อม code → แลก token ที่ VVA → verify signature
// ต้นแบบนี้จำลองด้วย signed token รูปแบบ vva:{base64(json)}:{hmac}
function makeMockVvaToken(sub, name) {
  const body = Buffer.from(JSON.stringify({ sub, name, iss: 'vva-sso', iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET_SSO).update(body).digest('base64url').slice(0, 24);
  return `vva:${body}:${sig}`;
}
const SECRET_SSO = process.env.VVA_SSO_SECRET || 'vva-dev-secret';

// หน้าเว็บกดปุ่ม "เข้าด้วย SSO" → ระบบจำลองว่า VVA ออก token ให้ (โหมดเดโม่)
app.get('/api/sso/mock-issue', (req, res) => {
  const enabled = db.prepare("SELECT value FROM settings WHERE key='sso_enabled'").get();
  if (!enabled || enabled.value !== 'true') return res.status(403).json({ error: 'ยังไม่เปิดใช้งาน SSO' });
  const name = String(req.query.name || 'สมชาย');
  const u = db.prepare('SELECT * FROM users WHERE name=?').get(name);
  if (!u) return res.status(404).json({ error: 'ไม่พบบัญชี ' + name + ' — สร้างในแท็บผู้ใช้ก่อน' });
  if (req.query.redirect === '1') {
    // โหมดเดโม่: ออก session token ตรงๆ แล้วเด้งไปหน้า sso-done (ข้ามขั้นตอน VVA)
    const token = crypto.randomBytes(24).toString('hex');
    tokens.set(token, { userId: u.id, role: u.role, name: u.name });
    audit(u.name, 'sso_login_mock', {});
    return res.send(`<script>localStorage.setItem('sgt_sso_token', '${token}'); location.href = '/sso-done.html';</script>`);
  }
  res.json({ vva_token: makeMockVvaToken(String(u.id), u.name), provider: 'VVA SSO (mock)' });
});

// callback: รับ token จาก VVA, verify, map/create user, ออก token ระบบเรา
app.post('/api/sso/login', (req, res) => {
  const { vva_token } = req.body || {};
  const enabled = db.prepare("SELECT value FROM settings WHERE key='sso_enabled'").get();
  if (!enabled || enabled.value !== 'true') return res.status(403).json({ error: 'ยังไม่เปิดใช้งาน SSO' });
  const m = /^vva:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(String(vva_token || ''));
  if (!m) return res.status(400).json({ error: 'รูปแบบ token ไม่ถูกต้อง' });
  const expect = crypto.createHmac('sha256', SECRET_SSO).update(m[1]).digest('base64url').slice(0, 24);
  if (expect !== m[2]) return res.status(401).json({ error: 'token ปลอมหรือหมดอายุ' });
  let payload;
  try { payload = JSON.parse(Buffer.from(m[1], 'base64url').toString()); } catch { return res.status(400).json({ error: 'tokenใช้ไม่ได้' }); }
  let user = db.prepare('SELECT * FROM users WHERE vva_user_id=?').get(payload.sub);
  if (!user) {
    // ผูกบัญชีเดิมด้วยชื่อ หรือสร้างใหม่ (บทบาทเริ่มต้น = guard)
    user = db.prepare('SELECT * FROM users WHERE name=?').get(payload.name);
    if (user) db.prepare('UPDATE users SET vva_user_id=? WHERE id=?').run(payload.sub, user.id);
    else {
      const info = db.prepare('INSERT INTO users(name,pin,role,vva_user_id) VALUES(?,?,?,?)')
        .run(payload.name, crypto.randomBytes(3).toString('hex'), 'guard', payload.sub);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
    }
  }
  audit(payload.name, 'sso_login', { provider: payload.iss });
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { userId: user.id, role: user.role, name: user.name, ts: Date.now() });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role }, via: 'sso' });
});


// ---------- SSO แบบ OAuth2/OIDC จริง (ต่อ VVA) ----------
// ตั้งค่าใน env: VVA_SSO_AUTH_URL, VVA_SSO_TOKEN_URL, VVA_SSO_USERINFO_URL,
// VVA_SSO_CLIENT_ID, VVA_SSO_CLIENT_SECRET, SGT_PUBLIC_URL
// ถ้าไม่ตั้ง env → ใช้โหมด mock เดิม (mock-issue)
const ssoStates = new Map(); // state -> {name, ts}
function ssoConfigured() {
  return !!(process.env.VVA_SSO_AUTH_URL && process.env.VVA_SSO_CLIENT_ID && process.env.SGT_PUBLIC_URL);
}

// Step 1: redirect ไปหน้า login ของ VVA
app.get('/api/sso/authorize', (req, res) => {
  const name = String(req.query.name || '');
  if (!ssoConfigured()) return res.redirect('/api/sso/mock-issue?name=' + encodeURIComponent(name) + '&redirect=1');
  const state = crypto.randomBytes(12).toString('hex');
  ssoStates.set(state, { name, ts: Date.now() });
  const redirectUri = encodeURIComponent(process.env.SGT_PUBLIC_URL + '/api/sso/callback');
  const url = `${process.env.VVA_SSO_AUTH_URL}?response_type=code&client_id=${process.env.VVA_SSO_CLIENT_ID}&redirect_uri=${redirectUri}&scope=openid%20profile&state=${state}`;
  res.redirect(url);
});

// Step 2: VVA redirect กลับมาพร้อม code → แลก token → อ่าน userinfo → ผูกบัญชี
app.get('/api/sso/callback', async (req, res) => {
  const { code, state } = req.query;
  const st = ssoStates.get(state || '');
  if (!st || Date.now() - st.ts > 10 * 60 * 1000) return res.status(400).send('state ไม่ถูกต้องหรือหมดอายุ');
  ssoStates.delete(state);
  try {
    const tokenRes = await fetch(process.env.VVA_SSO_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: String(code),
        redirect_uri: process.env.SGT_PUBLIC_URL + '/api/sso/callback',
        client_id: process.env.VVA_SSO_CLIENT_ID,
        client_secret: process.env.VVA_SSO_CLIENT_SECRET || '',
      }),
    });
    const vvaTokens = await tokenRes.json();
    const uiRes = await fetch(process.env.VVA_SSO_USERINFO_URL || process.env.VVA_SSO_AUTH_URL.replace('/authorize', '/userinfo'), {
      headers: { Authorization: 'Bearer ' + vvaTokens.access_token },
    });
    const ui = await uiRes.json();
    const sub = String(ui.sub || ui.id || '');
    const name = ui.name || ui.preferred_username || st.name;
    let user = db.prepare('SELECT * FROM users WHERE vva_user_id=?').get(sub);
    if (!user) {
      user = db.prepare('SELECT * FROM users WHERE name=?').get(name);
      if (user) db.prepare('UPDATE users SET vva_user_id=? WHERE id=?').run(sub, user.id);
      else {
        const info = db.prepare('INSERT INTO users(name,pin,role,vva_user_id) VALUES(?,?,?,?)')
          .run(name, crypto.randomBytes(3).toString('hex'), 'guard', sub);
        user = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
      }
    }
    audit(name, 'sso_login_oidc', { iss: 'vva' });
    const token = crypto.randomBytes(24).toString('hex');
    tokens.set(token, { userId: user.id, role: user.role, name: user.name, ts: Date.now() });
    // ส่ง token กลับหน้าเว็บด้วย fragment (ไม่ log) — หน้าเว็บอ่านแล้ว login
    res.send(`<script>localStorage.setItem('sgt_sso_token', '${token}'); location.href = '/sso-done.html';</script>`);
  } catch (e) {
    res.status(500).send('SSO callback error: ' + e.message);
  }
});


// ตรวจ QR + อายุ
function checkPostQR(qr) {
  const postId = verifyPostQR(qr);
  if (!postId) return { error: 'QR ไม่ถูกต้องหรือปลอม — ลองสแกนอีกครั้ง' };
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(postId);
  if (!post) return { error: 'ไม่พบป้อมนี้' };
  const ttl = db.prepare("SELECT value FROM settings WHERE key='qr_ttl_hours'").get();
  const hours = parseFloat(ttl?.value || '0');
  if (hours > 0 && post.qr_issued_at && (Date.now() - new Date(post.qr_issued_at).getTime()) > hours * 3600 * 1000) {
    return { error: 'QR หมดอายุแล้ว — ขอ QR ใหม่จากผู้ดูแล', expired: true, post };
  }
  return { post };
}

// ---------- auth ----------
app.get('/api/me', auth, (req, res) => res.json(req.user));

app.post('/api/login', (req, res) => {
  const { name, pin } = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE name=? AND pin=?').get(name, pin);
  if (!row) return res.status(401).json({ error: 'ชื่อหรือ PIN ไม่ถูกต้อง' });
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { userId: row.id, role: row.role, name: row.name, ts: Date.now() });
  audit(row.name, 'login', { role: row.role });
  res.json({ token, user: { id: row.id, name: row.name, role: row.role } });
});

// ---------- ค่าตั้งค่า (สาธารณะ — ไม่มีความลับ) ----------
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key,value,label FROM settings').all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

// ---------- admin: ภาพรวม ----------
app.get('/api/admin/overview', auth, (req, res) => {
  if (!canView(req.user)) return res.status(403).json({ error: 'ต้องเป็น admin' });
  res.json({
    sites: db.prepare('SELECT * FROM sites ORDER BY id').all(),
    posts: db.prepare('SELECT id,name,lat,lng,radius,qr,qr_png,site_id,created_at FROM posts ORDER BY id').all(),
    checkpoints: db.prepare('SELECT * FROM checkpoints ORDER BY seq').all(),  // มี site_id ใน select *
    users: db.prepare('SELECT id,name,role FROM users ORDER BY id').all(),
    schedules: db.prepare(
      `SELECT sc.*, u.name guard_name, p.name post_name FROM shift_schedules sc
       JOIN users u ON u.id=sc.guard_id JOIN posts p ON p.id=sc.post_id ORDER BY sc.date DESC, sc.start_time`
    ).all(),
    settings: db.prepare('SELECT key,value,label,updated_at FROM settings ORDER BY key').all(),
    shifts: db.prepare(
      `SELECT s.*, u.name guard_name, p.name post_name FROM shifts s
       JOIN users u ON u.id=s.guard_id JOIN posts p ON p.id=s.post_id
       ORDER BY s.id DESC LIMIT 50`
    ).all(),
    reports: db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT 50').all(),
    notif: db.prepare('SELECT * FROM notif_groups ORDER BY id').all(),
    incidents: db.prepare(
      `SELECT i.*, u.name guard_name FROM incidents i JOIN users u ON u.id=i.guard_id ORDER BY i.id DESC LIMIT 50`
    ).all(),
    audit: db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100').all(),
  });
});

// ---------- admin: ตั้งค่าระบบ ----------
app.put('/api/admin/settings', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  const entries = Object.entries(req.body || {});
  const upd = db.prepare('UPDATE settings SET value=?, updated_at=? WHERE key=?');
  let n = 0;
  for (const [k, v] of entries) {
    const r = upd.run(String(v), now(), k);
    if (r.changes > 0) n++;
  }
  audit(req.user.name, 'settings_update', entries.map(([k]) => k).join(','));
  res.json({ ok: true, updated: n });
});

// ---------- admin: จัดการผู้ใช้ ----------
app.post('/api/admin/users', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  const { name, pin, role } = req.body || {};
  if (!name || !pin || !['guard', 'supervisor', 'resident', 'admin'].includes(role))
    return res.status(400).json({ error: 'กรอกชื่อ PIN และเลือกบทบาท (guard/supervisor/resident/admin)' });
  try {
    const info = db.prepare('INSERT INTO users(name,pin,role) VALUES(?,?,?)').run(name.trim(), String(pin), role);
    audit(req.user.name, 'user_create', { id: info.lastInsertRowid, name, role });
    res.json({ id: info.lastInsertRowid });
  } catch (e) { res.status(409).json({ error: 'ชื่อนี้มีอยู่แล้ว' }); }
});

app.put('/api/admin/users/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  const { name, pin, role } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  if (role && !['guard', 'supervisor', 'resident', 'admin'].includes(role)) return res.status(400).json({ error: 'บทบาทไม่ถูกต้อง' });
  db.prepare('UPDATE users SET name=COALESCE(?,name), pin=COALESCE(?,pin), role=COALESCE(?,role) WHERE id=?')
    .run(name ? name.trim() : null, pin ? String(pin) : null, role || null, u.id);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  if (Number(req.params.id) === req.user.userId) return res.status(400).json({ error: 'ลบบัญชีตัวเองไม่ได้' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- admin: ตารางเวร ----------
app.post('/api/admin/schedules', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  const { guard_id, post_id, date, start_time, end_time } = req.body || {};
  if (!guard_id || !post_id || !date || !start_time || !end_time)
    return res.status(400).json({ error: 'กรอกข้อมูลให้ครบ (รปภ./ป้อม/วันที่/เวลาเริ่ม-จบ)' });
  const info = db.prepare('INSERT INTO shift_schedules(guard_id,post_id,date,start_time,end_time) VALUES(?,?,?,?,?)')
    .run(guard_id, post_id, date, start_time, end_time);
  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/admin/schedules/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  db.prepare('DELETE FROM shift_schedules WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- admin: โครงการ (sites) ----------
app.post('/api/admin/sites', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  const { name, address } = req.body || {};
  if (!name) return res.status(400).json({ error: 'ใส่ชื่อโครงการ' });
  const info = db.prepare('INSERT INTO sites(name,address,created_at) VALUES(?,?,?)').run(name.trim(), address || '', now());
  audit(req.user.name, 'site_create', { id: info.lastInsertRowid, name });
  res.json({ id: info.lastInsertRowid });
});

// ---------- admin: สร้างป้อม + QR ----------
app.post('/api/admin/posts', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  const { name, lat, lng, radius, site_id } = req.body || {};
  if (!name || !isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: 'กรอกชื่อและเลือกพิกัดบนแผนที่' });
  const defR = db.prepare("SELECT value FROM settings WHERE key='default_post_radius_m'").get();
  const defSite = db.prepare('SELECT id FROM sites ORDER BY id LIMIT 1').get();
  const ins = db.prepare('INSERT INTO posts(name,lat,lng,radius,qr,qr_png,site_id,created_at) VALUES(?,?,?,?,?,?,?,?)');
  const info = ins.run(name, lat, lng, Number(radius) || Number(defR?.value || 30), 'temp', 'temp', site_id || defSite?.id || null, now());
  audit(req.user.name, 'post_create', { id: info.lastInsertRowid, name });
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
  const { name, lat, lng, radius, seq, site_id } = req.body || {};
  if (!name || !isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: 'กรอกชื่อและเลือกพิกัดบนแผนที่' });
  const defR = db.prepare("SELECT value FROM settings WHERE key='default_checkpoint_radius_m'").get();
  const defSite = db.prepare('SELECT id FROM sites ORDER BY id LIMIT 1').get();
  const count = db.prepare('SELECT COUNT(*) c FROM checkpoints').get().c;
  const code = `CP-${String(count + 1).padStart(2, '0')}`;
  const ins = db.prepare('INSERT INTO checkpoints(code,name,lat,lng,radius,seq,site_id) VALUES(?,?,?,?,?,?,?)');
  const info = ins.run(code, name, lat, lng, Number(radius) || Number(defR?.value || 100), Number(seq) || count + 1, site_id || defSite?.id || null);
  audit(req.user.name, 'checkpoint_create', { code, name });
  res.json({ id: info.lastInsertRowid, code });
});

app.put('/api/admin/checkpoints/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  const { name, radius, require_two_person } = req.body || {};
  const cp = db.prepare('SELECT * FROM checkpoints WHERE id=?').get(req.params.id);
  if (!cp) return res.status(404).json({ error: 'ไม่พบจุดตรวจ' });
  db.prepare('UPDATE checkpoints SET name=COALESCE(?,name), radius=COALESCE(?,radius), require_two_person=COALESCE(?,require_two_person) WHERE id=?')
    .run(name ?? null, radius ?? null, require_two_person != null ? (require_two_person ? 1 : 0) : null, cp.id);
  audit(req.user.name, 'checkpoint_update', { id: cp.id, code: cp.code });
  res.json({ ok: true });
});

app.delete('/api/admin/checkpoints/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  db.prepare('DELETE FROM checkpoints WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- admin: ตั้งค่ากลุ่มแจ้งเตือน ----------
app.post('/api/admin/notif', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  const { event_type, label, channel, webhook_url, bot_token, chat_id } = req.body || {};
  if (!event_type || !label) return res.status(400).json({ error: 'กรอกประเภทเหตุการณ์และชื่อกลุ่ม' });
  if (!['webhook', 'telegram', 'line'].includes(channel || 'webhook'))
    return res.status(400).json({ error: 'ช่องทางต้องเป็น webhook/telegram/line' });
  const info = db.prepare(
    'INSERT INTO notif_groups(event_type,label,channel,webhook_url,bot_token,chat_id) VALUES(?,?,?,?,?,?)'
  ).run(event_type, label, channel || 'webhook', webhook_url || '', bot_token || '', chat_id || '');
  res.json({ id: info.lastInsertRowid });
});

// ส่งข้อความตามช่องทางที่ตั้งค่า — คืน 'ok' หรือ 'error:...'
async function sendToGroup(g, text, extra) {
  try {
    if (g.channel === 'telegram') {
      if (!g.bot_token || !g.chat_id) return 'error:ต้องใส่ bot_token+chat_id';
      const r = await fetch(`https://api.telegram.org/bot${g.bot_token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: g.chat_id, text }),
      });
      return r.ok ? 'ok' : 'http' + r.status;
    }
    if (g.channel === 'line') {
      if (!g.bot_token || !g.chat_id) return 'error:ต้องใส่ access_token+chat_id';
      const r = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + g.bot_token },
        body: JSON.stringify({ to: g.chat_id, messages: [{ type: 'text', text }] }),
      });
      return r.ok ? 'ok' : 'http' + r.status;
    }
    // webhook generic
    if (!g.webhook_url) return 'error:ยังไม่ใส่ URL';
    const r = await fetch(g.webhook_url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: g.label, text, ...extra }),
    });
    return r.ok ? 'ok' : 'http' + r.status;
  } catch (e) { return 'error:' + e.message.slice(0, 40); }
}

// ทดสอบส่งข้อความเข้ากลุ่ม
app.post('/api/admin/notif/:id/test', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  const g = db.prepare('SELECT * FROM notif_groups WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'ไม่พบกลุ่ม' });
  const result = await sendToGroup(g, `🔔 ทดสอบการแจ้งเตือนจาก Smart Guard Tour — กลุ่ม "${g.label}" (${g.event_type})`, {});
  res.json({ ok: result === 'ok', result });
});

app.delete('/api/admin/notif/:id', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  db.prepare('DELETE FROM notif_groups WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/reports/:id', auth, (req, res) => {
  if (!canView(req.user)) return res.status(403).json({ error: 'ไม่มีสิทธิ์' });
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
  const chk = checkPostQR(qr);
  if (chk.error) return res.status(chk.expired ? 410 : 400).json({ error: chk.error });
  const post = chk.post;
  const postId = post.id;
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
  const checkpoints = db.prepare('SELECT * FROM checkpoints WHERE site_id IS NULL OR site_id=? ORDER BY seq').all(post.site_id || 0);
  const today = new Date().toISOString().slice(0, 10);
  const schedule = db.prepare(
    'SELECT * FROM shift_schedules WHERE guard_id=? AND date=? ORDER BY start_time LIMIT 1'
  ).get(req.user.userId, today);
  // เตือน/บังคับ ถ้าเช็คอินนอกเวร (เทียบเวลาท้องถิ่น UTC+7)
  let scheduleWarning = null;
  if (schedule) {
    const nowBkk = new Date(Date.now() + 7 * 3600 * 1000);
    const hm = nowBkk.toISOString().slice(11, 16);
    const inWindow = schedule.start_time <= schedule.end_time
      ? (hm >= schedule.start_time && hm <= schedule.end_time)
      : (hm >= schedule.start_time || hm <= schedule.end_time); // ข้ามเที่ยงคืน
    if (!inWindow) {
      scheduleWarning = `⚠️ ตอนนี้ ${hm} น. อยู่นอกเวร ${schedule.start_time}–${schedule.end_time} น. ของคุณ`;
      const enforce = db.prepare("SELECT value FROM settings WHERE key='enforce_schedule'").get();
      if (enforce && enforce.value === 'true') {
        audit(req.user.name, 'checkin_blocked_out_of_schedule', { hm, schedule: schedule.id });
        return res.status(403).json({ error: scheduleWarning + ' — ระบบตั้งค่าให้บังคับเช็คอินในเวรเท่านั้น' });
      }
    }
  }
  audit(req.user.name, 'checkin', { shift: shift.id, post: post.name });
  broadcast({ type: 'shift', shift: { ...shift, guard_name: req.user.name, post_name: post.name } });
  res.json({ shift, post, checkpoints, schedule, scheduleWarning });
});

// ---------- guard: กดเริ่มปฏิบัติงาน ----------
app.post('/api/guard/start', auth, (req, res) => {
  const { shiftId } = req.body || {};
  const s = db.prepare('SELECT * FROM shifts WHERE id=? AND guard_id=?').get(shiftId, req.user.userId);
  if (!s) return res.status(404).json({ error: 'ไม่พบกะนี้' });
  if (s.status === 'checked_out') return res.status(400).json({ error: 'กะนี้จบไปแล้ว' });
  db.prepare("UPDATE shifts SET status='patrolling', started_at=COALESCE(started_at,?) WHERE id=?").run(now(), s.id);
  audit(req.user.name, 'shift_start', { shift: s.id });
  broadcast({ type: 'shift', shift: { ...db.prepare('SELECT * FROM shifts WHERE id=?').get(s.id), guard_name: req.user.name } });
  res.json({ ok: true, status: 'patrolling' });
});

// ---------- guard: บันทึกตำแหน่ง (REST สำรอง) ----------
app.post('/api/guard/position', auth, (req, res) => {
  const { shiftId, lat, lng, accuracy, battery, charging } = req.body || {};
  const s = db.prepare('SELECT * FROM shifts WHERE id=? AND guard_id=?').get(shiftId, req.user.userId);
  if (!s || s.status === 'checked_out') return res.status(400).json({ error: 'กะไม่Active' });
  savePosition(s, lat, lng, accuracy);
  if (battery != null) saveBattery(req.user.userId, s.id, battery, charging);
  res.json({ ok: true });
});

function savePosition(shift, lat, lng, accuracy) {
  if (!isFinite(lat) || !isFinite(lng)) return;
  const ts = now();
  db.prepare('INSERT INTO gps_tracks(shift_id,lat,lng,accuracy,ts) VALUES(?,?,?,?,?)')
    .run(shift.id, lat, lng, accuracy ?? null, ts);
  broadcast({ type: 'gps', shiftId: shift.id, guard: shift.guard_id, lat, lng, accuracy, ts });
}
// ---------- สถานะเครื่อง (แบต) ล่าสุดของ รปภ. ----------
function saveBattery(userId, shiftId, battery, charging) {
  const b = Number(battery);
  if (!isFinite(b)) return;
  const ts = now();
  db.prepare('INSERT INTO device_status(user_id,battery,charging,ts) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET battery=excluded.battery,charging=excluded.charging,ts=excluded.ts')
    .run(userId, Math.max(0, Math.min(1, b)), charging ? 1 : 0, ts);
  broadcast({ type: 'battery', userId, shiftId, battery: Math.round(b * 100), charging: !!charging, ts });
}

// ---------- guard: ถ่ายรูปเช็คจุดตรวจ + ตรวจ geofence ----------
app.post('/api/guard/visit', auth, async (req, res) => {
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
    photoPath = await savePhoto(UPLOAD_DIR, `v_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`, buf);
  }
  // two-person: ถ้าจุดนี้ต้อง 2 คน —เช็คว่ามี รปภ. อีกคนเช็คค้างไว้ใน 30 นาทีหรือไม่
  let confirmed = 1, paired = false;
  if (inside && cp.require_two_person) {
    const other = db.prepare(
      `SELECT v.* FROM visits v JOIN shifts s2 ON s2.id=v.shift_id
       WHERE v.checkpoint_id=? AND v.inside=1 AND v.confirmed=0 AND s2.guard_id<>?
       AND v.ts > datetime('now','-30 minutes') ORDER BY v.id DESC LIMIT 1`
    ).get(cp.id, req.user.userId);
    if (other) {
      paired = true; confirmed = 1;
      db.prepare('UPDATE visits SET confirmed=1, confirmed_by=? WHERE id=?').run(req.user.userId, other.id);
    } else {
      confirmed = 0; // รอคนที่ 2 มายืนยัน
    }
  }
  const info = db.prepare(
    'INSERT INTO visits(shift_id,checkpoint_id,lat,lng,accuracy,inside,photo,confirmed,confirmed_by,ts) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).run(s.id, cp.id, lat, lng, accuracy ?? null, inside ? 1 : 0, photoPath, confirmed, paired ? req.user.userId : null, now());
  const visit = db.prepare('SELECT * FROM visits WHERE id=?').get(info.lastInsertRowid);
  audit(req.user.name, inside ? (confirmed ? 'visit_ok' : 'visit_pending') : 'visit_outside', { shift: s.id, cp: cp.code, dist: Math.round(dist), two: !!cp.require_two_person });
  broadcast({ type: 'visit', shiftId: s.id, guard: req.user.name, checkpoint: cp.code, inside, confirmed, dist: Math.round(dist), ts: visit.ts });
  if (!inside) {
    return res.status(409).json({
      error: `ยังอยู่นอกรัศมีจุดตรวจ (ห่าง ${Math.round(dist)} ม. — ต้องไม่เกิน ${cp.radius} ม.)`,
      dist: Math.round(dist), radius: cp.radius, visitId: visit.id,
    });
  }
  res.json({ ok: true, confirmed, paired, pending: !confirmed, visit, dist: Math.round(dist), radius: cp.radius });
});

// ---------- guard: สแกน QR เช็คเอาต์ + สร้างรายงาน ----------
app.post('/api/guard/checkout', auth, async (req, res) => {
  const { shiftId, qr } = req.body || {};
  const chk = checkPostQR(qr);
  if (chk.error) return res.status(chk.expired ? 410 : 400).json({ error: chk.error });
  const postId = chk.post.id;
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
  const pendingCount = visits.filter(v => !v.confirmed).length;
  const trackCount = db.prepare('SELECT COUNT(*) c FROM gps_tracks WHERE shift_id=?').get(s.id).c;
  const detail = {
    guard: req.user.name,
    post: post.name,
    checked_in_at: s.checked_in_at,
    started_at: s.started_at,
    checked_out_at: now(),
    checkpoints_total: total,
    checkpoints_visited: visits.length,
    pending_two_person: pendingCount,
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

  // ส่งรายงานไปยังกลุ่มที่ตั้งค่าไว้ (webhook / Telegram / LINE)
  const groups = db.prepare("SELECT * FROM notif_groups WHERE event_type='shift_report'").all();
  const text = `📋 รายงานจบกะ #${reportId}\nรปภ.: ${req.user.name}\nป้อม: ${post.name}\nเช็คจุดตรวจสำเร็จ ${visits.length}/${total} จุด\nเริ่ม ${s.started_at || s.checked_in_at} — จบ ${now()}`;
  const sent = [];
  for (const g of groups) {
    const result = await sendToGroup(g, text, { reportId, detail });
    sent.push(`${g.label}(${g.channel}):${result}`);
  }
  db.prepare('UPDATE reports SET sent_to=? WHERE id=?').run(sent.join(',') || 'inbox', reportId);

  audit(req.user.name, 'checkout_report', { shift: s.id, report: reportId, visited: visits.length, total });
  broadcast({ type: 'report', reportId, guard: req.user.name, visited: visits.length, total });
  res.json({ ok: true, reportId, visited: visits.length, total, sent_to: sent });
});

// ---------- admin: เส้นทางย้อนหลังของกะ ----------
app.get('/api/admin/shift/:id/track', auth, (req, res) => {
  if (!canView(req.user)) return res.status(403).json({ error: 'ต้องเป็น admin' });
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


// ---------- ลูกบ้าน (resident): ดูสถานะตามสิทธิ์ ----------
app.get('/api/resident/status', auth, (req, res) => {
  if (req.user.role !== 'resident' && req.user.role !== 'admin' && req.user.role !== 'supervisor')
    return res.status(403).json({ error: 'เฉพาะลูกบ้านเท่านั้น' });
  const get = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : d; };
  const seeStatus = get('resident_see_status', 'true') === 'true';
  const seeLive = get('resident_see_live_location', 'false') === 'true';
  const seeHistory = get('resident_see_history', 'false') === 'true';
  if (!seeStatus) return res.json({ see_status: false, shifts: [] });

  // สรุปกะล่าสุด (ไม่มีพิกัดสดถ้าไม่ได้รับสิทธิ์)
  const shifts = db.prepare(
    `SELECT s.id, s.status, s.checked_in_at, s.started_at, s.checked_out_at,
            u.name guard_name, p.name post_name
     FROM shifts s JOIN users u ON u.id=s.guard_id JOIN posts p ON p.id=s.post_id
     ORDER BY s.id DESC LIMIT 10`
  ).all().map(s => {
    const total = db.prepare('SELECT COUNT(*) c FROM checkpoints').get().c;
    const visited = db.prepare('SELECT COUNT(*) c FROM visits WHERE shift_id=? AND inside=1').get(s.id).c;
    const last = db.prepare('SELECT ts FROM gps_tracks WHERE shift_id=? ORDER BY id DESC LIMIT 1').get(s.id);
    const out = { ...s, checkpoints_total: total, checkpoints_visited: visited, last_update: last ? last.ts : null };
    if (seeLive && s.status === 'patrolling') {
      const g = db.prepare('SELECT lat,lng,accuracy,ts FROM gps_tracks WHERE shift_id=? ORDER BY id DESC LIMIT 1').get(s.id);
      if (g) out.live = g;
    }
    if (seeHistory) {
      out.track = db.prepare('SELECT lat,lng,ts FROM gps_tracks WHERE shift_id=? ORDER BY id').all(s.id);
    }
    return out;
  });
  res.json({ see_status: true, see_live_location: seeLive, see_history: seeHistory, shifts });
});

// ---------- รปภ.: ปุ่ม SOS ฉุกเฉิน ----------
async function raiseSOS(user, shiftId, lat, lng) {
  const s = db.prepare('SELECT * FROM shifts WHERE id=? AND guard_id=?').get(shiftId, user.userId);
  if (!s) return null;
  const mapsLink = `https://www.google.com/maps?q=${lat},${lng}`;
  const text = `🚨 SOS! รปภ. ${user.name} แจ้งฉุกเฉิน
กะ #${s.id} · ${lat}, ${lng}
แผนที่: ${mapsLink}
เวลา ${now()}`;
  audit(user.name, 'sos', { shift: s.id, lat, lng });
  broadcast({ type: 'sos', guard: user.name, shiftId: s.id, lat, lng, ts: now() });
  sendPush('🚨 SOS ฉุกเฉิน!', `${user.name} กด SOS ที่ ${lat}, ${lng}`, { sos: true, shiftId: s.id });
  const groups = db.prepare("SELECT * FROM notif_groups WHERE event_type='sos'").all();
  const sent = [];
  for (const g of groups) sent.push(`${g.label}(${g.channel}):` + await sendToGroup(g, text, { sos: true, shiftId: s.id, lat, lng }));
  return sent;
}
app.post('/api/guard/sos', auth, async (req, res) => {
  const { shiftId, lat, lng } = req.body || {};
  const sent = await raiseSOS(req.user, shiftId, lat, lng);
  if (!sent) return res.status(404).json({ error: 'ไม่พบกะนี้' });
  res.json({ ok: true, sent_to: sent });
});


// ---------- แจ้งเตือน "จุดตรวจที่ยังไม่ถึง" (เช็คทุก 60 วินาที) ----------
const alertedMissed = new Set();
setInterval(() => {
  try {
    const active = db.prepare("SELECT * FROM shifts WHERE status='patrolling'").all();
    for (const s of active) {
      const cps = db.prepare('SELECT * FROM checkpoints').all();
      for (const cp of cps) {
        const key = s.id + ':' + cp.id;
        if (alertedMissed.has(key)) continue;
        const done = db.prepare('SELECT COUNT(*) c FROM visits WHERE shift_id=? AND checkpoint_id=? AND inside=1').get(s.id, cp.id).c;
        if (done) continue;
        // แจ้งเมื่อกะเริ่มมาแล้ว 30 นาทีแล้วยังไม่เช็คจุดนี้
        const started = new Date(s.started_at || s.checked_in_at).getTime();
        if (Date.now() - started > 30 * 60 * 1000) {
          alertedMissed.add(key);
          const u = db.prepare('SELECT name FROM users WHERE id=?').get(s.guard_id);
          const text = `⚠️ จุดตรวจ ${cp.code} (${cp.name}) ยังไม่ถูกเช็ค — รปภ. ${u.name} กะ #${s.id} เริ่มมาแล้ว 30+ นาที`;
          broadcast({ type: 'missed_cp', shiftId: s.id, cp: cp.code, guard: u.name });
          sendPush('⚠️ จุดตรวจที่ขาด', `${u.name} ยังไม่เช็ค ${cp.code} (${cp.name})`, { shiftId: s.id });
          db.prepare("SELECT * FROM notif_groups WHERE event_type='missed_checkpoint'").all()
            .forEach(g => sendToGroup(g, text, { shiftId: s.id, checkpoint: cp.code }));
        }
      }
    }
  } catch (e) { console.error('[alert]', e.message); }
}, 60 * 1000);


// ---------- admin: สถิติแดชบอร์ด ----------
app.get('/api/admin/stats', auth, (req, res) => {
  if (!canView(req.user)) return res.status(403).json({ error: 'ไม่มีสิทธิ์' });
  const q = (s) => db.prepare(s).get();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push({ date: d, shifts: db.prepare("SELECT COUNT(*) c FROM shifts WHERE substr(checked_in_at,1,10)=?").get(d).c,
      visits: db.prepare("SELECT COUNT(*) c FROM visits WHERE inside=1 AND substr(ts,1,10)=?").get(d).c });
  }
  const cpStats = db.prepare(
    `SELECT c.code, c.name, COUNT(v.id) visited FROM checkpoints c
     LEFT JOIN visits v ON v.checkpoint_id=c.id AND v.inside=1 GROUP BY c.id ORDER BY c.seq`).all();
  const dur = db.prepare(
    `SELECT AVG((julianday(checked_out_at)-julianday(COALESCE(started_at,checked_in_at)))*24*60) m
     FROM shifts WHERE status='checked_out'`).get().m;
  res.json({
    totals: {
      users: q('SELECT COUNT(*) c FROM users').c,
      guards: q("SELECT COUNT(*) c FROM users WHERE role='guard'").c,
      posts: q('SELECT COUNT(*) c FROM posts').c,
      checkpoints: q('SELECT COUNT(*) c FROM checkpoints').c,
      shifts_total: q('SELECT COUNT(*) c FROM shifts').c,
      shifts_today: q("SELECT COUNT(*) c FROM shifts WHERE substr(checked_in_at,1,10)=date('now')").c,
      reports: q('SELECT COUNT(*) c FROM reports').c,
      sos: q("SELECT COUNT(*) c FROM audit_logs WHERE action='sos'").c,
      incidents: q('SELECT COUNT(*) c FROM incidents').c,
      pending_two_person: q('SELECT COUNT(*) c FROM visits WHERE inside=1 AND confirmed=0').c,
      gps_points: q('SELECT COUNT(*) c FROM gps_tracks').c,
    },
    avg_shift_minutes: dur ? Math.round(dur) : null,
    last7days: days,
    checkpoint_stats: cpStats,
  });
});

// ---------- guard: ซิงก์ออฟไลน์ (คิวในเครื่อง) ----------
app.post('/api/guard/sync', auth, async (req, res) => {
  const { positions = [], visits = [], sos = [], incidents = [] } = req.body || {};
  const s = db.prepare("SELECT * FROM shifts WHERE guard_id=? AND status IN ('checked_in','patrolling') ORDER BY id DESC LIMIT 1").get(req.user.userId);
  let pOk = 0, vOk = 0, vFail = 0;
  if (s) {
    for (const p of positions) { if (isFinite(p.lat) && isFinite(p.lng)) { savePosition(s, p.lat, p.lng, p.accuracy); pOk++; } }
    for (const v of visits) {
      const cp = db.prepare('SELECT * FROM checkpoints WHERE id=?').get(v.checkpointId);
      if (!cp) { vFail++; continue; }
      const dist = haversineM(v.lat, v.lng, cp.lat, cp.lng);
      const inside = dist <= cp.radius;
      let photoPath = null;
      if (v.photo && String(v.photo).startsWith('data:image')) {
        const buf = Buffer.from(String(v.photo).split(',')[1], 'base64');
        photoPath = await savePhoto(UPLOAD_DIR, `v_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`, buf);
      }
      db.prepare('INSERT INTO visits(shift_id,checkpoint_id,lat,lng,accuracy,inside,photo,confirmed,ts) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(s.id, cp.id, v.lat, v.lng, v.accuracy ?? null, inside ? 1 : 0, photoPath, 1, v.ts || now());
      if (inside) vOk++; else vFail++;
    }
  }
  let sosOk = 0, incOk = 0;
  for (const x of sos) {
    const sent = await raiseSOS(req.user, s ? s.id : x.shiftId, x.lat, x.lng);
    if (sent) sosOk++;
  }
  for (const x of incidents) {
    if (!x.type) continue;
    const r = await raiseIncident(req.user, x.type, x.description, x.lat, x.lng, x.accuracy, x.photo);
    if (r) incOk++;
  }
  res.json({ ok: true, positions: pOk, visits_ok: vOk, visits_outside: vFail, sos: sosOk, incidents: incOk });
});


// ---------- รปภ.: แจ้งเหตุการณ์ (ส่งเฉพาะกลุ่มของเหตุการณ์นั้น) ----------
async function raiseIncident(user, type, description, lat, lng, accuracy, photo) {
  if (!type) return null;
  const s = db.prepare("SELECT * FROM shifts WHERE guard_id=? AND status IN ('checked_in','patrolling') ORDER BY id DESC LIMIT 1").get(user.userId);
  let photoPath = null;
  if (photo && String(photo).startsWith('data:image')) {
    const buf = Buffer.from(String(photo).split(',')[1], 'base64');
    photoPath = await savePhoto(UPLOAD_DIR, `inc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.jpg`, buf);
  }
  const info = db.prepare(
    'INSERT INTO incidents(shift_id,guard_id,type,description,lat,lng,accuracy,photo,sent_to,ts) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).run(s ? s.id : null, user.userId, type, description || '', lat ?? null, lng ?? null, accuracy ?? null, photoPath, '', now());
  const id = info.lastInsertRowid;
  const text = `🚨 เหตุการณ์: ${type}\nโดย ${user.name}${s ? ' (กะ #' + s.id + ')' : ''}\n${description ?? ''}\n${lat != null ? '📍 ' + lat + ', ' + lng + ' — https://www.google.com/maps?q=$lat,$lng\n' : ''}เวลา ${now()}`;
  // ส่งเฉพาะกลุ่มที่ตั้ง event_type = 'incident' หรือ 'incident:<type>'
  const groups = db.prepare("SELECT * FROM notif_groups WHERE event_type IN ('incident','incident:'||?)").all(type);
  const sent = [];
  for (const g of groups) sent.push(`${g.label}(${g.channel}):` + await sendToGroup(g, text, { incidentId: id, type }));
  db.prepare('UPDATE incidents SET sent_to=? WHERE id=?').run(sent.join(',') || 'inbox', id);
  audit(user.name, 'incident', { id, type });
  broadcast({ type: 'incident', id, guard: user.name, incidentType: type, lat, lng, ts: now() });
  sendPush('🚨 เหตุการณ์ใหม่: ' + type, `${user.name}: ${description || ''}`, { incidentId: id, type });
  return { id, sent_to: sent };
}
app.post('/api/guard/incident', auth, async (req, res) => {
  const { shiftId, type, description, lat, lng, accuracy, photo } = req.body || {};
  const r = await raiseIncident(req.user, type, description, lat, lng, accuracy, photo);
  if (!r) return res.status(400).json({ error: 'เลือกประเภทเหตุการณ์' });
  res.json({ ok: true, id: r.id, sent_to: r.sent_to });
});



// ---------- admin: ส่งออกรายงานเป็น Excel (.xlsx) ----------
app.get('/api/admin/reports/:id/export.xlsx', auth, (req, res) => {
  if (!canView(req.user)) return res.status(403).json({ error: 'ไม่มีสิทธิ์' });
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'ไม่พบรายงาน' });
  const d = JSON.parse(r.detail || '{}');
  const visits = db.prepare(
    `SELECT v.*, c.code, c.name cp_name FROM visits v JOIN checkpoints c ON c.id=v.checkpoint_id
     WHERE v.shift_id=? ORDER BY v.id`).all(r.shift_id);
  const track = db.prepare('SELECT lat,lng,accuracy,ts FROM gps_tracks WHERE shift_id=? ORDER BY id').all(r.shift_id);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['รายงานกะตรวจ #' + r.id], ['รปภ.', d.guard || r.guard_name], ['ป้อม', d.post || r.post_name],
    ['เริ่ม', d.started_at || ''], ['จบ', d.ended_at || ''], ['เช็คจุดสำเร็จ', `${d.checkpoints_visited}/${d.checkpoints_total}`],
    ['จุด GPS', d.gps_points ?? track.length], ['ส่งถึง', r.sent_to || 'inbox'],
  ]), 'สรุป');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['รหัสจุด', 'ชื่อ', 'เวลา', 'ละติจูด', 'ลองจิจูด', 'ความแม่นยำ (ม.)', 'ในรัศมี', 'รูป'],
    ...visits.map(v => [v.code, v.cp_name, v.ts, v.lat, v.lng, Math.round(v.accuracy || 0), v.inside ? 'ใช่' : 'ไม่', v.photo || '']),
  ]), 'จุดตรวจ');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['#', 'เวลา', 'ละติจูด', 'ลองจิจูด', 'ความแม่นยำ (ม.)'],
    ...track.map((t, i) => [i + 1, t.ts, t.lat, t.lng, Math.round(t.accuracy || 0)]),
  ]), 'เส้นทาง GPS');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="report_${r.id}.xlsx"`);
  res.send(buf);
});


// ---------- สรุปรายสัปดาห์อัตโนมัติ (ทุกจันทร์ 08:00 Bangkok) ----------
function weeklySummaryTick() {
  const bkk = new Date(Date.now() + 7 * 3600 * 1000);
  if (bkk.getUTCDay() !== 1 || bkk.getUTCHours() !== 1) return; // 08:00 BKK = 01:00 UTC
  const today = bkk.toISOString().slice(0, 10);
  const lastWeek = db.prepare(
    `SELECT COUNT(*) shifts, (SELECT COUNT(*) FROM reports) reports,
            (SELECT COUNT(*) FROM visits WHERE inside=1 AND ts > datetime('now','-7 days')) visits,
            (SELECT COUNT(*) FROM incidents WHERE ts > datetime('now','-7 days')) incidents,
            (SELECT COUNT(*) FROM audit_logs WHERE action='sos') sos
     FROM shifts WHERE checked_in_at > datetime('now','-7 days')`).get();
  const text = `📅 สรุปรายสัปดาห์ Smart Guard Tour (${today})\n🕐 กะ 7 วัน: ${lastWeek.shifts}\n📍 เช็คจุดสำเร็จ: ${lastWeek.visits} จุด\n🚨 เหตุการณ์: ${lastWeek.incidents} รายการ\n📋 รายงานทั้งหมด: ${lastWeek.reports} ฉบับ`;
  broadcast({ type: 'weekly', text });
  db.prepare("SELECT * FROM notif_groups WHERE event_type='shift_report'").all()
    .forEach(g => sendToGroup(g, text, { weekly: true }));
  audit('system', 'weekly_summary', { sent: text.length });
}
setInterval(weeklySummaryTick, 60 * 60 * 1000); // เช็คทุกชั่วโมงว่าถึงเวลาไหม


// ---------- admin: ปิดเหตุการณ์ (resolved) ----------
app.post('/api/admin/incidents/:id/resolve', auth, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'supervisor') return res.status(403).json({ error: 'ไม่มีสิทธิ์' });
  const info = db.prepare("UPDATE incidents SET status='resolved', resolved_by=? WHERE id=?").run(req.user.name, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'ไม่พบเหตุการณ์' });
  audit(req.user.name, 'incident_resolve', { id: req.params.id });
  broadcast({ type: 'incident_resolved', id: Number(req.params.id), by: req.user.name });
  res.json({ ok: true });
});

// ---------- ลบข้อมูล GPS เก่าตาม retention (PDPA) ----------
function cleanupOldGps() {
  const r = db.prepare("SELECT value FROM settings WHERE key='gps_retention_days'").get();
  const days = Math.max(1, parseInt(r?.value || '90', 10));
  const del = db.prepare("DELETE FROM gps_tracks WHERE ts < datetime('now', ?)").run(`-${days} days`);
  if (del.changes > 0) audit('system', 'retention_cleanup', { deleted_gps: del.changes, days });
  return del.changes;
}
app.post('/api/admin/cleanup', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  res.json({ ok: true, deleted_gps: cleanupOldGps() });
});
setInterval(() => { try { cleanupOldGps(); } catch (e) { console.error('[cleanup]', e.message); } }, 24 * 60 * 60 * 1000);


// ---------- admin: สำรอง/กู้คืนข้อมูล (JSON dump ทุกตาราง) ----------
const TABLES = ['users','sites','posts','checkpoints','shifts','gps_tracks','visits','incidents','reports','notif_groups','settings','shift_schedules','audit_logs'];
app.get('/api/admin/backup', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  const out = { exported_at: now(), tables: {} };
  for (const t of TABLES) out.tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
  audit(req.user.name, 'backup', { tables: TABLES.length });
  res.setHeader('Content-Disposition', `attachment; filename="sgt-backup-${Date.now()}.json"`);
  res.json(out);
});
app.post('/api/admin/restore', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  const data = req.body || {};
  if (!data.tables) return res.status(400).json({ error: 'ไฟล์สำรองไม่ถูกต้อง' });
  for (const t of TABLES) {
    if (!data.tables[t]) continue;
    db.prepare(`DELETE FROM ${t}`).run();
    const rows = data.tables[t];
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    const ins = db.prepare(`INSERT INTO ${t}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`);
    for (const row of rows) ins.run(...cols.map(c => row[c]));
  }
  audit(req.user.name, 'restore', { tables: Object.keys(data.tables).length });
  res.json({ ok: true });
});

// ---------- admin: ส่งออกสถิติเป็น Excel ----------
app.get('/api/admin/stats/export.xlsx', auth, async (req, res) => {
  if (!canView(req.user)) return res.status(403).json({ error: 'ไม่มีสิทธิ์' });
  const s = db.prepare('SELECT 1').get(); // reuse stats logic inline
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push([d, db.prepare("SELECT COUNT(*) c FROM shifts WHERE substr(checked_in_at,1,10)=?").get(d).c,
      db.prepare("SELECT COUNT(*) c FROM visits WHERE inside=1 AND substr(ts,1,10)=?").get(d).c]);
  }
  const cpStats = db.prepare(
    `SELECT c.code, c.name, COUNT(v.id) visited FROM checkpoints c
     LEFT JOIN visits v ON v.checkpoint_id=c.id AND v.inside=1 GROUP BY c.id ORDER BY c.seq`).all();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['วันที่', 'จำนวนกะ', 'เช็คจุดสำเร็จ'], ...days]), '7 วันย้อนหลัง');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['รหัสจุด', 'ชื่อ', 'ครั้งที่ถูกเช็ค'], ...cpStats.map(c => [c.code, c.name, c.visited])]), 'จุดตรวจ');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="stats_${Date.now()}.xlsx"`);
  res.send(buf);
});


// ---------- admin: ออก QR ใหม่ (rotate) ----------
app.post('/api/admin/posts/:id/rotate-qr', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'ไม่พบป้อม' });
  const qr = await makePostQRWithPng(post.id, post.name);
  db.prepare('UPDATE posts SET qr=?, qr_png=?, qr_issued_at=? WHERE id=?').run(qr.payload, qr.png, now(), post.id);
  audit(req.user.name, 'qr_rotate', { post: post.id });
  res.json({ qr: qr.payload, qr_png: qr.png });
});

// ---------- ปิดกะอัตโนมัติถ้าลืมเช็คเอาต์ ----------
function autoCloseShifts() {
  // กะที่เริ่มมาเกิน 12 ชม. หรือเลยเวลาสิ้นสุดของเวรวันนี้
  const rows = db.prepare(
    `SELECT s.*, sc.end_time FROM shifts s
     LEFT JOIN shift_schedules sc ON sc.guard_id=s.guard_id AND sc.date=date('now')
     WHERE s.status IN ('checked_in','patrolling')`).all();
  const nowBkk = new Date(Date.now() + 7 * 3600 * 1000).toISOString();
  let closed = 0;
  for (const s of rows) {
    const started = new Date(s.started_at || s.checked_in_at).getTime();
    const stale = Date.now() - started > 12 * 3600 * 1000;
    const pastEnd = s.end_time && nowBkk.slice(11, 16) > s.end_time;
    if (stale || pastEnd) {
      db.prepare("UPDATE shifts SET status='checked_out', checked_out_at=? WHERE id=?").run(now(), s.id);
      audit('system', 'shift_auto_closed', { shift: s.id, reason: stale ? 'stale>12h' : 'past_schedule_end' });
      broadcast({ type: 'shift', shift: { ...s, status: 'checked_out', auto: true } });
      closed++;
    }
  }
  return closed;
}
app.post('/api/admin/auto-close', auth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'ต้องเป็น admin' });
  res.json({ ok: true, closed: autoCloseShifts() });
});
setInterval(() => { try { autoCloseShifts(); } catch (e) { console.error('[autoclose]', e.message); } }, 60 * 1000);


// ---------- Web Push (แจ้งเตือนเด้งในเบราว์เซอร์ Admin/หัวหน้า) ----------
let VAPID = { publicKey: '', privateKey: '' };
{
  const pub = db.prepare("SELECT value FROM settings WHERE key='vapid_public'").get();
  const priv = db.prepare("SELECT value FROM settings WHERE key='vapid_private'").get();
  if (pub && priv) { VAPID = { publicKey: pub.value, privateKey: priv.value }; }
  else {
    VAPID = webpush.generateVAPIDKeys();
    db.prepare("INSERT OR REPLACE INTO settings(key,value,label,updated_at) VALUES('vapid_public',?, 'VAPID public key', ?)").run(VAPID.publicKey, now());
    db.prepare("INSERT OR REPLACE INTO settings(key,value,label,updated_at) VALUES('vapid_private',?, 'VAPID private key (อย่าเผยแพร่)', ?)").run(VAPID.privateKey, now());
  }
  webpush.setVapidDetails('mailto:admin@smartguard.local', VAPID.publicKey, VAPID.privateKey);
}
app.get('/api/push/vapid-key', (req, res) => res.json({ publicKey: VAPID.publicKey }));
app.post('/api/push/subscribe', auth, (req, res) => {
  const sub = req.body?.subscription;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'subscription ไม่ถูกต้อง' });
  db.prepare('INSERT OR REPLACE INTO push_subs(user_id,endpoint,sub_json,created_at) VALUES(?,?,?,?)')
    .run(req.user.userId, sub.endpoint, JSON.stringify(sub), now());
  res.json({ ok: true });
});
async function sendPush(title, body, data = {}) {
  const subs = db.prepare('SELECT * FROM push_subs').all();
  for (const s of subs) {
    try {
      await webpush.sendNotification(JSON.parse(s.sub_json), JSON.stringify({ title, body, data, ts: now() }));
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id=?').run(s.id);
    }
  }
}
app.post('/api/admin/push/test', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'supervisor') return res.status(403).json({ error: 'ไม่มีสิทธิ์' });
  await sendPush('🧪 ทดสอบ Push', 'ระบบ Smart Guard Tour ส่งแจ้งเตือนถึงคุณได้แล้ว');
  res.json({ ok: true, subs: db.prepare('SELECT COUNT(*) c FROM push_subs').get().c });
});

// ---------- admin: สถานะเครื่อง (แบต) ของ รปภ. ที่กำลังปฏิบัติงาน ----------
app.get('/api/admin/guards-status', auth, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'supervisor') return res.status(403).json({ error: 'ไม่มีสิทธิ์' });
  const rows = db.prepare(`
    SELECT sh.id shift_id, sh.guard_id, u.name guard_name, sh.status,
           d.battery, d.charging, d.ts battery_ts
    FROM shifts sh JOIN users u ON u.id=sh.guard_id
    LEFT JOIN device_status d ON d.user_id=sh.guard_id
    WHERE sh.status IN ('checked_in','patrolling') ORDER BY sh.id DESC`).all();
  res.json({ guards: rows });
});

// ---------- admin: จัดการ Webhook ภายนอก (API เปิด) ----------
function isAdminOrSupervisor(req, res) {
  if (req.user.role !== 'admin' && req.user.role !== 'supervisor') { res.status(403).json({ error: 'ไม่มีสิทธิ์' }); return false; }
  return true;
}
app.get('/api/admin/webhooks', auth, (req, res) => {
  if (!isAdminOrSupervisor(req, res)) return;
  const rows = db.prepare(`SELECT w.*, (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id=w.id) deliveries,
    (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id=w.id AND d.ok=1) ok_count FROM webhooks w ORDER BY w.id DESC`).all();
  res.json({ webhooks: rows, events: WH_EVENTS });
});
app.post('/api/admin/webhooks', auth, (req, res) => {
  if (!isAdminOrSupervisor(req, res)) return;
  const { label, url, secret, events, active } = req.body || {};
  if (!label || !url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'ต้องใส่ชื่อและ URL (http/https)' });
  const ev = Array.isArray(events) ? events.join(',') : (events || 'sos,incident,visit,missed_cp,shift,report');
  const info = db.prepare('INSERT INTO webhooks(label,url,secret,events,active,created_at) VALUES(?,?,?,?,?,?)')
    .run(label, url, secret || '', ev, active === false ? 0 : 1, now());
  res.json({ ok: true, id: info.lastInsertRowid });
});
app.put('/api/admin/webhooks/:id', auth, (req, res) => {
  if (!isAdminOrSupervisor(req, res)) return;
  const { label, url, secret, events, active } = req.body || {};
  const cur = db.prepare('SELECT * FROM webhooks WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'ไม่พบ webhook' });
  db.prepare('UPDATE webhooks SET label=?,url=?,secret=?,events=?,active=? WHERE id=?').run(
    label ?? cur.label, url ?? cur.url, secret ?? cur.secret,
    Array.isArray(events) ? events.join(',') : (events ?? cur.events),
    active === undefined ? cur.active : (active ? 1 : 0), req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/webhooks/:id', auth, (req, res) => {
  if (!isAdminOrSupervisor(req, res)) return;
  db.prepare('DELETE FROM webhooks WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.post('/api/admin/webhooks/:id/test', auth, async (req, res) => {
  if (!isAdminOrSupervisor(req, res)) return;
  const h = db.prepare('SELECT * FROM webhooks WHERE id=?').get(req.params.id);
  if (!h) return res.status(404).json({ error: 'ไม่พบ webhook' });
  const ok = await deliverWebhook(h, 'test', { label: h.label, by: req.user.name });
  res.json({ ok, delivered: ok ? 1 : 0 });
});
app.get('/api/admin/webhooks/deliveries', auth, (req, res) => {
  if (!isAdminOrSupervisor(req, res)) return;
  const q = req.query.webhook_id ? 'SELECT * FROM webhook_deliveries WHERE webhook_id=? ORDER BY id DESC LIMIT 100' : 'SELECT * FROM webhook_deliveries ORDER BY id DESC LIMIT 100';
  const rows = req.query.webhook_id
    ? db.prepare(q).all(req.query.webhook_id)
    : db.prepare(q).all();
  res.json({ deliveries: rows });
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
  // webhook ภายนอก (API เปิด) — ข้าม event ที่ถี่เกิน (gps/battery)
  if (msg.type !== 'gps' && msg.type !== 'battery') dispatchWebhooks(msg.type, msg);
}

// ---------- Webhook engine: ส่งออกไประบบภายนอก (VVA/CCTV/อื่นๆ) ----------
const WH_EVENTS = ['sos', 'incident', 'incident_resolved', 'visit', 'missed_cp', 'shift', 'report'];
function whSubscribed(events, ev) {
  return (events || '').split(',').map(x => x.trim()).includes(ev) || (events || '').split(',').map(x => x.trim()).includes('*');
}
async function dispatchWebhooks(event, payload) {
  let hooks = [];
  try { hooks = db.prepare('SELECT * FROM webhooks WHERE active=1').all(); } catch (e) { return; }
  for (const h of hooks) {
    if (!whSubscribed(h.events, event)) continue;
    deliverWebhook(h, event, payload).catch(() => {});
  }
}
async function deliverWebhook(h, event, payload) {
  const ts = now();
  const body = JSON.stringify({ event, ts, data: payload });
  const sig = h.secret ? crypto.createHmac('sha256', h.secret).update(ts + '.' + body).digest('hex') : '';
  let attempts = 0, code = 0, ok = 0, detail = '';
  for (let i = 0; i < 3; i++) {
    attempts++;
    try {
      const r = await fetch(h.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SGT-Event': event,
          'X-SGT-Timestamp': ts,
          ...(sig ? { 'X-SGT-Signature': 'sha256=' + sig } : {}),
        },
        body,
        signal: AbortSignal.timeout(8000),
      });
      code = r.status; ok = r.ok ? 1 : 0;
      detail = ok ? 'ok' : 'http' + r.status;
      if (ok) break;
    } catch (e) { code = 0; detail = e.message.slice(0, 60); }
    if (i < 2) await new Promise(r => setTimeout(r, 1000 * (i + 1) * 2));
  }
  try {
    db.prepare('INSERT INTO webhook_deliveries(webhook_id,event,status_code,ok,attempts,detail,ts) VALUES(?,?,?,?,?,?,?)')
      .run(h.id, event, code, ok, attempts, detail, ts);
  } catch (e) {}
  return ok;
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
      if (s && s.status !== 'checked_out') {
        savePosition(s, m.lat, m.lng, m.accuracy);
        if (m.battery != null) saveBattery(u.userId, s.id, m.battery, m.charging);
      }
    }
  });
  ws.on('close', () => clients.delete(ws));
});
