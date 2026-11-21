'use strict';
// r183: плотные облака — глобальный адаптивный денойз цвета (2-фазный), защита краёв, 16-бит RGB.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('r183: postParallel делает ГЛОБАЛЬНЫЙ денойз (2 фазы), а не кусочный', () => {
  const src = read('recolor-post.js');
  assert.match(src, /async function postParallel\(cfg\)/);
  assert.match(src, /await postParallelFill\(Object\.assign\(\{\}, cfg, \{[\s\S]{0,200}?denoise: false/);
  assert.match(src, /await denoiseGlobal\(\{/);
  assert.match(src, /module\.exports = \{[^}]*denoiseGlobal/);
  // сетка выровнена с метрикой finish-geometry: оси Y-Z, origin кратен ячейке
  assert.match(src, /const A1 = 1, A2 = 2;/);
  assert.match(src, /Math\.floor\(lo\[A1\] \/ cell\) \* cell/);
});

test('r183: адаптивные параметры денойза зависят от локальной плотности, края защищены', () => {
  const src = read('recolor-post.js');
  assert.match(src, /denoiseEdgePoint \|\| 100/, 'выбросы в краевых ячейках не трогаем (guard)');
  assert.match(src, /denoiseNoisyHi \|\| 26/, 'порог для плотных ячеек (12+)');
  assert.match(src, /denoiseNoisyMid \|\| 18/, 'порог 6-11 точек');
  assert.match(src, /denoiseNoisyLo \|\| 12/, 'порог 3-5 точек');
  assert.match(src, /detectC16/, '16-битный RGB обрабатывается отдельно');
  assert.match(src, /getC = \(b, q, off, c16\)/, 'чтение каналов с учётом 16 бит');
});

test('r183: в приложении денойз поста не отключается флагом tileOpt.denoise=false', () => {
  const main = read('main.js');
  assert.match(main, /const userDenoise = opt\.denoise !== false/);
  assert.match(main, /opt: Object\.assign\(\{\}, tileOpt, \{ denoise: userDenoise \}\)/);
});

// ---------- функциональный тест: шум на плотной поверхности убирается, граница двух цветов сохраняется ----------
function writeLas(file, n, pos, rgb) {
  const rl = 34, hs = 227;
  const b = Buffer.alloc(hs + n * rl);
  b.write('LASF', 0, 'latin1'); b[24] = 1; b[25] = 2;
  b.writeUInt16LE(hs, 94); b.writeUInt32LE(hs, 96); b[104] = 3; b.writeUInt16LE(rl, 105); b.writeUInt32LE(n, 107);
  b.writeDoubleLE(0.001, 131); b.writeDoubleLE(0.001, 139); b.writeDoubleLE(0.001, 147);
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = hs + i * rl;
    b.writeInt32LE(Math.round(pos[i * 3] * 1000), p);
    b.writeInt32LE(Math.round(pos[i * 3 + 1] * 1000), p + 4);
    b.writeInt32LE(Math.round(pos[i * 3 + 2] * 1000), p + 8);
    b.writeDoubleLE(i * 0.01, p + 20);
    b.writeUInt16LE(rgb[i * 3], p + 28); b.writeUInt16LE(rgb[i * 3 + 1], p + 30); b.writeUInt16LE(rgb[i * 3 + 2], p + 32);
    mnx = Math.min(mnx, pos[i * 3]); mny = Math.min(mny, pos[i * 3 + 1]); mnz = Math.min(mnz, pos[i * 3 + 2]);
    mxx = Math.max(mxx, pos[i * 3]); mxy = Math.max(mxy, pos[i * 3 + 1]); mxz = Math.max(mxz, pos[i * 3 + 2]);
  }
  b.writeDoubleLE(mxx, 179); b.writeDoubleLE(mnx, 187); b.writeDoubleLE(mxy, 195); b.writeDoubleLE(mny, 203); b.writeDoubleLE(mxz, 211); b.writeDoubleLE(mnz, 219);
  fs.writeFileSync(file, b);
}
function readRgb(file) {
  const b = fs.readFileSync(file);
  const n = b.readUInt32LE(107), off = b.readUInt32LE(96), rl = b.readUInt16LE(105);
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { const p = off + i * rl; out[i * 3] = b[p + 28]; out[i * 3 + 1] = b[p + 30]; out[i * 3 + 2] = b[p + 32]; }
  return { rgb: out, n };
}

test('r183: шум на плотной кирпичной поверхности убран, граница кирпич/раствор не размыта', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r183-'));
  try {
    // 60000 точек: 2000 ячеек 3×3 см по (Y,Z) по 30 точек; левая половина «кирпич» (160,60,40),
    // правая «раствор» (170,170,165); шум ±28 на канал
    const n = 60000, pos = new Float64Array(n * 3), col = new Uint8Array(n * 3), gray = new Uint8Array(n * 3);
    let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < n; i++) {
      const cellI = Math.floor(i / 30), k = i % 30;
      const cy = cellI % 50, cz = Math.floor(cellI / 50) % 40;        // 50×40 ячеек по 3 см
      const wall = cy >= 25 ? 1 : 0;
      pos[i * 3] = 10;
      pos[i * 3 + 1] = cy * 0.03 + rnd() * 0.02;
      pos[i * 3 + 2] = cz * 0.03 + rnd() * 0.02;
      const base = wall ? [170, 170, 165] : [160, 60, 40];
      for (let c = 0; c < 3; c++) { const v = base[c] + Math.round((rnd() - 0.5) * 56); col[i * 3 + c] = Math.max(0, Math.min(255, v)); gray[i * 3 + c] = 40; }
    }
    const g = path.join(dir, 'gray.las'), c = path.join(dir, 'color.las'), o = path.join(dir, 'out.las');
    writeLas(g, n, pos, gray); writeLas(c, n, pos, col);
    const before = readRgb(c);
    const P = require(path.join(ROOT, 'recolor-post.js'));
    await P.postColor(g, c, o, { denoiseCell: 0.02, fillCell: 0.3, fillRadius: 0.05 }, () => {});
    {
      const after = readRgb(o);
      const stat = (rgb) => {
        // 2-см ячейки по Y (ось 1), z=0; std по каналам
        const m = new Map();
        for (let i = 0; i < n; i++) {
          const k = Math.floor(pos[i * 3 + 1] / 0.02) + Math.floor(pos[i * 3 + 2] / 0.02) * 10000;
          let a = m.get(k); if (!a) { a = [0, 0, 0, 0, 0, 0, 0]; m.set(k, a); }
          a[0] += rgb[i * 3]; a[1] += rgb[i * 3 + 1]; a[2] += rgb[i * 3 + 2]; a[3]++; a[4] += rgb[i * 3] ** 2; a[5] += rgb[i * 3 + 1] ** 2; a[6] += rgb[i * 3 + 2] ** 2;
        }
        let s = 0, m1 = 0, m2 = 0;
        for (const a of m.values()) {
          if (a[3] < 10) continue;
          const v = Math.sqrt(a[4] / a[3] - (a[0] / a[3]) ** 2) + Math.sqrt(a[5] / a[3] - (a[1] / a[3]) ** 2) + Math.sqrt(a[6] / a[3] - (a[2] / a[3]) ** 2);
          s += v / 3;
          const y = 0; m1 += 1;
        }
        return m1 ? s / m1 : 0;
      };
      const sb = stat(before.rgb), sa = stat(after.rgb);
      assert.ok(sa < sb * 0.45, 'цветовое зерно убрано: std ' + sb.toFixed(1) + ' -> ' + sa.toFixed(1));
      // граница: средний цвет левой (кирпич) и правой (раствор) половины до/после (по Y≥0.75 м)
      const half = (rgb) => {
        const l = [0, 0, 0], r = [0, 0, 0]; let nl = 0, nr = 0;
        for (let i = 0; i < n; i++) {
          const right = pos[i * 3 + 1] >= 0.75;
          const t = right ? r : l; if (right) nr++; else nl++;
          for (let c = 0; c < 3; c++) t[c] += rgb[i * 3 + c];
        }
        return [l.map(v => v / nl), r.map(v => v / nr)];
      };
      const hb = half(before.rgb), ha = half(after.rgb);
      const contrast = (h) => Math.abs(h[0][0] - h[1][0]) + Math.abs(h[0][1] - h[1][1]) + Math.abs(h[0][2] - h[1][2]);
      assert.ok(contrast(ha) > contrast(hb) * 0.7, 'перепад кирпич/раствор сохранён: ' + contrast(hb).toFixed(1) + ' -> ' + contrast(ha).toFixed(1));
    }
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
});
