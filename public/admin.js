/* Smart Guard Tour — ฝั่ง Admin */
const $ = (id) => document.getElementById(id);
const toast = (m) => { const t = $('toast'); t.textContent = m; t.style.display = 'block';
  clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 3500); };
const S = { token: localStorage.getItem('sgt_admin_token') || '', data: null, ws: null,
  mapLive: null, mapManage: null, markers: {}, polylines: {}, clickTarget: null };

async function api(path, body, method) {
  const r = await fetch(path, { method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', 'x-token': S.token }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'ผิดพลาด');
  return j;
}

async function doLogin() {
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('lg-name').value.trim(), pin: $('lg-pin').value.trim() }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    if (j.user.role !== 'admin') throw new Error('ต้องเป็นบัญชี admin');
    S.token = j.token; localStorage.setItem('sgt_admin_token', j.token);
    $('scr-login').classList.add('hidden'); $('scr-main').classList.remove('hidden');
    await loadAll(); initLiveMap(); connectWS();
  } catch (e) { toast(e.message); }
}

function switchTab(tab, btn) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  ['live', 'manage', 'qr', 'reports', 'notif'].forEach(t => $('tab-' + t).classList.toggle('hidden', t !== tab));
  if (tab === 'manage' && !S.mapManage) initManageMap();
}

async function loadAll() {
  S.data = await api('/api/admin/overview');
  renderPosts(); renderCpsAdmin(); renderQRs(); renderShifts(); renderReports(); renderNotif(); renderLiveList();
}

// ---------- แผนที่สด ----------
function initLiveMap() {
  const c = S.data.posts[0] ? [S.data.posts[0].lat, S.data.posts[0].lng] : [13.7307, 100.5418];
  S.mapLive = L.map('map-admin').setView(c, 16);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(S.mapLive);
  for (const p of S.data.posts) L.marker([p.lat, p.lng]).addTo(S.mapLive).bindPopup('🚔 ' + p.name);
  for (const cp of S.data.checkpoints) {
    L.circleMarker([cp.lat, cp.lng], { radius: 7, color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: .9 })
      .addTo(S.mapLive).bindPopup(cp.code + ' ' + cp.name);
    L.circle([cp.lat, cp.lng], { radius: cp.radius, color: '#38bdf8', weight: 1, fillOpacity: .04 }).addTo(S.mapLive);
  }
}
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  S.ws = new WebSocket(`${proto}://${location.host}/ws?token=${S.token}`);
  S.ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'gps') onGps(m);
    else if (m.type === 'visit') toast(`📍 ${m.guard} เช็ค ${m.checkpoint} ${m.inside ? 'สำเร็จ' : '⚠️ นอกรัศมี'}`);
    else if (m.type === 'report') { toast(`📨 รายงานใหม่ #${m.reportId} จาก ${m.guard}`); loadAll(); }
    else if (m.type === 'shift') { loadAll(); }
  };
  S.ws.onclose = () => setTimeout(connectWS, 3000);
}
function onGps(m) {
  if (!S.mapLive) return;
  let mk = S.markers[m.shiftId];
  const label = `🟢 ${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}<br><small>รับเมื่อ ${new Date(m.ts).toLocaleTimeString('th-TH')}</small>`;
  if (mk) { mk.setLatLng([m.lat, m.lng]); mk.setPopupContent(label); }
  else {
    mk = L.circleMarker([m.lat, m.lng], { radius: 10, color: '#22c55e', fillColor: '#22c55e', fillOpacity: .95 })
      .addTo(S.mapLive).bindPopup(label).openPopup();
    S.markers[m.shiftId] = mk;
  }
  let pl = S.polylines[m.shiftId];
  if (pl) pl.addLatLng([m.lat, m.lng]);
  else { pl = L.polyline([[m.lat, m.lng]], { color: '#22c55e', weight: 3 }).addTo(S.mapLive); S.polylines[m.shiftId] = pl; }
  renderLiveList();
}
function renderLiveList() {
  const el = $('live-list'); if (!el) return;
  const rows = Object.entries(S.markers).map(([sid, mk]) => {
    const ll = mk.getLatLng();
    return `<div class="cp-item"><div><b>กะ #${sid}</b> — ตำแหน่งล่าสุด ${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}</div>
      <button class="btn-sm btn-ghost" onclick="showTrack(${sid})">🛤️ ดูเส้นทาง</button></div>`;
  });
  el.innerHTML = rows.length ? rows.join('') : '<p class="muted">ยังไม่มี รปภ. กำลังปฏิบัติงาน</p>';
}
async function showTrack(shiftId) {
  try {
    const j = await api(`/api/admin/shift/${shiftId}/track`);
    if (S.mapLive && j.track.length) {
      L.polyline(j.track.map(t => [t.lat, t.lng]), { color: '#a855f7', weight: 4, dashArray: '6 6' }).addTo(S.mapLive);
      S.mapLive.fitBounds(L.polyline(j.track.map(t => [t.lat, t.lng])).getBounds().pad(0.3));
    }
    toast(`กะ #${shiftId}: ${j.shift.guard_name} · บันทึก GPS ${j.track.length} จุด`);
  } catch (e) { toast(e.message); }
}

// ---------- จัดการป้อม/จุดตรวจ ----------
function initManageMap() {
  const c = S.data.posts[0] ? [S.data.posts[0].lat, S.data.posts[0].lng] : [13.7307, 100.5418];
  S.mapManage = L.map('map-manage').setView(c, 16);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(S.mapManage);
  S.mapManage.on('click', (e) => {
    $('p-lat').value = e.latlng.lat.toFixed(6); $('p-lng').value = e.latlng.lng.toFixed(6);
    $('c-lat').value = e.latlng.lat.toFixed(6); $('c-lng').value = e.latlng.lng.toFixed(6);
  });
  drawManageMarkers();
}
function drawManageMarkers() {
  if (!S.mapManage) return;
  S.mapManage.eachLayer(l => { if (l instanceof L.Marker || l instanceof L.CircleMarker || l instanceof L.Circle) S.mapManage.removeLayer(l); });
  for (const p of S.data.posts) L.marker([p.lat, p.lng]).addTo(S.mapManage).bindPopup('🚔 ' + p.name);
  for (const cp of S.data.checkpoints) {
    L.circleMarker([cp.lat, cp.lng], { radius: 7, color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: .9 }).addTo(S.mapManage).bindPopup(cp.code);
    L.circle([cp.lat, cp.lng], { radius: cp.radius, color: '#38bdf8', weight: 1 }).addTo(S.mapManage);
  }
}
async function addPost() {
  try {
    await api('/api/admin/posts', { name: $('p-name').value.trim(), lat: +$('p-lat').value, lng: +$('p-lng').value, radius: +$('p-radius').value });
    toast('สร้างป้อม + QR สำเร็จ 🎫'); $('p-name').value = ''; await loadAll(); drawManageMarkers();
  } catch (e) { toast(e.message); }
}
async function addCheckpoint() {
  try {
    const j = await api('/api/admin/checkpoints', { name: $('c-name').value.trim(), lat: +$('c-lat').value, lng: +$('c-lng').value, radius: +$('c-radius').value });
    toast('เพิ่มจุด ' + j.code + ' แล้ว'); $('c-name').value = ''; await loadAll(); drawManageMarkers();
  } catch (e) { toast(e.message); }
}
async function delPost(id) { if (!confirm('ลบป้อมนี้?')) return; await api(`/api/admin/posts/${id}`, null, 'DELETE'); await loadAll(); drawManageMarkers(); }
async function delCp(id) { if (!confirm('ลบจุดตรวจนี้?')) return; await api(`/api/admin/checkpoints/${id}`, null, 'DELETE'); await loadAll(); drawManageMarkers(); }

function renderPosts() {
  $('post-list').innerHTML = S.data.posts.map(p =>
    `<div class="cp-item"><div>🚔 <b>${p.name}</b><br><span class="muted">รัศมี QR ${p.radius} ม.</span></div>
     <button class="btn-sm btn-ghost" onclick="delPost(${p.id})">ลบ</button></div>`).join('') || '<p class="muted">ยังไม่มีป้อม</p>';
}
function renderCpsAdmin() {
  $('cp-list-admin').innerHTML = S.data.checkpoints.map(c =>
    `<div class="cp-item"><div><b>${c.code}</b> ${c.name}<br><span class="muted">รัศมี ${c.radius} ม. · ลำดับ ${c.seq}</span></div>
     <button class="btn-sm btn-ghost" onclick="delCp(${c.id})">ลบ</button></div>`).join('') || '<p class="muted">ยังไม่มีจุดตรวจ</p>';
}

// ---------- QR ----------
function renderQRs() {
  $('qr-list').innerHTML = S.data.posts.map(p =>
    `<div class="card row"><img class="qr-img" src="${p.qr_png}" alt="QR">
      <div><b>${p.name}</b><br>
      <span class="muted" style="font-size:11px; word-break:break-all;">${p.qr}</span><br>
      <button class="btn-sm btn-ghost" style="margin-top:6px;" onclick="navigator.clipboard.writeText('${p.qr}');toast('คัดลอกรหัส QR แล้ว')">📋 คัดลอกรหัส QR</button>
      <a class="btn-sm btn-ghost" style="display:inline-block;margin-top:6px;" href="${p.qr_png}" download="qr-post-${p.id}.png">⬇️ ดาวน์โหลดรูป QR</a></div>
     </div>`).join('') || '<p class="muted">ยังไม่มีป้อม — ไปแท็บ "ป้อม & จุดตรวจ" เพื่อสร้าง</p>';
}

// ---------- กะ & รายงาน ----------
function renderShifts() {
  $('shift-list').innerHTML = S.data.shifts.slice(0, 12).map(s => {
    const st = s.status === 'checked_out' ? '<span class="tag tag-info">จบแล้ว</span>'
      : s.status === 'patrolling' ? '<span class="tag tag-ok">กำลังตรวจ</span>' : '<span class="tag tag-warn">เช็คอินแล้ว</span>';
    return `<div class="cp-item"><div><b>#${s.id}</b> ${s.guard_name} @ ${s.post_name}<br>
      <span class="muted">${(s.checked_in_at || '').slice(11, 19)} น.</span> ${st}</div></div>`;
  }).join('') || '<p class="muted">ยังไม่มีกะ</p>';
}
function renderReports() {
  $('report-list').innerHTML = S.data.reports.map(r =>
    `<div class="cp-item" style="cursor:pointer;" onclick="openReport(${r.id})">
      <div>📋 <b>รายงาน #${r.id}</b> — ${r.guard_name} @ ${r.post_name}<br>
      <span class="muted">${r.ended_at ? r.ended_at.slice(0, 16).replace('T', ' ') : ''} · เช็คสำเร็จ ${r.visited}/${r.total} จุด · ส่งถึง: ${r.sent_to || 'inbox'}</span></div>
      <span>›</span></div>`).join('') || '<p class="muted">ยังไม่มีรายงาน</p>';
}
async function openReport(id) {
  try {
    const r = await api(`/api/admin/reports/${id}`);
    $('mr-title').textContent = `📋 รายงาน #${r.id} — ${r.guard_name} @ ${r.post_name}`;
    const d = r.detail;
    $('mr-body').innerHTML = `
      <p><b>เช็คจุดสำเร็จ ${d.checkpoints_visited}/${d.checkpoints_total} จุด</b> · จุด GPS ${d.gps_points} จุด</p>
      <p class="muted">เริ่ม ${d.started_at || d.checked_in_at} — จบ ${d.checked_out_at}</p>
      <table><tr><th>จุด</th><th>เวลา</th><th>ความแม่นยำ</th></tr>
      ${d.visits.map(v => `<tr><td>${v.code} ${v.name}</td><td>${(v.ts || '').slice(11, 19)}</td><td>±${Math.round(v.accuracy || 0)} ม.</td></tr>`).join('')}
      </table>
      <h2 style="margin-top:12px;">รูปถ่าย</h2>
      <div class="photo-grid">${d.visits.filter(v => v.photo).map(v => `<img src="${v.photo}">`).join('') || '<p class="muted">ไม่มีรูป</p>'}</div>`;
    $('modal-report').classList.remove('hidden');
  } catch (e) { toast(e.message); }
}

// ---------- แจ้งเตือน ----------
async function addNotif() {
  try {
    await api('/api/admin/notif', { event_type: $('n-event').value, label: $('n-label').value.trim(), webhook_url: $('n-url').value.trim() });
    toast('บันทึกกลุ่มแล้ว 🔔'); await loadAll();
  } catch (e) { toast(e.message); }
}
async function delNotif(id) { if (!confirm('ลบกลุ่มนี้?')) return; await api(`/api/admin/notif/${id}`, null, 'DELETE'); await loadAll(); }
function renderNotif() {
  $('notif-list').innerHTML = S.data.notif.map(n =>
    `<div class="cp-item"><div><b>${n.label}</b> <span class="tag tag-info">${n.event_type}</span><br>
     <span class="muted" style="word-break:break-all;">${n.webhook_url || '(ยังไม่ใส่ URL)'}</span></div>
     <button class="btn-sm btn-ghost" onclick="delNotif(${n.id})">ลบ</button></div>`).join('') || '<p class="muted">ยังไม่มีกลุ่ม</p>';
}
