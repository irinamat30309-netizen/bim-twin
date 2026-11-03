'use strict';
// Ревизия 30: мебель под антресолью, воздуховодом и трубами (что-то ниже 2,4 м над ней) уходит из плана в слой A-FURN —
// верхний срез стал колонкой из полос по высоте; стены под низкой антресолью, с высоким окном и с навесными шкафами остаются.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const AP = require(path.join(__dirname, '..', 'renderer', 'auto-plan.js'));

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ': ' + a + ' ≠ ' + b + ' ± ' + tol);
const byArea = (p) => p.rooms.slice().sort((a, b) => b.area - a.area);

// 3D-сцена: вертикальные грани (с вырезами [t0, t1, z0, z1]) и горизонтальные плиты, шаг 2 см, шум 3 мм
function scene(seed) {
  const r = rng(seed || 3), P = [], st = 0.02;
  return {
    P,
    wall(x0, y0, x1, y1, z0, z1, holes) {
      const L = Math.hypot(x1 - x0, y1 - y0), nx = -(y1 - y0) / L, ny = (x1 - x0) / L;
      for (let t = 0; t < L; t += st) for (let z = z0; z < z1; z += st) {
        const tt = t + r() * st, zz = z + r() * st;
        if (tt > L || zz > z1 || (holes && holes.some(h => tt >= h[0] && tt <= h[1] && zz >= h[2] && zz <= h[3]))) continue;
        const e = gauss(r) * 0.003; P.push(x0 + (x1 - x0) * tt / L + nx * e, y0 + (y1 - y0) * tt / L + ny * e, zz);
      }
    },
    slab(x0, y0, x1, y1, z) { for (let x = x0; x < x1; x += st) for (let y = y0; y < y1; y += st) P.push(x + r() * st, y + r() * st, z + gauss(r) * 0.003); }
  };
}
// основной срез h0–h1 и колонка над ним из K полос (как planSlice с high.bands)
function cut(P, h0, h1, c0, c1, K) {
  const uv = [], uh = [], bd = [];
  for (let i = 0; i < P.length; i += 3) {
    const h = P[i + 2];
    if (h >= h0 && h <= h1) uv.push(P[i], P[i + 1]);
    if (h >= c0 && h <= c1) { uh.push(P[i], P[i + 1]); bd.push(Math.max(0, Math.min(K - 1, Math.floor((h - c0) / (c1 - c0) * K)))); }
  }
  return { uv: new Float32Array(uv), uvHigh: new Float32Array(uh), bandHigh: new Uint8Array(bd), highBands: K };
}

// Помещение 6 × 5 м (потолок 2,8 м). Стеллаж A 3 × 0,4 × 1,8 м у северной стены под антресолью (плита на 2,3 м, y 3,8…5);
// стеллаж B 2,2 × 0,45 × 1,8 м у восточной стены под воздуховодом 0,5 × 0,3 м (низ на 2,2 м) и поперечными трубами на 2,35 м.
function storeScene(s) {
  s = s || scene(5);
  s.wall(0, 0, 6, 0, 0, 2.8); s.wall(6, 0, 6, 5, 0, 2.8); s.wall(6, 5, 0, 5, 0, 2.8); s.wall(0, 5, 0, 0, 0, 2.8);
  s.wall(1.5, 4.6, 4.5, 4.6, 0, 1.8); s.wall(1.5, 4.6, 1.5, 5, 0, 1.8); s.wall(4.5, 4.6, 4.5, 5, 0, 1.8); s.slab(1.5, 4.6, 4.5, 5, 1.8);
  s.slab(1, 3.8, 5, 5, 2.3); s.wall(1, 3.8, 5, 3.8, 2.3, 2.36);
  s.wall(5.55, 0.8, 5.55, 3.0, 0, 1.8); s.wall(5.55, 0.8, 6, 0.8, 0, 1.8); s.wall(5.55, 3.0, 6, 3.0, 0, 1.8); s.slab(5.55, 0.8, 6, 3.0, 1.8);
  s.slab(5.3, 0, 5.8, 5, 2.2); s.wall(5.3, 0, 5.3, 5, 2.2, 2.5); s.wall(5.8, 0, 5.8, 5, 2.2, 2.5);
  for (const y of [1.4, 2.4]) { s.wall(0, y - 0.04, 6, y - 0.04, 2.31, 2.39); s.wall(0, y + 0.04, 6, y + 0.04, 2.31, 2.39); }
  return s;
}
const shelfA = (f) => Math.abs(f.length - 3) < 0.08 && Math.abs(f.a[1] - 4.6) < 0.03 && Math.abs(f.b[1] - 4.6) < 0.03;
const shelfB = (f) => Math.abs(f.length - 2.2) < 0.08 && Math.abs(f.a[0] - 5.55) < 0.03 && Math.abs(f.b[0] - 5.55) < 0.03;

test('стеллажи под антресолью и под воздуховодом уходят в A-FURN (колонка полос), прежняя полоса 2,3–2,4 м их оставляла', () => {
  const s = storeScene(), C = cut(s.P, 1.15, 1.25, 1.3, 2.45, 8);
  const p = AP.extract(C.uv, { uvHigh: C.uvHigh, bandHigh: C.bandHigh, highBands: 8 });
  assert.ok(p.stats.lowCheck.checked && p.stats.lowCheck.bands === 8, 'проверка колонкой: ' + JSON.stringify(p.stats.lowCheck));
  assert.ok(p.low.some(shelfA), 'стеллаж под антресолью в low: ' + p.low.map(f => f.length.toFixed(2)).join(' '));
  assert.ok(p.low.some(shelfB), 'стеллаж под воздуховодом в low');
  assert.ok(!p.faces.some(shelfA) && !p.faces.some(shelfB), 'фасадов нет среди стен');
  near(byArea(p)[0].area, 30, 0.3, 'помещение целиком');
  assert.equal(p.faces.filter(f => f.length > 4.8).length, 4, 'четыре стены помещения остались');
  // ревизия 29 (одна полоса 2,3–2,4 м): антресоль над стеллажом A — «есть точки сверху», стеллаж остаётся стеной
  const O = cut(s.P, 1.15, 1.25, 2.3, 2.4, 1);
  const p29 = AP.extract(O.uv, { uvHigh: O.uvHigh });
  assert.ok(p29.stats.lowCheck.checked, 'старая проверка выполнена');
  assert.ok(p29.faces.some(shelfA), 'одна полоса не отличает стеллаж под антресолью');
});

// Два помещения A (x 0…6) и B (x 6,12…10), y 0…5. Перегородка до 2,2 м, над ней антресоль (плита x 5…7,12 на 2,2 м), выше пусто;
// южная стена A — окно 4,4 м на 1,4…2,2 м (перемычка до потолка); восточная стена B — навесные шкафы 1,5…2,2 м (стена за ними не видна).
function wallsScene() {
  const s = scene(7);
  s.wall(0, 0, 6, 0, 0, 2.8, [[0.8, 5.2, 1.4, 2.2]]); s.wall(6, 5, 0, 5, 0, 2.8); s.wall(0, 5, 0, 0, 0, 2.8);
  s.wall(6, 0, 6, 5, 0, 2.2, [[2.0, 2.9, 0, 2.1]]); s.wall(6.12, 5, 6.12, 0, 0, 2.2, [[2.1, 3.0, 0, 2.1]]);
  s.slab(5, 0, 7.12, 5, 2.2);
  s.wall(6.12, 0, 10, 0, 0, 2.8); s.wall(10, 5, 6.12, 5, 0, 2.8);
  s.wall(10, 0, 10, 5, 0, 2.8, [[0.5, 4.5, 1.5, 2.2]]);
  s.wall(9.65, 0.5, 9.65, 4.5, 1.5, 2.2); s.slab(9.65, 0.5, 10, 4.5, 1.5);
  return s;
}

test('стена под низкой антресолью, стена с высоким окном и стена с навесными шкафами остаются стенами', () => {
  const C = cut(wallsScene().P, 1.15, 1.25, 1.3, 2.45, 8);
  const p = AP.extract(C.uv, { uvHigh: C.uvHigh, bandHigh: C.bandHigh, highBands: 8 });
  assert.ok(p.stats.lowCheck.checked, 'проверка выполнена');
  assert.ok(!p.low.some(f => f.length > 1.5), 'длинные грани не убраны: ' + p.low.map(f => f.length.toFixed(2) + '@' + f.a.map(v => v.toFixed(2))).join(' '));
  const R = byArea(p);
  near(R[0].area, 30, 0.3, 'A'); near(R[1].area, 3.88 * 5, 0.3, 'B');
  assert.ok(p.walls.some(w => Math.abs(w.thickness - 0.12) < 0.02), 'перегородка — стена 12 см');
});

test('колонка полос, где у части полос нет данных (выше потолка) — эти полосы не учитываются', () => {
  const s = storeScene(), C = cut(s.P, 1.15, 1.25, 1.3, 2.45, 8);
  // полосы 6–7 «выше потолка»: точек нет
  const keep = []; for (let i = 0; i < C.bandHigh.length; i++) if (C.bandHigh[i] < 6) keep.push(i);
  const uh = new Float32Array(keep.length * 2), bd = new Uint8Array(keep.length);
  keep.forEach((i, j) => { uh[j * 2] = C.uvHigh[i * 2]; uh[j * 2 + 1] = C.uvHigh[i * 2 + 1]; bd[j] = C.bandHigh[i]; });
  const p = AP.extract(C.uv, { uvHigh: uh, bandHigh: bd, highBands: 8 });
  assert.equal(p.stats.lowCheck.validBands, 6, 'годных полос: ' + p.stats.lowCheck.validBands);
  assert.ok(p.low.some(shelfA) && p.low.some(shelfB), 'стеллажи убраны по оставшимся полосам');
  assert.equal(p.faces.filter(f => f.length > 4.8).length, 4);
});

// Сквозной путь: LAS → planSlice с колонкой (high.bands, тот же проход по файлу) → поток плана, как в приложении
test('LAS: колонка полос читается тем же проходом, поток плана убирает стеллажи под антресолью и воздуховодом', async () => {
  const fs = require('fs'), os = require('os');
  const { Worker } = require('worker_threads');
  const G = require('./r27-synthetic.helper.js');
  const Seg = require(path.join(__dirname, '..', 'cloud-segments.js'));
  const OV = require(path.join(__dirname, '..', 'cloud-overview.js'));
  const s = storeScene(scene(9)); s.slab(0, 0, 6, 5, 0); s.slab(0, 0, 6, 5, 2.8);
  const pts = []; for (let i = 0; i < s.P.length; i += 3) pts.push([500000 + s.P[i], 4000000 + s.P[i + 1], 100 + s.P[i + 2]]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bim-r30-')), file = path.join(dir, 'store.las');
  G.writeLas(file, pts);
  const d = Seg.openSegmentSource(file).desc, ov = OV.overview(d, { samples: 4e6 }), fl = ov.levels[0].h;
  const high = { h0: fl + 1.3, h1: fl + 2.45, bands: 8 };
  const sl = OV.planSlice(d, { h0: fl + 1.15, h1: fl + 1.25, high });
  assert.ok(sl.countHigh > 1000 && sl.bandHigh && sl.bandHigh.length === sl.countHigh && sl.highBands === 8, 'колонка: ' + sl.countHigh);
  const seen = new Set(sl.bandHigh); assert.equal(seen.size, 8, 'все 8 полос заполнены');
  // накопитель с прореживанием: номера полос остаются при своих точках
  const sm = OV.planSlice(d, { h0: fl + 1.15, h1: fl + 1.25, high, maxHigh: 100000 });
  assert.ok(sm.countHigh <= 100000 && sm.bandHigh.length === sm.countHigh, 'прореживание колонки');
  const res = await new Promise((ok, bad) => {
    const w = new Worker(path.join(__dirname, '..', 'cloud-overview-worker.js'), { workerData: { job: 'plan', desc: d, opts: { h0: fl + 1.15, h1: fl + 1.25, high, plan: {} } } });
    w.on('message', (m) => { if (m.type === 'result') { ok(m.result); w.terminate(); } });
    w.on('error', bad);
  });
  assert.equal(res.ok, true, res.message);
  assert.ok(res.slice.high && res.slice.high.bands === 8 && res.slice.high.count === sl.countHigh, 'сводка колонки');
  const p = res.plan, cx = d.cx != null ? d.cx : null;
  assert.ok(p.stats.lowCheck.checked && p.stats.lowCheck.bands === 8, 'проверка колонкой в потоке');
  assert.ok(p.low.some(f => Math.abs(f.length - 3) < 0.08 && Math.abs(f.a[1] - f.b[1]) < 0.02), 'стеллаж A в low: ' + p.low.map(f => f.length.toFixed(2)).join(' '));
  assert.ok(p.low.some(f => Math.abs(f.length - 2.2) < 0.08 && Math.abs(f.a[0] - f.b[0]) < 0.02), 'стеллаж B в low');
  near(byArea(p)[0].area, 30, 0.3, 'помещение целиком');
  assert.ok(/\nLINE\n8\nA-FURN\n/.test(AP.toDXF(p, {})), 'слой A-FURN в DXF');
  void cx;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('IPC плана принимает колонку до 2 м и число полос; окно задаёт колонку от среза до 2,45 м', () => {
  const fs = require('fs');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), cp = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'cloud-preview.js'), 'utf8');
  assert.match(main, /hi1 - hi0 <= 2 && hi0 >= h1/);
  assert.match(main, /hiBands = Math\.max\(1, Math\.min\(8,/);
  assert.match(cp, /hiBands: hi \? hi\[2\] : null/);
  assert.match(cp, /b = f\.floor \+ 2\.45/);
});
