'use strict';
// Ревизия 35: «База норм» для ИИ-ассистента — разбор документов (PDF через pdf.js, DOCX, TXT, RTF) на пункты, таблицы
// и страницы, шифр документа, BM25 + векторы (int8) с объединением RRF, цитаты «документ, пункт, страница»;
// инструменты search_norms / look_at_view, простой режим по нормам, снимки вида, новая лестница моделей Qwen 3.8.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const T = require(path.join(ROOT, 'ai', 'norms-text.js'));
const NI = require(path.join(ROOT, 'ai', 'norms-index.js'));
const NB = require(path.join(ROOT, 'ai', 'norms-builtin.js'));
const L = require(path.join(ROOT, 'ai', 'local-llm.js'));
const A = require(path.join(ROOT, 'ai', 'assistant.js'));
const PR = require(path.join(ROOT, 'ai', 'assistant-prompt.js'));
const AM = require(path.join(ROOT, 'ai', 'assistant-main.js'));
// PDF-фикстура хранится в репозитории как .b64 (как LAZ-фикстуры); при отсутствии PDF раскладываем во временную папку
const FIX_PDF = (() => {
  const p = path.join(ROOT, 'test', 'fixtures', 'norms-test-sp.pdf');
  if (fs.existsSync(p)) return p;
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r35-fix-')), 'norms-test-sp.pdf');
  fs.writeFileSync(out, Buffer.from(fs.readFileSync(p + '.b64', 'utf8'), 'base64'));
  return out;
})();
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'r35-'));
let HAS_PDFJS = true;
try { require.resolve('pdfjs-dist/legacy/build/pdf.mjs'); } catch (_) { HAS_PDFJS = false; }

// минимальный ZIP (deflate) для DOCX
function zip(files) {
  const parts = [], central = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8'), comp = zlib.deflateRawSync(data), nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nm, comp); central.push(ch, nm); off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat(parts.concat([cd, end]));
}
const P = (t) => '<w:p><w:r><w:t>' + t + '</w:t></w:r></w:p>';
function docx(dir) {
  const xml = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' + P('ГОСТ Р 99999-2031 Тестовые полы') + P('4 Требования') +
    P('4.1 Отклонение поверхности покрытия от плоскости при проверке рейкой 2 м не должно превышать 2 мм.') +
    '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' + P('4.2 Уступы между смежными плитками не более 1 мм.') +
    '<w:tbl><w:tr><w:tc>' + P('Покрытие') + '</w:tc><w:tc>' + P('Просвет, мм') + '</w:tc></w:tr></w:tbl></w:body></w:document>';
  const f = path.join(dir, 'gost-test.docx');
  fs.writeFileSync(f, zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': xml }));
  return f;
}
function waitIdle(ix, ms) {
  const t0 = Date.now();
  return new Promise((res, rej) => { const t = setInterval(() => { const s = ix.status(); if (!s.working && !s.queue) { clearInterval(t); res(s); } else if (Date.now() - t0 > (ms || 30000)) { clearInterval(t); rej(new Error('timeout')); } }, 50); });
}
// фейковые векторы: «мешок» основ слов → 64 измерения (детерминированно), чтобы проверить гибридный поиск без модели
function fakeEmbed(texts) {
  return Promise.resolve(texts.map((t) => {
    const v = new Float32Array(64);
    for (const w of T.tokens(t, { syn: true })) { let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[h % 64] += 1; }
    return L.normalize(Array.from(v), 64);
  }));
}

// ------------------------------------------------------------------ текст
test('r35: основы слов, синонимы, токены', () => {
  assert.strictEqual(T.stem('вертикали'), T.stem('вертикаль'));
  assert.strictEqual(T.stem('стены'), T.stem('стена'));
  assert.strictEqual(T.stem('5.10'), '5.10'); assert.strictEqual(T.stem('СП'), 'сп');
  const k = T.tokens('Завал кирпичной стены 5,5 мм', { syn: true });
  assert.ok(k.includes('5.5')); assert.ok(k.includes(T.stem('вертикаль')), 'завал → вертикаль'); assert.ok(k.includes(T.stem('кладка')), 'кирпичный → кладка');
  assert.ok(!T.tokens('и в на по').length, 'служебные слова отброшены');
  assert.deepStrictEqual(T.tokens('гипсо-волокнистые').length, 2);
});

test('r35: шифр документа по имени файла и тексту', () => {
  assert.strictEqual(T.detectCode('SP_70.13330.2012.pdf', ''), 'СП 70.13330.2012');
  assert.strictEqual(T.detectCode('x.pdf', 'Национальный стандарт ГОСТ Р 58945-2020 Правила'), 'ГОСТ Р 58945-2020');
  assert.strictEqual(T.detectCode('x.pdf', 'СНиП 3.03.01-87'), 'СНиП 3.03.01-87');
  assert.strictEqual(T.detectCode('x.pdf', 'ГОСТ 26433.2-94 Система обеспечения'), 'ГОСТ 26433.2-94');
  assert.strictEqual(T.detectCode('проект.pdf', 'Пояснительная записка'), '');
});

test('r35: пункты, таблицы, приложения, колонтитулы и цитата', () => {
  const pages = [1, 2, 3].map((n) => ({ page: n, text: 'СП 999.13330 Тестовый\n' + (n === 1 ? '5 Перегородки\n5.1 Общие требования\n5.1.1 Отклонение от вертикали не более 5 мм.\n5.1.2 Неровность под рейкой 2 м не более 3 мм.'
    : n === 2 ? 'Таблица 5.2 — Допуски каркаса\nШаг стоек: ±2 мм' : 'Приложение А\nМетодика\nА.1 Вертикаль измеряют построителем плоскостей.') + '\n' + n }));
  const clean = T.cleanPages(pages);
  assert.ok(clean.every((p) => !/Тестовый/.test(p.text)), 'повторяющийся колонтитул удалён');
  assert.ok(clean.every((p) => !/^\d+$/m.test(p.text)), 'номер страницы удалён');
  const ch = T.chunkPages(clean);
  const c1 = ch.find((c) => /5\.1\.1/.test(c.text));
  assert.strictEqual(c1.page, 1); assert.ok(c1.clauses.includes('5.1.1'));
  const tb = ch.find((c) => c.table === '5.2'); assert.ok(tb); assert.strictEqual(T.citeOf('СП 999', tb), 'СП 999, табл. 5.2, с. 2');
  const an = ch.find((c) => c.page === 3); assert.match(T.citeOf('СП 999', an), /прил\. А|п\. А\.1/);
  assert.match(T.citeOf('СП 999', c1), /^СП 999, п\. 5\.1(\.1)?–5\.1\.2, с\. 1$/);
  // длинный пункт режется
  const long = T.chunkPages([{ page: 7, text: '6.1 Требование. ' + 'Текст пункта длинный. '.repeat(200) }], { maxLen: 500 });
  assert.ok(long.length > 3 && long.every((c) => c.text.length <= 760 && c.clause === '6.1' && c.page === 7));
});

test('r35: разбор DOCX (страницы по разрывам), TXT с отметками OCR, RTF', async () => {
  const d = tmp();
  const r = await T.extractPages(docx(d));
  assert.ok(r.ok); assert.strictEqual(r.pages.length, 2); assert.match(r.pages[1].text, /4\.2 Уступы/); assert.match(r.pages[1].text, /Покрытие \| Просвет/);
  fs.writeFileSync(path.join(d, 'ocr.txt'), '=== Страница 1 ===\n1.1 Первый\n\n=== Страница 2 ===\n2.1 Второй');
  const t = await T.extractPages(path.join(d, 'ocr.txt'));
  assert.deepStrictEqual(t.pages.map((p) => p.page), [1, 2]);
  fs.writeFileSync(path.join(d, 'a.rtf'), '{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 3.1 \\u1058?\\u1077?\\u1089?\\u1090? \\\'e4\\\'e0\\par 3.2 B}');
  const rt = await T.extractPages(path.join(d, 'a.rtf'));
  assert.ok(rt.ok); assert.match(rt.pages[0].text, /3\.1 Тест да/); assert.doesNotMatch(rt.pages[0].text, /Arial/);
  const bad = await T.extractPages(path.join(d, 'x.dwg')).catch((e) => ({ ok: false, error: e.message }));
  assert.strictEqual(bad.ok, false);
});

test('r35: PDF через pdf.js — страницы, шифр, пункты', { skip: !HAS_PDFJS && 'pdfjs-dist не установлен' }, async () => {
  const r = await T.extractPages(FIX_PDF);
  assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.engine, 'pdf.js'); assert.strictEqual(r.pages.length, 4);
  const pages = T.cleanPages(r.pages);
  assert.strictEqual(T.detectCode('norms-test-sp.pdf', pages.map((p) => p.text).join('\n')), 'СП 999.13330.2030');
  const ch = T.chunkPages(pages);
  assert.ok(ch.some((c) => c.table === '5.2' && c.page === 2));
  assert.ok(ch.some((c) => c.page === 3 && c.clauses.includes('5.2.1')));
});

// ------------------------------------------------------------------ индекс
test('r35: встроенная база — поиск по словам находит нужные статьи', async () => {
  const ix = NI.createIndex({ dir: tmp() });
  const top = async (q) => (await ix.search(q, { n: 2 })).results[0];
  assert.match((await top('отклонение монолитной стены от вертикали')).cite, /СП 70\.13330\.2012, табл\. 5\.10/);
  assert.match((await top('ширина эвакуационного выхода')).cite, /СП 1\.13130/);
  assert.match((await top('толщина швов кладки')).cite, /СП 70.*раздел 9/);
  assert.match((await top('защитный слой бетона')).cite, /СП 63/);
  assert.match((await top('категория технического состояния')).cite, /ГОСТ 31937/);
  const r = await ix.search('вертикаль', { n: 3 });
  assert.ok(r.results.every((x) => x.source === 'встроенная база' && x.note === NB.NOTE));
  const none = await ix.search('квантовая хромодинамика глюонов');
  assert.strictEqual(none.results.length, 0); assert.match(none.note, /База норм|«Базу норм»/);
  ix.stop();
});

test('r35: добавление документов, дедуп, цитата со страницей, фильтр, удаление', async () => {
  const d = tmp(), dir = path.join(d, 'norms'), docDir = path.join(d, 'docs');
  fs.mkdirSync(docDir); const f = docx(docDir);
  fs.writeFileSync(path.join(docDir, 'readme.dwg'), 'x');
  const ix = NI.createIndex({ dir });
  const a = await ix.addFolder(docDir);
  assert.strictEqual(a.added.length, 1); assert.strictEqual(a.found, 1);
  const st = await waitIdle(ix);
  assert.strictEqual(st.docs[0].status, 'ok', JSON.stringify(st.docs[0])); assert.strictEqual(st.docs[0].code, 'ГОСТ Р 99999-2031'); assert.strictEqual(st.docs[0].pages, 2);
  const again = await ix.addFiles([f]); assert.strictEqual(again.added.length, 0); assert.strictEqual(again.skipped[0].reason, 'уже в базе');
  const r = await ix.search('уступы между плитками');
  assert.strictEqual(r.results[0].source, 'документ'); assert.strictEqual(r.results[0].cite, 'ГОСТ Р 99999-2031, п. 4.2, с. 2'); assert.strictEqual(r.results[0].page, 2);
  const only = await ix.search('рейка 2 м', { doc: 'ГОСТ Р 99999' });
  assert.ok(only.results.length && only.results.every((x) => x.doc === 'ГОСТ Р 99999-2031'));
  // буст по шифру: «по ГОСТ Р 99999» поднимает документ над встроенной базой
  const hinted = await ix.search('отклонение от плоскости рейкой по ГОСТ Р 99999');
  assert.strictEqual(hinted.results[0].doc, 'ГОСТ Р 99999-2031');
  // сохранение и перезапуск
  ix.stop();
  const ix2 = NI.createIndex({ dir });
  assert.strictEqual(ix2.status().docs[0].chunks, st.docs[0].chunks);
  assert.strictEqual((await ix2.search('уступы между плитками')).results[0].page, 2);
  assert.ok(ix2.remove(st.docs[0].id).ok);
  assert.strictEqual(ix2.status().docs.length, 0); assert.ok(!fs.existsSync(path.join(dir, 'docs', st.docs[0].id + '.json')));
  assert.strictEqual((await ix2.search('уступы между плитками')).results.filter((x) => x.source === 'документ').length, 0);
  ix2.stop();
});

test('r35: PDF в базе — цитата с пунктом и страницей', { skip: !HAS_PDFJS && 'pdfjs-dist не установлен' }, async () => {
  const ix = NI.createIndex({ dir: tmp() });
  await ix.addFiles([FIX_PDF]); const st = await waitIdle(ix);
  assert.strictEqual(st.docs[0].status, 'ok'); assert.strictEqual(st.docs[0].code, 'СП 999.13330.2030');
  const r = await ix.search('шаг стоек каркаса');
  assert.strictEqual(r.results[0].cite, 'СП 999.13330.2030, табл. 5.2, с. 2');
  ix.stop();
});

test('r35: векторы int8 — квантование, файл, скалярное произведение', () => {
  const v = L.normalize([3, -4, 0, 1], 4), q = NI.quantize(v);
  const rec = NI.concatVec(4, [q, NI.quantize(L.normalize([0, 0, 1, 0], 4))]);
  const f = path.join(tmp(), 'v.bin'); NI.writeVec(f, rec);
  const back = NI.readVec(f);
  assert.strictEqual(back.n, 2); assert.strictEqual(back.dim, 4);
  assert.ok(Math.abs(NI.dotQ(v, back, 0) - 1) < 0.02); assert.ok(Math.abs(NI.dotQ(v, back, 1)) < 0.05);
  fs.writeFileSync(f, 'XXXX'); assert.strictEqual(NI.readVec(f), null);
  assert.deepStrictEqual(NI.codeHints('допуск по СП 70 и ГОСТ Р 58945'), ['сп 70', 'гост р 58945']);
  assert.ok(NI.matchesHint('СП 70.13330.2012', ['сп 70'])); assert.ok(!NI.matchesHint('СП 700.1', ['сп 70']));
});

test('r35: гибридный поиск — векторы считаются в фоне, ждут занятости, сбрасываются при смене модели', async () => {
  const d = tmp(); let model = 'fake-embed', busy = true, calls = 0;
  const ix = NI.createIndex({ dir: d, embed: (t, o) => { calls++; return fakeEmbed(t, o); }, embedModel: () => model, isBusy: () => busy });
  await ix.addFiles([docx(tmp())]); await waitIdle(ix);
  const run = ix.embedPending();
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(calls, 0, 'пока ассистент отвечает, векторы не считаются'); assert.ok(ix.status().embed.running);
  busy = false; const er = await run;
  assert.ok(er.ok, JSON.stringify(er));
  const s = ix.status(); assert.strictEqual(s.embed.done, s.embed.total); assert.ok(s.docs[0].embedded === s.docs[0].chunks);
  const r = await ix.search('уступы смежных плиток');
  assert.ok(r.searched.vectors > 0); assert.strictEqual(r.results[0].cite, 'ГОСТ Р 99999-2031, п. 4.2, с. 2');
  model = 'other-embed';
  assert.strictEqual(ix.status().docs[0].embedded, 0, 'другая модель — векторы не годятся');
  const r2 = await ix.search('уступы смежных плиток'); assert.strictEqual(r2.searched.vectors, 0, 'старые векторы не используются');
  await ix.embedPending(); assert.ok(ix.status().docs[0].embedded > 0);
  ix.stop();
});

// ------------------------------------------------------------------ ассистент
test('r35: инструменты search_norms и look_at_view, выбор заранее', async () => {
  const names = A.TOOLS.map((t) => t.function.name);
  assert.ok(names.includes('search_norms') && names.includes('look_at_view'));
  assert.ok(!A.toolsFor({}).some((t) => t.function.name === 'look_at_view'), 'без зрения инструмента нет');
  assert.ok(A.toolsFor({ vision: () => true, captureView: () => 0, searchNorms: () => 0 }).some((t) => t.function.name === 'look_at_view'));
  const pl = (q) => A.planTools(q).map((x) => x.name);
  assert.deepStrictEqual(pl('Какой допуск вертикали по СП 70?'), ['search_norms']);
  assert.strictEqual(A.planTools('Какой допуск вертикали по СП 70?')[0].args.doc, 'СП 70');
  assert.deepStrictEqual(pl('можно ли класть плитку на клей'), ['search_norms']);
  assert.deepStrictEqual(pl('какая толщина защитного слоя бетона'), ['search_norms']);
  assert.deepStrictEqual(pl('Сколько стен вне допуска?'), ['get_walls'], 'вопрос о данных объекта не идёт в нормы');
  assert.ok(pl('стена 3 укладывается в допуск по СП 70?').includes('get_walls') && pl('стена 3 укладывается в допуск по СП 70?').includes('search_norms'));
  const ix = NI.createIndex({ dir: tmp() });
  const ctx = { searchNorms: (q, o) => ix.search(q, o) };
  const r = await A.execTool('search_norms', { query: 'защитный слой бетона' }, ctx);
  assert.ok(r.ok && r.found > 0); assert.match(r.results[0].cite, /СП 63/); assert.match(r.note, /краткое изложение/);
  assert.ok(!('_src' in JSON.parse(JSON.stringify(r))), 'служебные данные окна не уходят модели'); assert.ok(r._src[0].cite);
  assert.strictEqual((await A.execTool('search_norms', {}, ctx)).ok, false);
  assert.strictEqual((await A.execTool('look_at_view', {}, ctx)).ok, false);
  const v = await A.execTool('look_at_view', { focus: 'стены' }, { vision: () => true, captureView: async () => ({ ok: true, image: 'QUJD' }) });
  assert.strictEqual(v._image, 'QUJD');
  ix.stop();
});

test('r35: агент — нормы заранее, снимок вида уходит картинкой, ответ с цитатой', async () => {
  const ix = NI.createIndex({ dir: tmp() });
  const seen = [];
  const ctx = { searchNorms: (q, o) => ix.search(q, o), vision: () => true, captureView: async () => ({ ok: true, image: 'SU1H' }) };
  let n = 0;
  const chat = async (o) => {
    seen.push(o); n++;
    if (n === 1) return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'look_at_view', arguments: {} } }] } };
    return { message: { role: 'assistant', content: 'По СП 70.13330.2012 (табл. 5.10, п. 1) для стен под монолитные перекрытия — 15 мм.' } };
  };
  const out = await A.runAgent({ question: 'Какой допуск вертикали монолитной стены по СП 70?', ctx, chat, images: ['QUJD'] });
  assert.match(out.text, /15 мм/); assert.ok(out.tools.some((t) => t.name === 'search_norms' && t.prefetch));
  const m1 = seen[0].messages;
  assert.deepStrictEqual(m1.find((m) => m.role === 'user' && m.images).images, ['QUJD']);
  assert.ok(seen[0].tools.some((t) => t.function.name === 'look_at_view'));
  const m2 = seen[1].messages;
  assert.ok(m2.some((m) => m.role === 'user' && m.images && m.images[0] === 'SU1H'), 'снимок после look_at_view');
  assert.ok(!m2.some((m) => m.role === 'tool' && /SU1H/.test(m.content)), 'картинка не в JSON инструмента');
  assert.match(PR.build({}), /search_norms/); assert.match(PR.SYSTEM_SHORT, /search_norms/);
  assert.match(PR.build({ norms: 'встроенная + 2', vision: true }), /база норм: встроенная \+ 2[\s\S]*look_at_view/);
  ix.stop();
});

test('r35: простой режим отвечает по базе норм', async () => {
  const ix = NI.createIndex({ dir: tmp() });
  const ctx = { searchNorms: (q, o) => ix.search(q, o) };
  const a = await A.offlineNorms('Какой допуск вертикали монолитных стен по СП 70?', ctx);
  assert.ok(a && a.offline); assert.match(a.text, /СП 70\.13330\.2012/); assert.deepStrictEqual(a.tools, ['search_norms']); assert.ok(a.src.length);
  assert.strictEqual(await A.offlineNorms('сколько стен вне допуска', {}), null);
  ix.stop();
});

// ------------------------------------------------------------------ модели, главный процесс, проводка
test('r35: лестница моделей Qwen 3.8 и модель поиска', () => {
  const id = (h) => L.pickModel(Object.assign({ freeGB: 500 }, h)).id;
  assert.strictEqual(id({ ramGB: 64, vramGB: 48 }), 'qwen3.8:27b-q8_0');
  assert.strictEqual(id({ ramGB: 32, vramGB: 24 }), 'qwen3.8:27b');
  assert.strictEqual(id({ ramGB: 64, vramGB: 0 }), 'qwen3.6:35b-a3b');
  assert.strictEqual(id({ ramGB: 16, vramGB: 0 }), 'qwen3.5:9b');
  assert.strictEqual(id({ ramGB: 8, vramGB: 0 }), 'qwen3.5:4b');
  assert.strictEqual(id({ ramGB: 4, vramGB: 0 }), 'qwen3.5:2b-q4_K_M');
  assert.ok(L.modelInfo('qwen3.8:27b').ctx >= 32768 && L.modelInfo('qwen3.8:27b').vision);
  assert.strictEqual(L.EMBED.id, 'qwen3-embedding:0.6b'); assert.ok(L.EMBED_MODELS.length >= 2);
  const n = L.normalize([3, 4, 12], 2); assert.strictEqual(n.length, 2); assert.ok(Math.abs(n[0] * n[0] + n[1] * n[1] - 1) < 1e-6);
  assert.strictEqual(L.embedInfo('qwen3-embedding:0.6b:latest').id, 'qwen3-embedding:0.6b');
});

test('r35: главный процесс — картинки в сообщениях, состояние, IPC базы норм', async () => {
  const big = 'A'.repeat(5 * 1024 * 1024);
  const m = AM.sanitizeMessages([{ role: 'user', content: 'x', images: ['QUJD', big, '<svg>', 'SU1H', 'QUFB'] }, { role: 'assistant', content: 'y', images: ['QUJD'] }]);
  assert.deepStrictEqual(m[0].images, ['QUJD', 'SU1H']); assert.strictEqual(m[1].images, undefined);
  const st = AM.publicState({ phase: 'ready', vision: true, caps: ['completion', 'vision'], embed: 'qwen3-embedding:0.6b', embedPhase: 'ready', embedPct: 100 });
  assert.strictEqual(st.vision, true); assert.strictEqual(st.embedPhase, 'ready'); assert.strictEqual(st.embed, 'qwen3-embedding:0.6b');
  const H = {}, on = {};
  const ix = NI.createIndex({ dir: tmp() }); AM._setNorms(ix);
  AM.register({ handle: (n, f) => { H[n] = f; }, on: (n, f) => { on[n] = f; } }, { isTrustedIpcEvent: (e) => !e.evil, getWindows: () => [] });
  ['bim:normsStatus', 'bim:normsAddFiles', 'bim:normsAddFolder', 'bim:normsRemove', 'bim:normsReindex', 'bim:normsSearch', 'bim:normsOpen', 'bim:aiCaptureView'].forEach((k) => assert.ok(H[k], k));
  const s = await H['bim:normsStatus']({}); assert.ok(s.ok); assert.strictEqual(s.builtin.entries, NB.all().length);
  const r = await H['bim:normsSearch']({}, { query: 'защитный слой бетона' }); assert.match(r.results[0].cite, /СП 63/);
  await assert.rejects(() => H['bim:normsSearch']({ evil: 1 }, { query: 'x' }), /untrusted/);
  await assert.rejects(() => H['bim:normsRemove']({ evil: 1 }, { id: 'x' }), /untrusted/);
  assert.strictEqual((await H['bim:normsOpen']({}, { id: 'nope' })).ok, false);
  ix.stop(); AM._setNorms(null);
});

test('r35: проводка preload / интерфейс / сборка / справка', () => {
  const pre = read('preload.js');
  ['normsStatus', 'normsAddFiles', 'normsAddFolder', 'normsRemove', 'normsReindex', 'normsSearch', 'normsOpen', 'onNormsProgress', 'aiCaptureView'].forEach((k) => assert.ok(pre.includes(k + ':'), k));
  const ui = read('renderer/ai-assistant-ui.js');
  assert.match(ui, /data-act="norms"/); assert.match(ui, /searchNorms:/); assert.match(ui, /captureView:/); assert.match(ui, /renderSources/);
  assert.doesNotMatch(ui, /q\('form'\)/, 'форма чата берётся явно (в панели две формы)');
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.dependencies['pdfjs-dist']); assert.ok(pkg.build.asarUnpack.includes('node_modules/pdfjs-dist/legacy/**'));
  assert.ok(pkg.build.files.includes('ai/**'));
  const KB = require(path.join(ROOT, 'ai', 'assistant-kb.js'));
  assert.strictEqual(KB.search('как добавить СП в базу норм', 1)[0].title, 'База норм: СП, ГОСТ, проекты');
  assert.match(read('renderer/index.html'), /ai-assistant-ui\.js\?v=1350/);
  assert.match(read('renderer/ui/ai-assistant.css'), /\.ai-norms/);
});

test('r35: ответ по нормам без названия документа получает строку «Источник»', () => {
  const r = { ok: true, results: [
    { cite: 'СП 63.13330.2018 раздел 10, табл. 10.1', source: 'встроенная база', text: 'в закрытых помещениях при нормальной влажности — 20 мм; на открытом воздухе — 30 мм' },
    { cite: 'СП 70.13330.2012 табл. 5.10, п. 1', source: 'встроенная база', text: 'отклонение от вертикали 0,001 высоты' }] };
  const msgs = [{ role: 'tool', tool_name: 'search_norms', content: JSON.stringify(r) }];
  const t = A.withSource('Защитный слой — **20 мм**.', msgs);
  assert.match(t, /Источник: СП 63\.13330\.2018 раздел 10, табл\. 10\.1 \(встроенная база/);
  assert.strictEqual(A.withSource('По СП 63 — 20 мм.', msgs), 'По СП 63 — 20 мм.', 'документ уже назван');
  assert.strictEqual(A.withSource('Стена 4 вне допуска.', []), 'Стена 4 вне допуска.', 'без поиска по нормам — без изменений');
  const cut = JSON.stringify(r).slice(0, 120) + '…';
  assert.match(A.withSource('Слой 20 мм.', [{ role: 'tool', tool_name: 'search_norms', content: cut }]), /Источник: СП 63/);
});

test('r35: тега новой модели нет в Ollama — установка берёт следующую ступень', async () => {
  const http = require('http'), seen = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = body ? JSON.parse(body) : null; seen.push({ url: req.url, body: j });
      const lines = (arr) => { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); arr.forEach((x) => res.write(JSON.stringify(x) + '\n')); res.end(); };
      if (req.url === '/api/version') { res.end(JSON.stringify({ version: '0.40.8' })); return; }
      if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [] })); return; }
      if (req.url === '/api/pull') { if (/^qwen3\.8/.test(j.model)) lines([{ status: 'pulling manifest' }, { error: 'pull model manifest: file does not exist' }]); else lines([{ status: 'success' }]); return; }
      if (req.url === '/api/create') { lines([{ status: 'success' }]); return; }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port, d = fs.mkdtempSync(path.join(os.tmpdir(), 'r35-ladder-'));
  try {
    const r = await L.ensure({ dir: d, url, embed: false, hardware: { ramGB: 32, vramGB: 24, freeGB: 200 } });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.state.base, 'qwen3.6:35b-a3b');
    assert.ok(r.state.reasons.some((x) => /Qwen 3\.8 27B недоступна/.test(x)));
    assert.deepStrictEqual(seen.filter((s) => s.url === '/api/pull').map((s) => s.body.model), ['qwen3.8:27b', 'qwen3.6:35b-a3b']);
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'r35-ladder-'));
    const r2 = await L.ensure({ dir: d2, url, embed: false, model: 'qwen3.8:27b', hardware: { ramGB: 32, vramGB: 24, freeGB: 200 } });
    assert.ok(!r2.ok, 'модель, выбранная вручную, не подменяется');
  } finally { await new Promise((c) => srv.close(c)); }
});
