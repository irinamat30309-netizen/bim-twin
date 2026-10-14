'use strict';
// Ревизия 17: потоковая запись больших облаков. Берём настоящий код обработчиков bim:beginExportStream / writeExportStreamChunk /
// finishExportStream / cancelExportStream из main.js (без Electron: заглушки диалога, окна и фиксации файла) и проверяем поведение.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { PathGrantRegistry, canonicalExistingFile, hasAllowedExtension } = require('../security/file-access');
const { PTXStreamValidator } = require('../renderer/ptx-stream-validator');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const A = src.indexOf('  const activeExportStreams = new Map();'), B = src.indexOf("  ipcMain.on('bim:cancelCloudParse'");
assert.ok(A > 0 && B > A, 'в main.js найден блок потоковой записи');
const slice = src.slice(A, B);
const factory = vm.runInNewContext('(function (env) { const { fs, path, crypto, Buffer, console, ipcMain, dialog, BrowserWindow, PathGrantRegistry, PTXStreamValidator, safeFilePart, saveCloudOutputFromTemp, isTrustedIpcEvent, safeReadPath, canonicalExistingFile, hasAllowedExtension, USER_PICK_EXT_ALLOW, Uint8Array, ArrayBuffer } = env;\n' + slice + '\n return { activeExportStreams, fileGrants }; })', {});

function harness(dir, dialogPath) {
  const handlers = {}; const calls = { dialog: 0, commit: [] };
  const env = {
    fs, path, crypto, Buffer, console, PathGrantRegistry, PTXStreamValidator, canonicalExistingFile, hasAllowedExtension, USER_PICK_EXT_ALLOW: ['ply'], Uint8Array, ArrayBuffer,
    ipcMain: { handle: (n, f) => { handlers[n] = f; }, on() {} },
    dialog: { showSaveDialog: async () => { calls.dialog++; return dialogPath ? { canceled: false, filePath: dialogPath } : { canceled: true }; } },
    BrowserWindow: { fromWebContents: () => null },
    safeFilePart: (p) => path.basename(String(p || 'cloud').replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').slice(0, 120) || 'cloud.bin',
    saveCloudOutputFromTemp: async (target, temp) => { const st = fs.statSync(temp); fs.renameSync(temp, target); calls.commit.push(target); return { path: target, bytes: st.size, sha256: 'x', backupPath: null, noOp: false, warnings: [] }; },
    isTrustedIpcEvent: () => true, safeReadPath: () => null
  };
  const state = factory(env);
  const sender = { id: 7, isDestroyed: () => false, once() {}, on() {}, removeListener() {}, getURL: () => 'file:///x/renderer/index.html' };
  return { h: handlers, calls, state, event: { sender }, sender };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'r17-ipc-'));

test('r17 IPC: PLY потоком — куски байт, объявленный размер, файл на диске = склейка кусков, временного файла не остаётся', async () => {
  const dir = tmp(), target = path.join(dir, 'out.ply'), t = harness(dir, target);
  const parts = [Buffer.from('ply\nformat binary_little_endian 1.0\nelement vertex 3\nend_header\n'), crypto.randomBytes(1000), crypto.randomBytes(777)];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const b = await t.h['bim:beginExportStream'](t.event, { ext: 'ply', name: 'x.ply', expectedPoints: 3, expectedBytes: total });
  assert.ok(b.ok && /^[a-f0-9]{48}$/.test(b.streamId), JSON.stringify(b)); assert.equal(t.calls.dialog, 1);
  for (const p of parts) { const w = await t.h['bim:writeExportStreamChunk'](t.event, { streamId: b.streamId, bytes: new Uint8Array(p) }); assert.ok(w.ok, JSON.stringify(w)); }
  const f = await t.h['bim:finishExportStream'](t.event, { streamId: b.streamId });
  assert.ok(f.ok, JSON.stringify(f)); assert.equal(f.path, target); assert.equal(f.bytes, total);
  assert.ok(Buffer.compare(fs.readFileSync(target), Buffer.concat(parts)) === 0);
  assert.deepEqual(fs.readdirSync(dir), ['out.ply']); assert.equal(t.state.activeExportStreams.size, 0);
});

test('r17 IPC: размер не совпал с объявленным → ошибка, ничего не зафиксировано, временный файл удалён; лишние байты отвергаются сразу', async () => {
  const dir = tmp(), t = harness(dir, path.join(dir, 'a.las'));
  let b = await t.h['bim:beginExportStream'](t.event, { ext: 'las', expectedBytes: 100 });
  await t.h['bim:writeExportStreamChunk'](t.event, { streamId: b.streamId, bytes: new Uint8Array(60) });
  let f = await t.h['bim:finishExportStream'](t.event, { streamId: b.streamId });
  assert.equal(f.ok, false); assert.equal(t.calls.commit.length, 0); assert.deepEqual(fs.readdirSync(dir), []);
  b = await t.h['bim:beginExportStream'](t.event, { ext: 'las', expectedBytes: 100 });
  const w1 = await t.h['bim:writeExportStreamChunk'](t.event, { streamId: b.streamId, bytes: new Uint8Array(80) }); assert.ok(w1.ok);
  const w2 = await t.h['bim:writeExportStreamChunk'](t.event, { streamId: b.streamId, bytes: new Uint8Array(30) });
  assert.equal(w2.ok, false); assert.deepEqual(fs.readdirSync(dir), []); assert.equal(t.state.activeExportStreams.size, 0);
});

test('r17 IPC: форматы и куски проверяются; чужой/неверный токен, пустой и слишком большой кусок отвергаются; один поток на окно', async () => {
  const dir = tmp(), t = harness(dir, path.join(dir, 'b.xyz'));
  assert.equal((await t.h['bim:beginExportStream'](t.event, { ext: 'exe', expectedPoints: 1 })).error, 'stream_format_not_supported');
  assert.equal((await t.h['bim:beginExportStream'](t.event, { ext: 'ptx', expectedPoints: 0 })).error, 'invalid_point_count', 'для PTX число точек обязательно');
  assert.equal((await t.h['bim:beginExportStream'](t.event, { ext: 'xyz', expectedBytes: -5 })).error, 'invalid_expected_bytes');
  const b = await t.h['bim:beginExportStream'](t.event, { ext: 'xyz' }); assert.ok(b.ok);
  assert.equal((await t.h['bim:beginExportStream'](t.event, { ext: 'xyz' })).error, 'export_busy');
  assert.equal((await t.h['bim:writeExportStreamChunk']({ sender: { id: 9 } }, { streamId: b.streamId, bytes: new Uint8Array(4) })).error, 'invalid_or_expired_stream');
  assert.equal((await t.h['bim:writeExportStreamChunk'](t.event, { streamId: 'zz', bytes: new Uint8Array(4) })).error, 'invalid_or_expired_stream');
  assert.equal((await t.h['bim:writeExportStreamChunk'](t.event, { streamId: b.streamId, bytes: new Uint8Array(0) })).error, 'invalid_stream_chunk');
  assert.equal(t.state.activeExportStreams.size, 0, 'неверный кусок закрывает поток и удаляет временный файл');
  const b2 = await t.h['bim:beginExportStream'](t.event, { ext: 'csv' }); assert.ok(b2.ok);
  assert.equal((await t.h['bim:writeExportStreamChunk'](t.event, { streamId: b2.streamId, text: 'abc' })).error, 'invalid_stream_chunk', 'у бинарных форматов текстовый кусок не принимается');
  const b3 = await t.h['bim:beginExportStream'](t.event, { ext: 'obj' }); assert.ok(b3.ok);
  assert.equal((await t.h['bim:writeExportStreamChunk'](t.event, { streamId: b3.streamId, bytes: new Uint8Array(32 * 1024 * 1024 + 1) })).error, 'invalid_stream_chunk');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('r17 IPC: отмена удаляет временный файл; отмена диалога — canceled; PTX работает как раньше (текст, проверка)', async () => {
  const dir = tmp(), t = harness(dir, path.join(dir, 'c.pcd'));
  const b = await t.h['bim:beginExportStream'](t.event, { ext: 'pcd' });
  await t.h['bim:writeExportStreamChunk'](t.event, { streamId: b.streamId, bytes: new Uint8Array(500) });
  assert.ok(fs.readdirSync(dir).length === 1);
  const c = await t.h['bim:cancelExportStream'](t.event, { streamId: b.streamId }); assert.ok(c.ok && c.cancelled); assert.deepEqual(fs.readdirSync(dir), []);
  const t2 = harness(dir, null); assert.equal((await t2.h['bim:beginExportStream'](t2.event, { ext: 'ply' })).canceled, true);
  // PTX: один скан из одной точки
  const t3 = harness(dir, path.join(dir, 'd.ptx'));
  const b3 = await t3.h['bim:beginExportStream'](t3.event, { ext: 'ptx', expectedPoints: 1 }); assert.ok(b3.ok);
  const text = ['1', '1', '0 0 0', '1 0 0', '0 1 0', '0 0 1', '1 0 0 0', '0 1 0 0', '0 0 1 0', '0 0 0 1', '1 2 3'].join('\n') + '\n';
  const v = new PTXStreamValidator(1); v.push(text); v.finish();
  const w = await t3.h['bim:writeExportStreamChunk'](t3.event, { streamId: b3.streamId, text }); assert.ok(w.ok && w.points === 1, JSON.stringify(w));
  assert.ok((await t3.h['bim:finishExportStream'](t3.event, { streamId: b3.streamId })).ok);
  assert.equal(fs.readFileSync(path.join(dir, 'd.ptx'), 'utf8'), text);
});

test('r17 IPC: тихая запись в рабочий файл (targetPath) — только в путь, выданный этому окну; диалог не открывается; расширение должно совпасть', async () => {
  const dir = tmp(), work = path.join(dir, 'work.ply'); fs.writeFileSync(work, 'old');
  const t = harness(dir, path.join(dir, 'never.ply'));
  const denied = await t.h['bim:beginExportStream'](t.event, { ext: 'ply', targetPath: work });
  assert.equal(denied.error, 'path_not_authorized'); assert.equal(t.calls.dialog, 0);
  t.state.fileGrants.grantExistingFile(t.sender.id, work, { read: true, write: true });
  const wrongExt = await t.h['bim:beginExportStream'](t.event, { ext: 'las', targetPath: work });
  assert.equal(wrongExt.error, 'invalid_output_extension');
  const b = await t.h['bim:beginExportStream'](t.event, { ext: 'ply', targetPath: work, expectedBytes: 5 });
  assert.ok(b.ok, JSON.stringify(b)); assert.equal(t.calls.dialog, 0);
  await t.h['bim:writeExportStreamChunk'](t.event, { streamId: b.streamId, bytes: new Uint8Array([1, 2, 3, 4, 5]) });
  const f = await t.h['bim:finishExportStream'](t.event, { streamId: b.streamId }); assert.ok(f.ok, JSON.stringify(f));
  assert.deepEqual(Array.from(fs.readFileSync(work)), [1, 2, 3, 4, 5]);
  assert.equal((await t.h['bim:beginExportStream']({ sender: { id: 99, isDestroyed: () => false, once() {}, on() {}, removeListener() {}, getURL: () => 'file:///x/renderer/index.html' } }, { ext: 'ply', targetPath: work })).error, 'path_not_authorized', 'другое окно этот путь не получило');
});
