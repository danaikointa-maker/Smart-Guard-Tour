/* ตัวช่วยแผนที่ร่วม — เลือก Tile ตามการตั้งค่าในหลังบ้าน
   (OSM ค่าเริ่มต้น หรือ Google Maps tiles ใส่ key ใน ⚙️ ตั้งค่า) */
window.SGT = window.SGT || {};
SGT._tiles = null;
SGT.tileUrl = async function () {
  if (SGT._tiles) return SGT._tiles;
  try {
    const r = await fetch('/api/settings');
    const c = await r.json();
    SGT._tiles = c.map_tile_url || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  } catch (e) {
    SGT._tiles = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  }
  return SGT._tiles;
};
SGT.addTileLayer = async function (map) {
  const url = await SGT.tileUrl();
  return L.tileLayer(url, { maxZoom: 20, attribution: 'แผนที่' }).addTo(map);
};
