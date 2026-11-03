'use strict';
/*
 * xbin-core.js — чтение сырого файла сканера XGRIDS Lixel (*.xbin, контейнер «XBAG»), ревизия 22.
 *
 * Зачем: Lixel Studio строит итоговое облако не из map.las (realtime-карта), а из .xbin — там кадры двух камер «рыбий глаз»
 * 4000×3000 (H.264, каждый кадр ключевой, ~2,5 кадра/с на камеру), сырые данные лидара, IMU и калибровки. Чёткий цвет у Lixel —
 * это перекраска точек по этим кадрам. Здесь: калибровки камер (camera.yaml, extrinsic_*.yaml) и оглавление кадров
 * (время, смещение и длина кадра H.264 в файле) — без чтения самих кадров, поэтому оглавление 20–25 ГБ файла строится за секунды.
 *
 * Формат записи (little-endian), заголовок 52 байта:
 *   u32 crc, u32 L (длина всей записи), u16 type (=1), u16 hdrLen (=36), u64 t (мкс), u32 payloadLen, u32 count,
 *   u64 t0, u64 t1, u32 channel, u32 payloadLen; дальше payload: повторяющееся поле 1 (protobuf) — сообщения.
 * Сообщение кадра: 1 {2: время (zigzag, мкс), 3: …}, 2: формат, 3: ширина, 4: высота, 5: байты H.264 (Annex B).
 */
const fs = require('node:fs');

const HDR = 52;

function varint(b, p) {   // → [значение, новая позиция]; значения до 2^53 точно
  let r = 0, s = 1, c;
  do { if (p >= b.length) return [NaN, p]; c = b[p++]; r += (c & 0x7f) * s; s *= 128; } while (c & 0x80);
  return [r, p];
}

function readAt(fd, pos, len) {
  const b = Buffer.allocUnsafe(len); let got = 0;
  while (got < len) { const r = fs.readSync(fd, b, got, len - got, pos + got); if (!r) break; got += r; }
  return got === len ? b : b.subarray(0, got);
}

function recordAt(b, p) {
  if (p + HDR > b.length) return null;
  const L = b.readUInt32LE(p + 4), typ = b.readUInt16LE(p + 8), hl = b.readUInt16LE(p + 10), pl = b.readUInt32LE(p + 20), pl2 = b.readUInt32LE(p + 48);
  if (typ !== 1 || hl !== 36 || pl !== pl2 || L !== pl + HDR) return null;
  return { L, t: Number(b.readBigUInt64LE(p + 12)), count: b.readUInt32LE(p + 24), t0: Number(b.readBigUInt64LE(p + 28)), t1: Number(b.readBigUInt64LE(p + 36)), ch: b.readUInt32LE(p + 44) };
}

// первая запись: ищем в начале файла позицию, где подряд идут две корректные записи
function findFirstRecord(head) {
  for (let p = 8; p + HDR <= head.length; p++) {
    const r = recordAt(head, p); if (!r) continue;
    const q = p + r.L;
    if (q + HDR > head.length) return p;
    if (recordAt(head, q)) return p;
  }
  return -1;
}

// ---- калибровки из текстовых YAML в начале файла ----
function numList(txt, key) {   // «key:\n  - 1\n  - 2» или «key: [1, 2]»
  const re = new RegExp('(?:^|[^A-Za-z0-9_])' + key + ':[ \\t]*(\\[[^\\]]*\\]|(?:\\s*-\\s*[-+0-9.eE]+)+|[-+0-9.eE]+)');
  const m = re.exec(txt); if (!m) return null;
  const v = (m[1].match(/[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/g) || []).map(Number);
  return v.length ? v : null;
}
function yamlBlock(text, name) {
  const i = text.indexOf(name); if (i < 0) return null;
  let j = text.indexOf('version:', i); j = j < 0 ? Math.min(text.length, i + 4000) : text.indexOf('\n', j);
  return text.slice(i + name.length, j < 0 ? undefined : j);
}
function parseCalib(head) {
  const text = head.toString('latin1');
  const cam = yamlBlock(text, 'camera.yaml'); if (!cam) return null;
  const cams = [];
  const names = ['camera_0:', 'camera_1:', 'camera_2:'];
  for (let ci = 0; ci < 2; ci++) {
    const nm = names[ci], i = cam.indexOf(nm); if (i < 0) continue;
    const nx = cam.indexOf(names[ci + 1], i + nm.length); const blk = cam.slice(i, nx < 0 ? undefined : nx);
    const pose = numList(blk, 'camera_pose'), K = numList(blk, 'intrinsic'), D = numList(blk, 'distortion');
    const w = numList(blk, 'image_width'), h = numList(blk, 'image_height'), model = (/camera_model:\s*(\w+)/.exec(blk) || [])[1] || 'kb4';
    if (!K || K.length < 4) continue;
    cams.push({ name: nm.slice(0, -1), pose: pose && pose.length === 16 ? pose : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], fx: K[0], fy: K[1], cx: K[2], cy: K[3], d: (D || [0, 0, 0, 0]).slice(0, 4), w: w ? w[0] : 4000, h: h ? h[0] : 3000, model });
  }
  const m16 = (blk) => { const v = blk && numList(blk, 'transform'); return v && v.length === 16 ? v : null; };
  const camMotor = m16(yamlBlock(text, 'extrinsic_camera_motor.yaml')), imuMotor = m16(yamlBlock(text, 'extrinsic_imu_motor.yaml'));
  const motorLidar = m16(yamlBlock(text, 'extrinsic_motor_lidar.yaml'));
  const model = (/Lixel [A-Za-z0-9 ]+/.exec(text.slice(0, 600)) || [])[0] || null;
  return { cams, camMotor, imuMotor, motorLidar, model };
}

// ---- сообщение кадра ----
function parseImageMsg(b, p, end) {   // b — буфер, [p, end) — тело сообщения; → { ts, w, h, fmt, dOff, dLen } (dOff — от начала b)
  let ts = null, w = 0, h = 0, fmt = 0, dOff = -1, dLen = 0;
  while (p < end) {
    let tag; [tag, p] = varint(b, p); if (!Number.isFinite(tag)) return null;
    const f = Math.floor(tag / 8), wt = tag & 7;
    if (wt === 0) { let v; [v, p] = varint(b, p); if (f === 2) fmt = v; else if (f === 3) w = v; else if (f === 4) h = v; }
    else if (wt === 2) {
      let l; [l, p] = varint(b, p); if (!Number.isFinite(l)) return null;
      if (f === 1) {   // заголовок: поле 2 — время, zigzag, мкс
        let q = p; const e = Math.min(end, p + l);
        while (q < e) { let t2; [t2, q] = varint(b, q); if ((t2 & 7) === 0) { let v; [v, q] = varint(b, q); if (Math.floor(t2 / 8) === 2) ts = v / 2; } else if ((t2 & 7) === 2) { let l2; [l2, q] = varint(b, q); q += l2; } else break; }
      } else if (f === 5) { dOff = p; dLen = l; }
      p += l;
    } else if (wt === 1) p += 8; else if (wt === 5) p += 4; else return null;
  }
  return { ts, w, h, fmt, dOff, dLen };
}

/**
 * Оглавление: open(path) → { path, size, calib, first, channels: { [ch]: {records, bytes, t0, t1} }, frames: { [ch]: [{t, off, len}] } }
 * Кадры — каналы, где сообщения содержат H.264 (00 00 00 01) с размером кадра; время t — секунды (GPS/UNIX, как в LAS и poses.csv).
 */
function open(file, onProgress) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = readAt(fd, 0, Math.min(size, 4 << 20));
    if (head.toString('latin1', 0, 4) !== 'XBAG') throw new Error('это не файл сканера XGRIDS (*.xbin): нет подписи XBAG');
    const calib = parseCalib(head);
    const first = findFirstRecord(head);
    if (first < 0) throw new Error('в файле .xbin не найдены записи данных');
    const channels = {}, frames = {}; const imageCh = new Map();   // ch → true/false (решается по первой записи)
    let p = first, lastProg = 0, recs = 0;
    const hb = Buffer.allocUnsafe(HDR);
    while (p + HDR <= size) {
      if (fs.readSync(fd, hb, 0, HDR, p) !== HDR) break;
      const r = recordAt(hb, 0); if (!r) break;
      const c = channels[r.ch] || (channels[r.ch] = { records: 0, bytes: 0, t0: r.t0, t1: r.t1 });
      c.records++; c.bytes += r.L; c.t1 = r.t1; recs++;
      let isImg = imageCh.get(r.ch);
      if (isImg !== false) {
        // сообщения: читаем только начало каждого (до 96 байт), сами кадры пропускаем
        let q = p + HDR; const end = p + r.L; const list = []; let ok = true;
        for (let k = 0; k < r.count && q < end; k++) {
          const mh = readAt(fd, q, Math.min(96, end - q));
          let tag, l, o = 0; [tag, o] = varint(mh, o); [l, o] = varint(mh, o);
          if (tag !== 10 || !Number.isFinite(l)) { ok = false; break; }
          const body = q + o;
          if (isImg === undefined || list.length === 0) {
            const peek = readAt(fd, body, Math.min(l, 128)); const m = parseImageMsg(peek, 0, peek.length);
            if (!m || m.dOff < 0 || !(m.w > 0 && m.h > 0) || m.ts == null || peek.readUInt32BE(m.dOff) !== 1) { ok = false; break; }
            list.push({ t: m.ts / 1e6, off: body + m.dOff, len: m.dLen, w: m.w, h: m.h });
          } else {
            const peek = readAt(fd, body, Math.min(l, 128)); const m = parseImageMsg(peek, 0, peek.length);
            if (!m || m.dOff < 0 || m.ts == null) { ok = false; break; }
            list.push({ t: m.ts / 1e6, off: body + m.dOff, len: m.dLen, w: m.w, h: m.h });
          }
          q = body + l;
        }
        if (isImg === undefined) { isImg = ok && list.length > 0; imageCh.set(r.ch, isImg); }
        if (isImg && ok) { const F = frames[r.ch] || (frames[r.ch] = []); for (const f of list) F.push(f); }
      }
      p += r.L;
      if (onProgress && p - lastProg > (256 << 20)) { lastProg = p; onProgress(p / size); }
    }
    for (const k of Object.keys(frames)) frames[k].sort((a, b) => a.t - b.t);
    return { path: file, size, calib, first, records: recs, channels, frames };
  } finally { fs.closeSync(fd); }
}

function readFrame(fd, f) { return readAt(fd, f.off, f.len); }

// Поиск .xbin рядом с облаком: папка файла, её родители (до 3 уровней) и вложенные папки проектов
function findNear(lasAbs) {
  const path = require('node:path');
  const out = [];
  const scan = (dir) => { try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isFile() && /\.xbin$/i.test(e.name)) { const f = path.join(dir, e.name); try { out.push({ f, s: fs.statSync(f).size }); } catch (_) {} } } catch (_) {} };
  let d = path.dirname(lasAbs);
  for (let up = 0; up < 3 && d; up++) { scan(d); if (out.length) break; const nd = path.dirname(d); if (nd === d) break; d = nd; }
  if (!out.length) { try { const base = path.dirname(lasAbs); for (const e of fs.readdirSync(base, { withFileTypes: true })) if (e.isDirectory()) scan(path.join(base, e.name)); } catch (_) {} }
  out.sort((a, b) => b.s - a.s);
  return out.length ? out[0].f : null;
}

module.exports = { open, readFrame, readAt, parseCalib, parseImageMsg, findFirstRecord, recordAt, varint, findNear, HDR };
