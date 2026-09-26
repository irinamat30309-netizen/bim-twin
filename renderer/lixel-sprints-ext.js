/* lixel-sprints-ext.js — v1224
 * UI-обвязка спринтов 1,3,4,5,6,8 (паритет со спринт-модулями).
 * Подключает кнопки к чистым функциям XrayView / WallDetect / Terrain /
 * Georef / IfcExport / PotreeLoader через мост window.__pcTools.
 * Спринты 0 (MultiCloud), 2 (TinVolume), 7 (ExportHub) уже подключены в lixel-tools-ext.js.
 * Честные сообщения там, где нужен внешний движок/сеть (Potree стриминг).
 */
(function () {
  'use strict';
  var UP = 1; // вьюер Y-up: высота = ось Y (index 1); план = X(0),Z(2)
  var busy = false;

  function T() { return window.__pcTools || null; }
  function toast(m) { var t = T(); if (t && t.toast) t.toast(m); else try { console.log('[sprints-ext]', m); } catch (e) {} }
  function viewer() { var t = T(); var v = (t && t.viewer) ? t.viewer() : null; return v || (typeof window !== 'undefined' ? window.__viewer : null) || null; }

  function getCloud() {
    var t = T(); if (!t) return null;
    var c = t.getCloud ? t.getCloud() : null;
    if (!c || !c.pos || !c.pos.length) return null;
    return { pos: c.pos, col: c.col || null, count: c.count || c.pos.length / 3 };
  }
  function needCloud() {
    var t = T();
    if (t && t.isOctreeStreamActive && t.isOctreeStreamActive()) {
      toast('Операция требует полный массив точек и недоступна в «Поток LOD». Выключите «Поток LOD» и повторите.');
      return null;
    }
    var c = getCloud(); if (!c) { toast('Сначала откройте облако точек'); return null; } return c;
  }
  // Robust coordinate bounds and clipping are local to this module (the volume
  // extension owns a separate closure and cannot provide its private helpers).
  function robustRange(pos,count,axis){var stride=Math.max(1,Math.ceil(count/50000)),a=[];for(var i=0;i<count;i+=stride){var v=pos[i*3+axis];if(isFinite(v))a.push(v);}a.sort(function(x,y){return x-y;});if(!a.length)return[0,0];return[a[Math.floor((a.length-1)*0.002)],a[Math.ceil((a.length-1)*0.998)]];}
  function trimVolumeOutliers(c){var ranges=[0,1,2].map(function(a){return robustRange(c.pos,c.count,a);}),keep=0,mask=new Uint8Array(c.count);for(var i=0;i<c.count;i++){var ok=true;for(var a=0;a<3;a++){var v=c.pos[i*3+a];if(v<ranges[a][0]||v>ranges[a][1]){ok=false;break;}}if(ok){mask[i]=1;keep++;}}if(keep===c.count)return{cloud:c,removed:0};var p=new c.pos.constructor(keep*3),col=c.col?new c.col.constructor(keep*3):null,j=0;for(var i=0;i<c.count;i++)if(mask[i]){p.set(c.pos.subarray(i*3,i*3+3),j*3);if(col)col.set(c.col.subarray(i*3,i*3+3),j*3);j++;}return{cloud:{pos:p,col:col,count:keep},removed:c.count-keep};}
  function nfmt(n) { try { return Number(n).toLocaleString('ru-RU'); } catch (e) { return '' + n; } }
  function yieldFrame() { return new Promise(function (r) { setTimeout(r, 0); }); }

  function download(name, data, mime) {
    try {
      var blob = (data instanceof Blob) ? data : new Blob([data], { type: (mime || 'application/octet-stream') });
      var url = URL.createObjectURL(blob); var a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
      return true;
    } catch (e) { toast('Не удалось сформировать файл: ' + (e && e.message || e)); return false; }
  }

  async function run(label, work) {
    if (busy) { toast('Идёт обработка — дождитесь завершения'); return; }
    var t = T(); busy = true;
    var stop = (t && t.beginProgress) ? t.beginProgress(label) : { set: function () {} };
    function setPct(frac, lab) { try { if (stop && stop.set) stop.set(frac, lab); } catch (e) {} }
    try { setPct(0.02, label); await work(setPct); }
    catch (e) { console.warn('sprints-ext', e); toast('Ошибка: ' + (e && e.message || e)); }
    finally { busy = false; if (stop) { try { stop(); } catch (e) {} } }
  }

  // ---- геометрия-помощники (Y-up) ----------------------------------------
  // Перцентили высоты пола/потолка сцены (без выбросов).
  function floorTop(c) {
    var P = c.pos, n = c.count, ys = [], step = Math.max(1, Math.floor(n / 60000));
    for (var i = 0; i < n; i += step) ys.push(P[i * 3 + 1]);
    ys.sort(function (a, b) { return a - b; });
    if (!ys.length) return [0, 1];
    return [ys[Math.floor(ys.length * 0.05)], ys[Math.floor(ys.length * 0.95)]];
  }
  // Горизонтальный срез стен -> массив точек плана [x,z] (с прореживанием).
  function projectFloorBand(c) {
    var P = c.pos, n = c.count, ft = floorTop(c), floor = ft[0], top = ft[1], h = Math.max(1e-3, top - floor);
    var lo = floor + Math.max(0.3, h * 0.15), hi = floor + Math.max(1.2, h * 0.55);
    var pts = [], step = Math.max(1, Math.floor(n / 200000));
    for (var i = 0; i < n; i += step) { var y = P[i * 3 + 1]; if (y >= lo && y <= hi) pts.push([P[i * 3], P[i * 3 + 2]]); }
    if (pts.length > 30000) { var out = [], s = pts.length / 30000; for (var k = 0; k < 30000; k++) out.push(pts[Math.floor(k * s)]); pts = out; }
    return pts;
  }
  function buildScan2BimModel(c) {
    var S = window.Scan2BIM;
    if (!S || typeof S.reconstruct !== 'function') return null;
    var model = S.reconstruct(c.pos, { colors: c.col || null });
    return model && model.ok ? model : null;
  }
  function sourcePlanPoint(q, tr) {
    if (!tr || !tr.t) return q.slice();
    if (tr.axis === 'zup') return [q[0] + tr.t[0], -q[1] + tr.t[1]];
    if (tr.axis === 'yup') return [q[0] + tr.t[0], q[1] + tr.t[2]];
    return [q[0] + tr.t[0], q[1]];
  }
  function sourceVerticalOffset(tr) {
    if (!tr || !tr.t) return 0;
    return tr.axis === 'zup' ? tr.t[2] : (tr.axis === 'yup' ? tr.t[1] : 0);
  }

  // ---- Спринт 1: X-Ray / Ортографические виды ----------------------------
  // Мост к вьюеру: добавляем недостающие методы поверх реального API
  // (setStandardView / setOrtho / setCloudOpacity), чтобы модуль XrayView работал.
  function ensureXrayBridge() {
    var v = viewer(); if (!v || v.__xrayPatched) return v;
    if (typeof v.setCameraMode !== 'function') v.setCameraMode = function (m) { try { if (m === 'ortho' || m === 'orthographic') { if (v.setOrtho) v.setOrtho(true); } else if (m === 'perspective') { if (v.setOrtho) v.setOrtho(false); } } catch (e) {} };
    if (typeof v.setCamera !== 'function') v.setCamera = function (p) {
      try {
        var e = (p && p.eye) || [1, 1, 1]; var ax = Math.abs(e[0]), ay = Math.abs(e[1]), az = Math.abs(e[2]);
        var mx = Math.max(ax, ay, az), mn = Math.min(ax, ay, az); var name = 'iso', ortho = false;
        if (mx - mn < 1e-6) { name = 'iso'; ortho = false; }
        else if (ay >= ax && ay >= az) { name = 'top'; ortho = true; }
        else if (az >= ax && az >= ay) { name = 'front'; ortho = true; }
        else { name = 'right'; ortho = true; }
        if (v.setStandardView) v.setStandardView(name);
        if (v.setOrtho) v.setOrtho(ortho);
      } catch (e2) {}
    };
    if (typeof v.setXray !== 'function') v.setXray = function (on, depth) { try { if (v.setCloudOpacity) v.setCloudOpacity(on ? Math.max(0.12, 1 - (depth == null ? 0.6 : depth)) : 1); } catch (e) {} };
    v.__xrayPatched = true; return v;
  }
  function opView(mode, label) {
    var v = ensureXrayBridge(); if (!v) { toast('Сначала откройте модель/облако'); return; }
    var X = window.XrayView; if (!X) { toast('Модуль видов недоступен'); return; }
    X.setMode(mode); toast('Вид: ' + label);
  }
  function opOrtho() {
    var v = viewer(); if (!v || !v.setOrtho) { toast('Сначала откройте модель/облако'); return; }
    var on = v.isOrtho ? !v.isOrtho() : true; v.setOrtho(on);
    toast('Ортографическая проекция: ' + (on ? 'вкл' : 'выкл'));
  }
  function opXray() {
    var v = ensureXrayBridge(); if (!v) { toast('Сначала откройте облако'); return; }
    var X = window.XrayView; if (!X) { toast('Модуль рентгена недоступен'); return; }
    X.toggleXray(); toast('Рентген (просвечивание): ' + (X.isXray() ? 'вкл' : 'выкл'));
  }

  // ---- Спринт 3: Детекция стен -> план этажа (DXF) -----------------------
  function opWalls() { return run('Поиск стен…', async function (setPct) {
    var c = needCloud(); if (!c) return;
    var S = window.Scan2BIM, model = buildScan2BimModel(c);
    if (model && S && typeof S.toDXF === 'function' && model.walls && model.walls.length) {
      setPct(0.35, 'Реконструкция стен/проёмов/объектов…'); await yieldFrame();
      var tr = T().getSourceTransform && T().getSourceTransform();
      var dxfModel = S.toDXF(model, { planOnly: true, planTransform: function (q) { return sourcePlanPoint(q, tr); } });
      if (!download('floorplan-' + Date.now() + '.dxf', dxfModel, 'application/dxf')) { toast('Не удалось сохранить план DXF'); return; }
      setPct(1, 'Готово');
      var objectCount = model.objects ? model.objects.length : 0;
      toast('План Scan→BIM: стены — ' + model.walls.length + ', проёмы — ' + (model.stats.openingCount || 0) + ', объекты — ' + objectCount + '; DXF со слоями стен/проёмов/объектов' + (tr && tr.t ? ' в исходных координатах' : ' в локальной системе'));
      return;
    }
    if (!window.WallDetect) { toast('Модуль детекции стен недоступен'); return; }
    setPct(0.3, 'Проекция облака на план…'); await yieldFrame();
    var pts = projectFloorBand(c); if (pts.length < 20) { toast('Недостаточно точек в плоскости стен'); return; }
    setPct(0.6, 'RANSAC поиск стен…'); await yieldFrame();
    var plan = window.WallDetect.autoFloorPlan(pts, { minInliers: Math.max(10, Math.floor(pts.length * 0.01)) });
    if (!plan || !plan.walls || !plan.walls.length) { toast('Стены не обнаружены — попробуйте другое облако'); return; }
    var tr=T().getSourceTransform&&T().getSourceTransform(),t=tr&&tr.t;
    if(tr&&t&&window.WallDetect.wallsToDxf){
      function mapPlanPoint(q){return tr.axis==='zup'?[q[0]+t[0],-q[1]+t[1]]:[q[0]+t[0],q[1]+(tr.axis==='yup'?t[2]:0)];}
      var worldWalls=plan.walls.map(function(w){return{a:mapPlanPoint(w.a),b:mapPlanPoint(w.b)};}),worldNodes=(plan.nodes||[]).map(mapPlanPoint);
      plan.dxf=window.WallDetect.wallsToDxf(worldWalls,worldNodes);
    }
    download('floorplan-' + Date.now() + '.dxf', plan.dxf, 'application/dxf'); setPct(1, 'Готово');
    toast('План этажа: найдено стен ' + plan.walls.length + ' (DXF сохранён' + (tr?' в исходных координатах':'') + ')');
  }); }

  // ---- Спринт 4: Рельеф (PMF-класс грунта, DTM/DSM, GeoTIFF, горизонтали) -----
  function setTerrainSourceGeo(dsm){
    var t=T(),tr=t&&t.getSourceTransform?t.getSourceTransform():null,crs=t&&t.getSourceCrs?t.getSourceCrs():null,shift=tr&&tr.t||[0,0,0];
    var zTop=dsm.minZ+(dsm.nz-1)*dsm.cell,originX=dsm.minX+(shift[0]||0),originY,verticalOffset=0,flipRows=true;
    if(tr&&tr.axis==='zup'){
      // Viewer row zero is the greatest source northing for a Z-up scan.
      originY=shift[1]-dsm.minZ;verticalOffset=shift[2];flipRows=false;
    }else{
      // In Y-up clouds, the plan northing is viewer Z; reverse rows to make
      // the GeoTIFF north-up while keeping the point samples in the same grid.
      originY=zTop+(shift[2]||0);verticalOffset=shift[1]||0;
    }
    dsm.geo={originX:originX,originY:originY,cell:dsm.cell,flipRows:flipRows,crsWkt:crs||null};
    if(verticalOffset)for(var i=0;i<dsm.grid.length;i++)dsm.grid[i]+=verticalOffset;
    return dsm;
  }
  function opDSM() { return run('ЦМП (DSM)…', async function (setPct) {
    var c = needCloud(); if (!c) return; if (!window.Terrain) { toast('Модуль рельефа недоступен'); return; }
    setPct(0.4, 'Построение ЦМП…'); await yieldFrame();
    var clipped=trimVolumeOutliers(c), dsm = setTerrainSourceGeo(window.Terrain.buildDSM(clipped.cloud.pos, clipped.cloud.count, { cell: 0.5 }));
    setPct(0.8, 'Кодирование GeoTIFF…'); await yieldFrame();
    var tif = window.Terrain.dsmToTiff(dsm);
    download('dsm-' + Date.now() + '.tif', tif, 'image/tiff'); setPct(1, 'Готово');
    var fillPct=dsm.grid.length?Math.round(100*dsm.interpolatedCells/dsm.grid.length):0;
    toast('ЦМП (DSM): сетка ' + dsm.nx + '×' + dsm.nz + ' @' + dsm.cell.toFixed(2) + ' м' + (dsm.cell>0.500001?' (шаг увеличен для ограничения памяти)':'') + '; интерполировано ячеек ' + fillPct + '%' + (clipped.removed?' · исключено выбросов '+nfmt(clipped.removed):'') + ' — GeoTIFF сохранён');
  }); }
  function opDTM() { return run('ЦМР (DTM)…', async function (setPct) {
    var c = needCloud(); if (!c) return; if (!window.Terrain || !window.Terrain.buildDTM) { toast('Модуль ЦМР недоступен'); return; }
    setPct(0.25, 'Классификация грунта…'); await yieldFrame();
    var r=window.Terrain.csfClassify(c.pos,c.count,{});if(!r.groundCount){toast('Грунт не найден — ЦМР не построена');return;}
    setPct(0.55,'Построение сетки грунта…');await yieldFrame();
    var dtm=setTerrainSourceGeo(window.Terrain.buildDTM(c.pos,c.count,{cell:0.5,labels:r.labels}));
    if(!dtm.nx||!dtm.nz){toast('Недостаточно точек класса «грунт» для ЦМР');return;}
    setPct(0.8,'Кодирование GeoTIFF…');await yieldFrame();
    var tif=window.Terrain.dsmToTiff(dtm);download('dtm-'+Date.now()+'.tif',tif,'image/tiff');setPct(1,'Готово');
    var pct=dtm.grid.length?Math.round(100*dtm.interpolatedCells/dtm.grid.length):0;
    toast('ЦМР (DTM): '+dtm.nx+'×'+dtm.nz+' @'+dtm.cell.toFixed(2)+' м; '+nfmt(dtm.validCount)+' ground points, интерполяция ячеек '+pct+'% — GeoTIFF сохранён');
  }); }
  function opContours() { return run('Горизонтали…', async function (setPct) {
    var c = needCloud(); if (!c) return; if (!window.Terrain) { toast('Модуль рельефа недоступен'); return; }
    var intervalText = typeof window.prompt === 'function'
      ? window.prompt('Шаг горизонталей в метрах (например, 0.50):', '0.50')
      : '0.50';
    if (intervalText === null) { toast('Построение горизонталей отменено'); return; }
    var interval = Number(String(intervalText).trim().replace(',', '.'));
    if (!isFinite(interval) || interval <= 0) { toast('Укажите положительный числовой шаг горизонталей'); return; }
    setPct(0.4, 'Построение ЦМП…'); await yieldFrame();
    var clipped=trimVolumeOutliers(c),dsm = window.Terrain.buildDSM(clipped.cloud.pos, clipped.cloud.count, { cell: 0.5 });
    setPct(0.7, 'Трассировка горизонталей…'); await yieldFrame();
    var cont = window.Terrain.buildContours(dsm, { interval: interval });
    var segmentCount = cont.reduce(function (sum, level) { return sum + (level.segments ? level.segments.length : 0); }, 0);
    if (!segmentCount) {
      toast('При шаге ' + interval.toLocaleString('ru-RU') + ' м пересечений нет; пустой DXF не сохранён. Уменьшите шаг или выберите поверхность с рельефом.');
      setPct(1, 'Контуры не найдены');
      return;
    }
    var tr=T().getSourceTransform&&T().getSourceTransform(), dxf;
    if(tr&&tr.axis==='zup'&&tr.t){
      var L=['0','SECTION','2','ENTITIES'];cont.forEach(function(level){level.segments.forEach(function(seg){var a=seg[0],b=seg[1];L.push('0','LINE','8','CONTOURS','10',(a[0]+tr.t[0]).toFixed(4),'20',(-a[1]+tr.t[1]).toFixed(4),'30',(level.level+tr.t[2]).toFixed(4),'11',(b[0]+tr.t[0]).toFixed(4),'21',(-b[1]+tr.t[1]).toFixed(4),'31',(level.level+tr.t[2]).toFixed(4));});});L.push('0','ENDSEC','0','EOF');dxf=L.join('\n');
    }else if(tr&&tr.axis==='yup'&&tr.t){
      var L=['0','SECTION','2','ENTITIES'];cont.forEach(function(level){level.segments.forEach(function(seg){var a=seg[0],b=seg[1];L.push('0','LINE','8','CONTOURS','10',(a[0]+tr.t[0]).toFixed(4),'20',(level.level+tr.t[1]).toFixed(4),'30',(a[1]+tr.t[2]).toFixed(4),'11',(b[0]+tr.t[0]).toFixed(4),'21',(level.level+tr.t[1]).toFixed(4),'31',(b[1]+tr.t[2]).toFixed(4));});});L.push('0','ENDSEC','0','EOF');dxf=L.join('\n');
    }else dxf = window.Terrain.contoursToDxf(cont);
    if (!download('contours-' + Date.now() + '.dxf', dxf, 'application/dxf')) { toast('Не удалось сохранить горизонтали DXF'); return; }
    setPct(1, 'Готово');
    var fillPct=dsm.grid.length?Math.round(100*dsm.interpolatedCells/dsm.grid.length):0;
    toast('Горизонтали (' + interval.toLocaleString('ru-RU') + ' м): ' + cont.length + ' уровней / ' + nfmt(segmentCount) + ' сегментов; поверхность интерполирована на ' + fillPct + '% ячеек' + (dsm.cell>0.500001?' (эффективный шаг '+dsm.cell.toFixed(2)+' м)':'') + ' — DXF сохранён');
  }); }
  function opGround() { return run('Грунт (PMF)…', async function (setPct) {
    var c = needCloud(); if (!c) return; if (!window.Terrain) { toast('Модуль рельефа недоступен'); return; }
    setPct(0.5, 'Классификация грунта (progressive morphological filter)…'); await yieldFrame();
    var r = window.Terrain.csfClassify(c.pos, c.count, {}), st = window.Terrain.classStats(c.pos, c.count, r.labels);
    var usable = Math.max(1, c.count - (r.excludedCount || 0)), pct = (100 * r.groundCount / usable).toFixed(1); setPct(1, 'Готово');
    if (!r.groundCount) { toast('PMF: не удалось выделить грунт; проверьте ось высоты/размер ячейки'); return; }
    toast('Грунт PMF: ' + nfmt(r.groundCount) + ' т. (' + pct + '%), исключено выбросов ' + nfmt(r.excludedCount || 0) + '. Высоты ' + st.ground.min.toFixed(2) + '…' + st.ground.max.toFixed(2) + ' м');
  }); }
  function opGroundLAS() { return run('Классификация LAS…', async function (setPct) {
    var c = needCloud(), t = T(); if (!c) return;
    if (!window.Terrain || !window.ExportHub || !window.ExportHub.exportLAS) { toast('Модули классификации/LAS недоступны'); return; }
    setPct(0.25, 'Классификация грунта…'); await yieldFrame();
    var r = window.Terrain.csfClassify(c.pos, c.count, {}), src = t && t.getSourceCloud ? t.getSourceCloud() : c;
    if (!src || !src.pos || src.pos.length !== c.pos.length) { toast('Не удалось сопоставить исходные координаты с классификацией'); return; }
    var classes = new Uint8Array(r.labels.length), ground = 0;
    for (var i = 0; i < r.labels.length; i++) { classes[i] = r.labels[i] === 1 ? 2 : 1; if (classes[i] === 2) ground++; }
    var meta = Object.assign({}, src.meta || {}), crs = t && t.getSourceCrs ? t.getSourceCrs() : null;
    if (crs) meta.crsWkt = crs;
    setPct(0.65, 'Запись LAS 1.4 / ASPRS…'); await yieldFrame();
    var bytes = window.ExportHub.exportLAS({ pos: src.pos, col: src.col || c.col || null, count: r.labels.length, meta: meta, classification: classes });
    download('classified-' + Date.now() + '.las', bytes, 'application/vnd.las'); setPct(1, 'Готово');
    toast('Классифицированный LAS: грунт ' + nfmt(ground) + ', прочее ' + nfmt(r.labels.length - ground) + ' (ASPRS 2/1, WKT сохранён при наличии)');
  }); }

  // ---- Спринт 5: Геопривязка по GCP (Гельмерт 3D) ------------------------
  function opGeoref() { return run('Геопривязка…', async function (setPct) {
    var c = needCloud(); if (!c) return; var G = window.Georef; if (!G) { toast('Модуль геопривязки недоступен'); return; }
    var txt = (typeof window.prompt === 'function') ? window.prompt('GCP (CSV): name,srcX,srcY,srcZ,dstX,dstY,dstZ — исходные XYZ облака → целевые XYZ (Z вверх), ≥3 неколлинеарных точек:', '') : null;
    if (!txt) { toast('Геопривязка отменена'); return; }
    var mgr = new G.GCPManager();
    txt.split(/\r?\n/).forEach(function (line) {
      var p = line.split(/[,;\t]/).map(function (s) { return s.trim(); });
      if (p.length >= 7) { var src = [+p[1], +p[2], +p[3]], dst = [+p[4], +p[5], +p[6]]; if (src.every(isFinite) && dst.every(isFinite)) mgr.add(p[0] || ('P' + (mgr.list().length + 1)), src, dst); }
    });
    if (mgr.list().length < 3) { toast('Нужно ≥3 корректных GCP (получено ' + mgr.list().length + ')'); return; }
    setPct(0.6, 'Решение (Гельмерт 3D)…'); await yieldFrame();
    var sol = mgr.solve();
    if(!sol){toast('Геопривязка: точки GCP должны быть конечными и не лежать на одной прямой');return;}
    var source=T().getSourceCloud?T().getSourceCloud():c;
    if(!source||!source.pos||source.pos.length!==c.pos.length){toast('Не удалось получить координаты исходного облака');return;}
    var dstCrs=window.prompt('WKT целевой системы координат. Пустое значение снимет прежнюю CRS, чтобы не приписывать её новым координатам:', '');
    if(dstCrs===null){toast('Геопривязка отменена');return;}
    var world=G.applyTransform(source.pos,c.count,sol);
    var result=G.toViewerCloud(world,source.col||c.col,{crsWkt:dstCrs});
    T().loadCloud(result,'georef'); setPct(1, 'Готово');
    var maxResidual=0;sol.residuals.forEach(function(r){if(r.residual>maxResidual)maxResidual=r.residual;});
    toast('Геопривязка: RMS ' + sol.rms.toFixed(4) + ' м, максимум ' + maxResidual.toFixed(4) + ' м, масштаб ' + sol.scale.toFixed(7) + ', GCP ' + sol.gcpCount + (result.meta.crsWkt?' · CRS задана':' · CRS не задана'));
  }); }
  function opGcpTemplate() {
    download('gcp-template.csv', 'name,srcX,srcY,srcZ,dstX,dstY,dstZ\nP1,0,0,0,100,200,10\nP2,1,0,0,101,200,10\nP3,0,0,1,100,201,10\n', 'text/csv');
    toast('Шаблон GCP CSV сохранён');
  }

  // ---- Спринт 6: Экспорт IFC-2x3 -----------------------------------------
  function opIFC() { return run('Экспорт IFC…', async function (setPct) {
    var c = needCloud(); if (!c) return; if (!window.IfcExport || typeof window.IfcExport.exportIFC !== 'function') { toast('Модуль IFC-2x3 недоступен'); return; }
    setPct(0.25, 'Реконструкция стен Scan→BIM…'); await yieldFrame();
    var model = buildScan2BimModel(c), tr = T().getSourceTransform && T().getSourceTransform();
    var walls = [], floors, columns = [];
    if (model && model.walls && model.walls.length) {
      walls = model.walls.map(function (w) { return { a: sourcePlanPoint(w.a, tr), b: sourcePlanPoint(w.b, tr) }; });
      var verticalOffset = sourceVerticalOffset(tr), floorY = model.storey ? model.storey.floorY : floorTop(c)[0], ceilY = model.storey ? model.storey.ceilY : floorTop(c)[1];
      floors = [{ name: 'Level 0', ymin: floorY + verticalOffset, ymax: ceilY + verticalOffset }];
      columns = (model.objects || []).filter(function (o) { return o.kind === 'column'; }).map(function (o) {
        var p = sourcePlanPoint([o.cx, o.cz], tr);
        return { cx: p[0], cy: p[1], baseZ: o.cy - o.hy + verticalOffset, width: o.hx * 2, depth: o.hz * 2, height: o.hy * 2 };
      });
    } else {
      if (!window.WallDetect) { toast('Модули стен/IFC недоступны'); return; }
      var pts = projectFloorBand(c);
      setPct(0.55, 'Резервная 2D-детекция стен…'); await yieldFrame();
      var plan = window.WallDetect.autoFloorPlan(pts, { minInliers: Math.max(10, Math.floor(pts.length * 0.01)) });
      if (!plan || !plan.walls || !plan.walls.length) { toast('Стены не обнаружены для IFC'); return; }
      walls = plan.walls.map(function (w) { return { a: sourcePlanPoint(w.a, tr), b: sourcePlanPoint(w.b, tr) }; });
      var ft = floorTop(c), verticalOffset2 = sourceVerticalOffset(tr);
      floors = [{ name: 'Level 0', ymin: ft[0] + verticalOffset2, ymax: ft[1] + verticalOffset2 }];
    }
    setPct(0.85, 'Формирование IFC-2x3…'); await yieldFrame();
    var ifc = window.IfcExport.exportIFC(walls, floors, {
      projectName: 'BIM Twin', wallThickness: 0.2,
      floorElevation: floors[0].ymin, columns: columns
    });
    download('model-' + Date.now() + '.ifc', ifc, 'application/x-step'); setPct(1, 'Готово');
    toast('IFC2X3: стены — ' + walls.length + ', колонны — ' + columns.length + ', этажи — 1; legacy-экспорт не кодирует проёмы/прочие объекты' + (tr && tr.t ? ' в исходных координатах' : ' в локальной системе'));
  }); }

  // ---- IFC4: модель Scan→BIM с вырезами проёмов и семействами объектов ----
  function opIFC4() { return run('Экспорт IFC4 Scan→BIM…', async function (setPct) {
    var c = needCloud(); if (!c) return;
    var S = window.Scan2BIM;
    if (!S || typeof S.toIFC !== 'function') { toast('Полный IFC4 требует модуль Scan→BIM'); return; }
    setPct(0.25, 'Реконструкция BIM-модели…'); await yieldFrame();
    var model = buildScan2BimModel(c);
    if (!model || !model.walls || !model.walls.length) { toast('IFC4: не удалось построить стеновую модель; проверьте покрытие облака'); return; }
    setPct(0.75, 'Запись IFC4 (стены, проёмы, плиты, объекты)…'); await yieldFrame();
    var t = T(), tr = t && t.getSourceTransform ? t.getSourceTransform() : null;
    var crs = t && t.getSourceCrs ? t.getSourceCrs() : null;
    var ifc = S.toIFC(model, {
      name: 'bim-twin-scan2bim-ifc4.ifc', project: 'BIM Twin',
      sourceTransform: tr, crsWkt: crs,
      includeBeams: false, includePipes: false
    });
    if (!ifc || !/FILE_SCHEMA\(\s*\(\s*'IFC4'\s*\)\s*\)/.test(ifc)) { toast('IFC4: сформированный файл не прошёл проверку заголовка схемы'); return; }
    if (!download('scan2bim-ifc4-' + Date.now() + '.ifc', ifc, 'application/x-step')) { toast('Не удалось сохранить IFC4'); return; }
    setPct(1, 'Готово');
    var geoLabel = tr && tr.t ? 'координаты исходного файла сохранены' : 'локальные координаты IFC';
    var crsLabel = tr && crs ? 'CRS/WKT включена' : (crs ? 'CRS пропущена: нет исходного преобразования' : 'CRS/WKT в источнике не задана');
    var withheld = [];
    if (model.stats.beamCount) withheld.push('балок ' + model.stats.beamCount);
    if (model.stats.pipeCount) withheld.push('труб ' + model.stats.pipeCount);
    if (model.stats.cableCount) withheld.push('кабелей ' + model.stats.cableCount);
    toast('IFC4 Scan→BIM: стены — ' + model.walls.length + ', проёмы — ' + (model.stats.openingCount || 0) + ' (геометрические вырезы), колонны — ' + (model.stats.columnCount || 0) + ', плиты — ' + (model.slabs || []).length + '; ' + geoLabel + ', ' + crsLabel + (withheld.length ? '; не включены без ручной проверки: ' + withheld.join(', ') : ''));
  }); }

  // ---- Спринт 8: Загрузчик Potree 2.0 ------------------------------------
  function opPotree() { return run('Potree 2.0…', async function (setPct) {
    var t = T(); if (!t || !t.pickGeomFile) { toast('Открытие файла доступно в десктоп-версии'); return; }
    if (!window.PotreeLoader) { toast('Модуль Potree недоступен'); return; }
    toast('Выберите metadata.json набора Potree 2.0…');
    var f = await t.pickGeomFile('.json,application/json');
    if (!f) { toast('Файл не выбран'); return; }
    var path = f.path || f.name || ''; var base = path.replace(/[\\/][^\\/]*$/, '');
    setPct(0.4, 'Чтение иерархии Potree…');
    var loader = new window.PotreeLoader();
    try {
      await loader.open('file://' + base);
      var s = loader.summary(); window.__potree = loader; setPct(1, 'Готово');
      toast('Potree 2.0: ' + nfmt(s.totalPoints) + ' точек, ' + s.totalNodes + ' узлов. Сводка загружена (потоковый рендер требует HTTP-доступа к набору).');
    } catch (e) {
      toast('Potree 2.0: не удалось открыть офлайн (' + (e && e.message || e) + '). Нужен HTTP-доступ к metadata.json/hierarchy.bin/octree.bin.');
    }
  }); }

  // ---- построение риббонов -----------------------------------------------
  function mkBtn(label, title, onClick) {
    var b = document.createElement('button');
    b.className = 'tbtn lx-bigbtn'; b.type = 'button'; b.dataset.lxbig = '1';
    b.title = title || label; b.setAttribute('aria-label', title || label);
    var i = document.createElement('span'); i.className = 'lx-bic'; i.textContent = '▤';
    var l = document.createElement('span'); l.className = 'lx-blabel'; l.textContent = label;
    b.append(i, l); b.addEventListener('click', function () { onClick(); });
    return b;
  }
  function ensureGroup(id, tab, label) {
    var host = document.querySelector('.toolbar .tbtns'); if (!host) return null;
    var g = document.getElementById(id); if (g) return g.querySelector('.tgrow');
    g = document.createElement('div'); g.id = id; g.className = 'tgroup'; g.dataset.lxtab = tab;
    var row = document.createElement('div'); row.className = 'tgrow';
    var cap = document.createElement('div'); cap.className = 'tglabel'; cap.textContent = label;
    g.append(row, cap); host.append(g); return row;
  }

  var built = false;
  function build() {
    if (built) return; var host = document.querySelector('.toolbar .tbtns'); if (!host) return; built = true;
    var views = ensureGroup('lxSprintViews', 'tool', 'Виды (X-Ray)');
    if (views) {
      views.append(mkBtn('Сверху', 'Вид сверху (орто, план)', function () { opView('top', 'Сверху'); }));
      views.append(mkBtn('Спереди', 'Вид спереди (орто, фасад)', function () { opView('front', 'Спереди'); }));
      views.append(mkBtn('Сбоку', 'Вид сбоку (орто)', function () { opView('side', 'Сбоку'); }));
      views.append(mkBtn('Изометрия', 'Изометрический вид', function () { opView('iso', 'Изометрия'); }));
      views.append(mkBtn('Орто', 'Ортографическая/перспективная проекция', opOrtho));
      views.append(mkBtn('Рентген', 'Просвечивание (X-Ray)', opXray));
    }
    var geo = ensureGroup('lxSprintGeo', 'app', 'Гео / BIM');
    if (geo) {
      geo.append(mkBtn('Стены→DXF', 'Детекция стен и план этажа (DXF)', opWalls));
      geo.append(mkBtn('DSM→GeoTIFF', 'Цифровая модель поверхности по максимуму высот (GeoTIFF)', opDSM));
      geo.append(mkBtn('DTM→GeoTIFF', 'Цифровая модель рельефа только по PMF-классу грунта (GeoTIFF)', opDTM));
      geo.append(mkBtn('Горизонтали', 'Горизонтали рельефа (DXF)', opContours));
      geo.append(mkBtn('Грунт PMF', 'Прогрессивный морфологический фильтр низкой поверхности; параметры cellSize/threshold/maxSlope доступны через Terrain.csfClassify', opGround));
      geo.append(mkBtn('Классы→LAS', 'Экспорт LAS 1.4 с ASPRS-классами 2 (грунт) и 1 (прочее)', opGroundLAS));
      geo.append(mkBtn('IFC-2x3', 'Совместимость IFC2X3: стены и колонны; без проёмов/прочих объектов', opIFC));
      geo.append(mkBtn('IFC4 BIM', 'Scan→BIM: стены, проёмы, плиты и колонны; автоматические MEP/балки не включаются без ручной проверки', opIFC4));
      geo.append(mkBtn('Геопривязка', 'Геопривязка по GCP (Гельмерт 3D)', opGeoref));
      geo.append(mkBtn('Шаблон GCP', 'Скачать шаблон GCP CSV', opGcpTemplate));
      geo.append(mkBtn('Potree 2.0', 'Открыть набор Potree 2.0', opPotree));
    }
    try { console.log('[LixelStudio sprints-ext] риббоны спринтов 1/3/4/5/6/8 готовы · v1151'); } catch (e) {}
  }

  function boot() {
    ensureXrayBridge(); build();
    var tries = 0; var iv = setInterval(function () { tries++; ensureXrayBridge(); if (built || tries > 40) { clearInterval(iv); return; } build(); }, 250);
  }

  if (typeof window !== 'undefined') {
    window.__lxSprintsExt = {
      build: build, ensureXrayBridge: ensureXrayBridge,
      ops: { opView: opView, opOrtho: opOrtho, opXray: opXray, opWalls: opWalls, opDSM: opDSM, opContours: opContours, opGround: opGround, opGeoref: opGeoref, opGcpTemplate: opGcpTemplate, opIFC: opIFC, opIFC4: opIFC4, opPotree: opPotree }
    };
    window.addEventListener('lx-pctools-ready', boot);
    window.addEventListener('lx-viewer-ready', ensureXrayBridge);
    if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(boot, 350);
    else window.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 350); });
  }
})();
