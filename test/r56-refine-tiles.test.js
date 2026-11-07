'use strict';
// Ревизия 56: чистовая обработка сама дробит облако на плитки под число ядер, чтобы работали все ядра даже на
// небольших облаках (раньше облако до 4 млн точек было одной плиткой в один поток). Качество при этом не меняется.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const RP = require('../scan-refine-parallel');
const SC = require('./helpers/r20-scenes');
const ROOT = path.join(__dirname, '..');

function roomLas(file, n) {
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pts = new Array(n * 4), rgb = new Array(n * 3);
  for (let i = 0; i < n; i++) {
    const s = rnd() * 16; let x, y, z;
    if (s < 7) { x = rnd() * 10; y = rnd() * 8; z = 0; } else if (s < 10) { x = 0; y = rnd() * 8; z = rnd() * 3; }
    else if (s < 13) { x = rnd() * 10; y = 0; z = rnd() * 3; } else { x = rnd() * 10; y = 8; z = rnd() * 3; }
    pts[i * 4] = x; pts[i * 4 + 1] = y; pts[i * 4 + 2] = z; pts[i * 4 + 3] = rnd() * 100;
    rgb[i * 3] = 120 + Math.round(rnd() * 60); rgb[i * 3 + 1] = 110 + Math.round(rnd() * 60); rgb[i * 3 + 2] = 100 + Math.round(rnd() * 60);
  }
  SC.writeLas(file, pts, rgb);
}

test('r56: облако 1,8 млн точек режется на плитки само, явный tileMax уважается', async () => {
  const src = path.join(ROOT, 'scan-refine-parallel.js');
  const text = fs.readFileSync(src, 'utf8');
  assert.match(text, /if \(!opt\._tileMaxFixed\)/, 'авто-размер плитки можно выключить');
  assert.match(text, /n > 1500000 && n \/ threadsGuess < opt\.tileMax/, 'дробим только когда точек немного на поток');
  assert.match(text, /Math\.max\(600000, Math\.min\(opt\.tileMax, Math\.ceil\(n \/ \(threadsGuess \* 2\)\)\)\)/, 'не меньше 0,6 млн на плитку');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r56t-'));
  try {
    const las = path.join(dir, 'room.las'); roomLas(las, 1800000);
    const a = path.join(dir, 'auto.las'), b = path.join(dir, 'one.las');
    const sa = await RP.refineParallel(las, a, { tmpDir: dir, noiseLevel: 'normal', color: false, align: false });
    assert.ok(sa.tiles >= 3, 'плиток при авто-размере: ' + sa.tiles);
    assert.ok(sa.threads >= 2, 'потоков: ' + sa.threads);
    assert.ok(sa.written > 1500000, 'точек записано: ' + sa.written);
    const sb = await RP.refineParallel(las, b, { tmpDir: dir, noiseLevel: 'normal', color: false, align: false, tileMax: 4000000, _tileMaxFixed: true });
    assert.strictEqual(sb.tiles, 1, 'явный размер — одна плитка, как раньше');
    // качество не хуже: точек в авто-режиме не меньше, чем в одну плитку, минус доли процента у границ
    assert.ok(sb.written - sa.written < Math.ceil(sb.written * 0.002), 'разница точек у границ плиток: ' + (sb.written - sa.written));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
