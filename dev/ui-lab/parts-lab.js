// Ревизия 16 (не часть продукта): облако из сотен млн точек читается ЧАСТЯМИ. Проверка в Chromium на синтетическом «коридоре» ~4 млн точек:
//  А) viewer: beginCloudStream / addCloudStreamSegment / endCloudStream — все точки в видеопамяти, отсечение кирпичей вне экрана,
//     снижение «лишних» точек при движении, GPU-выбор точки (_segPointAt), блокировка правки без падений, интенсивность лениво,
//     нехватка видеопамяти → поместившиеся части + сообщение;
//  Б) app.js целиком: подмена IPC cloudPartsOpen/Read/Close, открытие файла через #modelInput, отмена из карточки прогресса.
//   sh /data/ui-lab/run.sh dev/ui-lab/parts-lab.js
const { launch } = require('./lab');
const path = require('path');
const ROOM = path.join(__dirname, 'room.ply');
(async () => {
  const { browser, page, errs } = await launch({ w: 1000, h: 640, theme: 'dark', wait: 2000 });
  page.setDefaultTimeout(900000);
  // общий генератор синтетического коридора: точка i (глобальный номер) — функция от i; кирпичи вдоль оси X подряд
  await page.evaluate(() => {
    const N = 4000000, SEG = 500000, CH = 50000, NCH = N / CH;
    const hash = (i, k) => { let h = (Math.imul(i + 1, 2654435761) ^ Math.imul(k + 7, 40503)) >>> 0; h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
    window.__gen = {
      N, SEG, CH,
      pt(i) { const c = Math.floor(i / CH); return [-40 + 80 * (c + hash(i, 1)) / NCH, hash(i, 2) * 6, hash(i, 3) * 8 - 4]; },
      seg(k, withAttr) {
        const from = k * SEG, n = Math.min(SEG, N - from), pos = new Float32Array(n * 3), col = new Uint8Array(n * 3);
        const inten = withAttr ? new Uint16Array(n) : null, cls = withAttr ? new Uint8Array(n) : null;
        for (let j = 0; j < n; j++) { const p = window.__gen.pt(from + j); pos[j * 3] = p[0]; pos[j * 3 + 1] = p[1]; pos[j * 3 + 2] = p[2]; col[j * 3] = 60 + (j & 63); col[j * 3 + 1] = 120; col[j * 3 + 2] = 200 - (j & 31); if (inten) { inten[j] = (hash(from + j, 4) * 65535) | 0; cls[j] = (j % 5) + 1; } }
        const nc = Math.ceil(n / CH), B = new Float32Array(nc * 6);
        for (let c = 0; c < nc; c++) { let a = [1e30, 1e30, 1e30], b = [-1e30, -1e30, -1e30]; for (let j = c * CH; j < Math.min(n, (c + 1) * CH); j++) for (let t = 0; t < 3; t++) { const v = pos[j * 3 + t]; if (v < a[t]) a[t] = v; if (v > b[t]) b[t] = v; } B.set([a[0], a[1], a[2], b[0], b[1], b[2]], c * 6); }
        return { ok: true, pos, col, intensity: inten, classification: cls, count: n, chunkPoints: CH, chunkBoxes: B, from, bbox: { mn: [-40, 0, -4], mx: [40, 6, 4] } };
      }
    };
  });
  const out = {}, checks = [];
  const ok = (name, cond, info) => checks.push({ name, ok: !!cond, info: info === undefined ? undefined : info });

  // ---------- А) viewer ----------
  const A = await page.evaluate(async () => {
    const v = window.__viewer || window.__lxViewer, G = window.__gen, r = {};
    window.__stl = 0; window.addEventListener('bim-stream-limit', () => { window.__stl++; });
    v.beginCloudStream({ total: G.N, bbox: { mn: [-40, 0, -4], mx: [40, 6, 4] }, meta: { format: 'las', total: G.N, colored: true, hasIntensity: true, hasClassification: true }, hasIntensity: true, hasClassification: true, name: 'corridor.las' }, { sampleTarget: 500000 });
    r.afterBegin = { stream: v.isStreamedCloud(), count: v.base[0].count, segs: v.base[0]._segs.length };
    let cnt = 0;
    for (let k = 0; k < G.N / G.SEG; k++) { const res = v.addCloudStreamSegment(G.seg(k, true)); if (!res.ok) r.addFail = res; cnt = res.loaded; }
    v.endCloudStream({ path: '/x/corridor.las', name: 'corridor.las' });
    const bo = v.base[0], info = v.getCloudInfo();
    r.loaded = { gpuCount: bo._gpuCount, count: bo.count, segs: bo._segs.length, info: { sourceCount: info.sourceCount, loadedCount: info.loadedCount, hasIntensity: info.hasIntensity, hasClassification: info.hasClassification }, sample: bo.pos.length / 3, bbox: v.bbox };
    r.chunksPerSeg = bo._segs[0].boxes.length / 6;
    const probe = (mov) => { v._interacting = !!mov; v._probeIdle = !mov; v._renderNow(); v._interacting = false; v._probeIdle = false; return v._cullStats ? Object.assign({}, v._cullStats) : null; };
    // 1) всё облако в кадре, покой: рисуются все точки
    v.target = [0, 3, 0]; v.dist = 110; v.yaw = 0; v.pitch = 0; v.render(); r.whole = { idle: probe(false), moving: probe(true) };
    // 2) вид вплотную к краю коридора: кирпичи вне экрана отсекаются и в покое, и при движении
    v.target = [-34, 3, 0]; v.dist = 7; v.render(); r.close = { idle: probe(false), moving: probe(true) };
    // 3) поворот камеры: другой набор кирпичей
    v.yaw = Math.PI / 2; v.render(); r.turn = { idle: probe(false), moving: probe(true) };
    v.yaw = 0; v.target = [-34, 3, 0]; v.dist = 7; v.render();
    // 4) GPU-выбор: индекс → точка должны совпадать с генератором (чтение из буфера видеопамяти)
    const rect = v.canvas.getBoundingClientRect(), M = v._lastVP || v._vp(); let okP = 0, badP = 0, tried = 0; const segHit = new Set();
    for (let t = 0; t < 900 && okP + badP < 12; t++) {
      const i = Math.floor(Math.random() * G.N), p = G.pt(i), x = Math.fround(p[0]), y = Math.fround(p[1]), z = Math.fround(p[2]);
      const cx = M[0] * x + M[4] * y + M[8] * z + M[12], cy = M[1] * x + M[5] * y + M[9] * z + M[13], cw = M[3] * x + M[7] * y + M[11] * z + M[15];
      if (cw <= 0) continue; const nx = cx / cw, ny = cy / cw; if (Math.abs(nx) > 0.85 || Math.abs(ny) > 0.85) continue;
      const sx = rect.left + (nx * 0.5 + 0.5) * rect.width, sy = rect.top + (1 - (ny * 0.5 + 0.5)) * rect.height;
      const pk = v._pickGPU(sx, sy, 6); tried++; if (!pk) continue;
      const q = G.pt(pk.index);
      if (Math.fround(q[0]) === pk.point[0] && Math.fround(q[1]) === pk.point[1] && Math.fround(q[2]) === pk.point[2]) { okP++; segHit.add(Math.floor(pk.index / G.SEG)); } else badP++;
    }
    r.pick = { tried, ok: okP, bad: badP, segmentsHit: segHit.size };
    r.pickIdMax = (() => { const pk = v._pickGPU(rect.left + rect.width / 2, rect.top + rect.height / 2, 400); return pk ? pk.index : null; })();
    // 5) блокировки правки/выделения: не падают, возвращают нейтральное, шлют сообщение
    // Ревизия 17: с копиями сегментов в памяти (cpu=true) операции работают (см. big-lab.js); аварийный путь r16 — когда копии не поместились (cpu=false)
    v.base[0]._stream.cpu = false;
    window.__stl = 0; v._streamBlockAt = 0;
    const blk = {};
    blk.selectBox = v.selectBox([-1, 0, -1], [1, 1, 1]); blk.deleteSelection = v.deleteSelection(); blk.cropToSelection = v.cropToSelection();
    blk.cleanAuto = v.cleanAutoInApp({}); blk.cleanSOR = v.cleanSORInApp({}); blk.voxel = v.voxelDownsampleInApp({}); blk.edited = v.getEditedCloud(); blk.undo = v.undoEdit();
    blk.classify = v.assignClassificationInApp(2); blk.floor = v.detectFloorWalls({}); blk.selectRegion = v.selectRegion(0, 0, 50, 50); blk.events = window.__stl;
    r.block = blk;
    // 6) интенсивность лениво: буферы появляются только при таком цвете
    r.ibBefore = bo._segs.filter((s) => s.ib).length;
    v.setColorMode('intensity'); v.render(); v._renderNow(); r.ibAfter = bo._segs.filter((s) => s.ib).length; r.glErrIntensity = v.gl.getError();
    v.setColorMode('classification'); v.render(); v._renderNow(); r.kbAfter = bo._segs.filter((s) => s.kb).length; r.glErrClass = v.gl.getError();
    v.setColorMode('rgb'); v.render();
    // 7) «Не рисовать невидимое при движении» выключено: при движении рисуется бюджет без ограничения по площади
    v.target = [0, 3, 0]; v.dist = 110; v.render(); v.setMoveSmart(false); const movOff = probe(true); v.setMoveSmart(true); const movOn = probe(true);
    r.smart = { off: movOff && movOff.drawn, on: movOn && movOn.drawn };
    // 8) нехватка видеопамяти на третьей части
    const gl = v.gl, realErr = gl.getError.bind(gl); let calls = 0; window.__gs = null; window.addEventListener('bim-gpu-short', (e) => { window.__gs = e.detail; });
    v.beginCloudStream({ total: G.N, bbox: { mn: [-40, 0, -4], mx: [40, 6, 4] }, meta: { format: 'las', total: G.N }, name: 'short.las' }, { sampleTarget: 200000 });
    gl.getError = () => { calls++; return calls === 6 ? gl.OUT_OF_MEMORY : realErr(); };   // по два вызова на часть: OOM на третьей
    const res = []; for (let k = 0; k < 5; k++) { const a = v.addCloudStreamSegment(G.seg(k, false)); res.push(a.ok ? 'ok' : (a.short ? 'short' : 'fail')); if (!a.ok) break; }
    gl.getError = realErr; v.endCloudStream({ path: '/x/short.las' });
    const b2 = v.base[0]; r.short = { res, segs: b2._segs.length, gpuCount: b2._gpuCount, event: window.__gs, info: v.getCloudInfo().loadedCount };
    v.render(); r.shortFrameErr = v.gl.getError();
    v.clearCloud(); r.cleared = { base: v.base.length, stream: v.isStreamedCloud() };
    return r;
  });
  out.viewer = A;
  const W = A.whole, C = A.close, T = A.turn, N = 4000000, SEG = 500000;
  ok('А1 все 4 млн точек в видеопамяти (8 частей)', A.loaded.gpuCount === N && A.loaded.count === N && A.loaded.segs === 8 && A.loaded.info.sourceCount === N && A.loaded.info.loadedCount === N, A.loaded);
  ok('А2 выборка для процессора ≈ 500 тыс. и габариты верны', A.loaded.sample > 400000 && A.loaded.sample <= 500001 && Math.abs(A.loaded.bbox.mn[0] + 40) < 0.1 && Math.abs(A.loaded.bbox.mx[0] - 40) < 0.1, { sample: A.loaded.sample });
  ok('А3 весь вид, покой: нарисованы ВСЕ точки', W.idle && W.idle.drawn === N && W.idle.culled === 0, W.idle);
  ok('А4 весь вид, движение: «лишние» точки (>6 на пиксель) не рисуются', W.moving && W.moving.drawn < N * 0.5 && W.moving.drawn > 0, W.moving);
  ok('А5 вблизи, покой: невидимые кирпичи отсечены, видимые нарисованы целиком', C.idle && C.idle.culled > 0 && C.idle.drawn === C.idle.visible && C.idle.drawn + C.idle.culled === N, C.idle);
  ok('А6 вблизи, движение: ещё меньше или столько же, чем в покое', C.moving && C.moving.drawn <= C.idle.drawn && C.moving.culled > 0, C.moving);
  ok('А7 поворот камеры меняет набор кирпичей', T.idle && T.idle.culled !== C.idle.culled || (T.idle && T.idle.visible !== C.idle.visible), { turn: T.idle, close: C.idle });
  ok('А8 GPU-выбор возвращает верные точки из буфера видеопамяти', A.pick.ok >= 5 && A.pick.bad === 0, A.pick);
  const B = A.block;
  ok('А9 блокировки правки: нейтральные значения, без падений, сообщение пришло', B.selectBox === 0 && B.deleteSelection === 0 && B.cropToSelection === 0 && B.cleanAuto === 0 && B.cleanSOR === 0 && B.voxel === 0 && B.edited === null && B.undo === false && B.classify && B.classify.ok === false && Array.isArray(B.floor) && B.floor.length === 0 && B.events >= 1, B);
  ok('А10 интенсивность/классы грузятся лениво, ошибок GL нет', A.ibBefore === 0 && A.ibAfter === 8 && A.kbAfter === 8 && A.glErrIntensity === 0 && A.glErrClass === 0, { before: A.ibBefore, after: A.ibAfter, k: A.kbAfter });
  ok('А11 «не рисовать невидимое при движении» выключается и включается', A.smart.off > A.smart.on, A.smart);
  ok('А12 нехватка видеопамяти: поместившиеся части на экране + сообщение', A.short.segs === 2 && A.short.gpuCount === 2 * SEG && A.short.event && A.short.event.streamed === true && A.short.res.join() === 'ok,ok,short' && A.shortFrameErr === 0, A.short);
  ok('А13 clearCloud очищает всё', A.cleared.base === 0 && A.cleared.stream === false, A.cleared);

  // ---------- Б) app.js целиком (подмена IPC) ----------
  await page.evaluate(() => {
    const G = window.__gen; window.__labPath = 'C:\\scans\\huge.las';
    const toks = new Map(); window.__reads = []; window.__closed = 0; window.__releases = 0;
    window.__bimOverrides = window.__bimOverrides || {};
    window.__bimOverrides.cloudPartsOpen = (p, jobId) => ({ ok: true, token: 'tok1', total: G.N, segPoints: G.SEG, chunkPoints: G.CH, segments: G.N / G.SEG, bbox: { mn: [-40, 0, -4], mx: [40, 6, 4] }, meta: { kind: 'points', points: G.N, total: G.N, format: 'LAS fmt 3', colored: true }, hasColor: true, hasIntensity: false, hasClassification: false });
    window.__bimOverrides.cloudPartsRead = async (a) => {
      window.__reads.push(a.part); if (window.__slowMs) await new Promise((r) => setTimeout(r, window.__slowMs));
      if (window.__stopAt != null && a.part >= window.__stopAt) return { ok: false, cancelled: true, message: 'Импорт отменён' };
      const s = G.seg(a.part, false), token = 'chunk' + a.part; toks.set(token, s);
      return { ok: true, count: s.count, from: s.from, chunkPoints: s.chunkPoints, chunkBoxes: s.chunkBoxes, bbox: s.bbox, chunked: { token, count: s.count, chunkPoints: 500000, fields: { pos: { type: 'Float32Array', per: 3 }, col: { type: 'Uint8Array', per: 3 } } } };
    };
    window.__bimOverrides.readCloudChunk = (a) => { const s = toks.get(a.token); return { ok: true, pos: s.pos.slice(a.from * 3, (a.from + a.count) * 3), col: s.col.slice(a.from * 3, (a.from + a.count) * 3) }; };
    window.__bimOverrides.releaseCloud = (a) => { window.__releases++; toks.delete(a.token); return true; };
    window.__bimOverrides.cloudPartsClose = () => { window.__closed++; return true; };
    window.__bimCalls.length = 0; window.__stl = 0; window.__gs = null;
  });
  await page.setInputFiles('#modelInput', ROOM);
  await page.waitForFunction(() => { const v = window.__viewer || window.__lxViewer; return v && v.isStreamedCloud && v.isStreamedCloud() && v.base[0]._gpuCount === 4000000; }, null, { timeout: 600000 });
  await page.waitForFunction(() => !(window.__lxProgress && window.__lxProgress.active), null, { timeout: 300000 });   // карточка прогресса закрыта = чтение полностью завершено
  await page.waitForTimeout(500);
  const Bb = await page.evaluate(() => {
    const v = window.__viewer || window.__lxViewer, bo = v.base[0], calls = window.__bimCalls.slice();
    return { reads: window.__reads.slice(), closed: window.__closed, releases: window.__releases, parseCloud: calls.filter((c) => c === 'parseCloud').length, partsOpen: calls.filter((c) => c === 'cloudPartsOpen').length,
      gpu: bo._gpuCount, segs: bo._segs.length, info: { s: v.getCloudInfo().sourceCount, l: v.getCloudInfo().loadedCount }, modal: !!document.querySelector('.lx-modal.open,.modal.open'), panelActive: !!(window.__lxProgress && window.__lxProgress.active) };
  });
  out.app = Bb;
  ok('Б1 приложение читает файл частями: 8 частей, parseCloud не вызывался, все точки в видеопамяти', Bb.partsOpen === 1 && Bb.parseCloud === 0 && Bb.reads.join() === '0,1,2,3,4,5,6,7' && Bb.gpu === N && Bb.info.s === N && Bb.info.l === N, Bb);
  ok('Б2 сессия закрыта, куски освобождены, карточка прогресса закрыта, диалога про память нет', Bb.closed >= 1 && Bb.releases === 8 && !Bb.modal && !Bb.panelActive, { closed: Bb.closed, rel: Bb.releases, modal: Bb.modal });
  // отмена из карточки прогресса на 3-й части
  await page.evaluate(() => { window.__reads.length = 0; window.__closed = 0; window.__slowMs = 700; window.__bimCalls.length = 0; });
  await page.setInputFiles('#modelInput', ROOM);
  await page.waitForFunction(() => window.__reads.length >= 2, null, { timeout: 120000 });
  await page.evaluate(() => { const a = window.__lxProgress && window.__lxProgress.active; if (a) a.stop.cancel(); });
  await page.waitForTimeout(4000);
  const Cc = await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; return { closed: window.__closed, reads: window.__reads.slice(), streamed: v.isStreamedCloud(), base: v.base.length, bo: v.base[0] ? v.base[0]._gpuCount : 0, parseCloud: window.__bimCalls.filter((c) => c === 'parseCloud').length }; });
  out.cancel = Cc;
  ok('Б3 отмена: сессия закрыта, чтение остановлено, облако убрано, прежний путь не запускался', Cc.closed >= 1 && Cc.reads.length < 8 && !Cc.streamed && Cc.base === 0 && Cc.parseCloud === 0, Cc);

  console.log(JSON.stringify(out, null, 1).slice(0, 6000));
  let bad = 0; for (const c of checks) { console.log((c.ok ? 'OK   ' : 'FAIL ') + c.name + (c.ok ? '' : ' ' + JSON.stringify(c.info))); if (!c.ok) bad++; }
  console.log('ошибки консоли:', errs.length, errs.slice(0, 5).join(' | '));
  await browser.close();
  process.exit(bad || errs.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
