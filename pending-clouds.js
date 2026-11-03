'use strict';
// pending-clouds.js — хранилище крупных облаков, ожидающих передачи в окно кусками (ревизия 6).
// Облако больше IPC_INLINE_POINTS не отправляется одним IPC-сообщением (на 50 млн точек это ≈1,4 ГБ): main оставляет массивы у себя,
// отдаёт окну описание (`chunked`), а окно забирает куски через bim:readCloudChunk и освобождает запись через bim:releaseCloud.
// Запись привязана к окну (sender.id); если окно закрылось или забыло освободить — удаляется по таймеру.
const crypto = require('crypto');

const PENDING_CLOUD_FIELDS = ['pos', 'col', 'intensity', 'classification'];
const PENDING_CLOUD_TTL_MS = 10 * 60 * 1000;
function createPendingCloudStore(opts) {
  opts = opts || {};
  const ttl = opts.ttlMs || PENDING_CLOUD_TTL_MS;
  const items = new Map();
  const drop = (token) => {
    const it = items.get(token);
    if (!it) return false;
    try { clearTimeout(it.timer); } catch (_) {}
    items.delete(token);
    return true;
  };
  return {
    // Забирает массивы из result в хранилище и возвращает облегчённый ответ с описанием кусков
    stash(senderId, result, chunkPoints) {
      const count = Math.floor(result.pos.length / 3);
      const fields = {};
      const arrays = {};
      for (const f of PENDING_CLOUD_FIELDS) {
        const a = result[f];
        if (!a || !ArrayBuffer.isView(a) || !a.length) continue;
        const per = Math.round(a.length / count);
        if (per < 1 || per * count !== a.length) continue; // массив не «по точке» — оставляем в ответе как есть
        arrays[f] = a;
        fields[f] = { type: a.constructor.name, per };
      }
      const token = crypto.randomBytes(12).toString('hex');
      const timer = setTimeout(() => drop(token), ttl);
      if (timer && typeof timer.unref === 'function') timer.unref();
      items.set(token, { senderId, arrays, count, timer });
      const light = {};
      for (const k of Object.keys(result)) if (!arrays[k]) light[k] = result[k];
      light.chunked = { token, count, chunkPoints, fields };
      return light;
    },
    read(senderId, req) {
      const it = req && typeof req.token === 'string' ? items.get(req.token) : null;
      if (!it || it.senderId !== senderId) return { ok: false, message: 'облако уже освобождено' };
      const from = Number(req.from), cnt = Number(req.count);
      if (!Number.isInteger(from) || !Number.isInteger(cnt) || from < 0 || cnt < 1 || from + cnt > it.count) return { ok: false, message: 'неверный диапазон точек' };
      const out = { ok: true };
      // .slice() — копия только нужного диапазона: иначе структурное копирование отправит весь буфер целиком
      for (const f of Object.keys(it.arrays)) {
        const per = it.arrays[f].length / it.count;
        out[f] = it.arrays[f].slice(from * per, (from + cnt) * per);
      }
      return out;
    },
    release(senderId, token) {
      const it = typeof token === 'string' ? items.get(token) : null;
      if (!it || it.senderId !== senderId) return false;
      return drop(token);
    },
    releaseSender(senderId) { for (const [t, it] of Array.from(items)) if (it.senderId === senderId) drop(t); },
    size() { return items.size; }
  };
}

module.exports = { createPendingCloudStore, PENDING_CLOUD_FIELDS, PENDING_CLOUD_TTL_MS };
