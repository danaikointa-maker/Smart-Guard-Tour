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
    if (j.user.role !== 'admin' && j.user.role !== 'supervisor') throw new Error('ต้องเป็นบัญชี admin หรือหัวหน้า รปภ.');
    S.token = j.token; S.role = j.user.role; localStorage.setItem('sgt_admin_token', j.token); localStorage.setItem('sgt_admin_role', j.user.role);
    $('scr-login').classList.add('hidden'); $('scr-main').classList.remove('hidden');
    if (S.role === 'supervisor') {
      // หัวหน้า รปภ.: เห็นเฉพาะแผนที่สด + รายงาน (อ่านอย่างเดียว ไม่ตั้งค่าได้)
      document.querySelectorAll('.tabs button').forEach(b => {
        const t = b.dataset.tab;
        if (!['live', 'reports'].includes(t)) b.classList.add('hidden');
      });
      $('tab-live').querySelector('.card b').textContent = '🟢 ตำแหน่ง รปภ. แบบเรียลไทม์ (มุมมองหัวหน้า)';
    }
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
  SGT.addTileLayer(S.mapLive);
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
    else if (m.type === 'sos') {
      toast(`🚨 SOS จาก ${m.guard}! ${m.lat}, ${m.lng}`);
      if (S.mapLive && m.lat) {
        L.circleMarker([m.lat, m.lng], { radius: 16, color: '#ef4444', fillColor: '#ef4444', fillOpacity: .8 })
          .addTo(S.mapLive).bindPopup(`🚨 SOS ${m.guard}<br>${new Date(m.ts).toLocaleTimeString('th-TH')}`).openPopup();
      }
    }
    else if (m.type === 'missed_cp') toast(`⚠️ กะ #${m.shiftId}: ${m.guard} ยังไม่เช็ค ${m.cp}`);
    else if (m.type === 'incident') { toast(`🚨 เหตุการณ์ใหม่: ${m.incidentType} โดย ${m.guard}`); loadAll(); }
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
  SGT.addTileLayer(S.mapManage);
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
    lastReport = r;
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
function toggleNotifFields() {
  const ch = $('n-channel').value;
  $('n-url').classList.toggle('hidden', ch !== 'webhook');
  $('n-token').classList.toggle('hidden', ch === 'webhook');
  $('n-chat').classList.toggle('hidden', ch === 'webhook');
}
async function addNotif() {
  try {
    await api('/api/admin/notif', {
      event_type: $('n-event').value, label: $('n-label').value.trim(), channel: $('n-channel').value,
      webhook_url: $('n-url').value.trim(), bot_token: $('n-token').value.trim(), chat_id: $('n-chat').value.trim(),
    });
    toast('บันทึกกลุ่มแล้ว 🔔'); await loadAll();
  } catch (e) { toast(e.message); }
}
async function delNotif(id) { if (!confirm('ลบกลุ่มนี้?')) return; await api(`/api/admin/notif/${id}`, null, 'DELETE'); await loadAll(); }
async function testNotif(id) {
  toast('กำลังทดสอบส่ง…');
  try { const j = await api(`/api/admin/notif/${id}/test`, {}); toast(j.ok ? '✅ ส่งสำเร็จ: ' + j.result : '⚠️ ' + j.result); }
  catch (e) { toast(e.message); }
}
const CH_LABEL = { webhook: 'Webhook', telegram: 'Telegram', line: 'LINE' };
function renderNotif() {
  $('notif-list').innerHTML = S.data.notif.map(n =>
    `<div class="cp-item"><div><b>${n.label}</b> <span class="tag tag-info">${n.event_type}</span>
     <span class="tag tag-ok">${CH_LABEL[n.channel] || n.channel}</span><br>
     <span class="muted" style="word-break:break-all;">${n.channel === 'webhook' ? (n.webhook_url || '(ยังไม่ใส่ URL)')
       : 'chat/group: ' + (n.chat_id || '-') + (n.bot_token ? ' · มี token ✓' : ' · ขาด token')}</span></div>
     <div style="display:flex;gap:6px;"><button class="btn-sm btn-ghost" onclick="testNotif(${n.id})">🧪 ทดสอบ</button>
     <button class="btn-sm btn-ghost" onclick="delNotif(${n.id})">ลบ</button></div></div>`).join('') || '<p class="muted">ยังไม่มีกลุ่ม</p>';
}

// ---------- ผู้ใช้ ----------
const ROLE_LABEL = { guard: '🚶 รปภ.', supervisor: '👮 หัวหน้า รปภ.', resident: '🏠 ลูกบ้าน', admin: '🛠️ Admin' };
async function addUser() {
  try {
    await api('/api/admin/users', { name: $('u-name').value.trim(), pin: $('u-pin').value.trim(), role: $('u-role').value });
    toast('เพิ่มผู้ใช้แล้ว 👥'); $('u-name').value = ''; $('u-pin').value = ''; await loadAll();
  } catch (e) { toast(e.message); }
}
async function delUser(id) { if (!confirm('ลบผู้ใช้นี้?')) return; try { await api(`/api/admin/users/${id}`, null, 'DELETE'); await loadAll(); } catch (e) { toast(e.message); } }
async function resetPin(id) {
  const pin = prompt('ตั้ง PIN ใหม่:'); if (!pin) return;
  try { await api(`/api/admin/users/${id}`, { pin }); toast('เปลี่ยน PIN แล้ว'); } catch (e) { toast(e.message); }
}
function renderUsers() {
  $('user-list').innerHTML = S.data.users.map(u =>
    `<div class="cp-item"><div><b>${u.name}</b> <span class="tag tag-info">${ROLE_LABEL[u.role] || u.role}</span></div>
     <div style="display:flex;gap:6px;"><button class="btn-sm btn-ghost" onclick="resetPin(${u.id})">🔑 เปลี่ยน PIN</button>
     <button class="btn-sm btn-ghost" onclick="delUser(${u.id})">ลบ</button></div></div>`).join('') || '<p class="muted">ไม่มีผู้ใช้</p>';
}

// ---------- ตารางเวร ----------
async function addSchedule() {
  try {
    await api('/api/admin/schedules', { guard_id: +$('sc-guard').value, post_id: +$('sc-post').value,
      date: $('sc-date').value, start_time: $('sc-start').value, end_time: $('sc-end').value });
    toast('เพิ่มตารางเวรแล้ว 🕐'); await loadAll();
  } catch (e) { toast(e.message); }
}
async function delSchedule(id) { if (!confirm('ลบตารางเวรนี้?')) return; await api(`/api/admin/schedules/${id}`, null, 'DELETE'); await loadAll(); }
function renderSchedules() {
  const guards = S.data.users.filter(u => u.role === 'guard');
  $('sc-guard').innerHTML = guards.map(u => `<option value="${u.id}">${u.name}</option>`).join('');
  $('sc-post').innerHTML = S.data.posts.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  if (!$('sc-date').value) $('sc-date').value = new Date().toISOString().slice(0, 10);
  $('schedule-list').innerHTML = S.data.schedules.map(sc =>
    `<div class="cp-item"><div>🕐 <b>${sc.date}</b> ${sc.start_time}–${sc.end_time}<br>
     <span class="muted">${sc.guard_name} @ ${sc.post_name}</span></div>
     <button class="btn-sm btn-ghost" onclick="delSchedule(${sc.id})">ลบ</button></div>`).join('') || '<p class="muted">ยังไม่มีตารางเวร</p>';
}

// ---------- ตั้งค่าระบบ ----------
function renderSettings() {
  const boolKeys = ['resident_see_status', 'resident_see_live_location', 'resident_see_history'];
  $('settings-list').innerHTML = S.data.settings.map(s => {
    const isBool = boolKeys.includes(s.key);
    const val = isBool
      ? `<select data-key="${s.key}"><option value="true" ${s.value === 'true' ? 'selected' : ''}>เปิด (true)</option>
          <option value="false" ${s.value === 'false' ? 'selected' : ''}>ปิด (false)</option></select>`
      : `<input data-key="${s.key}" value="${s.value.replace(/"/g, '&quot;')}">`;
    return `<div class="row" style="margin-bottom:10px;"><span style="flex:2;">${s.label}<br><span class="muted">${s.key}</span></span>${val}</div>`;
  }).join('');
}
async function saveSettings() {
  const body = {};
  document.querySelectorAll('#settings-list [data-key]').forEach(el => body[el.dataset.key] = el.value);
  try { const j = await api('/api/admin/settings', body, 'PUT'); toast(`บันทึกแล้ว 💾 (${j.updated} รายการ)`); await loadAll(); }
  catch (e) { toast(e.message); }
}

// ---------- สถิติ ----------
async function loadStats() {
  try {
    const s = await api('/api/admin/stats');
    const maxV = Math.max(1, ...s.last7days.map(d => d.visits));
    $('stats-body').innerHTML = `
      <div class="row" style="flex-wrap:wrap;">
        ${[['👥 ผู้ใช้ทั้งหมด', s.totals.users], ['🚶 รปภ.', s.totals.guards], ['🚔 ป้อม', s.totals.posts],
           ['📍 จุดตรวจ', s.totals.checkpoints], ['🕐 กะทั้งหมด', s.totals.shifts_total], ['📅 กะวันนี้', s.totals.shifts_today],
           ['📋 รายงาน', s.totals.reports], ['🚨 SOS', s.totals.sos], ['📡 จุด GPS', s.totals.gps_points]]
          .map(([l, v]) => `<div class="card" style="flex:1;min-width:100px;text-align:center;"><div class="big">${v}</div><span class="muted">${l}</span></div>`).join('')}
      </div>
      <div class="card"><h2>⏱️ ระยะเวลากะเฉลี่ย</h2><div class="big">${s.avg_shift_minutes ? s.avg_shift_minutes + ' นาที' : '—'}</div></div>
      <div class="card"><h2>📈 7 วันย้อนหลัง (กะ / การเช็คจุด)</h2>
        ${s.last7days.map(d => `<div class="row" style="margin-bottom:6px;"><span style="width:90px;">${d.date.slice(5)}</span>
          <div style="flex:1;background:#0b1220;border-radius:8px;height:18px;"><div style="width:${Math.round(d.visits / maxV * 100)}%;background:var(--ok);height:100%;border-radius:8px;"></div></div>
          <span class="muted" style="width:110px;text-align:right;">${d.shifts} กะ · ${d.visits} จุด</span></div>`).join('')}
      </div>
      <div class="card"><h2>📍 จุดตรวจที่ถูกเช็คบ่อย</h2>
        ${s.checkpoint_stats.map(c => `<div class="cp-item"><div><b>${c.code}</b> ${c.name}</div><b>${c.visited} ครั้ง</b></div>`).join('') || '<p class="muted">ยังไม่มีข้อมูล</p>'}
      </div>`;
  } catch (e) { toast(e.message); }
}

// ---------- บันทึกการใช้งาน ----------
function renderAudit() {
  $('audit-list').innerHTML = (S.data.audit || []).map(a =>
    `<div class="cp-item"><div><b>${a.action}</b> โดย ${a.actor}<br>
     <span class="muted">${a.ts.replace('T', ' ').slice(0, 19)} · ${a.detail || ''}</span></div></div>`).join('')
    || '<p class="muted">ยังไม่มีบันทึก</p>';
}


// auto-login ถ้ามี token ค้าง (เช่น เข้าผ่าน SSO แล้ว reload)
(async () => {
  if (!S.token) return;
  try {
    S.data = await api('/api/admin/overview');
    $('scr-login').classList.add('hidden'); $('scr-main').classList.remove('hidden');
    if (S.role === 'supervisor') {
      document.querySelectorAll('.tabs button').forEach(b => {
        if (!['live', 'reports', 'stats', 'audit'].includes(b.dataset.tab)) b.classList.add('hidden');
      });
    }
    renderPosts(); renderCpsAdmin(); renderQRs(); renderShifts(); renderReports(); renderNotif(); renderUsers(); renderSchedules(); renderSettings(); renderAudit(); loadStats();
    initLiveMap(); connectWS();
  } catch (e) { localStorage.removeItem('sgt_admin_token'); localStorage.removeItem('sgt_admin_role'); }
})();

// ---------- เหตุการณ์ ----------
function renderIncidents() {
  const el = $('incident-list'); if (!el || !S.data.incidents) return;
  el.innerHTML = S.data.incidents.map(i =>
    `<div class="cp-item"><div>🚨 <b>${i.type}</b> โดย ${i.guard_name}<br>
     <span class="muted">${i.ts.replace('T',' ').slice(0,19)} · ${i.lat ? '📍 ' + i.lat.toFixed(5) + ',' + i.lng.toFixed(5) : ''} ${i.description || ''}</span><br>
     <span class="muted">ส่งถึง: ${i.sent_to || 'inbox'}</span></div>
     ${i.photo ? `<img src="${i.photo.startsWith('http') ? i.photo : '/uploads/' + i.photo}" style="width:90px;border-radius:8px;">` : ''}</div>`).join('')
    || '<p class="muted">ยังไม่มีเหตุการณ์</p>';
}

// ---------- ฮีตแมปจุดตรวจบนแผนที่สด ----------
let heatLayer = null;
async function toggleHeat() {
  if (heatLayer) { S.mapLive.removeLayer(heatLayer); heatLayer = null; return; }
  const s = await api('/api/admin/stats');
  heatLayer = L.layerGroup();
  const max = Math.max(1, ...s.checkpoint_stats.map(c => c.visited));
  for (const c of s.checkpoint_stats) {
    const cp = S.data.checkpoints.find(x => x.code === c.code);
    if (!cp) continue;
    L.circle([cp.lat, cp.lng], { radius: 40 + 260 * (c.visited / max), color: '#ef4444',
      fillColor: '#ef4444', fillOpacity: 0.15 + 0.35 * (c.visited / max), weight: 1 })
      .addTo(heatLayer).bindPopup(`${c.code}: ถูกเช็ค ${c.visited} ครั้ง`);
  }
  heatLayer.addTo(S.mapLive);
  toast('🔥 ฮีตแมป: วงสีแดง = ความถี่การเช็คจุดตรวจ');
}

// ---------- ส่งออกรายงาน ----------
let lastReport = null;
async function exportCsv() {
  if (!lastReport) return;
  const d = lastReport.detail;
  const rows = [['code','name','time','lat','lng','accuracy_m'],
    ...d.visits.map(v => [v.code, v.name, v.ts, v.lat, v.lng, Math.round(v.accuracy || 0)])];
  const csv = rows.map(r => r.map(x => '"' + String(x).replace(/"/g, '""') + '"').join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `report_${lastReport.id}.csv`; a.click();
  toast('📥 ดาวน์โหลด CSV แล้ว');
}
