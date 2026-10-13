'use strict';
// Ревизия 14: ВСЕ точки файла показываются всегда — и в покое, и при движении камеры; ничего не режется без согласия пользователя.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const cfg = require('../app-config.js');
const cloud = require('../las-node.js');

test('конфиг: предел обычного режима = предел одного буфера вьюера (170 млн), бюджет показа не ограничен', () => {
  assert.equal(cfg.MAX_SINGLE_BUFFER_POINTS, 170000000);
  assert.match(read('renderer/webgl-viewer.js'), new RegExp('this\\._maxSingleBuffer = ' + cfg.MAX_SINGLE_BUFFER_POINTS));
  assert.equal(cfg.resolvePointBudget({ pointBudget: 1000 }), 2000000000);
  assert.equal(cfg.resolvePointShare({ pointShare: 0.1 }), 1);
});

test('вьюер: по умолчанию при движении рисуются все точки (100 %), «Авто» и проценты — только по выбору', () => {
  const w = read('renderer/webgl-viewer.js');
  assert.match(w, /this\._octAll = true; this\._octMovePct = 100/);
  assert.match(w, /o\._shuffled && !o\._lod && !\(this\._octMovePct >= 100\)/, 'обычный режим: при 100 % срез и бюджет не применяются');
  assert.match(w, /allMode = this\._octMovePct >= 100/);
  assert.match(w, /if \(inter && !allMode\) \{/, 'поток: при 100 % бюджет кадра — как в покое');
  assert.match(w, /tPx: \(inter && !pctMode && !allMode\) \? 1\.7 : 0\.0001/);
  assert.match(w, /maxNodes: \(inter && !allMode\) \? 6000 : 400000/);
  globalThis.window = { dispatchEvent() {} };
  const { Viewer3DGL } = require('../renderer/webgl-viewer.js');
  const v = Object.create(Viewer3DGL.prototype); v.render = () => {};
  assert.equal(v.setOctreeMovePercent(100), 100);
  assert.equal(v.setOctreeMovePercent(250), 100);
  assert.equal(v.setOctreeMovePercent(25), 25);
  assert.equal(v.setOctreeMovePercent(0), 0);
  assert.equal(v.setOctreeMovePercent('abc'), 0);
});

test('окно: «При движении» — «Все точки» по умолчанию, старое сохранённое «Авто» не переносится', () => {
  const a = read('renderer/app.js');
  assert.match(a, /\['100', 'Все точки \(без срезания\)'\]/);
  assert.match(a, /lsGet\('bim\.stream\.move2', '100'\)/);
  assert.match(a, /lsSet\('bim\.stream\.move2', qMove\.value\)/);
  assert.ok(!/lsGet\('bim\.stream\.move',/.test(a));
});

test('main: чтение целиком без «свободной памяти»; отказ — только если не влезает в ОЗУ/буфер или выделение памяти реально упало', () => {
  const m = read('main.js');
  const h = m.slice(m.indexOf("ipcMain.handle('bim:parseCloud'"), m.indexOf("ipcMain.handle('bim:readCloudChunk'"));
  assert.match(h, /availableMemoryBytes: require\('os'\)\.totalmem\(\)/);
  assert.match(h, /APP_CFG\.MAX_SINGLE_BUFFER_POINTS/);
  assert.match(h, /memoryGuard: \(previewOnly \|\| allowReduced\) \? undefined : false/);
  assert.match(h, /out of memory\|allocation failed/);
  assert.ok(!/cloud\.effectivePointBudget\(peek, \{\}\)/.test(h), 'свободная память больше не повод отказать');
});

test('1 млн и 3,3 млн точек читаются ЦЕЛИКОМ даже при «нулевой свободной памяти» (memoryGuard:false), ничего не урезается', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r14-'));
  try {
    for (const N of [1000000, 3300000]) {
      const f = path.join(dir, 'c' + N + '.ply');
      const head = Buffer.from('ply\nformat binary_little_endian 1.0\nelement vertex ' + N + '\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n');
      const body = Buffer.alloc(N * 15);
      for (let i = 0; i < N; i++) { const o = i * 15; body.writeFloatLE((i % 1000) * 0.01, o); body.writeFloatLE(((i / 1000) | 0) % 1000 * 0.01, o + 4); body.writeFloatLE((i % 7) * 0.01, o + 8); body[o + 12] = i & 255; body[o + 13] = 100; body[o + 14] = 50; }
      fs.writeFileSync(f, Buffer.concat([head, body]));
      const r = await cloud.parseCloudFileAsync(f, { maxPoints: 2000000000, memoryGuard: false });
      assert.equal(r.ok, true);
      assert.equal(r.count || r.pos.length / 3, N, 'все точки файла на месте');
      assert.ok(!r.pointBudget, 'ничего не урезано');
      fs.rmSync(f);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('effectivePointBudget по ОЗУ: 1 млн и 40 млн точек на машине с 16 ГБ — целиком; 400 млн — нет', () => {
  const GB = 1024 ** 3;
  assert.equal(cloud.effectivePointBudget(1000000, { availableMemoryBytes: 16 * GB }), 1000000);
  assert.equal(cloud.effectivePointBudget(40000000, { availableMemoryBytes: 16 * GB }), 40000000);
  assert.ok(cloud.effectivePointBudget(400000000, { availableMemoryBytes: 16 * GB }) < 400000000);
});
