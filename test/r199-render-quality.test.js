'use strict';
/*
 * r199/r201 — качество рендера облака «как в Lixel Studio».
 * Профиль «Фото (Lixel)» (DEFAULT): плоский энергосберегающий сплэт (alpha=1, без тёмных колец/пересвета)
 * + перспективная аттенюация, база 2.4 px при 1080p, clamp 1.8…6 px, яркость 1.0, насыщенность ×0.82,
 * chroma-only screen-space denoise K=0.8 (luma не трогается), бюджет 380M.
 * classic/balanced/max сохранены. r201: soft-alpha AA и fixed-size 2.0–2.2 проверены и отклонены
 * (speckle +80 % / +28 %), EDL отклонён.
 * Отдельно закреплён корень «1 px»: setAttenuate(false) не должен фиксировать pointSize=1.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP = read('renderer/app.js');
const VW = read('renderer/webgl-viewer.js');
const CMD = read('renderer/ui/commands.js');
const { Viewer3DGL } = require('../renderer/webgl-viewer.js');

function profileBlock(key) {
  const m = APP.match(new RegExp('\\b' + key + ": \\{[^\\n]*\\}"));
  assert.ok(m, 'профиль ' + key + ' не найден в RENDER_PROFILES');
  const src = m[0];
  const num = (name) => {
    const r = src.match(new RegExp(name + ':\\s*(-?[0-9.]+)'));
    return r ? Number(r[1]) : null;
  };
  const bool = (name) => {
    const r = src.match(new RegExp(name + ':\\s*(true|false)'));
    return r ? r[1] === 'true' : null;
  };
  return { src, num, bool };
}

test('r199: профиль «Фото (Lixel)»: плоский энергосберегающий soft + attenuate одновременно', () => {
  const p = profileBlock('photo');
  assert.match(p.src, /label: 'Фото \(Lixel\)'/);
  assert.strictEqual(p.bool('soft'), true, 'фото: мягкие сплаты должны быть включены');
  assert.strictEqual(p.bool('softFlat'), true, 'фото: плоский сплэт без тёмных колец (это и убирает зерно r177)');
  assert.strictEqual(p.bool('attenuate'), true, 'фото: перспективная аттенюация должна быть включена');
  assert.strictEqual(p.bool('photoSmooth'), true, 'r201: chroma-only screen-space denoise включён');
  assert.strictEqual(p.num('smoothK'), 0.8, 'r201: сила chroma-denoise 0.8');
  assert.strictEqual(p.num('smoothYK'), 0.45, 'r201: медианный luma-фильтр 0.45 (убирает спикл)');
  assert.strictEqual(p.bool('softAlpha'), null, 'r201: soft-alpha AA отклонён — на замерах speckle хуже в 1.8×');
  assert.strictEqual(p.bool('edl'), null, 'фото: без EDL — у эталона нет тёмных контуров');
});

test('r199: база 2.4 px (2.2–2.6), clamp 1.8…6, яркость 1.0, насыщенность 0.82', () => {
  const p = profileBlock('photo');
  const base = p.num('autoBase');
  assert.ok(base >= 2.2 && base <= 2.6, 'autoBase 2.2–2.6 px, получено ' + base);
  assert.strictEqual(base, 2.4);
  assert.strictEqual(p.num('minPx'), 1.8);
  assert.strictEqual(p.num('maxPx'), 6.0);
  assert.strictEqual(p.num('bright'), 1.0, 'пересвет недопустим: яркость ровно 1.0');
  assert.strictEqual(p.num('saturation'), 0.82);
  assert.ok(p.num('densityBoost') >= 1.2, 'перекрытие сплэтов для сплошной поверхности');
});

test('r199: DEFAULT — «Фото (Lixel)»; «Классический (r177)» сохранён выбираемым', () => {
  assert.match(APP, /const DEFAULT_RENDER_PROFILE = 'photo';/);
  assert.match(APP, /return DEFAULT_RENDER_PROFILE;/);
  assert.match(APP, /getItem\('bim\.uiProfileRev'\) !== '199'[\s\S]{0,400}setItem\('bim\.render\.profile', 'photo'\)/);
  assert.match(APP, /classic: \{ label: 'Классический \(r177\)', soft: true, autoBase: 3\.4, cap: 5\.0, bright: 1\.1, attenuate: false, density: 'classic', budget: 300000000 \}/);
  assert.match(APP, /balanced: \{ label: 'Сбалансированный', soft: false, autoBase: 2\.3, cap: 4\.0, bright: 1\.0, attenuate: true/);
  assert.match(APP, /max: \{ label: 'Максимум детализации', soft: false, autoBase: 2\.3, cap: 4\.5, bright: 1\.0, attenuate: true/);
  assert.match(CMD, /args: \['classic'\]/);
  assert.match(APP, /args: \['photo'\]/);
});

test('r199: корень «1 px» — setAttenuate(false) не фиксирует точку и не отменяет autoBase', () => {
  const v = Object.create(Viewer3DGL.prototype);
  v.render = function () {};
  v._notifyCloudChanged = function () {};
  v._cloudDisplay = { pointSize: 1, opacity: 1, min: 0, max: 1, palette: 0 };
  v._attenuate = true;
  v.setAttenuate(false);
  assert.strictEqual(v._cloudDisplay.pointSize, null, 'выключение аттенюации не должно давать fixedPx=1');
  assert.strictEqual(v._attenuate, false);
  // ручной слайдер остаётся фиксированным (не ломаем «Размер точки»)
  v._autoPointSize = false;
  v.setCloudPointSize(1);
  assert.strictEqual(v._cloudDisplay.pointSize, 1);
  assert.strictEqual(v._attenuate, false);
  assert.match(VW, /setAttenuate\(on\) \{ this\._attenuate = !!on; this\._cloudDisplay\.pointSize = null;/);
  assert.match(APP, /viewer\._cloudDisplay\.pointSize = null/);
});

test('r199: шейдер — плоский энергосберегающий край и радиальный r195 оба доступны', () => {
  assert.match(VW, /uniform float uSoft;/);
  assert.match(VW, /alpha = 1\.0;/);
  assert.match(VW, /float edge = smoothstep\(1\.0, 0\.45, rr\);[\s\S]{0,180}c \*= \(0\.55 \+ 0\.45 \* edge\);/);
  assert.match(VW, /if\(uSoftFlat>0\.5\)\{[\s\S]{0,700}float feather = smoothstep\(1\.0, 0\.86, rr\);[\s\S]{0,120}c \*= \(0\.94 \+ 0\.06 \* feather\);/);
  assert.match(VW, /if\(uSoftFlat<0\.5\) splat=0\.82\+0\.18\*sqrt/, 'в плоском режиме нет двойного затемнения кромки');
});

test('r199: аттенюация по локальному шагу + clamp 1.8…6 в draw-пути', () => {
  assert.match(VW, /uRadOn>0\.5\)\{ sc = uPtScale \* uRadMin \* exp2\(aRad \* uRadLog\); \}/);
  assert.match(VW, /ps = clamp\(sc \/ max\(gl_Position\.w, 0\.0001\), uPtMin, uPtMax\);/);
  assert.match(VW, /if \(isCloud && atten && !fixedPx && !this\._frameBox && this\._photoSize\)/);
  assert.match(VW, /gl\.uniform1f\(this\.u\.uPtMin, photoBase\);/);
  assert.match(VW, /gl\.uniform1f\(this\.u\.uPtMax, photoMax\);/);
  assert.match(VW, /setPhotoClamp\(minPx, maxPx\)/);
  // r197-совместимость: общий setMaxPointPx по-прежнему 1.5…5.0
  assert.match(VW, /setMaxPointPx\(px\)[^}]*Math\.max\(1\.5, Math\.min\(5\.0, v\)\)/);
});

test('r201: chroma-only denoise включён в фото; EDL и soft-alpha — опции, отклонены замерами', () => {
  assert.match(VW, /setPhotoSmooth\(on\)/);
  assert.match(VW, /setEdl\(on, strength, tol\)/);
  assert.match(VW, /if\(abs\(zn - zs\) > uEdlTol\) sum \+=/);
  assert.match(VW, /float shade = clamp\(exp\(-sum \* uStrength \* 20\.0\), 0\.55, 1\.0\);/);
  assert.match(APP, /setPhotoSmooth\(!!pr\.photoSmooth\)/);
  assert.match(APP, /setPhotoSmoothStrength\(pr\.smoothK/);
  assert.match(APP, /setEdl\(!!pr\.edl, pr\.edlStrength/);
  assert.match(APP, /setSoftFlat\(!!pr\.softFlat\)/);
  // soft-alpha AA реализован, но профилем не включается (на замерах speckle +80 %)
  assert.match(VW, /uniform float uSoftAlpha;/);
  assert.match(VW, /alpha = smoothstep\(1\.0, 0\.60, rr\);/);
  assert.match(VW, /setSoftAlpha\(on\)/);
  assert.match(APP, /setSoftAlpha\(!!pr\.softAlpha\)/);
});

test('r199: view-dependent плотность — ближние кирпичи в приоритете при бюджете кадра', () => {
  assert.match(VW, /setNearDensity\(on\)/);
  assert.match(VW, /if \(this\._nearDensity && share < 1\)[\s\S]{0,220}sumA/);
  assert.match(VW, /budget \* a \/ sumA/, 'доля кирпича пропорциональна его экранной площади');
});

test('r199: бюджет фото 380M не превышает VRAM (замер 14.9 Б/точку)', () => {
  const p = profileBlock('photo');
  const budget = p.num('budget');
  assert.strictEqual(budget, 380000000);
  assert.match(APP, /const GPU_BYTES_PER_POINT = 24;/);
  assert.match(APP, /if \(prof === 'photo'\) return 380000000;/);
  // консервативная оценка 24 Б/точку тоже должна влезать в 12 ГБ минус резерв 1 ГБ
  assert.ok(budget * 24 <= 12 * 1000 * 1000 * 1000 - 1024 * 1024 * 1024, '380M × 24 Б — верхняя консервативная оценка');
  // реальный замер G: 4268 MiB на 300M => 14.9 Б/точку => 380M ≈ 5.3 ГиБ
  const real = budget * 14.9 / (1024 ** 3);
  assert.ok(real < 6.0, 'реальный VRAM фото ≈ ' + real.toFixed(1) + ' ГиБ, должно быть < 6');
});

test('r199: фото-профиль выбираем; classic и остальные не сломаны', () => {
  assert.match(APP, /window\.__bimSetRenderProfile = function/);
  assert.match(APP, /ensurePhotoProfileMenuItem/);
  assert.match(APP, /args: \['photo'\]/);
  assert.match(APP, /applyProfileToViewer\(renderProfile\(\)\)/);
  assert.match(APP, /if \(prof === 'classic'\) return 300000000;/);
  assert.match(APP, /setMaxPointPx\(d === 'exact' \? 4\.5 : d === 'fast' \? 3\.0 : 4\.0\);/);
});
