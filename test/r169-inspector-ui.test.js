'use strict';
/*
 * r169 — 3 бага UI инспектора/ассистента:
 *  1) «Что это?» считал потоковое/большое облако «не открытым»: __pcTools.getCloud() возвращал null
 *     (getEditedCloud() у потокового облака намеренно null). Теперь — fallback на выборку viewer (bo.pos).
 *  2) Плавающая подсказка привязки бегала за курсором (meas-snap-tip) — убрана; та же информация в углу
 *     статуса (#lxInfo), восстанавливается после выхода.
 *  3) Автозамер не должен выводить «false» вместо значения — autoVal отбрасывает boolean/пустые значения.
 *  4) 39 кнопок needs:'cloud' остаются активными при открытом облаке/инспекторе (r145-регрессия).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP = read('renderer/app.js');
const VIEW = read('renderer/webgl-viewer.js');
const INS = read('renderer/lixel-object-inspector.js');
const CMD = require('../renderer/ui/commands.js');

test('r169: «Что это?» — getCloud отдаёт потоковое облако (выборку), а не null', () => {
  const part = APP.slice(APP.indexOf('window.__pcTools = {'), APP.indexOf('window.__pcTools = {') + 2600);
  assert.match(part, /getCloud: \(\) => \{/, 'getCloud должен быть функцией с fallback');
  assert.match(part, /viewer\.getEditedCloud/, 'сначала обычное отредактированное облако');
  assert.match(part, /bo\.pos/, 'fallback на выборку потокового буфера viewer (bo.pos)');
  assert.match(part, /sample: true/, 'выборка помечается, чтобы инструменты знали о неполных массивах');
  // гейт «облако открыто» в ассистенте использует __pcTools.getCloud — не меняем AI-файл, чиним мост
  assert.match(APP, /const hasCloudArrays = \(\) => \{[\s\S]{0,500}bo\.pos/, 'hasCloudArrays тоже должен видеть потоковое облако');
});

test('r169: плавающая подсказка привязки убрана — информация в углу статуса', () => {
  const fn = VIEW.slice(VIEW.indexOf('_hideSnapTip() {'), VIEW.indexOf('_showSnapTip(cx, cy, snap) {'));
  assert.match(fn, /getElementById\('lxInfo'\)/, 'скрытие/восстановление текста статуса');
  const show = VIEW.slice(VIEW.indexOf('_showSnapTip(cx, cy, snap) {'), VIEW.indexOf('_showSnapTip(cx, cy, snap) {') + 2400);
  assert.match(show, /getElementById\('lxInfo'\)/, 'привязка выводится в #lxInfo (угол статуса)');
  assert.doesNotMatch(show, /el\.style\.left/, 'подсказка больше не позиционируется у курсора');
  assert.doesNotMatch(show, /el\.hidden = false/, 'плавающий meas-snap-tip больше не показывается');
  assert.match(show, /this\._snapTip\.hidden = true/, 'на всякий случай скрываем старый элемент');
});

test('r169: autoVal не выводит false/true/undefined вместо размера', () => {
  const fn = INS.slice(INS.indexOf('function autoVal(d)'), INS.indexOf('function autoVal(d)') + 650);
  assert.match(fn, /v === false/, 'boolean false отбрасывается');
  assert.match(fn, /v === true/, 'boolean true отбрасывается');
  assert.match(fn, /undefined\|null|undefined/);
  assert.match(fn, /return \(d && d\.text\) \|\| '—'/, 'вместо false — подпись или прочерк');
});

test('r169: 30+ кнопок needs:cloud в реестре и они не блокируются инспектором (r145-регрессия)', () => {
  const cloud = CMD.all().filter((x) => x.item && x.item.needs === 'cloud');
  assert.ok(cloud.length >= 30, 'кнопок needs:cloud: ' + cloud.length);
  for (const { item } of cloud) {
    assert.ok(item.sel || item.call || item.slot || item.special || item.kind === 'select', item.id + ': нет способа запуска');
  }
  // гейт ленты: снимает aria-disabled, если облако открыто; инспектор не должен его включать обратно
  const ribbon = read('renderer/ui/ribbon.js');
  assert.match(ribbon, /var ok = item\.needs === 'bim' \? bim : cloud;/);
  assert.match(ribbon, /if \(ok\) b\.removeAttribute\('aria-disabled'\); else b\.setAttribute\('aria-disabled', 'true'\)/);
});

test('r169: инспектор не закрывает/не подменяет основное облако при открытии', () => {
  assert.match(INS, /function openWithCloud\(cloud, title\)/);
  assert.doesNotMatch(INS, /viewer\.loadCloud\(/, 'инспектор рисует объект в своём вьювере, а не в основном');
  assert.match(INS, /ensureViewer\(\)/, 'отдельный вьювер инспектора');
});
