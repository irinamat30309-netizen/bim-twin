/*
 * JsonStore — постоянное JSON-хранилище (работает всегда, без нативных зависимостей).
 * Единый API с SqliteStore. Данные — вложенный граф {project,floors,rooms[]}.
 */
const fs = require('fs');
const path = require('path');
const { buildData } = require('./loadData');
const SectionPresets = require('./sectionPresets');
const { atomicWriteJsonSync } = require('./atomic-file');
const ProjectState = require('./project-state');
const { ProjectAssetStore } = require('./project-assets');

const STORE_SCHEMA_VERSION = 2;

function genId(prefix) { return prefix + '_' + Math.random().toString(36).slice(2, 9); }
function cloneData(value) { return JSON.parse(JSON.stringify(value)); }

class JsonStore {
  constructor(dir) {
    this.dir = dir;
    this.storePath = path.join(dir, 'store.json');
    this.uploadsDir = path.join(dir, 'uploads');
    this.projectAssets = new ProjectAssetStore(dir);
    this.mode = 'json';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.uploadsDir)) fs.mkdirSync(this.uploadsDir, { recursive: true });
    this._load();
  }

  _migrateData(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('store root must be an object');
    const data = cloneData(raw);
    const version = Number.isInteger(data.storeSchemaVersion) ? data.storeSchemaVersion : 0;
    if (version > STORE_SCHEMA_VERSION) {
      const err = new RangeError('Хранилище создано более новой версией BIM Twin (' + version + ')');
      err.code = 'UNSUPPORTED_STORE_VERSION';
      throw err;
    }
    if (version < 1) {
      data.projectsArchive = data.projectsArchive || {};
      data.sectionPresets = Array.isArray(data.sectionPresets) ? data.sectionPresets : [];
      data.settings = data.settings || {};
      data.users = Array.isArray(data.users) ? data.users : [];
      data.discussions = Array.isArray(data.discussions) ? data.discussions : [];
    }
    if (version < 2) {
      data.projectStates = data.projectStates && typeof data.projectStates === 'object' ? data.projectStates : {};
      data.operationJournal = Array.isArray(data.operationJournal) ? data.operationJournal : [];
      data.backupIntegrity = 'sha256';
    }
    data.storeSchemaVersion = STORE_SCHEMA_VERSION;
    return { data, migrated: version !== STORE_SCHEMA_VERSION };
  }

  _readCandidate(file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return this._migrateData(raw);
  }

  _load() {
    const backupPath = this.storePath + '.bak';
    let primaryError = null;
    if (fs.existsSync(this.storePath)) {
      try {
        const candidate = this._readCandidate(this.storePath);
        this.data = candidate.data;
        this._ensureCollections();
        this._durableData = cloneData(this.data);
        if (candidate.migrated) this._save();
        this._cleanupStaleTemps();
        return;
      } catch (e) {
        if (e && e.code === 'UNSUPPORTED_STORE_VERSION') throw e;
        primaryError = e;
      }
    }
    if (fs.existsSync(backupPath)) {
      try {
        const candidate = this._readCandidate(backupPath);
        if (fs.existsSync(this.storePath) && primaryError) {
          const quarantine = this.storePath + '.corrupt-' + Date.now();
          fs.renameSync(this.storePath, quarantine);
        }
        this.data = candidate.data;
        this._ensureCollections();
        this._durableData = cloneData(this.data);
        // Preserve the known-good backup while restoring the primary file.
        this._save({ skipBackup: true });
        this._cleanupStaleTemps();
        return;
      } catch (backupError) {
        if (backupError && backupError.code === 'UNSUPPORTED_STORE_VERSION') throw backupError;
        const err = new Error('Не удалось открыть store.json или резервную копию; исходные файлы сохранены. ' +
          'Основная ошибка: ' + String(primaryError && primaryError.message || 'файл отсутствует') +
          '; резервная копия: ' + String(backupError && backupError.message || backupError));
        err.code = 'STORE_CORRUPT';
        throw err;
      }
    }
    if (primaryError) {
      const err = new Error('store.json повреждён; файл не был перезаписан. ' + String(primaryError.message || primaryError));
      err.code = 'STORE_CORRUPT';
      throw err;
    }
    this.data = buildData();
    this._ensureCollections();
    this._durableData = cloneData(this.data);
    this._save();
  }
  _cleanupStaleTemps() {
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.startsWith('.store.json.tmp-')) continue;
        try { fs.unlinkSync(path.join(this.dir, name)); } catch (_) {}
      }
    } catch (_) {}
  }
  _ensureCollections() {
    this.data.storeSchemaVersion = STORE_SCHEMA_VERSION;
    this.data.settings = this.data.settings || {};
    this.data.users = this.data.users || [];
    this.data.discussions = this.data.discussions || [];
    this.data.projectsArchive = this.data.projectsArchive || {};
    this.data.sectionPresets = Array.isArray(this.data.sectionPresets) ? this.data.sectionPresets : [];
    this.data.projectStates = this.data.projectStates && typeof this.data.projectStates === 'object' ? this.data.projectStates : {};
    this.data.operationJournal = Array.isArray(this.data.operationJournal) ? this.data.operationJournal : [];
    for (const bundle of Object.values(this.data.projectsArchive)) {
      if (bundle && typeof bundle === 'object') {
        bundle.sectionPresets = Array.isArray(bundle.sectionPresets) ? bundle.sectionPresets : [];
      }
    }
  }
  _save(options) {
    options = options || {};
    const previous = this._durableData || null;
    try {
      const data = cloneData(this.data);
      const saveOptions = options.skipBackup ? {} : { backupPath: this.storePath + '.bak' };
      atomicWriteJsonSync(this.storePath, data, saveOptions);
      this.data = data;
      this._durableData = cloneData(data);
      return true;
    } catch (e) {
      // Methods mutate a draft in memory before calling _save(). Restore the
      // last committed graph on any write/fsync/rename error.
      if (previous) this.data = cloneData(previous);
      throw e;
    }
  }

  // ---- lookups ----
  _room(id) { return this.data.rooms.find(r => r.id === id); }
  _roomOfElement(id) { return this.data.rooms.find(r => (r.elements || []).some(e => e.id === id)); }
  _roomOfDoc(id) { return this.data.rooms.find(r => (r.documents || []).some(d => d.id === id)); }

  getData() { return this.data; }

  updateProject(patch) { Object.assign(this.data.project, patch || {}); this._save(); return this.data.project; }

  // ---- floors ----
  createFloor(patch) {
    const f = Object.assign({ id: genId('floor'), project_id: this.data.project.id, number: (this.data.floors.length + 1), name: 'Новый этаж' }, patch || {});
    this.data.floors.push(f); this._save(); return f;
  }
  updateFloor(id, patch) { const f = this.data.floors.find(x => x.id === id); if (f) { Object.assign(f, patch); this._save(); } return f; }
  deleteFloor(id) {
    this.data.floors = this.data.floors.filter(f => f.id !== id);
    this.data.rooms = this.data.rooms.filter(r => r.floor_id !== id);
    this._save(); return { id };
  }

  // ---- rooms ----
  createRoom(floorId, patch) {
    const r = Object.assign({ id: genId('room'), floor_id: floorId, name: 'Новое помещение', number: '', type: '', area_m2: 0, height_m: 3, material: '', cost: 0, status: 'проект', elements: [], documents: [], findings: [] }, patch || {});
    r.elements = r.elements || []; r.documents = r.documents || []; r.findings = r.findings || [];
    this.data.rooms.push(r); this._save(); return r;
  }
  updateRoom(id, patch) { const r = this._room(id); if (r) { Object.assign(r, patch); this._save(); } return r; }
  deleteRoom(id) { this.data.rooms = this.data.rooms.filter(r => r.id !== id); this._save(); return { id }; }

  // ---- elements ----
  createElement(roomId, patch) {
    const r = this._room(roomId); if (!r) return null;
    const e = Object.assign({ id: genId('el'), ifc_guid: genId('guid'), type: 'оборудование', name: 'Новый элемент', ai_status: 'none' }, patch || {});
    r.elements = r.elements || []; r.elements.push(e); this._save(); return e;
  }
  updateElement(id, patch) { const r = this._roomOfElement(id); if (!r) return null; const e = r.elements.find(x => x.id === id); if (e) { Object.assign(e, patch); this._save(); } return e; }
  deleteElement(id) {
    const r = this._roomOfElement(id); if (!r) return { id };
    r.elements = r.elements.filter(e => e.id !== id);
    r.documents = (r.documents || []).map(d => (d.element_id === id ? Object.assign(d, { element_id: null }) : d));
    r.findings = (r.findings || []).filter(f => f.element_id !== id);
    this.data.discussions = (this.data.discussions || []).filter(d => d.element_id !== id);
    this._save(); return { id };
  }

  // ---- documents ----
  createDocument(patch) {
    const roomId = patch && patch.room_id;
    const r = this._room(roomId); if (!r) return null;
    const d = Object.assign({ id: genId('doc'), room_id: roomId, element_id: null, type: 'документ', name: 'Без имени', version: 'v1', date: new Date().toISOString().slice(0, 10), author: '', file: '', mime: '', size: 0, is_upload: 0, versions: [] }, patch || {});
    r.documents = r.documents || []; r.documents.push(d); this._save(); return d;
  }
  updateDocument(id, patch) { const r = this._roomOfDoc(id); if (!r) return null; const d = r.documents.find(x => x.id === id); if (d) { Object.assign(d, patch); this._save(); } return d; }
  deleteDocument(id) { const r = this._roomOfDoc(id); if (!r) return { id }; r.documents = r.documents.filter(d => d.id !== id); this._save(); return { id }; }

  // ---- model ----
  attachModel(roomId, patch) { const r = this._room(roomId); if (!r) return null; r.model = Object.assign({}, r.model || {}, patch || {}); this._save(); return r.model; }
  getModelPath(roomId) { const r = this._room(roomId); if (r && r.model && r.model.file) return path.isAbsolute(r.model.file) ? r.model.file : path.join(this.uploadsDir, r.model.file); return null; }

  // ---- findings & verification (Phase C) ----
  _findFinding(id) {
    for (const r of this.data.rooms) { const f = (r.findings || []).find(x => x.id === id); if (f) return { f, r }; }
    return null;
  }
  _recompute(room) {
    const rank = { none: 0, ok: 1, warn: 2, err: 3 };
    for (const e of (room.elements || [])) {
      let best = 'none';
      for (const f of (room.findings || [])) if (f.element_id === e.id && f.review !== 'rejected' && rank[f.severity] > rank[best]) best = f.severity;
      e.ai_status = best;
    }
  }
  setRoomFindings(roomId, findings) {
    const r = this._room(roomId); if (!r) return null;
    r.findings = (findings || []).slice();
    this._recompute(r); this._save(); return r.findings;
  }
  updateFinding(id, patch) { const hit = this._findFinding(id); if (!hit) return null; Object.assign(hit.f, patch || {}); this._recompute(hit.r); this._save(); return hit.f; }
  addFindingComment(id, comment) {
    const hit = this._findFinding(id); if (!hit) return null;
    hit.f.comments = hit.f.comments || [];
    hit.f.comments.push({ text: String(comment || ''), at: new Date().toISOString() });
    this._save(); return hit.f;
  }

  // ---- settings (Phase C) ----
  getSettings() { return this.data.settings || {}; }
  updateSettings(patch) { this.data.settings = Object.assign({}, this.data.settings || {}, patch || {}); this._save(); return this.data.settings; }

  // ---- project-scoped saved section presets ----
  listSectionPresets() {
    return (this.data.sectionPresets || [])
      .slice()
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || SectionPresets.nameKey(a.name).localeCompare(SectionPresets.nameKey(b.name)))
      .map(SectionPresets.clone);
  }
  saveSectionPreset(draft) {
    const normalized = SectionPresets.normalizeDraft(draft);
    const items = this.data.sectionPresets || (this.data.sectionPresets = []);
    const key = SectionPresets.nameKey(normalized.name);
    const index = items.findIndex(item => SectionPresets.nameKey(item && item.name) === key);
    const existing = index >= 0 ? items[index] : null;
    if (!existing && items.length >= SectionPresets.MAX_SECTION_PRESETS) {
      throw new RangeError('Достигнут лимит сохранённых сечений для проекта (100)');
    }
    const now = new Date().toISOString();
    const preset = SectionPresets.normalizePreset(normalized, {
      id: existing && existing.id || genId('section'),
      createdAt: existing && existing.createdAt || now,
      updatedAt: now,
      now
    });
    if (index >= 0) items[index] = preset;
    else items.push(preset);
    this._save();
    return { ok: true, replaced: !!existing, preset: SectionPresets.clone(preset) };
  }
  deleteSectionPreset(id) {
    if (typeof id !== 'string' || !id) throw new TypeError('Preset ID is required');
    const items = this.data.sectionPresets || [];
    const before = items.length;
    this.data.sectionPresets = items.filter(item => item.id !== id);
    const deleted = this.data.sectionPresets.length !== before;
    if (deleted) this._save();
    return { id, deleted };
  }

  // ---- projects (Phase D1) ----
  _archiveActive() {
    this.data.projectsArchive = this.data.projectsArchive || {};
    this.data.projectsArchive[this.data.project.id] = {
      project: this.data.project, floors: this.data.floors, rooms: this.data.rooms,
      sectionPresets: this.data.sectionPresets || []
    };
  }
  listProjects() {
    const list = [{ id: this.data.project.id, name: this.data.project.name, address: this.data.project.address, status: this.data.project.status, rooms: (this.data.rooms || []).length, active: true }];
    for (const id in (this.data.projectsArchive || {})) {
      const b = this.data.projectsArchive[id];
      list.push({ id: b.project.id, name: b.project.name, address: b.project.address, status: b.project.status, rooms: (b.rooms || []).length, active: false });
    }
    return list;
  }
  createProject(patch) {
    this._archiveActive();
    const id = genId('prj'); const floorId = genId('floor');
    this.data.project = Object.assign({ id, name: 'Новый проект', address: '', status: 'проект' }, patch || {});
    this.data.floors = [{ id: floorId, project_id: id, number: 1, name: 'Этаж 1' }];
    this.data.rooms = [];
    this.data.sectionPresets = [];
    this._save(); return this.data.project;
  }
  switchProject(id) {
    if (!id || id === this.data.project.id) return this.data.project;
    const target = (this.data.projectsArchive || {})[id]; if (!target) return null;
    this._archiveActive();
    delete this.data.projectsArchive[id];
    this.data.project = target.project; this.data.floors = target.floors; this.data.rooms = target.rooms;
    this.data.sectionPresets = Array.isArray(target.sectionPresets) ? target.sectionPresets : [];
    this._save(); return this.data.project;
  }
  deleteProject(id) {
    if (id === this.data.project.id) {
      const ids = Object.keys(this.data.projectsArchive || {});
      if (!ids.length) return { error: 'last_project' };
      this.switchProject(ids[0]);
    }
    delete this.data.projectsArchive[id];
    delete this.data.projectStates[id];
    this.data.operationJournal = this.data.operationJournal.filter(op => op.projectId !== id);
    this._save();
    this.projectAssets.deleteProject(id);
    return { id };
  }

  // ---- users & roles (Phase D2) ----
  listUsers() { return this.data.users || []; }
  createUser(patch) { const u = Object.assign({ id: genId('user'), name: 'Новый участник', role: 'Инженер', email: '' }, patch || {}); this.data.users.push(u); this._save(); return u; }
  updateUser(id, patch) { const u = this.data.users.find(x => x.id === id); if (u) { Object.assign(u, patch); this._save(); } return u; }
  deleteUser(id) {
    this.data.users = this.data.users.filter(u => u.id !== id);
    for (const r of this.data.rooms) for (const f of (r.findings || [])) if (f.assignee === id) f.assignee = null;
    this._save(); return { id };
  }
  assignFinding(id, patch) { return this.updateFinding(id, patch || {}); }

  // ---- element discussions (Phase D3) ----
  listDiscussions(elementId) { return (this.data.discussions || []).filter(d => !elementId || d.element_id === elementId); }
  createDiscussion(patch) {
    const d = Object.assign({ id: genId('disc'), element_id: null, room_id: null, title: 'Обсуждение', status: 'open', author: '', created_at: new Date().toISOString(), comments: [] }, patch || {});
    this.data.discussions.push(d); this._save(); return d;
  }
  addDiscussionComment(id, comment) {
    const d = (this.data.discussions || []).find(x => x.id === id); if (!d) return null;
    d.comments = d.comments || [];
    d.comments.push({ author: (comment && comment.author) || '', text: String((comment && comment.text) != null ? comment.text : comment || ''), at: new Date().toISOString() });
    this._save(); return d;
  }
  setDiscussionStatus(id, status) { const d = (this.data.discussions || []).find(x => x.id === id); if (!d) return null; d.status = status; this._save(); return d; }
  deleteDiscussion(id) { this.data.discussions = (this.data.discussions || []).filter(x => x.id !== id); this._save(); return { id }; }

  // ---- versioned project state, revisions and operation journal (Stage 2) ----
  _projectStateId(projectId) {
    const id = projectId || (this.data.project && this.data.project.id);
    if (typeof id !== 'string' || !id) throw new TypeError('projectId is required');
    const exists = id === (this.data.project && this.data.project.id) || !!(this.data.projectsArchive || {})[id];
    if (!exists) throw new Error('project not found: ' + id);
    return id;
  }
  _projectStateRecord(projectId) {
    const id = this._projectStateId(projectId);
    return ProjectState.normalizeProjectStateRecord(id, (this.data.projectStates || {})[id]);
  }
  _projectStateView(record) {
    return {
      ok: true,
      projectId: record.projectId,
      schemaVersion: record.schemaVersion,
      revision: record.generation,
      historyRevision: record.revision,
      cursor: record.cursor,
      payload: cloneData(record.payload),
      payloadHash: record.payloadHash,
      canUndo: record.cursor > 0,
      canRedo: record.cursor < record.history.length - 1,
      updatedAt: record.updatedAt
    };
  }
  getProjectState(projectId) {
    const id = this._projectStateId(projectId);
    return this._projectStateView(this._projectStateRecord(id));
  }
  _appendOperation(projectId, draft, defaults) {
    const entry = ProjectState.makeOperation(projectId, draft, defaults);
    this.data.operationJournal.push(entry);
    if (this.data.operationJournal.length > ProjectState.MAX_OPERATION_ENTRIES) {
      this.data.operationJournal.splice(0, this.data.operationJournal.length - ProjectState.MAX_OPERATION_ENTRIES);
    }
    return entry;
  }
  saveProjectState(payload, options) {
    options = options || {};
    const id = this._projectStateId(options.projectId);
    const before = this._projectStateRecord(id);
    const result = ProjectState.commitProjectState(before, id, payload, options);
    if (!result.changed) return Object.assign(this._projectStateView(result.record), { changed: false });
    this.data.projectStates[id] = result.record;
    const operation = options.operation || { operation: 'project.state.update' };
    this._appendOperation(id, Object.assign({}, operation, {
      inputHash: operation.inputHash || before.payloadHash,
      output: operation.output || { revision: result.record.revision, stateHash: result.record.payloadHash }
    }), { appVersion: options.appVersion });
    this._save();
    return Object.assign(this._projectStateView(result.record), { changed: true });
  }
  _moveProjectState(direction, options) {
    options = options || {};
    const id = this._projectStateId(options.projectId);
    const before = this._projectStateRecord(id);
    const result = ProjectState.moveProjectStateHistory(before, id, direction, options);
    if (!result.changed) return { ok: false, error: result.error, projectId: id, revision: before.generation, canUndo: before.cursor > 0, canRedo: before.cursor < before.history.length - 1 };
    this.data.projectStates[id] = result.record;
    this._appendOperation(id, {
      operation: 'project.' + direction,
      inputHash: before.payloadHash,
      parameters: { fromRevision: before.revision, toRevision: result.record.revision },
      output: { revision: result.record.revision, stateHash: result.record.payloadHash }
    }, { appVersion: options.appVersion });
    this._save();
    return Object.assign(this._projectStateView(result.record), { changed: true });
  }
  undoProjectState(options) { return this._moveProjectState('undo', options); }
  redoProjectState(options) { return this._moveProjectState('redo', options); }
  listProjectRevisions(projectId) {
    const id = this._projectStateId(projectId);
    return ProjectState.revisionList(this._projectStateRecord(id), id);
  }
  recordOperation(draft, projectId) {
    const id = this._projectStateId(projectId || (draft && draft.projectId));
    const entry = this._appendOperation(id, draft, {});
    this._save();
    return { ok: true, operation: cloneData(entry) };
  }
  listOperations(limit, projectId) {
    let id = projectId == null ? null : this._projectStateId(projectId);
    const n = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Number(limit) | 0)) : 100;
    return this.data.operationJournal.filter(op => !id || op.projectId === id).slice(-n).reverse().map(cloneData);
  }

  // ---- team sync bundle (Phase D5) ----
  exportWorkspace() {
    return {
      version: 6,
      exportedAt: new Date().toISOString(),
      data: cloneData(this.data),
      projectAssets: this.projectAssets.exportAssets(this.data.projectStates || {})
    };
  }
  importWorkspace(obj, opts) {
    const b = typeof obj === 'string' ? JSON.parse(obj) : obj; const incoming = b.data || b; opts = opts || {};
    this.projectAssets.importAssets(b.projectAssets || incoming.projectAssets || []);
    if (opts.merge) {
      const byId = (arr, x) => (arr || []).some(y => y.id === x.id);
      for (const u of (incoming.users || [])) if (!byId(this.data.users, u)) this.data.users.push(u);
      for (const d of (incoming.discussions || [])) if (!byId(this.data.discussions, d)) this.data.discussions.push(d);
      const inActive = incoming.project; const inArch = incoming.projectsArchive || {};
      const allIncoming = {}; if (inActive) allIncoming[inActive.id] = { project: inActive, floors: incoming.floors, rooms: incoming.rooms, sectionPresets: incoming.sectionPresets || [] };
      for (const k in inArch) allIncoming[k] = inArch[k];
      for (const k in allIncoming) {
        if (k === this.data.project.id) {
          for (const preset of (allIncoming[k].sectionPresets || [])) this.saveSectionPreset(preset);
        } else {
          this.data.projectsArchive[k] = allIncoming[k];
        }
      }
      this.data.settings = Object.assign({}, incoming.settings || {}, this.data.settings || {});
    } else {
      this.data = incoming; this._ensureCollections();
    }
    this._save(); return this.data;
  }

  // ---- backup ----
  exportBackup() {
    const body = Object.assign(this.exportWorkspace(), {
      format: 'bim-twin-workspace-backup',
      version: 5,
      storeSchemaVersion: STORE_SCHEMA_VERSION,
      data: cloneData(this.data)
    });
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
    const incoming = obj.data || obj;
    // Large classification label buffers live outside store.json. Import and
    // verify them before committing project-state references to the JSON store.
    this.projectAssets.importAssets(obj.projectAssets || incoming.projectAssets || []);
    const migrated = this._migrateData(incoming);
    this.data = migrated.data;
    this._ensureCollections();
    this._save();
    return this.data;
  }
}

module.exports = { JsonStore, genId, STORE_SCHEMA_VERSION };
