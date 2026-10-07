// Аудит измерений на синтетической сцене с известными размерами (не часть продукта).
// Каждый сценарий идёт через настоящий _measureClick с тем же снапом, что и у мыши; попытки: точно, затем 5 раз с промахом до 3 см
// (клик попадает в ближайшую к «промаху» точку облака — так же, как это делает pick). Допуски — в колонке «допуск».
//   LAB_CLOUD=/data/work/audit.ply  LAB_ONLY=префикс[,префикс]  LAB_OUT=файл.json  LAB_URL=http://127.0.0.1:8123/renderer/index.html?fromStart=1
// Запуск: node server.js &  затем  cd dev/ui-lab && LAB_CLOUD=/data/work/audit.ply sh /data/ui-lab/run.sh measure-audit.js
const fs = require('fs');
const { launch, openCloud } = require('./lab');
const ONLY = (process.env.LAB_ONLY || '').split(',').filter(Boolean);
(async () => {
  const { browser, page, errs } = await launch({ w: 1280, h: 800, theme: 'dark', wait: 2500 });
  page.setDefaultTimeout(900000);
  await openCloud(page);
  await page.waitForTimeout(2000);
  const out = await page.evaluate(async (ONLY) => {
    const V = window.__viewer || window.__lxViewer, bo = V.base[0], POS = bo.pos, NP = POS.length / 3;
    const SH = [-77.5, -1.5, -2.5];                                   // мир → экран загруженного облака (центрирование по bbox)
    const L = (w) => [w[0] + SH[0], w[1] + SH[1], w[2] + SH[2]], W = (l) => [l[0] - SH[0], l[1] - SH[1], l[2] - SH[2]];
    V.target = L([3, 1.4, 2]); V.dist = 6; V.yaw = -0.7; V.pitch = -0.4; V.render();   // камера в комнате, как при реальном измерении
    let sd = 777; const rnd = () => (sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296;
    const near = (w) => { const p = L(w); let b = -1, bd = 1e30; for (let i = 0; i < NP; i++) { const dx = POS[i * 3] - p[0], dy = POS[i * 3 + 1] - p[1], dz = POS[i * 3 + 2] - p[2], d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; b = i; } } return [POS[b * 3], POS[b * 3 + 1], POS[b * 3 + 2]]; };
    let MS = 0.03;   // максимальный промах клика, м
    const miss = (k) => { if (!k) return [0, 0, 0]; let v; do { v = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]; } while (v[0] * v[0] + v[1] * v[1] + v[2] * v[2] > 1); return [v[0] * MS, v[1] * MS, v[2] * MS]; };
    const setup = (mode) => { V.setMeasure(true); V.setMeasureMode(mode); V.measureSnap = true; V.smartMeasure = true; V._clearMeasure(); };
    const clickAt = (w, k) => { const m = miss(k), q = near([w[0] + m[0], w[1] + m[1], w[2] + m[2]]); const t0 = performance.now(); V._measureClick(q); return { r: V._measResult, ms: performance.now() - t0 }; };
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], len = (a) => Math.hypot(a[0], a[1], a[2]);
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const R = 0.11, CY = 1.6, CZ = 1.0;
    const pipePt = (x, deg) => { const f = deg * Math.PI / 180; return [x, CY + R * Math.sin(f), CZ + R * Math.cos(f)]; };
    const rows = [];
    const T = {};   // метрика → время клика
    const run = (name, tol, unit, fn, nAttempts, ms) => {
      if (ONLY.length && !ONLY.some((p) => name.startsWith(p))) return;
      MS = ms || 0.03;
      const errsA = [], notes = [], tms = [];
      for (let k = 0; k < (nAttempts || 6); k++) {
        let e = null, note = '';
        try { const r = fn(k); if (r && typeof r === 'object' && r.err != null) { e = r.err; note = r.note || ''; if (r.ms) tms.push(r.ms); } else e = r; } catch (ex) { e = NaN; note = 'ИСКЛЮЧЕНИЕ ' + ex.message; }
        errsA.push(e); if (note) notes.push(note);
      }
      const ok = errsA.filter((e) => typeof e === 'number' && isFinite(e) && Math.abs(e) <= tol).length;
      const abs = errsA.filter((e) => typeof e === 'number' && isFinite(e)).map(Math.abs).sort((a, b) => a - b);
      rows.push({ name, unit, tol, ok, n: errsA.length, errs: errsA.map((e) => (typeof e === 'number' ? +e.toFixed(3) : e)), max: abs.length ? +abs[abs.length - 1].toFixed(3) : null, med: abs.length ? +abs[abs.length >> 1].toFixed(3) : null, notes: [...new Set(notes)].slice(0, 3), ms: tms.length ? +(tms.reduce((a, b) => a + b, 0) / tms.length).toFixed(0) : null });
    };
    // значение, которое показывает окно результата: перпендикуляр (если он есть), иначе длина отрезка
    const shown = (r) => (r && r.perp != null ? r.perp : r && r.d3 != null ? r.d3 : null);
    const dist2 = (name, a, b, truth, tol, ms) => run('1 расстояние ' + name, tol || 5, 'мм', (k) => { setup('distance'); clickAt(a(k), k); const c = clickAt(b(k), k); const v = shown(c.r); let e = v == null ? NaN : v * 1000 - truth; const r = c.r; if (r && r.perp != null && ['planes', 'edges', 'pipe', 'point-plane'].includes(r.perpKind) && Math.abs(r.d3 - r.perp) * 1000 > 0.5) e = 1000 + Math.abs(r.d3 - r.perp) * 1000;   // отрезок на экране должен равняться числу в окне
      return { err: e, ms: c.ms, note: r && r.perpKind ? 'вид=' + r.perpKind : '' }; }, 6, ms);
    const rp = (lo, hi) => lo + rnd() * (hi - lo);
    // --- 1. расстояние: плоскости, рёбра, колонна, трубы
    dist2('пол→потолок', () => [rp(.6, 4), 0, rp(.6, 2.4)], () => [rp(.6, 4), 2.8, rp(.6, 2.4)], 2800);
    dist2('потолок→пол', () => [rp(.6, 4), 2.8, rp(.6, 2.4)], () => [rp(.6, 4), 0, rp(.6, 2.4)], 2800);
    dist2('стена W→E', () => [0, rp(.4, 2.4), rp(.4, 3.6)], () => [6, rp(.4, 2.4), rp(.4, 3.6)], 6000);
    dist2('стена S→N', () => [rp(.4, 5.6), rp(.4, 2.4), 0], () => [rp(.4, 5.6), rp(.4, 2.4), 4], 4000);
    dist2('стена W→грань колонны x=4,5', () => [0, rp(.4, 2.4), rp(.4, 3.6)], () => [4.5, rp(.4, 2.4), rp(2.65, 2.95)], 4500);
    dist2('грань колонны x=4,9→стена E', () => [4.9, rp(.4, 2.4), rp(2.65, 2.95)], () => [6, rp(.4, 2.4), rp(.4, 3.6)], 1100);
    dist2('грани колонны x=4,5↔4,9 (промах до 1 см, дальше 16 px от ребра)', () => [4.5, rp(.4, 2.4), rp(2.76, 2.84)], () => [4.9, rp(.4, 2.4), rp(2.76, 2.84)], 400, 5, 0.01);
    dist2('ребро пол–стена S → ребро потолок–стена N (по высоте и глубине)', () => [rp(1, 5), 0, 0], () => [rp(1, 5), 2.8, 4], Math.hypot(2800, 4000), 6);
    // Ø двумя кликами по трубе: сверху/снизу и по краям ±75°, разные X
    dist2('Ø трубы: верх/низ (X разные)', (k) => pipePt(rp(1.2, 2.4), 90), () => pipePt(rp(2.6, 4.4), -90), 220, 4);
    dist2('Ø трубы: края ±75°', () => pipePt(rp(1.2, 2.4), 75), () => pipePt(rp(2.6, 4.4), -75), 220, 4);
    dist2('Ø трубы: хорда 0°↔90° (не диаметр; ждём хорду 155,6 мм, промах до 1 см)', () => pipePt(2.0, 0), () => pipePt(2.0, 90), Math.hypot(R, R) * 1000, 8, 0.01);
    // пол → точка трубы (перпендикуляр от точки до плоскости = высота точки над полом) и труба → пол
    const floorPipe = (name, floorFirst) => run('1 расстояние ' + name, 3, 'мм', (k) => {
      setup('distance'); const fp = () => [rp(.8, 3.8), 0, rp(.8, 2.4)], pp = () => pipePt(rp(1.2, 4.4), rp(-60, 60));
      if (floorFirst) { clickAt(fp(), k); } else { clickAt(pp(), k); }
      const c = clickAt(floorFirst ? pp() : fp(), k), r = c.r; if (!r) return { err: NaN, ms: c.ms };
      const P = V.measurePts, pipeW = W(floorFirst ? P[1] : P[0]), v = r.perp != null ? r.perp : r.d3;
      let e = v * 1000 - pipeW[1] * 1000; if (r.perp != null && Math.abs(r.d3 - r.perp) * 1000 > 0.5) e = 1000 + Math.abs(r.d3 - r.perp) * 1000;
      return { err: e, ms: c.ms, note: 'вид=' + (r.perpKind || 'нет') };
    }, 6, 0.01);
    floorPipe('пол→труба (⊥ = высота точки трубы)', true);
    floorPipe('труба→пол (⊥ = высота точки трубы)', false);
    // --- 2. инструмент «Диаметр» (1 клик)
    for (const deg of [0, 45, -45, 75, -75, 90, -90]) run('2 диаметр одним кликом ' + deg + '°', 4, 'мм', (k) => { setup('diameter'); const c = clickAt(pipePt(rp(1.2, 4.4), deg), k); return { err: c.r && c.r.diameter != null ? c.r.diameter * 1000 - 220 : NaN, ms: c.ms, note: c.r && c.r.error ? c.r.error : 'дуга ' + (c.r && c.r.arc != null ? Math.round(c.r.arc) + '°' : '?') + (c.r && c.r.weak ? ' слабая' : '') }; });
    run('2 диаметр: клик по плоскости → отказ (ждём error)', 0.5, 'флаг', (k) => { setup('diameter'); const c = clickAt([rp(1, 5), 0, rp(.5, 3.5)], k); return { err: c.r && c.r.error ? 0 : 1, ms: c.ms, note: c.r && c.r.error || 'диаметр ' + (c.r && c.r.diameter) }; });
    // --- 3. точка
    const pointErr = (name, w, truthFn, tol, ms) => run('3 точка ' + name, tol, 'мм', (k) => { setup('point'); const c = clickAt(w(k), k); const p = c.r && c.r.point ? W(c.r.point) : null; return { err: p ? truthFn(p) * 1000 : NaN, ms: c.ms, note: V._lastSnapKind || '' }; }, 6, ms);
    pointErr('угол пол/S/W (0,0,0)', () => [0, 0, 0], (p) => len(p), 6);
    pointErr('угол потолок/N/E (6;2,8;4)', () => [6, 2.8, 4], (p) => len(sub(p, [6, 2.8, 4])), 6);
    pointErr('ребро потолок–стена W (x=0,y=2,8)', () => [0, 2.8, rp(.8, 3.2)], (p) => Math.hypot(p[0], p[1] - 2.8), 5);
    pointErr('вертикальное ребро колонны (4,5; 2,6)', () => [4.5, rp(.5, 2.3), 2.6], (p) => Math.hypot(p[0] - 4.5, p[2] - 2.6), 5);
    pointErr('верхний угол колонны (4,5; 2,8; 2,6), промах до 1 см (на ребро: сдвиг вдоль него ≤ промаха)', () => [4.5, 2.8, 2.6], (p) => len(sub(p, [4.5, 2.8, 2.6])), 12, 0.01);
    pointErr('пол (на плоскости, ждём |y|≈0)', () => [rp(.6, 4), 0, rp(.6, 2.4)], (p) => Math.abs(p[1]), 4);
    pointErr('труба (радиальная ошибка)', () => pipePt(rp(1.2, 4.4), rp(-60, 60)), (p) => Math.abs(Math.hypot(p[1] - CY, p[2] - CZ) - R), 4);
    // --- 4. ломаная, угол, площадь
    const polyMode = (name, mode, pts, fn, tol, unit, ms) => run('4 ' + name, tol, unit, (k) => { setup(mode); let c; for (const p of pts) c = clickAt(p, k); return { err: fn(c.r), ms: c.ms }; }, 6, ms);
    polyMode('ломаная по полу 16 м', 'polyline', [[0, 0, 0], [6, 0, 0], [6, 0, 4], [0, 0, 4]], (r) => (r && r.total != null ? r.total * 1000 - 16000 : NaN), 12, 'мм');
    polyMode('ломаная вдоль рёбер потолка 10 м + колонна', 'polyline', [[0, 2.8, 0], [6, 2.8, 0], [6, 2.8, 4]], (r) => (r && r.total != null ? r.total * 1000 - 10000 : NaN), 10, 'мм');
    polyMode('угол пол: (6,0,0)-(0,0,0)-(0,0,4) = 90°', 'angle', [[6, 0, 0], [0, 0, 0], [0, 0, 4]], (r) => (r && r.deg != null ? r.deg - 90 : NaN), 0.5, '°');
    polyMode('угол в колонне 90° (промах до 1 см)', 'angle', [[4.9, 0, 2.6], [4.5, 0, 2.6], [4.5, 0, 3.0]], (r) => (r && r.deg != null ? r.deg - 90 : NaN), 2.5, '°', 0.01);
    polyMode('площадь пола 24 м²', 'area', [[0, 0, 0], [6, 0, 0], [6, 0, 4], [0, 0, 4]], (r) => (r && r.area != null ? r.area - 24 : NaN), 0.03, 'м²');
    polyMode('площадь стены S 16,8 м²', 'area', [[0, 0, 0], [6, 0, 0], [6, 2.8, 0], [0, 2.8, 0]], (r) => (r && r.area != null ? r.area - 16.8 : NaN), 0.03, 'м²');
    polyMode('площадь грани колонны 1,12 м² (промах до 1 см)', 'area', [[4.5, 0, 2.6], [4.5, 0, 3.0], [4.5, 2.8, 3.0], [4.5, 2.8, 2.6]], (r) => (r && r.area != null ? r.area - 1.12 : NaN), 0.03, 'м²', 0.01);
    // --- 5. плоскость: нормаль (мрад) и габариты участка
    const planeCase = (name, w, nrm, ext, tolN, tolE, ms) => {
      run('5 плоскость ' + name + ': нормаль', tolN, 'мрад', (k) => { setup('plane'); const c = clickAt(w(k), k); const r = c.r; if (!r || !r.normal) return { err: NaN, note: r && r.error || 'нет результата', ms: c.ms }; return { err: Math.acos(Math.min(1, Math.abs(dot(r.normal, nrm)))) * 1000, ms: c.ms }; }, 6, ms);
      run('5 плоскость ' + name + ': габариты', tolE, 'мм', (k) => { setup('plane'); const c = clickAt(w(k), k); const r = c.r; if (!r || r.length == null) return { err: NaN, note: r && r.error || 'нет результата', ms: c.ms }; const got = [r.length, r.width].sort((a, b) => b - a), exp = ext.slice().sort((a, b) => b - a); return { err: Math.max(Math.abs(got[0] - exp[0]), Math.abs(got[1] - exp[1])) * 1000, note: 'получено ' + got.map((x) => x.toFixed(3)).join('×'), ms: c.ms }; }, 6, ms);
    };
    planeCase('пол', () => [rp(.8, 3.8), 0, rp(.8, 2.4)], [0, 1, 0], [6, 4], 6, 40);
    planeCase('потолок', () => [rp(.8, 3.8), 2.8, rp(.8, 2.4)], [0, 1, 0], [6, 4], 6, 40);
    planeCase('стена S', () => [rp(.8, 5.2), rp(.6, 2.2), 0], [0, 0, 1], [6, 2.8], 6, 40);
    planeCase('стена W', () => [0, rp(.6, 2.2), rp(.6, 3.4)], [1, 0, 0], [4, 2.8], 6, 40);
    planeCase('стена E', () => [6, rp(.6, 2.2), rp(.6, 3.4)], [1, 0, 0], [4, 2.8], 6, 40);
    planeCase('грань колонны (промах до 1 см)', () => [4.5, rp(.6, 2.2), rp(2.7, 2.9)], [1, 0, 0], [0.4, 2.8], 8, 40, 0.01);
    run('5 плоскость на трубе → отказ с подсказкой', 0.5, 'флаг', (k) => { setup('plane'); const c = clickAt(pipePt(rp(1.5, 4.4), rp(-40, 40)), k); return { err: c.r && c.r.error ? 0 : 1, note: c.r && c.r.error ? 'есть сообщение' : 'плоскость построена (' + (c.r && c.r.length) + ')', ms: c.ms }; });
    // --- 6. отклонение от плоскости (точка → плоскость, со знаком)
    const devCase = (name, ref, pt, truth, tol) => run('6 отклонение ' + name, tol || 5, 'мм', (k) => { setup('deviation'); clickAt(ref(k), k); const c = clickAt(pt(k), k); return { err: c.r && c.r.distance != null ? c.r.distance * 1000 - truth : NaN, ms: c.ms, note: c.r && c.r.error || '' }; });
    devCase('пол→потолок', () => [rp(.8, 3.8), 0, rp(.8, 2.4)], () => [rp(.8, 3.8), 2.8, rp(.8, 2.4)], 2800);
    devCase('потолок→пол', () => [rp(.8, 3.8), 2.8, rp(.8, 2.4)], () => [rp(.8, 3.8), 0, rp(.8, 2.4)], 2800);
    devCase('пол→низ трубы', () => [rp(.8, 3.8), 0, rp(.8, 2.4)], () => pipePt(rp(1.2, 4.4), -90), CY * 1000 - R * 1000);
    devCase('пол→верх трубы', () => [rp(.8, 3.8), 0, rp(.8, 2.4)], () => pipePt(rp(1.2, 4.4), 90), CY * 1000 + R * 1000);
    devCase('стена W→грань колонны', () => [0, rp(.6, 2.2), rp(.6, 3.4)], () => [4.5, rp(.6, 2.2), rp(2.65, 2.95)], 4500);
    devCase('стена W→стена E', () => [0, rp(.6, 2.2), rp(.6, 3.4)], () => [6, rp(.6, 2.2), rp(.6, 3.4)], 6000);
    devCase('стена S→стена N', () => [rp(.8, 5.2), rp(.6, 2.2), 0], () => [rp(.8, 5.2), rp(.6, 2.2), 4], 4000);
    // --- 7. ребро и угол между плоскостями
    const cornerCase = (name, planes, check, tol, unit) => run('7 ребро/угол ' + name, tol, unit, (k) => { setup('corner'); let c; for (const p of planes) c = clickAt(p(k), k); return Object.assign({ ms: c.ms }, check(c.r)); });
    cornerCase('пол+стена S: угол 90°', [() => [rp(.8, 5), 0, rp(.8, 3)], () => [rp(.8, 5), rp(.5, 2.3), 0]], (r) => ({ err: r && r.angleDeg != null ? r.angleDeg - 90 : NaN, note: r && r.error || '' }), 0.4, '°');
    cornerCase('пол+стена S: положение ребра (расстояние от оси до линии y=0,z=0)', [() => [rp(.8, 5), 0, rp(.8, 3)], () => [rp(.8, 5), rp(.5, 2.3), 0]], (r) => { if (!r || !r.linePoint) return { err: NaN, note: r && r.error || '' }; const p = W(r.linePoint); return { err: Math.hypot(p[1], p[2]) * 1000 }; }, 3, 'мм');
    cornerCase('стены W+S: угол 90°', [() => [0, rp(.5, 2.3), rp(.8, 3.2)], () => [rp(.8, 5), rp(.5, 2.3), 0]], (r) => ({ err: r && r.angleDeg != null ? r.angleDeg - 90 : NaN, note: r && r.error || '' }), 0.4, '°');
    cornerCase('три плоскости: пол+S+W → точка (0,0,0)', [() => [rp(.8, 5), 0, rp(.8, 3)], () => [rp(.8, 5), rp(.5, 2.3), 0], () => [0, rp(.5, 2.3), rp(.8, 3.2)]], (r) => { if (!r || !r.corner) return { err: NaN, note: r && r.error || '' }; return { err: len(W(r.corner)) * 1000 }; }, 4, 'мм');
    cornerCase('три плоскости: потолок+N+E → точка (6;2,8;4)', [() => [rp(.8, 3.8), 2.8, rp(.8, 2.4)], () => [rp(.8, 5), rp(.5, 2.3), 4], () => [6, rp(.5, 2.3), rp(.8, 3.2)]], (r) => { if (!r || !r.corner) return { err: NaN, note: r && r.error || '' }; return { err: len(sub(W(r.corner), [6, 2.8, 4])) * 1000 }; }, 4, 'мм');
    run('7 ребро/угол: пол+потолок (параллельны) → отказ', 0.5, 'флаг', (k) => { setup('corner'); clickAt([rp(.8, 3.8), 0, rp(.8, 2.4)], k); const c = clickAt([rp(.8, 3.8), 2.8, rp(.8, 2.4)], k); return { err: c.r && c.r.error ? 0 : 1, note: c.r && c.r.error || 'принято: угол ' + (c.r && c.r.angleDeg) }; });
    // --- 8. отмена шага и завершение
    run('8 отмена: Backspace/undo/Esc ведут себя как задумано', 0.5, 'флаг', (k) => {
      setup('polyline'); const a = clickAt([0, 0, 0], k); clickAt([6, 0, 0], k); clickAt([6, 0, 4], k);
      const n3 = V.measurePts.length; V.undoMeasurePoint(); const n2 = V.measurePts.length; const prog = V.hasMeasureProgress(); const c = V.cancelMeasure(); const after = V.hasMeasureProgress();
      V.setMeasureMode('deviation'); V._clearMeasure(); clickAt([2, 0, 2], k); const dev1 = V.hasMeasureProgress(); V.undoMeasurePoint(); const dev0 = V.hasMeasureProgress();
      const okAll = n3 === 3 && n2 === 2 && prog && c && !after && dev1 && !dev0;
      return { err: okAll ? 0 : 1, note: okAll ? 'ok' : JSON.stringify({ n3, n2, prog, c, after, dev1, dev0 }) };
    }, 1);
    return { rows, pos: NP };
  }, ONLY);
  console.log('точек', out.pos);
  const pad = (s, n) => String(s).padEnd(n);
  let bad = 0;
  for (const r of out.rows) {
    const flag = r.ok === r.n ? 'OK ' : 'ПЛОХО';
    if (r.ok !== r.n) bad++;
    console.log(flag, pad(r.name, 78), pad(r.ok + '/' + r.n, 5), 'мед', pad(r.med, 8), 'макс', pad(r.max, 9), r.unit, '(допуск ' + r.tol + ')', r.ms != null ? ' ' + r.ms + ' мс/клик' : '', r.notes.length ? ' | ' + r.notes.join(' ; ') : '');
    if (r.ok !== r.n) console.log('      ошибки по попыткам:', JSON.stringify(r.errs));
  }
  console.log('сценариев', out.rows.length, 'с отклонениями', bad, '| ошибки консоли:', errs.length, errs.slice(0, 5).join(' || '));
  if (process.env.LAB_OUT) fs.writeFileSync(process.env.LAB_OUT, JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
