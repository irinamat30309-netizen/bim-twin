'use strict';
// Ревизия 6: доля точек файла и передача облака в окно кусками (вместо лимита IPC в 20 млн точек).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CFG = require('../app-config');
const cloud = require('../las-node');
const { createPendingCloudStore } = require('../pending-clouds');
const CloudChunks = require('../renderer/cloud-chunks');

const R_ = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

function tmpFile(name) { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'share-r6-')), name); }
// Бинарный PLY с n вершинами x y z + uchar r g b; x = номер точки, чтобы было видно, какие точки выбраны
function writePly(file, n) {
  const head = Buffer.from('ply\nformat binary_little_endian 1.0\nelement vertex ' + n + '\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n', 'latin1');
  const body = Buffer.alloc(n * 15);
  for (let i = 0; i < n; i++) { const o = i * 15; body.writeFloatLE(i, o); body.writeFloatLE((i * 7) % 13, o + 4); body.writeFloatLE((i * 3) % 5, o + 8); body[o + 12] = i & 255; body[o + 13] = 120; body[o + 14] = 30; }
  fs.writeFileSync(file, Buffer.concat([head, body]));
}
function writeXyz(file, n) {
  const rows = []; for (let i = 0; i < n; i++) rows.push(i + ' ' + ((i * 7) % 13) + ' ' + ((i * 3) % 5)); fs.writeFileSync(file, rows.join('\n') + '\n');
}
function writeLas(file, n) {
  const H = 227, rec = 20, buf = Buffer.alloc(H + n * rec);
  buf.write('LASF', 0, 'latin1'); buf[24] = 1; buf[25] = 2; buf.writeUInt16LE(H, 94); buf.writeUInt32LE(H, 96); buf.writeUInt32LE(0, 100);
  buf[104] = 0; buf.writeUInt16LE(rec, 105); buf.writeUInt32LE(n, 107);
  buf.writeDoubleLE(0.01, 131); buf.writeDoubleLE(0.01, 139); buf.writeDoubleLE(0.01, 147);
  buf.writeDoubleLE(0, 155); buf.writeDoubleLE(0, 163); buf.writeDoubleLE(0, 171);
  for (let i = 0; i < n; i++) { const o = H + i * rec; buf.writeInt32LE(i * 100, o); buf.writeInt32LE(((i * 7) % 13) * 100, o + 4); buf.writeInt32LE(((i * 3) % 5) * 100, o + 8); }
  fs.writeFileSync(file, buf);
}
const countOf = (r) => r.pos.length / 3;

test('resolvePointShare: по умолчанию 100 %, допустимы только доли 1/k', () => {
  assert.equal(CFG.resolvePointShare({}), 1);
  assert.equal(CFG.resolvePointShare(null), 1);
  assert.equal(CFG.resolvePointShare({ pointShare: 100 }), 1);
  assert.equal(CFG.resolvePointShare({ pointShare: 50 }), 0.5);
  assert.equal(CFG.resolvePointShare({ pointShare: 25 }), 0.25);
  assert.ok(Math.abs(CFG.resolvePointShare({ pointShare: 33 }) - 1 / 3) < 1e-12);
  assert.equal(CFG.resolvePointShare({ pointShare: 10 }), 0.1);
  assert.equal(CFG.resolvePointShare({ pointShare: 0 }), 1);
  assert.equal(CFG.resolvePointShare({ pointShare: -5 }), 1);
  assert.equal(CFG.resolvePointShare({ pointShare: 150 }), 1);
  assert.equal(CFG.resolvePointShare({ pointShare: 'abc' }), 1);
  for (const p of CFG.POINT_SHARES) { const sh = CFG.resolvePointShare({ pointShare: p }); assert.equal(Math.round(sh * 100), p); assert.ok(Number.isInteger(Math.round(1 / sh))); }
  assert.equal(CFG.POINT_SHARES[0], 100);
});

test('PLY: 100 % = все точки, 50 % и 20 % — каждая 2-я и 5-я, бюджет остаётся верхним пределом', () => {
  const f = tmpFile('a.ply'); writePly(f, 1000);
  const all = cloud.parseCloudFile(f, { maxPoints: 200000000 });
  assert.ok(all.ok); assert.equal(countOf(all), 1000);
  assert.equal(countOf(cloud.parseCloudFile(f, { maxPoints: 200000000, pointShare: 1 })), 1000);
  const half = cloud.parseCloudFile(f, { maxPoints: 200000000, pointShare: 0.5 });
  assert.equal(countOf(half), 500);
  const fifth = cloud.parseCloudFile(f, { maxPoints: 200000000, pointShare: 0.2 });
  assert.equal(countOf(fifth), 200);
  // выборка равномерная: красный канал хранит номер точки (до 255)
  const g = tmpFile('g.ply'); writePly(g, 250);
  const pick = cloud.parseCloudFile(g, { maxPoints: 200000000, pointShare: 0.2 });
  const ids = Array.from({ length: countOf(pick) }, (_, i) => Math.round((pick.col[i * 3] > 1 ? pick.col[i * 3] : pick.col[i * 3] * 255)));
  // las-core.keepSampledIndex берёт по одной точке из каждого блока в 5 подряд идущих (без наложения на регулярные узоры сканера)
  assert.equal(ids.length, 50);
  ids.forEach((id, j) => assert.ok(id >= j * 5 && id < j * 5 + 5, 'точка ' + id + ' из блока ' + j));
  assert.equal(fifth.col.length, 200 * 3);
  // бюджет ниже доли побеждает (берётся более редкая выборка)
  const capped = cloud.parseCloudFile(f, { maxPoints: 200000, pointShare: 0.5 });
  assert.equal(countOf(capped), 500);
  // meta.total — число точек в файле независимо от доли
  assert.equal(half.meta.total, 1000);
});

test('PLY: доля не «залипает» между вызовами (состояние модуля сбрасывается)', () => {
  const f = tmpFile('b.ply'); writePly(f, 600);
  assert.equal(countOf(cloud.parseCloudFile(f, { maxPoints: 200000000, pointShare: 0.1 })), 60);
  assert.equal(countOf(cloud.parseCloudFile(f, { maxPoints: 200000000 })), 600);
  const bad = tmpFile('missing.ply');
  assert.equal(cloud.parseCloudFile(bad, { pointShare: 0.1 }).ok, false);
  assert.equal(countOf(cloud.parseCloudFile(f, { maxPoints: 200000000 })), 600);
});

test('LAS и текстовые форматы: доля применяется так же', () => {
  const l = tmpFile('c.las'); writeLas(l, 1000);
  assert.equal(countOf(cloud.parseCloudFile(l, { maxPoints: 200000000 })), 1000);
  assert.equal(countOf(cloud.parseCloudFile(l, { maxPoints: 200000000, pointShare: 0.25 })), 250);
  const t = tmpFile('d.xyz'); writeXyz(t, 1000);
  assert.equal(countOf(cloud.parseCloudFile(t, { maxPoints: 200000000 })), 1000);
  assert.equal(countOf(cloud.parseCloudFile(t, { maxPoints: 200000000, pointShare: 0.1 })), 100);
});

test('parseCloudFileAsync пробрасывает долю в воркер', async () => {
  const f = tmpFile('e.ply'); writePly(f, 800);
  const r = await cloud.parseCloudFileAsync(f, { maxPoints: 200000000, pointShare: 0.5 });
  assert.ok(r.ok); assert.equal(countOf(r), 400);
  const r2 = await cloud.parseCloudFileAsync(f, { maxPoints: 200000000 });
  assert.equal(countOf(r2), 800);
});

test('лимита IPC в 20 млн точек больше нет: куски вместо одного сообщения', () => {
  assert.equal(CFG.IPC_MAX_POINTS, undefined, 'IPC_MAX_POINTS удалён');
  assert.ok(CFG.IPC_CHUNK_POINTS >= 1e6 && CFG.IPC_CHUNK_POINTS * 29 < 300 * 1048576, 'один кусок < 300 МБ');
  assert.ok(CFG.IPC_INLINE_POINTS >= CFG.IPC_CHUNK_POINTS);
  const m = R_('main.js');
  assert.ok(!/IPC_MAX_POINTS/.test(m) && !/ipcLimited/.test(m));
  assert.ok(/bim:readCloudChunk/.test(m) && /bim:releaseCloud/.test(m));
  assert.ok(/resolvePointShare\(s\)/.test(m) && /pointShare/.test(m));
  const pre = R_('preload.js');
  assert.ok(/readCloudChunk:\s*\(a\)\s*=>\s*inv\('bim:readCloudChunk'/.test(pre) && /releaseCloud:\s*\(a\)\s*=>\s*inv\('bim:releaseCloud'/.test(pre));
  assert.ok(!/ipcLimited/.test(R_('renderer', 'app.js')));
  assert.ok(R_('renderer', 'index.html').indexOf('cloud-chunks.js') > 0 && R_('renderer', 'index.html').indexOf('cloud-chunks.js') < R_('renderer', 'index.html').indexOf('app.js?v='));
  assert.ok(JSON.parse(R_('package.json')).build.files.includes('pending-clouds.js'), 'pending-clouds.js должен попасть в сборку');
});

function fakeResult(n) {
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), intensity = new Float32Array(n), classification = new Uint8Array(n);
  for (let i = 0; i < n; i++) { pos[i * 3] = i; pos[i * 3 + 1] = i * 2; pos[i * 3 + 2] = -i; col[i * 3] = (i % 255) / 255; intensity[i] = i % 100; classification[i] = i % 7; }
  return { ok: true, kind: 'points', pos, col, intensity, classification, count: n, meta: { total: n * 3, points: n, format: 'test' } };
}
// «IPC»: main-сторона через хранилище, окно — через CloudChunks; данные копируются как при структурном клонировании
function fakeApi(store, senderId) {
  const clone = (o) => structuredClone(o);
  return {
    calls: [],
    readCloudChunk(req) { this.calls.push(['read', req.from, req.count]); return Promise.resolve(clone(store.read(senderId, req))); },
    releaseCloud(req) { this.calls.push(['release']); return Promise.resolve(store.release(senderId, req.token)); }
  };
}

test('хранилище кусков: облако уходит облегчённым ответом, куски читаются по токену, освобождение работает', async () => {
  const store = createPendingCloudStore();
  const full = fakeResult(25000);
  const light = store.stash(7, full, 10000);
  assert.equal(light.pos, undefined); assert.equal(light.col, undefined); assert.equal(light.intensity, undefined); assert.equal(light.classification, undefined);
  assert.equal(light.chunked.count, 25000); assert.equal(light.chunked.chunkPoints, 10000);
  assert.deepEqual(light.chunked.fields.pos, { type: 'Float32Array', per: 3 });
  assert.deepEqual(light.chunked.fields.classification, { type: 'Uint8Array', per: 1 });
  assert.deepEqual(light.meta, full.meta); assert.equal(store.size(), 1);
  const api = fakeApi(store, 7);
  const back = await CloudChunks.resolve(api, light, {});
  assert.equal(store.size(), 0, 'после сборки запись освобождена');
  assert.equal(back.chunked, undefined);
  assert.ok(back.pos instanceof Float32Array && back.col instanceof Float32Array && back.intensity instanceof Float32Array && back.classification instanceof Uint8Array);
  assert.deepEqual(back.pos, full.pos); assert.deepEqual(back.col, full.col); assert.deepEqual(back.intensity, full.intensity); assert.deepEqual(back.classification, full.classification);
  assert.deepEqual(api.calls.map(c => c[0]), ['read', 'read', 'read', 'release']);
  assert.deepEqual(api.calls.filter(c => c[0] === 'read').map(c => c[2]), [10000, 10000, 5000]);
});

test('хранилище кусков: чужое окно, неверный диапазон и повторное чтение отклоняются; без col/intensity тоже работает', async () => {
  const store = createPendingCloudStore();
  const r = fakeResult(100); delete r.col; delete r.intensity; delete r.classification;
  const light = store.stash(1, r, 40);
  const tok = light.chunked.token;
  assert.equal(Object.keys(light.chunked.fields).join(','), 'pos');
  assert.equal(store.read(2, { token: tok, from: 0, count: 10 }).ok, false, 'другое окно не читает');
  assert.equal(store.read(1, { token: tok, from: 90, count: 20 }).ok, false, 'за пределами облака');
  assert.equal(store.read(1, { token: tok, from: -1, count: 5 }).ok, false);
  assert.equal(store.read(1, { token: tok, from: 0.5, count: 5 }).ok, false);
  assert.equal(store.read(1, { token: 'x', from: 0, count: 5 }).ok, false);
  const part = store.read(1, { token: tok, from: 60, count: 40 });
  assert.equal(part.ok, true); assert.equal(part.pos.length, 120);
  assert.equal(part.pos.buffer.byteLength, 120 * 4, 'кусок — отдельная копия, а не вид на весь буфер');
  assert.equal(store.release(2, tok), false); assert.equal(store.size(), 1);
  assert.equal(store.release(1, tok), true); assert.equal(store.size(), 0);
  assert.equal(store.read(1, { token: tok, from: 0, count: 5 }).ok, false, 'после освобождения читать нельзя');
  const out = await CloudChunks.resolve(fakeApi(createPendingCloudStore(), 1), { ok: true, chunked: { token: 'zz', count: 10, chunkPoints: 5, fields: { pos: { type: 'Float32Array', per: 3 } } } }, {});
  assert.equal(out.ok, false); assert.match(out.message, /передать облако/);
});

test('хранилище кусков: окно закрылось или забыло освободить — запись удаляется (releaseSender и таймер)', async () => {
  const store = createPendingCloudStore({ ttlMs: 30 });
  store.stash(1, fakeResult(10), 5); store.stash(2, fakeResult(10), 5);
  store.releaseSender(1); assert.equal(store.size(), 1);
  await new Promise(r => setTimeout(r, 80)); assert.equal(store.size(), 0);
});

test('CloudChunks.resolve: малое облако без chunked возвращается как есть; прогресс доходит до 1', async () => {
  const small = fakeResult(10);
  assert.equal(await CloudChunks.resolve({}, small, {}), small);
  const fail = { ok: false, message: 'x' };
  assert.equal(await CloudChunks.resolve({}, fail, {}), fail);
  const store = createPendingCloudStore();
  const light = store.stash(3, fakeResult(2500), 1000);
  const seen = [];
  await CloudChunks.resolve(fakeApi(store, 3), light, { onProgress: (f) => seen.push(f) });
  assert.deepEqual(seen, [0.4, 0.8, 1]);
});

test('CloudChunks.resolve: нехватка памяти окна даёт понятное сообщение про долю точек и освобождает облако в main', async () => {
  const store = createPendingCloudStore();
  const light = store.stash(5, fakeResult(100), 50);
  light.chunked.count = 5e9; // абсурдный размер → RangeError при выделении
  light.chunked.fields.pos.per = 3;
  const api = fakeApi(store, 5);
  const out = await CloudChunks.resolve(api, light, {});
  assert.equal(out.ok, false); assert.equal(out.outOfMemory, true);
  assert.match(out.message, /Доля точек|доля точек|долю точек/i);
  assert.deepEqual(api.calls.map(c => c[0]), ['release']);
});

test('интерфейс: доля точек в Настройках и в «Вид облака», по умолчанию 100 %', () => {
  const app = R_('renderer', 'app.js'), html = R_('renderer', 'index.html');
  assert.ok(/secC = section\('Облака точек'\)/.test(app) && /'Доля точек файла'/.test(app));
  assert.ok(/id="qShare"/.test(html) && /id="qDensity"[^>]*max="300"[^>]*value="200"/.test(html));
  assert.ok(/100 % — все точки файла/.test(app));
  assert.ok(/applyPointShare\(st\.pointShare\)/.test(app));
  const ui = R_('renderer', 'lixel-cloud-ui.js');
  assert.ok(/cpShareNote/.test(ui) && /Настройки → Облака точек/.test(ui));
});
