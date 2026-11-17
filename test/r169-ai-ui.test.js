'use strict';
/*
 * r169: jsdom-проверки интеграции ИИ-ассистента:
 *  • контекст приложения передаётся в запрос (appPack/promptBlock через _ctx);
 *  • «Что это?» не блокируется потоковым облаком (getCloud только как sample в base[0]) — баг гейта;
 *  • локальный интент-парсер отвечает без модели фактами из контекста и честно «не знаю»;
 *  • «Что это?» по выделению/инспектору использует auto-measure и открывает карточку в чате;
 *  • событие lx-ai-what-is от инспектора открывает ответ.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }
const R = path.join(__dirname, '..', 'renderer');
const read = (f) => fs.readFileSync(path.join(R, f), 'utf8');
const skip = !JSDOM && 'jsdom не установлен';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEnv() {
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div id="lxLegacy"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const log = { toasts: [], hydrate: 0 };
  const pos = new Float32Array(60 * 3);
  for (let i = 0; i < 60; i++) { pos[i * 3] = (i % 10) * 0.2; pos[i * 3 + 1] = Math.floor(i / 20) * 0.5; pos[i * 3 + 2] = (i % 5) * 0.3; }
  const sel = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const viewer = {
    bbox: { mn: [0, 0, 0], mx: [2, 1.5, 1.5] },
    base: [{ pos, col: null, _spacing: 0.02 }],
    _cloudRecord: { sourceName: 'D:/scan/room.las', sourceCount: 60, loadedCount: 60 },
    _sel: sel,
    selectionCount: () => sel.size,
    getEditedCloud: () => null,   // как у большого/потокового облака
    render: () => { }
  };
  w.__lxKit = { toast: (m) => { log.toasts.push(String(m)); }, hydrate: () => { log.hydrate++; }, ask: async () => true };
  w.__pcTools = { viewer: () => viewer, getCloud: () => ({ pos, col: null, classification: null, count: 60, sample: true }), getSourceCrs: () => null, getSourceTransform: () => null };
  w.__bimCurrentCloudPath = 'D:/scan/room.las';
  w.__viewer = viewer;
  w.bimAPI = { aiStatus: async () => ({ ready: false, phase: 'none' }), normsStatus: async () => ({ builtin: { entries: 12 }, docs: [] }) };
  w.__lxCommands = { TABS: [] };
  w.__lxRibbon = { button: () => null, activeTab: null };
  w.CloudInspectUI = {
    current: () => ({
      fileName: 'room.las', project: 'Тест-проект', dxfName: 'plan.dxf',
      res: { walls: [{ ok: true }, { ok: false }], floor: { FF: 12.345, FL: 12.3, mmPerM: 1.1, area: 32.5 }, defects: [{ depth: 3 }], openings: [{}, {}], rooms: [{ area: 18 }], mep: { pipes: 2, beams: 1 } },
      cmp: { walls: 2, matched: 1, mismatch: 1 }
    })
  };
  w.__lxScan2BIM = { state: { model: { ok: true, storeys: [{ name: 'Этаж 1', height: 3 }], walls: [{ length: 4, openings: [{ kind: 'door' }] }], slabs: [{}], rooms: [{ area: 18 }], pipes: [1] } }, open: () => { } };
  w.BimProjectState = { ready: Promise.resolve(), snapshot: () => ({ metadata: { projectName: 'Тест-проект' }, measurements: [{ label: 'Толщина стены', value: 0.2, unit: 'м' }], documents: [{ name: 'ТЗ.pdf', status: 'ok' }] }), projectId: 'prj-1', revision: 1 };
  w.__bimProjectName = 'Тест-проект';
  const autoMain = { title: 'Стена', family: 'wall', role: 'wall', score: 0.93, center: [1, 0.75, 0.75], dims: [
    { key: 'length', label: 'Длина', value: 2, unit: 'м', text: '2,00 м' },
    { key: 'height', label: 'Высота', value: 1.5, unit: 'м', text: '1,50 м' },
    { key: 'thickness', label: 'Толщина', value: 0.2, unit: 'м', text: '200 мм' }
  ] };
  const autoRes = { ok: true, objects: [autoMain], main: autoMain, info: { spacing: 0.02 }, rejected: [] };
  w.AutoMeasure = { analyze: (p, n) => { log.autoArgs = { n }; return autoRes; } };
  w.__lxObjectInspector = { state: { auto: { res: autoRes, busy: false } } };
  w.eval(read('ai-context.js'));
  w.eval(read('ai-intent.js'));
  w.eval(read('ai-assistant-ui.js'));
  return { w, dom, log, viewer, sel, autoRes };
}

test('r169 UI (jsdom): контекст приложения собирается и передаётся в запрос (облако/элемент/инспекция/модель)', { skip }, () => {
  const { w, dom } = makeEnv();
  try {
    const UI = w.BimAssistantUI;
    assert.ok(UI, 'BimAssistantUI загружен');
    const pack = UI._appPack();
    assert.ok(pack, 'appPack есть');
    assert.equal(pack.cloud.name, 'room.las');
    assert.equal(pack.cloud.points, 60);
    assert.ok(pack.element && pack.element.type === 'wall', 'элемент из инспектора');
    assert.equal(pack.inspection.available, true);
    assert.equal(pack.inspection.summary.walls, 2);
    assert.equal(pack.model.open, true);
    const block = UI._promptBlock();
    assert.match(block, /СЕЙЧАС В ПРИЛОЖЕНИИ/);
    assert.match(block, /room\.las/);
    assert.match(block, /Стена/);
    assert.match(block, /не выдумывай|не подменяй/i);
    const ctx = UI._ctx();
    assert.equal(typeof ctx.appContext, 'function');
    assert.equal(ctx.appContext().cloud.points, 60);
    assert.equal(ctx.selection().active, true);
    assert.equal(ctx.element().type, 'wall');
    assert.ok(ctx.checks().length >= 3, 'проверки инспектора в контексте');
  } finally { try { dom.window.close(); } catch (e) { } }
});

test('r169 UI (jsdom): «Что это?» не требует getEditedCloud (потоковое облако) — гейт не срабатывает', { skip }, () => {
  const { w, dom, log } = makeEnv();
  try {
    const UI = w.BimAssistantUI;
    UI.open();
    UI.pick();
    assert.equal(UI._state().picking, true, 'режим выбора включён на потоковом облаке');
    assert.equal(log.toasts.some((t) => /Откройте облако точек/.test(t)), false, 'ложного «Откройте облако» нет');
    assert.ok(w.__bimPick && w.__bimPick.active, '__bimPick включён');
  } finally { try { dom.window.close(); } catch (e) { } }
});

test('r169 UI (jsdom): локальный ответ без модели — толщина по выделению/инспектору, с фактами', { skip }, async () => {
  const { w, dom, log } = makeEnv();
  try {
    const UI = w.BimAssistantUI;
    UI.open();
    await UI.ask('какая толщина у стены?');
    await wait(50);
    const st = UI._state();
    const last = st.history.filter((m) => m.role === 'assistant').slice(-1)[0] || {};
    assert.match(last.content, /Толщина/);
    assert.match(last.content, /200 мм|0,2/);
    const msg = w.document.querySelectorAll('.ai-msg.ai-bot');
    assert.ok(msg.length >= 1);
  } finally { try { dom.window.close(); } catch (e) { } }
});

test('r169 UI (jsdom): неизвестный вопрос офлайн — честное «не знаю» и предложения действий', { skip }, async () => {
  const { w, dom } = makeEnv();
  try {
    const UI = w.BimAssistantUI;
    UI.open();
    await UI.ask('расскажи анекдот про стройку');
    await wait(40);
    const text = w.document.querySelector('.ai-msg.ai-bot') ? w.document.querySelector('.ai-msg.ai-bot').textContent : '';
    assert.match(text, /Не знаю/);
    assert.match(text, /Что можно сделать|База норм|Открыть контроль|выделите/i);
    const st = UI._state();
    const last = st.history.filter((m) => m.role === 'assistant').slice(-1)[0] || {};
    assert.match(last.content, /Не знаю/);
  } finally { try { dom.window.close(); } catch (e) { } }
});

test('r169 UI (jsdom): «Что это?» по выделению — карточка с типом/размерами из auto-measure', { skip }, async () => {
  const { w, dom, log } = makeEnv();
  try {
    const UI = w.BimAssistantUI;
    const r = await UI.explainSelection({ model: false });
    assert.equal(r.ok, true);
    assert.equal(r.element.type, 'wall');
    assert.ok(log.autoArgs && log.autoArgs.n >= 10, 'классификатор получил выделенные точки');
    const st = UI._state();
    assert.ok(st.picked && st.picked.el && st.picked.el.type === 'wall');
    const bots = w.document.querySelectorAll('.ai-msg.ai-bot');
    const text = Array.from(bots).map((b) => b.textContent).join('\n');
    assert.match(text, /Стена|стена/);
    assert.match(text, /Толщина|200 мм/);
    assert.equal(log.toasts.some((t) => /Откройте облако точек/.test(t)), false);
  } finally { try { dom.window.close(); } catch (e) { } }
});

test('r169 UI (jsdom): «Что это?» из инспектора и событие lx-ai-what-is открывают ответ ИИ', { skip }, async () => {
  const { w, dom } = makeEnv();
  try {
    const UI = w.BimAssistantUI;
    const r = UI.explainInspector();
    assert.equal(r.ok, true);
    assert.match(r.text, /Стена|стена/);
    const text1 = w.document.body.textContent;
    assert.match(text1, /Толщина|200 мм/);
    // внешнее событие от инспектора: {detail:{auto: AutoMeasure res}}
    w.dispatchEvent(new w.CustomEvent('lx-ai-what-is', { detail: { auto: w.__lxObjectInspector.state.auto.res } }));
    await wait(30);
    const bots = w.document.querySelectorAll('.ai-msg.ai-bot');
    assert.ok(bots.length >= 1, 'ответ появился в чате ассистента');
    // API для кнопки инспектора
    const r2 = w.__lxAiWhatIs(w.__lxObjectInspector.state.auto.res);
    assert.equal(r2.ok, true);
  } finally { try { dom.window.close(); } catch (e) { } }
});

test('r169 UI (jsdom): контекст передаётся модели — вопрос обогащается блоком фактов (фейковый runAgent)', { skip }, async () => {
  const { w, dom } = makeEnv();
  try {
    const calls = [];
    w.BimAssistant = {
      runAgent: (o) => { calls.push(o.question); return Promise.resolve({ text: 'Ответ по фактам: стена, толщина 200 мм.', tools: [] }); },
      offlineAnswer: () => ({ text: 'offline', tools: [] }),
      stripThink: (s) => s, planAction: () => null, offlineNorms: async () => null
    };
    w.eval(read('ai-assistant-ui.js'));
    const UI = w.BimAssistantUI;
    w.bimAPI.aiStatus = async () => ({ ready: true, phase: 'ready', base: 'qwen', models: [] });
    UI.open();
    await wait(60);
    await UI.ask('сверь с документацией');
    await wait(60);
    assert.ok(calls.length >= 1, 'runAgent вызван');
    const sent = calls[calls.length - 1];
    assert.match(sent, /СЕЙЧАС В ПРИЛОЖЕНИИ/, 'в вопрос добавлен структурированный контекст');
    assert.match(sent, /облако: room\.las/);
    assert.match(sent, /контроль геометрии/);
    const all = Array.from(w.document.querySelectorAll('.ai-msg.ai-bot')).map((b) => b.textContent).join('\n');
    assert.match(all, /Ответ по фактам/);
  } finally { try { dom.window.close(); } catch (e) { } }
});
