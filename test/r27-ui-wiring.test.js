'use strict';
// Ревизия 27: мощность ПК, окно «Перед загрузкой» (чистые функции), отчёт PDF, «Последние действия»,
// папка проекта / работа на месте и связи main ↔ preload ↔ окно.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..'), R = path.join(ROOT, 'renderer');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const Cap = require(path.join(ROOT, 'system-capacity.js'));
const CP = require(path.join(R, 'cloud-preview.js'));
const CR = require(path.join(R, 'cloud-report.js'));
const HP = require(path.join(R, 'history-panel.js'));
const PW = require(path.join(R, 'project-workspace.js'));
const GB = 1073741824;

test('мощность ПК: nvidia-smi и рекомендация числа точек', () => {
  const g = Cap.parseNvidiaSmi('8192, 1024, NVIDIA GeForce RTX 3070\n4096, 100, NVIDIA T400\n');
  assert.equal(g.name, 'NVIDIA GeForce RTX 3070');
  assert.equal(g.vramTotal, 8 * GB); assert.equal(g.vramFree, 7 * GB);
  assert.equal(Cap.parseNvidiaSmi('garbage'), null);
  const big = Cap.recommend({ vramTotal: 24 * GB, vramFree: 22 * GB, ramTotal: 64 * GB, ramFree: 48 * GB });
  const mid = Cap.recommend({ vramTotal: 8 * GB, vramFree: 7 * GB, ramTotal: 32 * GB, ramFree: 20 * GB });
  const igpu = Cap.recommend({ integrated: true, ramTotal: 16 * GB, ramFree: 8 * GB });
  for (const r of [big, mid, igpu]) { assert.ok(r.points >= 1e6, 'рекомендация не меньше 1 млн'); assert.ok(r.safeMax >= r.points, 'надёжный предел не меньше рекомендации'); }
  assert.ok(big.points > mid.points, 'мощнее видеокарта — больше точек');
  assert.ok(igpu.points <= 50e6 && igpu.safeMax <= 100e6, 'встроенная графика ограничена');
  assert.ok(igpu.notes.some(n => /встроенная/.test(n)));
  const unknown = Cap.recommend({ ramTotal: 16 * GB });
  assert.ok(unknown.notes.some(n => /не определена/.test(n)), 'видеопамять не определена — сказано прямо');
});

test('окно «Перед загрузкой»: ползунок, оценка, этажи, маска маршрута', () => {
  const total = 250e6;
  assert.equal(CP.sliderToPoints(0, total), 1e6);
  assert.equal(CP.sliderToPoints(1000, total), total);
  for (const p of [2e6, 30e6, 120e6]) { const x = CP.pointsToSlider(p, total); assert.ok(Math.abs(CP.sliderToPoints(x, total) - p) / p < 0.01, 'обратимость ' + p); }
  assert.equal(CP.sliderToPoints(500, 300000), 300000, 'маленькое облако — все точки');
  const pts = new Float32Array(3000);
  for (let i = 0; i < 1000; i++) { pts[i * 3] = i % 10; pts[i * 3 + 1] = Math.floor(i / 100); pts[i * 3 + 2] = (i % 4); }
  const e = CP.estimate(pts, 1e6, { rect: { u0: 0, u1: 4.5, v0: 0, v1: 100 }, h: { min: 0, max: 1.5 } }, null);
  assert.equal(e.frac, 0.25, 'половина по области × половина по высоте');
  assert.equal(e.points, 250000);
  const st = CP.storeys([{ h: 0, area: 100 }, { h: 2.8, area: 90 }, { h: 3.1, area: 95 }, { h: 5.9, area: 80 }], { h1: 6.1 });
  assert.equal(st.length, 2, 'два этажа: перекрытие 2,8–3,1 — одно');
  assert.equal(st[0].floor, 0); assert.equal(st[0].ceiling, 2.8); assert.equal(st[1].floor, 3.1);
  const route = new Float32Array([0, 0, 1, 0, 10, 0, 1, 0.5, 10, 10, 1, 1]);
  const m = CP.routeMaskJS(route, { u0: -5, u1: 15, v0: -5, v1: 15 }, 2, 0, 1);
  const on = (u, v) => !!m.bits[Math.floor((v - m.v0) / m.cell) * m.nx + Math.floor((u - m.u0) / m.cell)];
  assert.equal(on(5, 0), true); assert.equal(on(10, 5), true); assert.equal(on(0, 10), false);
  assert.equal(CP.niceScale(100, 0.07), 5);
  assert.deepEqual(CP.turbo(0).length, 3);
});

test('PDF-отчёт: HTML A4 со сведениями, уровнями, планом и безопасными картинками', () => {
  const ov = { ok: true, file: { name: 'скан<1>.las', points: 1234567, size: 40e6, format: 'LAS 1.2', colored: true },
    origin: { zup: true }, bbox: { u0: 0, u1: 10, v0: 0, v1: 6, h0: 0, h1: 2.8 }, grid: { nx: 10, ny: 6, cell: 1 },
    hist: { h0: 0, step: 0.1, counts: Array.from({ length: 28 }, (_, i) => (i === 0 || i === 27 ? 1000 : 50)) },
    levels: [{ h: 0, area: 60, points: 1000 }, { h: 2.8, area: 60, points: 1000 }], stats: { footprint: 60, perM2: 20000, spacing: 0.01, w: 10, d: 6, h: 2.8 } };
  const plan = { ok: true, faces: [{ a: [0, 0], b: [10, 0], length: 10 }], openings: [{ a: [2, 0], b: [3.5, 0], width: 1.5 }], walls: [{ thickness: 0.12, at: [6, 3] }],
    rooms: [{ name: 'Пом. 1', area: 36, size: [6, 6], center: [3, 3] }], bbox: { u0: 0, u1: 10, v0: 0, v1: 6 }, stats: {} };
  const html = CR.build({ ov, plan, maps: [{ title: 'Плотность', src: 'data:image/png;base64,iVBORw0KGgo=' }, { title: 'Злая', src: 'javascript:alert(1)' }],
    snapshot: 'data:image/jpeg;base64,/9j/4AAQ', fileName: 'скан<1>.las', project: 'Объект', appVersion: '1.2.0-rc.3', load: { maxPoints: 20e6 } });
  assert.match(html, /@page\{size:A4/);
  assert.match(html, /скан&lt;1&gt;\.las/, 'имя файла экранировано');
  assert.doesNotMatch(html, /javascript:alert/, 'картинки только data:image');
  assert.match(html, /<svg/, 'гистограмма и план — SVG');
  assert.match(html, /Пом\. 1/); assert.match(html, /36/);
  assert.match(html, /data:image\/png;base64,iVBORw0KGgo=/);
});

test('«Последние действия»: подписи правок и операций журнала', () => {
  assert.deepEqual(HP.describe({ removedPos: new Float32Array(3 * 1500) }), { label: 'Удаление точек', detail: 'удалено 1500 точек' });
  assert.equal(HP.describe({ pos: new Float32Array(30), tool: 'smooth' }).label, 'Сглаживание');
  assert.equal(HP.describe({ pos: new Float32Array(30), snapshot: true }).label, 'Правка облака');
  assert.match(HP.describe({ classificationEdit: true, changedPointCount: 21 }).detail, /21 точка/);
  assert.equal(HP.opLabel('cloud.autoClean'), 'Автоочистка');
  assert.equal(HP.opLabel('project.state.update'), 'Изменение проекта');
  assert.equal(HP.opLabel('cloud.something'), 'Облако: something');
  assert.equal(HP.ago(Date.now() - 5000), 'только что');
  assert.equal(HP.ago(Date.now() - 3 * 60000), '3 мин назад');
  const src = read('renderer/history-panel.js');
  assert.match(src, /Object\.defineProperty\(v, '_undo', \{ get:/, 'стек отмены перехватывается без правки просмотрщика');
  assert.match(src, /Отменить до этого/);
  assert.match(src, /for \(var i = 0; i < k; i\+\+\) \{ if \(!v\.undoEdit\(\)\) break;/, 'отмена до выбранной — по шагам');
  assert.match(src, /listProjectOperations/);
  assert.match(read('renderer/app.js'), /tool: String\(name \|\| 'edit'\), pointCountBefore: nPts \}/, 'запись отмены помнит инструмент');
});

test('папка проекта: работа на месте только для полного облака, имя «как новое»', () => {
  assert.equal(PW.inPlaceBlock({ path: 'C:/a/скан.las' }), '');
  assert.match(PW.inPlaceBlock({ path: 'C:/a/скан.las', sampled: true }), /выборка/);
  assert.match(PW.inPlaceBlock({ path: 'C:/a/скан.las', filtered: true, filterText: 'область' }), /не целиком/);
  assert.match(PW.inPlaceBlock({ path: 'C:/a/скан.e57' }), /E57/);
  assert.match(PW.inPlaceBlock({}), /откройте/);
  assert.equal(PW.newName('C:\\a\\Скан 1.las', 'ply'), 'Скан 1-правка.ply');
  assert.equal(PW.newName('/a/Скан 1-правка.ply', 'ply'), 'Скан 1-правка.ply', 'суффикс не копится');
  assert.equal(PW.joinPath('C:\\X\\Облака', 'a.ply'), 'C:\\X\\Облака\\a.ply');
  assert.equal(PW.joinPath('/home/x/Облака/', 'a.ply'), '/home/x/Облака/a.ply');
  const ss = read('renderer/lixel-smart-save.js');
  assert.match(ss, /var SAME_FMT = \['ply', 'las', 'xyz', 'pts', 'pcd', 'csv'\]/);
  assert.match(ss, /payload = buildCloudPayload\(wfmt, cloud\)/, 'рабочий LAS сохраняется как LAS, а не PLY-байтами');
  assert.match(ss, /setWorkingPath: function \(p\)/); assert.match(ss, /saveAsNew: function \(\) \{ return save\(\{ askPath: true \}\); \}/);
  const pw = read('renderer/project-workspace.js');
  assert.match(pw, /bim-cloud-change/, 'другое облако — сброс рабочего файла');
  assert.match(pw, /s\.setWorkingPath\(null\)/);
});

test('связи: main ↔ preload ↔ окно, упаковка, разметка, лента', () => {
  const main = read('main.js'), pre = read('preload.js'), app = read('renderer/app.js'), html = read('renderer/index.html'), pkg = JSON.parse(read('package.json'));
  for (const h of ['systemCapacity', 'cloudOverview', 'cloudPlan', 'saveReportPdf', 'projectFolder', 'grantWorkInPlace', 'cloudBackups']) {
    assert.ok(main.includes("ipcMain.handle('bim:" + h + "'"), 'main: bim:' + h);
    assert.match(pre, new RegExp('\\b' + h + ': '), 'preload: ' + h);
  }
  assert.ok(main.includes("ipcMain.on('bim:cancelCloudOverview'"));
  assert.match(main, /readSegmentAsync\([^;]*filter: ss\.filter \|\| null/, 'части читаются с фильтром окна');
  assert.match(main, /function cloudBackupKeep\(\)/); assert.match(main, /pruneCloudHistory\([^)]*cloudBackupKeep\(\)\)/);
  assert.match(main, /javascript: false/, 'окно печати PDF без скриптов');
  assert.match(pre, /cloudPartsOpen: \(p, jobId, opts\) => inv\('bim:cloudPartsOpen', \{[^}]*filter/);
  assert.match(app, /window\.CloudPreview\.maybeOpen\(filePath, \{ label \}\)/);
  assert.match(app, /if \(pre && pre\.cancelled\) return \{ ok: false, cancelled: true/);
  assert.match(app, /parseCloudWithProgress\(lastCloudPath, progressLabel, \{ skipPreview: true \}\)/, 'перечитывание не открывает окно снова');
  assert.match(app, /window\.__bimLastCloudPath = \(\) => lastCloudPath/);
  assert.match(app, /window\.__bimPcCapacity && window\.__bimPcCapacity\.recommendation/, 'предел точек по умолчанию — по мощности ПК');
  const order = ['export-hub.js', 'auto-plan.js', 'cloud-report.js', 'cloud-preview.js', 'history-panel.js', 'project-workspace.js'].map(f => html.indexOf('src="' + f + '?v='));
  order.forEach((at, i) => { assert.ok(at > 0, 'подключён ' + i); if (i) assert.ok(at > order[i - 1], 'порядок ' + i); });
  assert.ok(html.indexOf('href="ui/cloud-tools.css?v=') > html.indexOf('href="ui/motion.css?v='), 'стили окон после системы');
  for (const f of ['cloud-overview.js', 'cloud-overview-worker.js', 'renderer/auto-plan.js']) assert.ok(pkg.build.asarUnpack.includes(f), 'asarUnpack ' + f);
  for (const f of ['cloud-overview.js', 'cloud-overview-worker.js', 'system-capacity.js']) assert.ok(pkg.build.files.includes(f), 'files ' + f);
  const C = require(path.join(R, 'ui', 'commands.js'));
  assert.equal(C.byId.cpPreview.call, 'CloudPreview.openNext'); assert.equal(C.byId.cpPlanDxf.call, 'CloudPreview.planDxf');
  assert.equal(C.byId.cpReport.call, 'CloudPreview.report'); assert.equal(C.byId.histRecent.call, 'HistoryPanel.open');
  assert.equal(C.byId.projFolder.call, 'ProjectWorkspace.open'); assert.equal(C.byId.projBackups.call, 'ProjectWorkspace.backups');
});

test('новые модули окна: без эмодзи, синтаксис, классы стилей описаны', () => {
  const PICTO = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B55}\uFE0F]/u;
  const css = read('renderer/ui/cloud-tools.css');
  for (const f of ['cloud-preview.js', 'cloud-report.js', 'auto-plan.js', 'history-panel.js', 'project-workspace.js']) {
    const src = read('renderer/' + f);
    assert.doesNotMatch(src, PICTO, f + ': эмодзи');
    new Function(src);   // синтаксис
  }
  for (const [f, pre] of [['cloud-preview.js', 'bp'], ['history-panel.js', 'hp'], ['project-workspace.js', 'pw']]) {
    const used = new Set([...read('renderer/' + f).matchAll(new RegExp('class="([^"]*)"', 'g'))].flatMap(m => m[1].split(/\s+/)).map(c => c.replace(/[^a-z0-9-]/g, '')).filter(c => c.startsWith(pre + '-')));
    const missing = [...used].filter(c => !css.includes('.' + c));
    assert.deepEqual(missing, [], f + ': классы без стилей');
  }
});
