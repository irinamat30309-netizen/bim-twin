'use strict';
// Классы точек по результатам контроля (ревизия 33): новый LAS рядом с облаком, у каждой точки — класс (байт классификации).
// Геометрические правила по найденному: элементы под потолком (балки, трубы, короба, лотки — по их сечениям), пол (сетка пола 10 см,
// местная отметка), стены (грани плана ±7 см), потолок (верх колонок в квадратах 0,5 м), ниже пола — шум, остальное до 2,5 м над
// полом — мебель и предметы, выше — прочее. Номера: стандартные ASPRS там, где они подходят (2 — земля/пол, 6 — здание/стены,
// 7 — шум), остальные — из резерва 24–29 (в форматах 0–5 доступны классы 0–31).
// Исходник не меняется; запись во временный файл и переименование. Если задана рамка — пишутся только точки в ней (вырезка).
const fs = require('fs');
const OV = require('./cloud-overview');

const CLASSES = {
  1: 'прочее', 2: 'пол', 6: 'стены', 7: 'шум (ниже пола)', 24: 'потолок', 25: 'балки', 26: 'трубы', 27: 'воздуховоды и короба', 28: 'кабельные лотки', 29: 'мебель и предметы'
};
const BY_KIND = { beam: 25, pipe: 26, duct: 27, tray: 28, rack: 26 };

function readExact(fd, buf, len, pos) { let got = 0; while (got < len) { const n = fs.readSync(fd, buf, got, len - got, pos + got); if (!n) break; got += n; } return got; }
function writeAll(fd, buf, len, pos) { let put = 0; while (put < len) { put += fs.writeSync(fd, buf, put, len - put, pos == null ? null : pos + put); } }

// модель классов: { floor: { u0, v0, cell, nx, ny, z, flag }, floorH, blockFloor(u, v), faces, ceiling: { phi, a0, b0, cell, nx, ny, h }, elements }
function makeClassifier(m, opts) {
  opts = opts || {};
  const floorH = +m.floorH, F = m.floor || null, wallTol = opts.wallTol || 0.07, objTop = opts.objTop || 2.5;
  // стены: растр 5 см вдоль граней плана
  const R = m.rect, wc = 0.05, wnx = Math.max(1, Math.ceil((R.u1 - R.u0) / wc)), wny = Math.max(1, Math.ceil((R.v1 - R.v0) / wc)), wall = new Uint8Array(wnx * wny);
  const rr = Math.ceil(wallTol / wc);
  (m.faces || []).forEach((f) => {
    const L = Math.hypot(f.b[0] - f.a[0], f.b[1] - f.a[1]), st = Math.max(1, Math.ceil(L / (wc * 0.5)));
    for (let q = 0; q <= st; q++) {
      const u = f.a[0] + (f.b[0] - f.a[0]) * q / st, v = f.a[1] + (f.b[1] - f.a[1]) * q / st, ci = Math.floor((u - R.u0) / wc), cj = Math.floor((v - R.v0) / wc);
      for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++) {
        const I = ci + di, J = cj + dj; if (I < 0 || J < 0 || I >= wnx || J >= wny) continue;
        const cu = R.u0 + (I + 0.5) * wc - u, cv = R.v0 + (J + 0.5) * wc - v; if (cu * cu + cv * cv <= wallTol * wallTol + wc * wc / 2) wall[J * wnx + I] = 1;
      }
    }
  });
  // элементы: поиск по клеткам 1 м
  const els = (m.elements || []).map((e) => ({ c: Math.cos(e.th), s: Math.sin(e.th), t0: e.t0 - 0.03, t1: e.t1 + 0.03, q0: e.q - e.width / 2 - 0.03, q1: e.q + e.width / 2 + 0.03, z0: e.bottom - 0.03, z1: e.top + 0.03, cls: BY_KIND[e.kind] || 1, e }));
  const cells = new Map();
  els.forEach((x, i) => {
    const e = x.e, hw = e.width / 2 + 0.05, nx = -Math.sin(e.th) * hw, ny = Math.cos(e.th) * hw;
    const xs = [e.a[0] + nx, e.a[0] - nx, e.b[0] + nx, e.b[0] - nx], ys = [e.a[1] + ny, e.a[1] - ny, e.b[1] + ny, e.b[1] - ny];
    for (let gx = Math.floor(Math.min(...xs)); gx <= Math.floor(Math.max(...xs)); gx++) for (let gy = Math.floor(Math.min(...ys)); gy <= Math.floor(Math.max(...ys)); gy++) {
      const k = gx + ',' + gy; let a = cells.get(k); if (!a) cells.set(k, a = []); a.push(i);
    }
  });
  const C = m.ceiling || null, cc = C ? Math.cos(C.phi) : 1, cs = C ? Math.sin(C.phi) : 0;
  const ceilAt = (u, v) => { if (!C) return NaN; const i = Math.floor((u * cc + v * cs - C.a0) / C.cell), j = Math.floor((-u * cs + v * cc - C.b0) / C.cell); return i < 0 || j < 0 || i >= C.nx || j >= C.ny ? NaN : C.h[j * C.nx + i]; };
  const floorAt = (u, v) => {
    if (F) { const i = Math.floor((u - F.u0) / F.cell), j = Math.floor((v - F.v0) / F.cell); if (i >= 0 && j >= 0 && i < F.nx && j < F.ny) { const k = j * F.nx + i; if (F.flag[k] === 1 && F.z[k] === F.z[k]) return F.z[k]; } }
    return m.blockFloor ? m.blockFloor(u, v) : NaN;
  };
  return function cls(u, v, h) {
    const a = cells.get(Math.floor(u) + ',' + Math.floor(v));
    if (a) for (let x = 0; x < a.length; x++) {
      const g = els[a[x]]; if (h < g.z0 || h > g.z1) continue; const t = u * g.c + v * g.s; if (t < g.t0 || t > g.t1) continue; const q = -u * g.s + v * g.c; if (q >= g.q0 && q <= g.q1) return g.cls;
    }
    const fz = floorAt(u, v), f = fz === fz ? fz : floorH, inFloor = fz === fz;
    if (inFloor && Math.abs(h - f) <= 0.03) return 2;
    if (inFloor && h < f - 0.08) return 7;
    const wi = Math.floor((u - R.u0) / wc), wj = Math.floor((v - R.v0) / wc);
    const ch = ceilAt(u, v);
    if (ch === ch && h >= ch - 0.07 && h <= ch + 0.3) return 24;
    if (wi >= 0 && wj >= 0 && wi < wnx && wj < wny && wall[wj * wnx + wi] && h > f + 0.03) return 6;
    if (inFloor && h > f && h <= f + objTop) return 29;
    return 1;
  };
}

// запись: копия заголовка и VLR, записи с новым классом; рамка (вырезка) — с пересчётом числа точек, по возвратам и границ
function writeClassified(desc, outPath, classify, opts) {
  opts = opts || {};
  if (desc.kind !== 'las') return { ok: false, message: 'классы точек — для LAS' };
  const t0 = Date.now(), D = OV.makeDecoder(desc), rl = D.recLen, total = desc.count, fmt = desc.fmt, kOff = fmt >= 6 ? 16 : 15, rOff = 14;
  const rect = opts.rect || null, inR = rect ? (u, v) => u >= rect.u0 && u <= rect.u1 && v >= rect.v0 && v <= rect.v1 : null;
  const fi = fs.openSync(desc.path, 'r'), tmp = outPath + '.part';
  let fo = null, written = 0, ok = false;
  const counts = {}, byRet = new Float64Array(15), mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  try {
    const head = Buffer.alloc(desc.offToPts); readExact(fi, head, desc.offToPts, 0);
    const verMinor = head.readUInt8(25);
    fo = fs.openSync(tmp, 'w'); writeAll(fo, head, head.length, 0);
    const perChunk = Math.max(1, Math.floor((8 << 20) / rl)), buf = Buffer.allocUnsafe(perChunk * rl), ob = Buffer.allocUnsafe(perChunk * rl), o = { u: 0, v: 0, h: 0 };
    let pos = desc.offToPts;
    for (let first = 0; first < total; first += perChunk) {
      if (opts.signal && opts.signal.aborted) return { ok: false, cancelled: true, message: 'отменено' };
      const cnt = Math.min(perChunk, total - first), got = Math.floor(readExact(fi, buf, cnt * rl, desc.offToPts + first * rl) / rl);
      let w = 0;
      for (let j = 0; j < got; j++) {
        const base = j * rl; D.dec(buf, base, o);
        if (inR && !inR(o.u, o.v)) continue;
        const c = classify(o.u, o.v, o.h), ob0 = w * rl;
        buf.copy(ob, ob0, base, base + rl);
        ob[ob0 + kOff] = fmt >= 6 ? c : (ob[ob0 + kOff] & 0xe0) | (c & 0x1f);
        counts[c] = (counts[c] || 0) + 1;
        if (rect) {
          const rn = fmt >= 6 ? ob[ob0 + rOff] & 0x0f : ob[ob0 + rOff] & 0x07; if (rn >= 1 && rn <= 15) byRet[rn - 1]++;
          const X = ob.readInt32LE(ob0) * desc.scale[0] + desc.offset[0], Y = ob.readInt32LE(ob0 + 4) * desc.scale[1] + desc.offset[1], Z = ob.readInt32LE(ob0 + 8) * desc.scale[2] + desc.offset[2];
          if (X < mn[0]) mn[0] = X; if (X > mx[0]) mx[0] = X; if (Y < mn[1]) mn[1] = Y; if (Y > mx[1]) mx[1] = Y; if (Z < mn[2]) mn[2] = Z; if (Z > mx[2]) mx[2] = Z;
        }
        w++;
      }
      if (w) { writeAll(fo, ob, w * rl, pos); pos += w * rl; written += w; }
      if (opts.onProgress) opts.onProgress(Math.min(1, (first + cnt) / total));
    }
    // хвост (EVLR LAS 1.4) не копируется при вырезке; без вырезки — копия как есть
    const tailFrom = desc.offToPts + total * rl, size = fs.fstatSync(fi).size;
    if (!rect && size > tailFrom) { const tb = Buffer.alloc(Math.min(size - tailFrom, 64 << 20)); const n = readExact(fi, tb, tb.length, tailFrom); writeAll(fo, tb, n, pos); }
    if (rect) {
      const h = Buffer.alloc(8);
      h.writeUInt32LE(written > 0xffffffff ? 0 : written, 0); fs.writeSync(fo, h, 0, 4, 107);
      for (let r = 0; r < 5; r++) { h.writeUInt32LE(Math.min(0xffffffff, byRet[r]), 0); fs.writeSync(fo, h, 0, 4, 111 + r * 4); }
      if (written) { const bb = Buffer.alloc(48); bb.writeDoubleLE(mx[0], 0); bb.writeDoubleLE(mn[0], 8); bb.writeDoubleLE(mx[1], 16); bb.writeDoubleLE(mn[1], 24); bb.writeDoubleLE(mx[2], 32); bb.writeDoubleLE(mn[2], 40); fs.writeSync(fo, bb, 0, 48, 179); }
      if (verMinor >= 4 && head.length >= 375) {
        const b8 = Buffer.alloc(8); b8.writeBigUInt64LE(BigInt(written), 0); fs.writeSync(fo, b8, 0, 8, 247);
        for (let r = 0; r < 15; r++) { b8.writeBigUInt64LE(BigInt(byRet[r]), 0); fs.writeSync(fo, b8, 0, 8, 255 + r * 8); }
        // EVLR не копируются — их смещение и число обнуляются
        const z8 = Buffer.alloc(12); fs.writeSync(fo, z8, 0, 12, 235);
      }
    }
    fs.closeSync(fo); fo = null;
    fs.renameSync(tmp, outPath); ok = true;
    return { ok: true, path: outPath, points: total, written, counts, crop: !!rect, seconds: (Date.now() - t0) / 1000 };
  } catch (e) {
    return { ok: false, message: 'классы точек не записаны: ' + String((e && e.message) || e) };
  } finally {
    try { fs.closeSync(fi); } catch (_) {}
    if (fo != null) try { fs.closeSync(fo); } catch (_) {}
    if (!ok) try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

module.exports = { CLASSES, BY_KIND, makeClassifier, writeClassified };
