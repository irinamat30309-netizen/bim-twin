// Ревизия 17 (не часть продукта): большое облако (читается частями, >48 млн точек) со ВСЕМИ функциями. Проверка в Chromium на синтетической комнате
// ~1,2 млн точек в 4 сегментах (части и кирпичи те же, что у настоящего файла, только меньше): выделение (все режимы), правка и откат, чистка, прореживание,
// классы, экспорт; независимая проверка по генератору (контрольные суммы), без падений и ошибок консоли.
//   sh /data/ui-lab/run.sh dev/ui-lab/big-lab.js [часть]    (части: sel edit clean cls exp app; без аргумента — все)
const { launch } = require('./lab');
const path = require('path');
const ROOM = path.join(__dirname, 'room.ply');
const WANT = process.argv.slice(2);
const want = (k) => !WANT.length || WANT.includes(k);
(async () => {
  const { browser, page, errs } = await launch({ w: 1000, h: 640, theme: 'dark', wait: 2000 });
  page.setDefaultTimeout(1800000);
  await page.evaluate(() => {
    const N = 1200000, SEG = 300000, CH = 30000;
    const hash = (i, k) => { let h = (Math.imul(i + 1, 2654435761) ^ Math.imul(k + 7, 40503)) >>> 0; h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
    const G = window.__G = { N, SEG, CH, hash };
    // комната 20×3×10 м: пол, две стены, потолок, предмет (куб ~1 м) и редкий «мусор» в воздухе; цвет — по положению; интенсивность — случайная
    G.pt = (i) => {
      const u = hash(i, 0), a = hash(i, 1), b = hash(i, 2), c = (hash(i, 3) - 0.5) * 0.004;
      let x, y, z, cat;
      if (u < 0.38) { x = 20 * a; z = 10 * b; y = c; cat = 1; }
      else if (u < 0.52) { x = 20 * a; y = 3 * b; z = c; cat = 2; }
      else if (u < 0.66) { x = c; y = 3 * a; z = 10 * b; cat = 3; }
      else if (u < 0.76) { x = 20 * a; z = 10 * b; y = 3 + c; cat = 4; }
      else if (u < 0.985) { x = 9.5 + a; y = 1.2 * b; z = 4.5 + hash(i, 3); cat = 5; }
      else { x = 20 * a; y = 3 * b; z = 10 * hash(i, 3); cat = 6; }
      return [Math.fround(x), Math.fround(y), Math.fround(z), cat];
    };
    G.seg = (k, withAttr) => {
      const from = k * SEG, n = Math.min(SEG, N - from), pos = new Float32Array(n * 3), col = new Uint8Array(n * 3);
      const inten = withAttr ? new Uint16Array(n) : null, cls = withAttr ? new Uint8Array(n) : null;
      for (let j = 0; j < n; j++) {
        const p = G.pt(from + j); pos[j * 3] = p[0]; pos[j * 3 + 1] = p[1]; pos[j * 3 + 2] = p[2];
        col[j * 3] = Math.min(255, Math.floor(p[0] * 12)); col[j * 3 + 1] = Math.min(255, 40 + Math.floor(p[1] * 50)); col[j * 3 + 2] = Math.min(255, Math.floor(p[2] * 24));
        if (inten) { inten[j] = Math.floor(hash(from + j, 9) * 65535); cls[j] = 0; }
      }
      const nc = Math.ceil(n / CH), B = new Float32Array(nc * 6);
      for (let c = 0; c < nc; c++) { const a = [1e30, 1e30, 1e30], b = [-1e30, -1e30, -1e30]; for (let j = c * CH; j < Math.min(n, (c + 1) * CH); j++) for (let t = 0; t < 3; t++) { const v = pos[j * 3 + t]; if (v < a[t]) a[t] = v; if (v > b[t]) b[t] = v; } for (let t = 0; t < 3; t++) { B[c * 6 + t] = a[t]; B[c * 6 + 3 + t] = b[t]; } }
      return { ok: true, pos, col, intensity: inten, classification: null, count: n, chunkPoints: CH, chunkBoxes: B, from, bbox: { mn: [0, -0.01, 0], mx: [20, 3.01, 10] } };
    };
    // загрузка в просмотрщик так же, как это делает app.js (части по очереди)
    G.load = (v, name, n) => {
      v.beginCloudStream({ total: N, bbox: { mn: [0, -0.01, 0], mx: [20, 3.01, 10] }, meta: { format: 'las', total: N, colored: true, hasIntensity: true }, hasIntensity: true, hasClassification: false, name }, { sourceName: '/x/' + name, sampleTarget: 300000 });
      for (let k = 0; k < N / SEG; k++) { const r = v.addCloudStreamSegment(G.seg(k, true)); if (!r.ok) throw new Error('segment ' + k); }
      v.endCloudStream({ path: '/x/' + name, name });
      v.target = [10, 1.5, 5]; v.dist = 24; v.yaw = 0.6; v.pitch = 0.5; v.render();
    };
    // контрольная сумма набора точек (не зависит от порядка): число точек и сумма хешей координат + цвета
    G.sumOf = (v) => {
      const bo = v.base[0]; let n = 0, s1 = 0, s2 = 0;
      for (const sg of bo._segs) for (let i = 0; i < sg.n; i++) { const x = sg.P[i * 3], y = sg.P[i * 3 + 1], z = sg.P[i * 3 + 2]; n++; s1 += x * 1.1 + y * 2.3 + z * 3.7; if (sg.C) s2 += sg.C[i * 3] * 3 + sg.C[i * 3 + 1] * 5 + sg.C[i * 3 + 2] * 7; }
      return { n, s1: Math.round(s1 * 1000) / 1000, s2 };
    };
    // побайтовая подпись сегментов (порядок учитывается)
    G.sig = (v) => {
      const bo = v.base[0]; let h = 2166136261 >>> 0, n = 0;
      for (const sg of bo._segs) { const u = new Uint32Array(sg.P.buffer, sg.P.byteOffset, sg.n * 3); for (let i = 0; i < u.length; i++) h = (Math.imul(h ^ u[i], 16777619) >>> 0); n += sg.n; if (sg.C) for (let i = 0; i < sg.n * 3; i++) h = (Math.imul(h ^ sg.C[i], 16777619) >>> 0); if (sg.I) for (let i = 0; i < sg.n; i++) h = (Math.imul(h ^ sg.I[i], 16777619) >>> 0); if (sg.K) for (let i = 0; i < sg.n; i++) h = (Math.imul(h ^ sg.K[i], 16777619) >>> 0); }
      return n + ':' + h;
    };
    G.expect = (pred) => { let n = 0, s1 = 0; for (let i = 0; i < N; i++) { const p = G.pt(i); if (pred(p)) { n++; s1 += p[0] * 1.1 + p[1] * 2.3 + p[2] * 3.7; } } return { n, s1: Math.round(s1 * 1000) / 1000 }; };
    window.__notices = []; window.addEventListener('bim-big-notice', (e) => window.__notices.push(e.detail.message)); window.__stl = 0; window.addEventListener('bim-stream-limit', () => { window.__stl++; });
  });
  const out = {}, checks = [];
  const T0 = Date.now(), log = (m) => console.log('# ' + Math.round((Date.now() - T0) / 1000) + ' c: ' + m);
  const ok = (name, cond, info) => checks.push({ name, ok: !!cond, info: info === undefined ? undefined : info });
  const close = (a, b, eps) => Math.abs(a - b) <= (eps || 0.01);

  // ---------- A) выделение простыми инструментами, удаление/обрезка/откат ----------
  if (want('sel') || want('edit')) {
    const A = await page.evaluate(async () => {
      const v = window.__viewer || window.__lxViewer, G = window.__G, r = {};
      G.load(v, 'room.las');
      r.loaded = { big: v.isBigCloud(), segs: v.base[0]._segs.length, cpu: v.base[0]._stream.cpu, hasP: v.base[0]._segs.every((s) => s.P && s.P.length >= s.n * 3), info: v.bigInfo(), sig0: G.sig(v), sum0: G.sumOf(v) };
      // selectBox
      const bx = { mn: [8, 0, 3], mx: [12, 2, 7] };
      r.box = { got: await v.selectBox(bx.mn, bx.mx), want: G.expect((p) => p[0] >= 8 && p[0] <= 12 && p[1] >= 0 && p[1] <= 2 && p[2] >= 3 && p[2] <= 7) };
      // selectSphere
      r.sph = { got: await v.selectSphere([10, 1, 5], 1.5), want: G.expect((p) => { const dx = p[0] - 10, dy = p[1] - 1, dz = p[2] - 5; return dx * dx + dy * dy + dz * dz <= 2.25; }) };
      // инверсия и очистка
      const n0 = v.selectionCount(); v.invertSelection(); r.inv = { before: n0, after: v.selectionCount(), total: G.N }; v.clearSelection(); r.cleared = v.selectionCount();
      // удаление выделенного бокса: контрольная сумма оставшихся, затем откат — побайтово
      await v.selectBox(bx.mn, bx.mx); const del = v.selectionCount(); v.setPlaneProtect(false); v.setHoleFill(false);
      const t0 = performance.now(); r.removed = await v.deleteSelection(); r.delMs = Math.round(performance.now() - t0);
      r.afterDel = { sum: G.sumOf(v), sel: v.selectionCount(), want: G.expect((p) => !(p[0] >= 8 && p[0] <= 12 && p[1] >= 0 && p[1] <= 2 && p[2] >= 3 && p[2] <= 7)), del, count: v.base[0].count, gpu: v.base[0]._gpuCount, canUndo: v.canUndo() };
      r.undo1 = v.undoEdit(); r.afterUndo = { sig: G.sig(v), count: v.base[0].count, gpu: v.base[0]._gpuCount, canUndo: v.canUndo() };
      // обрезка (оставить только выделенное) и откат
      await v.selectBox(bx.mn, bx.mx); r.cropped = await v.cropToSelection();
      r.afterCrop = { sum: G.sumOf(v), want: G.expect((p) => p[0] >= 8 && p[0] <= 12 && p[1] >= 0 && p[1] <= 2 && p[2] >= 3 && p[2] <= 7) };
      r.undo2 = v.undoEdit(); r.afterUndo2 = { sig: G.sig(v) };
      // принудительное удаление (без защиты)
      await v.selectSphere([10, 0.5, 5], 0.8); const sel2 = v.selectionCount(); r.force = await v.deleteSelectionForce(); r.forceSel = sel2;
      r.undo3 = v.undoEdit(); r.afterUndo3 = { sig: G.sig(v) };
      r.noUndo = v.undoEdit();
      r.blockEvents = window.__stl; r.notices = window.__notices.slice();
      r.gl = v.gl.getError();
      return r;
    });
    out.A = A;
    const L = A.loaded;
    ok('А1 облако «большое»: копии частей в памяти, все точки, bigInfo', L.big && L.cpu === true && L.segs === 4 && L.hasP && L.info.count === 1200000 && L.sum0.n === 1200000 && L.info.hasColor && L.info.hasIntensity, L);
    ok('А2 selectBox: число выделенных = контрольный подсчёт по генератору', A.box.got === A.box.want.n && A.box.got > 1000, A.box);
    ok('А3 selectSphere: число выделенных = контрольный подсчёт', A.sph.got === A.sph.want.n && A.sph.got > 1000, A.sph);
    ok('А4 инверсия: всё остальное; очистка → 0', A.inv.after === A.inv.total - A.inv.before && A.cleared === 0, A.inv);
    ok('А5 удаление: удалено ровно выделенное, остальные точки — контрольная сумма сходится', A.removed === A.afterDel.del && A.afterDel.sum.n === A.afterDel.want.n && close(A.afterDel.sum.s1, A.afterDel.want.s1, 0.5) && A.afterDel.count === A.afterDel.sum.n && A.afterDel.gpu === A.afterDel.sum.n && A.afterDel.sel === 0 && A.afterDel.canUndo, A.afterDel);
    ok('А6 откат удаления: все точки на своих местах (побайтно, как были)', A.undo1 === true && A.afterUndo.sig === L.sig0 && A.afterUndo.count === 1200000 && A.afterUndo.gpu === 1200000, { sig0: L.sig0, after: A.afterUndo });
    ok('А7 обрезка оставляет только выделенное; откат возвращает всё побайтно', A.cropped === 1200000 - A.afterCrop.want.n && A.afterCrop.sum.n === A.afterCrop.want.n && close(A.afterCrop.sum.s1, A.afterCrop.want.s1, 0.5) && A.undo2 === true && A.afterUndo2.sig === L.sig0, { cropped: A.cropped, crop: A.afterCrop, sig: A.afterUndo2.sig });
    ok('А8 принудительное удаление и откат', A.force === A.forceSel && A.force > 100 && A.undo3 === true && A.afterUndo3.sig === L.sig0, { force: A.force, sel: A.forceSel });
    ok('А9 пустой откат → false; блокировок r16 нет; ошибок GL нет', A.noUndo === false && A.blockEvents === 0 && A.gl === 0, { ev: A.blockEvents, gl: A.gl, notices: A.notices });
    console.log('удаление бокса, мс:', A.delMs);
  }

  // ---------- B) выделение по экрану: рамка, лассо, кисть, цвет, палочка, объект, срез ----------
  if (want('scr')) {
    const S = await page.evaluate(async () => {
      const v = window.__viewer || window.__lxViewer, G = window.__G, r = {}, fr = Math.fround;
      G.load(v, 'room.las'); v.setPlaneProtect(false); v.setHoleFill(false); v._renderNow && v._renderNow();
      const rect = v.canvas.getBoundingClientRect(), M = Float64Array.from(v._lastVP || v._vp());
      const proj = (p) => { const cw = M[3] * p[0] + M[7] * p[1] + M[11] * p[2] + M[15]; if (cw <= 0) return null; return [fr((M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12]) / cw), fr((M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13]) / cw), fr(cw)]; };
      const ndc = (cx, cy) => [(cx - rect.left) / rect.width * 2 - 1, 1 - (cy - rect.top) / rect.height * 2];
      const brute = (test) => { let n = 0; for (let i = 0; i < G.N; i++) { const q = proj(G.pt(i)); if (q && test(q, i)) n++; } return n; };
      const rc = (a, b, c, d) => ({ x0: rect.left + rect.width * a, y0: rect.top + rect.height * b, x1: rect.left + rect.width * c, y1: rect.top + rect.height * d });
      const rectTest = (R) => { const a = ndc(R.x0, R.y0), b = ndc(R.x1, R.y1), xl = Math.min(a[0], b[0]), xh = Math.max(a[0], b[0]), yl = Math.min(a[1], b[1]), yh = Math.max(a[1], b[1]); return (q) => q[0] >= xl && q[0] <= xh && q[1] >= yl && q[1] <= yh; };
      const idxIn = (test) => { const bad = []; for (const g of v._sel) { const q = proj(G.pt(g)); if (!q || !test(q)) bad.push(g); if (bad.length > 3) break; } return bad.length; };
      const A = rc(0.30, 0.25, 0.62, 0.7), B = rc(0.5, 0.4, 0.8, 0.85);
      // насквозь: ровно всё, что попало в рамку
      v.setSelectDepthMode(2); const tA = rectTest(A);
      r.through = { got: await v.selectRegion(A.x0, A.y0, A.x1, A.y1), want: brute(tA) };
      // видимое (режимы 0/1): подмножество, не больше «насквозь», все внутри рамки
      v.setSelectDepthMode(0); v.clearSelection(); const m0 = await v.selectRegion(A.x0, A.y0, A.x1, A.y1); r.mode0 = { n: m0, outside: idxIn(tA) };
      v.setSelectDepthMode(1); v.clearSelection(); const m1 = await v.selectRegion(A.x0, A.y0, A.x1, A.y1); r.mode1 = { n: m1, outside: idxIn(tA) };
      // сложение/вычитание
      v.setSelectDepthMode(2); v.clearSelection(); await v.selectRegion(A.x0, A.y0, A.x1, A.y1);
      v._selStart = [B.x0, B.y0]; v._selCur = [B.x1, B.y1]; await v._finishMarquee(true, false);
      const tB = rectTest(B); r.union = { got: v.selectionCount(), want: brute((q) => tA(q) || tB(q)) };
      v._selStart = [B.x0, B.y0]; v._selCur = [B.x1, B.y1]; await v._finishMarquee(false, true);
      r.subtract = { got: v.selectionCount(), want: brute((q) => tA(q) && !tB(q)) };
      // лассо (треугольник)
      v.clearSelection(); const tri = [[rect.left + rect.width * 0.3, rect.top + rect.height * 0.3], [rect.left + rect.width * 0.7, rect.top + rect.height * 0.35], [rect.left + rect.width * 0.45, rect.top + rect.height * 0.8]];
      const polyN = tri.map((p) => ndc(p[0], p[1]));
      const inPoly = (x, y) => { let inside = false; for (let a = 0, b = polyN.length - 1; a < polyN.length; b = a++) { const yi = polyN[a][1], yj = polyN[b][1]; if ((yi > y) !== (yj > y)) { const xi = polyN[a][0], xj = polyN[b][0]; if (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-20) + xi) inside = !inside; } } return inside; };
      v._lasso = tri; await v._finishLasso(false, false); v._lasso = null;
      r.lasso = { got: v.selectionCount(), want: brute((q) => inPoly(q[0], q[1])) };
      // кисть: передний слой под курсором, подсветка растёт
      v.setSelectDepthMode(0); v.clearSelection(); v._brushRadius = 18; v._buildBrushGrid();
      const cx = rect.left + rect.width * 0.5, cy = rect.top + rect.height * 0.55; r.brushGrid = !!v._brushGrid;
      v._brushAt(cx, cy, false); v._brushAt(cx + 12, cy + 4, false); r.brush = { n: v.selectionCount(), hl: v._bigHL ? v._bigHL.length / 3 : 0 };
      let far = 0; const rr = 18 + 12 + 5; for (const g of v._sel) { const q = proj(G.pt(g)); if (!q) { far++; continue; } const sx = rect.left + (q[0] * 0.5 + 0.5) * rect.width, sy = rect.top + (1 - (q[1] * 0.5 + 0.5)) * rect.height; if (Math.hypot(sx - cx, sy - cy) > rr + 12) far++; }
      r.brush.far = far; const n0 = v.selectionCount(); v._brushAt(cx, cy, true); r.brush.afterSub = v.selectionCount(); r.brush.before = n0;
      // выбор по цвету под курсором
      v.clearSelection(); const seed = v._bigPickIndex(cx, cy); r.seed = seed;
      const colOf = (i) => { const p = G.pt(i); return [Math.min(255, Math.floor(p[0] * 12)), Math.min(255, 40 + Math.floor(p[1] * 50)), Math.min(255, Math.floor(p[2] * 24))]; };
      const sc = colOf(seed), tol = 25; let wantC = 0; for (let i = 0; i < G.N; i++) { const c = colOf(i); const d0 = c[0] - sc[0], d1 = c[1] - sc[1], d2 = c[2] - sc[2]; if (d0 * d0 + d1 * d1 + d2 * d2 <= tol * tol) wantC++; }
      r.color = { got: await v.selectColorAt(cx, cy, tol), want: wantC };
      // палочка и «умный объект»
      v.clearSelection(); r.wand = { n: await v.magicWandAt(cx, cy) };
      v.clearSelection(); r.smart = { n: await v.smartObjectAt(cx, cy, { maxPts: 400000 }) };
      // выделение → отдельный объект
      v.clearSelection(); await v.selectBox([9.6, 0.1, 4.6], [10.2, 0.8, 5.2]); const sn = v.selectionCount(); const ob = v.extractSelectionAsObject('Тест'); r.extract = { sel: sn, count: ob && ob.count, objs: (v._objects || []).length };
      // срез: секущий бокс и «выделить всё в срезе»
      v.clearSelection(); v.setSection(true); v.setSectionBox({ xmin: 0.4, xmax: 0.6, ymin: 0, ymax: 1, zmin: 0.3, zmax: 0.7 }); const cb = v._clipBounds();
      r.slice = { got: await v.selectInSlice(), want: G.expect((p) => p[0] >= cb.mn[0] && p[0] <= cb.mx[0] && p[1] >= cb.mn[1] && p[1] <= cb.mx[1] && p[2] >= cb.mn[2] && p[2] <= cb.mx[2]).n };
      // шар внутри среза не выходит за бокс
      v.clearSelection(); r.sliceSphere = { got: await v.selectSphere([10, 1, 5], 3), want: G.expect((p) => { const dx = p[0] - 10, dy = p[1] - 1, dz = p[2] - 5; return dx * dx + dy * dy + dz * dz <= 9 && p[0] >= cb.mn[0] && p[0] <= cb.mx[0] && p[1] >= cb.mn[1] && p[1] <= cb.mx[1] && p[2] >= cb.mn[2] && p[2] <= cb.mx[2]; }).n };
      v.setSection(false); v.clearSelection();
      r.events = window.__stl; r.notices = window.__notices.slice(); r.gl = v.gl.getError();
      return r;
    });
    out.S = S;
    ok('Б1 рамка «насквозь»: выделено ровно то, что попало в рамку (контроль по генератору)', S.through.got === S.through.want && S.through.got > 5000, S.through);
    ok('Б2 рамка (режимы 0 и 1): только видимое — заметно меньше, чем «насквозь», все внутри рамки', S.mode0.n > 0 && S.mode0.n < S.through.got * 0.5 && S.mode1.n >= S.mode0.n && S.mode1.n < S.through.got * 0.9 && S.mode0.n <= S.through.got && S.mode0.outside === 0 && S.mode1.n > 0 && S.mode1.n <= S.through.got && S.mode1.outside === 0, { m0: S.mode0, m1: S.mode1, thr: S.through.got });
    ok('Б3 сложение и вычитание рамок', S.union.got === S.union.want && S.subtract.got === S.subtract.want, { u: S.union, s: S.subtract });
    ok('Б4 лассо: точно по контуру', S.lasso.got === S.lasso.want && S.lasso.got > 3000, S.lasso);
    ok('Б5 кисть: передний слой под курсором, подсветка растёт, вычитание работает', S.brushGrid && S.brush.n > 0 && S.brush.hl > 0 && S.brush.far === 0 && S.brush.afterSub < S.brush.before, S.brush);
    ok('Б6 выбор по цвету: все такого цвета во всём облаке', S.seed >= 0 && S.color.got === S.color.want && S.color.got > 0, { seed: S.seed, c: S.color });
    ok('Б7 палочка и умный объект выделяют область', S.wand.n > 0 && S.smart.n > 0, { w: S.wand, s: S.smart });
    ok('Б8 выделение → отдельный объект (все точки)', S.extract.count === S.extract.sel && S.extract.sel > 100 && S.extract.objs >= 1, S.extract);
    ok('Б9 срез: «выделить всё в срезе» и шар не выходят за секущий бокс', S.slice.got === S.slice.want && S.slice.got > 1000 && S.sliceSphere.got === S.sliceSphere.want, { s: S.slice, sph: S.sliceSphere });
    ok('Б10 блокировок r16 и ошибок GL нет', S.events === 0 && S.gl === 0, { ev: S.events, gl: S.gl, notices: S.notices });
  }

  // ---------- В) чистка и прореживание: те же результаты, что у плоских алгоритмов PCEdit на тех же точках; откат побайтно ----------
  if (want('clean')) {
    const C = await page.evaluate(async () => {
      const v = window.__viewer || window.__lxViewer, G = window.__G, PE = window.PCEdit, r = { ops: [] };
      G.load(v, 'room.las'); v.setPlaneProtect(false); v.setHoleFill(false);
      const sp = v.base[0]._spacing, sig0 = G.sig(v); r.sp = sp;
      const flat = (pred) => { const segs = v.base[0]._segs; let n = 0; for (const s of segs) n += s.n; const pos = new Float32Array(n * 3), col = new Uint8Array(n * 3); let k = 0; for (const s of segs) for (let i = 0; i < s.n; i++) { const x = s.P[i * 3], y = s.P[i * 3 + 1], z = s.P[i * 3 + 2]; if (pred && !pred(x, y, z)) continue; pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z; col[k * 3] = s.C[i * 3]; col[k * 3 + 1] = s.C[i * 3 + 1]; col[k * 3 + 2] = s.C[i * 3 + 2]; k++; } return { pos: pos.subarray(0, k * 3), col: col.subarray(0, k * 3), n: k }; };
      const op = async (name, run, ref) => {
        const f = flat(), t0 = performance.now(); const want = ref(f); const refMs = Math.round(performance.now() - t0);
        const t1 = performance.now(); const got = await run(); const ms = Math.round(performance.now() - t1);
        const gotN = (got && typeof got === 'object') ? got.removed : got, cnt = v.bigInfo().count, sum = G.sumOf(v);
        const undo = v.undoEdit(), back = G.sig(v) === sig0;
        r.ops.push({ name, got: gotN, want: (want && typeof want === 'object') ? want.removed : want, after: cnt, sumN: sum.n, undo, back, ms, refMs, extra: (got && typeof got === 'object') ? got : null, wantExtra: (want && typeof want === 'object') ? want : null });
      };
      await op('density', () => v.cleanInApp({}), (f) => PE.cleanVoxelDensity(f, { voxel: sp * 3 }).removed);
      await op('clusters', () => v.cleanClustersInApp({}), (f) => PE.cleanClusters(f, { voxel: sp * 4 }).removed);
      await op('radius', () => v.cleanRadiusInApp({}), (f) => PE.cleanRadiusOutliers(f, { radius: sp * 5 }).removed);
      await op('sor', () => v.cleanSORInApp({}), (f) => PE.cleanStatisticalOutliers(f, { voxel: sp * 3 }).removed);
      await op('noise', () => v.noiseFilterInApp({}), (f) => PE.noiseFilterLocalPlane(f, { voxel: sp * 2 }).removed);
      await op('slice', () => v.sliceKeepInApp({ axis: 1, at: 1.5, thickness: 0.5 }), (f) => PE.sliceSection(f, { axis: 1, at: 1.5, thickness: 0.5 }).removed);
      await op('islands', () => v.cleanIslandsInApp({}), (f) => { const n = f.n, r1 = PE.cleanClusters(f, { voxel: sp * 2, minClusterPts: Math.max(120, Math.round(n * 0.0003)) }); const rr = PE.cleanRadiusOutliers({ pos: r1.pos, col: r1.col }, { radius: sp * 3, minNeighbors: 1 }); return r1.removed + ((rr.removed && rr.removed <= n * 0.03) ? rr.removed : 0); });
      await op('auto', () => v.cleanAutoInApp({ maxPasses: 3 }), (f) => { const a = PE.cleanAuto(f, { voxel: sp * 3, maxPasses: 3 }); return { removed: a.removed, passes: a.passes, breakdown: a.breakdown }; });
      await op('downsample', () => v.voxelDownsampleInApp({}), (f) => { const a = PE.voxelDownsample(f, { voxel: sp * 2 }); return f.n - a.pos.length / 3; });
      // внутри секущего бокса: чистится только то, что внутри; снаружи всё на месте
      v.setSection(true); v.setSectionBox({ xmin: 0.2, xmax: 0.8, ymin: 0, ymax: 1, zmin: 0.2, zmax: 0.8 }); const cb = v._clipBounds(), inside = (x, y, z) => x >= cb.mn[0] && x <= cb.mx[0] && y >= cb.mn[1] && y <= cb.mx[1] && z >= cb.mn[2] && z <= cb.mx[2];
      const outBefore = (() => { let n = 0, s = 0; for (const sg of v.base[0]._segs) for (let i = 0; i < sg.n; i++) { const x = sg.P[i * 3], y = sg.P[i * 3 + 1], z = sg.P[i * 3 + 2]; if (!inside(x, y, z)) { n++; s += x + y * 2 + z * 3; } } return { n, s: Math.round(s * 100) / 100 }; })();
      const fIn = flat(inside), wantIn = PE.cleanVoxelDensity(fIn, { voxel: sp * 3 }).removed;
      const gotIn = await v.cleanInApp({});
      const outAfter = (() => { let n = 0, s = 0; for (const sg of v.base[0]._segs) for (let i = 0; i < sg.n; i++) { const x = sg.P[i * 3], y = sg.P[i * 3 + 1], z = sg.P[i * 3 + 2]; if (!inside(x, y, z)) { n++; s += x + y * 2 + z * 3; } } return { n, s: Math.round(s * 100) / 100 }; })();
      r.clip = { got: gotIn, want: wantIn, outBefore, outAfter, undo: v.undoEdit(), back: G.sig(v) === sig0 };
      // прореживание внутри бокса
      const fIn2 = flat(inside), wantDs = fIn2.n - PE.voxelDownsample(fIn2, { voxel: sp * 2 }).pos.length / 3; const n1 = v.bigInfo().count;
      const gotDs = await v.voxelDownsampleInApp({}); const n2 = v.bigInfo().count;
      r.clipDs = { got: gotDs, want: wantDs, drop: n1 - n2, segs: v.base[0]._segs.length, undo: v.undoEdit(), back: G.sig(v) === sig0, segsAfter: v.base[0]._segs.length };
      v.setSection(false);
      // отмена посреди операции: облако не изменено
      let cancelled = null; const p = v.cleanSORInApp({}); setTimeout(() => { window.dispatchEvent(new CustomEvent('lx-progress-cancel')); }, 150); const rr = await p; r.cancel = { ret: rr, back: G.sig(v) === sig0, busy: v._bigBusy, notices: window.__notices.slice(-2) };
      r.events = window.__stl; r.gl = v.gl.getError();
      return r;
    });
    out.C = C;
    for (const o of C.ops) {
      const w = o.want;
      const same = (o.name === 'auto') ? (o.got === w && o.extra && o.wantExtra && o.extra.passes === o.wantExtra.passes && JSON.stringify(o.extra.breakdown) === JSON.stringify(o.wantExtra.breakdown)) : (o.got === w);
      ok('В ' + o.name + ': удалено ' + o.got + ' (плоский алгоритм: ' + w + '), точек осталось ' + o.after + ', откат побайтно, ' + o.ms + ' мс', same && o.got > 0 && o.after === o.sumN && (o.name === 'downsample' ? true : o.after === 1200000 - o.got) && o.undo === true && o.back === true, o);
    }
    ok('В clip: чистка только внутри бокса = плоскому результату, снаружи ни одной точки не тронуто, откат побайтно', C.clip.got === C.clip.want && C.clip.got > 0 && C.clip.outBefore.n === C.clip.outAfter.n && C.clip.outBefore.s === C.clip.outAfter.s && C.clip.undo && C.clip.back, C.clip);
    ok('В clip: прореживание внутри бокса = плоскому результату, откат побайтно (сегменты возвращены)', C.clipDs.got === C.clipDs.want && C.clipDs.got > 0 && C.clipDs.drop === C.clipDs.got && C.clipDs.undo && C.clipDs.back && C.clipDs.segsAfter === 4, C.clipDs);
    ok('В отмена: облако не изменено, операция свободна, сообщение об отмене', C.cancel.ret === 0 && C.cancel.back && C.cancel.busy === false && C.cancel.notices.some((m) => /отменен/.test(m)), C.cancel);
    ok('В блокировок r16 и ошибок GL нет', C.events === 0 && C.gl === 0, { ev: C.events, gl: C.gl });
  }

  // ---------- Г) классификация ----------
  if (want('cls')) {
    const K = await page.evaluate(async () => {
      const v = window.__viewer || window.__lxViewer, G = window.__G, PE = window.PCEdit, r = {};
      G.load(v, 'room.las'); v.setPlaneProtect(false); v.setHoleFill(false);
      const sig0 = G.sig(v); const segs = v.base[0]._segs;
      r.planes = v.detectFloorWalls().length;
      const flatPos = (() => { let n = 0; for (const s of segs) n += s.n; const pos = new Float32Array(n * 3); let k = 0; for (const s of segs) { pos.set(s.P.subarray(0, s.n * 3), k * 3); k += s.n; } return pos; })();
      const want = PE.classifyStructure({ pos: flatPos }, {});
      const counts = await v.classifyInApp({});
      r.counts = counts; r.want = want.counts; r.has = { info: v.bigInfo().hasClassification, labels: !!v.getClassificationLabels(), len: v.getClassificationLabels() && v.getClassificationLabels().length };
      const lab = v.getClassificationLabels(); let eq = lab.length === want.labels.length; for (let i = 0; eq && i < lab.length; i++) if (lab[i] !== want.labels[i]) eq = false; r.labelsEqual = eq;
      v.setColorMode('classification'); v.render(); v._renderNow(); r.kb = segs.filter((s) => s.kb).length; r.glCls = v.gl.getError();
      r.record = { hasClassification: v.getCloudInfo().hasClassification };
      // выделить класс «пол»
      const selN = (await v.classifyInApp({ selectClass: 1 })) && v.selectionCount(); r.selFloor = { sel: selN, floor: counts.floor };
      // назначить класс выделенному боксу, откат
      v.clearSelection(); await v.selectBox([8, 0, 3], [12, 2, 7]); const sn = v.selectionCount(); const labBefore = v.getClassificationLabels();
      r.assign = v.assignClassificationInApp(6); const labA = v.getClassificationLabels(); let n6 = 0; for (let i = 0; i < labA.length; i++) if (labA[i] === 6) n6++;
      r.assign.sel = sn; r.assign.n6 = n6; r.assign.again = v.assignClassificationInApp(6);
      r.assign.undo = v.undoEdit(); const labU = v.getClassificationLabels(); let same = true; for (let i = 0; i < labU.length; i++) if (labU[i] !== labBefore[i]) { same = false; break; } r.assign.restored = same;
      // удаление выделенного в размеченном облаке: метки остаются у своих точек, откат возвращает
      v.clearSelection(); await v.selectBox([8, 0, 3], [12, 2, 7]); const hist0 = v.getClassificationLabels().reduce((a, c) => { a[c] = (a[c] || 0) + 1; return a; }, {});
      const del = await v.deleteSelection(); const labD = v.getClassificationLabels();
      r.del = { removed: del, labels: labD.length, count: v.bigInfo().count, hist: labD.reduce((a, c) => { a[c] = (a[c] || 0) + 1; return a; }, {}), hist0 };
      r.del.undo = v.undoEdit(); const labR = v.getClassificationLabels(); let same2 = labR.length === labBefore.length; for (let i = 0; same2 && i < labR.length; i++) if (labR[i] !== labBefore[i]) same2 = false; r.del.restored = same2;
      // сброс меток
      r.clear = { ret: v.clearClassificationLabels(), labels: v.getClassificationLabels(), has: v.bigInfo().hasClassification, mode: v.getColorMode && v.getColorMode() };
      // назначение без разметки (метки появляются у выбранных точек), откат убирает атрибут
      v.clearSelection(); await v.selectBox([8, 0, 3], [12, 2, 7]); const a2 = v.assignClassificationInApp(2); r.fresh = { ok: a2.ok, changed: a2.changed, has: v.bigInfo().hasClassification };
      r.fresh.undo = v.undoEdit(); r.fresh.hasAfter = v.bigInfo().hasClassification; r.fresh.back = G.sig(v) === sig0;
      r.events = window.__stl; r.gl = v.gl.getError();
      return r;
    });
    out.K = K;
    ok('Г1 пол и стены найдены', K.planes >= 3, K.planes);
    ok('Г2 разметка конструктива: те же метки, что у плоского алгоритма, для ВСЕХ точек', K.labelsEqual && K.has.len === 1200000 && K.counts.floor === K.want.floor && K.counts.wall === K.want.wall && K.counts.ceiling === K.want.ceiling && K.counts.floor > 100000, { c: K.counts, w: K.want, has: K.has });
    ok('Г3 цвет «по классам» рисуется без ошибок GL, запись облака знает про классы', K.kb === 4 && K.glCls === 0 && K.record.hasClassification, { kb: K.kb, gl: K.glCls });
    ok('Г4 «выделить класс»: выделен весь пол', K.selFloor.sel === K.selFloor.floor && K.selFloor.sel > 0, K.selFloor);
    ok('Г5 назначение класса: все выделенные получили код, повтор — без изменений, откат возвращает метки', K.assign.ok && K.assign.changed > 0 && K.assign.n6 === K.assign.changed && K.assign.again.unchanged === true && K.assign.undo === true && K.assign.restored, K.assign);
    ok('Г6 удаление в размеченном облаке: метки точек сохранены, откат возвращает метки', K.del.removed > 0 && K.del.labels === K.del.count && K.del.count === 1200000 - K.del.removed && K.del.undo && K.del.restored, K.del);
    ok('Г7 сброс меток; назначение класса без разметки и его откат', K.clear.ret === true && K.clear.labels === null && K.clear.has === false && K.fresh.ok && K.fresh.changed > 0 && K.fresh.has === true && K.fresh.undo && K.fresh.hasAfter === false && K.fresh.back, { clear: K.clear, fresh: K.fresh });
    ok('Г8 блокировок r16 и ошибок GL нет', K.events === 0 && K.gl === 0, { ev: K.events, gl: K.gl });
  }

  // ---------- Д) экспорт всех точек потоком ----------
  if (want('exp')) {
    const E = await page.evaluate(async () => {
      const v = window.__viewer || window.__lxViewer, G = window.__G, r = { fmts: {} };
      G.load(v, 'room.las'); v.setPlaneProtect(false); v.setHoleFill(false);
      const collect = async (fmt) => { const ex = v.getBigExport(fmt); const parts = []; let bytes = 0; for await (const c of ex.chunks) { parts.push(c); bytes += c.length; } const all = new Uint8Array(bytes); let o = 0; for (const c of parts) { all.set(c, o); o += c.length; } return { ex: { count: ex.count, expectedBytes: ex.expectedBytes, fmt: ex.fmt }, bytes, all, nChunks: parts.length }; };
      for (const f of ['ply', 'las', 'xyz', 'pts', 'pcd', 'csv', 'obj']) {
        const c = await collect(f), head = new TextDecoder().decode(c.all.subarray(0, Math.min(400, c.all.length)));
        const o = { count: c.ex.count, bytes: c.bytes, expected: c.ex.expectedBytes, chunks: c.nChunks };
        if (f === 'ply') { const m = /element vertex (\d+)/.exec(head); o.header = m && +m[1]; }
        if (f === 'las') { const dv = new DataView(c.all.buffer); o.sig = String.fromCharCode(c.all[0], c.all[1], c.all[2], c.all[3]); o.npts = Number(dv.getBigUint64(247, true)); o.legacy = dv.getUint32(107, true); o.offset = dv.getUint32(96, true); o.rec = dv.getUint16(105, true); }
        if (f === 'xyz' || f === 'csv' || f === 'pts' || f === 'obj') { let lines = 0; for (let i = 0; i < c.all.length; i++) if (c.all[i] === 10) lines++; o.lines = lines; }
        if (f === 'pcd') { const m = /POINTS (\d+)/.exec(head); o.header = m && +m[1]; }
        r.fmts[f] = o;
      }
      // экспорт после правки отражает правку
      await v.selectBox([8, 0, 3], [12, 2, 7]); const del = await v.deleteSelection(); const c2 = await collect('ply'); r.afterDel = { del, count: c2.ex.count, bytes: c2.bytes, header: +/element vertex (\d+)/.exec(new TextDecoder().decode(c2.all.subarray(0, 300)))[1], total: v.bigInfo().count };
      // первая точка PLY совпадает с первой точкой сегмента (координаты float32, порядок как в памяти)
      const dv = new DataView(c2.all.buffer), hdrEnd = (() => { const t = new TextDecoder().decode(c2.all.subarray(0, 400)); return t.indexOf('end_header') + 'end_header\n'.length; })();
      const sg0 = v.base[0]._segs[0]; r.firstPt = { ply: [dv.getFloat32(hdrEnd, true), dv.getFloat32(hdrEnd + 4, true), dv.getFloat32(hdrEnd + 8, true)], mem: [sg0.P[0], sg0.P[1], sg0.P[2]] };
      v.undoEdit(); r.gl = v.gl.getError(); r.events = window.__stl;
      return r;
    });
    out.E = E; const N = 1200000;
    ok('Д1 PLY: заголовок и размер = ожидаемым, все 1,2 млн точек', E.fmts.ply.count === N && E.fmts.ply.header === N && E.fmts.ply.bytes === E.fmts.ply.expected, E.fmts.ply);
    ok('Д2 LAS: сигнатура, число точек в заголовке, размер = ожидаемому', E.fmts.las.sig === 'LASF' && E.fmts.las.npts === N && E.fmts.las.bytes === E.fmts.las.expected && E.fmts.las.bytes === E.fmts.las.offset + N * E.fmts.las.rec, E.fmts.las);
    ok('Д3 XYZ, PTS, CSV, PCD, OBJ: все точки', E.fmts.xyz.count === N && E.fmts.xyz.lines >= N && E.fmts.xyz.lines <= N + 6 && E.fmts.csv.lines >= N + 1 && E.fmts.csv.lines <= N + 6 && E.fmts.pts.lines >= N + 1 && E.fmts.pts.lines <= N + 6 && E.fmts.pcd.header === N && E.fmts.obj.lines === N + 1, { xyz: E.fmts.xyz, csv: E.fmts.csv, pts: E.fmts.pts, pcd: E.fmts.pcd, obj: E.fmts.obj });
    ok('Д4 экспорт после удаления отражает правку; первая точка совпадает с памятью', E.afterDel.count === N - E.afterDel.del && E.afterDel.header === E.afterDel.count && E.afterDel.total === E.afterDel.count && Math.abs(E.firstPt.ply[0] - E.firstPt.mem[0]) < 1e-3 + 1e-9 && Math.abs(E.firstPt.ply[1] - E.firstPt.mem[1]) < 1e-6 && Math.abs(E.firstPt.ply[2] - E.firstPt.mem[2]) < 1e-6, { a: E.afterDel, f: E.firstPt });
    ok('Д5 блокировок r16 и ошибок GL нет', E.events === 0 && E.gl === 0, { ev: E.events, gl: E.gl });
  }

  // ---------- Ж) приложение целиком: открытие файла частями, кнопки «Чистка», «Удалить», «Обрезать», «Отменить», «Сохранить», меню, экспорт ----------
  if (want('app')) {
    await page.evaluate(() => {
      const G = window.__G; window.__labPath = 'C:\\scans\\huge.las';
      const toks = new Map(); window.__reads = []; window.__closed = 0; window.__releases = 0; window.__stream = null; window.__saveCalls = [];
      window.__bimOverrides = window.__bimOverrides || {};
      window.__bimOverrides.cloudPartsOpen = () => ({ ok: true, token: 'tok1', total: G.N, segPoints: G.SEG, chunkPoints: G.CH, segments: G.N / G.SEG, bbox: { mn: [0, -0.01, 0], mx: [20, 3.01, 10] }, meta: { kind: 'points', points: G.N, total: G.N, format: 'LAS fmt 3', colored: true }, hasColor: true, hasIntensity: false, hasClassification: false });
      window.__bimOverrides.cloudPartsRead = async (a) => {
        window.__reads.push(a.part);
        const s = G.seg(a.part, false), token = 'chunk' + a.part; toks.set(token, s);
        return { ok: true, count: s.count, from: s.from, chunkPoints: s.chunkPoints, chunkBoxes: s.chunkBoxes, bbox: s.bbox, chunked: { token, count: s.count, chunkPoints: 500000, fields: { pos: { type: 'Float32Array', per: 3 }, col: { type: 'Uint8Array', per: 3 } } } };
      };
      window.__bimOverrides.readCloudChunk = (a) => { const s = toks.get(a.token); return { ok: true, pos: s.pos.slice(a.from * 3, (a.from + a.count) * 3), col: s.col.slice(a.from * 3, (a.from + a.count) * 3) }; };
      window.__bimOverrides.releaseCloud = (a) => { window.__releases++; toks.delete(a.token); return true; };
      window.__bimOverrides.cloudPartsClose = () => { window.__closed++; return true; };
      // потоковая запись: проверяем, что приложение шлёт в основной процесс все байты и ни разу не собирает файл целиком
      window.__bimOverrides.beginExportStream = (a) => { window.__stream = { begin: a, chunks: 0, bytes: 0, head: null, fin: false, cancelled: false, maxChunk: 0, typed: true }; return { ok: true, streamId: 'a'.repeat(48), fileName: 'out.' + a.ext }; };
      window.__bimOverrides.writeExportStreamChunk = (a) => { const s = window.__stream; if (!(a.bytes instanceof Uint8Array)) s.typed = false; s.chunks++; s.bytes += a.bytes.length; s.maxChunk = Math.max(s.maxChunk, a.bytes.length); if (!s.head) s.head = new TextDecoder().decode(a.bytes.subarray(0, Math.min(400, a.bytes.length))); return { ok: true, bytes: s.bytes }; };
      window.__bimOverrides.finishExportStream = () => { window.__stream.fin = true; return { ok: true, path: 'C:\\out\\pointcloud-edited.' + window.__stream.begin.ext, bytes: window.__stream.bytes, sha256: 'x' }; };
      window.__bimOverrides.cancelExportStream = () => { if (window.__stream) window.__stream.cancelled = true; return { ok: true }; };
      window.__bimOverrides.saveCloud = () => { window.__saveCalls.push('saveCloud'); return { ok: false, error: 'must-not-be-called' }; };
      window.__bimOverrides.exportFile = () => { window.__saveCalls.push('exportFile'); return { ok: false, error: 'must-not-be-called' }; };
      window.__bimCalls.length = 0; window.__stl = 0; window.__notices.length = 0;
    });
    log('app: открываю файл'); await page.setInputFiles('#modelInput', ROOM);
    await page.waitForFunction(() => { const v = window.__viewer || window.__lxViewer; return v && v.isBigCloud && v.isBigCloud() && v.base[0] && v.base[0]._gpuCount === 1200000; }, null, { timeout: 240000 });
    log('app: облако загружено');
    await page.waitForFunction(() => !(window.__lxProgress && window.__lxProgress.active), null, { timeout: 300000 });
    await page.waitForTimeout(500);
    const waitIdle = async () => { await page.waitForTimeout(300); const t0 = Date.now(); let last = 0; for (;;) { const st = await page.evaluate(() => { const v = window.__viewer || window.__lxViewer, a = window.__lxProgress && window.__lxProgress.active; return { prog: !!a, busy: !!v._bigBusy, notices: window.__notices.slice(-2) }; }); if (!st.prog && !st.busy) break; if (Date.now() - t0 > 20000 && Date.now() - last > 15000) { last = Date.now(); log('ждём: ' + JSON.stringify(st).slice(0, 300)); } if (Date.now() - t0 > 900000) throw new Error('waitIdle: превышено время'); await page.waitForTimeout(1000); } await page.waitForTimeout(200); };
    const J0 = await page.evaluate(() => { const v = window.__viewer || window.__lxViewer, G = window.__G, calls = window.__bimCalls.slice(); window.__sig0 = G.sig(v); const bo = v.base[0];
      return { big: v.isBigCloud(), info: v.bigInfo(), parseCloud: calls.filter((c) => c === 'parseCloud').length, reads: window.__reads.join(), sig: window.__sig0, flatNull: v.getEditedCloud() === null, gpu: bo._gpuCount }; });
    out.J0 = J0;
    ok('Ж1 файл открыт частями: «большое» облако, все 1,2 млн точек, parseCloud не вызывался', J0.big && J0.info.count === 1200000 && J0.parseCloud === 0 && J0.reads === '0,1,2,3' && J0.gpu === 1200000, J0);
    // классификация через меню «Чистка»
    log('app: меню'); await page.evaluate(() => document.getElementById('vtTools').click()); await page.waitForSelector('#cleanMenu', { state: 'attached', timeout: 20000 });
    await page.evaluate(() => { const b = [...document.querySelectorAll('#cleanMenu .lx-pop-item')].find((x) => /Разметить конструктив/.test(x.textContent)); if (!b) throw new Error('нет пункта меню'); b.click(); });
    await waitIdle(); log('app: разметка готова');
    const J1 = await page.evaluate(() => { const v = window.__viewer || window.__lxViewer, lab = v.getClassificationLabels(); window.__sig0 = window.__G.sig(v);   // подпись после разметки (классы входят в подпись)
      let h = {}; if (lab) for (let i = 0; i < lab.length; i++) h[lab[i]] = (h[lab[i]] || 0) + 1; return { sel: v.selectionCount(), labels: lab ? lab.length : null, hist: h, notices: window.__notices.slice(), stl: window.__stl }; });
    out.J1 = J1;
    ok('Ж2 меню «Разметить конструктив»: метки для ВСЕХ точек, «прочее» выделено', J1.labels === 1200000 && J1.sel > 0 && J1.sel === (J1.hist[0] | 0) && J1.stl === 0, J1);
    // «Удалить» (кнопка) → «Отменить» (кнопка)
    await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; window.__selN = v.selectionCount(); });
    log('app: удалить'); await page.evaluate(() => document.getElementById('edDelete').click()); await waitIdle(); log('app: удалено');
    const J2 = await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; return { count: v.bigInfo().count, sel: v.selectionCount(), selN: window.__selN, labels: v.getClassificationLabels() && v.getClassificationLabels().length, dirty: window.__pcAutosave ? window.__pcAutosave.isDirty() : null, notices: window.__notices.slice() }; });
    await page.evaluate(() => document.getElementById('edUndo').click()); await waitIdle(); log('app: отмена');
    const J3 = await page.evaluate(() => { const v = window.__viewer || window.__lxViewer, G = window.__G; return { count: v.bigInfo().count, sig: G.sig(v), same: G.sig(v) === window.__sig0, labels: v.getClassificationLabels() && v.getClassificationLabels().length }; });
    out.J2 = J2; out.J3 = J3;
    ok('Ж3 кнопка «Удалить»: убраны ровно выделенные точки, метки остались у оставшихся', J2.count === 1200000 - J2.selN && J2.sel === 0 && J2.labels === J2.count, J2);
    ok('Ж4 кнопка «Отменить»: все точки на месте побайтно, метки вернулись', J3.count === 1200000 && J3.same && J3.labels === 1200000, J3);
    // «Обрезать» → «Отменить» через Ctrl+Z
    await page.evaluate(async () => { const v = window.__viewer || window.__lxViewer; v.clearSelection(); await v.selectBox([8, 0, 3], [12, 2, 7]); window.__selN = v.selectionCount(); });
    log('app: обрезать'); await page.evaluate(() => document.getElementById('edCrop').click()); await waitIdle();
    const J4 = await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; return { count: v.bigInfo().count, selN: window.__selN }; });
    await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; v.undoEdit(); });
    const J5 = await page.evaluate(() => { const v = window.__viewer || window.__lxViewer, G = window.__G; return { count: v.bigInfo().count, same: G.sig(v) === window.__sig0 }; });
    out.J4 = J4; out.J5 = J5;
    ok('Ж5 кнопка «Обрезать»: осталось ровно выделенное; откат возвращает всё', J4.count === J4.selN && J4.selN > 0 && J5.count === 1200000 && J5.same, { J4, J5 });
    // кнопка «Чистка» (авто): точки уменьшились, нативный путь не вызывался
    await page.evaluate(() => { window.__bimCalls.length = 0; document.getElementById('vtClean').click(); }); log('app: чистка'); await waitIdle(); log('app: чистка готова');
    const J6 = await page.evaluate(() => { const v = window.__viewer || window.__lxViewer, calls = window.__bimCalls.slice(); return { count: v.bigInfo().count, auto: window.__lastAutoClean ? { removed: window.__lastAutoClean.removed, passes: window.__lastAutoClean.passes } : null, native: calls.filter((c) => /clean(Cloud|Status)/.test(c)).length, undo: (v._undo || []).length, notices: window.__notices.slice() }; });
    out.J6 = J6;
    ok('Ж6 кнопка «Чистка»: точки убраны на месте (без Python), число сходится, откат записан', J6.auto && J6.auto.removed > 0 && J6.count === 1200000 - J6.auto.removed && J6.native === 0 && J6.undo >= 1, J6);
    // сохранение кнопкой «Сохранить»: поток, все байты, приложение не собирает файл
    const cntBefore = J6.count;
    await page.evaluate(() => { window.__stream = null; document.getElementById('edSave').click(); });
    log('app: сохранение'); await page.waitForFunction(() => window.__stream && window.__stream.fin, null, { timeout: 300000 }); await waitIdle(); log('app: сохранено');
    const J7 = await page.evaluate(() => { const s = window.__stream, m = /element vertex (\d+)/.exec(s.head || ''); return { ext: s.begin.ext, expectedPoints: s.begin.expectedPoints, expectedBytes: s.begin.expectedBytes, bytes: s.bytes, chunks: s.chunks, maxChunk: s.maxChunk, header: m && +m[1], typed: s.typed, magic: (s.head || '').slice(0, 3), saveCalls: window.__saveCalls.slice(), cancelled: s.cancelled, dirty: window.__pcAutosave ? window.__pcAutosave.isDirty() : null }; });
    out.J7 = J7;
    ok('Ж7 «Сохранить»: PLY потоком — все точки, размер = объявленному, куски ≤ 32 МБ, saveCloud не вызывался, «не сохранено» снято', J7.ext === 'ply' && J7.expectedPoints === cntBefore && J7.header === cntBefore && J7.bytes === J7.expectedBytes && J7.chunks > 3 && J7.maxChunk <= 32 * 1024 * 1024 && J7.typed && J7.magic === 'ply' && J7.saveCalls.length === 0 && !J7.cancelled && J7.dirty === false, J7);
    // экспорт из меню формата (LAS), E57 — честный отказ
    const ex1 = await page.evaluate(async () => { window.__stream = null; await window.__lxSmartSave.exportAs('las'); const s = window.__stream; return { ext: s && s.begin.ext, expectedBytes: s && s.begin.expectedBytes, bytes: s && s.bytes, sig: s && (s.head || '').slice(0, 4), saveCalls: window.__saveCalls.slice() }; });
    const ex2 = await page.evaluate(async () => { window.__stream = null; await window.__lxSmartSave.exportAs('e57'); return { began: !!window.__stream, saveCalls: window.__saveCalls.slice(), notices: window.__notices.slice() }; });
    const ex3 = await page.evaluate(async () => { window.__stream = null; await window.__lxSmartSave.exportAs('obj'); const s = window.__stream; return { ext: s && s.begin.ext, head: s && (s.head || '').split('\n')[0], bytes: s && s.bytes }; });
    out.J8 = { ex1, ex2, ex3 };
    ok('Ж8 экспорт LAS потоком (размер = объявленному); E57 для такого облака отклонён сообщением, без записи; OBJ потоком', ex1.ext === 'las' && ex1.bytes === ex1.expectedBytes && ex1.sig === 'LASF' && ex1.saveCalls.length === 0 && ex2.began === false && ex3.ext === 'obj' && /^# BIM Twin point cloud export/.test(ex3.head || '') && ex3.bytes > 1000000, out.J8);
    // 3DGS (по выборке) и блокировок r16 нет
    const J9 = await page.evaluate(async () => { const v = window.__viewer || window.__lxViewer, s = await v.getBigSample(100000); return { count: s && s.count, total: s && s.total, col: !!(s && s.col), len: s && s.pos.length / 3, stl: window.__stl, gl: v.gl.getError() }; });
    out.J9 = J9;
    ok('Ж9 выборка для 3DGS: равномерно из всех точек, с цветом; блокировок r16 и ошибок GL нет', J9.count === 100000 && J9.len === 100000 && J9.total === cntBefore && J9.col && J9.stl === 0 && J9.gl === 0, J9);
  }

  console.log(JSON.stringify(out, null, 1).slice(0, 5000));
  let bad = 0; for (const c of checks) { console.log((c.ok ? 'OK   ' : 'FAIL ') + c.name + (c.ok ? '' : ' ' + JSON.stringify(c.info).slice(0, 600))); if (!c.ok) bad++; }
  console.log('ошибки консоли:', errs.length, errs.slice(0, 5).join(' | '));
  await browser.close();
  process.exit(bad || errs.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
