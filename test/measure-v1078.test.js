'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..', 'renderer');
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(R, 'app.js'), 'utf8');
const VW = fs.readFileSync(path.join(R, 'webgl-viewer.js'), 'utf8');

test('index.html: кнопки Плотно/Рамки в панели качества', () => {
  assert.ok(HTML.includes('id="qDense"'), 'qDense button missing');
  assert.ok(HTML.includes('id="qFrame"'), 'qFrame button missing');
  assert.ok(HTML.includes('🎨 Вид облака:'), 'quality panel label missing');
});

test('app.js: обработчики qDense/qFrame подключены', () => {
  assert.ok(APP.includes("$('qDense')"), 'qDense not wired');
  assert.ok(APP.includes("$('qFrame')"), 'qFrame not wired');
  assert.ok(APP.includes('setDenseFill'), 'setDenseFill call missing');
  assert.ok(APP.includes('setFrame'), 'setFrame call missing');
});

test('webgl-viewer.js: методы и uniform добавлены', () => {
  assert.ok(VW.includes('setDenseFill(on)'), 'setDenseFill method missing');
  assert.ok(VW.includes('denseFillOn()'), 'denseFillOn method missing');
  assert.ok(VW.includes('setFrame(on)'), 'setFrame method missing');
  assert.ok(VW.includes('frameOn()'), 'frameOn method missing');
  assert.ok(VW.includes('uFrame'), 'uFrame uniform missing');
  assert.ok(VW.includes("'uFrame'"), 'uFrame not registered in uniform list');
  assert.ok(VW.includes('_denseFill'), '_denseFill state missing');
  assert.ok(VW.includes('_frame'), '_frame state missing');
});

test('webgl-viewer.js: бесконечный зум и ближняя плоскость', () => {
  assert.ok(VW.includes('Math.max(1e-4, Math.min(6000,'), 'zoom clamp not lowered');
  assert.ok(!VW.includes('Math.max(0.003, Math.min(6000,'), 'old zoom clamp still present');
  assert.ok(VW.includes('Math.max(1e-5, Math.min(dg * 0.0006'), 'near plane not lowered');
  assert.ok(!VW.includes('Math.max(0.001, Math.min(dg * 0.0006'), 'old near plane still present');
});

test('webgl-viewer.js: плотная заливка расширяет uPtMax', () => {
  assert.ok(VW.includes('this._denseFill ? 9.0 :'), 'dense fill cap boost missing');
  assert.ok(VW.includes('this._attenuate || this._denseFill || adaptive'), 'dense fill attenuation not enabled');
});

test('app.js: перенос панели 3D-инструментов в верхнюю панель', () => {
  assert.ok(APP.includes("getElementById('vtGroup')"), 'vtGroup relocation missing');
  assert.ok(APP.includes("_g.id = 'vtGroup'"), 'vtGroup id not set');
  assert.ok(APP.includes(".toolbar .tbtns"), 'toolbar target selector missing');
  assert.ok(APP.includes("'3D-\u0438\u043d\u0441\u0442\u0440\u0443\u043c\u0435\u043d\u0442\u044b'"), 'group label missing');
});

test('index.html: группа «Облако точек» рядом с 3D-туром', () => {
  assert.ok(HTML.includes('>Облако точек<'), 'point-cloud group label missing');
  assert.ok(HTML.includes('id="btnOpenCloud"'), 'btnOpenCloud missing');
  // кнопка больше не скрыта через display:none в разметке
  const seg = HTML.slice(HTML.indexOf('id="btnOpenCloud"') - 40, HTML.indexOf('id="btnOpenCloud"') + 40);
  assert.ok(!seg.includes('display:none'), 'btnOpenCloud should be visible');
  // группа стоит после 3D-тура (tsSplatTop) и до группы Правка
  assert.ok(HTML.indexOf('id="tsSplatTop"') < HTML.indexOf('id="btnOpenCloud"'), 'point-cloud group should follow 3D-tour');
});

test('app.js: кнопка облака всегда видна + fallback на выбор файла', () => {
  assert.ok(APP.includes("b.style.display = '';"), 'open-cloud button not forced visible');
  assert.ok(APP.includes("$('modelInput'); if (mi)"), 'file-picker fallback missing');
});

test('index.html: легенда убрана, консоль всегда открыта', () => {
  assert.ok(!HTML.includes('class="legend"'), 'legend should be removed');
  assert.ok(!HTML.includes('id="devConsole" class="devconsole" style="display:none"'), 'devConsole should not start hidden');
  assert.ok(HTML.includes('id="devConsole" class="devconsole">'), 'devConsole should be always-open');
});

test('app.js: куб видов перенесён в тулбар + консоль-док', () => {
  assert.ok(APP.includes("_g2.id = 'vcGroup'"), 'viewCube not relocated into toolbar');
  assert.ok(APP.includes('console-collapsed'), 'console dock collapse logic missing');
  assert.ok(APP.includes("panel.style.display = 'flex'"), 'console not forced open');
});

test('styles.css: док снизу резервирует место под 3D', () => {
  const CSS = fs.readFileSync(path.join(R, 'styles.css'), 'utf8');
  assert.ok(/\.stage\{ padding-bottom: 232px/.test(CSS), 'stage bottom padding missing');
  assert.ok(CSS.includes('.tbtns #vcGroup .viewcube'), 'toolbar viewcube styling missing');
});

test('app.js: консоль с регулируемой высотой', () => {
  assert.ok(APP.includes("grip.className = 'dc-resize'"), 'console resize grip missing');
  assert.ok(APP.includes('const applyH ='), 'applyH resize handler missing');
  assert.ok(APP.includes('stage.style.paddingBottom'), 'stage padding should follow console height');
});

test('styles.css: fix кнопки облака + Виды вправо + грип', () => {
  const CSS = fs.readFileSync(path.join(R, 'styles.css'), 'utf8');
  assert.ok(CSS.includes('.btn#btnOpenCloud{ width:auto'), 'open-cloud button not un-boxed');
  assert.ok(/\.tbtns #vcGroup\{ margin-left:auto/.test(CSS), 'Виды not pushed right');
  assert.ok(CSS.includes('.dc-resize{'), 'resize grip CSS missing');
});

test('webgl-viewer.js: _frame() — метод, не перезаписан флагом', () => {
  assert.ok(VW.includes('this._frameBox = false'), 'frame flag should be _frameBox');
  assert.ok(!/this\._frame = (?:false|!!on)/.test(VW), '_frame boolean must not shadow _frame() method');
  assert.ok(VW.includes('_frame() { const c = this.bbox'), '_frame() camera method must remain');
});

test('webgl-viewer.js: маркеры измерения — маленькие экранные точки, не кубы', () => {
  // в _buildMeasure маркеры теперь points с _isSel (постоянный размер), а не boxGeom
  const bm = VW.slice(VW.indexOf('_buildMeasure()'), VW.indexOf('_measLayerEl()'));
  assert.ok(bm.includes('const markPts = []'), 'markers should be collected as points');
  assert.ok(/objs\.push\(\{ points: true, pos: new Float32Array\(markPts\)[^}]*_isSel: true/.test(bm), 'marker points object with _isSel missing');
  assert.ok(!bm.includes('boxGeom(p[0], p[1], p[2], s, s, s)'), 'old scene-scaled box markers must be gone');
  assert.ok(!/boxGeom\(this\._measCornerPt/.test(bm), 'corner marker box must be replaced by point');
});

test('webgl-viewer.js: CloudCompare-стиль — снап под курсор + предпросмотр', () => {
  assert.ok(VW.includes('_hoverMeasure(cx, cy)'), 'hover preview method missing');
  assert.ok(VW.includes('_setHoverPoint(pt)'), 'hover marker setter missing');
  assert.ok(VW.includes('this._hoverObj ? [this._hoverObj] : []'), 'hover object must join draw list');
  assert.ok(VW.includes('if (this.measuring) this._hoverMeasure'), 'mousemove should drive hover while measuring');
  // снап — по ближайшей к курсору точке, а не просто ближайшей по глубине
  assert.ok(VW.includes('bestScore = Infinity'), 'pick should score by cursor distance');
  assert.ok(VW.includes('crosshair'), 'measure cursor should be crosshair');
});

test('webgl-viewer.js: адаптивная плотность при приближении', () => {
  assert.ok(/const adaptive = isCloud && !fixedPx && !this\._frameBox/.test(VW), 'adaptive density flag missing');
  assert.ok(VW.includes('uPtMin, adaptive ? baseSize : 1.0'), 'adaptive must keep base size as floor');
  assert.ok(VW.includes('adaptive ? 6.0 : 1.0'), 'adaptive should raise max point size to fill gaps');
  assert.ok(VW.includes('this._densityBoost'), 'density boost must widen adaptive point size');
  assert.ok(VW.includes('this._interBudget = 128000000'), 'interactive budget must keep points on zoom');
  assert.ok(VW.includes('setDensityBoost(v)'), 'density boost setter missing');
});

test('webgl-viewer.js: лупа-увеличитель для точного прицеливания', () => {
  assert.ok(VW.includes('_ensureLoupe()'), 'loupe factory missing');
  assert.ok(VW.includes('_drawLoupe(cx, cy'), 'loupe draw method missing');
  assert.ok(VW.includes('_hideLoupe()'), 'loupe hide method missing');
  assert.ok(VW.includes('setLoupeZoom(z)'), 'loupe zoom setter missing');
  // лупа копирует область под курсором из основного canvas
  assert.ok(VW.includes('ctx.drawImage(this.canvas'), 'loupe must copy from main canvas');
  assert.ok(VW.includes('preserveDrawingBuffer: true'), 'preserveDrawingBuffer required to copy WebGL canvas');
  // лупа вызывается в цикле наведения и скрывается при выходе
  assert.ok(VW.includes('this._drawLoupe(xy[0], xy[1]'), 'hover loop must drive loupe');
  assert.ok(/mouseleave.*_hideLoupe\(\)/s.test(VW), 'loupe should hide on mouseleave');
  assert.ok(VW.includes('imageSmoothingEnabled = false'), 'loupe should use crisp nearest-neighbour zoom');
});

test('viewer: секущий бокс (uClipMin/uClipMax) в шейдере и юниформах', () => {
  assert.ok(VW.includes('uniform vec3 uClipMin; uniform vec3 uClipMax;'), 'clip box uniforms missing');
  assert.ok(VW.includes("'uClipMin', 'uClipMax'"), 'clip uniforms not registered');
  assert.ok(VW.includes('vW.x<uClipMin.x||vW.x>uClipMax.x||vW.y<uClipMin.y||vW.y>uClipMax.y||vW.z<uClipMin.z||vW.z>uClipMax.z'), 'box discard test missing');
});

test('viewer: методы среза по осям и границы бокса', () => {
  assert.ok(VW.includes('setSectionAxis(axis, lo, hi)'), 'setSectionAxis missing');
  assert.ok(VW.includes('setSectionBox(b)'), 'setSectionBox missing');
  assert.ok(VW.includes('resetSection()'), 'resetSection missing');
  assert.ok(VW.includes('_clipBounds()'), '_clipBounds missing');
  assert.ok(VW.includes('_pointInClip(i)'), '_pointInClip missing');
  assert.ok(VW.includes('_clipFilter(idx)'), '_clipFilter missing');
  assert.ok(VW.includes('min: [0, 0, 0], max: [1, 1, 1]'), 'section box state missing');
});

test('viewer: правки защищают срезанные точки (_applyEditOp)', () => {
  assert.ok(VW.includes('_applyEditOp(runFn)'), '_applyEditOp missing');
  assert.ok(VW.includes('this._applyEditOp(function(sub){return window.PCEdit.cleanStatisticalOutliers(sub,o);})'), 'SOR not wrapped');
  assert.ok(VW.includes('this._applyEditOp(function(sub){return window.PCEdit.cleanRadiusOutliers(sub,o);})'), 'radius not wrapped');
  assert.ok(VW.includes('this._applyEditOp(function(sub){return window.PCEdit.noiseFilterLocalPlane(sub,o);})'), 'noise not wrapped');
  assert.ok(VW.includes('this._applyEditOp(function(sub){return window.PCEdit.voxelDownsample(sub,o);})'), 'voxel not wrapped');
  assert.ok(VW.includes('this._applyEditOp(function(sub){return window.PCEdit.sliceSection(sub,opts||{});})'), 'slice not wrapped');
});

test('viewer: выделение ограничено видимой частью среза', () => {
  assert.ok(VW.includes("this._clipFilter(this._resolveVisibleSelection(raw, proj, 'lasso'))"), 'lasso not clip-filtered');
  assert.ok(VW.includes("this._clipFilter(this._resolveVisibleSelection(raw, proj, 'rect'))"), 'marquee not clip-filtered');
  assert.ok(VW.includes('!this._sel.has(i) && this._pointInClip(i)'), 'brush not clip-guarded');
  assert.ok(VW.includes('new Set(this._clipFilter(window.PCEdit.selectByBox'), 'box select not clip-filtered');
});

test('app.js: панель секущего бокса со слайдерами по осям', () => {
  assert.ok(APP.includes('ensureSectionPanel'), 'section panel builder missing');
  assert.ok(APP.includes("id=\"sec_' + ax.a + '_min\"") || APP.includes('sec_' ), 'axis sliders missing');
  assert.ok(APP.includes('viewer.setSectionAxis'), 'setSectionAxis not wired');
  assert.ok(APP.includes('viewer.resetSection'), 'resetSection not wired');
});

test('app.js: пресеты плана/фасада/бока показывают метрические границы', () => {
  for (const id of ['sec_preset_y', 'sec_preset_z', 'sec_preset_x']) assert.ok(APP.includes(id), 'missing section preset ' + id);
  assert.ok(APP.includes('viewer.sliceSetup(axis, lo, hi)'), 'preset must create a single-axis slab');
  assert.ok(APP.includes('viewer.setSectionView(axis)'), 'preset must orient the view to the section plane');
  assert.ok(APP.includes('толщина ') && APP.includes('toFixed(3)'), 'missing metric slab readout');
});
