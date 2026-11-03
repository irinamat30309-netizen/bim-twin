// r11: второе облако не заменяет первое — «Добавить к проекту» (все облака на экране), цвета при слиянии не чернеют
const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const path = require('path');
const R = (...a) => fs.readFileSync(path.join(__dirname, '..', ...a), 'utf8');
test('открытие второго облака спрашивает: добавить к проекту или заменить', () => {
  const app = R('renderer', 'app.js');
  assert.match(app, /Открыть ещё одно облако/);
  assert.match(app, /okLabel: 'Добавить к проекту', cancelLabel: 'Заменить текущее'/);
  assert.match(app, /TX\.addParsedCloud\(pr, localPath \|\| file\.name\)/);
  assert.match(app, /viewer\._cloudRecord\) \? TX\.addableCount\(\) : 0/, 'заглушка-комната без облака вопрос не вызывает');
});
test('addParsedCloud совмещает по srcXform/CRS тем же путём, что «Объединить»', () => {
  const x = R('renderer', 'lixel-tools-ext.js');
  assert.match(x, /async function alignSecond\(pr, f, opts\)/);
  assert.match(x, /return alignSecond\(pr, f, opts\)/);
  assert.match(x, /addParsedCloud: addParsedCloud, addableCount: addableCount/);
  assert.match(x, /requireComparable: true/);
});
