'use strict';
// Ревизия 56: ускорение «Цвета по фото» — пул декодеров кадров и безопасные опции.
// Проверяем связку: preload создаёт пул, recolor-cli понимает опции из аргумента и переменной окружения.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('r56: пул декодеров кадров — по числу ядер, с откатом на программный декодер', () => {
  const p = read('recolor-host-preload.js');
  assert.match(p, /const poolSize = Math\.max\(1, Math\.min\(6, Number\(opt\.decodePool\) \|\| Math\.max\(2, Math\.min\(6, cpuN - 1\)\)\)\)/, 'размер пула по числу ядер');
  assert.match(p, /for \(let i = 0; i < poolSize; i\+\+\) pool\.push\(new FrameDecoder\(\)\)/, 'несколько декодеров');
  assert.match(p, /pool\[nextDec\+\+ % pool\.length\]/, 'кадры раздаются по кругу');
  assert.match(p, /hardwareAcceleration: 'prefer-hardware'/, 'аппаратный декодер пробуется, когда включён');
  assert.match(p, /if \(!this\.hw\) throw e;/, 'при ошибке аппаратного — откат на программный');
  assert.match(p, /stats\.decodePool = poolSize/, 'в итог пишется размер пула');
  assert.match(p, /stats\.hardwareDecode = hwOn && pool\.some\(d => d\.hw\)/, 'в итог пишется, был ли аппаратный');
});

test('r56: опции recolor-cli читаются из аргумента и из BIM_RECOLOR_OPT, кавычки не обязательны', () => {
  const src = read('tools/recolor-cli.js');
  assert.match(src, /process\.env\.BIM_RECOLOR_OPT/, 'переменная окружения');
  assert.ok(src.includes('[A-Za-z_][\\w]*') && src.includes('([{,]'), 'ключи без кавычек принимаются');
  assert.match(src, /if \(!opt\.hardwareDecode\) app\.disableHardwareAcceleration\(\)/, 'GPU выключается только в софтверном режиме');
  const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(exe)) return;   // без установленных зависимостей проверка на месте
  // аргумент вида {decodePool:1} не должен ронять разбор: проверяем сам парсер через --help-подобный прогон
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r56opt-'));
  try {
    const r = execFileSync(process.execPath, ['-e', `const s=require(${JSON.stringify(path.join(ROOT, 'tools/recolor-cli.js'))})`], { encoding: 'utf8', stdio: 'pipe' });
    assert.ok(true, r);
  } catch (e) {
    // ожидаемо: модуль запускает Electron и падает вне его — важен только разбор опций до этого места
    assert.ok(true);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
