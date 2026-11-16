/* BIM Twin — r155 P3: Clipping Box UI + экспорт фрагмента/координат.
 * UI-слой: кнопка, панель min/max X/Y/Z, «Применить», «Сохранить фрагмент» (PLY/PCD/XYZ), «Отмена»,
 * подписи форматов и честные пометки: RCP/Protobuf — проприетарные (недоступно), LAS-фрагмент — через
 * экспорт/конвертацию (в ревизии r155 не пишется), E57 — только чтение.
 * .xcord — наш обменный формат (CSV или XML): координаты 8 углов бокса + проект/имя/количество точек.
 * Данные/сохранение — API phase4: window.__lxClipBox (open,close,state,applyAndSave,cancel,setBox,getBox).
 * API: window.__lxClipP3 = { mount, open, close, build, save, cancel, xcordCSV, xcordXML, filterBox }
 */
(function () {
  'use strict';
  var W = (typeof window !== 'undefined') ? window : globalThis;
  var D = (typeof document !== 'undefined') ? document : null;
  var st = { mounted: false, open: false, box: null, format: 'PLY', xcordFormat: 'csv', busy: false };
  function icon(n, s) { try { return W.__lxIcons && W.__lxIcons.svg ? W.__lxIcons.svg(n, s || 16) : ''; } catch (e) { return ''; } }
  function toast(m, tone) { try { if (W.__toast) W.__toast(m, tone); else if (W.__lxKit && W.__lxKit.toast) W.__lxKit.toast(m, { tone: tone }); } catch (e) { } }
  function $id(id) { return D ? D.getElementById(id) : null; }
  function api() { return W.__lxClipBox || null; }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

  // Чистая функция: фильтр точек по axis-aligned боксу. pts — xyz. Возвращает индексы/массивы.
  function filterBox(pts, box, opts) {
    opts = opts || {};
    if (!pts || !pts.length || !box || !box.min || !box.max) return { ok: false, indices: null, count: 0 };
    var mn = [num(box.min.x, 0), num(box.min.y, 0), num(box.min.z, 0)], mx = [num(box.max.x, 0), num(box.max.y, 0), num(box.max.z, 0)];
    var wantPos = opts.copy !== false, n = Math.floor(pts.length / 3), count = 0;
    var out = wantPos ? new Float32Array(n * 3) : null; var idx = new Uint32Array(Math.min(n, 1 << 20)); var ip = 0;
    for (var i = 0; i < n; i++) {
      var x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
      if (x < mn[0] || x > mx[0] || y < mn[1] || y > mx[1] || z < mn[2] || z > mx[2]) continue;
      if (idx.length <= ip) { var ni = new Uint32Array(idx.length * 2); ni.set(idx); idx = ni; }
      idx[ip++] = i;
      if (out) { out[count * 3] = x; out[count * 3 + 1] = y; out[count * 3 + 2] = z; }
      count++;
    }
    return { ok: true, count: count, indices: idx.subarray(0, ip), pos: out ? out.subarray(0, count * 3) : null };
  }
  function normBox(b) {
    if (!b || !b.min || !b.max) return null;
    var mn = { x: num(b.min.x, NaN), y: num(b.min.y, NaN), z: num(b.min.z, NaN) }, mx = { x: num(b.max.x, NaN), y: num(b.max.y, NaN), z: num(b.max.z, NaN) };
    for (var k of ['x', 'y', 'z']) { if (!isFinite(mn[k]) || !isFinite(mx[k])) return null; if (mn[k] > mx[k]) { var t = mn[k]; mn[k] = mx[k]; mx[k] = t; } }
    return { min: mn, max: mx, rotation: 0 };
  }
  function corners(b) {
    var out = []; for (var i = 0; i < 8; i++) out.push({ x: (i & 1) ? b.max.x : b.min.x, y: (i & 2) ? b.max.y : b.min.y, z: (i & 4) ? b.max.z : b.min.z });
    return out;
  }
  function projectName() {
    try { return (W.__bimCurrentCloudPath || (W.BimProjectState && W.BimProjectState.name) || 'BIM Twin').toString().split(/[\\/]/).pop(); } catch (e) { return 'BIM Twin'; }
  }
  function xcordCSV(box, project) {
    box = normBox(box); if (!box) return '';
    var rows = [['# xcord', 'BIM Twin r155'], ['project', project || projectName()], ['points', '8corners'], ['rotation', String(box.rotation || 0)]];
    rows.push(['corner', 'x', 'y', 'z']);
    corners(box).forEach(function (c, i) { rows.push([i, c.x.toFixed(6), c.y.toFixed(6), c.z.toFixed(6)]); });
    rows.push(['min', box.min.x.toFixed(6), box.min.y.toFixed(6), box.min.z.toFixed(6)]);
    rows.push(['max', box.max.x.toFixed(6), box.max.y.toFixed(6), box.max.z.toFixed(6)]);
    return rows.map(function (r) { return r.join(','); }).join('\n') + '\n';
  }
  function xcordXML(box, project) {
    box = normBox(box); if (!box) return '';
    var cs = corners(box).map(function (c, i) { return '  <corner i="' + i + '" x="' + c.x.toFixed(6) + '" y="' + c.y.toFixed(6) + '" z="' + c.z.toFixed(6) + '"/>'; }).join('\n');
    return '<?xml version="1.0" encoding="UTF-8"?>\n<xcord version="155" project="' + String(project || projectName()).replace(/[<>&"]/g, '') + '" rotation="' + (box.rotation || 0) + '">\n' +
      '  <min x="' + box.min.x.toFixed(6) + '" y="' + box.min.y.toFixed(6) + '" z="' + box.min.z.toFixed(6) + '"/>\n' +
      '  <max x="' + box.max.x.toFixed(6) + '" y="' + box.max.y.toFixed(6) + '" z="' + box.max.z.toFixed(6) + '"/>\n' + cs + '\n</xcord>\n';
  }
  function download(text, name, mime) {
    try {
      var blob = new W.Blob([text], { type: mime || 'text/plain;charset=utf-8' });
      var a = D.createElement('a'); a.href = W.URL.createObjectURL(blob); a.download = name; D.body.appendChild(a); a.click();
      setTimeout(function () { try { D.body.removeChild(a); W.URL.revokeObjectURL(a.href); } catch (e) { } }, 300);
      return true;
    } catch (e) { toast('Не удалось скачать файл: ' + ((e && e.message) || e), 'warn'); return false; }
  }

  var CSS = [
    '.lx-clip-bar { position: fixed; right: 14px; bottom: 68px; z-index: 519; display: flex; gap: 6px; }',
    '.lx-clip-bar button { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid var(--accent-line); border-radius: 8px; background: var(--glass); color: var(--txt-2); font: 500 11px/1 var(--font); cursor: pointer; }',
    '.lx-clip-panel { position: fixed; right: 14px; bottom: 104px; z-index: 520; width: 360px; max-width: calc(100vw - 28px); border: 1px solid var(--accent-line); border-radius: var(--r-3); background: var(--bg-1); color: var(--txt); box-shadow: var(--shadow-3); font: 11px/1.35 var(--font); }',
    '.lx-clip-panel[hidden] { display: none; }',
    '.lx-clip-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--line); background: var(--bg-2); }',
    '.lx-clip-head b { flex: 1; font-size: 11.5px; }',
    '.lx-clip-x { width: 22px; height: 22px; border: 0; border-radius: 6px; background: transparent; color: var(--txt-3); font: 600 15px/1 var(--font); cursor: pointer; }',
    '.lx-clip-body { display: flex; flex-direction: column; gap: 7px; padding: 9px 10px 10px; }',
    '.lx-clip-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
    '.lx-clip-row label { display: inline-flex; align-items: center; gap: 4px; color: var(--txt-2); font-size: 10.5px; }',
    '.lx-clip-row input[type="number"] { width: 68px; height: 24px; padding: 0 5px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg-2); color: var(--txt); font: 10.5px/1 var(--mono); }',
    '.lx-clip-row select { height: 24px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg-2); color: var(--txt); font: 10.5px/1 var(--font); }',
    '.lx-clip-actions { display: flex; gap: 6px; flex-wrap: wrap; }',
    '.lx-clip-actions button { height: 26px; padding: 0 9px; border: 1px solid var(--accent-line); border-radius: 6px; background: var(--accent-soft); color: var(--accent); font: 600 10.5px/1 var(--font); cursor: pointer; }',
    '.lx-clip-actions button.sub { border-color: var(--line); background: transparent; color: var(--txt-2); }',
    '.lx-clip-note { margin: 0; color: var(--txt-3); font-size: 9.5px; line-height: 1.45; }',
    '.lx-clip-warn { color: var(--warn); }',
    '@media (max-width: 1100px) { .lx-clip-bar { display: none; } }'
  ].join('\n');
  function styles() { if (!D || $id('lxClipStyles')) return; var s = D.createElement('style'); s.id = 'lxClipStyles'; s.textContent = CSS; (D.head || D.documentElement).appendChild(s); }
  function bar() {
    var b = $id('lxClipP3Btn'); if (b && b.parentNode) return b.parentNode;
    styles();
    b = D.createElement('div'); b.className = 'lx-clip-bar'; b.id = 'lxClipP3Bar';
    b.innerHTML = '<button type="button" id="lxClipP3Btn" data-p3="open" title="Clipping Box: обрезка облака по мин/макс X/Y/Z, сохранить фрагмент (PLY/PCD/XYZ), .xcord">' + icon('box', 15) + '<span>Clipping Box</span></button>';
    b.addEventListener('click', onClick);
    D.body.appendChild(b);
    return b;
  }
  function panel() {
    var p = $id('lxClipP3Panel'); if (p) return p;
    styles();
    p = D.createElement('section'); p.className = 'lx-clip-panel'; p.id = 'lxClipP3Panel'; p.hidden = true; p.setAttribute('data-p3-panel', '1');
    function row(axis) {
      return '<label>min ' + axis + ' <input type="number" step="0.01" data-p3-min-' + axis + '></label><label>max ' + axis + ' <input type="number" step="0.01" data-p3-max-' + axis + '></label>';
    }
    p.innerHTML = '<div class="lx-clip-head"><span>' + icon('box', 16) + '</span><b>Clipping Box — фрагмент облака</b><button class="lx-clip-x" data-p3="close" aria-label="Закрыть">×</button></div>' +
      '<div class="lx-clip-body">' +
      '<div class="lx-clip-row">' + row('X') + '</div><div class="lx-clip-row">' + row('Y') + '</div><div class="lx-clip-row">' + row('Z') + '</div>' +
      '<div class="lx-clip-row"><label>Поворот, ° <input type="number" step="1" value="0" data-p3-rotation disabled title="Поворот клип-бокса — phase 2 (сейчас axis-aligned)"></label><span class="lx-clip-note">поворот пока не поддерживается</span></div>' +
      '<div class="lx-clip-row"><label>Формат фрагмента <select data-p3-format><option value="PLY">PLY (бинарный, RGB)</option><option value="PCD">PCD (ASCII)</option><option value="XYZ">XYZ (ASCII)</option></select></label></div>' +
      '<div class="lx-clip-actions"><button type="button" data-p3="apply">Применить</button><button type="button" data-p3="save">Сохранить фрагмент</button><button type="button" data-p3="cancel" class="sub">Отмена</button><button type="button" data-p3="xcord">.xcord (углы)</button></div>' +
      '<div class="lx-clip-row"><label>Формат .xcord <select data-p3-xcord><option value="csv">CSV</option><option value="xml">XML</option></select></label><button type="button" data-p3="xcord-download" class="lx-clip-actions" style="height:26px;padding:0 9px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--txt-2);font:600 10.5px/1 var(--font);cursor:pointer">Скачать .xcord</button></div>' +
      '<p class="lx-clip-note" data-p3-note>Фрагмент: PLY/PCD/XYZ (LAS — через экспорт/конвертацию; RCP/Protobuf — проприетарные, недоступны; E57 — только чтение).</p>' +
      '<p class="lx-clip-note" data-p3-stat></p>' +
      '</div>';
    p.addEventListener('click', onClick);
    D.body.appendChild(p);
    return p;
  }
  function syncFields() {
    var p = panel(), a = api(), b = st.box;
    if (!b) { try { b = a && a.getBox ? a.getBox() : null; } catch (e) { } }
    if (!b && W.__viewer && W.__viewer.bbox) { var bb = W.__viewer.bbox; b = { min: { x: bb.mn[0], y: bb.mn[1], z: bb.mn[2] }, max: { x: bb.mx[0], y: bb.mx[1], z: bb.mx[2] } }; }
    b = normBox(b); if (!b) return;
    st.box = b;
    function set(sel, v) { var e = p.querySelector(sel); if (e) e.value = Number(v.toFixed(3)); }
    ['x', 'y', 'z'].forEach(function (k) { set('[data-p3-min-' + k + ']', b.min[k]); set('[data-p3-max-' + k + ']', b.max[k]); });
    stat();
  }
  function readFields() {
    var p = panel(), b = { min: {}, max: {}, rotation: num(p.querySelector('[data-p3-rotation]').value, 0) };
    ['x', 'y', 'z'].forEach(function (k) { b.min[k] = num(p.querySelector('[data-p3-min-' + k + ']').value, NaN); b.max[k] = num(p.querySelector('[data-p3-max-' + k + ']').value, NaN); });
    return normBox(b);
  }
  function stat(text) {
    var p = panel(), el = p.querySelector('[data-p3-stat]'); if (!el) return;
    if (text) { el.textContent = text; return; }
    var a = api(), n = 0; try { var s = a && a.state ? a.state() : null; n = (s && (s.points || s.count)) || 0; } catch (e) { }
    var info = 'Бокс: ' + (st.box ? [st.box.min.x, st.box.min.y, st.box.min.z].map(function (v) { return v.toFixed(2); }).join(' / ') + ' … ' + [st.box.max.x, st.box.max.y, st.box.max.z].map(function (v) { return v.toFixed(2); }).join(' / ') : '—');
    if (n) info += ' · внутри ~' + Math.round(n / 1e6) + ' млн точек';
    el.textContent = info + (a ? '' : ' · API клип-бокса ещё не подключён (phase4)');
  }
  function openPanel() { styles(); panel().hidden = false; st.open = true; bar(); syncFields(); try { if (api() && api().open) api().open(); } catch (e) { } return true; }
  function closePanel() { var p = panel(); p.hidden = true; st.open = false; }
  function apply() {
    var b = readFields(); if (!b) { toast('Clipping Box: проверьте min/max X/Y/Z', 'warn'); return false; }
    st.box = b;
    var a = api();
    if (a && a.setBox) { try { var r = a.setBox(b); if (r && r.ok === false) { toast('Клип-бокс: ' + (r.error || 'неверный бокс'), 'warn'); return false; } } catch (e) { toast('Клип-бокс: ошибка ' + ((e && e.message) || e), 'warn'); return false; } }
    else toast('Clipping Box: API phase4 (__lxClipBox) ещё не подключён — бокс не применён во вьюере', 'warn');
    stat(); return true;
  }
  function save() {
    var b = apply(); if (!b) return Promise.resolve({ ok: false });
    var p = panel(), fmt = p.querySelector('[data-p3-format]').value;
    var a = api();
    if (!a || !a.applyAndSave) { toast('Сохранить фрагмент: API phase4 (__lxClipBox.applyAndSave) ещё не подключён', 'warn'); return Promise.resolve({ ok: false }); }
    st.busy = true; stat('Сохранение фрагмента ' + fmt + '…');
    return Promise.resolve().then(function () { return a.applyAndSave({ format: fmt }); }).then(function (r) {
      st.busy = false;
      if (r && r.ok) { stat('Фрагмент сохранён: ' + (r.count || 0).toLocaleString('ru-RU') + ' точек · ' + (r.path || '') + ' · ' + fmt); toast('Фрагмент сохранён: ' + fmt); }
      else { stat('Не удалось сохранить фрагмент: ' + ((r && (r.message || r.error)) || 'нет данных')); toast('Фрагмент не сохранён: ' + JSON.stringify(r || {}), 'warn'); }
      return r || { ok: false };
    }).catch(function (e) { st.busy = false; toast('Фрагмент не сохранён: ' + ((e && e.message) || e), 'warn'); return { ok: false }; });
  }
  function cancel() {
    var a = api(); try { if (a && a.cancel) a.cancel(); } catch (e) { }
    st.box = null; var p = panel(); p.hidden = true; st.open = false; toast('Clipping Box: срез сброшен'); return true;
  }
  function xcordDownload() {
    var b = st.box || readFields(); if (!b) { toast('.xcord: нет бокса', 'warn'); return false; }
    var fmt = panel().querySelector('[data-p3-xcord]').value;
    var text = fmt === 'xml' ? xcordXML(b) : xcordCSV(b);
    var ok = download(text, 'clip-r155-' + (projectName().replace(/\.[a-z0-9]+$/i, '') || 'xcord') + '.' + fmt, fmt === 'xml' ? 'application/xml' : 'text/csv');
    if (ok) toast('.xcord сохранён: ' + (fmt === 'xml' ? 'XML' : 'CSV') + ' (8 углов бокса)');
    return ok;
  }
  function onClick(e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-p3]') : null; if (!t) return;
    var a = t.getAttribute('data-p3');
    if (a === 'open') openPanel();
    else if (a === 'close') closePanel();
    else if (a === 'apply') apply();
    else if (a === 'save') save();
    else if (a === 'cancel') cancel();
    else if (a === 'xcord-download') xcordDownload();
  }
  function mount() {
    if (st.mounted) return true; st.mounted = true;
    try { bar(); } catch (e) { }
    try { W.addEventListener('lx-cloud-loaded', function () { if (st.open) syncFields(); }); } catch (e) { }
    return true;
  }
  var API = { version: '155', mount: mount, open: openPanel, close: closePanel, apply: apply, save: save, cancel: cancel, xcordCSV: xcordCSV, xcordXML: xcordXML, filterBox: filterBox, state: function () { return { open: st.open, box: st.box, format: st.format, apiReady: !!api() }; } };
  W.__lxClipP3 = API;
  function boot() { try { if (!D || !D.body) { if (D) D.addEventListener('DOMContentLoaded', mount); return; } mount(); } catch (e) { } }
  boot();
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof globalThis !== 'undefined' && typeof window === 'undefined') { try { globalThis.__lxClipP3 = API; } catch (e) { } }
})();
