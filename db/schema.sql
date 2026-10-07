-- BIM Twin schema v2 (Phase A)
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT);
INSERT OR IGNORE INTO schema_meta(key,value) VALUES ('version','2');

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT, address TEXT, status TEXT
);

CREATE TABLE IF NOT EXISTS section_presets (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  source_json TEXT NOT NULL,
  params_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, id)
);

CREATE TABLE IF NOT EXISTS floors (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  number INTEGER, name TEXT
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  floor_id TEXT,
  name TEXT, number TEXT, type TEXT,
  area_m2 REAL, height_m REAL, material TEXT, cost REAL, status TEXT,
  model_name TEXT, model_file TEXT, model_mime TEXT
);

CREATE TABLE IF NOT EXISTS elements (
  id TEXT PRIMARY KEY,
  room_id TEXT,
  ifc_guid TEXT, type TEXT, name TEXT, ai_status TEXT DEFAULT 'none'
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  room_id TEXT, element_id TEXT,
  type TEXT, name TEXT, version TEXT, date TEXT, author TEXT,
  file TEXT, mime TEXT, size INTEGER, is_upload INTEGER DEFAULT 0,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT, v TEXT, date TEXT, file TEXT
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  room_id TEXT, name TEXT, file TEXT, mime TEXT, size INTEGER, is_upload INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ai_findings (
  id TEXT PRIMARY KEY,
  element_id TEXT, document_id TEXT,
  kind TEXT, severity TEXT, confidence REAL, text TEXT
);

CREATE INDEX IF NOT EXISTS idx_rooms_floor ON rooms(floor_id);
CREATE INDEX IF NOT EXISTS idx_el_room ON elements(room_id);
CREATE INDEX IF NOT EXISTS idx_doc_room ON documents(room_id);
CREATE INDEX IF NOT EXISTS idx_find_el ON ai_findings(element_id);
CREATE INDEX IF NOT EXISTS idx_docver_doc ON document_versions(document_id);
CREATE INDEX IF NOT EXISTS idx_floors_project ON floors(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_section_presets_project_name ON section_presets(project_id, name_key);
CREATE INDEX IF NOT EXISTS idx_section_presets_project_updated ON section_presets(project_id, updated_at);
