'use strict';
// Ревизия 8: «грузить все возможные точки» — дробный шаг выборки, потоковый индекс без потолка 40/400 млн, предложение показать все точки.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const core = require('../las-core');
const cloud = require('../las-node');
const CFG = require('../app-config');
const OB = require('../octree-build-core');
const R_ = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

function tmpFile(name) { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loadall-r8-')), name); }
function writeLas(file, n) {
  const H = 227, rec = 20, buf = Buffer.alloc(H + n * rec);
  buf.write('LASF', 0, 'latin1'); buf[24] = 1; buf[25] = 2; buf.writeUInt16LE(H, 94); buf.writeUInt32LE(H, 96); buf.writeUInt32LE(0, 100);
  buf[104] = 0; buf.writeUInt16LE(rec, 105); buf.writeUInt32LE(n, 107);
  buf.writeDoubleLE(0.01, 131); buf.writeDoubleLE(0.01, 139); buf.writeDoubleLE(0.01, 147);
  for (let i = 0; i < n; i++) { const o = H + i * rec; buf.writeInt32LE(i * 100, o); buf.writeInt32LE(((i * 7) % 13) * 100, o + 4); buf.writeInt32LE(((i * 3) % 5) * 100, o + 8); }
  fs.writeFileSync(file, buf);
}

test('keepSampledIndex: дробный шаг даёт ровно ceil(N/шаг) точек, без больших пропусков', () => {
  for (const s of [1.5, 2.0000001, 2.5, 3.37, 7.9]) {
    const N = 300007; let k = 0, last = -1, gap = 0;
    for (let i = 0; i < N; i++) if (core.keepSampledIndex(i, s)) { k++; gap = Math.max(gap, i - last); last = i; }
    assert.ok(Math.abs(k - Math.ceil(N / s)) <= 1, 'шаг ' + s + ': ' + k + ' vs ' + Math.ceil(N / s));
    assert.ok(gap <= 2 * Math.ceil(s), 'шаг ' + s + ': максимальный пропуск ' + gap);
  }
});

test('keepSampledIndex: целый шаг ведёт себя как раньше (одна точка на окно)', () => {
  const stride = 7;
  for (let w = 0; w < 500; w++) { let kept = 0; for (let g = w * stride; g < (w + 1) * stride; g++) if (core.keepSampledIndex(g, stride)) kept++; assert.equal(kept, 1); }
});

test('LAS: бюджет 40 % от файла даёт 40 % точек, а не 33 % (раньше шаг округлялся вверх до 3)', () => {
  const f = tmpFile('a.las'); writeLas(f, 500000);   // минимальный бюджет разбора — 200 000 точек
  const r = cloud.parseCloudFile(f, { maxPoints: 200000, memoryGuard: false });
  const n = r.pos.length / 3;
  assert.ok(n >= 199900 && n <= 200000, 'загружено ' + n + ' (раньше было бы 166 667)');
  const r2 = cloud.parseCloudFile(f, { maxPoints: 300000, memoryGuard: false });
  assert.ok(Math.abs(r2.pos.length / 3 - 300000) <= 100);
  const r3 = cloud.parseCloudFile(f, { maxPoints: 600000, memoryGuard: false });
  assert.equal(r3.pos.length / 3, 500000);
});

test('потоковый индекс: потолок 2 млрд (а не 40/400 млн), в main.js прореживание только если файл больше потолка', () => {
  assert.ok(CFG.OCTREE_MAX_POINTS >= 2000000000);
  assert.ok(OB.MAX_INDEX_POINTS_OUT_OF_CORE >= 2000000000);
  const m = R_('main.js');
  assert.match(m, /useOutOfCore && Number\.isSafeInteger\(sourcePointCount\) && sourcePointCount > maxPoints/);
});

test('потоковый индекс: LAS целиком, без прореживания, если бюджет не меньше файла', () => {
  const f = tmpFile('b.las'); writeLas(f, 9000);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loadall-oct-')), 'idx');
  const r = OB.buildOctreeToDisk(f, out, { maxPoints: 9000, nodeCapacity: 1000, sourcePreflightInfo: cloud.getOutOfCoreLasPointFileInfo(f) });
  assert.equal(r.indexedPointCount, 9000); assert.equal(r.sourcePointCount, 9000);
});

test('окно: после загрузки части точек предлагается потоковый режим (диалог, кнопка vtStream)', () => {
  const a = R_('renderer', 'app.js');
  assert.match(a, /function offerFullCloud\(filePath, result\)/);
  assert.match(a, /Показать все точки файла\?/);
  assert.match(a, /sb0\.click\(\)/);
  assert.ok(!/\b(confirm|prompt|alert)\(/.test(a.slice(a.indexOf('function streamOfferText'), a.indexOf('async function parseCloudWithProgress'))));
  assert.match(R_('renderer', 'lixel-cloud-ui.js'), /кнопка «Потоковый LOD»/);
});
