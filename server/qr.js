const crypto = require('crypto');
const QRCode = require('qrcode');

// secret สำหรับลงลายเซ็น QR — ในโปรดักชันเก็บใน env
const SECRET = process.env.SGT_SECRET || 'sgt-dev-secret-change-me';

function sign(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex').slice(0, 24);
}

// payload: SGT1:P:{postId}:{nonce}:{sig}
function makePostQR(postId, postName) {
  const nonce = crypto.randomBytes(6).toString('hex');
  const body = `SGT1:P:${postId}:${nonce}`;
  const payload = `${body}:${sign(body)}`;
  return { payload, png: null, postName };
}

async function makePostQRWithPng(postId, postName) {
  const q = makePostQR(postId, postName);
  q.png = await QRCode.toDataURL(q.payload, { width: 320, margin: 1 });
  return q;
}

// เวอร์ชัน sync (ใช้ตอน seed) — เก็บเป็น SVG data URL แสดงใน <img> ได้เหมือนกัน
function makePostQRSync(postId) {
  const nonce = crypto.randomBytes(6).toString('hex');
  const body = `SGT1:P:${postId}:${nonce}`;
  const payload = `${body}:${sign(body)}`;
  const svg = QRCode.toString(payload, { type: 'svg', margin: 1, width: 320 });
  return { payload, png: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg) };
}

// ตรวจสอบและคืน post id — คืน null ถ้า QR ปลอม/หมดอายุ
function verifyPostQR(payload) {
  const m = /^SGT1:P:(\d+):([a-f0-9]+):([a-f0-9]+)$/.exec(String(payload || '').trim());
  if (!m) return null;
  const body = `SGT1:P:${m[1]}:${m[2]}`;
  if (sign(body) !== m[3]) return null;
  return parseInt(m[1], 10);
}

module.exports = { makePostQRWithPng, makePostQRSync, verifyPostQR };
