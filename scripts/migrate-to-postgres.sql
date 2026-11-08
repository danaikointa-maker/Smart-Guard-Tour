-- ============================================================
-- Smart Guard Tour: สคริปต์สร้างสคีมา PostgreSQL + PostGIS
-- ใช้เมื่อขึ้นโปรดักชัน (DATABASE_URL=postgres://...)
-- ข้อมูลเดิมย้ายด้วย pg_dump --data-only หรือสคริปต์ย้ายเอง
-- ============================================================
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS users(
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  pin TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'guard',
  vva_user_id TEXT
);
CREATE TABLE IF NOT EXISTS posts(
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  geom GEOGRAPHY(POINT, 4326) NOT NULL,   -- PostGIS: เก็บพิกัดแบบทรงกลม
  lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL, -- เก็บซ้ำไว้อ่านง่าย
  radius DOUBLE PRECISION NOT NULL DEFAULT 30,
  qr TEXT NOT NULL, qr_png TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints(
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  geom GEOGRAPHY(POINT, 4326) NOT NULL,
  lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL,
  radius DOUBLE PRECISION NOT NULL DEFAULT 100,
  seq INTEGER NOT NULL DEFAULT 1
);
-- geofence check แบบ PostGIS (แทน haversine ใน geo.js):
--   SELECT ST_DWithin(geom, ST_SetSRID(ST_MakePoint(lng,lat),4326)::geography, radius)
CREATE TABLE IF NOT EXISTS shifts(
  id SERIAL PRIMARY KEY,
  guard_id INTEGER NOT NULL REFERENCES users(id),
  post_id INTEGER NOT NULL REFERENCES posts(id),
  status TEXT NOT NULL DEFAULT 'checked_in',
  checked_in_at TIMESTAMPTZ, started_at TIMESTAMPTZ, checked_out_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS gps_tracks(
  id BIGSERIAL PRIMARY KEY,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL, accuracy DOUBLE PRECISION,
  ts TIMESTAMPTZ NOT NULL
) PARTITION BY RANGE (ts);          -- partition ตามเดือน
CREATE TABLE gps_tracks_2026_11 PARTITION OF gps_tracks
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS visits(
  id BIGSERIAL PRIMARY KEY,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id),
  lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL, accuracy DOUBLE PRECISION,
  inside BOOLEAN NOT NULL,
  photo TEXT,
  ts TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS incidents(
  id SERIAL PRIMARY KEY,
  shift_id INTEGER REFERENCES shifts(id),
  guard_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL, description TEXT,
  lat DOUBLE PRECISION, lng DOUBLE PRECISION, accuracy DOUBLE PRECISION,
  photo TEXT, sent_to TEXT, ts TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS reports(
  id SERIAL PRIMARY KEY,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  guard_name TEXT, post_name TEXT,
  started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ,
  total INTEGER, visited INTEGER,
  detail JSONB, sent_to TEXT, created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS notif_groups(
  id SERIAL PRIMARY KEY,
  event_type TEXT NOT NULL, label TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'webhook',
  webhook_url TEXT NOT NULL DEFAULT '',
  bot_token TEXT NOT NULL DEFAULT '',
  chat_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS shift_schedules(
  id SERIAL PRIMARY KEY,
  guard_id INTEGER NOT NULL REFERENCES users(id),
  post_id INTEGER NOT NULL REFERENCES posts(id),
  date DATE NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs(
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_gps_shift ON gps_tracks(shift_id, ts);
CREATE INDEX IF NOT EXISTS idx_visits_shift ON visits(shift_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts DESC);
