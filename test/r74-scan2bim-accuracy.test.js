'use strict';
// Ревизия 74: точность scan-to-BIM «1:1» на эталонных сценах + заполнение проёмов в IFC.
// Ошибки считаются по заведомо известной геометрии: оси стен, толщина, длина, высота, площадь, проёмы.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../renderer/scan2bim.js');

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// сцена: комната 8×6, стены 0.24, перегородка 0.12 с дверью, окно 1.4×1.4 (подоконник 0.9), высота 2.8
function scene() {
  const H = 2.8, T = 0.24, Ti = 0.12;
  return {
    H, walls: [
      { a: [0, 0], b: [8, 0], t: T, h: H, openings: [{ s0: 1.6, s1: 3.0, z0: 0.9, z1: 2.3 }] },
      { a: [8, 0], b: [8, 6], t: T, h: H, openings: [] },
      { a: [8, 6], b: [0, 6], t: T, h: H, openings: [] },
      { a: [0, 6], b: [0, 0], t: T, h: H, openings: [] },
      { a: [4, 0.12], b: [4, 6 - 0.12], t: Ti, h: H, openings: [{ s0: 1.8, s1: 2.7, z0: 0, z1: 2.1 }] }
    ]
  };
}

function cloud(sc, step = 0.02, noise = 0.004) {
  const rand = rng(7), pts = [];
  const W = sc.w || 8, D = sc.d || 6;
  for (const w of sc.walls) {
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const dx = (w.b[0] - w.a[0]) / len, dz = (w.b[1] - w.a[1]) / len, nx = -dz, nz = dx;
    for (const side of [-1, 1]) for (let s = 0; s <= len; s += step) for (let z = 0.02; z <= w.h - 0.02; z += step) {
      let hole = false;
      for (const o of (w.openings || [])) if (s >= o.s0 && s <= o.s1 && z >= o.z0 && z <= o.z1) hole = true;
      if (hole) continue;
      const off = side * w.t / 2 + (rand() - 0.5) * noise;
      pts.push([w.a[0] + dx * s + nx * off + (rand() - 0.5) * noise, z + (rand() - 0.5) * noise, w.a[1] + dz * s + nz * off + (rand() - 0.5) * noise]);
    }
  }
  for (let x = 0; x <= W; x += 0.1) for (let z = 0; z <= D; z += 0.1) { pts.push([x, 0, z]); pts.push([x, sc.H, z]); }
  return pts;
}

const sc = scene();
const model = S.reconstruct(cloud(sc), { voxel: 0.04 });

test('r74: оси стен, толщина, длины, высота и площадь — в допусках 1:1', () => {
  assert.equal(model.ok, true, model.error);
  assert.equal(model.walls.length, 5, 'должно быть 5 стен, найдено ' + model.walls.length);
  assert.ok(Math.abs(model.storey.height - sc.H) <= 0.01, 'высота ' + model.storey.height);
  assert.ok(Math.abs(model.stats.floorArea - (8 + 0.24) * (6 + 0.24)) / ((8 + 0.24) * (6 + 0.24)) <= 0.01, 'площадь ' + model.stats.floorArea);
  // каждая эталонная стена должна найтись рядом со своей осью
  for (const g of sc.walls) {
    const gm = [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2];
    let best = Infinity, bw = null;
    for (const w of model.walls) {
      const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1], L2 = dx * dx + dz * dz;
      let t = L2 ? ((gm[0] - w.a[0]) * dx + (gm[1] - w.a[1]) * dz) / L2 : 0; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(gm[0] - (w.a[0] + dx * t), gm[1] - (w.a[1] + dz * t));
      if (d < best) { best = d; bw = w; }
    }
    assert.ok(best <= 0.02, `стена ${g.a}→${g.b}: сдвиг оси ${best.toFixed(3)} м`);
    assert.ok(Math.abs(bw.thickness - g.t) <= 0.02, `толщина ${bw.thickness.toFixed(3)} вместо ${g.t}`);
    const gtLen = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]);
    assert.ok(Math.abs(bw.length - gtLen) <= 0.05, `длина ${bw.length.toFixed(2)} вместо ${gtLen}`);
  }
});

test('r74: проёмы — двери и окна найдены с размерами в допуске 3 см', () => {
  const total = model.stats.openingCount;
  assert.equal(total, 2, 'проёмов: ' + total);
  const win = model.walls.map(w => w).flatMap(w => (w.openings || []).map(o => ({ w, o }))).find(x => x.o.kind === 'window');
  const door = model.walls.map(w => w).flatMap(w => (w.openings || []).map(o => ({ w, o }))).find(x => x.o.kind === 'door');
  assert.ok(win, 'окно не найдено');
  assert.ok(door, 'дверь не найдена');
  assert.ok(Math.abs(win.o.width - 1.4) <= 0.06, 'ширина окна ' + win.o.width.toFixed(3));
  assert.ok(Math.abs(win.o.sill - 0.9) <= 0.06, 'подоконник ' + win.o.sill.toFixed(3));
  assert.ok(Math.abs(win.o.head - 2.3) <= 0.06, 'перемычка ' + win.o.head.toFixed(3));
  assert.ok(Math.abs(door.o.width - 0.9) <= 0.06, 'ширина двери ' + door.o.width.toFixed(3));
  assert.ok(door.o.sill <= 0.05, 'дверь должна начинаться от пола');
  assert.ok(Math.abs(door.o.head - 2.1) <= 0.08, 'высота двери ' + door.o.head.toFixed(3));
});

test('r74: IFC — окно и дверь заполняют проёмы (IfcRelFillsElement)', () => {
  const step = S.toIFC(model, { name: 'model.ifc' });
  const count = (re) => (step.match(re) || []).length;
  assert.equal(count(/=IFCOPENINGELEMENT\(/g), 2, 'проёмы');
  assert.equal(count(/=IFCRELVOIDSELEMENT\(/g), 2, 'вырезы');
  assert.equal(count(/=IFCWINDOW\(/g), 1, 'окно в IFC');
  assert.equal(count(/=IFCDOOR\(/g), 1, 'дверь в IFC');
  assert.equal(count(/=IFCRELFILLSELEMENT\(/g), 2, 'связи заполнения');
  // каждая связь заполнения ссылается на проём и на окно/дверь
  const ents = new Map();
  for (const line of step.split(/\r?\n/)) { const m = line.match(/^#(\d+)=(\w+)\((.*)\);$/); if (m) ents.set('#' + m[1], m[2]); }
  for (const line of step.split(/\r?\n/)) {
    const m = line.match(/^#(\d+)=IFCRELFILLSELEMENT\((.*)\);$/);
    if (!m) continue;
    const refs = m[2].match(/,(#\d+),(#\d+)$/);
    assert.ok(refs, 'связь заполнения без ссылок: ' + line);
    assert.equal(ents.get(refs[1]), 'IFCOPENINGELEMENT');
    assert.ok(['IFCWINDOW', 'IFCDOOR'].includes(ents.get(refs[2])), 'заполнение ' + ents.get(refs[2]));
  }
});

test('r74: помещения — три комнаты с площадями в допуске 5 %, в IFC как IfcSpace', () => {
  // квартира 12×6: две перегородки 0.1 с дверями → три помещения по ~ (12/3 - 0.1) × (6 - 0.28)
  const H = 2.7, T = 0.28, Ti = 0.1;
  const sc3 = {
    H, w: 12, d: 6, walls: [
      { a: [0, 0], b: [12, 0], t: T, h: H, openings: [] },
      { a: [12, 0], b: [12, 6], t: T, h: H, openings: [] },
      { a: [12, 6], b: [0, 6], t: T, h: H, openings: [] },
      { a: [0, 6], b: [0, 0], t: T, h: H, openings: [] },
      { a: [4, 0], b: [4, 6], t: Ti, h: H, openings: [{ s0: 2.5, s1: 3.4, z0: 0, z1: 2.0 }] },
      { a: [8, 0], b: [8, 6], t: Ti, h: H, openings: [{ s0: 2.5, s1: 3.4, z0: 0, z1: 2.0 }] }
    ]
  };
  const m3 = S.reconstruct(cloud(sc3, 0.06, 0.004), { voxel: 0.05 });
  assert.equal(m3.ok, true, m3.error);
  assert.equal(m3.rooms.length, 3, 'комнат: ' + m3.rooms.length);
  const expect = (12 - 2 * T - 2 * Ti) / 3 * (6 - 2 * (T / 2));
  for (const r of m3.rooms) {
    assert.ok(Math.abs(r.area - expect) / expect <= 0.05, `площадь комнаты ${r.area.toFixed(2)} вместо ${expect.toFixed(2)}`);
  }
  const totalRoomArea = m3.rooms.reduce((a, r) => a + r.area, 0);
  assert.ok(Math.abs(totalRoomArea - 3 * expect) / (3 * expect) <= 0.05, 'сумма площадей ' + totalRoomArea.toFixed(2));
  const ifc = S.toIFC(m3, { name: 'rooms.ifc' });
  assert.equal((ifc.match(/=IFCSPACE\(/g) || []).length, 3, 'IfcSpace в IFC');
  assert.equal((ifc.match(/=IFCRELAGGREGATES\(/g) || []).length, 4, 'этаж + помещения');
});
