'use strict';
// Ревизии 34–43: оценка ИИ-ассистента на настоящей локальной модели (Ollama).  node scripts/ai-eval.js [--model bim-twin-assistant] [--url http://127.0.0.1:11435] [--only 1,5] [--think]
// Данные контроля — test/fixtures/assistant-inspection.json; вопросы — ai/assistant-eval.json. Печатает итог и пишет отчёт в ai-eval-result.json.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const A = require(path.join(ROOT, 'ai', 'assistant.js'));
const L = require(path.join(ROOT, 'ai', 'local-llm.js'));
const C = require(path.join(ROOT, 'renderer', 'ui', 'commands.js'));
const res = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'assistant-inspection.json'), 'utf8'));
const E = JSON.parse(fs.readFileSync(path.join(ROOT, 'ai', 'assistant-eval.json'), 'utf8'));
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const model = arg('--model') || 'bim-twin-assistant', url = arg('--url') || null, think = process.argv.includes('--think');
const only = arg('--only') ? arg('--only').split(',').map(Number) : null;
const cmds = A.flattenCommands(C);
// r35: база норм — только встроенные статьи (временная папка); векторы — если в Ollama есть модель поиска (--embed qwen3-embedding:0.6b)
const NI = require(path.join(ROOT, 'ai', 'norms-index.js'));
const embedModel = arg('--embed');
const norms = NI.createIndex({ dir: fs.mkdtempSync(path.join(require('os').tmpdir(), 'bimtwin-eval-norms-')),
  embed: embedModel ? (t, o) => L.embed(Object.assign({ url, model: embedModel, input: t }, o || {})) : null, embedModel: embedModel || '' });

const MEM = require(path.join(ROOT, 'ai', 'assistant-memory.js'));
function memCtx() {
  const m = MEM.empty();
  return { add: (it) => MEM.add(m, it), parse: (t) => MEM.fromRemember(t), recall: (q, n) => MEM.recall(m, q, n), block: (q) => MEM.promptBlock(MEM.recall(m, q, 6)),
    best: (k, d) => MEM.bestParam(m, k, d), learn: (k, v, g) => MEM.learnParam(m, k, v, g), info: () => m.items.length ? MEM.summary(m).total + ' записей' : '',
    // r43: навыки (сценарии из нескольких команд)
    skills: () => MEM.skills(m), findSkill: (q) => MEM.findSkill(m, q), addSkill: (s) => MEM.addSkill(m, s), useSkill: (n) => MEM.useSkill(m, n) };
}
async function one(c) {
  const actions = [];
  const ctx = { inspection: () => res, cloud: () => ({ name: 'demo.las', points: 2.4e6 }), project: () => 'Демо', commands: () => cmds,
    confirm: async (text, info) => { actions.push(info); return true; },
    runCommand: async (id) => ({ message: 'выполнено: ' + id }), showResult: async (a) => ({ message: 'открыто' }), exportResult: async (f) => ({ message: 'сохранено: ' + f }),
    searchNorms: (q, o) => norms.search(q, o),
    // r42: команды «почисти облако» и «запомни …» — без настоящего облака, память в оперативной памяти
    cleanCloud: async (o) => ({ ok: true, message: 'очищено (' + o.thoroughness + ')', stats: { removed: 1000 } }), memory: memCtx(),
    // r43: проверка качества облака (результат как у BimCloudAudit на шумном скане), обновления баз — без сети
    auditCloud: async () => ({ ok: true, points: 2.4e6, spacing: 0.012, noise: 0.006, isolatedPct: 0.8, doubling: 0.1, loa: 'LOA20', grade: 'удовлетворительно',
      verdict: 'шум 6 мм, двоения нет, одиночных точек 0,8 %', suggest: { thoroughness: 'deep', micro: true, why: 'шум выше 5 мм и много одиночных точек' }, recommendations: [] }),
    updates: { check: async () => ({ ok: true, available: [], message: 'Все базы актуальны.' }), install: async () => ({ ok: true, installed: [], message: 'Нечего устанавливать.' }) },
    waitIdle: async () => ({ ok: true }) };
  const t0 = Date.now();
  const out = await A.runAgent({ question: c.q, ctx, think, chat: (o) => L.chat(Object.assign({}, o, { url, model })) });
  const used = out.tools.map(t => t.name), text = out.text || '';
  const toolOk = !c.tools || c.tools.some(t => used.includes(t));
  const mustOk = (c.must || []).every(re => new RegExp(re).test(text));
  let actOk = true;
  if (c.action) actOk = actions.some(a => a.tool === c.action.name && Object.keys(c.action.args).every(k => String(a.args[k]) === String(c.action.args[k])));
  return { q: c.q, ok: toolOk && mustOk && actOk, toolOk, mustOk, actOk, used, actions, text, seconds: (Date.now() - t0) / 1000 };
}
(async () => {
  const rows = [];
  if (embedModel) { const t0 = Date.now(); const er = await norms.embedPending(); console.log('векторы встроенной базы: ' + JSON.stringify(er) + ', ' + Math.round((Date.now() - t0) / 1000) + ' с'); }
  for (let i = 0; i < E.cases.length; i++) {
    if (only && !only.includes(i + 1)) continue;
    let r; try { r = await one(E.cases[i]); } catch (e) { r = { q: E.cases[i].q, ok: false, error: String(e && e.message || e), seconds: 0 }; }
    rows.push(r);
    console.log((r.ok ? 'OK  ' : 'FAIL') + ' ' + (i + 1) + '. ' + r.q + '  [' + (r.used || []).join(', ') + '] ' + r.seconds.toFixed(1) + ' с' + (r.error ? ' — ' + r.error : '') + '\n     ' + String(r.text || '').replace(/\s+/g, ' ').slice(0, 300));
  }
  const ok = rows.filter(r => r.ok).length;
  console.log('\nИтог: ' + ok + ' из ' + rows.length + ' (' + Math.round(ok / Math.max(1, rows.length) * 100) + ' %), модель ' + model + ', среднее ' + (rows.reduce((s, r) => s + r.seconds, 0) / Math.max(1, rows.length)).toFixed(1) + ' с');
  fs.writeFileSync(path.join(process.cwd(), 'ai-eval-result.json'), JSON.stringify({ model, think, at: new Date().toISOString(), ok, total: rows.length, rows }, null, 1));
  process.exit(0);
})();
