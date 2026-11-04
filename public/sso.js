/* ปุ่ม "เข้าด้วย SSO (VVA)" — แสดงเฉพาะเมื่อ admin เปิด sso_enabled ใน ⚙️ ตั้งค่า */
async function ssoMaybeShow(btnId, nameInputId, onToken) {
  try {
    const c = await (await fetch('/api/settings')).json();
    if (c.sso_enabled !== 'true') return;
    const btn = document.getElementById(btnId);
    btn.classList.remove('hidden');
    btn.textContent = `🔐 เข้าด้วย SSO (${c.sso_provider_name || 'VVA'})`;
    btn.onclick = async () => {
      const name = document.getElementById(nameInputId).value.trim();
      if (!name) return alert('ใส่ชื่อก่อน (ชื่อต้องตรงกับบัญชีในระบบ)');
      const r = await fetch('/api/sso/mock-issue?name=' + encodeURIComponent(name));
      const j = await r.json();
      if (!r.ok) return alert(j.error);
      const r2 = await fetch('/api/sso/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vva_token: j.vva_token }) });
      const j2 = await r2.json();
      if (!r2.ok) return alert(j2.error);
      onToken(j2);
    };
  } catch (e) {}
}
