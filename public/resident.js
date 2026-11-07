/* ลูกบ้าน: ดูสถานะการตรวจตามสิทธิ์ที่ Admin ตั้งค่า (ไม่เห็น GPS สดถ้าไม่ได้รับอนุญาต) */
const $ = (id) => document.getElementById(id);
const toast = (m) => { const t = $('toast'); t.textContent = m; t.style.display = 'block';
  clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 3500); };
const S = { token: localStorage.getItem('sgt_res_token') || '', timer: null, map: null, markers: {} };

async function doLogin() {
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: $('lg-name').value.trim(), pin: $('lg-pin').value.trim() }) });
  const j = await r.json();
  if (!r.ok) return toast(j.error);
  if (j.user.role !== 'resident') return toast('บัญชีนี้ไม่ใช่ลูกบ้าน');
  S.token = j.token; localStorage.setItem('sgt_res_token', j.token);
  $('scr-login').classList.add('hidden'); $('scr-main').classList.remove('hidden');
  load(); S.timer = setInterval(load, 10000);
}

async function load() {
  const r = await fetch('/api/resident/status', { headers: { 'x-token': S.token } });
  const j = await r.json();
  if (!r.ok) return toast(j.error);
  if (!j.see_status) { $('shift-cards').innerHTML = '<div class="card">ผู้ดูแลปิดการมองเห็นสถานะสำหรับลูกบ้านในขณะนี้</div>'; return; }
  $('privacy-note').textContent = j.see_live_location
    ? '⚠️ ตอนนี้ผู้ดูแลอนุญาตให้คุณเห็นตำแหน่งสดของ รปภ.'
    : '🔒 คุณเห็นสถานะการตรวจเท่านั้น — ไม่เห็นตำแหน่งสดหรือเส้นทางของ รปภ. (ตามนโยบายความเป็นส่วนตัว)';
  renderShifts(j.shifts);
  if (j.see_live_location) renderLiveMap(j.shifts); else { $('rmap').classList.add('hidden'); }
}

function renderShifts(shifts) {
  $('shift-cards').innerHTML = shifts.map(s => {
    const st = s.status === 'checked_out' ? '<span class="tag tag-info">จบกะแล้ว</span>'
      : s.status === 'patrolling' ? '<span class="tag tag-ok">🟢 กำลังตรวจตรา</span>'
      : '<span class="tag tag-warn">เช็คอินแล้ว</span>';
    return `<div class="card"><div class="row"><b>กะ #${s.id} — ${s.guard_name}</b>${st}</div>
      <p class="muted">${s.post_name} · เช็คจุดตรวจสำเร็จ <b>${s.checkpoints_visited}/${s.checkpoints_total}</b> จุด</p>
      <p class="muted">${s.started_at ? 'เริ่ม ' + s.started_at.slice(11, 19) + ' น.' : ''} ${s.last_update ? '· อัปเดตล่าสุด ' + s.last_update.slice(11, 19) + ' น.' : ''}</p></div>`;
  }).join('') || '<div class="card muted">ยังไม่มีกะตรวจ</div>';
}

function renderLiveMap(shifts) {
  $('rmap').classList.remove('hidden');
  if (!S.map) {
    S.map = L.map('rmap').setView([13.7307, 100.5418], 16);
    SGT.addTileLayer(S.map);
  }
  const live = shifts.filter(s => s.live);
  for (const s of live) {
    if (S.markers[s.id]) S.markers[s.id].setLatLng([s.live.lat, s.live.lng]);
    else S.markers[s.id] = L.circleMarker([s.live.lat, s.live.lng], { radius: 9, color: '#22c55e', fillColor: '#22c55e' })
      .addTo(S.map).bindPopup(`🚶 ${s.guard_name}<br><small>${s.live.ts.slice(11, 19)} น.</small>`);
  }
}

(async () => {
  if (!S.token) return;
  const rr = await fetch('/api/resident/status', { headers: { 'x-token': S.token } });
  if (rr.ok) { $('scr-login').classList.add('hidden'); $('scr-main').classList.remove('hidden'); load(); S.timer = setInterval(load, 10000); }
  else localStorage.removeItem('sgt_res_token');
})();
