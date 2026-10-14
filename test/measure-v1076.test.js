const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', 'renderer', p), 'utf8');
const HTML = read('index.html');
const CSS = read('ui/tools.css') + '\n' + read('ui/shell.css');
const COMMANDS = require('../renderer/ui/commands.js');
const APP = read('app.js');

// —— Панель режима измерения: компактный HUD над сценой, а выбор режимов — сгруппирован на вкладке «Измерения» ——
test('index.html: measureBar — отдельный HUD-блок с заголовком режима и действиями', () => {
  assert.ok(HTML.includes('id="measureBar" class="hud hud-measure"'), 'measureBar не hud');
  assert.ok(HTML.includes('class="hud-title"'), 'нет заголовка панели');
  assert.ok(HTML.includes('class="hud-actions"'), 'нет блока действий');
});

test('лента «Измерения»: группы с подписями (режим, замеры, плоскости, привязка, результаты, объект)', () => {
  const tab = COMMANDS.TABS.find((t) => t.id === 'measure');
  assert.ok(tab, 'нет вкладки «Измерения»');
  assert.ok(tab.groups.length >= 4, 'ожидалось ≥ 4 групп, найдено ' + tab.groups.length);
  for (const g of tab.groups) assert.ok(g.label, 'у группы ' + g.id + ' нет подписи');
  for (const g of ['Замеры', 'Плоскости', 'Привязка', 'Результаты']) {
    assert.ok(tab.groups.some((x) => x.label === g), 'нет группы: ' + g);
  }
});

test('index.html: баланс <div> внутри measureBar', () => {
  const start = HTML.indexOf('id="measureBar"');
  const end = HTML.indexOf('</section>', start);
  const block = HTML.slice(start, end);
  const opens = (block.match(/<div/g) || []).length;
  const closes = (block.match(/<\/div>/g) || []).length;
  assert.ok(opens > 0, 'в measureBar есть вложенные блоки');
  assert.strictEqual(opens, closes, 'небаланс div: ' + opens + ' вс ' + closes);
});

test('стили: HUD-панель и группы ленты', () => {
  assert.ok(CSS.includes('.hud {'), 'нет .hud');
  assert.ok(CSS.includes('.hud-title'), 'нет .hud-title');
  assert.ok(CSS.includes('.lx-group'), 'нет .lx-group');
  assert.ok(CSS.includes('.lx-glabel'), 'нет .lx-glabel');
});

test('app.js: выбор режимов через [data-mm] (кнопки живут в ленте, а не только в панели)', () => {
  assert.ok(APP.includes("querySelectorAll('[data-mm]')"), 'селектор режимов изменён');
  assert.ok(!APP.includes("querySelectorAll('#measureBar [data-mm]')"), 'режимы не должны привязываться к панели HUD');
});
