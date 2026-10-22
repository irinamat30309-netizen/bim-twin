'use strict';
// Чистовая обработка скана в новый LAS: шумная стена становится тоньше, одиночный выброс удаляется, цветовой выброс исправляется,
// движущиеся воксели вырезаются, заголовок результата корректен; плитки с перекрытием дают тот же результат, что одна плитка.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../scan-refine-core');

// LAS 1.2, формат 2 (26 байт: xyz, интенсивность, флаги, класс, угол, user, source, RGB в +20)
function writeLas(file, P, C) {
  const n = P.length / 3, H = Buffer.alloc(227), sc = 0.0001;
  H.write('LASF', 0, 'latin1'); H[24] = 1; H[25] = 2; H.writeUInt16LE(227, 94); H.writeUInt32LE(227, 96); H[104] = 2; H.writeUInt16LE(26, 105); H.writeUInt32LE(n, 107); H.writeUInt32LE(n, 111);
  H.writeDoubleLE(sc, 131); H.writeDoubleLE(sc, 139); H.writeDoubleLE(sc, 147);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { const v = P[i * 3 + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
  H.writeDoubleLE(mx[0], 179); H.writeDoubleLE(mn[0], 187); H.writeDoubleLE(mx[1], 195); H.writeDoubleLE(mn[1], 203); H.writeDoubleLE(mx[2], 211); H.writeDoubleLE(mn[2], 219);
  const B = Buffer.alloc(n * 26);
  for (let i = 0; i < n; i++) { const o = i * 26; for (let a = 0; a < 3; a++) B.writeInt32LE(Math.round(P[i * 3 + a] / sc), o + a * 4); for (let a = 0; a < 3; a++) B.writeUInt16LE(C[i * 3 + a], o + 20 + a * 2); }
  fs.writeFileSync(file, Buffer.concat([H, B]));
}
function readLas(file) {
  const b = fs.readFileSync(file), off = b.readUInt32LE(96), rl = b.readUInt16LE(105), n = b.readUInt32LE(107), s = b.readDoubleLE(131);
  const P = new Float64Array(n * 3), C = new Uint16Array(n * 3);
  for (let i = 0; i < n; i++) { const o = off + i * rl; for (let a = 0; a < 3; a++) { P[i * 3 + a] = b.readInt32LE(o + a * 4) * s; C[i * 3 + a] = b.readUInt16LE(o + 20 + a * 2); } }
  return { n, P, C, size: b.length, off, rl, minX: b.readDoubleLE(187), maxX: b.readDoubleLE(179), minZ: b.readDoubleLE(219), maxZ: b.readDoubleLE(211) };
}
// стена x ∈ [0, 6], z ∈ [0, 3] в плоскости y = 2 с шумом ±4 мм; серая; один «блик» и одна точка в воздухе
function scene() {
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const P = [], C = [];
  for (let i = 0; i < 120000; i++) { P.push(rnd() * 6, 2 + (rnd() + rnd() + rnd() - 1.5) * 0.008, rnd() * 3); C.push(120, 120, 120); }
  C[3000 * 3] = C[3000 * 3 + 1] = C[3000 * 3 + 2] = 255;   // блик
  P.push(3, 4, 1.5); C.push(120, 120, 120);                  // одиночная точка в 2 м от стены
  return { P: Float64Array.from(P), C: Uint16Array.from(C) };
}
const rms = (P, n) => { let m = 0; for (let i = 0; i < n; i++) m += P[i * 3 + 1]; m /= n; let s = 0; for (let i = 0; i < n; i++) s += (P[i * 3 + 1] - m) ** 2; return Math.sqrt(s / n); };

test('стена тоньше, выброс и блик убраны, заголовок корректен; плитки не меняют результат', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refine-')), src = path.join(dir, 's.las'), dst = path.join(dir, 'o.las'), dst2 = path.join(dir, 'o2.las');
  try {
    const S = scene(); writeLas(src, S.P, S.C);
    const st = R.refine(src, dst, {});
    const O = readLas(dst);
    assert.strictEqual(st.written, O.n); assert.strictEqual(O.size, O.off + O.n * O.rl);
    assert.ok(st.noise >= 1 && O.n >= 120000 - 50, `удалено лишнего: ${120001 - O.n}`);
    for (let i = 0; i < O.n; i++) assert.ok(Math.abs(O.P[i * 3 + 1] - 2) < 0.05, 'точка вне стены осталась');
    const r0 = rms(S.P, 120000), r1 = rms(O.P, O.n);
    assert.ok(r1 < r0 * 0.5, `толщина ${(r0 * 1000).toFixed(2)} → ${(r1 * 1000).toFixed(2)} мм`);
    let bright = 0; for (let i = 0; i < O.n; i++) if (O.C[i * 3] > 200) bright++;
    assert.strictEqual(bright, 0, 'блик не исправлен');
    assert.ok(O.minX > -0.01 && O.maxX < 6.01 && O.minZ > -0.01 && O.maxZ < 3.01, 'габариты в заголовке ' + [O.minX, O.maxX, O.minZ, O.maxZ]);
    // мелкие плитки (перекрытие 20 см) — то же число точек и та же толщина
    const st2 = R.refine(src, dst2, { tileMax: 20000 });
    assert.ok(st2.tiles > 4); const O2 = readLas(dst2);
    assert.ok(Math.abs(O2.n - O.n) <= 5, `${O2.n} против ${O.n}`);
    assert.ok(Math.abs(rms(O2.P, O2.n) - r1) < r1 * 0.2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('движущиеся воксели вырезаются', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refine-')), src = path.join(dir, 's.las'), dst = path.join(dir, 'o.las');
  try {
    const S = scene(); writeLas(src, S.P, S.C);
    // сетка вокселей 0,1 м от (0, 0, 0); «движущийся» — столбик x ∈ [1, 1.1), y ∈ [1.9, 2.0) и [2.0, 2.1), z ∈ [1, 1.1)
    const grid = { gx: 0, gy: 0, gz: 0, v: 0.1, nx: 100, ny: 100, nz: 100 };
    const keys = Float64Array.from([10 + 100 * (19 + 100 * 10), 10 + 100 * (20 + 100 * 10)]);
    const st = R.refine(src, dst, { dynamic: { keys, grid }, thin: false, color: false, noise: false });
    let expect = 0; for (let i = 0; i < 120000; i++) { const x = S.P[i * 3], y = S.P[i * 3 + 1], z = S.P[i * 3 + 2]; if (x >= 1 && x < 1.1 && y >= 1.9 && y < 2.1 && z >= 1 && z < 1.1) expect++; }
    assert.ok(expect > 50 && Math.abs(st.dynamic - expect) <= 2, `${st.dynamic} против ${expect}`);
    assert.strictEqual(st.written, 120001 - st.dynamic);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('чистовая обработка и движущиеся объекты попадают в сборку и распаковываются для worker_threads', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  for (const f of ['dynamic-clean-core.js', 'dynamic-clean-worker.js', 'scan-refine-core.js', 'scan-refine-worker.js']) {
    assert.ok(pkg.build.files.includes(f), 'files: ' + f); assert.ok(pkg.build.asarUnpack.includes(f), 'asarUnpack: ' + f);
  }
  assert.ok(pkg.build.asarUnpack.includes('renderer/dynamic-voxels.js'));
});
