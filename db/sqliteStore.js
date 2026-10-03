/*
 * SqliteStore — хранилище на better-sqlite3 с тем же API, что и JsonStore.
 * Применяет schema.sql, мягкие миграции колонок и seed при пустой базе.
 */
const fs = require('fs');
const path = require('path');
const { seed } = require('./seed');
const SectionPresets = require('./sectionPresets');
const ProjectState = require('./project-state');
const { ProjectAssetStore } = require('./project-assets');

function genId(prefix) { return prefix + '_' + Math.random().toString(36).slice(2, 9); }

class SqliteStore {
  constructor(dir, Database) {
    this.dir = dir;
    this.uploadsDir = path.join(dir, 'uploads');
    this.projectAssets = new ProjectAssetStore(dir);
    this.mode = 'sqlite';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.uploadsDir)) fs.mkdirSync(this.uploadsDir, { recursive: true });
    this.db = new Database(path.join(dir, 'bim-twin.db'));
    this.db.pragma('journal_mode = WAL');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    this.db.exec(schema);
    this._migrate();
    const n = this.db.prepare('SELECT COUNT(*) c FROM rooms').get().c;
    if (!n) seed(this.db);
  }

  _ensureColumn(table, col, decl) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  }
  _schemaVersion() {
    try { const r = this.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get(); return r ? (parseInt(r.value, 10) || 0) : 0; } catch (e) { return 0; }
  }
  _setSchemaVersion(v) {
    this.db.prepare("INSERT OR REPLACE INTO schema_meta(key,value) VALUES ('version',?)").run(String(v));
  }
  _migrate() {
    // Явные версионированные миграции. Каждый шаг идемпотентен (IF NOT EXISTS / _ensureColumn)
    // и выполняется в транзакции; текущая версия хранится в schema_meta.
    const migrations = [
      { v: 3, up: () => {
        this._ensureColumn('rooms', 'model_name', 'TEXT');
        this._ensureColumn('rooms', 'model_file', 'TEXT');
        this._ensureColumn('rooms', 'model_mime', 'TEXT');
        this._ensureColumn('documents', 'mime', 'TEXT');
        this._ensureColumn('documents', 'size', 'INTEGER');
        this._ensureColumn('documents', 'is_upload', 'INTEGER DEFAULT 0');
        this._ensureColumn('documents', 'created_at', 'TEXT');
        this._ensureColumn('ai_findings', 'review', "TEXT DEFAULT 'open'");
        this._ensureColumn('ai_findings', 'source', 'TEXT');
        this._ensureColumn('ai_findings', 'comments', 'TEXT');
        this._ensureColumn('ai_findings', 'created_at', 'TEXT');
        this.db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
      } },
      { v: 4, up: () => {
        this._ensureColumn('ai_findings', 'assignee', 'TEXT');
        this._ensureColumn('ai_findings', 'due', 'TEXT');
        this.db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, role TEXT, email TEXT)');
        this.db.exec('CREATE TABLE IF NOT EXISTS discussions (id TEXT PRIMARY KEY, element_id TEXT, room_id TEXT, title TEXT, status TEXT, author TEXT, created_at TEXT, comments TEXT)');
      } },
      { v: 5, up: () => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS section_presets (
          project_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL,
          source_json TEXT NOT NULL, params_json TEXT NOT NULL, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, PRIMARY KEY(project_id, id)
        )`);
        this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_section_presets_project_name ON section_presets(project_id, name_key)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_section_presets_project_updated ON section_presets(project_id, updated_at)');
      } },
      { v: 6, up: () => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS project_states (
          project_id TEXT PRIMARY KEY NOT NULL,
          schema_version INTEGER NOT NULL,
          generation INTEGER NOT NULL,
          history_revision INTEGER NOT NULL,
          payload_hash TEXT NOT NULL,
          record_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS operation_journal (
          id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          parameters_json TEXT NOT NULL,
          input_hash TEXT,
          output_json TEXT NOT NULL,
          warnings_json TEXT NOT NULL,
          app_version TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`);
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_operation_journal_project_time ON operation_journal(project_id, created_at)');
      } },
    ];
    let cur = this._schemaVersion();
    for (const m of migrations) {
      if (cur < m.v) {
        this.db.transaction(m.up)();
        this._setSchemaVersion(m.v);
        cur = m.v;
      }
    }
  }
  _activeProjectId() {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='activeProjectId'").get();
    let id = null; if (row) { try { id = JSON.parse(row.value); } catch (e) { id = row.value; } }
    if (id && this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(id)) return id;
    const first = this.db.prepare('SELECT id FROM projects LIMIT 1').get();
    return first ? first.id : null;
  }

  getData() {
    const activeId = this._activeProjectId();
    const project = (activeId && this.db.prepare('SELECT * FROM projects WHERE id=?').get(activeId)) || this.db.prepare('SELECT * FROM projects LIMIT 1').get() || {};
    const floors = project.id ? this.db.prepare('SELECT * FROM floors WHERE project_id=? ORDER BY number').all(project.id) : [];
    const floorIds = floors.map(f => f.id);
    const roomRows = floorIds.length ? this.db.prepare(`SELECT * FROM rooms WHERE floor_id IN (${floorIds.map(() => '?').join(',')})`).all(...floorIds) : [];
    const roomIds = roomRows.map(r => r.id);
    // Пакетная загрузка (устранение N+1): один запрос на тип сущности вместо запроса на каждое помещение.
    const _in = (ids) => `(${ids.map(() => '?').join(',')})`;
    const elementRows = roomIds.length ? this.db.prepare(`SELECT * FROM elements WHERE room_id IN ${_in(roomIds)}`).all(...roomIds) : [];
    const documentRows = roomIds.length ? this.db.prepare(`SELECT * FROM documents WHERE room_id IN ${_in(roomIds)}`).all(...roomIds) : [];
    const elIds = elementRows.map(e => e.id);
    const docIds = documentRows.map(d => d.id);
    const findingRows = elIds.length ? this.db.prepare(`SELECT * FROM ai_findings WHERE element_id IN ${_in(elIds)}`).all(...elIds) : [];
    const versionRows = docIds.length ? this.db.prepare(`SELECT document_id,v,date FROM document_versions WHERE document_id IN ${_in(docIds)}`).all(...docIds) : [];
    const elementsByRoom = new Map();
    for (const e of elementRows) { const a = elementsByRoom.get(e.room_id) || elementsByRoom.set(e.room_id, []).get(e.room_id); a.push(e); }
    const versionsByDoc = new Map();
    for (const v of versionRows) { const a = versionsByDoc.get(v.document_id) || versionsByDoc.set(v.document_id, []).get(v.document_id); a.push({ v: v.v, date: v.date }); }
    const documentsByRoom = new Map();
    for (const d of documentRows) { d.versions = versionsByDoc.get(d.id) || []; const a = documentsByRoom.get(d.room_id) || documentsByRoom.set(d.room_id, []).get(d.room_id); a.push(d); }
    const findingsByEl = new Map();
    for (const f of findingRows) {
      f.review = f.review || 'open';
      try { f.comments = f.comments ? JSON.parse(f.comments) : []; } catch (e) { f.comments = []; }
      const a = findingsByEl.get(f.element_id) || findingsByEl.set(f.element_id, []).get(f.element_id); a.push(f);
    }
    const rooms = roomRows.map(r => {
      const room = Object.assign({}, r);
      room.elements = elementsByRoom.get(r.id) || [];
      room.documents = documentsByRoom.get(r.id) || [];
      room.findings = [];
      for (const e of room.elements) { const fs2 = findingsByEl.get(e.id); if (fs2) for (const f of fs2) room.findings.push(f); }
      if (r.model_file) room.model = { name: r.model_name, file: r.model_file, mime: r.model_mime };
      return room;
    });
    const users = this.db.prepare('SELECT * FROM users').all();
    const discussions = this.db.prepare('SELECT * FROM discussions').all().map(d => { try { d.comments = d.comments ? JSON.parse(d.comments) : []; } catch (e) { d.comments = []; } return d; });
    const sectionPresets = project.id ? this._listSectionPresetsForProject(project.id) : [];
    return { project, floors, rooms, users, discussions, sectionPresets };
  }

  updateProject(patch) {
    const activeId = this._activeProjectId();
    const p = (activeId && this.db.prepare('SELECT * FROM projects WHERE id=?').get(activeId)) || this.db.prepare('SELECT * FROM projects LIMIT 1').get(); if (!p) return null;
    const m = Object.assign({}, p, patch);
    this.db.prepare('UPDATE projects SET name=?,address=?,status=? WHERE id=?').run(m.name, m.address, m.status, p.id);
    return m;
  }

  createFloor(patch) {
    const activeId = this._activeProjectId();
    const p = (activeId && this.db.prepare('SELECT id FROM projects WHERE id=?').get(activeId)) || this.db.prepare('SELECT id FROM projects LIMIT 1').get();
    const cnt = p ? this.db.prepare('SELECT COUNT(*) c FROM floors WHERE project_id=?').get(p.id).c : 0;
    const f = Object.assign({ id: genId('floor'), project_id: p && p.id, number: cnt + 1, name: 'Новый этаж' }, patch || {});
    this.db.prepare('INSERT INTO floors(id,project_id,number,name) VALUES (?,?,?,?)').run(f.id, f.project_id, f.number, f.name);
    return f;
  }
  updateFloor(id, patch) {
    const f = this.db.prepare('SELECT * FROM floors WHERE id=?').get(id); if (!f) return null;
    const m = Object.assign({}, f, patch);
    this.db.prepare('UPDATE floors SET number=?,name=? WHERE id=?').run(m.number, m.name, id); return m;
  }
  deleteFloor(id) {
    const _tx = this.db.transaction((fid) => {
      const rooms = this.db.prepare('SELECT id FROM rooms WHERE floor_id=?').all(fid);
      for (const r of rooms) this.deleteRoom(r.id);
      this.db.prepare('DELETE FROM floors WHERE id=?').run(fid);
    });
    _tx(id); return { id };
  }

  createRoom(floorId, patch) {
    const r = Object.assign({ id: genId('room'), floor_id: floorId, name: 'Новое помещение', number: '', type: '', area_m2: 0, height_m: 3, material: '', cost: 0, status: 'проект' }, patch || {});
    this.db.prepare('INSERT INTO rooms(id,floor_id,name,number,type,area_m2,height_m,material,cost,status) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(r.id, r.floor_id, r.name, r.number, r.type, r.area_m2, r.height_m, r.material, r.cost, r.status);
    r.elements = []; r.documents = []; r.findings = []; return r;
  }
  updateRoom(id, patch) {
    const r = this.db.prepare('SELECT * FROM rooms WHERE id=?').get(id); if (!r) return null;
    const m = Object.assign({}, r, patch);
    this.db.prepare('UPDATE rooms SET name=?,number=?,type=?,area_m2=?,height_m=?,material=?,cost=?,status=? WHERE id=?')
      .run(m.name, m.number, m.type, m.area_m2, m.height_m, m.material, m.cost, m.status, id); return m;
  }
  deleteRoom(id) {
    const _tx = this.db.transaction((rid) => {
      const els = this.db.prepare('SELECT id FROM elements WHERE room_id=?').all(rid).map(e => e.id);
      if (els.length) this.db.prepare(`DELETE FROM ai_findings WHERE element_id IN (${els.map(() => '?').join(',')})`).run(...els);
      this.db.prepare('DELETE FROM elements WHERE room_id=?').run(rid);
      const docs = this.db.prepare('SELECT id FROM documents WHERE room_id=?').all(rid).map(d => d.id);
      if (docs.length) this.db.prepare(`DELETE FROM document_versions WHERE document_id IN (${docs.map(() => '?').join(',')})`).run(...docs);
      this.db.prepare('DELETE FROM documents WHERE room_id=?').run(rid);
      this.db.prepare('DELETE FROM rooms WHERE id=?').run(rid);
    });
    _tx(id); return { id };
  }

  createElement(roomId, patch) {
    const e = Object.assign({ id: genId('el'), room_id: roomId, ifc_guid: genId('guid'), type: 'оборудование', name: 'Новый элемент', ai_status: 'none' }, patch || {});
    this.db.prepare('INSERT INTO elements(id,room_id,ifc_guid,type,name,ai_status) VALUES (?,?,?,?,?,?)').run(e.id, roomId, e.ifc_guid, e.type, e.name, e.ai_status); return e;
  }
  updateElement(id, patch) {
    const e = this.db.prepare('SELECT * FROM elements WHERE id=?').get(id); if (!e) return null;
    const m = Object.assign({}, e, patch);
    this.db.prepare('UPDATE elements SET type=?,name=?,ai_status=? WHERE id=?').run(m.type, m.name, m.ai_status, id); return m;
  }
  deleteElement(id) {
    this.db.prepare('DELETE FROM ai_findings WHERE element_id=?').run(id);
    this.db.prepare('UPDATE documents SET element_id=NULL WHERE element_id=?').run(id);
    this.db.prepare('DELETE FROM elements WHERE id=?').run(id); return { id };
  }

  createDocument(patch) {
    const d = Object.assign({ id: genId('doc'), room_id: null, element_id: null, type: 'документ', name: 'Без имени', version: 'v1', date: new Date().toISOString().slice(0, 10), author: '', file: '', mime: '', size: 0, is_upload: 0, created_at: new Date().toISOString() }, patch || {});
    this.db.prepare('INSERT INTO documents(id,room_id,element_id,type,name,version,date,author,file,mime,size,is_upload,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(d.id, d.room_id, d.element_id, d.type, d.name, d.version, d.date, d.author, d.file, d.mime, d.size, d.is_upload, d.created_at);
    d.versions = []; return d;
  }
  updateDocument(id, patch) {
    const d = this.db.prepare('SELECT * FROM documents WHERE id=?').get(id); if (!d) return null;
    const m = Object.assign({}, d, patch);
    this.db.prepare('UPDATE documents SET element_id=?,type=?,name=?,version=?,date=?,author=?,file=?,mime=?,size=? WHERE id=?')
      .run(m.element_id, m.type, m.name, m.version, m.date, m.author, m.file, m.mime, m.size, id); return m;
  }
  deleteDocument(id) {
    this.db.prepare('DELETE FROM document_versions WHERE document_id=?').run(id);
    this.db.prepare('DELETE FROM documents WHERE id=?').run(id); return { id };
  }

  attachModel(roomId, patch) {
    const p = patch || {};
    this.db.prepare('UPDATE rooms SET model_name=?,model_file=?,model_mime=? WHERE id=?').run(p.name || null, p.file || null, p.mime || null, roomId);
    return p;
  }
  getModelPath(roomId) {
    const r = this.db.prepare('SELECT model_file FROM rooms WHERE id=?').get(roomId);
    if (r && r.model_file) return path.isAbsolute(r.model_file) ? r.model_file : path.join(this.uploadsDir, r.model_file);
    return null;
  }

  // ---- findings & verification (Phase C) ----
  _recompute(roomId) {
    const els = this.db.prepare('SELECT id FROM elements WHERE room_id=?').all(roomId);
    const rank = { none: 0, ok: 1, warn: 2, err: 3 };
    for (const e of els) {
      const rows = this.db.prepare('SELECT severity,review FROM ai_findings WHERE element_id=?').all(e.id);
      let best = 'none';
      for (const f of rows) if ((f.review || 'open') !== 'rejected' && rank[f.severity] > rank[best]) best = f.severity;
      this.db.prepare('UPDATE elements SET ai_status=? WHERE id=?').run(best, e.id);
    }
  }
  setRoomFindings(roomId, findings) {
    const els = this.db.prepare('SELECT id FROM elements WHERE room_id=?').all(roomId).map(e => e.id);
    const tx = this.db.transaction(() => {
      if (els.length) this.db.prepare(`DELETE FROM ai_findings WHERE element_id IN (${els.map(() => '?').join(',')})`).run(...els);
      const ins = this.db.prepare('INSERT INTO ai_findings(id,element_id,document_id,kind,severity,confidence,text,review,source,comments,created_at,assignee,due) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const f of (findings || [])) ins.run(f.id, f.element_id, f.document_id || null, f.kind, f.severity, f.confidence, f.text, f.review || 'open', f.source || 'rule', JSON.stringify(f.comments || []), f.created_at || new Date().toISOString(), f.assignee || null, f.due || null);
      this._recompute(roomId);
    });
    tx();
    const room = this.getData().rooms.find(r => r.id === roomId);
    return room ? room.findings : [];
  }
  updateFinding(id, patch) {
    const f = this.db.prepare('SELECT * FROM ai_findings WHERE id=?').get(id); if (!f) return null;
    const m = Object.assign({}, f, patch || {});
    const comments = typeof m.comments === 'string' ? m.comments : JSON.stringify(m.comments || []);
    this.db.prepare('UPDATE ai_findings SET kind=?,severity=?,confidence=?,text=?,review=?,source=?,comments=?,assignee=?,due=? WHERE id=?')
      .run(m.kind, m.severity, m.confidence, m.text, m.review || 'open', m.source || 'rule', comments, m.assignee || null, m.due || null, id);
    const el = this.db.prepare('SELECT room_id FROM elements WHERE id=?').get(f.element_id);
    if (el) this._recompute(el.room_id);
    const out = this.db.prepare('SELECT * FROM ai_findings WHERE id=?').get(id);
    try { out.comments = out.comments ? JSON.parse(out.comments) : []; } catch (e) { out.comments = []; }
    return out;
  }
  addFindingComment(id, comment) {
    const f = this.db.prepare('SELECT * FROM ai_findings WHERE id=?').get(id); if (!f) return null;
    let arr = []; try { arr = f.comments ? JSON.parse(f.comments) : []; } catch (e) { arr = []; }
    arr.push({ text: String(comment || ''), at: new Date().toISOString() });
    this.db.prepare('UPDATE ai_findings SET comments=? WHERE id=?').run(JSON.stringify(arr), id);
    return arr;
  }

  // ---- settings (Phase C) ----
  getSettings() {
    const rows = this.db.prepare('SELECT key,value FROM settings').all();
    const out = {};
    for (const r of rows) { try { out[r.key] = JSON.parse(r.value); } catch (e) { out[r.key] = r.value; } }
    return out;
  }
  updateSettings(patch) {
    const up = this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for (const k in (patch || {})) up.run(k, JSON.stringify(patch[k]));
    return this.getSettings();
  }

  // ---- project-scoped saved section presets ----
  _decodeSectionPreset(row) {
    try {
      return SectionPresets.normalizePreset({
        id: row.id,
        name: row.name,
        source: JSON.parse(row.source_json),
        params: JSON.parse(row.params_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }, {
        id: row.id,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
    } catch (e) {
      return null;
    }
  }
  _listSectionPresetsForProject(projectId) {
    if (!projectId) return [];
    return this.db.prepare('SELECT * FROM section_presets WHERE project_id=? ORDER BY updated_at DESC, name_key ASC')
      .all(projectId).map(row => this._decodeSectionPreset(row)).filter(Boolean);
  }
  listSectionPresets() {
    return this._listSectionPresetsForProject(this._activeProjectId());
  }
  _saveSectionPresetForProject(projectId, draft, restore) {
    if (!projectId || !this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) {
      throw new Error('Не удалось определить активный проект');
    }
    const clean = SectionPresets.normalizeDraft(draft);
    const key = SectionPresets.nameKey(clean.name);
    const byName = this.db.prepare('SELECT * FROM section_presets WHERE project_id=? AND name_key=?').get(projectId, key);
    const byId = restore && restore.id
      ? this.db.prepare('SELECT * FROM section_presets WHERE project_id=? AND id=?').get(projectId, restore.id)
      : null;
    const existing = byName || byId || null;
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM section_presets WHERE project_id=?').get(projectId).n;
    if (!existing && count >= SectionPresets.MAX_SECTION_PRESETS) {
      throw new RangeError('Достигнут лимит сохранённых сечений для проекта (100)');
    }
    const now = new Date().toISOString();
    const preserveTimes = !!(restore && restore.preserveTimestamps);
    const preset = SectionPresets.normalizePreset(clean, {
      id: existing && existing.id || (restore && restore.id) || genId('section'),
      createdAt: existing && existing.created_at || (preserveTimes && restore.createdAt) || now,
      updatedAt: preserveTimes && restore.updatedAt || now,
      now
    });
    const values = [
      preset.name, SectionPresets.nameKey(preset.name), JSON.stringify(preset.source),
      JSON.stringify(preset.params), preset.createdAt, preset.updatedAt
    ];
    if (existing) {
      this.db.prepare('UPDATE section_presets SET name=?, name_key=?, source_json=?, params_json=?, created_at=?, updated_at=? WHERE project_id=? AND id=?')
        .run(...values, projectId, preset.id);
    } else {
      this.db.prepare('INSERT INTO section_presets(project_id,id,name,name_key,source_json,params_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(projectId, preset.id, ...values);
    }
    return { ok: true, replaced: !!existing, preset };
  }
  saveSectionPreset(draft) {
    return this._saveSectionPresetForProject(this._activeProjectId(), draft);
  }
  deleteSectionPreset(id) {
    if (typeof id !== 'string' || !id) throw new TypeError('Preset ID is required');
    const projectId = this._activeProjectId();
    if (!projectId) throw new Error('Не удалось определить активный проект');
    const result = this.db.prepare('DELETE FROM section_presets WHERE project_id=? AND id=?').run(projectId, id);
    return { id, deleted: result.changes > 0 };
  }

  // ---- projects (Phase D1) ----
  _projectRoomCount(pid) {
    const fids = this.db.prepare('SELECT id FROM floors WHERE project_id=?').all(pid).map(f => f.id);
    if (!fids.length) return 0;
    return this.db.prepare(`SELECT COUNT(*) c FROM rooms WHERE floor_id IN (${fids.map(() => '?').join(',')})`).get(...fids).c;
  }
  listProjects() {
    const active = this._activeProjectId();
    return this.db.prepare('SELECT * FROM projects').all().map(p => ({ id: p.id, name: p.name, address: p.address, status: p.status, rooms: this._projectRoomCount(p.id), active: p.id === active }));
  }
  createProject(patch) {
    const id = genId('prj'); const p = Object.assign({ id, name: 'Новый проект', address: '', status: 'проект' }, patch || {});
    this.db.prepare('INSERT INTO projects(id,name,address,status) VALUES (?,?,?,?)').run(p.id, p.name, p.address, p.status);
    this.db.prepare('INSERT INTO floors(id,project_id,number,name) VALUES (?,?,?,?)').run(genId('floor'), id, 1, 'Этаж 1');
    this.updateSettings({ activeProjectId: id }); return p;
  }
  switchProject(id) { if (this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(id)) this.updateSettings({ activeProjectId: id }); return this.db.prepare('SELECT * FROM projects WHERE id=?').get(id); }
  deleteProject(id) {
    const others = this.db.prepare('SELECT id FROM projects WHERE id<>?').all(id).map(p => p.id);
    if (!others.length) return { error: 'last_project' };
    const fids = this.db.prepare('SELECT id FROM floors WHERE project_id=?').all(id).map(f => f.id);
    for (const fid of fids) { const rids = this.db.prepare('SELECT id FROM rooms WHERE floor_id=?').all(fid).map(r => r.id); for (const rid of rids) this.deleteRoom(rid); }
    this.db.prepare('DELETE FROM section_presets WHERE project_id=?').run(id);
    this.db.prepare('DELETE FROM project_states WHERE project_id=?').run(id);
    this.db.prepare('DELETE FROM operation_journal WHERE project_id=?').run(id);
    this.db.prepare('DELETE FROM floors WHERE project_id=?').run(id);
    this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
    if (this._activeProjectId() === id) this.updateSettings({ activeProjectId: others[0] });
    this.projectAssets.deleteProject(id);
    return { id };
  }

  // ---- versioned project state, revisions and operation journal (Stage 2) ----
  _projectStateId(projectId) {
    const id = projectId || this._activeProjectId();
    if (typeof id !== 'string' || !id || !this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(id)) {
      throw new Error('project not found: ' + String(id || ''));
    }
    return id;
  }
  _readProjectStateRecord(projectId) {
    const id = this._projectStateId(projectId);
    const row = this.db.prepare('SELECT record_json FROM project_states WHERE project_id=?').get(id);
    if (!row) return ProjectState.createProjectStateRecord(id);
    let raw;
    try { raw = JSON.parse(row.record_json); }
    catch (e) { throw new Error('project state record is corrupt for ' + id + ': ' + e.message); }
    return ProjectState.normalizeProjectStateRecord(id, raw);
  }
  _writeProjectStateRecord(record) {
    this.db.prepare(`INSERT OR REPLACE INTO project_states
      (project_id,schema_version,generation,history_revision,payload_hash,record_json,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(
      record.projectId, record.schemaVersion, record.generation, record.revision,
      record.payloadHash, JSON.stringify(record), record.updatedAt
    );
  }
  _projectStateView(record) {
    return {
      ok: true,
      projectId: record.projectId,
      schemaVersion: record.schemaVersion,
      revision: record.generation,
      historyRevision: record.revision,
      cursor: record.cursor,
      payload: ProjectState.cloneJsonSafe(record.payload, 'project state'),
      payloadHash: record.payloadHash,
      canUndo: record.cursor > 0,
      canRedo: record.cursor < record.history.length - 1,
      updatedAt: record.updatedAt
    };
  }
  getProjectState(projectId) {
    return this._projectStateView(this._readProjectStateRecord(projectId));
  }
  _insertOperation(projectId, draft, appVersion) {
    const entry = ProjectState.makeOperation(projectId, draft, { appVersion });
    this.db.prepare(`INSERT OR REPLACE INTO operation_journal
      (id,project_id,operation,parameters_json,input_hash,output_json,warnings_json,app_version,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      entry.id, entry.projectId, entry.operation, JSON.stringify(entry.parameters),
      entry.inputHash, JSON.stringify(entry.output), JSON.stringify(entry.warnings),
      entry.appVersion, entry.createdAt
    );
    const excess = this.db.prepare('SELECT COUNT(*) c FROM operation_journal WHERE project_id=?').get(projectId).c - ProjectState.MAX_OPERATION_ENTRIES;
    if (excess > 0) this.db.prepare(`DELETE FROM operation_journal WHERE id IN (
      SELECT id FROM operation_journal WHERE project_id=? ORDER BY created_at ASC,id ASC LIMIT ?
    )`).run(projectId, excess);
    return entry;
  }
  saveProjectState(payload, options) {
    options = options || {};
    const id = this._projectStateId(options.projectId);
    const tx = this.db.transaction(() => {
      const before = this._readProjectStateRecord(id);
      const result = ProjectState.commitProjectState(before, id, payload, options);
      if (!result.changed) return Object.assign(this._projectStateView(result.record), { changed: false });
      this._writeProjectStateRecord(result.record);
      const operation = options.operation || { operation: 'project.state.update' };
      this._insertOperation(id, Object.assign({}, operation, {
        inputHash: operation.inputHash || before.payloadHash,
        output: operation.output || { revision: result.record.revision, stateHash: result.record.payloadHash }
      }), options.appVersion);
      return Object.assign(this._projectStateView(result.record), { changed: true });
    });
    return tx();
  }
  _moveProjectState(direction, options) {
    options = options || {};
    const id = this._projectStateId(options.projectId);
    const tx = this.db.transaction(() => {
      const before = this._readProjectStateRecord(id);
      const result = ProjectState.moveProjectStateHistory(before, id, direction, options);
      if (!result.changed) return { ok: false, error: result.error, projectId: id, revision: before.generation, canUndo: before.cursor > 0, canRedo: before.cursor < before.history.length - 1 };
      this._writeProjectStateRecord(result.record);
      this._insertOperation(id, {
        operation: 'project.' + direction,
        inputHash: before.payloadHash,
        parameters: { fromRevision: before.revision, toRevision: result.record.revision },
        output: { revision: result.record.revision, stateHash: result.record.payloadHash }
      }, options.appVersion);
      return Object.assign(this._projectStateView(result.record), { changed: true });
    });
    return tx();
  }
  undoProjectState(options) { return this._moveProjectState('undo', options); }
  redoProjectState(options) { return this._moveProjectState('redo', options); }
  listProjectRevisions(projectId) {
    const id = this._projectStateId(projectId);
    return ProjectState.revisionList(this._readProjectStateRecord(id), id);
  }
  recordOperation(draft, projectId) {
    const id = this._projectStateId(projectId || (draft && draft.projectId));
    const entry = this._insertOperation(id, draft, draft && draft.appVersion);
    return { ok: true, operation: entry };
  }
  listOperations(limit, projectId) {
    const id = projectId == null ? null : this._projectStateId(projectId);
    const n = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Number(limit) | 0)) : 100;
    const rows = id
      ? this.db.prepare('SELECT * FROM operation_journal WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(id, n)
      : this.db.prepare('SELECT * FROM operation_journal ORDER BY created_at DESC,id DESC LIMIT ?').all(n);
    return rows.map(row => ({
      id: row.id, projectId: row.project_id, operation: row.operation,
      parameters: JSON.parse(row.parameters_json), inputHash: row.input_hash,
      output: JSON.parse(row.output_json), warnings: JSON.parse(row.warnings_json),
      appVersion: row.app_version, createdAt: row.created_at
    }));
  }

  // ---- users & roles (Phase D2) ----
  listUsers() { return this.db.prepare('SELECT * FROM users').all(); }
  createUser(patch) { const u = Object.assign({ id: genId('user'), name: 'Новый участник', role: 'Инженер', email: '' }, patch || {}); this.db.prepare('INSERT INTO users(id,name,role,email) VALUES (?,?,?,?)').run(u.id, u.name, u.role, u.email); return u; }
  updateUser(id, patch) { const u = this.db.prepare('SELECT * FROM users WHERE id=?').get(id); if (!u) return null; const m = Object.assign({}, u, patch); this.db.prepare('UPDATE users SET name=?,role=?,email=? WHERE id=?').run(m.name, m.role, m.email, id); return m; }
  deleteUser(id) { this.db.prepare('DELETE FROM users WHERE id=?').run(id); this.db.prepare('UPDATE ai_findings SET assignee=NULL WHERE assignee=?').run(id); return { id }; }
  assignFinding(id, patch) { return this.updateFinding(id, patch || {}); }

  // ---- element discussions (Phase D3) ----
  listDiscussions(elementId) {
    const rows = elementId ? this.db.prepare('SELECT * FROM discussions WHERE element_id=?').all(elementId) : this.db.prepare('SELECT * FROM discussions').all();
    return rows.map(d => { try { d.comments = d.comments ? JSON.parse(d.comments) : []; } catch (e) { d.comments = []; } return d; });
  }
  createDiscussion(patch) {
    const d = Object.assign({ id: genId('disc'), element_id: null, room_id: null, title: 'Обсуждение', status: 'open', author: '', created_at: new Date().toISOString(), comments: [] }, patch || {});
    this.db.prepare('INSERT INTO discussions(id,element_id,room_id,title,status,author,created_at,comments) VALUES (?,?,?,?,?,?,?,?)').run(d.id, d.element_id, d.room_id, d.title, d.status, d.author, d.created_at, JSON.stringify(d.comments || []));
    return d;
  }
  addDiscussionComment(id, comment) {
    const d = this.db.prepare('SELECT * FROM discussions WHERE id=?').get(id); if (!d) return null;
    let arr = []; try { arr = d.comments ? JSON.parse(d.comments) : []; } catch (e) { arr = []; }
    arr.push({ author: (comment && comment.author) || '', text: String((comment && comment.text) != null ? comment.text : comment || ''), at: new Date().toISOString() });
    this.db.prepare('UPDATE discussions SET comments=? WHERE id=?').run(JSON.stringify(arr), id);
    d.comments = arr; return d;
  }
  setDiscussionStatus(id, status) { this.db.prepare('UPDATE discussions SET status=? WHERE id=?').run(status, id); return this.listDiscussions().find(x => x.id === id) || null; }
  deleteDiscussion(id) { this.db.prepare('DELETE FROM discussions WHERE id=?').run(id); return { id }; }

  // ---- workspace sync (Phase D5) ----
  exportWorkspace() {
    const projects = this.db.prepare('SELECT * FROM projects').all();
    const dump = { projects: [], users: this.listUsers(), discussions: this.listDiscussions(), settings: this.getSettings(), operationJournal: this.listOperations(2000) };
    for (const p of projects) {
      const floors = this.db.prepare('SELECT * FROM floors WHERE project_id=?').all(p.id);
      const fids = floors.map(f => f.id);
      const rooms = (fids.length ? this.db.prepare(`SELECT * FROM rooms WHERE floor_id IN (${fids.map(() => '?').join(',')})`).all(...fids) : []).map(r => {
        const room = Object.assign({}, r);
        room.elements = this.db.prepare('SELECT * FROM elements WHERE room_id=?').all(r.id);
        room.documents = this.db.prepare('SELECT * FROM documents WHERE room_id=?').all(r.id);
        const elIds = room.elements.map(e => e.id);
        room.findings = elIds.length ? this.db.prepare(`SELECT * FROM ai_findings WHERE element_id IN (${elIds.map(() => '?').join(',')})`).all(...elIds) : [];
        return room;
      });
      dump.projects.push({
        project: p, floors, rooms,
        sectionPresets: this._listSectionPresetsForProject(p.id),
        projectState: this._readProjectStateRecord(p.id)
      });
    }
    const projectStateRecords = dump.projects.map(bundle => ({ projectId: bundle.project.id, record: bundle.projectState }));
    return {
      format: 'bim-twin-workspace-backup',
      version: 6,
      storeSchemaVersion: 6,
      exportedAt: new Date().toISOString(),
      data: dump,
      projectAssets: this.projectAssets.exportAssets(projectStateRecords)
    };
  }
  importWorkspace(obj, opts) {
    const b = typeof obj === 'string' ? JSON.parse(obj) : obj; const data = b.data || b;
    const merge = !!(opts && opts.merge);
    this.projectAssets.importAssets(b.projectAssets || data.projectAssets || []);
    const V = merge ? 'INSERT OR REPLACE INTO' : 'INSERT INTO';
    const projects = data.projects || (data.project ? [{
      project: data.project, floors: data.floors, rooms: data.rooms,
      sectionPresets: data.sectionPresets || [],
      projectState: data.projectState || (data.projectStates && data.projectStates[data.project.id])
    }] : []);
    const tx = this.db.transaction(() => {
      if (!merge) for (const t of ['ai_findings', 'document_versions', 'documents', 'elements', 'rooms', 'floors', 'section_presets', 'project_states', 'operation_journal', 'projects', 'discussions', 'users']) this.db.prepare(`DELETE FROM ${t}`).run();
      for (const u of (data.users || [])) this.db.prepare(`${V} users(id,name,role,email) VALUES (?,?,?,?)`).run(u.id, u.name, u.role, u.email);
      for (const d of (data.discussions || [])) this.db.prepare(`${V} discussions(id,element_id,room_id,title,status,author,created_at,comments) VALUES (?,?,?,?,?,?,?,?)`).run(d.id, d.element_id, d.room_id, d.title, d.status || 'open', d.author, d.created_at, typeof d.comments === 'string' ? d.comments : JSON.stringify(d.comments || []));
      for (const bundle of projects) {
        const p = bundle.project;
        this.db.prepare(`${V} projects(id,name,address,status) VALUES (?,?,?,?)`).run(p.id, p.name, p.address, p.status);
        for (const preset of (bundle.sectionPresets || [])) {
          this._saveSectionPresetForProject(p.id, preset, {
            id: preset.id,
            createdAt: preset.createdAt,
            updatedAt: preset.updatedAt,
            preserveTimestamps: true
          });
        }
        for (const f of (bundle.floors || [])) this.db.prepare(`${V} floors(id,project_id,number,name) VALUES (?,?,?,?)`).run(f.id, f.project_id || p.id, f.number, f.name);
        for (const r of (bundle.rooms || [])) {
          this.db.prepare(`${V} rooms(id,floor_id,name,number,type,area_m2,height_m,material,cost,status,model_name,model_file,model_mime) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(r.id, r.floor_id, r.name, r.number, r.type, r.area_m2, r.height_m, r.material, r.cost, r.status, (r.model && r.model.name) || r.model_name || null, (r.model && r.model.file) || r.model_file || null, (r.model && r.model.mime) || r.model_mime || null);
          for (const e of (r.elements || [])) this.db.prepare(`${V} elements(id,room_id,ifc_guid,type,name,ai_status) VALUES (?,?,?,?,?,?)`).run(e.id, r.id, e.ifc_guid, e.type, e.name, e.ai_status || 'none');
          for (const d of (r.documents || [])) this.db.prepare(`${V} documents(id,room_id,element_id,type,name,version,date,author,file,mime,size,is_upload,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(d.id, r.id, d.element_id || null, d.type, d.name, d.version, d.date, d.author, d.file || '', d.mime || '', d.size || 0, d.is_upload || 0, d.created_at || null);
          for (const f of (r.findings || [])) this.db.prepare(`${V} ai_findings(id,element_id,document_id,kind,severity,confidence,text,review,source,comments,created_at,assignee,due) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(f.id, f.element_id, f.document_id || null, f.kind, f.severity, f.confidence, f.text, f.review || 'open', f.source || 'rule', typeof f.comments === 'string' ? f.comments : JSON.stringify(f.comments || []), f.created_at || null, f.assignee || null, f.due || null);
        }
        const rawState = bundle.projectState || (data.projectStates && data.projectStates[p.id]);
        if (rawState) this._writeProjectStateRecord(ProjectState.normalizeProjectStateRecord(p.id, rawState));
      }
      for (const op of (data.operationJournal || data.operations || [])) {
        const opPid = op && op.projectId;
        if (opPid && projects.some(bundle => bundle.project.id === opPid)) this._insertOperation(opPid, op, op.appVersion);
      }
      if (data.settings && typeof data.settings === 'object') {
        for (const key of Object.keys(data.settings)) {
          this.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(key, JSON.stringify(data.settings[key]));
        }
      }
    });
    tx();
    if (!merge && projects[0]) this.updateSettings({ activeProjectId: projects[0].project.id });
    return this.getData();
  }

  // Бэкап всего рабочего пространства (все проекты), а не только активного.
  exportBackup() {
    const body = this.exportWorkspace();
    body.checksum = { algorithm: 'sha256', digest: ProjectState.hashJson(body) };
    return JSON.stringify(body, null, 2);
  }
  importBackup(json) {
    const obj = typeof json === 'string' ? JSON.parse(json) : json;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new TypeError('invalid backup');
    if (obj.checksum && obj.checksum.algorithm === 'sha256') {
      const body = Object.assign({}, obj); delete body.checksum;
      if (ProjectState.hashJson(body) !== obj.checksum.digest) throw new Error('backup checksum mismatch');
    }
    return this.importWorkspace(obj);
  }
}

module.exports = { SqliteStore, genId };
