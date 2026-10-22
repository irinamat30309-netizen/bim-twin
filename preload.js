const { contextBridge, ipcRenderer, webUtils } = require('electron');

const inv = (ch, ...payload) => ipcRenderer.invoke(ch, ...payload);
const snd = (ch, ...payload) => ipcRenderer.send(ch, ...payload);

contextBridge.exposeInMainWorld('bimAPI', {
  platform: process.platform,
  getPathForFile: (file) => {
    try {
      const p = webUtils && file ? webUtils.getPathForFile(file) : '';
      if (!p) return '';
      return ipcRenderer.sendSync('bim:authorizePickedPath', p) === true ? p : '';
    } catch (_) { return ''; }
  },
  winMin: () => snd('bim:win:min'),
  winMax: () => snd('bim:win:max'),
  winClose: () => snd('bim:win:close'),
  getData: () => inv('bim:getData'),
  getMode: () => inv('bim:getMode'),
  readFile: (p) => inv('bim:readFile', p),
  readPicked: (p) => inv('bim:readPicked', p),
  parseCloud: (p, jobId, opts) => inv('bim:parseCloud', jobId ? Object.assign({ path: p, jobId, preview: !!(opts && opts.preview), allowReduced: !!(opts && opts.allowReduced) },
    opts && opts.pre && typeof opts.pre === 'object' ? { pre: true, filter: opts.pre.filter || null, maxPoints: Number(opts.pre.maxPoints) || 0, estimate: Number(opts.pre.estimate) || 0 } : {}) : p),
  readCloudChunk: (a) => inv('bim:readCloudChunk', a),
  cloudPartsOpen: (p, jobId, opts) => inv('bim:cloudPartsOpen', { path: p, jobId, maxPoints: opts && opts.maxPoints > 0 ? Number(opts.maxPoints) : 0,
    filter: opts && opts.filter && typeof opts.filter === 'object' ? opts.filter : null, estimate: opts && opts.estimate > 0 ? Number(opts.estimate) : 0, force: !!(opts && opts.force) }),
  // ревизия 27: карта облака до загрузки, мощность ПК, план из облака (DXF), PDF-отчёт, папка проекта, работа с файлом на месте
  systemCapacity: (opts) => inv('bim:systemCapacity', { refresh: !!(opts && opts.refresh), renderer: opts && typeof opts.renderer === 'string' ? opts.renderer : '' }),
  cloudOverview: (p, jobId, opts) => inv('bim:cloudOverview', { path: p, jobId: jobId || null, minPoints: opts && opts.minPoints > 0 ? Number(opts.minPoints) : 0 }),
  cancelCloudOverview: (jobId) => { if (typeof jobId === 'string' && jobId) snd('bim:cancelCloudOverview', { jobId }); },
  cloudPlan: (payload) => inv('bim:cloudPlan', payload || {}),
  cloudInspect: (payload) => inv('bim:cloudInspect', payload || {}),
  pickDxfText: () => inv('bim:pickDxfText', {}),
  findCleanCloud: (p) => inv('bim:findCleanCloud', { path: p }),
  onCloudPlanProgress: (jobId, callback) => {
    if (typeof jobId !== 'string' || typeof callback !== 'function' || typeof ipcRenderer.on !== 'function') return () => {};
    const listener = (_event, payload) => { if (!payload || payload.jobId !== jobId) return; try { callback(payload.progress, payload.label); } catch (_) {} };
    ipcRenderer.on('bim:cloudPlanProgress', listener);
    let active = true;
    return () => { if (!active) return; active = false; try { ipcRenderer.removeListener('bim:cloudPlanProgress', listener); } catch (_) {} };
  },
  saveReportPdf: (payload) => inv('bim:saveReportPdf', payload || {}),
  projectFolder: (action) => inv('bim:projectFolder', { action: action || 'get' }),
  grantWorkInPlace: (p) => inv('bim:grantWorkInPlace', { path: p }),
  cloudBackups: (payload) => inv('bim:cloudBackups', payload || {}),
  cloudPartsRead: (a) => inv('bim:cloudPartsRead', a),
  cloudPartsClose: (a) => inv('bim:cloudPartsClose', a),
  releaseCloud: (a) => inv('bim:releaseCloud', a),
  onCloudParseProgress: (jobId, callback) => {
    if (typeof jobId !== 'string' || typeof callback !== 'function' || typeof ipcRenderer.on !== 'function') return () => {};
    const listener = (_event, payload) => {
      if (!payload || payload.jobId !== jobId) return;
      try { callback(payload.progress); } catch (_) {}
    };
    ipcRenderer.on('bim:parseCloudProgress', listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      try { ipcRenderer.removeListener('bim:parseCloudProgress', listener); } catch (_) {}
    };
  },
  cancelCloudParse: (jobId) => {
    if (typeof jobId === 'string' && jobId) snd('bim:cancelCloudParse', { jobId });
  },
  potreeStatus: () => inv('bim:potreeStatus'),
  convertPotree: (p) => inv('bim:convertPotree', p),
  splatTransformStatus: () => inv('bim:splatTransformStatus'),
  convertSplat: (p) => inv('bim:convertSplat', p),
  cleanStatus: () => inv('bim:cleanStatus'),
  cleanCloud: (a) => inv('bim:cleanCloud', a),
  cleanAbort: () => inv('bim:cleanAbort'),
  // v1034: CloudCompare как готовый редактор
  ccStatus: () => inv('bim:ccStatus'),
  editInCloudCompare: (a) => inv('bim:editInCloudCompare', a),
  installCloudCompare: () => inv('bim:installCloudCompare'),
  downloadCloudCompare: () => inv('bim:downloadCloudCompare'),
  // v1041: CloudCompare, встроенный прямо в окно приложения (Windows)
  embedCloudCompare: (a) => inv('bim:embedCloudCompare', a),
  ccEmbedBounds: (a) => inv('bim:ccEmbedBounds', a),
  ccEmbedClose: () => inv('bim:ccEmbedClose'),
  ccFolder: () => inv('bim:ccFolder'),
  geomStatus: () => inv('bim:geomStatus'),
  s2bStatus: () => inv('bim:s2bStatus'),
  s2bAuth: () => inv('bim:s2bAuth'),
  s2bRestart: () => inv('bim:s2bRestart'),
  deviation: (a) => inv('bim:deviation', a),
  registerClouds: (a) => inv('bim:registerClouds', a),
  meshCloud: (a) => inv('bim:meshCloud', a),
  pdalRun: (a) => inv('bim:pdalRun', a),
  installPyDeps: () => inv('bim:installPyDeps'),
  readDocument: (docId) => inv('bim:readDocument', docId),
  openFile: (p) => inv('bim:openFile', p),
  saveCopy: (docId) => inv('bim:saveCopy', docId),
  convertDwg: (docId) => inv('bim:convertDwg', docId),
  saveDocument: (docId, base64) => inv('bim:saveDocument', docId, base64),
  ocrDocument: (docId) => inv('bim:ocrDocument', docId),
  ocrStatus: () => inv('bim:ocrStatus'),
  installOcr: () => inv('bim:installOcr'),
  getModelPath: (roomId) => inv('bim:getModelPath', roomId),

  importIFC: (a) => inv('bim:importIFC', a),

  uploadDocument: (a) => inv('bim:uploadDocument', a),
  uploadModel: (a) => inv('bim:uploadModel', a),

  updateProject: (patch) => inv('bim:updateProject', patch),
  createFloor: (patch) => inv('bim:createFloor', patch),
  updateFloor: (id, patch) => inv('bim:updateFloor', { id, patch }),
  deleteFloor: (id) => inv('bim:deleteFloor', id),
  createRoom: (floorId, patch) => inv('bim:createRoom', { floorId, patch }),
  updateRoom: (id, patch) => inv('bim:updateRoom', { id, patch }),
  deleteRoom: (id) => inv('bim:deleteRoom', id),
  createElement: (roomId, patch) => inv('bim:createElement', { roomId, patch }),
  updateElement: (id, patch) => inv('bim:updateElement', { id, patch }),
  deleteElement: (id) => inv('bim:deleteElement', id),
  createDocument: (patch) => inv('bim:createDocument', patch),
  updateDocument: (id, patch) => inv('bim:updateDocument', { id, patch }),
  deleteDocument: (id) => inv('bim:deleteDocument', id),

  analyzeRoom: (roomId) => inv('bim:analyzeRoom', roomId),
  analyzeAll: () => inv('bim:analyzeAll'),
  analyzeDocument: (docId) => inv('bim:analyzeDocument', docId),
  updateFinding: (id, patch) => inv('bim:updateFinding', { id, patch }),
  addFindingComment: (id, comment) => inv('bim:addFindingComment', { id, comment }),
  getSettings: () => inv('bim:getSettings'),
  setSettings: (patch) => inv('bim:setSettings', patch),

  // Phase E: app info, paths, updates
  getVersion: () => inv('bim:getVersion'),
  getPaths: () => inv('bim:getPaths'),
  openPath: (p) => inv('bim:openPath', p),
  checkUpdates: () => inv('bim:checkUpdates'),

  exportBackup: () => inv('bim:exportBackup'),
  importBackup: (json) => inv('bim:importBackup', json),

  // Phase D1: projects
  listProjects: () => inv('bim:listProjects'),
  createProject: (patch) => inv('bim:createProject', patch),
  switchProject: (id) => inv('bim:switchProject', id),
  deleteProject: (id) => inv('bim:deleteProject', id),
  editProject: (id, patch) => inv('bim:editProject', { id, patch: patch || {} }),
  duplicateProject: (id, patch) => inv('bim:duplicateProject', { id, patch: patch || {} }),
  getProjectState: (projectId) => inv('bim:getProjectState', projectId),
  saveProjectState: (payload) => inv('bim:saveProjectState', payload),
  undoProjectState: (payload) => inv('bim:undoProjectState', payload || {}),
  redoProjectState: (payload) => inv('bim:redoProjectState', payload || {}),
  listProjectRevisions: (projectId) => inv('bim:listProjectRevisions', projectId),
  recordProjectOperation: (entry) => inv('bim:recordProjectOperation', entry),
  listProjectOperations: (payload) => inv('bim:listProjectOperations', payload || {}),
  saveProjectClassification: (payload) => inv('bim:saveProjectClassification', payload),
  clearProjectClassification: (payload) => inv('bim:clearProjectClassification', payload),
  loadProjectClassification: (payload) => inv('bim:loadProjectClassification', payload || {}),
  listSectionPresets: () => inv('bim:listSectionPresets'),
  saveSectionPreset: (preset) => inv('bim:saveSectionPreset', preset),
  deleteSectionPreset: (id) => inv('bim:deleteSectionPreset', id),

  // Phase D2: users & assignment
  listUsers: () => inv('bim:listUsers'),
  createUser: (patch) => inv('bim:createUser', patch),
  updateUser: (id, patch) => inv('bim:updateUser', { id, patch }),
  deleteUser: (id) => inv('bim:deleteUser', id),
  assignFinding: (id, patch) => inv('bim:assignFinding', { id, patch }),

  // Phase D3: element discussions
  listDiscussions: (elementId) => inv('bim:listDiscussions', elementId),
  createDiscussion: (patch) => inv('bim:createDiscussion', patch),
  addDiscussionComment: (id, comment) => inv('bim:addDiscussionComment', { id, comment }),
  setDiscussionStatus: (id, status) => inv('bim:setDiscussionStatus', { id, status }),
  deleteDiscussion: (id) => inv('bim:deleteDiscussion', id),

  // Phase D4: export reports
  exportReport: (scope, format) => inv('bim:exportReport', { scope, format }),

  // Phase D5: team sync
  exportSync: () => inv('bim:exportSync'),
  importSync: (merge) => inv('bim:importSync', { merge }),
  /* LCC2: нативный выбор папки */
  lcc2OpenFolder: () => inv('lcc2:openFolder'),
  lcc2ReadFile: (fullPath) => inv('lcc2:readFile', fullPath),

  // Phase 4: save edited point cloud to .ply
  saveCloud: (payload) => inv('bim:saveCloud', payload),
  // v1156 — умное сохранение: экспорт в любой формат (диалог), тихое сохранение в путь, закрытие с вопросом
  exportFile: (payload) => inv('bim:exportFile', payload),
  // Bounded-memory single-scan PTX export; every token is scoped to this renderer.
  beginExportStream: (payload) => inv('bim:beginExportStream', payload),
  writeExportStreamChunk: (payload) => inv('bim:writeExportStreamChunk', payload),
  finishExportStream: (streamId) => inv('bim:finishExportStream', { streamId }),
  cancelExportStream: (streamId) => inv('bim:cancelExportStream', { streamId }),
  saveCloudToPath: (payload) => inv('bim:saveCloudToPath', payload),
  setDirty: (v) => ipcRenderer.send('bim:setDirty', v),
  setProjectDirty: (v) => ipcRenderer.send('bim:setProjectDirty', v),
  closeConfirmed: () => ipcRenderer.send('bim:closeConfirmed'),
  onDoSaveThenClose: (cb) => ipcRenderer.on('bim:doSaveThenClose', () => { try { cb(); } catch (e) {} }),
  // Умное авто-сохранение правок (черновик в userData) + ручной экспорт
  autosaveCloud: (payload) => inv('bim:autosaveCloud', payload),
  autosaveLoad: (payload) => inv('bim:autosaveLoad', payload),
  autosaveClear: (payload) => inv('bim:autosaveClear', payload),
  // Конвертация LAS/LAZ/E57 → PLY для 3D-экскурсии
  convertCloudToPly: (a) => inv('bim:convertCloudToPly', a || {}),

  // Item 3 (patch 26): реальные станции сканера (E57) для «Экскурсии»
  parseScanStations: (p) => inv('bim:parseScanStations', p),
  importStations: () => inv('bim:importStations'),
  saveStations: (payload) => inv('bim:saveStations', payload),

  // Удаление движущихся объектов по траектории сканера (LAS с временем точек + poses.csv)
  findTrajectory: (payload) => inv('bim:findTrajectory', payload),
  pickTrajectory: () => inv('bim:pickTrajectory'),
  findXbin: (payload) => inv('bim:findXbin', payload),   // ревизия 22: файл сканера .xbin рядом с облаком (цвет по фото)
  pickXbin: () => inv('bim:pickXbin'),
  openXbin: (p) => inv('bim:openXbin', { path: p }),   // ревизия 23: файл .xbin → облако и траектория проекта Lixel
  // ревизия 24: облако из сырого лидара .xbin (density: normal ≈ 40 млн, high ≈ 120 млн, all — все точки) с прогрессом и отменой
  // ревизия 25: opts.refine — уточнение траектории по самому облаку (точнее, дольше)
  xbinBuildCloud: (p, jobId, density, opts) => inv('bim:xbinBuildCloud', { path: p, jobId, density, refine: !!(opts && opts.refine) }),
  onXbinCloudProgress: (jobId, callback) => {
    if (typeof jobId !== 'string' || typeof callback !== 'function' || typeof ipcRenderer.on !== 'function') return () => {};
    const listener = (_event, payload) => { if (!payload || payload.jobId !== jobId) return; try { callback(payload.progress, payload.label); } catch (_) {} };
    ipcRenderer.on('bim:xbinCloudProgress', listener);
    let active = true;
    return () => { if (!active) return; active = false; try { ipcRenderer.removeListener('bim:xbinCloudProgress', listener); } catch (_) {} };
  },
  cancelXbinCloud: (jobId) => { if (typeof jobId === 'string' && jobId) snd('bim:cancelXbinCloud', { jobId }); },
  pickScanFolder: () => inv('bim:pickScanFolder'),   // ревизия 19: папка проекта сканера → облако + траектория
  dynamicClean: (payload) => inv('bim:dynamicClean', payload),
  onDynamicCleanProgress: (jobId, callback) => {
    if (typeof jobId !== 'string' || typeof callback !== 'function' || typeof ipcRenderer.on !== 'function') return () => {};
    const listener = (_event, payload) => { if (!payload || payload.jobId !== jobId) return; try { callback(payload.progress, payload.label); } catch (_) {} };
    ipcRenderer.on('bim:dynamicCleanProgress', listener);
    let active = true;
    return () => { if (!active) return; active = false; try { ipcRenderer.removeListener('bim:dynamicCleanProgress', listener); } catch (_) {} };
  },
  cancelDynamicClean: (jobId) => { if (typeof jobId === 'string' && jobId) snd('bim:cancelDynamicClean', { jobId }); },
  // Чистовая обработка скана в новый LAS (выбор файла результата — в диалоге главного процесса)
  refineScan: (payload) => inv('bim:refineScan', payload),
  onRefineScanProgress: (jobId, callback) => {
    if (typeof jobId !== 'string' || typeof callback !== 'function' || typeof ipcRenderer.on !== 'function') return () => {};
    const listener = (_event, payload) => { if (!payload || payload.jobId !== jobId) return; try { callback(payload.progress, payload.label); } catch (_) {} };
    ipcRenderer.on('bim:refineScanProgress', listener);
    let active = true;
    return () => { if (!active) return; active = false; try { ipcRenderer.removeListener('bim:refineScanProgress', listener); } catch (_) {} };
  },
  cancelRefineScan: (jobId) => { if (typeof jobId === 'string' && jobId) snd('bim:cancelRefineScan', { jobId }); },

  // Пункт 4 (patch 28): дисковый octree — сборка на диск и потоковая подгрузка узлов
  buildOctree: (payload) => inv('bim:buildOctree', payload),
  readOctreeNode: (payload) => inv('bim:readOctreeNode', payload),
  deleteOctree: (payload) => inv('bim:deleteOctree', payload),
  onOctreeProgress: (jobId, callback) => {
    if (typeof jobId !== 'string' || typeof callback !== 'function' || typeof ipcRenderer.on !== 'function') return () => {};
    const listener = (_event, payload) => {
      if (!payload || payload.jobId !== jobId) return;
      try { callback(payload.progress); } catch (_) {}
    };
    ipcRenderer.on('bim:octreeProgress', listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      try { ipcRenderer.removeListener('bim:octreeProgress', listener); } catch (_) {}
    };
  },
  cancelOctreeBuild: (jobId) => {
    if (typeof jobId === 'string' && jobId) snd('bim:cancelOctreeBuild', { jobId });
  }
});
