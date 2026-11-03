'use strict';
/*
 * knowledge-update.js — обновление баз ассистента из интернета (ревизия 43). Main-процесс, без Electron (fetch внедряется).
 *
 * Лента (feed.json) — список выпусков баз; программа скачивает только ДАННЫЕ (JSON), никакого кода:
 *   { "format": "bim-twin-feed", "version": 1, "updated": "2026-11-19", "items": [
 *       { "id": "norms-2026-11", "kind": "norms", "version": "2026.11.1", "title": "…", "url": "norms-2026-11.json",
 *         "sha256": "<64 hex>", "size": 12345, "published": "2026-11-19", "notes": "…" } ] }
 *   kind: norms   — записи базы норм { format: "bim-twin-norms", docs: {шифр: название}, entries: [{id, doc, clause, topic, text, tags}] }
 *                   (тот же id заменяет встроенную запись — так приходят новые редакции);
 *         kb      — статьи справки { format: "bim-twin-kb", articles: [{id, title, tags, text}] };
 *         knowledge — пакет знаний и навыков .bimknow.json (как у «Экспорт пакета», с подписью);
 *         status  — актуальность документов { format: "bim-twin-norms-status", docs: [{code, status, replacedBy, date, note}] };
 *         model   — рекомендация базовой модели { format: "bim-twin-model", base, minRamGb, note } (сама модель не скачивается без согласия).
 * Защита: только https (http — лишь localhost для проверки), размер ленты ≤ 1 МБ, файла ≤ 20 МБ, SHA-256 обязателен и сверяется,
 * текст проходит фильтр «инструкций для модели» (assistant-memory.suspicious), поля обрезаются. Отправляется только GET без данных пользователя.
 * Автопроверка: раз в intervalH часов (по умолчанию 24), если включена (по умолчанию да); данные ставятся сами, модель — по кнопке.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const M = require('./assistant-memory');

const FEED_FORMAT = 'bim-twin-feed';
const KINDS = { norms: 'База норм', kb: 'Справка', knowledge: 'Знания и навыки', status: 'Актуальность документов', model: 'Модель' };
const DEFAULT_FEEDS = ['https://raw.githubusercontent.com/irinamat30309-netizen/bim-twin/agent/ui-redesign/knowledge/feed.json'];
const LIM = { feed: 1024 * 1024, file: 20 * 1024 * 1024, items: 200, entries: 3000, articles: 600, text: 6000, statusDocs: 3000 };

function updatesDir(env) {
  const e = env || process.env;
  if (e.BIMTWIN_AI_UPDATES) return path.resolve(e.BIMTWIN_AI_UPDATES);
  const L = require('./local-llm');
  return path.join(path.dirname(L.memoryPath(e)), 'updates');
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, n || 200).trim();
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } }
function writeJson(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp' + process.pid; fs.writeFileSync(t, JSON.stringify(o, null, 1)); fs.renameSync(t, f); }
function okUrl(u) {
  let x; try { x = new URL(u); } catch (_) { return false; }
  if (x.protocol === 'https:') return true;
  return x.protocol === 'http:' && (x.hostname === '127.0.0.1' || x.hostname === 'localhost');
}
function cmpVer(a, b) {
  const pa = String(a || '').split(/[.\-]/).map((x) => +x || 0), pb = String(b || '').split(/[.\-]/).map((x) => +x || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

// ------------------------------------------------------------------ проверка содержимого
function validateFeed(j, baseUrl) {
  if (!j || j.format !== FEED_FORMAT || !Array.isArray(j.items)) return { ok: false, error: 'Это не лента обновлений BIM Twin.' };
  if (+j.version > 1) return { ok: false, error: 'Лента более новой версии — обновите программу.' };
  const items = [];
  j.items.slice(0, LIM.items).forEach((it) => {
    if (!it || !KINDS[it.kind] || !/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(String(it.id || '')) || !/^[0-9a-f]{64}$/i.test(String(it.sha256 || ''))) return;
    let url; try { url = new URL(String(it.url || ''), baseUrl).href; } catch (_) { return; }
    if (!okUrl(url)) return;
    items.push({ id: String(it.id), kind: it.kind, version: str(it.version, 40) || '1', title: str(it.title, 200) || String(it.id), url, sha256: String(it.sha256).toLowerCase(),
      size: Math.max(0, +it.size || 0), published: str(it.published, 40), notes: str(it.notes, 1000) });
  });
  return { ok: true, items, updated: str(j.updated, 40), name: str(j.name, 120) };
}
function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const x = { id: str(e.id, 64), doc: str(e.doc, 120), clause: str(e.clause, 200), topic: str(e.topic, 300), text: str(e.text, LIM.text), tags: str(e.tags, 600) };
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(x.id) || !x.doc || !x.text || M.suspicious(x.text + ' ' + x.topic + ' ' + x.tags)) return null;
  return x;
}
function validatePayload(kind, j) {
  if (!j || typeof j !== 'object') return { ok: false, error: 'Файл не JSON.' };
  if (kind === 'norms') {
    if (j.format !== 'bim-twin-norms' || !Array.isArray(j.entries)) return { ok: false, error: 'Не база норм BIM Twin.' };
    const entries = [], docs = {}; let rejected = 0;
    j.entries.slice(0, LIM.entries).forEach((e) => { const x = cleanEntry(e); if (x) entries.push(x); else rejected++; });
    if (j.docs && typeof j.docs === 'object') Object.keys(j.docs).slice(0, 500).forEach((k) => { const v = str(j.docs[k], 300); if (v && !M.suspicious(v)) docs[str(k, 120)] = v; });
    return { ok: true, data: { format: 'bim-twin-norms', docs, entries }, count: entries.length, rejected };
  }
  if (kind === 'kb') {
    if (j.format !== 'bim-twin-kb' || !Array.isArray(j.articles)) return { ok: false, error: 'Не статьи справки BIM Twin.' };
    const arts = []; let rejected = 0;
    j.articles.slice(0, LIM.articles).forEach((a) => {
      const x = a && { id: str(a.id, 64), title: str(a.title, 200), tags: str(a.tags, 600), text: str(a.text, LIM.text) };
      if (!x || !/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(x.id) || !x.title || !x.text || M.suspicious(x.title + ' ' + x.text)) { rejected++; return; }
      arts.push(x);
    });
    return { ok: true, data: { format: 'bim-twin-kb', articles: arts }, count: arts.length, rejected };
  }
  if (kind === 'status') {
    if (j.format !== 'bim-twin-norms-status' || !Array.isArray(j.docs)) return { ok: false, error: 'Не список актуальности документов.' };
    const docs = j.docs.slice(0, LIM.statusDocs).map((d) => d && { code: str(d.code, 120), status: ['действует', 'заменён', 'отменён', 'изменён'].includes(d.status) ? d.status : 'действует', replacedBy: str(d.replacedBy, 120), date: str(d.date, 40), note: str(d.note, 400) })
      .filter((d) => d && d.code && !M.suspicious(d.note));
    return { ok: true, data: { format: 'bim-twin-norms-status', docs }, count: docs.length, rejected: 0 };
  }
  if (kind === 'knowledge') {
    if (j.format !== M.FORMAT || !Array.isArray(j.items)) return { ok: false, error: 'Не пакет знаний BIM Twin.' };
    return { ok: true, data: j, count: j.items.length, rejected: 0 };
  }
  if (kind === 'model') {
    if (j.format !== 'bim-twin-model' || !/^[a-z0-9][a-z0-9._:-]{1,80}$/i.test(String(j.base || ''))) return { ok: false, error: 'Не рекомендация модели.' };
    return { ok: true, data: { format: 'bim-twin-model', base: String(j.base), minRamGb: +j.minRamGb || 0, note: str(j.note, 600) }, count: 1, rejected: 0 };
  }
  return { ok: false, error: 'Неизвестный тип обновления.' };
}

// нормализация шифра для сверки: «СП 70.13330.2012» → «сп 70.13330»
function codeKey(c) { return String(c || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').replace(/^(сп|гост р|гост|снип|санпин)\s*/, '$1 ').replace(/[.\-–](19|20)\d\d\b.*$/, '').trim(); }

// ------------------------------------------------------------------ обновлятель
function createUpdater(opts) {
  const o = opts || {};
  const dir = o.dir || updatesDir();
  const F = { state: path.join(dir, 'state.json') };
  const now = o.now || Date.now;
  const fetchFn = o.fetch || (typeof fetch === 'function' ? fetch : null);
  const listeners = new Set();
  let st = Object.assign({ auto: true, intervalH: 24, feeds: DEFAULT_FEEDS.slice(), lastCheck: 0, lastError: '', installed: {}, available: [], log: [] }, readJson(F.state, {}));
  if (!Array.isArray(st.feeds) || !st.feeds.length) st.feeds = DEFAULT_FEEDS.slice();
  const save = () => { try { writeJson(F.state, st); } catch (_) {} };
  const emit = (ev) => { for (const fn of listeners) { try { fn(ev); } catch (_) {} } };
  const log = (t) => { st.log.unshift({ at: now(), text: str(t, 300) }); st.log = st.log.slice(0, 50); };

  async function getBytes(url, max, timeoutMs) {
    if (!fetchFn) throw new Error('Нет доступа к сети в этом окружении.');
    if (!okUrl(url)) throw new Error('Разрешены только адреса https.');
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const tm = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 20000) : null;
    try {
      const r = await fetchFn(url, { method: 'GET', redirect: 'follow', signal: ctrl ? ctrl.signal : undefined, headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' } });
      if (!r || !r.ok) throw new Error('Сервер ответил ' + (r ? r.status : 'ошибкой'));
      const len = +((r.headers && r.headers.get && r.headers.get('content-length')) || 0);
      if (len > max) throw new Error('Файл больше допустимого (' + Math.round(max / 1048576) + ' МБ).');
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > max) throw new Error('Файл больше допустимого (' + Math.round(max / 1048576) + ' МБ).');
      return buf;
    } finally { if (tm) clearTimeout(tm); }
  }

  async function check() {
    const found = [], errors = [];
    for (const feed of st.feeds.slice(0, 8)) {
      try {
        const buf = await getBytes(feed, LIM.feed, 15000);
        let j; try { j = JSON.parse(buf.toString('utf8')); } catch (_) { throw new Error('лента не JSON'); }
        const v = validateFeed(j, feed); if (!v.ok) throw new Error(v.error);
        v.items.forEach((it) => { const inst = st.installed[it.id]; it.feed = feed; it.installed = inst ? inst.version : ''; it.isNew = !inst || cmpVer(it.version, inst.version) > 0; found.push(it); });
      } catch (e) { errors.push(feed + ': ' + String(e && e.message || e)); }
    }
    st.lastCheck = now(); st.lastError = errors.join('; ').slice(0, 600);
    st.available = found.filter((x) => x.isNew);
    save();
    const res = { ok: !errors.length || found.length > 0, checked: st.feeds.length, available: st.available.map(brief), upToDate: found.filter((x) => !x.isNew).length, errors, lastCheck: st.lastCheck };
    res.message = res.available.length ? 'Доступно обновлений: ' + res.available.length + ' — ' + res.available.map((x) => x.title + ' ' + x.version).join('; ') : errors.length && !found.length ? 'Не удалось проверить: ' + errors[0] : 'Все базы актуальны.';
    emit({ type: 'checked', result: res });
    return res;
  }
  function brief(x) { return { id: x.id, kind: x.kind, kindText: KINDS[x.kind], title: x.title, version: x.version, installed: x.installed || '', published: x.published, notes: x.notes, size: x.size }; }

  async function installOne(it, hooks) {
    const buf = await getBytes(it.url, LIM.file, 60000);
    const h = sha256(buf);
    if (h !== it.sha256) throw new Error('контрольная сумма не совпала — файл повреждён или подменён');
    let j; try { j = JSON.parse(buf.toString('utf8')); } catch (_) { throw new Error('файл не JSON'); }
    const v = validatePayload(it.kind, j); if (!v.ok) throw new Error(v.error);
    const file = path.join(dir, it.kind, it.id + '.json');
    let extra = {};
    if (it.kind === 'knowledge') {
      if (!hooks || !hooks.importKnowledge) throw new Error('память ассистента недоступна');
      extra = hooks.importKnowledge(v.data, it) || {};
      if (extra.ok === false) throw new Error(extra.error || 'пакет не принят');
    }
    writeJson(file, Object.assign({ _id: it.id, _version: it.version, _title: it.title, _sha256: h, _installed: new Date(now()).toISOString() }, v.data));
    st.installed[it.id] = { version: it.version, kind: it.kind, title: it.title, at: now(), count: v.count, rejected: v.rejected, file };
    log('Установлено: ' + it.title + ' ' + it.version + ' (' + v.count + (v.rejected ? ', отклонено ' + v.rejected : '') + ')');
    return { id: it.id, kind: it.kind, title: it.title, version: it.version, count: v.count, rejected: v.rejected, extra };
  }
  async function install(ids, hooks) {
    if (!st.available.length) await check();
    const list = st.available.filter((x) => !ids || !ids.length || ids.includes(x.id));
    const done = [], failed = [];
    for (const it of list) {
      try { done.push(await installOne(it, hooks)); } catch (e) { failed.push({ id: it.id, title: it.title, error: String(e && e.message || e) }); log('Ошибка ' + it.title + ': ' + String(e && e.message || e)); }
    }
    st.available = st.available.filter((x) => !done.some((d) => d.id === x.id));
    save();
    const kinds = new Set(done.map((d) => d.kind));
    if (kinds.has('norms') && hooks && hooks.onNorms) { try { hooks.onNorms(loadNorms()); } catch (_) {} }
    if (kinds.has('kb') && hooks && hooks.onKb) { try { hooks.onKb(loadKb()); } catch (_) {} }
    const res = { ok: !failed.length, installed: done, failed, message: (done.length ? 'Установлено: ' + done.map((d) => d.title + ' ' + d.version).join('; ') + '.' : 'Нечего устанавливать.') + (failed.length ? ' Ошибки: ' + failed.map((f) => f.title + ' — ' + f.error).join('; ') : '') };
    emit({ type: 'installed', result: res });
    return res;
  }
  function readKind(kind) {
    const d = path.join(dir, kind); let files = [];
    try { files = fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort(); } catch (_) { return []; }
    return files.map((f) => readJson(path.join(d, f), null)).filter(Boolean);
  }
  // нормы: записи всех установленных выпусков (позже установленный перекрывает раньше)
  function loadNorms() {
    const by = new Map(), docs = {};
    readKind('norms').sort((a, b) => String(a._installed).localeCompare(String(b._installed))).forEach((p) => {
      const v = validatePayload('norms', p); if (!v.ok) return;
      v.data.entries.forEach((e) => by.set(e.id, Object.assign({ updated: p._version || '' }, e)));
      Object.assign(docs, v.data.docs);
    });
    return { entries: Array.from(by.values()), docs };
  }
  function loadKb() {
    const by = new Map();
    readKind('kb').forEach((p) => { const v = validatePayload('kb', p); if (v.ok) v.data.articles.forEach((a) => by.set(a.id, a)); });
    return Array.from(by.values());
  }
  function loadStatus() {
    const by = new Map();
    readKind('status').forEach((p) => { const v = validatePayload('status', p); if (v.ok) v.data.docs.forEach((d) => by.set(codeKey(d.code), d)); });
    return by;
  }
  function loadModel() { const L = readKind('model'); return L.length ? L[L.length - 1] : null; }
  // актуальность: какие из шифров (встроенная база + документы пользователя) заменены или отменены
  function normsStatus(codes, builtinStatus) {
    const by = loadStatus();
    (builtinStatus || []).forEach((d) => { const k = codeKey(d.code); if (!by.has(k)) by.set(k, d); });
    const out = [];
    (codes || []).forEach((c) => {
      const d = by.get(codeKey(c)); if (!d) return;
      const sameEd = String(d.code).replace(/\s+/g, '') === String(c).replace(/\s+/g, '');
      if (d.status === 'заменён' || d.status === 'отменён' || (!sameEd && /(19|20)\d\d/.test(c) && /(19|20)\d\d/.test(d.code))) out.push({ code: c, actual: d.code, status: sameEd ? d.status : 'есть новая редакция', replacedBy: d.replacedBy || (sameEd ? '' : d.code), note: d.note, date: d.date });
    });
    return out;
  }
  function due() { return !!st.auto && now() - (st.lastCheck || 0) >= Math.max(1, +st.intervalH || 24) * 3600e3; }
  // автопроверка: данные ставятся сами (кроме модели — только сообщение)
  async function auto(hooks) {
    if (!due()) return { ok: true, skipped: true };
    const c = await check();
    const data = (st.available || []).filter((x) => x.kind !== 'model').map((x) => x.id);
    if (!data.length) return { ok: c.ok, checked: true, installed: [] , message: c.message };
    const r = await install(data, hooks);
    return Object.assign({ checked: true }, r);
  }
  function settings(p) {
    if (p && typeof p === 'object') {
      if (typeof p.auto === 'boolean') st.auto = p.auto;
      if (+p.intervalH >= 1 && +p.intervalH <= 24 * 30) st.intervalH = Math.round(+p.intervalH);
      if (Array.isArray(p.feeds)) { const f = p.feeds.map((x) => String(x).trim()).filter(okUrl).slice(0, 8); st.feeds = f.length ? f : DEFAULT_FEEDS.slice(); }
      save();
    }
    return state();
  }
  function state() {
    return { auto: st.auto, intervalH: st.intervalH, feeds: st.feeds.slice(), lastCheck: st.lastCheck, lastError: st.lastError, due: due(),
      installed: Object.keys(st.installed).map((id) => Object.assign({ id }, st.installed[id], { file: undefined, kindText: KINDS[st.installed[id].kind] })), available: st.available.map(brief), log: st.log.slice(0, 20) };
  }
  return { dir, check, install, auto, due, settings, state, loadNorms, loadKb, loadStatus, loadModel, normsStatus, onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
}

// ------------------------------------------------------------------ выпуск ленты (для сопровождающего баз): node ai/knowledge-update.js build <папка>
function buildFeed(folder, o) {
  const opt = o || {};
  const prev = readJson(path.join(folder, 'feed.json'), { items: [] });
  const items = [];
  fs.readdirSync(folder).filter((f) => f.endsWith('.json') && f !== 'feed.json').sort().forEach((f) => {
    const buf = fs.readFileSync(path.join(folder, f)); let j; try { j = JSON.parse(buf.toString('utf8')); } catch (_) { return; }
    const kind = j.format === 'bim-twin-norms' ? 'norms' : j.format === 'bim-twin-kb' ? 'kb' : j.format === 'bim-twin-norms-status' ? 'status' : j.format === M.FORMAT ? 'knowledge' : j.format === 'bim-twin-model' ? 'model' : null;
    if (!kind) return;
    const id = f.replace(/\.json$/, ''), h = sha256(buf), old = (prev.items || []).find((x) => x.id === id);
    const version = j.release || (old && old.sha256 === h ? old.version : (opt.version || new Date().toISOString().slice(0, 10).replace(/-/g, '.')));
    items.push({ id, kind, version: String(version), title: j.title || (old && old.title) || id, url: f, sha256: h, size: buf.length, published: (old && old.sha256 === h && old.published) || new Date().toISOString().slice(0, 10), notes: j.notes || '' });
  });
  const feed = { format: FEED_FORMAT, version: 1, name: 'Базы BIM Twin', updated: new Date().toISOString().slice(0, 10), items };
  fs.writeFileSync(path.join(folder, 'feed.json'), JSON.stringify(feed, null, 1) + '\n');
  return feed;
}

module.exports = { FEED_FORMAT, KINDS, DEFAULT_FEEDS, LIM, updatesDir, validateFeed, validatePayload, createUpdater, buildFeed, codeKey, cmpVer, okUrl };

if (require.main === module && process.argv[2] === 'build') {
  const f = buildFeed(path.resolve(process.argv[3] || 'knowledge'));
  console.log('feed.json: ' + f.items.length + ' выпусков');
}
