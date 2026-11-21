'use strict';
/*
 * r184: пути вывода инструментов P1/P2/P3 — только папка проекта.
 * Проверяем: <Project>/output/<tool>-<stamp> (+<Project>/temp с очисткой), запрос папки при
 * отсутствии проекта, отсутствие записи в userData/AppData, безопасную очистку старых
 * p1-r151/p2p3-r155, IPC статуса/очистки и UI-баннер.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }

const ROOT = path.join(__dirname, '..');
const R = path.join(ROOT, 'renderer');
const TS = require(path.join(ROOT, 'tool-storage.js'));
const P1B = require(path.join(ROOT, 'p1-bridge.js'));
const P23B = require(path.join(ROOT, 'p23-bridge.js'));
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const P1UI = fs.readFileSync(path.join(R, 'ui', 'p1-tools.js'), 'utf8');
const P23UI = fs.readFileSync(path.join(R, 'ui', 'p23-tools.js'), 'utf8');

function tmpDir(p) { return fs.mkdtempSync(path.join(os.tmpdir(), (p || 'r184-'))); }
function walk(dir) {
  const out = [];
  try {
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) out.push(...walk(p)); else out.push(p);
    }
  } catch (_) { }
  return out;
}
function fakeDeps(opts) {
  opts = opts || {};
  const handlers = {};
  const tmp = tmpDir('r184-bridge-');
  const projectDir = path.join(tmp, 'proj');
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(projectDir, { recursive: true }); fs.mkdirSync(userData, { recursive: true });
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
  const deps = {
    ipcMain, app: { getPath: () => userData }, dialog, rootDir: ROOT, python: null,
    fileGrants: { grantExistingFile: () => { } },
    ipcSender: (event) => (event && event.sender) || { id: 1, send: () => { } },
    resolveAuthorizedFile: (event, p) => (p && fs.existsSync(p) ? path.resolve(p) : null),
    grantExistingOutput: () => true,
    userData
  };
  if (opts.withProject) { deps.projectFolder = () => ({ ok: true, path: projectDir, own: true }); deps.chooseProjectFolder = async () => ({ ok: true, path: projectDir }); }
  if (opts.chooseResult) deps.chooseProjectFolder = async () => opts.chooseResult;
  if (opts.userData) deps.userData = opts.userData;
  return { deps, handlers, tmp, projectDir, userData };
}
function touch(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); return p; }

test('r184 tool-storage: <Project>/output/<tool>-<stamp> и <Project>/temp с очисткой', () => {
  const root = tmpDir('r184-job-');
  const job = TS.makeJob(root, 'classify');
  assert.ok(job.outDir.startsWith(path.join(root, 'output') + path.sep), 'результаты в <project>/output');
  assert.ok(job.tempDir.startsWith(path.join(root, 'temp') + path.sep), 'временные в <project>/temp');
  assert.match(path.basename(job.outDir), /^classify-\d{8}-\d{6}/);
  assert.ok(fs.existsSync(job.outDir) && fs.existsSync(job.tempDir));
  const out = job.out('classified.las');
  assert.equal(path.dirname(out), job.outDir);
  const evil = job.out('../../evil.las');
  assert.equal(path.dirname(evil), job.outDir, 'имена не выходят из папки: ' + evil);
  assert.ok(TS.isInside(job.outDir, evil));
  const tmpFile = job.tmp('scratch.ply'); fs.writeFileSync(tmpFile, 'tmp');
  const fin = job.finalize();
  assert.equal(fin.ok, true);
  assert.equal(fs.existsSync(job.tempDir), false, 'temp удалён после операции');
  assert.equal(fs.existsSync(out.replace(/classified\.las$/, '')), true);
  assert.equal(fs.existsSync(root), true);
});

test('r184 tool-storage: без проекта — папка спрашивается, отмена/отсутствие = ошибка (не AppData)', async () => {
  const root = tmpDir('r184-resolve-');
  const chosen = path.join(root, 'chosen-project');
  // 1) проект выбран
  assert.equal(await TS.resolveProjectRoot({ projectFolder: () => ({ ok: true, path: chosen, own: true }) }), path.resolve(chosen));
  // 2) не выбран — диалог вернул папку
  assert.equal(await TS.resolveProjectRoot({ projectFolder: () => ({ ok: true, path: root, own: false }), chooseProjectFolder: async () => ({ ok: true, path: chosen }) }), path.resolve(chosen));
  // 3) диалог отменён
  await assert.rejects(() => TS.resolveProjectRoot({ projectFolder: () => null, chooseProjectFolder: async () => ({ canceled: true }) }), (e) => e.code === 'canceled');
  // 4) нет ни проекта, ни диалога — ошибка no_project, никакого userData
  await assert.rejects(() => TS.resolveProjectRoot({ userData: root }), (e) => e.code === 'no_project');
  const err = TS.storageError(Object.assign(new Error('нет папки'), { code: 'no_project' }));
  assert.equal(err.needProjectFolder, true);
});

test('r184 tool-storage: безопасная очистка старых p1-r151/p2p3-r155', () => {
  const userData = tmpDir('r184-legacy-');
  touch(path.join(userData, 'p1-r151', 'classify-x', 'classified.las'));
  touch(path.join(userData, 'p1-r151', 'export-x', 'batch.ply'));
  touch(path.join(userData, 'p2p3-r155', 'clip-x', 'clip-fragment.ply'));
  touch(path.join(userData, 'settings.json'));
  touch(path.join(userData, 'autosave', 'keep.json'));
  const info = TS.legacySummary(userData);
  assert.equal(info.dirs.length, 2);
  assert.ok(info.bytes >= 3);
  assert.ok(info.files >= 3);
  // без подтверждения — ничего не удалено
  let r = TS.cleanLegacy(userData, {});
  assert.equal(r.ok, false);
  assert.ok(fs.existsSync(path.join(userData, 'p1-r151')));
  // с подтверждением — удалены только две старые папки
  r = TS.cleanLegacy(userData, { confirm: true });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(userData, 'p1-r151')), false);
  assert.equal(fs.existsSync(path.join(userData, 'p2p3-r155')), false);
  assert.equal(fs.existsSync(path.join(userData, 'settings.json')), true, 'чужие файлы не тронуты');
  assert.equal(fs.existsSync(path.join(userData, 'autosave', 'keep.json')), true);
  // повторно — безопасно
  assert.equal(TS.cleanLegacy(userData, { confirm: true }).ok, true);
});

test('r184 p1-bridge: классификация пишет только в папку проекта, без проекта — просит папку', async () => {
  const cloud = touch(path.join(tmpDir('r184-cloud-'), 'ref.las'));
  // нет папки проекта → понятная ошибка, ничего не создано
  const a = fakeDeps();
  P1B.register(a.deps);
  let r = await a.handlers['bim:p1Classify']({ sender: { id: 1 } }, { cloud });
  assert.equal(r.ok, false);
  assert.equal(r.needProjectFolder, true);
  assert.match(r.error, /папк|проект/i);
  assert.deepEqual(walk(a.userData), [], 'в пользовательский каталог ничего не записано');
  // папка проекта есть → job создан внутри <project>/output, temp убран
  const b = fakeDeps({ withProject: true });
  P1B.register(b.deps);
  r = await b.handlers['bim:p1Classify']({ sender: { id: 1 } }, { cloud });
  assert.equal(r.ok, false, 'python отсутствует — операция не выполнена, но папки проверяем');
  const outRoot = path.join(b.projectDir, 'output');
  assert.ok(fs.existsSync(outRoot), 'output создан в папке проекта');
  const jobDirs = fs.existsSync(outRoot) ? fs.readdirSync(outRoot).filter((n) => /^classify-/.test(n)) : [];
  assert.equal(jobDirs.length, 1, 'папка операции в output/ проекта: ' + jobDirs.join(','));
  assert.equal(fs.existsSync(path.join(b.projectDir, 'temp')), false, 'temp очищен');
  assert.deepEqual(walk(b.userData), [], 'в userData ничего не записано');
});

test('r184 p23-bridge: фрагмент клип-бокса — в папку проекта; статус сообщает пути; без проекта — ошибка', async () => {
  const pos = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]);
  const a = fakeDeps();
  P23B.register(a.deps);
  let st = await a.handlers['bim:p23Status']({});
  assert.ok(st.storage, 'статус содержит storage');
  assert.equal(st.storage.projectSelected, false);
  let r = await a.handlers['bim:p23SaveFragment']({ sender: { id: 1 } }, { format: 'ply', pos });
  assert.equal(r.ok, false);
  assert.equal(r.needProjectFolder, true);
  assert.deepEqual(walk(a.userData), []);
  const b = fakeDeps({ withProject: true });
  P23B.register(b.deps);
  st = await b.handlers['bim:p23Status']({});
  assert.equal(st.storage.projectSelected, true);
  assert.equal(st.storage.outputRoot, path.join(b.projectDir, 'output'));
  r = await b.handlers['bim:p23SaveFragment']({ sender: { id: 1 } }, { format: 'ply', pos });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.path.startsWith(path.join(b.projectDir, 'output') + path.sep), 'файл в папке проекта: ' + r.path);
  assert.ok(fs.existsSync(r.path));
  assert.deepEqual(walk(b.userData), [], 'в userData ничего не записано');
  assert.equal(walk(b.projectDir).some((p) => p.includes(path.join('temp', 'clip-'))), false, 'temp очищен');
});

test('r184: IPC p1Storage — info/cleanLegacy/confirm и тестовый assign запрещён вне E2E', async () => {
  const userData = tmpDir('r184-storage-ipc-');
  touch(path.join(userData, 'p1-r151', 'x', 'a.las'));
  const { deps, handlers } = fakeDeps({ withProject: true, userData });
  P1B.register(deps);
  let r = await handlers['bim:p1Storage']({ sender: { id: 1 } }, { action: 'info' });
  assert.equal(r.ok, true);
  assert.equal(r.projectSelected, true);
  assert.ok(r.legacyBytes > 0, 'старые папки видны');
  r = await handlers['bim:p1Storage']({ sender: { id: 1 } }, { action: 'cleanLegacy' });
  assert.equal(r.ok, false, 'без confirm не удаляем');
  assert.ok(fs.existsSync(path.join(userData, 'p1-r151')));
  r = await handlers['bim:p1Storage']({ sender: { id: 1 } }, { action: 'cleanLegacy', confirm: true });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(userData, 'p1-r151')), false);
  r = await handlers['bim:p1Storage']({ sender: { id: 1 } }, { action: 'assignProjectDir', path: path.join(userData, 'x') });
  assert.equal(r.ok, false, 'assignProjectDir доступен только при BIM_TWIN_E2E=1');
  assert.match(r.error, /тестовом режиме/);
});

test('r184: main/preload/UI — мост получает папку проекта, старый p1-r151 не пишется, баннер и очистка есть', () => {
  assert.match(MAIN, /projectFolder:\s*toolProjectFolderInfo/);
  assert.match(MAIN, /chooseProjectFolder:\s*chooseToolProjectFolder/);
  assert.match(MAIN, /toolProjectFolderInfo/);
  assert.doesNotMatch(MAIN, /outputRoot:\s*\(\)\s*=>\s*projectTempDir\(\)/);
  for (const src of [fs.readFileSync(path.join(ROOT, 'p1-bridge.js'), 'utf8'), fs.readFileSync(path.join(ROOT, 'p23-bridge.js'), 'utf8')]) {
    assert.doesNotMatch(src, /app\.getPath\('userData'\)/, 'мость не должен писать в userData');
    assert.doesNotMatch(src, /p1-r151|p2p3-r155/, 'нет старых каталогов AppData в путях записи');
    assert.match(src, /toolStorage\.beginJob/);
  }
  assert.match(PRELOAD, /p1Storage:\s*\(a\)/);
  assert.match(PRELOAD, /p23Storage:\s*\(a\)/);
  assert.match(P1UI, /lxP1StorageBar/);
  assert.match(P1UI, /cleanLegacy|cleanLegacyStorage/);
  assert.match(P1UI, /p1Storage\(\{ action: 'info' \}\)/);
  assert.match(P23UI, /storageText/);
});

test('r184 UI (jsdom): баннер показывает папку проекта и предлагает удалить старые результаты', async () => {
  if (!JSDOM) return;
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [], toasts = [];
  const projectRoot = 'D:\\Projects\\Дом';
  const info = {
    ok: true, projectSelected: true, projectRoot, outputRoot: projectRoot + '\\output', tempRoot: projectRoot + '\\temp',
    legacyBytes: 8 * 1024 * 1024, legacy: { dirs: [{ name: 'p1-r151', exists: true, bytes: 8 * 1024 * 1024, files: 5 }], bytes: 8 * 1024 * 1024, files: 5 }
  };
  w.bimAPI = {
    p1Register: async () => ({ ok: false }),
    p1Storage: async (a) => { calls.push(a); if (a && a.action === 'choose') return { ok: true }; if (a && a.action === 'cleanLegacy') return { ok: true, removed: [{ name: 'p1-r151', existed: true, bytes: 8 * 1024 * 1024, files: 5 }] }; return info; }
  };
  w.__lxKit = { toast: (m, o) => toasts.push(m), ask: async () => true };
  w.__lxIcons = { svg: () => '' };
  w.eval(P1UI);
  try {
    w.__lxP1.mount();
    await new Promise((r) => setTimeout(r, 80));
    const bar = w.document.getElementById('lxP1StorageBar');
    assert.ok(bar && !bar.hidden, 'баннер хранения виден');
    assert.match(bar.textContent, /Результаты/);
    assert.match(bar.textContent, /8,0 МБ|8\.0 МБ|Старые результаты/);
    // кнопка удаления: подтверждение true → запрос confirm:true
    const del = bar.querySelector('[data-p1storage="clean"]');
    assert.ok(del, 'кнопка удаления старых результатов');
    del.click();
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(calls.some((a) => a && a.action === 'cleanLegacy' && a.confirm === true), 'вызвана очистка с confirm:true');
    assert.ok(fs.existsSync('D:\\Projects') || true); // путь в тесте не создаём — проверяем только вызов
  } finally { try { dom.window.close(); } catch (e) { } }
});
