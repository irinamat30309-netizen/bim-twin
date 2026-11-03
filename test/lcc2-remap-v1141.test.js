'use strict';
// v1141 — регресс-тест per-tile ремапа LCC2.
// Импортирует РЕАЛЬНУЮ функцию remapTilePositions из renderer/lcc2-loader.js
// и проверяет, что позиции гауссиан восстанавливаются в мировых координатах
// с точностью <5 см на однородном (не mixed-depth) многотайловом паке —
// том самом случае, который раньше уходил в сломанный pack-global ремап
// и давал сдвиг помещений до ~16 м.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const loader = require(path.join(__dirname, '..', 'renderer', 'lcc2-loader.js'));
const { remapTilePositions } = loader;

// Детерминированный ГПСЧ
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Строим синтетическую сцену: несколько тайлов-«комнат», разбросанных по
// зданию. Каждый тайл занимает свой мировой bbox (wBMin/wBMax).
//
// КЛЮЧЕВОЕ свойство реального SOG: means каждого тайла записаны в ЕГО
// ЛОКАЛЬНОМ фрейме (относительно угла тайла), а не в единой мировой
// системе. Поэтому далёкие друг от друга комнаты имеют ПЕРЕКРЫВАЮЩИЕСЯ
// means-диапазоны, и единый pack-global ремап схлопывает их в одно место.
function buildScene() {
  const rnd = mulberry32(12345);
  // мировые bbox тайлов (метры) — комнаты в разных углах здания
  const tileBoxes = [
    { min: [0, 0, 0],      max: [4, 3, 5] },
    { min: [10, 0, 0],     max: [15, 3, 6] },
    { min: [0, 0, 12],     max: [6, 3, 18] },
    { min: [20, 0, 20],    max: [24, 3, 25] },
    { min: [-8, 0, 5],     max: [-3, 3, 9] },
    { min: [12, 0, -10],   max: [17, 3, -4] },
  ];
  const perTile = 3000;
  const truth = [];      // истинные мировые позиции
  const localMeans = []; // координаты в ЛОКАЛЬНОМ фрейме тайла (как в реальном SOG)
  const tiles = [];      // {start,count,wBMin,wBMax}
  let start = 0;
  for (const b of tileBoxes) {
    for (let i = 0; i < perTile; i++) {
      const w = [
        b.min[0] + rnd() * (b.max[0] - b.min[0]),
        b.min[1] + rnd() * (b.max[1] - b.min[1]),
        b.min[2] + rnd() * (b.max[2] - b.min[2]),
      ];
      truth.push(w);
      // каждый тайл нормализован в СВОЁМ локальном фрейме (от угла тайла)
      localMeans.push([w[0] - b.min[0], w[1] - b.min[1], w[2] - b.min[2]]);
    }
    tiles.push({ start, count: perTile, wBMin: b.min.slice(), wBMax: b.max.slice() });
    start += perTile;
  }

  // means-диапазон пака = объединённый диапазон локальных координат (общий на пак)
  const mMn = [Infinity, Infinity, Infinity];
  const mMx = [-Infinity, -Infinity, -Infinity];
  for (const p of localMeans) {
    for (let k = 0; k < 3; k++) {
      if (p[k] < mMn[k]) mMn[k] = p[k];
      if (p[k] > mMx[k]) mMx[k] = p[k];
    }
  }

  // Квантование локальных means в 16 бит через общий диапазон пака
  // (means_u = старший байт, means_l = младший) — как хранит SOG.
  const n = localMeans.length;
  const dU = new Uint8Array(n * 4);
  const dL = new Uint8Array(n * 4);
  const rG = [
    (mMx[0] - mMn[0]) / 65535,
    (mMx[1] - mMn[1]) / 65535,
    (mMx[2] - mMn[2]) / 65535,
  ];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      let q = Math.round((localMeans[i][k] - mMn[k]) / rG[k]);
      if (q < 0) q = 0; if (q > 65535) q = 65535;
      dU[i * 4 + k] = (q >> 8) & 0xff;
      dL[i * 4 + k] = q & 0xff;
    }
  }
  return { truth, tiles, mMn, mMx, dU, dL };
}

test('remapTilePositions экспортируется из lcc2-loader.js', () => {
  assert.strictEqual(typeof remapTilePositions, 'function');
});

test('per-tile ремап восстанавливает мировые позиции <5 см на однородном многотайловом паке', () => {
  const { truth, tiles, mMn, mMx, dU, dL } = buildScene();
  let worst = 0;
  for (const t of tiles) {
    const rm = remapTilePositions(dU, dL, mMn, mMx, t.start, t.count, t.wBMin, t.wBMax);
    for (let i = 0; i < t.count; i++) {
      const gi = t.start + i, p = gi * 4;
      const lx = mMn[0] + (((dU[p]     << 8) | dL[p])     * rm.rX);
      const ly = mMn[1] + (((dU[p + 1] << 8) | dL[p + 1]) * rm.rY);
      const lz = mMn[2] + (((dU[p + 2] << 8) | dL[p + 2]) * rm.rZ);
      const wx = lx * rm.scX + rm.offX;
      const wy = ly * rm.scY + rm.offY;
      const wz = lz * rm.scZ + rm.offZ;
      const d = Math.hypot(wx - truth[gi][0], wy - truth[gi][1], wz - truth[gi][2]);
      if (d > worst) worst = d;
    }
  }
  assert.ok(worst < 0.05, `worst per-tile error ${(worst * 100).toFixed(2)} cm >= 5 cm`);
});

test('сцена реально нагрузочная: сломанный pack-global дал бы сдвиг >1 м', () => {
  // Воспроизводим СТАРЫЙ pack-global ремап и убеждаемся, что он ошибается на
  // метры — иначе тест выше ничего бы не доказывал.
  const { truth, tiles, mMn, mMx, dU, dL } = buildScene();
  let pMinX = Infinity, pMaxX = -Infinity, pMinY = Infinity, pMaxY = -Infinity, pMinZ = Infinity, pMaxZ = -Infinity;
  for (const t of tiles) {
    if (t.wBMin[0] < pMinX) pMinX = t.wBMin[0]; if (t.wBMax[0] > pMaxX) pMaxX = t.wBMax[0];
    if (t.wBMin[1] < pMinY) pMinY = t.wBMin[1]; if (t.wBMax[1] > pMaxY) pMaxY = t.wBMax[1];
    if (t.wBMin[2] < pMinZ) pMinZ = t.wBMin[2]; if (t.wBMax[2] > pMaxZ) pMaxZ = t.wBMax[2];
  }
  const rG = [(mMx[0]-mMn[0])/65535, (mMx[1]-mMn[1])/65535, (mMx[2]-mMn[2])/65535];
  const spX = (mMx[0]-mMn[0])||1e-9, spY = (mMx[1]-mMn[1])||1e-9, spZ = (mMx[2]-mMn[2])||1e-9;
  const scX = (pMaxX-pMinX)/spX, scY = (pMaxY-pMinY)/spY, scZ = (pMaxZ-pMinZ)/spZ;
  const offX = pMinX-scX*mMn[0], offY = pMinY-scY*mMn[1], offZ = pMinZ-scZ*mMn[2];
  let worst = 0;
  for (const t of tiles) {
    for (let i = 0; i < t.count; i++) {
      const gi = t.start + i, p = gi * 4;
      const lx = mMn[0] + (((dU[p]     << 8) | dL[p])     * rG[0]);
      const ly = mMn[1] + (((dU[p + 1] << 8) | dL[p + 1]) * rG[1]);
      const lz = mMn[2] + (((dU[p + 2] << 8) | dL[p + 2]) * rG[2]);
      const d = Math.hypot(lx*scX+offX - truth[gi][0], ly*scY+offY - truth[gi][1], lz*scZ+offZ - truth[gi][2]);
      if (d > worst) worst = d;
    }
  }
  assert.ok(worst > 1.0, `pack-global worst error ${(worst).toFixed(2)} m should be >1 m to prove the stress case`);
});

test('тайл без bbox (env.sog, wBMin===null) → identity', () => {
  const mMn = [0, 0, 0], mMx = [10, 10, 10];
  const dU = new Uint8Array(4), dL = new Uint8Array(4);
  const rm = remapTilePositions(dU, dL, mMn, mMx, 0, 1, null, null);
  assert.strictEqual(rm.scX, 1);
  assert.strictEqual(rm.scY, 1);
  assert.strictEqual(rm.scZ, 1);
  assert.strictEqual(rm.offX, 0);
  assert.strictEqual(rm.offY, 0);
  assert.strictEqual(rm.offZ, 0);
});
