'use strict';
// Ревизия 4: бюджет точек проекта 200 млн (дефолт, миграция, защита по памяти).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../app-config');
const budget = require('../octree-resource-budget');
const lasNode = require('../las-node');

const GiB = 1024 ** 3;
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('конфиг: дефолт и минимум бюджета — 200 млн, потолок выше', () => {
  assert.strictEqual(cfg.DEFAULT_MAX_POINTS, 200000000);
  assert.strictEqual(cfg.MIN_POINT_BUDGET, 200000000);
  assert.ok(cfg.MAX_POINT_BUDGET >= cfg.MIN_POINT_BUDGET);
  assert.strictEqual(cfg.PLY_EXPORT_MAX_POINTS, 200000000);
  assert.ok(cfg.LOD_DRAW_BUDGET > 0 && cfg.LOD_DRAW_BUDGET < cfg.DEFAULT_MAX_POINTS);
  assert.ok(cfg.MIN_SAFE_PREVIEW_POINTS >= 1000000);
});

test('resolvePointBudget (ревизия 12): бюджет больше не режет облако — всегда «без ограничения», сохранённые значения игнорируются', () => {
  const r = cfg.resolvePointBudget;
  for (const st of [{}, null, undefined, { pointBudget: 'мусор' }, { pointBudget: -5 }, { pointBudget: 3000000 }, { pointBudget: 3000000, pointBudgetCustom: true }, { pointBudget: 900000000, pointBudgetCustom: true }]) assert.strictEqual(r(st), cfg.ALL_POINTS);
  assert.ok(cfg.ALL_POINTS >= 2000000000);
});

test('maxCloudPreviewPoints: монотонность и разумные пределы', () => {
  const f = budget.maxCloudPreviewPoints;
  assert.strictEqual(f(null), null);
  assert.strictEqual(f(undefined), null);
  let prev = -1;
  for (const g of [1, 2, 3, 4, 8, 16, 32, 64]) {
    const v = f(g * GiB);
    assert.ok(Number.isFinite(v) && v >= prev, g + ' ГиБ');
    prev = v;
  }
  assert.ok(f(8 * GiB) < 200000000, '8 ГиБ не вмещают 200 млн');
  assert.ok(f(8 * GiB) > 50000000);
  assert.ok(f(64 * GiB) >= 200000000, '64 ГиБ вмещают 200 млн');
});

test('effectivePointBudget: сужение по свободной памяти не ниже 3 млн', () => {
  const e = lasNode.effectivePointBudget;
  assert.strictEqual(e(200000000, { availableMemoryBytes: 64 * GiB }), 200000000);
  const cap8 = e(200000000, { availableMemoryBytes: 8 * GiB });
  assert.ok(cap8 < 200000000 && cap8 > 50000000);
  assert.strictEqual(e(200000000, { availableMemoryBytes: 0.2 * GiB }), 3000000);
  assert.strictEqual(e(200000000, { memoryGuard: false }), 200000000);
  // запрос меньше лимита памяти не увеличивается
  assert.strictEqual(e(5000000, { availableMemoryBytes: 64 * GiB }), 5000000);
});

function writeBinaryPly(file, n) {
  const header = 'ply\nformat binary_little_endian 1.0\nelement vertex ' + n +
    '\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n';
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, header);
  const REC = 15, CH = 200000;
  let done = 0;
  while (done < n) {
    const m = Math.min(CH, n - done);
    const buf = Buffer.alloc(m * REC);
    for (let i = 0; i < m; i++) {
      const k = done + i, o = i * REC;
      buf.writeFloatLE((k % 1000) * 0.01, o);
      buf.writeFloatLE(((k / 1000) % 1000 | 0) * 0.01, o + 4);
      buf.writeFloatLE((k % 7) * 0.01, o + 8);
      buf[o + 12] = k & 255; buf[o + 13] = (k >> 3) & 255; buf[o + 14] = 128;
    }
    fs.writeSync(fd, buf);
    done += m;
  }
  fs.closeSync(fd);
}

test('parseCloudFileAsync: при нехватке памяти облако прорежено и это явно сообщается', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb4-'));
  const file = path.join(dir, 'big.ply');
  const N = 3300000;
  writeBinaryPly(file, N);
  try {
    const tight = await lasNode.parseCloudFileAsync(file, { maxPoints: 200000000, availableMemoryBytes: 1e6 });
    assert.ok(tight.pointBudget, 'есть описание бюджета');
    assert.strictEqual(tight.pointBudget.memoryLimited, true);
    assert.strictEqual(tight.pointBudget.applied, 3000000);
    assert.strictEqual(tight.pointBudget.requested, 200000000);
    assert.ok(tight.count < N && tight.count <= 3000000 && tight.count >= N / 3, 'прорежено равномерным шагом, count=' + tight.count);
    // без ограничения по памяти облако читается целиком
    const full = await lasNode.parseCloudFileAsync(file, { maxPoints: 200000000, memoryGuard: false });
    assert.strictEqual(full.count, N);
    assert.ok(!full.pointBudget || !full.pointBudget.memoryLimited);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('подключение (ревизия 12): main.js берёт единый «безлимитный» бюджет, ползунка «Предел» в интерфейсе нет', () => {
  const main = read('main.js');
  const app = read('renderer/app.js');
  const html = read('renderer/index.html');
  assert.match(main, /APP_CFG\s*=\s*require\('\.\/app-config'\)/);
  assert.ok((main.match(/APP_CFG\.resolvePointBudget\(/g) || []).length >= 2, 'парсинг и октодерево берут общий бюджет');
  assert.ok(!/\b120000000\b/.test(main), 'в main.js не осталось жёсткого 120 млн');
  assert.match(app, /function lodDrawBudget\(/);
  assert.match(app, /resolvePointBudget/);
  assert.ok(!/id="qDensity"/.test(html) && !/qDensity/.test(app));
});
