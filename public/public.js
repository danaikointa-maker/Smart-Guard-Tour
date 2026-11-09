/* แดชบอร์ดสาธารณะ (read-only, ไม่ต้องล็อกอิน) — ข้อมูลรวมอย่างเดียว */
const $ = (id) => document.getElementById(id);

async function load() {
  try {
    const r = await fetch('/api/public/summary');
    const j = await r.json();
    if (!r.ok) {
      $('banner-off').classList.remove('hidden');
      $('content').classList.add('hidden');
      return;
    }
    $('banner-off').classList.add('hidden');
    $('content').classList.remove('hidden');
    $('site-name').textContent = j.site_name || 'Smart Guard Tour';
    $('as-of').textContent = 'ข้อมูล ณ ' + new Date(j.as_of).toLocaleString('th-TH');
    $('st-patrol').textContent = j.patrolling_now;
    $('st-shifts').textContent = j.shifts_today;
    $('st-inc').textContent = j.open_incidents;
    $('st-sos').textContent = j.sos_today;
    $('post-list').innerHTML = (j.posts || []).map(p => {
      const pct = p.total ? Math.round(100 * p.visited_today / p.total) : 0;
      const done = p.total > 0 && p.visited_today >= p.total;
      return `<div style="margin-bottom:12px;">
        <div class="row"><b>🚔 ${p.name}</b><span class="tag ${done ? 'tag-ok' : 'tag-info'}">${done ? '✅ ตรวจครบ' : p.visited_today + '/' + p.total + ' จุด'}</span></div>
        <div style="background:#e5e7eb;border-radius:8px;height:12px;margin-top:6px;">
          <div style="background:${done ? '#22c55e' : '#38bdf8'};height:12px;border-radius:8px;width:${pct}%;"></div>
        </div></div>`;
    }).join('') || '<p class="muted">ยังไม่มีป้อม</p>';
  } catch (e) {
    $('as-of').textContent = 'เชื่อมต่อไม่ได้ — กำลังลองใหม่…';
  }
}
load();
setInterval(load, 15000);
