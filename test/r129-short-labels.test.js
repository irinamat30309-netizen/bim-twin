'use strict';
/* r129: короткие подписи ко всем кнопкам ленты.
   Проверяем: (1) чистую функцию сокращения, (2) что лента её использует и подписи видны в CSS,
   (3) что у каждой команды в commands.js есть непустая подпись и короткий вариант не пустой. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { shortLabel, normalize } = require(path.join(ROOT, 'renderer/ui/short-label.js'));

test('shortLabel: короткие названия не меняются', () => {
  assert.strictEqual(shortLabel('Стены', 14), 'Стены');
  assert.strictEqual(shortLabel('Окна', 14), 'Окна');
  assert.strictEqual(shortLabel('Двери', 14), 'Двери');
});

test('shortLabel: длинные названия сокращаются до лимита', () => {
  const cases = [
    'Пересечение объектов', 'Конвертация и геометрия', 'Обработка облака точек',
    'Структура проекта', 'Геопривязка модели', 'Рельеф и грунт', 'Документация проекта',
    'Объединение облаков', 'Сечение плоскостью', 'Копировать выделенное',
  ];
  for (const c of cases) {
    const s = shortLabel(c, 14);
    assert.ok(s.length > 0, 'пустая подпись для: ' + c);
    assert.ok(s.length <= 14, 'длиннее 14: "' + s + '" из "' + c + '"');
    assert.ok(c.startsWith(s.split(' ')[0]) || s.split(' ')[0].length >= 3, 'нет начала названия: ' + s);
  }
});

test('shortLabel: убирает скобки и лишние пробелы', () => {
  assert.strictEqual(normalize('  План  (подвал)  '), 'План');
  assert.strictEqual(shortLabel('Разрез (1-1)', 14), 'Разрез');
  assert.strictEqual(shortLabel('  Импорт   облака ', 14), 'Импорт облака');
});

test('shortLabel: пустое и однобуквенное не падает', () => {
  assert.strictEqual(shortLabel('', 14), '');
  assert.strictEqual(shortLabel(null, 14), '');
  assert.ok(shortLabel('Суперкалифраджилистик', 14).length <= 14);
});

test('ribbon.js использует короткие подписи и хранит полное название', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/ui/ribbon.js'), 'utf8');
  assert.match(src, /__lxShortLabel/, 'лента не использует сокращатель');
  assert.match(src, /var short = item\.short \|\| shortLabelFn\(/, 'нет вычисления короткой подписи');
  assert.match(src, /l\.textContent = short/, 'подпись кнопки не сокращается');
  assert.match(src, /data-full/, 'полное название не сохраняется в data-full');
});

test('CSS показывает подписи у больших кнопок ленты', () => {
  const css = fs.readFileSync(path.join(ROOT, 'renderer/ui/shell.css'), 'utf8');
  assert.ok(!/\.lx-lg\s+\.lbl\s*\{[^}]*display:\s*none/.test(css), 'подписи снова скрыты в CSS');
  assert.match(css, /\.lx-lg \.lbl \{[^}]*display:\s*block/, 'нет правила показа подписи');
  assert.match(css, /max-width:\s*(7[0-9]|8[0-9]|9[0-9])px/, 'нет ограничения ширины подписи');
});

test('index.html подключает short-label.js до ribbon.js', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
  const iShort = html.search(/<script[^>]+ui\/short-label\.js/);
  const iRibbon = html.search(/<script[^>]+ui\/ribbon\.js/);
  assert.ok(iShort > 0, 'short-label.js не подключён');
  assert.ok(iRibbon > 0, 'ribbon.js не подключён');
  assert.ok(iShort < iRibbon, 'short-label.js должен идти до ribbon.js');
});

test('у каждой команды ленты есть подпись и она даёт короткий вариант', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/ui/commands.js'), 'utf8');
  const items = [...src.matchAll(/\bI\('([^']+)',\s*'([^']+)',\s*'([^']+)'/g)];
  assert.ok(items.length >= 40, 'слишком мало найденных команд: ' + items.length);
  for (const [, id, ico, label] of items) {
    assert.ok(label.trim().length > 0, 'пустая подпись у ' + id);
    const s = shortLabel(label, 14);
    assert.ok(s.length > 0, 'короткая подпись пуста: ' + id + ' / ' + label);
    assert.ok(s.length <= 14, 'короткая подпись длиннее 14: ' + id + ' → ' + s);
  }
});
