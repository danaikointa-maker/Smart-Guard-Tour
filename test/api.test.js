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
