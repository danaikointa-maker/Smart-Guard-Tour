/* Smart Guard Tour — ฝั่ง รปภ. : UX เรียบง่าย 4 ขั้นตอน */
const $ = (id) => document.getElementById(id);
const toast = (m) => { const t = $('toast'); t.textContent = m; t.style.display = 'block';
  clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 4000); };
const show = (id) => { document.querySelectorAll('.container > div').forEach(d => d.classList.add('hidden'));
  $(id).classList.remove('hidden'); };

const S = { token: localStorage.getItem('sgt_token') || '', me: null, shift: null, post: null,
  checkpoints: [], visits: new Set(), myPos: null, ws: null, map: null, myMarker: null,
  cpMarkers: {}, watchId: null, lastSent: 0, scanTimer: null, camStream: null, shotCp: null, shotData: null,
  cfg: { gps_interval_sec: 4 } };

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
async function manualCheckin() { const v = $('qr-manual-in').value.trim(); if (v) doCheckin(v); }
async function doCheckin(qr) {
  try {
    const j = await api('/api/guard/checkin', { qr });
    S.shift = j.shift; S.post = j.post; S.checkpoints = j.checkpoints;
    toast(`เช็คอินที่ ${j.post.name} สำเร็จ ✅`);
    $('start-post').textContent = j.post.name;
    $('start-info').textContent = `มีจุดตรวจทั้งหมด ${j.checkpoints.length} จุด · กะ #${j.shift.id}` +
      (j.schedule ? ` · เวรของคุณวันนี้ ${j.schedule.start_time}–${j.schedule.end_time} น.` : '');
    show('scr-start');
  } catch (e) { toast(e.message); goScanIn(); }
}

// ---------- เริ่มกะ ----------
async function startShift() {
  try {
    await api('/api/guard/start', { shiftId: S.shift.id });
    connectWS(); startGPS(); initMap(); renderCpList(); show('scr-patrol');
    toast('เริ่มติดตาม GPS แล้ว 📍');
  } catch (e) { toast(e.message); }
}

// ---------- GPS + Realtime ----------
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  S.ws = new WebSocket(`${proto}://${location.host}/ws?token=${S.token}`);
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
    if (t - S.lastSent > (Number(S.cfg.gps_interval_sec) || 4) * 1000) { S.lastSent = t; sendPos(); }
  }, (e) => toast('GPS: ' + e.message), { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
}
function sendPos() {
  if (!S.myPos || !S.shift) return;
  const msg = { type: 'pos', shiftId: S.shift.id, lat: S.myPos.lat, lng: S.myPos.lng, accuracy: S.myPos.acc };
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg));
  else api('/api/guard/position', { shiftId: S.shift.id, ...S.myPos }).catch(() => {});
}

// ---------- แผนที่ ----------
function initMap() {
  if (S.map) return;
  S.map = L.map('gmap').setView([S.post.lat, S.post.lng], 17);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(S.map);
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

function renderCpList() {
  const el = $('cp-list'); el.innerHTML = '';
  let done = 0;
  for (const cp of [...S.checkpoints].sort((a, b) => a.seq - b.seq)) {
    const d = distTo(cp); const isDone = S.visits.has(cp.id);
    if (isDone) done++;
    const near = d !== null && d <= cp.radius;
    const div = document.createElement('div');
    div.className = 'cp-item' + (isDone ? ' done' : near ? ' near' : ' far');
    div.innerHTML = `<div style="flex:2;"><b>${cp.code}</b> ${cp.name}<br>
      <span class="muted">รัศมี ${cp.radius} ม. · ${isDone ? '<span class="tag tag-ok">✓ เช็คแล้ว</span>' : ''}</span></div>
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
function shoot() {
  const v = $('cam-shot'), c = $('canvas-shot');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  S.shotData = c.toDataURL('image/jpeg', 0.8);
  $('img-shot').src = S.shotData; $('img-shot').classList.remove('hidden');
  $('cam-shot').classList.add('hidden');
  $('btn-shoot').classList.add('hidden'); $('btn-send').classList.remove('hidden');
}
function closeCam() {
  $('modal-cam').classList.add('hidden');
  if (S.shotStream) { S.shotStream.getTracks().forEach(t => t.stop()); S.shotStream = null; }
}
async function sendVisit() {
  if (!S.shotData || !S.shotCp || !S.myPos) return;
  try {
    const j = await api('/api/guard/visit', { shiftId: S.shift.id, checkpointId: S.shotCp.id,
      lat: S.myPos.lat, lng: S.myPos.lng, accuracy: S.myPos.acc, photo: S.shotData });
    S.visits.add(S.shotCp.id);
    closeCam(); renderCpList(); toast(`✅ เช็ค ${S.shotCp.code} สำเร็จ (ห่าง ${j.dist} ม.)`);
    const m = S.cpMarkers[S.shotCp.id]; if (m) { m.setStyle({ color: '#22c55e', fillColor: '#22c55e' }); }
  } catch (e) {
    closeCam();
    if (e.status === 409) toast('⚠️ ' + e.message + ' — เดินเข้าใกล้จุดแล้วถ่ายใหม่');
    else toast(e.message);
    renderCpList();
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
