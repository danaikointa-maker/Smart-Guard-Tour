// Service Worker — รับ Web Push แจ้งเตือนแม้ปิดแท็บ (SOS/เหตุการณ์/จุดขาด)
self.addEventListener('push', (e) => {
  let d = { title: 'Smart Guard Tour', body: '' };
  try { d = { ...d, ...JSON.parse(e.data.text()) }; } catch {}
  e.waitUntil(self.registration.showNotification(d.title, { body: d.body, icon: '/favicon.png', data: d.data }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/admin.html'));
});
