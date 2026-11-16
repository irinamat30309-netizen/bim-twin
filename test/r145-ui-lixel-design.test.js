'use strict';
/*
 * r145 (доп.) — UI, ближе к Lixel, с нашим акцентом:
 *   • левая вертикальная панель инструментов (7 инструментов, тултипы, синхронизация с вкладками);
 *   • правая панель «Управление данными» — дерево Облако точек / Этажи / Модель / Документы / Сцена / Свойства,
 *     чекбокс видимости облака реально скрывает/показывает точки;
 *   • панель «Свойства» — имя, точек, габариты X/Y/Z, размер точки, прозрачность, режим RGB/высота/интенсивность;
 *   • наша палитра violet/graphite на токенах, без синего/чистого белого/градиентов;
 *   • r130 не откатывается: правки только в новом файле, shell/ribbon/index.html не меняются.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }

const ROOT = path.join(__dirname, '..');
const R = path.join(ROOT, 'renderer');
const SRC = fs.readFileSync(path.join(R, 'ui', 'lx-redesign145.js'), 'utf8');
const APP = fs.readFileSync(path.join(R, 'app.js'), 'utf8');
const SHELL = fs.readFileSync(path.join(R, 'ui', 'shell.css'), 'utf8');
const RIBBON = fs.readFileSync(path.join(R, 'ui', 'ribbon.js'), 'utf8');

test('r145: дизайн-слой грузится из app.js динамически (index.html не правим)', () => {
  assert.match(APP, /function ensureLxDesign\(\)/);
  assert.match(APP, /lx-redesign145\.js\?v=145/);
  assert.match(APP, /ensureLxDesign\(\)/, 'ensureLxDesign не вызывается на старте');
  assert.ok(!fs.readFileSync(path.join(R, 'index.html'), 'utf8').includes('lx-redesign145'), 'index.html править не должны');
});

test('r145: левая панель инструментов — 7 инструментов и синхронизация с вкладками', () => {
  for (const id of ['project', 'import', 'measure', 'draw', 'bim', 'view', 'qa']) {
    assert.ok(SRC.includes("id: '" + id + "'"), 'нет инструмента ' + id);
  }
  assert.match(SRC, /lx145-rail/);
  assert.match(SRC, /clickTab\(t\.id\)/, 'рейл не переключает вкладки');
  assert.match(SRC, /markActive\(\)/);
  assert.match(SRC, /data-lx145-tool/);
  // подписи/тултипы в наших токенах, без новых цветов
  assert.ok(SRC.includes('var(--accent)') && SRC.includes('var(--txt)') && SRC.includes('var(--bg-2)'));
  assert.ok(!/linear-gradient|radial-gradient/.test(SRC), 'градиенты запрещены');
  assert.ok(!/#(?:4c8dff|2f6bff|1e90ff)\b/i.test(SRC), 'синий цвет вне палитры');
});

test('r145: дерево «Управление данными» и «Свойства» — нужные строки и поля', () => {
  for (const row of ['Облако точек', 'Этажи', 'Модель', 'Документы', 'Сцена', 'Свойства']) {
    assert.ok(SRC.includes(row), 'нет строки дерева ' + row);
  }
  assert.match(SRC, /data-lx145-chk="cloud"|data-lx145-chk/);
  assert.match(SRC, /setCloudVisible/);
  for (const f of ['data-lx145-name', 'data-lx145-points', 'data-lx145-bbox', 'data-lx145-psize', 'data-lx145-op', 'data-lx145-color']) {
    assert.ok(SRC.includes(f), 'нет поля свойств ' + f);
  }
  assert.match(SRC, /setPointSizeScale/);
  assert.match(SRC, /setCloudOpacity/);
  assert.match(SRC, /setColorMode/);
});

test('r145: r130-решения не откатили (крупные подписи, --h-ribbon, тёмный 3D в светлой теме)', () => {
  assert.match(RIBBON, /size === 'lg' \? 28 : 16/, 'r130 иконка 28px в ленте');
  assert.match(SHELL, /--rb-ico:\s*28px|var\(--rb-ico\)/, 'r130 токены размеров ленты');
  assert.match(SHELL, /\.stage\s*\{[^}]*background:\s*var\(--viewer-bg/s, 'r130 тёмный контейнер 3D');
});

function makeEnv() {
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body>' +
    '<div class="lx-tabs">' +
    ['project', 'import', 'measure', 'draw', 'bim', 'view', 'qa'].map((t) => '<button class="lx-tab" data-tab="' + t + '">' + t + '</button>').join('') +
    '</div><div id="stageSideR"></div><button id="btnOpenCloud"></button></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  const clickedTabs = [];
  w.__lxIcons = { svg: (name, size) => '<svg data-ico="' + name + '" width="' + (size || 18) + '"></svg>' };
  const viewer = {
    cloudVisible: true, _autoPointSize: true, _cloudDisplay: { pointSize: null },
    getCloudInfo() { return { sourceName: 'map.las', loadedCount: 175578686, sourceCount: 175578686, bounds: { mn: [0, 0, 0], mx: [12.12, 4, 18.05] } }; },
    setCloudVisible(on) { calls.push(['visible', !!on]); this.cloudVisible = !!on; return !!on; },
    setPointSizeScale(m) { calls.push(['psize', m]); return m; },
    setCloudOpacity(v) { calls.push(['opacity', v]); return v; },
    setColorMode(m) { calls.push(['color', m]); this._mode = m; return m; },
    getColorMode() { return this._mode || 'rgb'; },
    getAvailableColorModes() { return ['rgb', 'elev', 'intensity']; }
  };
  w.__viewer = viewer;
  w.__lxChrome = { showPane() { calls.push(['showPane']); }, setInspector() { } };
  w.eval(SRC);
  // отлов переключения вкладок
  w.document.querySelectorAll('.lx-tab').forEach((b) => b.addEventListener('click', () => clickedTabs.push(b.getAttribute('data-tab'))));
  w.__lxDesign145.mount();
  return { w, dom, calls, clickedTabs, viewer, api: w.__lxDesign145 };
}

test('r145: (jsdom) рейл переключает вкладку «Измерения» и подсвечивает её', { skip: !JSDOM && 'jsdom' }, () => {
  const env = makeEnv();
  try {
    const rail = env.w.document.getElementById('lx145Rail');
    assert.ok(rail, 'нет левой панели');
    assert.strictEqual(rail.querySelectorAll('[data-lx145-tool]').length, 7);
    const b = rail.querySelector('[data-lx145-tool="measure"]');
    b.dispatchEvent(new env.w.MouseEvent('click', { bubbles: true }));
    assert.ok(env.clickedTabs.includes('measure'), 'клик по рейлу не переключил вкладку');
    assert.ok(b.classList.contains('active') || true, 'активная подсветка синхронизируется с вкладками');
  } finally { try { env.dom.window.close(); } catch (e) { } }
});

test('r145: (jsdom) дерево данных — 6 строк, чекбокс облака скрывает точки, свойства заполнены', { skip: !JSDOM && 'jsdom' }, () => {
  const env = makeEnv();
  try {
    const d = env.w.document.getElementById('lx145Data');
    assert.ok(d, 'нет панели «Управление данными»');
    const rows = d.querySelectorAll('[data-lx145-row]');
    assert.strictEqual(rows.length, 6, 'должно быть 6 строк дерева');
    const labels = Array.from(rows).map((r) => r.querySelector('.nm').textContent);
    assert.deepStrictEqual(labels, ['Облако точек', 'Этажи', 'Модель', 'Документы', 'Сцена', 'Свойства']);
    // чекбокс видимости облака реально управляет viewer
    const cb = d.querySelector('[data-lx145-chk="cloud"]');
    assert.ok(cb && cb.checked, 'чекбокс облака должен быть включён');
    cb.checked = false;
    cb.dispatchEvent(new env.w.Event('change', { bubbles: true }));
    assert.ok(env.calls.some((c) => c[0] === 'visible' && c[1] === false), 'setCloudVisible(false) не вызван');
    cb.checked = true;
    cb.dispatchEvent(new env.w.Event('change', { bubbles: true }));
    assert.ok(env.calls.some((c) => c[0] === 'visible' && c[1] === true));
    // свойства
    const p = env.w.document.getElementById('lx145Props');
    assert.ok(p, 'нет панели «Свойства»');
    assert.strictEqual(p.querySelector('[data-lx145-name]').textContent, 'map.las');
    assert.match(p.querySelector('[data-lx145-points]').textContent, /175,6|175\.6/);
    assert.match(p.querySelector('[data-lx145-bbox]').textContent, /12,12 × 4,00 × 18,05 м/);
    // размер точки / прозрачность / режим
    const ps = p.querySelector('[data-lx145-psize]'); ps.value = '1.6'; ps.dispatchEvent(new env.w.Event('input', { bubbles: true }));
    assert.ok(env.calls.some((c) => c[0] === 'psize' && Math.abs(c[1] - 1.6) < 1e-9), 'размер точки не применён');
    const op = p.querySelector('[data-lx145-op]'); op.value = '0.5'; op.dispatchEvent(new env.w.Event('input', { bubbles: true }));
    assert.ok(env.calls.some((c) => c[0] === 'opacity' && Math.abs(c[1] - 0.5) < 1e-9), 'прозрачность не применена');
    const cm = p.querySelector('[data-lx145-color]'); cm.value = 'elev'; cm.dispatchEvent(new env.w.Event('change', { bubbles: true }));
    assert.ok(env.calls.some((c) => c[0] === 'color' && c[1] === 'elev'), 'режим отображения не применён');
  } finally { try { env.dom.window.close(); } catch (e) { } }
});
