'use strict';
// Ревизия 22: синтетическая съёмка для «цвета по фото»: стена с узором (x = 5 м), пол с узором (z = −1 м) и красный ящик
// перед стеной; камера «рыбий глаз» (KB4 без дисторсии, 400×300) смотрит вдоль +x и идёт вдоль y; кадры рендерятся лучами.
// Внизу каждого кадра — «оператор» (пурпурное пятно, которого нет в облаке). Облако: точки поверхностей с тусклым,
// размытым исходным цветом (как realtime-карта), время точки — когда сканер был рядом.
const W = 400, H = 300, F = 150;
const BOX = { mn: [2.3, -0.25, -0.6], mx: [2.7, 0.25, -0.2] };
function wallColor(y, z) { const k = (Math.floor(y * 4 + 100) + Math.floor(z * 4 + 100)) & 1; return k ? [200, 60, 40] : [40, 90, 200]; }   // клетка 25 см
function floorColor(x, y) { const k = (Math.floor(x * 2 + 100) + Math.floor(y * 2 + 100)) & 1; return k ? [210, 210, 200] : [60, 60, 60]; }
const BOXC = [230, 20, 20], OPC = [250, 0, 250];
function trueColor(x, y, z) {
  if (x > BOX.mn[0] - 1e-6 && x < BOX.mx[0] + 1e-6 && y > BOX.mn[1] - 1e-6 && y < BOX.mx[1] + 1e-6 && z > BOX.mn[2] - 1e-6 && z < BOX.mx[2] + 1e-6) return BOXC;
  if (Math.abs(x - 5) < 1e-6) return wallColor(y, z);
  return floorColor(x, y);
}
function camY(t) { return -1 + 0.5 * t; }   // 0…4 с: y −1 → 1
// поза IMU: положение (0, camY, 0), ориентация единичная; камера: z камеры = +x мира, x камеры = −y, y камеры = −z
const R_IMU_CAM = [0, 0, 1, -1, 0, 0, 0, -1, 0];
function calib() {
  const T = [0, 0, 1, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 1];   // imuMotor = T_imu_cam, camMotor = I → T_imu_cam0 = imuMotor · inv(I)
  return { cams: [{ name: 'camera_0', pose: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], fx: F, fy: F, cx: W / 2, cy: H / 2, d: [0, 0, 0, 0], w: W, h: H, model: 'kb4' }],
    camMotor: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], imuMotor: T, motorLidar: null, model: 'test' };
}
function posesText() { let s = ''; for (let k = 0; k <= 40; k++) { const t = k * 0.1; s += [t.toFixed(3), 0, camY(t).toFixed(4), 0, 0, 0, 0, 1].join(',') + '\n'; } return s; }
function hitScene(o, d) {   // ближайшее пересечение луча: ящик, стена x=5, пол z=−1
  let best = Infinity, col = null;
  { let t0 = -Infinity, t1 = Infinity, ok = true;
    for (let a = 0; a < 3; a++) { if (Math.abs(d[a]) < 1e-12) { if (o[a] < BOX.mn[a] || o[a] > BOX.mx[a]) ok = false; continue; }
      let u = (BOX.mn[a] - o[a]) / d[a], v = (BOX.mx[a] - o[a]) / d[a]; if (u > v) { const q = u; u = v; v = q; } if (u > t0) t0 = u; if (v < t1) t1 = v; }
    if (ok && t1 >= t0 && t0 > 0) { best = t0; col = BOXC; } }
  if (d[0] > 1e-9) { const t = (5 - o[0]) / d[0]; if (t > 0 && t < best) { best = t; col = wallColor(o[1] + t * d[1], o[2] + t * d[2]); } }
  if (d[2] < -1e-9) { const t = (-1 - o[2]) / d[2]; if (t > 0 && t < best) { const x = o[0] + t * d[0]; if (x < 5) { best = t; col = floorColor(x, o[1] + t * d[1]); } } }
  return col || [120, 160, 230];
}
// кадр в момент t → I420 (полный диапазон) + «оператор» внизу кадра
function render(t) {
  const Y = new Uint8Array(W * H), U = new Uint8Array(W * H / 4), V = new Uint8Array(W * H / 4), rgb = new Float32Array(W * H * 3);
  const o = [0, camY(t), 0];
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    const px = u + 0.5 - W / 2, py = v + 0.5 - H / 2, r = Math.hypot(px, py), th = r / F; let c;
    if ((u - W / 2) * (u - W / 2) / (70 * 70) + (v - H) * (v - H) / (60 * 60) < 1) c = OPC;
    else {
      const s = r > 0 ? Math.sin(th) / r : 0, dc = [px * s, py * s, Math.cos(th)];
      const M = R_IMU_CAM, d = [M[0] * dc[0] + M[1] * dc[1] + M[2] * dc[2], M[3] * dc[0] + M[4] * dc[1] + M[5] * dc[2], M[6] * dc[0] + M[7] * dc[1] + M[8] * dc[2]];
      c = th > 1.5 ? [0, 0, 0] : hitScene(o, d);
    }
    const i = v * W + u; rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2];
    Y[i] = Math.round(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);
  }
  for (let v = 0; v < H / 2; v++) for (let u = 0; u < W / 2; u++) {
    let r = 0, g = 0, b = 0; for (const [a, bb] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const i = ((2 * v + bb) * W + 2 * u + a) * 3; r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2]; }
    r /= 4; g /= 4; b /= 4; const y = 0.299 * r + 0.587 * g + 0.114 * b;
    U[v * W / 2 + u] = Math.max(0, Math.min(255, Math.round((b - y) / 1.772 + 128))); V[v * W / 2 + u] = Math.max(0, Math.min(255, Math.round((r - y) / 1.402 + 128)));
  }
  return { w: W, h: H, Y, U, V, sY: W, sU: W / 2, uvStep: 1, fullRange: true };
}
// облако: точки стены, пола и ящика (шаг ~3 см), время — когда камера ближе всего по y (±0,6 с), исходный цвет — серый тусклый
function cloud(seed) {
  let s = seed || 11; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const pts = [], rgb = [], kind = [];
  const add = (x, y, z, k) => { const tc = Math.min(4, Math.max(0, (y + 1) / 0.5 + (rnd() - 0.5) * 1.2)); pts.push(x, y, z, tc); const c = trueColor(x, y, z), g = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    for (let a = 0; a < 3; a++) rgb.push(Math.round(0.5 * g + 0.2 * c[a] + 20 + (rnd() - 0.5) * 30)); kind.push(k); };
  for (let y = -1.6; y <= 1.6; y += 0.03) for (let z = -1; z <= 0.8; z += 0.03) add(5, y + (rnd() - 0.5) * 0.01, z + (rnd() - 0.5) * 0.01, 0);
  for (let x = 1.2; x < 5; x += 0.03) for (let y = -1.6; y <= 1.6; y += 0.03) add(x + (rnd() - 0.5) * 0.01, y + (rnd() - 0.5) * 0.01, -1, 1);
  for (let y = BOX.mn[1]; y <= BOX.mx[1] + 1e-9; y += 0.02) for (let z = BOX.mn[2]; z <= BOX.mx[2] + 1e-9; z += 0.02) add(BOX.mn[0], y, z, 2);   // передняя грань ящика
  return { pts, rgb, kind, n: kind.length };
}
function frames(fps) { const out = []; for (let k = 0; k * (1 / fps) <= 4 + 1e-9; k++) out.push({ t: k / fps, off: k, len: 1, w: W, h: H }); return out; }
module.exports = { W, H, F, BOX, BOXC, OPC, trueColor, wallColor, floorColor, calib, posesText, render, cloud, frames, camY };
