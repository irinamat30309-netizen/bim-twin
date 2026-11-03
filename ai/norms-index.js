'use strict';
/*
 * База норм BIM Twin: локальный индекс документов (СП, ГОСТ, СНиП, проекты, ТЗ)
 * для ассистента. Гибридный поиск: BM25 по словам (работает всегда, сразу после
 * добавления) + векторы смысла (модель эмбеддингов Ollama, если скачана),
 * объединение рангов RRF. Каждый результат несёт цитату «документ, пункт, страница».
 *
 * Хранение (каталог normsDir()):
 *   index.json        — список документов и параметры векторов
 *   docs/<id>.json    — фрагменты документа (текст, пункт, таблица, страница, токены)
 *   vec/<id>.bin      — векторы фрагментов: 'BTV1', dim, n, n×float32 масштабов, n×dim int8
 * Исходные файлы не копируются — хранится путь к ним.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const T = require('./norms-text');
const B = require('./norms-builtin');

const MAX_FILE = 300 * 1024 * 1024;
const BUILTIN_ID = 'builtin';
const K1 = 1.2, BB = 0.75, RRF_K = 60;

function normsDir(env) {
  const e = env || process.env;
  if (e.BIMTWIN_NORMS_DIR) return path.resolve(e.BIMTWIN_NORMS_DIR);
  const L = require('./local-llm');
  return path.join(path.dirname(L.baseDir(e)), 'norms');
}

// ------------------------------------------------------------------ векторы (int8)
function quantize(v) {
  let mx = 0;
  for (let i = 0; i < v.length; i++) { const a = Math.abs(v[i]); if (a > mx) mx = a; }
  const scale = mx > 0 ? mx / 127 : 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i] / scale)));
  return { scale, q };
}
function concatVec(dim, list) {
  const n = list.length;
  const scales = new Float32Array(n), data = new Int8Array(n * dim);
  list.forEach((it, j) => { scales[j] = it.scale; data.set(it.q.subarray(0, dim), j * dim); });
  return { dim, n, scales, data };
}
function writeVec(file, rec) {
  const head = Buffer.alloc(12);
  head.write('BTV1', 0, 'ascii'); head.writeUInt32LE(rec.dim, 4); head.writeUInt32LE(rec.n, 8);
  const buf = Buffer.concat([head, Buffer.from(rec.scales.buffer, rec.scales.byteOffset, rec.n * 4), Buffer.from(rec.data.buffer, rec.data.byteOffset, rec.n * rec.dim)]);
  atomicWrite(file, buf);
}
function readVec(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return null; }
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'BTV1') return null;
  const dim = buf.readUInt32LE(4), n = buf.readUInt32LE(8);
  if (buf.length < 12 + n * 4 + n * dim) return null;
  const ab = new ArrayBuffer(n * 4); Buffer.from(ab).set(buf.subarray(12, 12 + n * 4));
  const data = new Int8Array(n * dim); data.set(new Int8Array(buf.buffer, buf.byteOffset + 12 + n * 4, n * dim));
  return { dim, n, scales: new Float32Array(ab), data };
}
function dotQ(q, rec, j) {
  const d = rec.dim, off = j * d, a = rec.data;
  let s = 0;
  for (let i = 0; i < d; i++) s += q[i] * a[off + i];
  return s * rec.scales[j];
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function readJson(file, def) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; } }
function sha1File(file) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', rej).on('end', () => res(h.digest('hex')));
  });
}

// «по СП 70», «ГОСТ 26433.2», «СНиП 3.03.01» → префиксы шифров
function codeHints(q) {
  const s = String(q || '');
  const out = [];
  const re = /(СП|SP|ГОСТ\s+Р|ГОСТ|GOST|СНиП|SNiP)\s*(\d{1,6}(?:\.\d{1,5}){0,3})/gi;
  let m;
  while ((m = re.exec(s))) {
    let k = m[1].toUpperCase().replace(/\s+/g, ' ');
    k = k === 'SP' ? 'СП' : k === 'GOST' ? 'ГОСТ' : k === 'SNIP' || k === 'СНИП' ? 'СНиП' : k;
    out.push((k + ' ' + m[2]).toLowerCase());
  }
  return out;
}
function matchesHint(label, hints) {
  const l = String(label || '').toLowerCase();
  return hints.some((h) => l === h || l.startsWith(h + '.') || l.startsWith(h + '-') || l.startsWith(h + ' '));
}

function builtinChunks() {
  return B.all().map((e, i) => ({
    i, page: 0, clause: e.clause, clauses: [e.clause], table: '', heading: e.topic, text: e.text,
    bid: e.id, doc: e.doc, docName: e.name, topic: e.topic,
    k: T.tokens(e.topic + '\n' + e.text + '\n' + (e.tags || '') + '\n' + e.doc, { syn: true })
  }));
}
function builtinHash() {
  return crypto.createHash('sha1').update(JSON.stringify(B.all().map((e) => [e.id, e.topic, e.text]))).digest('hex').slice(0, 16);
}

// ------------------------------------------------------------------ индекс
function createIndex(opts) {
  const o = opts || {};
  const dir = o.dir || normsDir();
  const workerPath = o.workerPath || path.join(__dirname, 'norms-worker.js');
  const workerTimeoutMs = o.workerTimeoutMs || 15 * 60 * 1000;
  const queryTimeoutMs = o.queryTimeoutMs || 8000;
  const F = { index: path.join(dir, 'index.json'), docs: path.join(dir, 'docs'), vec: path.join(dir, 'vec') };
  let st = readJson(F.index, null);
  if (!st || st.v !== 1) st = { v: 1, docs: [], vec: { model: '', dim: 0, builtin: '' } };
  if (!st.vec) st.vec = { model: '', dim: 0, builtin: '' };
  // незавершённые задачи после перезапуска — снова в очередь
  for (const d of st.docs) if (d.status === 'working' || d.status === 'queued') d.status = 'queued';
  const listeners = new Set();
  const chunkCache = new Map();
  const vecCache = new Map();
  let bm = null;           // построенный BM25
  let working = null;      // { id, worker, timer }
  let embedRun = null;     // { ctrl, model, done, total }
  let embedError = '';
  let stopped = false;

  const save = () => atomicWrite(F.index, JSON.stringify(st, null, 1));
  const emit = (ev) => { for (const fn of listeners) { try { fn(Object.assign({ status: status() }, ev || {})); } catch (e) {} } };
  const docById = (id) => st.docs.find((d) => d.id === id);
  const docLabel = (d) => d.code || d.name;

  function chunksOf(id) {
    if (chunkCache.has(id)) return chunkCache.get(id);
    let ch;
    if (id === BUILTIN_ID) ch = builtinChunks();
    else ch = (readJson(path.join(F.docs, id + '.json'), { chunks: [] }).chunks) || [];
    chunkCache.set(id, ch);
    return ch;
  }
  function vecsOf(id) {
    if (vecCache.has(id)) return vecCache.get(id);
    const r = readVec(path.join(F.vec, id + '.bin'));
    const ok = r && r.dim === st.vec.dim ? r : null;
    vecCache.set(id, ok);
    return ok;
  }
  function liveIds() { return [BUILTIN_ID].concat(st.docs.filter((d) => d.status === 'ok').map((d) => d.id)); }

  function buildBm() {
    const ids = liveIds();
    const post = new Map(); const lens = []; const refs = [];
    for (const id of ids) {
      const ch = chunksOf(id);
      for (let j = 0; j < ch.length; j++) {
        const ix = refs.length; refs.push([id, j]);
        const k = ch[j].k || [];
        lens.push(k.length);
        const tf = new Map();
        for (const t of k) tf.set(t, (tf.get(t) || 0) + 1);
        for (const [t, c] of tf) { let a = post.get(t); if (!a) post.set(t, a = []); a.push(ix, c); }
      }
    }
    const N = refs.length;
    const avg = N ? lens.reduce((a, b) => a + b, 0) / N : 1;
    bm = { post, lens, refs, N, avg: avg || 1 };
    return bm;
  }

  // ---------------------------------------------------------------- добавление
  async function addFiles(files) {
    const added = [], skipped = [];
    for (const f0 of files || []) {
      const file = path.resolve(String(f0));
      const ext = path.extname(file).slice(1).toLowerCase();
      try {
        if (!T.EXT_OK.includes(ext)) { skipped.push({ file, reason: 'формат .' + ext + ' не поддерживается' }); continue; }
        const s = fs.statSync(file);
        if (!s.isFile()) { skipped.push({ file, reason: 'не файл' }); continue; }
        if (s.size > MAX_FILE) { skipped.push({ file, reason: 'больше 300 МБ' }); continue; }
        if (!s.size) { skipped.push({ file, reason: 'пустой файл' }); continue; }
        const hash = await sha1File(file);
        const dup = st.docs.find((d) => d.hash === hash);
        if (dup) { if (dup.file !== file && !fs.existsSync(dup.file)) dup.file = file; skipped.push({ file, reason: 'уже в базе', id: dup.id }); continue; }
        const d = { id: hash.slice(0, 16), hash, name: path.basename(file), file, code: '', status: 'queued', error: '', pages: 0, chunks: 0,
          size: s.size, ocr: false, truncated: false, embedded: 0, added: new Date().toISOString() };
        st.docs.push(d); added.push({ id: d.id, name: d.name });
      } catch (e) { skipped.push({ file, reason: String(e.message || e) }); }
    }
    if (added.length) { save(); emit({ type: 'added' }); pump(); }
    return { added, skipped };
  }

  async function addFolder(folder) {
    const found = [];
    const walk = (d, depth) => {
      if (depth > 8 || found.length >= 5000) return;
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        if (found.length >= 5000) return;
        if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile() && T.EXT_OK.includes(path.extname(e.name).slice(1).toLowerCase())) found.push(p);
      }
    };
    walk(path.resolve(String(folder)), 0);
    const r = await addFiles(found);
    return Object.assign({ found: found.length }, r);
  }

  function runWorker(d) {
    return new Promise((resolve) => {
      let done = false;
      const { Worker } = require('worker_threads');
      let w;
      const fin = (m) => { if (done) return; done = true; clearTimeout(timer); try { w && w.terminate(); } catch (e) {} resolve(m); };
      try { w = new Worker(workerPath, { workerData: { file: d.file, ocr: o.ocr !== false, ocrCmd: o.ocrCmd, ocrLang: o.ocrLang } }); }
      catch (e) { resolve({ ok: false, error: String(e.message || e) }); return; }
      const timer = setTimeout(() => fin({ ok: false, error: 'Превышено время обработки' }), workerTimeoutMs);
      working = { id: d.id, worker: w, timer, cancel: () => fin({ ok: false, cancelled: true, error: 'Остановлено' }) };
      w.on('message', fin);
      w.on('error', (e) => fin({ ok: false, error: String((e && e.message) || e) }));
      w.on('exit', (c) => fin({ ok: false, error: 'Обработчик завершился (' + c + ')' }));
    });
  }

  let pumping = false;
  async function pump() {
    if (pumping || stopped) return;
    pumping = true;
    try {
      for (;;) {
        if (stopped) break;
        const d = st.docs.find((x) => x.status === 'queued');
        if (!d) break;
        if (!fs.existsSync(d.file)) { d.status = 'error'; d.error = 'Файл не найден'; save(); emit({ type: 'doc', id: d.id }); continue; }
        d.status = 'working'; d.error = ''; emit({ type: 'doc', id: d.id });
        const m = await runWorker(d);
        working = null;
        if (!docById(d.id)) continue; // удалён во время обработки
        if (m && m.cancelled) { d.status = 'queued'; break; }
        if (m && m.ok) {
          const chunks = m.chunks || [];
          atomicWrite(path.join(F.docs, d.id + '.json'), JSON.stringify({ id: d.id, code: m.code, chunks }));
          chunkCache.delete(d.id); vecCache.delete(d.id);
          try { fs.unlinkSync(path.join(F.vec, d.id + '.bin')); } catch (e) {}
          Object.assign(d, { status: chunks.length ? 'ok' : 'empty', code: m.code || '', pages: m.pages || 0, total: m.total || 0,
            chunks: chunks.length, ocr: !!m.ocr, truncated: !!m.truncated, kind: m.kind || '', engine: m.engine || '', embedded: 0,
            error: chunks.length ? '' : 'Текст не найден' });
        } else {
          Object.assign(d, { status: m && m.needsOcr ? 'scan' : 'error', error: (m && m.error) || 'Ошибка обработки', chunks: 0, embedded: 0 });
        }
        bm = null; save(); emit({ type: 'doc', id: d.id });
      }
    } finally { pumping = false; }
    if (!stopped) embedPending().catch(() => {});
  }

  function remove(id) {
    const d = docById(id);
    if (!d) return { ok: false, error: 'not_found' };
    if (working && working.id === id) working.cancel();
    st.docs = st.docs.filter((x) => x.id !== id);
    for (const f of [path.join(F.docs, id + '.json'), path.join(F.vec, id + '.bin')]) { try { fs.unlinkSync(f); } catch (e) {} }
    chunkCache.delete(id); vecCache.delete(id); bm = null;
    save(); emit({ type: 'removed', id });
    return { ok: true };
  }

  function reindex(id) {
    const list = id ? st.docs.filter((d) => d.id === id) : st.docs;
    for (const d of list) {
      if (working && working.id === d.id) continue;
      d.status = 'queued'; d.error = ''; d.embedded = 0;
    }
    save(); emit({ type: 'reindex' }); pump();
    return { ok: true, queued: list.length };
  }

  // ---------------------------------------------------------------- векторы
  // Повторный вызов во время прогона присоединяется к нему и досчитывает остаток.
  async function embedPending() {
    if (embedRun && embedRun.promise) {
      const r = await embedRun.promise;
      if (!r.ok) return r;
      const r2 = await embedPending();
      return r2.ok ? { ok: true, done: (r.done || 0) + (r2.done || 0) } : r2;
    }
    const p = embedOnce();
    if (embedRun && !embedRun.promise) embedRun.promise = p;
    return p;
  }
  async function embedOnce() {
    if (!o.embed || embedRun || stopped) return { ok: false, reason: embedRun ? 'running' : 'no_embed' };
    const model = typeof o.embedModel === 'function' ? o.embedModel() : o.embedModel;
    if (!model) return { ok: false, reason: 'no_model' };
    if (st.vec.model !== model) {
      st.vec = { model, dim: 0, builtin: '' };
      for (const d of st.docs) d.embedded = 0;
      try { for (const f of fs.readdirSync(F.vec)) fs.unlinkSync(path.join(F.vec, f)); } catch (e) {}
      vecCache.clear(); save();
    }
    const bh = builtinHash();
    const todo = [];
    if (st.vec.builtin !== bh) todo.push(BUILTIN_ID);
    for (const d of st.docs) if (d.status === 'ok' && (d.embedded || 0) < d.chunks) todo.push(d.id);
    if (!todo.length) return { ok: true, done: 0 };
    const ctrl = new AbortController();
    embedRun = { ctrl, model, done: 0, total: 0 };
    for (const id of todo) embedRun.total += id === BUILTIN_ID ? chunksOf(id).length : (docById(id).chunks - (docById(id).embedded || 0));
    embedError = '';
    emit({ type: 'embed' });
    try {
      for (const id of todo) {
        const d = id === BUILTIN_ID ? null : docById(id);
        if (id !== BUILTIN_ID && (!d || d.status !== 'ok')) continue;
        const ch = chunksOf(id);
        const file = path.join(F.vec, id + '.bin');
        const prev = id === BUILTIN_ID ? null : readVec(file);
        const list = [];
        if (prev && prev.dim === st.vec.dim && prev.n <= ch.length) {
          for (let j = 0; j < prev.n; j++) list.push({ scale: prev.scales[j], q: prev.data.subarray(j * prev.dim, (j + 1) * prev.dim) });
        }
        let since = 0;
        for (let j = list.length; j < ch.length; j += 8) {
          if (ctrl.signal.aborted || stopped) throw new Error('aborted');
          while (typeof o.isBusy === 'function' && o.isBusy()) {
            await new Promise((r) => setTimeout(r, 1000));
            if (ctrl.signal.aborted || stopped) throw new Error('aborted');
          }
          const batch = ch.slice(j, j + 8).map((c) => ((c.doc ? c.doc + '. ' : '') + (c.heading ? c.heading + '\n' : '') + c.text).slice(0, 2000));
          const vs = await o.embed(batch, { query: false, signal: ctrl.signal });
          if (!vs || vs.length !== batch.length) throw new Error('embed_failed');
          for (const v of vs) {
            if (!st.vec.dim) st.vec.dim = v.length;
            if (v.length !== st.vec.dim) throw new Error('embed_dim_mismatch');
            list.push(quantize(v));
          }
          embedRun.done += vs.length; since += vs.length;
          if (since >= 256 && id !== BUILTIN_ID) {
            since = 0; writeVec(file, concatVec(st.vec.dim, list)); vecCache.delete(id);
            if (d) d.embedded = list.length; save();
          }
          emit({ type: 'embed' });
        }
        writeVec(file, concatVec(st.vec.dim, list)); vecCache.delete(id);
        if (d) d.embedded = list.length; else st.vec.builtin = bh;
        save(); emit({ type: 'embed' });
      }
      return { ok: true, done: embedRun.done };
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (msg !== 'aborted') embedError = msg;
      return { ok: false, error: msg };
    } finally {
      embedRun = null; emit({ type: 'embed' });
    }
  }

  // ---------------------------------------------------------------- поиск
  function vecReady() {
    const model = typeof o.embedModel === 'function' ? o.embedModel() : o.embedModel;
    return !!(o.embed && model && st.vec.model === model && st.vec.dim);
  }

  async function search(query, sopts) {
    const so = sopts || {};
    const n = Math.max(1, Math.min(12, so.n || 6));
    const q = String(query || '').trim();
    if (!q) return { ok: false, error: 'empty_query', results: [] };
    if (!bm) buildBm();
    const hints = codeHints(q);
    const want = so.doc ? String(so.doc).toLowerCase().trim() : '';
    const labelOf = (id, c) => id === BUILTIN_ID ? c.doc : docLabel(docById(id) || { name: id });
    const allowed = (id, c) => {
      if (!want) return true;
      if (id === want) return true;
      const l = String(labelOf(id, c)).toLowerCase(), nm = id === BUILTIN_ID ? '' : String((docById(id) || {}).name || '').toLowerCase();
      return l.includes(want) || nm.includes(want) || matchesHint(l, codeHints(want));
    };
    // BM25
    const qt = Array.from(new Set(T.tokens(q, { syn: true })));
    const sc = new Map();
    for (const t of qt) {
      const p = bm.post.get(t);
      if (!p) continue;
      const df = p.length / 2;
      const idf = Math.log(1 + (bm.N - df + 0.5) / (df + 0.5));
      for (let i = 0; i < p.length; i += 2) {
        const ix = p[i], tf = p[i + 1], len = bm.lens[ix];
        const s = idf * tf * (K1 + 1) / (tf + K1 * (1 - BB + BB * len / bm.avg));
        sc.set(ix, (sc.get(ix) || 0) + s);
      }
    }
    const bmList = [...sc].filter(([ix]) => { const [id, j] = bm.refs[ix]; return allowed(id, chunksOf(id)[j]); })
      .sort((a, b) => b[1] - a[1]).slice(0, 50).map(([ix]) => bm.refs[ix][0] + '#' + bm.refs[ix][1]);
    // Векторы
    let vecList = [], vecUsed = false, vecCount = 0;
    if (vecReady()) {
      try {
        const ctrl = new AbortController();
        const tm = setTimeout(() => ctrl.abort(), queryTimeoutMs);
        if (so.signal) so.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
        let qv;
        try { qv = (await o.embed([q], { query: true, signal: ctrl.signal }))[0]; } finally { clearTimeout(tm); }
        if (qv && qv.length === st.vec.dim) {
          const all = [];
          for (const id of liveIds()) {
            if (id === BUILTIN_ID && st.vec.builtin !== builtinHash()) continue;   // r43: встроенная база обновилась — старые векторы не к тем фрагментам
            const rec = vecsOf(id);
            if (!rec) continue;
            const ch = chunksOf(id);
            vecCount += rec.n;
            for (let j = 0; j < Math.min(rec.n, ch.length); j++) {
              if (!allowed(id, ch[j])) continue;
              all.push([id + '#' + j, dotQ(qv, rec, j)]);
            }
          }
          all.sort((a, b) => b[1] - a[1]);
          const best = all.length ? all[0][1] : 0;
          const thr = Math.max(0.3, best - 0.2);
          vecList = all.filter((x) => x[1] >= thr).slice(0, 50).map((x) => x[0]);
          vecUsed = true;
        }
      } catch (e) { /* поиск по словам остаётся */ }
    }
    // RRF + буст по шифру
    const fused = new Map();
    bmList.forEach((key, r) => fused.set(key, (fused.get(key) || 0) + 1 / (RRF_K + r + 1)));
    vecList.forEach((key, r) => fused.set(key, (fused.get(key) || 0) + 1 / (RRF_K + r + 1)));
    if (hints.length) {
      for (const [key, v] of fused) {
        const [id, j] = key.split('#');
        if (matchesHint(labelOf(id, chunksOf(id)[+j]), hints)) fused.set(key, v * 1.6);
      }
    }
    const ranked = [...fused].sort((a, b) => b[1] - a[1]);
    const seen = new Set(); const results = [];
    for (const [key, score] of ranked) {
      const [id, js] = key.split('#'); const c = chunksOf(id)[+js];
      if (!c) continue;
      const label = labelOf(id, c);
      const dk = label + '|' + (c.clause || '') + '|' + (c.table || '') + '|' + (id === BUILTIN_ID ? '' : c.page);
      if (seen.has(dk)) continue; seen.add(dk);
      const text = c.text.length > 1400 ? c.text.slice(0, 1400) + '…' : c.text;
      if (id === BUILTIN_ID) {
        results.push({ source: 'встроенная база', id, doc: c.doc, name: c.docName, page: 0, clause: c.clause, table: '', topic: c.topic,
          cite: c.doc + ', ' + c.clause, text, note: B.NOTE, score: +score.toFixed(5) });
      } else {
        const d = docById(id) || {};
        results.push({ source: 'документ', id, doc: label, name: d.name, file: d.file, page: c.page, clause: c.clause, table: c.table,
          topic: c.heading, cite: T.citeOf(label, c), text, score: +score.toFixed(5) });
      }
      if (results.length >= n) break;
    }
    const out = { ok: true, query: q, results, searched: { chunks: bm.N, documents: st.docs.filter((d) => d.status === 'ok').length, vectors: vecUsed ? vecCount : 0 } };
    if (!results.length) out.note = 'В базе норм ничего не найдено по запросу. Добавьте нужный документ (СП, ГОСТ, проект) в «Базу норм» или переформулируйте вопрос.';
    return out;
  }

  // ---------------------------------------------------------------- состояние
  function status() {
    const model = typeof o.embedModel === 'function' ? o.embedModel() : o.embedModel;
    let total = 0, done = 0;
    const bn = B.all().length;
    total += bn; done += st.vec.builtin && st.vec.model === model ? bn : 0;
    for (const d of st.docs) if (d.status === 'ok') { total += d.chunks; done += st.vec.model === model ? Math.min(d.embedded || 0, d.chunks) : 0; }
    if (embedRun) done = Math.min(total, done + embedRun.done - (embedRun.saved || 0));
    return {
      dir,
      builtin: { entries: bn, docs: Object.keys(B.DOCS).length, note: B.NOTE },
      docs: st.docs.map((d) => ({ id: d.id, name: d.name, file: d.file, code: d.code, status: d.status, error: d.error, pages: d.pages,
        chunks: d.chunks, size: d.size, ocr: d.ocr, truncated: d.truncated, embedded: st.vec.model === model ? (d.embedded || 0) : 0,
        exists: fs.existsSync(d.file) })),
      chunks: bn + st.docs.reduce((a, d) => a + (d.status === 'ok' ? d.chunks : 0), 0),
      queue: st.docs.filter((d) => d.status === 'queued').length,
      working: working ? working.id : null,
      embed: { model: model || '', done, total, running: !!embedRun, error: embedError }
    };
  }

  function onProgress(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  // r43: после установки обновлений встроенной базы — пересобрать фрагменты и BM25, векторы досчитаются в фоне
  function refreshBuiltin() { chunkCache.delete(BUILTIN_ID); vecCache.delete(BUILTIN_ID); bm = null; emit({ type: 'builtin' }); Promise.resolve().then(pump).catch(() => {}); return builtinChunks().length; }
  function stop() {
    stopped = true;
    if (embedRun) embedRun.ctrl.abort();
    if (working) working.cancel();
    try { save(); } catch (e) {}
  }
  function start() { stopped = false; pump(); }

  return { dir, addFiles, addFolder, remove, reindex, embedPending, search, status, onProgress, stop, start, pump, refreshBuiltin,
    _chunksOf: chunksOf };
}

module.exports = { createIndex, normsDir, quantize, concatVec, readVec, writeVec, dotQ, codeHints, matchesHint, builtinChunks, BUILTIN_ID };
