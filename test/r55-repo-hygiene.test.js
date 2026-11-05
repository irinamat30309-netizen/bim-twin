'use strict';
// Ревизия 55: порядок в репозитории — в `scan2bim-ai-server/models/` лежал файл с именем-«кракозяброй»
// (UTF-8, прочитанный как CP866). Тест не даёт вернуть такие имена и проверяет памятку про веса.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');

const MOJIBAKE = /[╨╩╪╫╬╧╤╥╣╢╡╠╟╞╝╜╛║╗╖╕╔╓╒╘╙╚]/;

test('r55: в репозитории нет имён файлов-«кракозябр», памятка про веса читается', () => {
  const out = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files'], { cwd: ROOT, encoding: 'utf8' });
  const bad = out.split('\n').filter(p => p && MOJIBAKE.test(p));
  assert.deepStrictEqual(bad, [], 'имена-кракозябры: ' + bad.join(', '));
  const dir = path.join(ROOT, 'scan2bim-ai-server', 'models');
  const names = fs.readdirSync(dir);
  assert.ok(names.includes('PUT-WEIGHTS-HERE.txt'), 'памятка про веса: ' + names.join(', '));
  assert.ok(!names.some(n => MOJIBAKE.test(n)), 'в models нет кракозябр: ' + names.join(', '));
  const txt = fs.readFileSync(path.join(dir, 'PUT-WEIGHTS-HERE.txt'), 'utf8');
  assert.match(txt, /PointTransformerV3|model_best\.pth/, 'памятка объясняет, какой файл класть');
});
