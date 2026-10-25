'use strict';
/*
 * assistant-main.js — ИИ-ассистент в главном процессе (ревизия 34): IPC и автоматическая установка локальной модели.
 *   bim:aiStatus → состояние (этап, проценты, модель, железо);  bim:aiSetup { model? } → запустить установку (в фоне);
 *   bim:aiChat { jobId, messages, tools, think } → ответ модели, по ходу — событие bim:aiDelta { jobId, content, thinking };
 *   bim:aiCancel { jobId };  событие bim:aiSetupProgress — состояние установки.
 * Модель работает только на 127.0.0.1 (свой Ollama на 11435 или установленный пользователем на 11434).
 * r35 — «База норм»: bim:normsStatus / normsAddFiles / normsAddFolder / normsRemove / normsReindex / normsSearch / normsOpen,
 *   событие bim:normsProgress; снимок вида для модели со зрением — bim:aiCaptureView { rect }.
 * r42 — память и обучение: bim:aiMemLoad / aiMemSave { memory } / aiMemExport { kind: pack|dataset|modelfile } / aiMemImport / aiTrain { reset }.
 */
const L = require('./local-llm');
const NI = require('./norms-index');
const NT = require('./norms-text');
const M = require('./assistant-memory');
const KU = require('./knowledge-update');
const NB = require('./norms-builtin');

// r43: обновления баз из интернета — установленные нормы подмешиваются во встроенную базу при запуске
let updater = null;
function updates() {
  if (updater) return updater;
  updater = KU.createUpdater({});
  try { const n = updater.loadNorms(); NB.setExtra(n.entries, n.docs); } catch (_) {}
  return updater;
}

let normsIx = null;
function norms() {
  if (normsIx) return normsIx;
  normsIx = NI.createIndex({
    embed: (input, o) => L.embed({ input, query: !!(o && o.query), signal: o && o.signal }),
    embedModel: () => { const st = L.readState(); return st.embedPhase === 'ready' && st.embed ? st.embed : ''; },
    isBusy: () => jobs.size > 0
  });
  return normsIx;
}

let setupRun = null;          // текущая установка в этом процессе
const jobs = new Map();       // jobId → AbortController
let watchTimer = null;

function sanitizeMessages(list) {
  if (!Array.isArray(list)) return [];
  const keep = list.length > 60 && list[0] && list[0].role === 'system' ? [list[0]].concat(list.slice(-59)) : list.slice(-60);   // системная подсказка остаётся первой
  return keep.map((m) => {
    const role = ['system', 'user', 'assistant', 'tool'].includes(m && m.role) ? m.role : 'user';
    const out = { role, content: String(m && m.content || '').slice(0, 24000) };
    if (role === 'user' && Array.isArray(m.images)) {
      const imgs = m.images.filter((x) => typeof x === 'string' && x.length <= 4 * 1024 * 1024 && /^[A-Za-z0-9+/=]+$/.test(x.slice(0, 256))).slice(0, 2);
      if (imgs.length) out.images = imgs;
    }
    if (role === 'tool' && m.tool_name) out.tool_name = String(m.tool_name).slice(0, 64);
    if (role === 'assistant' && Array.isArray(m.tool_calls)) out.tool_calls = m.tool_calls.slice(0, 8).map((c) => ({ function: { name: String(c && c.function && c.function.name || '').slice(0, 64), arguments: c && c.function && typeof c.function.arguments === 'object' ? c.function.arguments : {} } }));
    return out;
  });
}
function sanitizeTools(list) {
  if (!Array.isArray(list)) return [];
  const js = JSON.stringify(list.slice(0, 32));
  return js.length > 64000 ? [] : JSON.parse(js);
}

function broadcast(getWins, ch, payload) {
  for (const w of getWins()) { try { if (w && !w.isDestroyed()) w.webContents.send(ch, payload); } catch (_) {} }
}

function startSetup(getWins, opts) {
  if (setupRun) return setupRun;
  const o = opts || {};
  setupRun = L.ensure({ model: o.model || undefined, onProgress: (s) => broadcast(getWins, 'bim:aiSetupProgress', publicState(s)) })
    .then((r) => {
      if (r && r.ok) { try { norms().start(); norms().embedPending().catch(() => {}); } catch (_) {} }
      // установку ведёт другой процесс (START.bat / установщик) — следим за state.json и пересылаем прогресс в окно
      if (r && r.busy) watchForeign(getWins);
      return r;
    })
    .finally(() => { setupRun = null; });
  return setupRun;
}
function watchForeign(getWins) {
  if (watchTimer) return;
  let last = '';
  watchTimer = setInterval(() => {
    const st = L.readState();
    const key = st.phase + ':' + st.pct + ':' + st.updated;
    if (key !== last) { last = key; broadcast(getWins, 'bim:aiSetupProgress', publicState(st)); }
    if (!L.lockHolder()) { clearInterval(watchTimer); watchTimer = null; if (st.phase !== 'ready') startSetup(getWins); }
  }, 1500);
  if (watchTimer.unref) watchTimer.unref();
}
function publicState(s) {
  const st = s || {};
  return { ready: st.phase === 'ready', phase: st.phase || 'none', pct: st.pct || 0, done: st.done || 0, total: st.total || 0, status: st.status || '', message: st.message || '', error: st.error || null,
    base: st.base || null, model: st.model || null, why: st.why || '', reasons: st.reasons || [], hardware: st.hardware || null, server: st.server || null, think: !!st.think,
    running: !!st.running, busy: !!st.busy, dir: st.dir || null, vision: !!st.vision, caps: Array.isArray(st.caps) ? st.caps : [],
    embed: st.embed || null, embedPhase: st.embedPhase || 'none', embedPct: st.embedPct || 0, embedError: st.embedError || null, models: (st.models || L.MODELS).map((m) => ({ id: m.id, label: m.label, size: m.size, note: m.note })) };
}

function register(ipcMain, deps) {
  const trusted = deps.isTrustedIpcEvent || (() => true);
  const getWins = deps.getWindows || (() => []);
  ipcMain.handle('bim:aiStatus', async () => {
    try { const s = await L.status(); if (setupRun) s.busy = true; return publicState(s); } catch (e) { return publicState({ phase: 'error', error: String(e && e.message || e) }); }
  });
  ipcMain.handle('bim:aiSetup', async (event, a) => {
    if (!trusted(event)) throw new Error('untrusted_sender');
    const model = a && typeof a.model === 'string' && /^[a-z0-9._:-]{2,64}$/i.test(a.model) ? a.model : null;
    if (model && !L.modelInfo(model)) return { ok: false, error: 'unknown_model' };
    startSetup(getWins, { model });
    return { ok: true, started: true };
  });
  ipcMain.handle('bim:aiChat', async (event, a) => {
    if (!trusted(event)) throw new Error('untrusted_sender');
    const jobId = a && typeof a.jobId === 'string' ? a.jobId.slice(0, 80) : 'ai-' + Date.now();
    const ac = new AbortController(); jobs.set(jobId, ac);
    const sender = event.sender;
    try {
      const r = await L.chat({ messages: sanitizeMessages(a && a.messages), tools: sanitizeTools(a && a.tools), think: a && a.think != null ? !!a.think : undefined, signal: ac.signal,
        onDelta: (d) => { try { if (!sender.isDestroyed()) sender.send('bim:aiDelta', { jobId, content: d.content, thinking: d.thinking }); } catch (_) {} } });
      return { ok: true, message: r.message, stats: r.stats };
    } catch (e) {
      const msg = String(e && e.message || e);
      return { ok: false, cancelled: ac.signal.aborted || msg === 'cancelled', error: msg };
    } finally { jobs.delete(jobId); }
  });
  // ---- r35: снимок вида для модели со зрением
  ipcMain.handle('bim:aiCaptureView', async (event, a) => {
    if (!trusted(event)) throw new Error('untrusted_sender');
    try {
      const r = a && a.rect;
      const rect = r && [r.x, r.y, r.width, r.height].every((v) => Number.isFinite(v) && v >= 0) && r.width >= 16 && r.height >= 16
        ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : undefined;
      let img = await event.sender.capturePage(rect);
      const sz = img.getSize();
      if (sz.width > 1280) img = img.resize({ width: 1280, quality: 'good' });
      const jpg = img.toJPEG(82);
      return { ok: true, image: jpg.toString('base64'), width: img.getSize().width, height: img.getSize().height, bytes: jpg.length };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });
  // ---- r35: база норм
  const progressHooked = new WeakSet();
  const hookProgress = () => {
    const ix = norms();
    if (progressHooked.has(ix)) return ix;
    progressHooked.add(ix);
    let t = 0, pend = null;
    ix.onProgress((ev) => {
      const send = () => { t = Date.now(); pend = null; broadcast(getWins, 'bim:normsProgress', { type: ev.type, status: ix.status() }); };
      if (ev.type !== 'embed' || Date.now() - t > 700) send();
      else if (!pend) { pend = setTimeout(send, 700); if (pend.unref) pend.unref(); }
    });
    return ix;
  };
  const pickFiles = async (event, folder) => {
    const { dialog, BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(event.sender) || undefined;
    const r = await dialog.showOpenDialog(win, folder
      ? { title: 'Папка с нормативными документами', properties: ['openDirectory'] }
      : { title: 'Добавить документы в базу норм', properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Документы (PDF, DOCX, TXT, RTF, HTML, XLSX)', extensions: NT.EXT_OK }] });
    return r.canceled ? [] : (r.filePaths || []);
  };
  ipcMain.handle('bim:normsStatus', async () => { try { return Object.assign({ ok: true }, hookProgress().status()); } catch (e) { return { ok: false, error: String(e && e.message || e) }; } });
  ipcMain.handle('bim:normsAddFiles', async (event) => {
    if (!trusted(event)) throw new Error('untrusted_sender');
    const files = await pickFiles(event, false);
    if (!files.length) return { ok: true, cancelled: true, added: [], skipped: [] };
    return Object.assign({ ok: true }, await hookProgress().addFiles(files));
  });
  ipcMain.handle('bim:normsAddFolder', async (event) => {
    if (!trusted(event)) throw new Error('untrusted_sender');
    const dirs = await pickFiles(event, true);
    if (!dirs.length) return { ok: true, cancelled: true, added: [], skipped: [] };
    return Object.assign({ ok: true }, await hookProgress().addFolder(dirs[0]));
  });
  ipcMain.handle('bim:normsRemove', async (event, a) => {
    if (!trusted(event)) throw new Error('untrusted_sender');
    return hookProgress().remove(String(a && a.id || ''));
  });
  ipcMain.handle('bim:normsReindex', async (event, a) => {
    if (!trusted(event)) throw new Error('untrusted_sender');
    const ix = hookProgress();
    const r = ix.reindex(a && a.id ? String(a.id) : undefined);
    ix.embedPending().catch(() => {});
    return r;
  });
  ipcMain.handle('bim:normsSearch', async (event, a) => {
    if (!trusted(event)) throw new Error('untrusted_sender');
    try { return await hookProgress().search(String(a && a.query || '').slice(0, 600), { n: a && a.n, doc: a && a.doc ? String(a.doc).slice(0, 120) : undefined }); }
    catch (e) { return { ok: false, error: String(e && e.message || e), results: [] }; }
  });
  ipcMain.handle('bim:normsOpen', async (event, a) => {
    if (!trusted(event)) throw new Error('untrusted_sender');
    const d = hookProgress().status().docs.find((x) => x.id === String(a && a.id || ''));
    if (!d) return { ok: false, error: 'not_found' };
    if (!d.exists) return { ok: false, error: 'Файл не найден: ' + d.file };
    const { shell } = require('electron');
    const err = await shell.openPath(d.file);
    return err ? { ok: false, error: err } : { ok: true };
  });
  // ---- r42: память и обучение ассистента (опыт, правила, пакеты знаний)
  const fs = require('fs'), path = require('path');
  const memLoad = () => { try { return M.normalize(JSON.parse(fs.readFileSync(L.memoryPath(), 'utf8'))); } catch (_) { return M.empty(); } };
  const memSave = (m) => { const p = L.memoryPath(); fs.mkdirSync(path.dirname(p), { recursive: true }); const tmp = p + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(m)); fs.renameSync(tmp, p); };
  ipcMain.handle('bim:aiMemLoad', async () => { const m = memLoad(); return { ok: true, memory: m, summary: M.summary(m), trained: L.readState().trained || null }; });
  ipcMain.handle('bim:aiMemSave', async (event, a) => {
    if (!trusted(event)) throw new Error('untrusted_sender');
    try { const js = JSON.stringify(a && a.memory || {}); if (js.length > 8e6) return { ok: false, error: 'Память слишком большая (больше 8 МБ).' }; const m = M.normalize(JSON.parse(js)); memSave(m); return { ok: true, summary: M.summary(m) }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });
  // выгрузка: пакет знаний (.bimknow.json), датасет для дообучения (.jsonl) или Modelfile для Ollama
  ipcMain.handle('bim:aiMemExport', async (event, a) => {
    if (!trusted(event)) throw new Error('untrusted_sender');
    const kind = a && a.kind === 'dataset' ? 'dataset' : a && a.kind === 'modelfile' ? 'modelfile' : 'pack';
    const m = memLoad(), prompt = require('./assistant-prompt');
    const text = kind === 'pack' ? JSON.stringify(M.exportPack(m, { name: a && a.name, author: a && a.author, description: a && a.description, params: !(a && a.params === false) }), null, 1)
      : kind === 'dataset' ? M.datasetJSONL(m, prompt.SYSTEM_SHORT) : M.modelfile(m, { from: L.readState().base || 'qwen3:8b', system: prompt.SYSTEM_SHORT });
    const { dialog, BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(event.sender) || undefined;
    const def = kind === 'pack' ? 'знания-bim-twin.bimknow.json' : kind === 'dataset' ? 'bim-twin-dataset.jsonl' : 'Modelfile';
    const r = await dialog.showSaveDialog(win, { title: kind === 'pack' ? 'Сохранить пакет знаний' : kind === 'dataset' ? 'Сохранить набор примеров для дообучения' : 'Сохранить Modelfile',
      defaultPath: def, filters: kind === 'pack' ? [{ name: 'Пакет знаний BIM Twin', extensions: ['bimknow.json', 'json'] }] : kind === 'dataset' ? [{ name: 'JSONL', extensions: ['jsonl'] }] : [{ name: 'Modelfile', extensions: ['*'] }] });
    if (r.canceled || !r.filePath) return { ok: true, cancelled: true };
    fs.writeFileSync(r.filePath, text, 'utf8');
    return { ok: true, file: r.filePath, bytes: Buffer.byteLength(text), summary: M.summary(m) };
  });
  ipcMain.handle('bim:aiMemImport', async (event) => {
    if (!trusted(event)) throw new Error('untrusted_sender');
    const { dialog, BrowserWindow } = require('electron');
    const win = BrowserWindow.fromWebContents(event.sender) || undefined;
    const r = await dialog.showOpenDialog(win, { title: 'Загрузить пакет знаний', properties: ['openFile'], filters: [{ name: 'Пакет знаний BIM Twin', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: true, cancelled: true };
    const st = fs.statSync(r.filePaths[0]);
    if (st.size > 20e6) return { ok: false, error: 'Файл больше 20 МБ — это не пакет знаний.' };
    const m = memLoad(), res = M.importPack(m, fs.readFileSync(r.filePaths[0], 'utf8'));
    if (res.ok) memSave(m);
    return Object.assign(res, { memory: res.ok ? m : undefined, summary: M.summary(m), file: path.basename(r.filePaths[0]) });
  });
  ipcMain.handle('bim:aiTrain', async (event, a) => {
    if (!trusted(event)) throw new Error('untrusted_sender');
    if (setupRun) return { ok: false, busy: true, error: 'Сейчас идёт установка модели — попробуйте позже.' };
    return L.train({ reset: !!(a && a.reset) });
  });
  // ---- r43: обновления баз (нормы, справка, знания и навыки, актуальность документов, модель)
  const updHooks = () => ({
    importKnowledge: (pack, it) => { const m = memLoad(), r = M.importPack(m, pack); if (r.ok) memSave(m); return r; },
    onNorms: (n) => { NB.setExtra(n.entries, n.docs); try { norms().refreshBuiltin(); } catch (_) {} },
    onKb: (arts) => broadcast(getWins, 'bim:aiKbExtra', { articles: arts })
  });
  const outdated = () => {
    let codes = Object.keys(NB.DOCS);
    try { codes = codes.concat((norms().status().docs || []).map((d) => d.code).filter(Boolean)); } catch (_) {}
    return updates().normsStatus(codes, NB.STATUS || []);
  };
  ipcMain.handle('bim:aiUpdState', async () => Object.assign(updates().state(), { outdated: outdated(), model: updates().loadModel(), extraNorms: NB.extraCount() }));
  ipcMain.handle('bim:aiUpdCheck', async (event) => {
    if (!trusted(event)) throw new Error('untrusted_sender');
    const r = await updates().check(); return Object.assign(r, { outdated: outdated() });
  });
  ipcMain.handle('bim:aiUpdInstall', async (event, a) => {
    if (!trusted(event)) throw new Error('untrusted_sender');
    const ids = a && Array.isArray(a.ids) ? a.ids.map(String).slice(0, 50) : null;
    const r = await updates().install(ids, updHooks());
    return Object.assign(r, { memory: r.installed.some((x) => x.kind === 'knowledge') ? memLoad() : undefined, state: updates().state() });
  });
  ipcMain.handle('bim:aiUpdSettings', async (event, a) => {
    if (!trusted(event)) throw new Error('untrusted_sender');
    return updates().settings({ auto: a && typeof a.auto === 'boolean' ? a.auto : undefined, intervalH: a && a.intervalH, feeds: a && Array.isArray(a.feeds) ? a.feeds : undefined });
  });
  ipcMain.handle('bim:aiKbLoad', async () => ({ ok: true, articles: updates().loadKb() }));
  // автопроверка: через минуту после запуска и затем раз в час (сама решает по интервалу); только если включена
  const autoUpd = async () => {
    try {
      if (process.env.BIMTWIN_AI_UPDATES_OFF === '1' || !updates().due()) return;
      const r = await updates().auto(updHooks());
      if (r && !r.skipped && (r.installed && r.installed.length || (updates().state().available || []).length)) broadcast(getWins, 'bim:aiUpdate', Object.assign({}, r, { state: updates().state() }));
    } catch (e) { console.warn('[ai] updates', e && e.message); }
  };
  setTimeout(autoUpd, 60000).unref();
  setInterval(autoUpd, 3600e3).unref();
  ipcMain.on('bim:aiCancel', (_e, a) => { const ac = a && jobs.get(a.jobId); if (ac) ac.abort(); });
}

// при запуске приложения: если модель ещё не готова — поставить автоматически (выключается настройкой aiAutoSetup: false)
function autoStart(getWins, settings) {
  const s = settings || {};
  if (s.aiAutoSetup === false || process.env.BIMTWIN_AI_AUTOSETUP === '0') return;
  setTimeout(async () => {
    try {
      if (L.isReady()) {
        await L.endpoint();   // готово — поднять сервер заранее, чтобы первый ответ был быстрее
        // r35: модель поиска по смыслу (если установка была до r35) и векторы базы норм — в фоне
        const st = L.readState();
        if (!(st.embedPhase === 'ready' && st.embed)) {
          await L.ensureEmbed({ onProgress: (x) => broadcast(getWins, 'bim:aiSetupProgress', publicState(x)) }).catch(() => {});
        }
        norms().start();
        norms().embedPending().catch(() => {});
        return;
      }
      startSetup(getWins);
    } catch (e) { console.warn('[ai] auto setup', e && e.message); }
  }, 6000).unref();
}
function stop() { for (const ac of jobs.values()) { try { ac.abort(); } catch (_) {} } try { if (normsIx) normsIx.stop(); } catch (_) {} L.stopServer(); }

module.exports = { register, autoStart, stop, sanitizeMessages, publicState, norms, updates, _setUpdater: (u) => { updater = u; }, _startSetup: startSetup, _setNorms: (ix) => { normsIx = ix; } };
