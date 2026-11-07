/* ตัวช่วยแผนที่ร่วม — เลือก Tile ตามการตั้งค่าในหลังบ้าน
   (OSM ค่าเริ่มต้น หรือ Google Maps tiles ใส่ key ใน ⚙️ ตั้งค่า) */
window.SGT = window.SGT || {};
SGT._tiles = null;
SGT.tileUrl = async function () {
  if (SGT._tiles) return SGT._tiles;
  const OSM = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  try {
    const r = await fetch('/api/settings');
    const c = await r.json();
    if (c.map_provider === 'google' && c.google_maps_api_key) {
      // Google Maps แสดงผล (ข้อมูล GPS ยังเป็นของระบบเราเอง — แค่ใช้ tile ของ Google)
      SGT._tiles = 'https://mt{s}.google.com/vt/lyrs=m&hl=th&x={x}&y={y}&z={z}&key=' + c.google_maps_api_key;
    } else {
      SGT._tiles = c.map_tile_url || OSM;
    }
  } catch (e) { SGT._tiles = OSM; }
  return SGT._tiles;
};
SGT.addTileLayer = async function (map) {
  const url = await SGT.tileUrl();
  return L.tileLayer(url, { maxZoom: 20, attribution: 'แผนที่' }).addTo(map);
};
