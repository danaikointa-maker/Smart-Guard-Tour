/* Smart Guard Tour — ฝั่ง รปภ. : UX เรียบง่าย 4 ขั้นตอน */
const $ = (id) => document.getElementById(id);
const toast = (m) => { const t = $('toast'); t.textContent = m; t.style.display = 'block';
  clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 4000); };
const show = (id) => { document.querySelectorAll('.container > div').forEach(d => d.classList.add('hidden'));
  $(id).classList.remove('hidden'); };

const S = { token: localStorage.getItem('sgt_token') || '', me: null, shift: null, post: null,
  checkpoints: [], visits: new Set(), myPos: null, ws: null, map: null, myMarker: null,
  cpMarkers: {}, watchId: null, lastSent: 0, scanTimer: null, camStream: null, shotCp: null, shotData: null, routeOrder: new Map(), lastRoute: 0,
  cfg: { gps_interval_sec: 4 }, pending: new Set(), batt: null,
  queue: JSON.parse(localStorage.getItem('sgt_queue') || '[]'), shotFlags: [], lastPosSent: null };

async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-token': S.token },
    body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'เกิดข้อผิดพลาด'); e.status = r.status; e.data = j; throw e; }
  return j;
}
const apiGet = async (path) => { const r = await fetch(path, { headers: { 'x-token': S.token } });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'ผิดพลาด'); return j; };

// ---------- login ----------
async function doLogin() {
  try {
    const j = await api('/api/login', { name: $('lg-name').value.trim(), pin: $('lg-pin').value.trim() });
    S.token = j.token; S.me = j.user; localStorage.setItem('sgt_token', j.token);
    fetch('/api/settings').then(r => r.json()).then(c => { S.cfg = { ...S.cfg, ...c }; }).catch(() => {});
    toast(`สวัสดี ${j.user.name} 👋`); goScanIn();
  } catch (e) { toast(e.message); }
}

// ---------- QR scanning ----------
async function openCam(videoId, onQr) {
  stopScan();
  try {
    S.camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const v = $(videoId); v.srcObject = S.camStream; await v.play();
    const loop = () => {
      if (!S.camStream) return;
      if (v.readyState === v.HAVE_ENOUGH_DATA) {
        const c = document.createElement('canvas');
        c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0);
        const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
        const code = jsQR(img.data, img.width, img.height);
        if (code && code.data) { stopScan(); onQr(code.data); return; }
      }
      S.scanTimer = requestAnimationFrame(loop);
    };
    loop();
  } catch (e) { toast('เปิดกล้องไม่ได้ — ลองพิมพ์รหัสแทน (' + e.message + ')'); }
}
function stopScan() { if (S.scanTimer) cancelAnimationFrame(S.scanTimer); S.scanTimer = null;
  if (S.camStream) { S.camStream.getTracks().forEach(t => t.stop()); S.camStream = null; } }

function goScanIn() { show('scr-scanin'); $('scanin-status').textContent = 'กำลังมองหา QR…'; openCam('cam-in', (qr) => doCheckin(qr)); }

// ---------- NFC (Web NFC) — แทนการสแกน QR เมื่อสติกเกอร์ QR เสียหาย/แสงไม่ดี ----------
// การ์ด NFC เก็บข้อความเดียวกับ QR: SGT1:P:{postId}:{nonce}:{hmac}
function nfcSupported() { return 'NDEFReader' in window; }
function initNFC() {
  if (!nfcSupported()) return;
  $('btn-nfc-in') && $('btn-nfc-in').classList.remove('hidden');
  $('btn-nfc-out') && $('btn-nfc-out').classList.remove('hidden');
  $('nfc-hint-in') && $('nfc-hint-in').classList.remove('hidden');
}
async function tapNFC(mode) {
  if (!nfcSupported()) return toast('เครื่องนี้ไม่รองรับ Web NFC (ใช้ Chrome บน Android + HTTPS)');
  const statusEl = mode === 'in' ? $('scanin-status') : $('scanout-status');
  try {
    const reader = new NDEFReader();
    await reader.scan();
    statusEl.textContent = '📲 แตะการ์ด NFC ที่ป้อม…';
    toast('📲 แตะการ์ด NFC ที่ป้อมตอนนี้');
    reader.onreading = (ev) => {
      const rec = ev.message.records[0];
      const qr = new TextDecoder().decode(rec.data).trim();
      if (!qr.startsWith('SGT1:')) return toast('การ์ดนี้ไม่ใช่ของระบบ Smart Guard Tour');
      if (mode === 'in') doCheckin(qr); else doCheckout(qr);
    };
    reader.onreadingerror = () => toast('อ่านการ์ดไม่สำเร็จ — ลองแตะอีกครั้ง');
  } catch (e) {
    toast('NFC: ' + (e.name === 'NotAllowedError' ? 'ต้องอนุญาตสิทธิ์ NFC ก่อน (แตะปุ่มแล้วแตะการ์ด)' : e.message));
  }
}
async function manualCheckin() { const v = $('qr-manual-in').value.trim(); if (v) doCheckin(v); }
async function doCheckin(qr) {
  try {
    const j = await api('/api/guard/checkin', { qr });
    S.shift = j.shift; S.post = j.post; S.checkpoints = j.checkpoints;
    toast(`เช็คอินที่ ${j.post.name} สำเร็จ ✅`);
    $('start-post').textContent = j.post.name;
    $('start-info').textContent = `มีจุดตรวจทั้งหมด ${j.checkpoints.length} จุด · กะ #${j.shift.id}` +
      (j.schedule ? ` · เวรของคุณวันนี้ ${j.schedule.start_time}–${j.schedule.end_time} น.` : '');
    if (j.scheduleWarning) setTimeout(() => toast(j.scheduleWarning), 800);
    show('scr-start');
  } catch (e) { toast(e.message); goScanIn(); }
}

// ---------- เริ่มกะ ----------
async function startShift() {
  try {
    await api('/api/guard/start', { shiftId: S.shift.id });
    connectWS(); startGPS(); initBattery(); initMap(); renderCpList(); show('scr-patrol'); flushQueue(); loadRoute();
    toast('เริ่มติดตาม GPS แล้ว 📍');
  } catch (e) { toast(e.message); }
}

// ---------- GPS + Realtime ----------
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  S.ws = new WebSocket(`${proto}://${location.host}/ws?token=${S.token}`);
  S.ws.onopen = () => flushQueue();
  S.ws.onclose = () => setTimeout(connectWS, 3000);
}
function startGPS() {
  if (!navigator.geolocation) { toast('เครื่องนี้ไม่รองรับ GPS'); return; }
  S.watchId = navigator.geolocation.watchPosition((p) => {
    S.myPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
    $('mypos').textContent = `${S.myPos.lat.toFixed(5)}, ${S.myPos.lng.toFixed(5)}`;
    $('myacc').textContent = `±${Math.round(S.myPos.acc)} ม.`;
    updateMap(); renderCpList();
    const t = Date.now();
    if (t - S.lastSent > (Number(S.cfg.gps_interval_sec) || 4) * 1000) {
      const minMove = Number(S.cfg.gps_min_move_m) || 0;
      const moved = !S.lastPosSent || hav(S.lastPosSent.lat, S.lastPosSent.lng, S.myPos.lat, S.myPos.lng) > minMove;
      if (moved) { S.lastSent = t; S.lastPosSent = { ...S.myPos }; sendPos(); }
    }
    if (t - S.lastRoute > 15000) { S.lastRoute = t; loadRoute(); }
  }, (e) => toast('GPS: ' + e.message), { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
}
function sendPos() {
  if (!S.myPos || !S.shift) return;
  const batt = S.batt ? { battery: S.batt.level, charging: S.batt.charging } : {};
  const msg = { type: 'pos', shiftId: S.shift.id, lat: S.myPos.lat, lng: S.myPos.lng, accuracy: S.myPos.acc, ...batt };
  if (S.ws && S.ws.readyState === 1) { S.ws.send(JSON.stringify(msg)); return; }
  api('/api/guard/position', { shiftId: S.shift.id, ...S.myPos, ...batt })
    .catch(() => enqueue({ kind: 'pos', lat: S.myPos.lat, lng: S.myPos.lng, accuracy: S.myPos.acc, ts: new Date().toISOString() }));
}
// ---------- แบตเครื่อง: รายงานสถานะให้แดชบอร์ดหัวหน้า ----------
function initBattery() {
  if (!navigator.getBattery) return;
  navigator.getBattery().then((b) => {
    S.batt = { level: b.level, charging: b.charging };
    b.addEventListener('levelchange', () => { S.batt.level = b.level; });
    b.addEventListener('chargingchange', () => { S.batt.charging = b.charging; });
  }).catch(() => {});
}

// ---------- โหมดออฟライン: คิวในเครื่อง + ซิงก์อัตโนมัติ ----------
function enqueue(item) {
  S.queue.push(item);
  if (S.queue.length > 50) S.queue = S.queue.slice(-50);
  localStorage.setItem('sgt_queue', JSON.stringify(S.queue));
  $('mypos').textContent += ' 📴(คิว ' + S.queue.length + ')';
}
async function flushQueue() {
  if (!S.queue.length || !S.shift) return;
  const items = S.queue; S.queue = []; localStorage.setItem('sgt_queue', '[]');
  try {
    const j = await api('/api/guard/sync', {
      positions: items.filter(i => i.kind === 'pos'),
      visits: items.filter(i => i.kind === 'visit'),
      sos: items.filter(i => i.kind === 'sos'),
      incidents: items.filter(i => i.kind === 'incident'),
    });
    toast(`📶 ซิงก์ข้อมูลออฟラインแล้ว: GPS ${j.positions} จุด, เช็คจุด ${j.visits_ok} สำเร็จ, SOS ${j.sos || 0}, เหตุการณ์ ${j.incidents || 0}`);
    if (j.visits_ok) location.reload();
  } catch (e) { S.queue = items.concat(S.queue); localStorage.setItem('sgt_queue', JSON.stringify(S.queue)); }
}
window.addEventListener('online', flushQueue);

// ---------- เส้นทางตรวจแบบไดนามิก ----------
async function loadRoute() {
  if (!S.shift) return;
  try {
    const j = await apiGet('/api/guard/route');
    S.routeOrder = new Map(j.route.map(r => [r.id, r.order]));
    renderCpList();
  } catch (e) {}
}

// ---------- แผนที่ ----------
function initMap() {
  if (S.map) return;
  S.map = L.map('gmap').setView([S.post.lat, S.post.lng], 17);
  SGT.addTileLayer(S.map);
  L.marker([S.post.lat, S.post.lng]).addTo(S.map).bindPopup(`🚔 ${S.post.name}`);
  for (const cp of S.checkpoints) {
    const m = L.circleMarker([cp.lat, cp.lng], { radius: 9, color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.9 })
      .addTo(S.map).bindPopup(`${cp.code} ${cp.name}`);
    L.circle([cp.lat, cp.lng], { radius: cp.radius, color: '#38bdf8', weight: 1, fillOpacity: 0.05 }).addTo(S.map);
    S.cpMarkers[cp.id] = m;
  }
}
function updateMap() {
  if (!S.map || !S.myPos) return;
  if (S.myMarker) S.myMarker.setLatLng([S.myPos.lat, S.myPos.lng]);
  else S.myMarker = L.circleMarker([S.myPos.lat, S.myPos.lng], { radius: 8, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 1 }).addTo(S.map);
}
const distTo = (cp) => S.myPos ? Math.round(hav(S.myPos.lat, S.myPos.lng, cp.lat, cp.lng)) : null;
function hav(a, b, c, d) { const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(c - a), dLng = r(d - b);
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLng / 2) ** 2)); }

// ---------- ประหยัดดาต้าซิม: resize รูปก่อนส่ง ----------
function resizePhoto(dataUrl, maxPx) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      if (scale >= 1) return resolve(dataUrl);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function renderCpList() {
  const el = $('cp-list'); el.innerHTML = '';
  let done = 0;
  const ordered = [...S.checkpoints].sort((a, b) => {
    const oa = S.routeOrder.get(a.id), ob = S.routeOrder.get(b.id);
    if (oa != null || ob != null) return (oa ?? 999) - (ob ?? 999);
    return a.seq - b.seq;
  });
  for (const cp of ordered) {
    const ord = S.routeOrder.get(cp.id);
    const d = distTo(cp); const isDone = S.visits.has(cp.id); const isPending = S.pending.has(cp.id);
    if (isDone) done++;
    const near = d !== null && d <= cp.radius;
    const div = document.createElement('div');
    div.className = 'cp-item' + (isDone ? ' done' : near ? ' near' : ' far');
    div.innerHTML = `<div style="flex:2;"><b>${cp.code}</b> ${cp.name}${ord ? ` <span class="tag tag-info">🧭 #${ord}</span>` : ''}<br>
      <span class="muted">รัศมี ${cp.radius} ม. · ${isPending ? '<span class="tag tag-warn">⏳ รอคนที่ 2</span>' : isDone ? '<span class="tag tag-ok">✓ เช็คแล้ว</span>' : ''}</span></div>
      <div class="dist">${d === null ? '…' : d + ' ม.'}</div>
      ${isDone ? '' : `<button class="btn-sm btn-${near ? 'ok' : 'ghost'}" ${near ? '' : 'disabled'}
        onclick="openCamFor(${cp.id})">📷 ${near ? 'ถ่ายรูป' : 'เข้าใกล้ก่อน'}</button>`}`;
    el.appendChild(div);
  }
  $('prog').textContent = `${done}/${S.checkpoints.length}`;
}

// ---------- ถ่ายรูปเช็คจุด ----------
async function openCamFor(cpId) {
  if (!S.myPos) { toast('รอ GPS สักครู่…'); return; }
  const cp = S.checkpoints.find(c => c.id === cpId);
  const d = distTo(cp);
  if (d > cp.radius) { toast(`ยังห่าง ${d} ม. (ต้องไม่เกิน ${cp.radius} ม.) — เดินเข้าใกล้แล้วลองใหม่`); return; }
  S.shotCp = cp;
  $('cam-cp').textContent = `${cp.code} ${cp.name}`;
  $('cam-dist').textContent = `ตอนนี้ห่าง ${d} ม. · รัศมี ${cp.radius} ม.`;
  $('img-shot').classList.add('hidden'); $('cam-shot').classList.remove('hidden');
  $('btn-shoot').classList.remove('hidden'); $('btn-send').classList.add('hidden');
  $('modal-cam').classList.remove('hidden');
  try {
    const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const v = $('cam-shot'); v.srcObject = st; S.shotStream = st; await v.play();
  } catch (e) { toast('เปิดกล้องไม่ได้: ' + e.message); }
}
async function shoot() {
  const v = $('cam-shot'), c = $('canvas-shot');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  S.shotData = c.toDataURL('image/jpeg', 0.8);
  S.shotData = await resizePhoto(S.shotData, Number(S.cfg.photo_max_px) || 800);
  $('img-shot').src = S.shotData; $('img-shot').classList.remove('hidden');
  $('cam-shot').classList.add('hidden');
  $('btn-shoot').classList.add('hidden'); $('btn-send').classList.remove('hidden');
  // 🤖 AI ตรวจรูปอัตโนมัติ (วิเคราะห์ในเครื่อง): ความสว่าง + ความคมชัด
  S.shotFlags = analyzePhoto(c);
  const el = $('shot-flags');
  if (S.shotFlags.length) {
    el.textContent = '🤖 ตรวจพบ: ' + S.shotFlags.map(f => ({ dark: '🌑 รูปมืดเกิน', blurry: '🌫️ รูปเบลอ', lowres: '🔍 ความละเอียดต่ำ' }[f])).join(' · ') + ' — ถ่ายใหม่ถ้าทำได้';
    el.classList.remove('hidden');
  } else { el.classList.add('hidden'); el.textContent = '🤖 ✅ รูปชัด สว่าง พร้อมใช้'; el.style.color = '#15803d'; setTimeout(() => { el.classList.add('hidden'); el.style.color = '#b45309'; }, 2500); }
}
// วิเคราะห์รูปบน canvas: mean luminance + variance ของ Laplacian (ความเบลอ)
function analyzePhoto(srcCanvas) {
  const flags = [];
  try {
    const w = Math.min(160, srcCanvas.width), h = Math.min(120, srcCanvas.height);
    if (srcCanvas.width < 320) flags.push('lowres');
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(srcCanvas, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h).data;
    const gray = [];
    let lumSum = 0;
    for (let i = 0; i < img.length; i += 4) {
      const g = 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
      gray.push(g); lumSum += g;
    }
    const mean = lumSum / gray.length;
    if (mean < 45) flags.push('dark');
    // Laplacian variance
    let lapSum = 0, lapSq = 0, n = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      lapSum += lap; lapSq += lap * lap; n++;
    }
    const lapVar = n ? lapSq / n - (lapSum / n) ** 2 : 0;
    if (lapVar < 120) flags.push('blurry');
  } catch (e) {}
  return flags;
}
function closeCam() {
  $('modal-cam').classList.add('hidden');
  if (S.shotStream) { S.shotStream.getTracks().forEach(t => t.stop()); S.shotStream = null; }
}
async function sendVisit() {
  if (!S.shotData || !S.shotCp || !S.myPos) return;
  try {
    const j = await api('/api/guard/visit', { shiftId: S.shift.id, checkpointId: S.shotCp.id,
      lat: S.myPos.lat, lng: S.myPos.lng, accuracy: S.myPos.acc, photo: S.shotData, flags: S.shotFlags });
    S.visits.add(S.shotCp.id);
    (S.confirmedSet = S.confirmedSet || new Set());
    if (j.confirmed) S.confirmedSet.add(S.shotCp.id); else S.confirmedSet.delete(S.shotCp.id);
    closeCam(); renderCpList();
    if (j.pending) toast(`⏳ เช็ค ${S.shotCp.code} แล้ว — รอ รปภ. คนที่ 2 มายืนยัน (จุดนี้ต้อง 2 คน)`);
    else if (j.paired) toast(`✅ เช็ค ${S.shotCp.code} สำเร็จ — จับคู่ยืนยัน 2 คนแล้ว! (ห่าง ${j.dist} ม.)`);
    else toast(`✅ เช็ค ${S.shotCp.code} สำเร็จ (ห่าง ${j.dist} ม.)`);
    const m = S.cpMarkers[S.shotCp.id]; if (m) { m.setStyle({ color: '#22c55e', fillColor: '#22c55e' }); }
  } catch (e) {
    closeCam();
    if (e.status === 409) toast('⚠️ ' + e.message + ' — เดินเข้าใกล้จุดแล้วถ่ายใหม่');
    else if (!navigator.onLine || e.message === 'Failed to fetch') {
      enqueue({ kind: 'visit', checkpointId: S.shotCp.id, lat: S.myPos.lat, lng: S.myPos.lng,
        accuracy: S.myPos.acc, photo: S.shotData, flags: S.shotFlags, ts: new Date().toISOString() });
      toast('📴 ออฟไลน์ — เก็บรูปไว้ในเครื่องแล้ว จะส่งอัตโนมัติเมื่อเน็ตกลับมา');
    } else toast(e.message);
    renderCpList();
  }
}

// ---------- SOS ----------
async function sos() {
  if (!confirm('🚨 ส่งสัญญาณฉุกเฉิน SOS ไปยังหัวหน้าและกลุ่มแจ้งเตือน now?')) return;
  try {
    const j = await api('/api/guard/sos', { shiftId: S.shift.id, lat: S.myPos?.lat, lng: S.myPos?.lng });
    toast('🚨 ส่ง SOS แล้ว! ' + (j.sent_to.length ? 'ส่งถึง: ' + j.sent_to.join(', ') : 'แจ้งในแผนที่สดของหัวหน้าแล้ว'));
  } catch (e) {
    if (!navigator.onLine || e.message === 'Failed to fetch') {
      enqueue({ kind: 'sos', shiftId: S.shift?.id, lat: S.myPos?.lat, lng: S.myPos?.lng, ts: new Date().toISOString() });
      toast('📴 ออฟไลน์ — เก็บ SOS ไว้ในเครื่อง จะส่งอัตโนมัติเมื่อกลับออนไลน์');
    } else toast(e.message);
  }
}

// ---------- เช็คเอาต์ ----------
function goScanOut() { show('scr-scanout'); $('scanout-status').textContent = 'กำลังมองหา QR…'; openCam('cam-out', (qr) => doCheckout(qr)); }
async function manualCheckout() { const v = $('qr-manual-out').value.trim(); if (v) doCheckout(v); }
async function doCheckout(qr) {
  try {
    const j = await api('/api/guard/checkout', { shiftId: S.shift.id, qr });
    if (S.watchId) navigator.geolocation.clearWatch(S.watchId);
    stopScan();
    $('done-info').innerHTML = `รายงาน #${j.reportId} ถูกส่งเข้าสู่ส่วนกลางแล้ว 📨<br>
      เช็คจุดตรวจสำเร็จ <b>${j.visited}/${j.total}</b> จุด` +
      (j.sent_to && j.sent_to.length ? `<br>ส่งถึง: ${j.sent_to.join(', ')}` : '<br>(ยังไม่ได้ตั้งค่ากลุ่มแจ้งเตือน — รายงานอยู่ในกล่องของ Admin)');
    show('scr-done');
  } catch (e) { toast(e.message); goScanOut(); }
}

$('lg-name').focus();
initNFC();

// ---------- แจ้งเหตุการณ์ ----------
let incPhoto = null;
function openIncident() { incPhoto = null; $('img-inc').classList.add('hidden'); $('inc-desc').value = '';
  $('modal-incident').classList.remove('hidden'); }
function closeIncident() { $('modal-incident').classList.add('hidden'); stopIncCam(); }
function stopIncCam() { const v = $('cam-inc'); if (v.srcObject) { v.srcObject.getTracks().forEach(t => t.stop()); v.srcObject = null; } }
async function incShoot() {
  try {
    const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const v = $('cam-inc'); v.srcObject = st; v.classList.remove('hidden'); await v.play();
    setTimeout(async () => {
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      incPhoto = await resizePhoto(c.toDataURL('image/jpeg', 0.8), Number(S.cfg.photo_max_px) || 800);
      $('img-inc').src = incPhoto; $('img-inc').classList.remove('hidden'); v.classList.add('hidden'); stopIncCam();
    }, 600);
  } catch (e) { toast('เปิดกล้องไม่ได้: ' + e.message); }
}
async function submitIncident() {
  try {
    const j = await api('/api/guard/incident', { shiftId: S.shift?.id, type: $('inc-type').value,
      description: $('inc-desc').value.trim(), lat: S.myPos?.lat, lng: S.myPos?.lng, accuracy: S.myPos?.acc, photo: incPhoto });
    closeIncident();
    toast('📢 ส่งแจ้งเหตุการณ์ #' + j.id + ' แล้ว ' + (j.sent_to.length ? '→ ' + j.sent_to.join(', ') : '(เข้ากล่อง Admin)'));
  } catch (e) {
    if (!navigator.onLine || e.message === 'Failed to fetch') {
      enqueue({ kind: 'incident', type: $('inc-type').value, description: $('inc-desc').value.trim(),
        lat: S.myPos?.lat, lng: S.myPos?.lng, accuracy: S.myPos?.acc, photo: incPhoto, ts: new Date().toISOString() });
      closeIncident();
      toast('📴 ออฟไลน์ — เก็บเหตุการณ์ไว้ในเครื่อง จะส่งอัตโนมัติเมื่อกลับออนไลน์');
    } else toast(e.message);
  }
}
