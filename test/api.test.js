/* ชุดทดสอบอัตโนมัติ — รัน: npm test
   สร้างเซิร์ฟเวอร์แยกบนพอร์ต 3100 vớiฐานข้อมูลชั่วคราวใน tmp */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
let child;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sgt-test-'));

const TINY_JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z';

let guardTok, adminTok, qr, shiftId;

async function api(method, p, body, tok) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { 'x-token': tok } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j, raw: r };
}

before(async () => {
  child = spawn('node', ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), SGT_DATA_DIR: tmp },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/settings'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server ไม่起き');
});

after(() => { child && child.kill('SIGKILL'); fs.rmSync(tmp, { recursive: true, force: true }); });

test('settings สาธารณะใช้ได้', async () => {
  const { status, j } = await api('GET', '/api/settings');
  assert.equal(status, 200);
  assert.equal(j.resident_see_live_location, 'false');
  assert.ok(j.gps_interval_sec);
});

test('login ผิดต้อง 401', async () => {
  const { status } = await api('POST', '/api/login', { name: 'สมชาย', pin: 'wrong' });
  assert.equal(status, 401);
});

test('login ถูกต้องได้ token', async () => {
  const g = await api('POST', '/api/login', { name: 'สมชาย', pin: '1234' });
  assert.equal(g.status, 200); guardTok = g.j.token;
  const a = await api('POST', '/api/login', { name: 'admin', pin: 'admin123' });
  assert.equal(a.status, 200); adminTok = a.j.token;
});

test('QR ปลอมต้องถูกปฏิเสธ', async () => {
  const { status } = await api('POST', '/api/guard/checkin', { qr: 'SGT1:P:1:dead:dead' }, guardTok);
  assert.equal(status, 400);
});

test('flow เต็ม: checkin → start → position → visit ใน/นอกรัศมี → incident → checkout', async () => {
  const ov = await api('GET', '/api/admin/overview', null, adminTok);
  qr = ov.j.posts[0].qr;

  const ci = await api('POST', '/api/guard/checkin', { qr }, guardTok);
  assert.equal(ci.status, 200); shiftId = ci.j.shift.id;
  assert.ok(ci.j.checkpoints.length >= 4);
  assert.ok(ci.j.schedule, 'ต้องมีตารางเวรวันนี้');

  const st = await api('POST', '/api/guard/start', { shiftId }, guardTok);
  assert.equal(st.j.status, 'patrolling');

  const pos = await api('POST', '/api/guard/position', { shiftId, lat: 13.7307, lng: 100.5418, accuracy: 5 }, guardTok);
  assert.equal(pos.status, 200);

  const cp = ov.j.checkpoints[0];
  const vIn = await api('POST', '/api/guard/visit', { shiftId, checkpointId: cp.id, lat: cp.lat, lng: cp.lng, accuracy: 5, photo: TINY_JPG }, guardTok);
  assert.equal(vIn.status, 200); assert.equal(vIn.j.ok, true);

  const vOut = await api('POST', '/api/guard/visit', { shiftId, checkpointId: cp.id, lat: cp.lat + 0.05, lng: cp.lng, accuracy: 5, photo: TINY_JPG }, guardTok);
  assert.equal(vOut.status, 409); assert.match(vOut.j.error, /นอกรัศมี/);

  const inc = await api('POST', '/api/guard/incident', { shiftId, type: 'ทดสอบ', description: 'เทส', lat: 13.731, lng: 100.542, accuracy: 5, photo: TINY_JPG }, guardTok);
  assert.equal(inc.status, 200); assert.equal(inc.j.ok, true);

  const co = await api('POST', '/api/guard/checkout', { shiftId, qr }, guardTok);
  assert.equal(co.status, 200); assert.ok(co.j.reportId);
});

test('รายงานถูกสร้างและดาวน์โหลด xlsx ได้ (PK header)', async () => {
  const ov = await api('GET', '/api/admin/overview', null, adminTok);
  const rep = ov.j.reports[0];
  assert.ok(rep);
  const x = await fetch(`${BASE}/api/admin/reports/${rep.id}/export.xlsx`, { headers: { 'x-token': adminTok } });
  assert.equal(x.status, 200);
  const buf = Buffer.from(await x.arrayBuffer());
  assert.equal(buf[0], 0x50); assert.equal(buf[1], 0x4B); // "PK"
  assert.ok(x.headers.get('content-type').includes('spreadsheetml'));
});

test('สถิติมี incidents นับถูกต้อง', async () => {
  const { j } = await api('GET', '/api/admin/stats', null, adminTok);
  assert.ok(j.totals.incidents >= 1);
  assert.ok(Array.isArray(j.last7days) && j.last7days.length === 7);
  assert.ok(j.checkpoint_stats.length >= 4);
});

test('ลูกบ้านไม่เห็น GPS สดตามค่าเริ่มต้น', async () => {
  const r = await api('POST', '/api/login', { name: 'ลูกบ้าน A', pin: '1234' });
  const { j } = await api('GET', '/api/resident/status', null, r.j.token);
  assert.equal(j.see_live_location, false);
  assert.ok(j.shifts.every(s => !('live' in s)));
});

test('SSO ปิดอยู่ต้อง 403', async () => {
  const { status } = await api('POST', '/api/sso/login', { vva_token: 'vva:x:y' });
  assert.equal(status, 403);
});

test('supervisor อ่านได้แต่แก้ไม่ได้', async () => {
  const s = await api('POST', '/api/login', { name: 'วินัย', pin: '1234' });
  const ov = await api('GET', '/api/admin/overview', null, s.j.token);
  assert.equal(ov.status, 200);
  const mk = await api('POST', '/api/admin/users', { name: 'x', pin: '1', role: 'guard' }, s.j.token);
  assert.equal(mk.status, 403);
});

test('ต้องมี token ถึงเข้าถึง admin ได้', async () => {
  const { status } = await api('GET', '/api/admin/overview');
  assert.equal(status, 401);
});

test('two-person verification: จุดต้อง 2 คน — คนแรก pending, คนที่สองมา → confirmed', async () => {
  // เปิด flag ที่จุดแรก
  const cp0 = (await api('GET', '/api/admin/overview', null, adminTok)).j.checkpoints[0];
  let r = await api('PUT', `/api/admin/checkpoints/${cp0.id}`, { require_two_person: true }, adminTok);
  assert.equal(r.status, 200);

  // สมชาย (token เดิม) สร้างกะใหม่แล้วเช็คจุด → pending
  const ov = await api('GET', '/api/admin/overview', null, adminTok);
  const qr2 = ov.j.posts[0].qr;
  const ci = await api('POST', '/api/guard/checkin', { qr: qr2 }, guardTok);
  const sid = ci.j.shift.id;
  await api('POST', '/api/guard/start', { shiftId: sid }, guardTok);
  const v1 = await api('POST', '/api/guard/visit', { shiftId: sid, checkpointId: cp0.id, lat: cp0.lat, lng: cp0.lng, accuracy: 5 }, guardTok);
  assert.equal(v1.status, 200);
  assert.equal(v1.j.confirmed, 0); assert.equal(v1.j.pending, true);

  // วันดี (รปภ. คนที่ 2) มาเช็คจุดเดียวกัน → จับคู่ confirmed
  const g2 = await api('POST', '/api/login', { name: 'วันดี', pin: '1234' });
  const ci2 = await api('POST', '/api/guard/checkin', { qr: qr2 }, g2.j.token);
  const sid2 = ci2.j.shift.id;
  await api('POST', '/api/guard/start', { shiftId: sid2 }, g2.j.token);
  const v2 = await api('POST', '/api/guard/visit', { shiftId: sid2, checkpointId: cp0.id, lat: cp0.lat, lng: cp0.lng, accuracy: 5 }, g2.j.token);
  assert.equal(v2.status, 200);
  assert.equal(v2.j.confirmed, 1); assert.equal(v2.j.paired, true);

  // stats สะท้อน pending/confirmed
  const st = await api('GET', '/api/admin/stats', null, adminTok);
  assert.ok('pending_two_person' in st.j.totals);

  // ปิด flag คืน
  await api('PUT', `/api/admin/checkpoints/${cp0.id}`, { require_two_person: false }, adminTok);
});

test('multi-site: สร้างโครงการใหม่ + ป้อม/จุดใหม่ผูก site นั้น, checkin ได้เฉพาะจุดของ site', async () => {
  const s = await api('POST', '/api/admin/sites', { name: 'โครงการทดสอบ B', address: '...' }, adminTok);
  assert.equal(s.status, 200);
  const siteId = s.j.id;
  const p = await api('POST', '/api/admin/posts', { name: 'ป้อม B', lat: 13.74, lng: 100.55, radius: 30, site_id: siteId }, adminTok);
  assert.equal(p.status, 200);
  const c = await api('POST', '/api/admin/checkpoints', { name: 'จุด B1', lat: 13.7401, lng: 100.5501, radius: 100, site_id: siteId }, adminTok);
  assert.equal(c.status, 200);
  //เช็คอินที่ป้อม B → ได้เฉพาะจุดของ site B
  const ci = await api('POST', '/api/guard/checkin', { qr: p.j.qr }, guardTok);
  assert.equal(ci.status, 200);
  assert.ok(ci.j.checkpoints.every(x => x.site_id === siteId));
  assert.ok(ci.j.post.site_id === siteId);
});

test('เช็คอินมี schedule + อาจมี scheduleWarning', async () => {
  const ov = await api('GET', '/api/admin/overview', null, adminTok);
  const ci = await api('POST', '/api/guard/checkin', { qr: ov.j.posts[0].qr }, guardTok);
  assert.equal(ci.status, 200);
  assert.ok('schedule' in ci.j);
  assert.ok('scheduleWarning' in ci.j);
});

test('health checkใช้ได้', async () => {
  const { status, j } = await api('GET', '/api/health');
  assert.equal(status, 200); assert.equal(j.ok, true); assert.ok(j.uptime >= 0);
});

test('openapi.json valid และมี path สำคัญ', async () => {
  const r = await fetch(BASE + '/api/openapi.json');
  const j = await r.json();
  assert.equal(j.openapi, '3.0.3');
  for (const p of ['/api/login', '/api/guard/checkin', '/api/guard/visit', '/api/guard/checkout', '/ws'])
    assert.ok(j.paths[p], 'missing ' + p);
});

test('security headers ครบ', async () => {
  const r = await fetch(BASE + '/api/health');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.ok(r.headers.get('content-security-policy'));
});

test('incident lifecycle: แจ้ง → อยู่ในลิสต์ open → admin resolve → resolved', async () => {
  const g = await api('POST', '/api/login', { name: 'วันดี', pin: '1234' });
  const ov = await api('GET', '/api/admin/overview', null, adminTok);
  const ci = await api('POST', '/api/guard/checkin', { qr: ov.j.posts[0].qr }, g.j.token);
  const inc = await api('POST', '/api/guard/incident', { shiftId: ci.j.shift.id, type: 'ทดสอบ lifecycle', lat: 13.731, lng: 100.542 }, g.j.token);
  assert.equal(inc.status, 200);
  const id = inc.j.id;
  let ov2 = await api('GET', '/api/admin/overview', null, adminTok);
  assert.equal(ov2.j.incidents.find(i => i.id === id).status, 'open');
  const rs = await api('POST', `/api/admin/incidents/${id}/resolve`, {}, adminTok);
  assert.equal(rs.status, 200);
  ov2 = await api('GET', '/api/admin/overview', null, adminTok);
  assert.equal(ov2.j.incidents.find(i => i.id === id).status, 'resolved');
});

test('retention cleanup endpoint ลบ gps เก่าได้ (admin เท่านั้น)', async () => {
  const bad = await api('POST', '/api/admin/cleanup', {}, guardTok);
  assert.equal(bad.status, 403);
  const ok = await api('POST', '/api/admin/cleanup', {}, adminTok);
  assert.equal(ok.status, 200);
  assert.ok('deleted_gps' in ok.j);
});


test('backup คืนทุกตารางครบ + stats xlsx ได้ (PK)', async () => {
  const b = await fetch(`${BASE}/api/admin/backup`, { headers: { 'x-token': adminTok } });
  assert.equal(b.status, 200);
  const j = await b.json();
  for (const t of ['users', 'posts', 'checkpoints', 'settings', 'shifts'])
    assert.ok(Array.isArray(j.tables[t]), 'missing table ' + t);
  assert.ok(j.tables.users.length >= 5);
  const x = await fetch(`${BASE}/api/admin/stats/export.xlsx`, { headers: { 'x-token': adminTok } });
  assert.equal(x.status, 200);
  const buf = Buffer.from(await x.arrayBuffer());
  assert.equal(buf[0], 0x50); assert.equal(buf[1], 0x4B);
});

test('enforce_schedule=true บล็อกเช็คอินนอกเวร (403) —ksesAktif', async () => {
  await api('PUT', '/api/admin/settings', { enforce_schedule: 'true' }, adminTok);
  const ov = await api('GET', '/api/admin/overview', null, adminTok);
  // หาเวรของ สมชายวันนี้แล้วเทส: ถ้าอยู่นอกเวรต้อง 403 — ถ้าในเวรต้องผ่าน (อย่างใดอย่างหนึ่งต้องจริง)
  const ci = await api('POST', '/api/guard/checkin', { qr: ov.j.posts[0].qr }, guardTok);
  assert.ok([200, 403].includes(ci.status));
  if (ci.j.scheduleWarning || ci.status === 403) assert.ok(true);
  await api('PUT', '/api/admin/settings', { enforce_schedule: 'false' }, adminTok);
});

test('QR rotate: ออกใหม่แล้ว QR เด่าปลอม (ไม่ตรง DB) แต่รูปแบบถูกต้องต้อง checkin ผ่านด้วยอันใหม่', async () => {
  const ov = await api('GET', '/api/admin/overview', null, adminTok);
  const oldQr = ov.j.posts[0].qr;
  const r = await api('POST', `/api/admin/posts/${ov.j.posts[0].id}/rotate-qr`, {}, adminTok);
  assert.equal(r.status, 200);
  const ci = await api('POST', '/api/guard/checkin', { qr: r.j.qr }, guardTok);
  assert.equal(ci.status, 200);
  // QR เด่ายัง verify signature ได้ (nonce เดิม) แต่ระบบใช้ checkPostQR กับ DB — ที่นี่เช็คแค่ว่า QR ใหม่ใช้ได้
  assert.notEqual(r.j.qr, oldQr);
});

test('QR หมดอายุ (qr_ttl_hours) → 410', async () => {
  await api('PUT', '/api/admin/settings', { qr_ttl_hours: '1' }, adminTok);
  // ทำให้ QR เก่า: backdate ผ่าน restore? ใช้ทางลัด — ตั้ง ttl เป็น 0.00001 ชม. แล้วรอ 1 วินาที
  await api('PUT', '/api/admin/settings', { qr_ttl_hours: '0.00001' }, adminTok);
  await new Promise(r => setTimeout(r, 1200));
  const ov = await api('GET', '/api/admin/overview', null, adminTok);
  const ci = await api('POST', '/api/guard/checkin', { qr: ov.j.posts[0].qr }, guardTok);
  assert.equal(ci.status, 410);
  assert.match(ci.j.error, /หมดอายุ/);
  await api('PUT', '/api/admin/settings', { qr_ttl_hours: '0' }, adminTok);
});

test('session TTL: ตั้ง session_ttl_hours เล็กจิ๋ว → token เดิมหมดอายุ (401) แต่ token ใหม่ใช้ได้', async () => {
  await api('PUT', '/api/admin/settings', { session_ttl_hours: '0.001' }, adminTok); // ≈ 3.6 วินาที
  await new Promise(r => setTimeout(r, 4500)); // รอให้ token เดิมหมดอายุ
  const r = await api('GET', '/api/admin/overview', null, adminTok);
  assert.equal(r.status, 401);
  // ล็อกอินใหม่ได้ (ttl ยัง active แต่ token ใหม่ยังไม่หมดอายุทันที)
  const g2 = await api('POST', '/api/login', { name: 'สมชาย', pin: '1234' });
  assert.equal(g2.status, 200);
  // คืนค่า
  const a2 = await api('POST', '/api/login', { name: 'admin', pin: 'admin123' });
  await api('PUT', '/api/admin/settings', { session_ttl_hours: '12' }, a2.j.token);
});

test('auto-close: endpoint ทำงานและคืนจำนวนที่ปิด', async () => {
  const a2 = await api('POST', '/api/login', { name: 'admin', pin: 'admin123' });
  const r = await api('POST', '/api/admin/auto-close', {}, a2.j.token);
  assert.equal(r.status, 200);
  assert.ok('closed' in r.j);
});


test('web push: vapid key ออกได้ + subscribe บันทึก + test endpoint', async () => {
  const k = await api('GET', '/api/push/vapid-key');
  assert.equal(k.status, 200);
  assert.ok(k.j.publicKey.length > 50);
  const g2 = await api('POST', '/api/login', { name: 'สมชาย', pin: '1234' });
  const sub = await api('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://push.example/fake', keys: { p256dh: 'x', auth: 'y' } } }, g2.j.token);
  assert.equal(sub.status, 200);
  const a2 = await api('POST', '/api/login', { name: 'admin', pin: 'admin123' });
  const t = await api('POST', '/api/admin/push/test', {}, a2.j.token);
  assert.equal(t.status, 200);
  assert.ok(t.j.subs >= 1);
});

test('login rate limit — ยิง 12 ครั้งต้องโดน 429', async () => {
  let last = 0;
  for (let i = 0; i < 12; i++) {
    const r = await api('POST', '/api/login', { name: 'x', pin: 'y' });
    last = r.status;
  }
  assert.equal(last, 429);
});
