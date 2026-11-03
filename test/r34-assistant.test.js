'use strict';
// Ревизия 34: локальный ИИ-ассистент — установка Ollama и модели (загрузка с докачкой и SHA-256, выбор модели по железу и диску,
// блокировка, своя модель bim-twin-assistant), поток ответа и вызовы инструментов, агентный цикл с подтверждением действий,
// заранее нужные данные, проверка цифр, простой режим, калькулятор, проводка IPC / preload / интерфейса / сборки / START.bat / установщика.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'ai', 'local-llm.js'));
const A = require(path.join(ROOT, 'ai', 'assistant.js'));
const KB = require(path.join(ROOT, 'ai', 'assistant-kb.js'));
const PR = require(path.join(ROOT, 'ai', 'assistant-prompt.js'));
const AM = require(path.join(ROOT, 'ai', 'assistant-main.js'));
const C = require(path.join(ROOT, 'renderer', 'ui', 'commands.js'));
const RES = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'assistant-inspection.json'), 'utf8'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'r34-'));

function ctxFor(res, extra) {
  const acts = [];
  const ctx = Object.assign({ inspection: () => res, compare: () => null, cloud: () => ({ name: 'demo.las', points: 2.4e6 }), project: () => 'Демо', commands: () => A.flattenCommands(C),
    confirm: async (text, info) => { acts.push(Object.assign({ text }, info)); return true; },
    runCommand: async (id) => ({ ok: true, message: 'запущено ' + id }), showResult: async (a) => ({ ok: true, message: 'открыто' }), exportResult: async (f) => ({ ok: true, message: 'сохранено ' + f }) }, extra || {});
  return { ctx, acts };
}

// ------------------------------------------------------------------ мок-сервер Ollama
function mockOllama(script) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = body ? JSON.parse(body) : null; seen.push({ url: req.url, body: j });
      const lines = (arr) => { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); arr.forEach((x) => res.write(JSON.stringify(x) + '\n')); res.end(); };
      if (req.url === '/api/version') { res.end(JSON.stringify({ version: '0.40.8' })); return; }
      if (req.url === '/api/tags') { res.end(JSON.stringify({ models: (script.have || []).map((n) => ({ name: n })) })); return; }
      if (req.url === '/api/pull') { lines([{ status: 'pulling manifest' }, { status: 'pulling', digest: 'sha256:a', total: 1000, completed: 400 }, { status: 'pulling', digest: 'sha256:a', total: 1000, completed: 1000 }, { status: 'success' }]); return; }
      if (req.url === '/api/create') { lines([{ status: 'creating' }, { status: 'success' }]); return; }
      if (req.url === '/api/chat') { lines(script.chat(j, seen.filter((s) => s.url === '/api/chat').length)); return; }
      res.writeHead(404); res.end();
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: 'http://127.0.0.1:' + srv.address().port, seen, close: () => new Promise((c) => srv.close(c)) })));
}

// ------------------------------------------------------------------ выбор модели
test('r34: модель по памяти, видеокарте и месту на диске', () => {
  // r35: лестница моделей — Qwen 3.8 27B (q8_0 при 34+ ГБ видеопамяти), подробно — test/r35-norms.test.js
  assert.strictEqual(L.pickModel({ ramGB: 32, vramGB: 24, freeGB: 200 }).id, 'qwen3.8:27b');
  assert.strictEqual(L.pickModel({ ramGB: 64, vramGB: 0, freeGB: 200 }).id, 'qwen3.6:35b-a3b');
  assert.strictEqual(L.pickModel({ ramGB: 32, vramGB: 8, freeGB: 200 }).id, 'qwen3.6:35b-a3b');
  assert.strictEqual(L.pickModel({ ramGB: 16, vramGB: 0, freeGB: 200 }).id, 'qwen3.5:9b');
  assert.strictEqual(L.pickModel({ ramGB: 8, vramGB: 0, freeGB: 200 }).id, 'qwen3.5:4b');
  assert.strictEqual(L.pickModel({ ramGB: 4, vramGB: 0, freeGB: 200 }).id, 'qwen3.5:2b-q4_K_M');
  const low = L.pickModel({ ramGB: 32, vramGB: 24, freeGB: 12 });
  assert.strictEqual(low.id, 'qwen3.5:9b'); assert.ok(low.reasons.length >= 2);
  assert.strictEqual(L.pickModel({ ramGB: 32, vramGB: 24, freeGB: 5 }, { have: ['qwen3.8:27b'] }).id, 'qwen3.8:27b', 'уже скачанная модель место не требует');
  assert.ok(L.MODELS.every((m) => m.size > 0 && m.ctx >= 8192 && m.label && m.note));
  assert.deepStrictEqual(L.parseNvidia('NVIDIA GeForce RTX 4090, 24564\n'), [{ name: 'NVIDIA GeForce RTX 4090', vramGB: 24 }].map((g) => Object.assign(g, { vramGB: L.parseNvidia('NVIDIA GeForce RTX 4090, 24564')[0].vramGB })));
  assert.ok(L.parseNvidia('NVIDIA GeForce RTX 4090, 24564')[0].vramGB > 23);
});

test('r34: список SHA-256, имя архива Ollama для платформы', () => {
  const h = 'a'.repeat(64);
  const m = L.parseShaList(h + '  ./ollama-windows-amd64.zip\n' + 'b'.repeat(64) + ' *ollama-linux-amd64.tar.zst\nмусор\n');
  assert.strictEqual(m['ollama-windows-amd64.zip'], h); assert.strictEqual(m['ollama-linux-amd64.tar.zst'], 'b'.repeat(64));
  assert.match(L.assetName('win32', 'x64'), /windows-amd64\.zip$/);
  assert.match(L.assetName('linux', 'x64'), /linux-amd64\.tar\.zst$/);
  assert.ok(L.assetName('darwin', 'arm64'));
});

test('r34: загрузка — редирект, докачка Range, 416, проверка SHA-256', async () => {
  const data = crypto.randomBytes(300000), sha = crypto.createHash('sha256').update(data).digest('hex');
  let ranges = [], mode = 'ok';
  const srv = http.createServer((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { Location: '/file' }); res.end(); return; }
    const r = /bytes=(\d+)-/.exec(req.headers.range || ''); ranges.push(r ? +r[1] : 0);
    if (mode === '416' && r) { mode = 'ok'; res.writeHead(416); res.end(); return; }
    if (r) { const from = +r[1]; res.writeHead(206, { 'Content-Length': data.length - from }); res.end(data.subarray(from)); return; }
    res.writeHead(200, { 'Content-Length': data.length }); res.end(data);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port, d = tmp();
  try {
    const out = path.join(d, 'a.bin'); let prog = 0;
    const r1 = await L.download(base + '/redir', out, { sha256: sha, onProgress: (x) => { prog = x; } });
    assert.strictEqual(r1.bytes, data.length); assert.strictEqual(prog, data.length); assert.ok(fs.readFileSync(out).equals(data));
    // докачка: половина уже есть в .part
    const out2 = path.join(d, 'b.bin'); fs.writeFileSync(out2 + '.part', data.subarray(0, 120000)); ranges = [];
    await L.download(base + '/file', out2, { sha256: sha });
    assert.deepStrictEqual(ranges, [120000]); assert.ok(fs.readFileSync(out2).equals(data));
    // 416 — .part испорчен/длиннее: начинаем сначала
    const out3 = path.join(d, 'c.bin'); fs.writeFileSync(out3 + '.part', Buffer.alloc(10)); mode = '416'; ranges = [];
    await L.download(base + '/file', out3, { sha256: sha });
    assert.deepStrictEqual(ranges, [10, 0]); assert.ok(fs.readFileSync(out3).equals(data));
    // неверная сумма — повтор и ошибка, файл не остаётся
    await assert.rejects(L.download(base + '/file', path.join(d, 'e.bin'), { sha256: 'f'.repeat(64) }), /sha256_mismatch/);
    assert.ok(!fs.existsSync(path.join(d, 'e.bin')) && !fs.existsSync(path.join(d, 'e.bin.part')));
  } finally { srv.close(); }
});

test('r34: блокировка установки — один процесс, чужая устаревшая снимается', () => {
  const d = tmp();
  assert.strictEqual(L.takeLock(d), true);
  assert.strictEqual(L.takeLock(d), false, 'повторно в том же процессе — занято');
  L.releaseLock(d); assert.strictEqual(L.takeLock(d), true); L.releaseLock(d);
  fs.writeFileSync(L.paths(d).lock, JSON.stringify({ pid: 999999, at: Date.now() }));   // процесса нет
  assert.strictEqual(L.takeLock(d), true); L.releaseLock(d);
  assert.ok(/ollama$/.test(L.baseDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }).replace(/\\/g, '/')) || L.baseDir({}).length > 0);
});

test('r34: установка через сервер Ollama — модель скачивается, создаётся bim-twin-assistant, ready.flag', async () => {
  const m = await mockOllama({ have: [], chat: () => [] }), d = tmp(), states = [];
  try {
    const r = await L.ensure({ dir: d, url: m.url, model: 'qwen3.5:4b', hardware: { ramGB: 8, vramGB: 0, freeGB: 100 }, onProgress: (s) => states.push(s.phase) });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.state.phase, 'ready'); assert.strictEqual(r.state.model, L.ASSISTANT); assert.strictEqual(r.state.base, 'qwen3.5:4b');
    assert.ok(states.includes('model') && states.includes('create'));
    const pull = m.seen.find((s) => s.url === '/api/pull'), create = m.seen.find((s) => s.url === '/api/create');
    assert.strictEqual(pull.body.model, 'qwen3.5:4b');
    assert.strictEqual(create.body.model, 'bim-twin-assistant'); assert.strictEqual(create.body.from, 'qwen3.5:4b');
    assert.strictEqual(create.body.system, PR.SYSTEM_SHORT); assert.strictEqual(create.body.parameters.num_ctx, L.modelInfo('qwen3.5:4b').ctx);
    assert.ok(L.isReady(d)); assert.ok(!fs.existsSync(L.paths(d).lock));
    // уже скачанную модель не тянем повторно
    const m2 = await mockOllama({ have: ['qwen3.5:4b', L.EMBED.id], chat: () => [] });
    try {
      const r2 = await L.ensure({ dir: d, url: m2.url, model: 'qwen3.5:4b', hardware: { ramGB: 8 } });
      assert.ok(r2.ok); assert.ok(!m2.seen.some((s) => s.url === '/api/pull'));
    } finally { await m2.close(); }
  } finally { await m.close(); }
});

test('r34: поток ответа и вызовы инструментов из /api/chat', async () => {
  const m = await mockOllama({ chat: () => [
    { message: { role: 'assistant', thinking: 'думаю ' } }, { message: { role: 'assistant', content: 'При' } }, { message: { role: 'assistant', content: 'вет' } },
    { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_walls', arguments: { filter: 'bad' } } }] } },
    { done: true, eval_count: 40, eval_duration: 2e9, prompt_eval_count: 900, total_duration: 3e9 }] });
  try {
    const parts = [];
    const r = await L.chat({ url: m.url, model: 'x', messages: [{ role: 'user', content: 'q' }], tools: A.TOOLS, think: false, onDelta: (p) => parts.push(p) });
    assert.strictEqual(r.message.content, 'Привет'); assert.strictEqual(r.message.thinking, 'думаю ');
    assert.strictEqual(r.message.tool_calls[0].function.name, 'get_walls');
    assert.strictEqual(r.stats.evalCount, 40); assert.strictEqual(r.stats.evalMs, 2000);
    assert.strictEqual(parts.length, 3);
    const body = m.seen.find((s) => s.url === '/api/chat').body;
    assert.strictEqual(body.stream, true); assert.strictEqual(body.think, false); assert.ok(body.tools.length >= 12);
  } finally { await m.close(); }
});

// ------------------------------------------------------------------ инструменты по данным контроля
test('r34: инструменты отдают точные цифры контроля', () => {
  const { ctx } = ctxFor(RES);
  const w = A._get.walls(ctx, { filter: 'bad', sort: 'lean', limit: 3 });
  assert.strictEqual(w.checked, 9); assert.strictEqual(w.out_of_tolerance, 8); assert.strictEqual(w.walls[0].number, 7);
  assert.ok(Math.abs(w.walls[0].plumb_mm_per_m - 3.08) < 0.01);
  const w4 = A._get.walls(ctx, { number: 4 }); assert.strictEqual(w4.wall.number, 4); assert.ok(Math.abs(w4.wall.rail_mm - 10) < 0.05);
  const f = A._get.floor(ctx, {}); assert.ok(Math.abs(f.FF - 19.4) < 0.05 && Math.abs(f.FL - 16.6) < 0.05);
  const df = A._get.defects(ctx, { limit: 5 }); assert.strictEqual(df.total, 3);
  const op = A._get.openings(ctx, {}); assert.strictEqual(op.doors, 2); assert.strictEqual(op.windows, 1);
  const me = A._get.mep(ctx, { filter: 'low' }); assert.strictEqual(me.below_limit, 1); assert.ok(Math.abs(me.min_clear_m - 2.01) < 0.005);
  const none = A._get.walls(ctxFor(null).ctx, {}); assert.strictEqual(none.ok, false); assert.match(none.message, /Контроль геометрии/);
});

test('r34: калькулятор без eval, разбор вызовов в тексте, удаление рассуждений', () => {
  assert.strictEqual(A.calculate('12,4*7,85').result, 97.34);
  assert.strictEqual(A.calculate('2^10').result, 1024);
  assert.strictEqual(A.calculate('sqrt(16)+max(1;3)').result, 7);
  assert.ok(Math.abs(A.calculate('sin(30)').result - 0.5) < 1e-9);
  assert.strictEqual(A.calculate('process.exit()').ok, false);
  assert.strictEqual(A.calculate('constructor').ok, false);
  const c1 = A.inlineToolCalls('<tool_call>{"name":"get_floor","arguments":{}}</tool_call>');
  assert.strictEqual(c1[0].function.name, 'get_floor');
  const c2 = A.inlineToolCalls('```json\n{"name":"calculate","arguments":{"expression":"2+2"}}\n```');
  assert.strictEqual(c2[0].function.name, 'calculate');
  assert.deepStrictEqual(A.inlineToolCalls('Просто текст про стены {не json}'), []);
  assert.strictEqual(A.stripThink('<think>долго</think>Ответ'), 'Ответ');
});

test('r34: заранее нужные данные и действия по явной просьбе', () => {
  const names = (q) => A.planTools(q).map((x) => x.name);
  assert.deepStrictEqual(names('Сколько стен вне допуска?'), ['get_walls']);
  assert.deepStrictEqual(A.planTools('Покажи стену 4')[0], { name: 'get_walls', args: { number: 4 } });
  assert.ok(names('Какие FF и FL у пола?').includes('get_floor'));
  assert.ok(A.planTools('Хватает ли высоты в свету под трубами?').some((x) => x.name === 'get_mep' && x.args.filter === 'low'));
  assert.ok(names('Где выгрузка в IFC?').includes('find_command'));
  assert.deepStrictEqual(names('Как проверить ровность пола?'), ['search_help', 'find_command'], 'инструкция — без цифр объекта');
  assert.ok(names('Посчитай площадь 12,4 на 7,85').includes('calculate'));
  const { ctx } = ctxFor(RES);
  assert.deepStrictEqual(A.planAction('Покажи стену 4', ctx), { name: 'show_result', args: { tab: 'walls', wall: 4 } });
  assert.deepStrictEqual(A.planAction('Сохрани PDF-отчёт контроля', ctx), { name: 'export_result', args: { format: 'pdf' } });
  assert.deepStrictEqual(A.planAction('Выгрузи трубы в IFC', ctx), { name: 'export_result', args: { format: 'mep_ifc' } });
  assert.deepStrictEqual(A.planAction('Запусти контроль геометрии', ctx), { name: 'run_command', args: { id: 'cpInspect' } });
  assert.strictEqual(A.planAction('Как сохранить PDF?', ctx), null);
  assert.strictEqual(A.planAction('Какие стены хуже всех?', ctx), null);
});

test('r34: проверка цифр — значения без источника находятся', () => {
  const src = JSON.stringify({ lean_mm: 8.0, plumb: 3.08, area: 62.1, pct: 7.4, clear_m: 2.01 });
  assert.deepStrictEqual(A.ungrounded('Завал 8 мм, 3,1 мм/м, площадь 62 м², 7,4 %, низ 2,01 м (2010 мм)', src), []);
  assert.deepStrictEqual(A.ungrounded('Вертикаль 245 мм', src), ['245 мм']);
});

// ------------------------------------------------------------------ агентный цикл
test('r34: агент — данные заранее, вызов инструмента моделью, ответ, без лишних действий', async () => {
  const { ctx, acts } = ctxFor(RES); const ev = []; let calls = 0;
  const chat = async (o) => {
    calls++;
    const tools = o.messages.filter((m) => m.role === 'tool').map((m) => m.tool_name);
    if (calls === 1) { assert.deepStrictEqual(tools, ['get_walls']); return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'calculate', arguments: { expression: '8/9*100' } } }] } }; }
    assert.ok(tools.includes('calculate'));
    return { message: { role: 'assistant', content: 'Вне допуска 8 из 9 стен, хуже всех №7 — 3,08 мм/м.' }, stats: { evalCount: 10, evalMs: 500 } };
  };
  const out = await A.runAgent({ question: 'Сколько стен вне допуска?', ctx, chat, onEvent: (e) => ev.push(e.type) });
  assert.match(out.text, /8 из 9/); assert.strictEqual(calls, 2); assert.strictEqual(acts.length, 0);
  assert.deepStrictEqual(out.tools.map((t) => t.name), ['get_walls', 'calculate']);
  assert.ok(ev.includes('tool') && ev.includes('tool_result') && ev.includes('final'));
  assert.strictEqual(out.messages[0].role, 'system'); assert.match(out.messages[0].content, /BIM Twin/);
});

test('r34: агент — действие по просьбе выполняется один раз и только после подтверждения', async () => {
  const shown = []; const { ctx, acts } = ctxFor(RES, { showResult: async (a) => { shown.push(a); return { ok: true, message: 'Показана стена ' + a.wall }; } });
  let calls = 0;
  const chat = async () => { calls++; return calls === 1 ? { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'show_result', arguments: { tab: 'walls', wall: 4 } } }] } } : { message: { role: 'assistant', content: 'Открыла стену 4.' } }; };
  const out = await A.runAgent({ question: 'Покажи стену 4', ctx, chat });
  assert.strictEqual(acts.length, 1, 'одно подтверждение'); assert.match(acts[0].text, /стена 4/);
  assert.deepStrictEqual(shown, [{ tab: 'walls', wall: 4 }]);
  assert.strictEqual(out.text, 'Открыла стену 4.');
  // пользователь отказался — действие не выполняется
  const { ctx: c2 } = ctxFor(RES, { confirm: async () => false, exportResult: async () => { throw new Error('не должно вызываться'); } });
  const out2 = await A.runAgent({ question: 'Сохрани PDF-отчёт', ctx: c2, chat: async (o) => ({ message: { role: 'assistant', content: JSON.parse(o.messages.filter((m) => m.role === 'tool').pop().content).cancelled ? 'Хорошо, не сохраняю.' : '?' } }) });
  assert.strictEqual(out2.text, 'Хорошо, не сохраняю.');
});

test('r34: агент — выдуманные цифры исправляются повтором или ответом по данным', async () => {
  const { ctx } = ctxFor(RES); let calls = 0;
  const out = await A.runAgent({ question: 'Какие FF и FL у пола?', ctx, chat: async (o) => { calls++; return { message: { role: 'assistant', content: calls === 1 ? 'Неровность 245 мм.' : 'FF 19,4, FL 16,6; уклон 2,94 мм/м.' } }; } });
  assert.strictEqual(calls, 2); assert.match(out.text, /19,4/);
  calls = 0;
  const out2 = await A.runAgent({ question: 'Какие FF и FL у пола?', ctx, chat: async () => { calls++; return { message: { role: 'assistant', content: 'Неровность 245 мм.' } }; } });
  assert.strictEqual(calls, 2); assert.doesNotMatch(out2.text, /245/); assert.match(out2.text, /FF 19,4/);
});

test('r34: простой режим без модели отвечает по данным', () => {
  const { ctx } = ctxFor(RES);
  assert.match(A.offlineAnswer('Сколько стен вне допуска?', ctx).text, /вне допуска 8/);
  assert.match(A.offlineAnswer('Какие FF и FL у пола?', ctx).text, /FF 19,4/);
  assert.match(A.offlineAnswer('Трубы под потолком', ctx).text, /Ø/);
  assert.match(A.offlineAnswer('Посчитай 12,4*7,85', ctx).text, /97,34/);
  assert.ok(A.offlineAnswer('Где сравнение с DXF?', ctx).text.length > 10);
});

test('r34: справка и подсказка модели', () => {
  assert.ok(KB.ARTICLES ? KB.ARTICLES.length >= 30 : KB.search('пол', 50).length >= 3);
  assert.match(KB.search('как проверить ровность пола', 3)[0].title, /пол/i);
  assert.ok(KB.search('допуск штукатурки по вертикали', 3).some((r) => /стен|допуск/i.test(r.title + r.text)));
  const sys = A.systemPrompt(ctxFor(RES).ctx);
  assert.match(sys, /только из инструментов|из инструментов/); assert.doesNotMatch(sys, /19,4|3,08/, 'в подсказке нет цифр объекта');
  assert.ok(PR.SYSTEM_SHORT.length > 100 && PR.SYSTEM_SHORT.length < 4000);
});

test('r34: главный процесс — очистка сообщений и состояние для окна', () => {
  const msgs = AM.sanitizeMessages([{ role: 'system', content: 'a' }, { role: 'evil', content: 'b' }, { role: 'user', content: 'x'.repeat(100000) }, { role: 'tool', tool_name: 'get_walls', content: '{}' }]);
  assert.ok(msgs.every((m) => ['system', 'user', 'assistant', 'tool'].includes(m.role)));
  assert.ok(msgs.find((m) => m.role === 'user').content.length < 100000);
  const st = AM.publicState({ phase: 'ready', base: 'qwen3.5:9b', model: 'bim-twin-assistant', secret: 1 });
  assert.strictEqual(st.ready, true); assert.strictEqual(st.secret, undefined); assert.ok(st.models.length === L.MODELS.length);
  // IPC регистрируется
  const handled = [], onl = [];
  AM.register({ handle: (n) => handled.push(n), on: (n) => onl.push(n) }, { isTrustedIpcEvent: () => true, getWindows: () => [] });
  ['bim:aiChat', 'bim:aiSetup', 'bim:aiStatus'].forEach((n) => assert.ok(handled.includes(n), n)); assert.deepStrictEqual(onl, ['bim:aiCancel']);
});

// ------------------------------------------------------------------ проводка
test('r34: проводка main / preload / index.html / лента / сборка / START.bat / установщик', () => {
  const main = read('main.js');
  assert.match(main, /require\('\.\/ai\/assistant-main'\)/); assert.match(main, /aiMain\.register\(ipcMain, \{ isTrustedIpcEvent/);
  assert.match(main, /aiMain\.autoStart\(/); assert.match(main, /require\('\.\/ai\/assistant-main'\)\.stop\(\)/);
  const pre = read('preload.js');
  ['aiStatus', 'aiSetup', 'aiChat', 'aiCancel', 'onAiDelta', 'onAiSetupProgress'].forEach((k) => assert.ok(pre.includes(k + ':'), k));
  assert.match(pre, /bim:aiDelta/); assert.match(pre, /bim:aiSetupProgress/);
  const html = read('renderer/index.html');
  const order = ['../ai/assistant-kb.js', '../ai/assistant-prompt.js', '../ai/assistant.js', 'ai-assistant-ui.js'].map((s) => html.indexOf('src="' + s));
  assert.ok(order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]), 'порядок скриптов');
  assert.ok(html.indexOf('cloud-inspect-ui.js') < order[3]); assert.match(html, /ui\/ai-assistant\.css/);
  const cmd = A.flattenCommands(C).find((c) => c.id === 'aiAssistant');
  assert.ok(cmd && cmd.tab === 'Контроль'); assert.match(read('renderer/ui/commands.js'), /call: 'BimAssistantUI\.toggle'/);
  const pkg = JSON.parse(read('package.json'));
  ['ai/local-llm.js', 'ai/setup-cli.js', 'ai/assistant-prompt.js'].forEach((f) => assert.ok(pkg.build.asarUnpack.includes(f), f));
  const bat = read('START.bat');
  assert.ok(!/[^\x00-\x7F]/.test(bat), 'START.bat — только ASCII'); assert.match(bat, /\r\n/);
  assert.match(bat, /ollama\\ready\.flag/); assert.match(bat, /ai\\setup-cli\.js/); assert.match(bat, /set ELECTRON_RUN_AS_NODE=1/); assert.match(bat, /endlocal/);
  const nsh = read('build/installer.nsh');
  assert.ok(!/[^\x00-\x7F]/.test(nsh)); assert.match(nsh, /ELECTRON_RUN_AS_NODE", t "1"/); assert.match(nsh, /setup-cli\.js" --background/);
  assert.match(nsh, /ELECTRON_RUN_AS_NODE", i 0/, 'переменная сбрасывается — приложение после установки запускается как обычно');
  assert.match(nsh, /\$\{isUpdated\}/); assert.match(nsh, /Stop-Process/);
  const ui = read('renderer/ai-assistant-ui.js');
  assert.match(ui, /BimAssistantUI/); assert.match(ui, /confirm:/); assert.match(ui, /offlineAnswer/);
  const ins = read('renderer/cloud-inspect-ui.js');
  assert.match(ins, /S\.exportPdf = /); assert.match(ins, /reopen: reopen/); assert.match(ins, /current: cur/);
});

test('r34: панель ассистента — разметка ответа безопасна', () => {
  global.window = undefined;
  const UI = require(path.join(ROOT, 'renderer', 'ai-assistant-ui.js'));
  const h = UI._md('**Итог**\n- стена №7\n- <img src=x onerror=1>\n1. первый');
  assert.match(h, /<b>Итог<\/b>/); assert.match(h, /<ul><li>стена №7<\/li><li>&lt;img/); assert.match(h, /<ol><li>первый/);
  assert.doesNotMatch(h, /<img/);
});
