/* ปุ่ม "เข้าด้วย SSO (VVA)" — แสดงเฉพาะเมื่อ admin เปิด sso_enabled ใน ⚙️ ตั้งค่า */
async function ssoMaybeShow(btnId, nameInputId, onToken) {
  try {
    const c = await (await fetch('/api/settings')).json();
    if (c.sso_enabled !== 'true') return;
    const btn = document.getElementById(btnId);
    btn.classList.remove('hidden');
    btn.textContent = `🔐 เข้าด้วย SSO (${c.sso_provider_name || 'VVA'})`;
    btn.onclick = () => {
      const name = document.getElementById(nameInputId).value.trim();
      if (!name) return alert('ใส่ชื่อก่อน (ชื่อต้องตรงกับบัญชีในระบบ)');
      // โหมด OIDC จริง: redirect ไป VVA ; ถ้าไม่ได้ตั้งค่า env → server จะ fallback เป็น mock และเด้งกลับมา
      location.href = '/api/sso/authorize?name=' + encodeURIComponent(name);
    };
  } catch (e) {}
}
