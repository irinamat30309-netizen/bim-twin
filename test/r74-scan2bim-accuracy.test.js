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
  if (sc.column) {
    const c = sc.column, half = c.size / 2;
    for (let y = 0.05; y < sc.H - 0.05; y += 0.05) for (let o = -half; o <= half; o += 0.05) {
      pts.push([c.x + o, y, c.z - half], [c.x + o, y, c.z + half], [c.x - half, y, c.z + o], [c.x + half, y, c.z + o]);
    }
  }
  if (sc.beam) {
    const b = sc.beam, y0 = sc.H - b.h;
    for (let x = b.x0; x <= b.x1; x += 0.05) for (let zo = -b.w / 2; zo <= b.w / 2; zo += 0.05) pts.push([x, y0, b.z + zo], [x, sc.H, b.z + zo]);
    for (let x = b.x0; x <= b.x1; x += 0.05) for (let y = y0; y <= sc.H; y += 0.05) pts.push([x, y, b.z - b.w / 2], [x, y, b.z + b.w / 2]);
  }
  if (sc.furniture) {
    for (const f of sc.furniture) {
      for (let x = f.x0; x <= f.x1; x += 0.06) for (let z = f.z0; z <= f.z1; z += 0.06) for (let y = f.y0; y <= f.y1; y += 0.06) {
        const edge = x <= f.x0 + 0.06 || x >= f.x1 - 0.06 || z <= f.z0 + 0.06 || z >= f.z1 - 0.06 || y >= f.y1 - 0.06;
        if (edge) pts.push([x, y, z]);
      }
    }
  }
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

test('r74: перекрытия — пол и потолок, площадь плиты и отметка уровня в допуске', () => {
  assert.equal(model.slabs.length, 2, 'плит: ' + model.slabs.length);
  const floor = model.slabs.find(s => s.type === 'floor');
  const ceil = model.slabs.find(s => s.type === 'ceiling');
  assert.ok(floor && ceil, 'нужны пол и потолок');
  assert.ok(Math.abs(floor.level) <= 0.01, 'отметка пола ' + floor.level);
  assert.ok(Math.abs(ceil.level - sc.H) <= 0.01, 'отметка потолка ' + ceil.level);
  const gtArea = (8 + 0.24) * (6 + 0.24);
  assert.ok(Math.abs(S.polyArea(floor.polygon) - gtArea) / gtArea <= 0.01, 'площадь плиты ' + S.polyArea(floor.polygon));
  assert.ok(Math.abs(floor.thickness - 0.2) <= 0.01, 'толщина плиты ' + floor.thickness);
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

test('r74: колонна и балка находятся и экспортируются в IFC', () => {
  const sc2 = scene();
  sc2.column = { x: 6.0, z: 4.0, size: 0.4 };
  sc2.beam = { x0: 3.0, x1: 7.6, z: 2.0, w: 0.3, h: 0.12 };
  const m = S.reconstruct(cloud(sc2, 0.03, 0.004), { voxel: 0.04 });
  assert.equal(m.ok, true, m.error);
  const cols = m.objects.filter(o => o.kind === 'column');
  assert.equal(cols.length, 1, 'колонн: ' + cols.length);
  assert.ok(Math.abs(cols[0].cx - 6.0) <= 0.05 && Math.abs(cols[0].cz - 4.0) <= 0.05, `центр колонны ${cols[0].cx},${cols[0].cz}`);
  assert.equal(m.beams.length, 1, 'балок: ' + m.beams.length);
  assert.ok(Math.abs(m.beams[0].length - 4.6) <= 0.15, 'длина балки ' + m.beams[0].length);
  const ifc = S.toIFC(m, { name: 'struct.ifc' });
  assert.equal((ifc.match(/=IFCCOLUMN\(/g) || []).length, 1, 'IfcColumn');
  assert.equal((ifc.match(/=IFCBEAM\(/g) || []).length, 1, 'IfcBeam');
});

test('r74: высокая мебель у стены не становится стеной', () => {
  const sc3 = scene();
  sc3.furniture = [{ x0: 0.15, x1: 0.75, z0: 3.0, z1: 4.6, y0: 0, y1: 2.0 }];
  const m = S.reconstruct(cloud(sc3, 0.03, 0.004), { voxel: 0.04 });
  assert.equal(m.ok, true, m.error);
  assert.equal(m.walls.length, 5, 'стен: ' + m.walls.length);
  assert.ok(m.objects.some(o => o.kind === 'equipment'), 'шкаф должен попасть в объекты');
});

// два этажа по 3 м: плиты на 0, 3 и 6 → два этажа, у каждого свои стены и проёмы
function twoStoreyCloud(step = 0.04) {
  const W = 8, D = 6, H = 3, T = 0.25, rand = rng(5), pts = [];
  const rings = () => [
    { a: [0, 0], b: [W, 0], t: T, openings: [{ s0: 1.5, s1: 2.9, z0: 0.9, z1: 2.3 }] },
    { a: [W, 0], b: [W, D], t: T, openings: [] },
    { a: [W, D], b: [0, D], t: T, openings: [] },
    { a: [0, D], b: [0, 0], t: T, openings: [] }
  ];
  const levels = [
    { y: 0, walls: rings() },
    { y: H, walls: rings().concat([{ a: [4, 0.12], b: [4, D - 0.12], t: 0.12, openings: [{ s0: 2.0, s1: 2.9, z0: 0, z1: 2.1 }] }]) }
  ];
  for (const lv of levels) {
    for (const w of lv.walls) {
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      const dx = (w.b[0] - w.a[0]) / len, dz = (w.b[1] - w.a[1]) / len, nx = -dz, nz = dx;
      for (const side of [-1, 1]) for (let s = 0; s <= len; s += step) for (let z = 0.02; z <= H - 0.02; z += step) {
        let hole = false;
        for (const o of (w.openings || [])) if (s >= o.s0 && s <= o.s1 && z >= o.z0 && z <= o.z1) hole = true;
        if (hole) continue;
        const off = side * w.t / 2 + (rand() - 0.5) * 0.004;
        pts.push([w.a[0] + dx * s + nx * off, lv.y + z, w.a[1] + dz * s + nz * off]);
      }
    }
    for (let x = 0; x <= W; x += 0.08) for (let z = 0; z <= D; z += 0.08) pts.push([x, lv.y, z]);
  }
  for (let x = 0; x <= W; x += 0.08) for (let z = 0; z <= D; z += 0.08) pts.push([x, 2 * H, z]);
  return pts;
}

test('r74: фасад — уровни по полосам перекрытий, 3 этажа по 3 м', () => {
  // фасад 20 м, три этажа: вертикальная стена + горизонтальные полосы перекрытий
  const H = 3, T = 0.3, len = 20, floors = 3, step = 0.05, rnd = rng(9), pts = [];
  const wins = (f) => [0, 1, 2, 3, 4, 5].map(k => ({ s0: 1.2 + k * 3.1, s1: 2.6 + k * 3.1, z0: 0.9 + (f % 2) * 0.1, z1: 2.3 }));
  for (let f = 0; f < floors; f++) {
    const y0 = f * H, ops = wins(f);
    for (const side of [-1, 1]) for (let s = 0; s <= len; s += step) for (let z = 0.02; z <= H - 0.02; z += step) {
      let hole = false;
      for (const o of ops) if (s >= o.s0 && s <= o.s1 && z >= o.z0 && z <= o.z1) hole = true;
      if (hole) continue;
      pts.push([-len / 2 + s, y0 + z + (rnd() - 0.5) * 0.004, side * T / 2]);
    }
    // полосы перекрытий (пол этажа и его потолок)
    for (const y of [y0, y0 + H]) {
      for (let x = -len / 2; x <= len / 2; x += 0.1) for (let z = -0.35; z <= 0.35; z += 0.1) {
        pts.push([x, y + (rnd() - 0.5) * 0.004, z]);
      }
    }
  }
  const levels = S.detectStoreys(pts);
  assert.equal(levels.length, floors, 'уровней: ' + levels.length);
  for (let f = 0; f < floors; f++) assert.ok(Math.abs(levels[f].floorY - f * H) <= 0.05, `уровень ${f}: ${levels[f].floorY}`);
  const m = S.reconstruct(pts, { voxel: 0.05 });
  assert.equal(m.ok, true, m.error);
  assert.equal(m.storeys.length, floors, 'этажей: ' + m.storeys.length);
  for (let f = 0; f < floors; f++) {
    const st = m.storeys[f];
    assert.ok(Math.abs(st.floorY - f * H) <= 0.05, `пол этажа ${f + 1}: ${st.floorY}`);
    assert.ok(Math.abs(st.height - H) <= 0.08, `высота этажа ${f + 1}: ${st.height}`);
    assert.equal(st.walls.length, 1, `стен на этаже ${f + 1}: ${st.walls.length}`);
    assert.equal(st.walls[0].openings.length, 6, `окон на этаже ${f + 1}: ${st.walls[0].openings.length}`);
  }
});

test('r74: ручной диапазон этажа (opts.range) — берётся ровно заданная полоса', () => {
  const pts = twoStoreyCloud();
  const m = S.reconstruct(pts, { voxel: 0.04, range: { floorY: 3, ceilY: 6 } });
  assert.equal(m.ok, true, m.error);
  assert.ok(!m.storeys || m.storeys.length <= 1, 'при ручном диапазоне этаж один');
  assert.ok(Math.abs(m.storey.floorY - 3) <= 0.02, 'пол ' + m.storey.floorY);
  assert.ok(Math.abs(m.storey.height - 3) <= 0.02, 'высота ' + m.storey.height);
  assert.equal(m.walls.length, 5, 'стен на втором этаже: ' + m.walls.length);
  assert.equal(m.stats.openingCount, 2, 'проёмов: ' + m.stats.openingCount);
  const ifc = S.toIFC(m, { name: 'range.ifc' });
  assert.equal((ifc.match(/=IFCBUILDINGSTOREY\(/g) || []).length, 1, 'один этаж в IFC');
});

test('r74: ручной диапазон этажа — поля в окне «Скан → BIM» и передача в движок', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'lixel-scan2bim-ui.js'), 'utf8');
  assert.match(src, /Этаж: пол, м \(0 — авто\)/, 'поле «пол этажа»');
  assert.match(src, /Этаж: потолок, м \(0 — авто\)/, 'поле «потолок этажа»');
  assert.match(src, /opts\.range = \{ floorY: fY, ceilY: cY \}/, 'диапазон уходит в движок');
  assert.match(src, /delete opts\.range/, 'пустые поля возвращают автоопределение');
});

test('r74: два этажа — уровни, стены и проёмы каждого этажа, IfcBuildingStorey на этаж', () => {
  const pts = twoStoreyCloud();
  const levels = S.detectStoreys(pts);
  assert.equal(levels.length, 2, 'уровней: ' + levels.length);
  assert.ok(Math.abs(levels[0].floorY - 0) <= 0.03, 'пол 1: ' + levels[0].floorY);
  assert.ok(Math.abs(levels[1].floorY - 3) <= 0.03, 'пол 2: ' + levels[1].floorY);
  const m = S.reconstruct(pts, { voxel: 0.04 });
  assert.equal(m.ok, true, m.error);
  assert.equal(m.storeys.length, 2, 'этажей в модели: ' + m.storeys.length);
  assert.equal(m.walls.length, 9, 'стен всего: ' + m.walls.length);
  assert.equal(m.storeys[0].walls.length, 4, 'стен 1 этажа');
  assert.equal(m.storeys[1].walls.length, 5, 'стен 2 этажа');
  assert.equal(m.stats.openingCount, 3, 'проёмов: ' + m.stats.openingCount);
  const ops0 = m.storeys[0].walls.reduce((a, w) => a + (w.openings || []).length, 0);
  const ops1 = m.storeys[1].walls.reduce((a, w) => a + (w.openings || []).length, 0);
  assert.equal(ops0, 1, 'проёмов на 1 этаже');
  assert.equal(ops1, 2, 'проёмов на 2 этаже (окно + дверь)');
  for (const w of m.walls) assert.ok(w.storeyIndex === 0 || w.storeyIndex === 1, 'у стены есть номер этажа');
  const ifc = S.toIFC(m, { name: 'two.ifc' });
  assert.equal((ifc.match(/=IFCBUILDINGSTOREY\(/g) || []).length, 2, 'IfcBuildingStorey на этаж');
  assert.equal((ifc.match(/=IFCRELCONTAINEDINSPATIALSTRUCTURE\(/g) || []).length, 2, 'связь элементов по этажам');
  assert.equal((ifc.match(/=IFCWALLSTANDARDCASE\(/g) || []).length, 9, 'все стены в IFC');
  // целостность STEP: все ссылки #N существуют, все строки закрыты «;»
  const ids = new Set([...ifc.matchAll(/^#(\d+)=/gm)].map(m => '#' + m[1]));
  assert.ok(ids.size > 100, 'сущностей в IFC: ' + ids.size);
  const broken = [...ifc.matchAll(/#(\d+)/g)].map(m => '#' + m[1]).filter(r => !ids.has(r));
  assert.deepEqual(broken.slice(0, 5), [], 'битые ссылки: ' + broken.slice(0, 5).join(','));
  for (const line of ifc.split(/\r?\n/)) {
    if (/^#\d+=/.test(line)) assert.ok(line.trimEnd().endsWith(';'), 'строка без «;»: ' + line.slice(0, 60));
  }
});
