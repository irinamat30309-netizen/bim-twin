'use strict';
/*
 * xbin-project.js — открытие сырого файла сканера XGRIDS Lixel (*.xbin) как проекта, ревизия 23.
 *
 * Папка проекта Lixel (как её пишет сканер): <имя>.xbin — сырые данные (лидар, IMU, кадры камер, калибровки), map.las — облако
 * реального времени, project_data/poses.csv — траектория. Lixel Studio кладёт рядом свой экспорт (*.las, «Xgrids LixelStudio»).
 * inspect(xbin) читает только начало .xbin (подпись XBAG, калибровки) и заголовки облаков, поэтому работает мгновенно на файлах
 * любого размера, и выбирает облако для показа: экспорт Lixel Studio → map.las → прочие LAS → LAZ/E57/PLY/PCD.
 * Облако из сырых пакетов лидара здесь не строится — нужен пересчёт SLAM, его делает Lixel Studio.
 */
const fs = require('node:fs');
const path = require('node:path');
const XB = require('./xbin-core');

const CLOUD_RANK = { '.las': 0, '.laz': 1, '.e57': 2, '.ply': 3, '.pcd': 4 };
const POSES_RE = /^(poses|trajectory|traj)\.(csv|txt)$/i;

function readHead(file, len) {
  const fd = fs.openSync(file, 'r');
  try { return XB.readAt(fd, 0, len); } finally { fs.closeSync(fd); }
}
function cstr(b, a, n) { return b.toString('latin1', a, a + n).replace(/\0[\s\S]*$/, '').trim(); }

// Заголовок LAS: программа, число точек, есть ли время точек (форматы 1, 3, 4, 5, 6–10)
function lasInfo(file) {
  try {
    const b = readHead(file, 375);
    if (b.length < 227 || b.toString('latin1', 0, 4) !== 'LASF') return null;
    const minor = b[25], fmt = b[104] & 0x3f;
    let n = b.readUInt32LE(107);
    if (!n && minor >= 4 && b.length >= 255) n = Number(b.readBigUInt64LE(247));
    return { software: cstr(b, 58, 32), system: cstr(b, 26, 32), version: '1.' + minor, format: fmt, points: n, hasTime: fmt === 1 || fmt >= 3, hasColor: fmt === 2 || fmt === 3 || fmt === 5 || fmt >= 7 };
  } catch (_) { return null; }
}

function scanFolder(root, maxDepth) {
  const clouds = [], poses = []; let seen = 0;
  const walk = (dir, depth) => {
    if (depth > maxDepth || seen > 20000) return;
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (++seen > 20000) return;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/^(\.|node_modules$|\$recycle)/i.test(e.name)) walk(f, depth + 1); continue; }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (ext in CLOUD_RANK) {
        let size = 0; try { size = fs.statSync(f).size; } catch (_) { continue; }
        clouds.push({ path: f, name: e.name, ext, size, depth, backup: /-original(-\d+)?\.las$/i.test(e.name) });
      } else if (POSES_RE.test(e.name)) poses.push({ path: f, name: e.name, depth, lixel: /project_data$/i.test(dir) });
    }
  };
  walk(root, 0);
  return { clouds, poses };
}

function cloudKind(c) {
  if (c.ext !== '.las') return 'other';
  if (c.las && /lixel\s*studio/i.test(c.las.software)) return 'studio';
  if (/^map\.las$/i.test(c.name)) return 'realtime';
  return 'other';
}
const KIND_RANK = { studio: 0, realtime: 1, other: 2 };

// Траектория: число поз, длительность (с), длина пути (м)
function posesSummary(file) {
  try {
    const st = fs.statSync(file); if (st.size > (64 << 20)) return { n: 0, duration: 0, length: 0 };
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let n = 0, t0 = NaN, t1 = NaN, len = 0, px = NaN, py = NaN, pz = NaN;
    for (const ln of lines) {
      const v = ln.split(/[,;\s]+/).filter(Boolean).map(Number);
      if (v.length < 4 || !v.slice(0, 4).every(Number.isFinite)) continue;
      if (!n) t0 = v[0]; t1 = v[0]; n++;
      if (Number.isFinite(px)) { const d = Math.hypot(v[1] - px, v[2] - py, v[3] - pz); if (d < 50) len += d; }
      px = v[1]; py = v[2]; pz = v[3];
    }
    return { n, duration: n > 1 ? t1 - t0 : 0, length: len };
  } catch (_) { return { n: 0, duration: 0, length: 0 }; }
}

/**
 * inspect(xbinPath) → { xbin: {path, size, model, lidar, cams, camRes}, cloud|null, others: [...], poses|null }
 * Бросает ошибку, если файл не .xbin (нет подписи XBAG).
 */
function inspect(xbinPath, opts) {
  opts = opts || {};
  const abs = path.resolve(xbinPath);
  const size = fs.statSync(abs).size;
  const head = readHead(abs, Math.min(size, 4 << 20));
  if (head.toString('latin1', 0, 4) !== 'XBAG') throw new Error('это не файл сканера XGRIDS (*.xbin): нет подписи XBAG');
  const calib = XB.parseCalib(head) || { cams: [] };
  const text = head.toString('latin1');
  const lidar = (/lidar_type:\s*"?([A-Za-z0-9_]+)/.exec(text) || [])[1] || null;
  const cams = calib.cams || [];
  const xbin = { path: abs, name: path.basename(abs), size, model: calib.model || null, lidar: lidar ? lidar.replace(/_lidar$/i, '').replace(/^hesai$/i, 'Hesai').replace(/^livox.*/i, 'Livox') : null,
    cams: cams.length, camRes: cams.length ? cams[0].w + '×' + cams[0].h : null, photoReady: !!(cams.length && calib.camMotor && calib.imuMotor),
    lidarReady: !!(calib.motorLidar && calib.imuMotor) };   // ревизия 24: облако из сырого лидара (xbin-lidar.js)
  const root = path.dirname(abs);
  const { clouds, poses } = scanFolder(root, opts.depth == null ? 3 : opts.depth);
  for (const c of clouds) { c.las = c.ext === '.las' ? lasInfo(c.path) : null; c.kind = cloudKind(c); }
  const usable = clouds.filter(c => !c.backup && !/(^|[\\/])\.bimtwin-refine-/.test(c.path) && (c.ext !== '.las' || c.las));
  usable.sort((a, b) => (KIND_RANK[a.kind] - KIND_RANK[b.kind]) || (CLOUD_RANK[a.ext] - CLOUD_RANK[b.ext]) || (a.depth - b.depth) || (b.size - a.size));
  const pub = (c) => c && { path: c.path, name: c.name, size: c.size, kind: c.kind, points: c.las ? c.las.points : null, hasTime: c.las ? c.las.hasTime : null, hasColor: c.las ? c.las.hasColor : null, software: c.las ? c.las.software : null };
  poses.sort((a, b) => (b.lixel - a.lixel) || (a.depth - b.depth) || (/^poses/i.test(b.name) - /^poses/i.test(a.name)));
  const p = poses[0] || null;
  return { xbin, cloud: pub(usable[0]) || null, others: usable.slice(1, 6).map(pub), poses: p ? Object.assign({ path: p.path, name: path.relative(root, p.path) }, posesSummary(p.path)) : null };
}

module.exports = { inspect, lasInfo, posesSummary, scanFolder };
