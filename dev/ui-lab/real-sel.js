// Выгрузка реальных выделений (не часть продукта): на настоящем облаке обводим рамкой дверь, проём в стене и т. д. так же,
// как это делает человек (кнопка «Измерить объект» → рамка мышью), и сохраняем облако выделения, которое получает «Инспектор объекта».
// Облака лежат в LAB_SEL_DIR/<имя>.f32 (Float32 xyz, координаты просмотра) + <имя>.json (камера, рамка, число точек).
// По ним алгоритм автоматического замера (renderer/auto-measure.js) отлаживается в Node без браузера (dev/ui-lab/auto-node.js).
//   LAB_CLOUD — PLY;  LAB_SEL_DIR — куда писать;  LAB_ONLY — список сценариев через запятую;  LAB_NO_EYEBOX=1 — не требовать, чтобы глаз камеры был в коридоре
//   (для косых видов: камера стоит за стеной, но точки перед стеной всё равно видны — как при просмотре «снаружи» через проём).
//   Запуск: sh run.sh real-sel.js
const { launch, shot } = require('./lab');
const { plyBbox } = require('./ply-bbox');
const fs = require('fs');

const OUT = process.env.LAB_SEL_DIR || '/tmp/sel';
const ONLY = (process.env.LAB_ONLY || '').split(',').filter(Boolean);
fs.mkdirSync(OUT, { recursive: true });
const PI = Math.PI;
const D1 = { x: [-16.641, -15.131], y: [1.603, 3.804], z: [-14.745, -14.481] };
const D2 = { x: [-15.998, -14.986], y: [1.591, 3.799], z: [-21.12, -20.86] };
const WR = { x: [-14.64, -14.576], y: [1.623, 3.807], z: [-2.524, -1.22] };
const SCEN = [
  { name: 'door1-front', box: D1, margin: 0.30, yaw: 0, pitch: 0.0, dist: 2.8 },
  { name: 'door1-front-back', box: D1, margin: 0.30, yaw: PI, pitch: 0.0, dist: 2.8 },
  { name: 'door1-tight', box: D1, margin: 0.0, yaw: 0, pitch: 0.0, dist: 2.8 },
  { name: 'door1-wide', box: D1, margin: 0.8, yaw: 0, pitch: 0.0, dist: 3.4 },
  { name: 'door1-oblique', box: D1, margin: 0.3, yaw: 0.55, pitch: 0.05, dist: 3.0 },
  { name: 'door1-oblique-back', box: D1, margin: 0.3, yaw: PI - 0.55, pitch: 0.05, dist: 3.0 },
  { name: 'door2-front', box: D2, margin: 0.30, yaw: 0, pitch: 0.0, dist: 2.8 },
  { name: 'door2-front-back', box: D2, margin: 0.30, yaw: PI, pitch: 0.0, dist: 2.8 },
  { name: 'door2-oblique', box: D2, margin: 0.3, yaw: 0.55, pitch: 0.05, dist: 3.0 },
  { name: 'wallR-hole', box: WR, margin: 0.3, yaw: -PI / 2 + 0.9, pitch: 0.0, dist: 3.0 },
  { name: 'wallR-hole-oblique', box: WR, margin: 0.3, yaw: -PI / 2 + 1.1, pitch: 0.05, dist: 3.0 },
  { name: 'partition-full', box: { x: [-17.6, -14.1], y: [1.592, 5.762], z: [-14.745, -14.481] }, margin: 0.05, yaw: 0, pitch: 0.0, dist: 5.0 },
  { name: 'partition-full-oblique', box: { x: [-17.6, -14.1], y: [1.592, 5.762], z: [-14.745, -14.481] }, margin: 0.05, yaw: 0.4, pitch: 0.0, dist: 5.5 },
  // Потолочные трубы и кабельный лоток: коробка задана в координатах ПРОСМОТРА (vbox), камера смотрит снизу вверх.
  { name: 'pipes-a', vbox: { x: [-1.5, 1.5], y: [0.9, 1.7], z: [2.0, 4.0] }, margin: 0.0, yaw: 0, pitch: -0.8, dist: 4.2 },
  { name: 'pipes-a-oblique', vbox: { x: [-1.5, 1.5], y: [0.9, 1.7], z: [2.5, 4.5] }, margin: 0.0, yaw: 0.5, pitch: -0.6, dist: 4.4 },
  { name: 'pipes-b', vbox: { x: [-1.5, 1.5], y: [0.9, 1.7], z: [6.0, 8.0] }, margin: 0.0, yaw: 0, pitch: -0.8, dist: 4.2 },
  { name: 'tray-a', vbox: { x: [-0.6, 0.6], y: [1.3, 1.7], z: [0.2, 1.8] }, margin: 0.0, yaw: 0, pitch: -0.8, dist: 3.4 },
  { name: 'pipes-narrow', vbox: { x: [-0.5, 0.5], y: [0.9, 1.6], z: [2.0, 3.2] }, margin: 0.0, yaw: 0, pitch: -0.8, dist: 3.4 }
];
const EYE_BOX = { x: [-1.42, 1.42], z: [-13.35, 13.85] };   // глаз камеры обязан быть внутри полосы коридора (иначе смотрим на стену с обратной стороны)

/* LAB_AUTO=1: после выделения нажимаем в окне «Измерить автоматически» так же, как человек (вкладка «Автоматически» → кнопка), читаем карточки с экрана,
 * проверяем сохранение в проект, повтор «на месте» и «Показать на облаке». Результаты — в LAB_SEL_DIR/<имя>.auto.json и снимки auto-<имя>.png. */
async function autoClick(page, name) {
  const t0 = Date.now();
  await page.click('#lxInsTab-auto'); await page.waitForTimeout(200);
  const kind = (process.env.LAB_KIND || '');
  if (kind) { await page.click('#lxInsKinds [data-kind="' + kind + '"]'); await page.waitForTimeout(150); }
  await page.click('#lxInsAutoBtn');
  try { await page.waitForSelector('#lxInsAutoOut .lx-auto-card, #lxInsAutoOut .lx-auto-sum.err', { timeout: 60000 }); } catch (e) { console.log('   авто:', name, ': нет результата за 60 с'); return; }
  await page.waitForTimeout(900);
  const read = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('#lxInsAutoOut .lx-auto-card')].map((c) => ({
      title: c.querySelector('.lx-auto-head span').textContent,
      dims: [...c.querySelectorAll('.lx-auto-row')].map((r) => ({ label: r.querySelector('.lx-auto-lbl').textContent, value: r.querySelector('.lx-auto-val').textContent, sigma: (r.querySelector('.lx-auto-sig') || {}).textContent || '', level: r.className.split(' ').pop(), saved: !!r.querySelector('.lx-auto-saved') }))
    }));
    const dc = window.__lxDocCheck, list = dc ? dc.rows().filter((x) => x.origin === 'auto') : [];
    return { cards: rows, state: (document.getElementById('lxInsAutoState') || {}).textContent, saved: list.map((x) => ({ label: x.label, type: x.objectType, value: x.valueText, status: x.status })), total: dc ? dc.rows().length : 0 };
  });
  const first = await read();
  await shot(page, 'auto-' + name);
  // повторное нажатие: в проекте не должно появиться дублей
  const before = first.total;
  await page.click('#lxInsAutoBtn'); await page.waitForSelector('#lxInsAutoOut .lx-auto-card', { timeout: 60000 }); await page.waitForTimeout(600);
  const second = await read();
  // «Показать на облаке»
  let shown = null;
  const btn = page.locator('#lxInsAutoOut [data-auto-show]').first();
  if (await btn.count()) { await btn.click(); await page.waitForTimeout(700); shown = await page.evaluate(() => { const v = window.__lxObjectInspector && document.querySelector('#lxInsModal'); const L = document.querySelectorAll('#lxInsModal .lx-win-stage div'); return Array.from(L).map((d) => d.textContent).filter((t) => /мм|м$| %/.test(t)).slice(0, 3); }); await shot(page, 'auto-' + name + '-show'); }
  fs.writeFileSync(OUT + '/' + name + '.auto.json', JSON.stringify({ name, ms: Date.now() - t0, first, second: { total: second.total, saved: second.saved.length }, dupes: second.total - before, shown }, null, 1));
  const top = first.cards[0];
  console.log('   авто:', name, '|', top ? top.title + ': ' + top.dims.map((d) => d.label + ' ' + d.value + ' ' + d.sigma + ' [' + d.level + (d.saved ? ', в проекте' : '') + ']').join('; ') : first.state, '| в проекте авто:', first.saved.length, 'дублей после повтора:', second.total - before);
}

(async () => {
  const cloud = process.env.LAB_CLOUD;
  const t0 = Date.now();
  const { browser, page, errs } = await launch({ w: 1440, h: 900, theme: 'dark', wait: 2500 });
  page.setDefaultTimeout(300000);
  await page.setInputFiles('#modelInput', cloud);
  let info = null;
  for (let i = 0; i < 150; i++) {
    await page.waitForTimeout(2000);
    info = await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; const b = v && v.base && v.base[0]; return b && b.pos ? { n: b.pos.length / 3 } : null; });
    if (info && info.n > 1000) break;
  }
  console.log('загрузка', Math.round((Date.now() - t0) / 1000), 'с; точек в просмотре', info.n);
  await page.waitForTimeout(3000);
  const bb = plyBbox(cloud), shift = [0, 1, 2].map((k) => -(bb.mn[k] + bb.mx[k]) / 2);
  console.log('сдвиг', shift.map((x) => +x.toFixed(4)));

  for (const sc of SCEN) {
    if (ONLY.length && !ONLY.includes(sc.name)) continue;
    const b = sc.vbox ? { x: sc.vbox.x.map((v) => v - shift[0]), y: sc.vbox.y.map((v) => v - shift[1]), z: sc.vbox.z.map((v) => v - shift[2]) } : sc.box, m = sc.margin;
    const corners = [];
    for (const x of b.x) for (const y of b.y) for (const z of b.z) corners.push([x + shift[0], y + shift[1], z + shift[2]]);
    const C = [0, 1, 2].map((k) => (Math.min(...corners.map((p) => p[k])) + Math.max(...corners.map((p) => p[k]))) / 2);
    const mg = [m, m, 0];
    const corners2 = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) corners2.push([(sx < 0 ? b.x[0] : b.x[1]) + sx * mg[0] + shift[0], (sy < 0 ? b.y[0] : b.y[1]) + sy * mg[1] + shift[1], (sz < 0 ? b.z[0] : b.z[1]) + shift[2]]);
    let placed = null;
    for (let dd = 0; dd <= 10; dd += 0.5) { const dist = sc.dist + dd;
      const r = await page.evaluate(({ C, dist, yaw, pitch, corners2 }) => {
        const v = window.__viewer || window.__lxViewer;
        v.target = C.slice(); v.dist = dist; v.yaw = yaw; v.pitch = pitch; v._ortho = false; v._lastVP = null; v.render();
        const cr = v.canvas.getBoundingClientRect();
        const pts = corners2.map((p) => v.worldToScreen(p));
        const eye = [C[0] + dist * Math.cos(pitch) * Math.sin(yaw), C[1] + dist * Math.sin(pitch), C[2] + dist * Math.cos(pitch) * Math.cos(yaw)];
        const idx = v._psIndex ? v._psIndex() : null;
        const blockedEye = idx ? idx.nearest(eye[0], eye[1], eye[2], 0.15) >= 0 : false;
        return { pts, cr: { l: cr.left, t: cr.top, r: cr.right, b: cr.bottom }, eye, blockedEye };
      }, { C, dist, yaw: sc.yaw, pitch: sc.pitch, corners2 });
      const xs = r.pts.map((p) => p.x), ys = r.pts.map((p) => p.y);
      const rect = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      // безопасная зона холста: без верхней ленты объектов, куба вида и кнопок справа
      const inside = rect.x0 > r.cr.l + 24 && rect.x1 < r.cr.r - 90 && rect.y0 > r.cr.t + 62 && rect.y1 < r.cr.b - 24;
      const eyeOk = process.env.LAB_NO_EYEBOX === '1' || (r.eye[0] > EYE_BOX.x[0] && r.eye[0] < EYE_BOX.x[1] && r.eye[2] > EYE_BOX.z[0] && r.eye[2] < EYE_BOX.z[1]);
      if (inside && eyeOk && !r.blockedEye) { placed = { dist, rect, eye: r.eye }; break; }
    }
    if (!placed) { console.log(sc.name, ': не удалось подобрать вид'); continue; }
    await page.waitForTimeout(600);
    const { rect } = placed;
    const top = await page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? (e.id || e.className || e.tagName) : null; }, { x: rect.x0 + 5, y: rect.y0 + 5 });
    await page.evaluate(() => window.__lxObjectInspector.startPick());
    await page.mouse.move(rect.x0, rect.y0); await page.mouse.down();
    await page.mouse.move((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2, { steps: 6 });
    await page.mouse.move(rect.x1, rect.y1, { steps: 6 });
    if (sc.name === 'door1-front') await shot(page, 'sel-' + sc.name + '-drag');
    await page.mouse.up();
    let got = null;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(500);
      got = await page.evaluate(() => { const st = window.__lxObjectInspector.state; const c = st.lastCloud; const m = document.getElementById('lxInsModal'); if (!c || !m || m.hidden) return null; const u8 = new Uint8Array(c.pos.buffer, c.pos.byteOffset, c.pos.byteLength); let s = ''; for (let k = 0; k < u8.length; k += 32768) s += String.fromCharCode.apply(null, u8.subarray(k, k + 32768)); return { n: c.pos.length / 3, b64: btoa(s), meta: c.meta || null, title: st.title }; });
      if (got) break;
    }
    if (!got) { console.log(sc.name, ': выделение пустое, элемент под рамкой:', top); await page.evaluate(() => window.__lxObjectInspector.stopPick()); continue; }
    fs.writeFileSync(OUT + '/' + sc.name + '.f32', Buffer.from(got.b64, 'base64'));
    fs.writeFileSync(OUT + '/' + sc.name + '.json', JSON.stringify({ name: sc.name, n: got.n, shift, scen: sc, placed, meta: got.meta }, null, 1));
    console.log(sc.name, 'точек', got.n, 'камера', placed.dist, 'рамка', Object.values(rect).map(Math.round).join(','));
    if (['door1-front', 'wallR-hole', 'door2-oblique', 'partition-full', 'pipes-a', 'tray-a'].includes(sc.name)) { await page.waitForTimeout(1200); await shot(page, 'sel-' + sc.name + '-inspector'); }
    if (process.env.LAB_AUTO === '1') await autoClick(page, sc.name);
    await page.evaluate(() => window.__lxObjectInspector.close());
    await page.waitForTimeout(300);
  }
  console.log('ошибки страницы:', errs.length ? errs.slice(0, 5) : 'нет');
  await browser.close();
})().catch((e) => { console.error('СБОЙ', e); process.exit(1); });
