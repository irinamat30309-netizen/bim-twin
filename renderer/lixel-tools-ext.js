/* lixel-tools-ext.js — v1151
 * UI-обвязка риббонов «Инструмент» и «Приложение» (паритет с LixelStudio).
 * Подключает кнопки к чистым функциям PCEdit + MultiCloud/TinVolume/ExportHub
 * через мост window.__pcTools. Показывает счётчик выполнения в процентах.
 * Честные сообщения там, где нужен внешний движок (LAS→RCP, Удалённая передача).
 */
(function () {
  'use strict';
  var UP = 1; // вьюер Y-up: высота = ось Y (index 1)
  var busy = false;

  function T() { return window.__pcTools || null; }
  function toast(m) { var t = T(); if (t && t.toast) t.toast(m); else try { console.log('[tools-ext]', m); } catch (e) {} }
  function pcedit() { return window.PCEdit || null; }

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

  function nfmt(n) { try { return Number(n).toLocaleString('ru-RU'); } catch (e) { return '' + n; } }
  function m3(v) { return (Math.round(v * 1000) / 1000).toLocaleString('ru-RU') + ' м³'; }

  // Скачивание сформированного файла (blob) — самодостаточно.
  function download(name, data, mime) {
    try {
      var blob = (data instanceof Blob) ? data : new Blob([data], { type: (mime || 'application/octet-stream') + ';charset=utf-8' });
      var url = URL.createObjectURL(blob); var a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
      return true;
    } catch (e) { toast('Не удалось сформировать файл: ' + (e && e.message || e)); return false; }
  }

  // Обёртка с полосой прогресса %. work(setPct) — setPct(frac 0..1, label?).
  async function run(label, work) {
    if (busy) { toast('Идёт обработка — дождитесь завершения'); return; }
    var t = T(); busy = true;
    var stop = (t && t.beginProgress) ? t.beginProgress(label) : { set: function () {}, text: function () {} };
    function setPct(frac, lab) { try { if (stop && stop.set) stop.set(frac, lab); } catch (e) {} }
    try { setPct(0.02, label); await work(setPct); }
    catch (e) { console.warn('tools-ext', e); toast('Ошибка: ' + (e && e.message || e)); }
    finally { busy = false; if (stop) { try { stop(); } catch (e) {} } }
  }

  function yieldFrame() { return new Promise(function (r) { setTimeout(r, 0); }); }

  // Загрузить второе облако из файла (для Объединить/Наложение/Сравнение объёмов).
  async function pickSecondCloud(setPct, label, opts) {
    var t = T(); if (!t || !t.pickGeomFile || !t.api || !t.api()) { toast('Выбор файла доступен в десктоп-версии'); return null; }
    toast(label || 'Выберите второе облако…');
    var f = await t.pickGeomFile('.ply,.las,.laz,.e57,.ptx,.pcd,.xyz,.pts');
    if (!f || !f.path) { toast('Файл не выбран'); return null; }
    setPct && setPct(0.3, 'Чтение файла…');
    var pr = await t.api().parseCloud(f.path);
    if (!pr || !pr.ok || !pr.pos) { toast('Не удалось прочитать облако'); return null; }
    var base = t.getSourceTransform && t.getSourceTransform(), other = pr.meta && pr.meta.srcXform, points = pr.pos;
    var baseCrs=t.getSourceCrs?t.getSourceCrs():null,otherCrs=pr.meta&&pr.meta.crsWkt||null;
    var crsStatus=window.Georef&&window.Georef.compareCrsWkt?window.Georef.compareCrsWkt(baseCrs,otherCrs):'unknown';
    var hasTransforms=!!(base&&other&&base.axis&&other.axis&&base.t&&other.t),confirmedUnknown=false;
    if(opts&&opts.requireComparable){
      if(crsStatus==='different'){
        toast('Операция отменена: CRS облаков различаются. Сначала преобразуйте оба облака в одну систему координат.');
        return null;
      }
      if(crsStatus!=='same'||!hasTransforms){
        var why=crsStatus==='unknown'?'CRS отсутствует или не удалось однозначно сопоставить WKT':'не удалось подтвердить общий source-transform';
        var question='Сопоставимость координат не подтверждена ('+why+'). Продолжайте только если оба облака уже находятся в одной системе координат и совпадающем datum. Выполнить операцию?';
        if(typeof window.confirm!=='function'||!window.confirm(question)){toast('Операция отменена: сначала подтвердите общую систему координат или выполните геопривязку');return null;}
        confirmedUnknown=true;
      }
    }
    if (base && other && base.axis && other.axis && base.t && other.t) {
      var n=points.length/3, world=new Float64Array(n*3), aligned=new Float32Array(n*3), a=other.t,b=base.t;
      for(var i=0;i<n;i++){
        var x=points[i*3],y=points[i*3+1],z=points[i*3+2],sx,sy,sz;
        if(other.axis==='zup'){sx=x+a[0];sy=-z+a[1];sz=y+a[2];}else{sx=x+a[0];sy=y+a[1];sz=z+a[2];}
        world[i*3]=sx;world[i*3+1]=sy;world[i*3+2]=sz;
        if(base.axis==='zup'){aligned[i*3]=sx-b[0];aligned[i*3+1]=sz-b[2];aligned[i*3+2]=-(sy-b[1]);}else{aligned[i*3]=sx-b[0];aligned[i*3+1]=sy-b[1];aligned[i*3+2]=sz-b[2];}
      }
      points=aligned;
    }
    return { pos: points, col: pr.col || null, count: pr.meta && pr.meta.points || pr.pos.length / 3, path: f.path, meta: pr.meta, frameCheck:{crsStatus:crsStatus,transformsApplied:hasTransforms,confirmedUnknown:confirmedUnknown} };
  }

  // ---------- Инструмент ----------
  function opResample() { return run('Ресэмплирование…', async function (setPct) {
    var c = needCloud(); if (!c) return; var P = pcedit(); if (!P) return;
    var vv=T().viewer&&T().viewer(), spacing=(vv&&vv.base&&vv.base[0]&&vv.base[0]._spacing)||0.01; var def = Math.max(0.005, Math.min(0.03, spacing * 2));
    var raw = window.prompt('Размер вокселя (м). Точки в одном вокселе будут объединены:', def.toFixed(3));
    if (raw === null) return;
    var voxel = Number(String(raw).replace(',', '.'));
    if (!(voxel > 0 && isFinite(voxel))) { toast('Введите положительный размер вокселя в метрах'); return; }
    setPct(0.3, 'Понижение плотности…'); await yieldFrame();
    var r = P.voxelDownsample(c, { voxel: voxel }); setPct(0.8, 'Загрузка результата…'); await yieldFrame();
    T().loadCloud({ pos: r.pos, col: r.col, count: r.kept }, 'resample', { operation: 'cloud.resample', parameters: { voxel: r.voxel, removed: r.removed, kept: r.kept } }); setPct(1, 'Готово');
    toast('Ресэмплирование: ' + nfmt(r.kept) + ' точек (удалено ' + nfmt(r.removed) + ', воксель ' + r.voxel.toFixed(3) + ' м)');
  }); }

  function opSmooth() { return run('Сглаживание…', async function (setPct) {
    var c = needCloud(); if (!c) return; var P = pcedit(); if (!P) return;
    setPct(0.3, 'MLS-проекция на локальные плоскости…'); await yieldFrame();
    var r = P.smoothMLS(c, { strength: 0.7 }); setPct(0.85, 'Загрузка результата…'); await yieldFrame();
    T().loadCloud({ pos: r.pos, col: r.col, count: r.count }, 'smooth', { operation: 'cloud.smooth', parameters: { algorithm: 'MLS', strength: 0.7, moved: r.moved, points: r.count } }); setPct(1, 'Готово');
    toast('Сглаживание: смещено ' + nfmt(r.moved) + ' из ' + nfmt(r.count) + ' точек');
  }); }

  function refineWall(plane,cloud){
    var p=cloud.pos,n=cloud.count,N=plane.normal,d=plane.d,bounds=[ [Infinity,-Infinity],[Infinity,-Infinity],[Infinity,-Infinity] ];
    for(var i=0;i<n;i++)for(var a=0;a<3;a++){var v=p[i*3+a];if(v<bounds[a][0])bounds[a][0]=v;if(v>bounds[a][1])bounds[a][1]=v;}
    var tol=plane.tol||Math.max(0.001,Math.hypot(bounds[0][1]-bounds[0][0],bounds[1][1]-bounds[1][0],bounds[2][1]-bounds[2][0])*0.004),step=Math.max(1,Math.ceil(n/50000),Math.ceil(n/50000));
    var sx=0,sy=0,sz=0,m=0;
    for(var i=0;i<n;i+=step){var x=p[i*3],y=p[i*3+1],z=p[i*3+2];if(Math.abs(N[0]*x+N[1]*y+N[2]*z+d)<=tol){sx+=x;sy+=y;sz+=z;m++;}}
    if(m<3)return plane;var c=[sx/m,sy/m,sz/m],A=[[0,0,0],[0,0,0],[0,0,0]];
    for(var i=0;i<n;i+=step){var x=p[i*3],y=p[i*3+1],z=p[i*3+2];if(Math.abs(N[0]*x+N[1]*y+N[2]*z+d)>tol)continue;var v=[x-c[0],y-c[1],z-c[2]];for(var a=0;a<3;a++)for(var b=0;b<3;b++)A[a][b]+=v[a]*v[b];}
    var V=[[1,0,0],[0,1,0],[0,0,1]];
    for(var it=0;it<18;it++){var u=0,v=1,max=Math.abs(A[0][1]);if(Math.abs(A[0][2])>max){u=0;v=2;max=Math.abs(A[0][2]);}if(Math.abs(A[1][2])>max){u=1;v=2;max=Math.abs(A[1][2]);}if(max<1e-12)break;var phi=0.5*Math.atan2(2*A[u][v],A[v][v]-A[u][u]),co=Math.cos(phi),si=Math.sin(phi),au=A[u][u],av=A[v][v],auv=A[u][v];A[u][u]=co*co*au-2*si*co*auv+si*si*av;A[v][v]=si*si*au+2*si*co*auv+co*co*av;A[u][v]=A[v][u]=0;for(var k=0;k<3;k++)if(k!==u&&k!==v){var ku=A[k][u],kv=A[k][v];A[k][u]=A[u][k]=co*ku-si*kv;A[k][v]=A[v][k]=si*ku+co*kv;}for(var k=0;k<3;k++){var ku=V[k][u],kv=V[k][v];V[k][u]=co*ku-si*kv;V[k][v]=si*ku+co*kv;}}
    var ix=0;if(A[1][1]<A[ix][ix])ix=1;if(A[2][2]<A[ix][ix])ix=2;var q=[V[0][ix],V[1][ix],V[2][ix]],l=Math.hypot(q[0],q[1],q[2])||1;q=q.map(function(x){return x/l;});if(q[0]*N[0]+q[1]*N[1]+q[2]*N[2]<0)q=q.map(function(x){return-x;});
    return Object.assign({},plane,{normal:q,d:-(q[0]*c[0]+q[1]*c[1]+q[2]*c[2]),refinedCount:m});
  }

  function opVertical() { return run('Вертикальное выравнивание…', async function (setPct) {
    var c = needCloud(); if (!c) return; var P = pcedit(); if (!P || !P.dominantPlane) return;
    setPct(0.35, 'Поиск вертикальной стены…'); await yieldFrame();
    var plane = P.dominantPlane(c, { orientation: 'wall', upAxis: 1 }); if (!plane || !plane.normal) { toast('Вертикальная плоскость не найдена'); return; }
    plane=refineWall(plane,c); var nx = plane.normal[0], nz = plane.normal[2], len = Math.hypot(nx, nz); if (len < 1e-8) { toast('Невозможно определить горизонтальное направление стены'); return; }
    var angle = -Math.atan2(nz, nx), co = Math.cos(angle), si = Math.sin(angle), b = plane.bounds || null;
    var mn=[Infinity,Infinity,Infinity],mx=[-Infinity,-Infinity,-Infinity];
    for(var i=0;i<c.count;i++)for(var a=0;a<3;a++){var v=c.pos[i*3+a];if(v<mn[a])mn[a]=v;if(v>mx[a])mx[a]=v;}
    var ox=(mn[0]+mx[0])/2,oz=(mn[2]+mx[2])/2,out=c.pos.slice();
    for(var i=0;i<c.count;i++){var x=c.pos[i*3]-ox,z=c.pos[i*3+2]-oz;out[i*3]=co*x-si*z+ox;out[i*3+2]=si*x+co*z+oz;}
    T().loadCloud({pos:out,col:c.col,count:c.count},'vertical-align',{operation:'cloud.vertical-align',parameters:{rotationRadians:angle,rotationDegrees:angle*180/Math.PI,pivot:[ox,oz],planeNormal:plane.normal}}); setPct(1,'Готово'); toast('Вертикаль: разворот по азимуту на '+(angle*180/Math.PI).toFixed(2)+'°; наклон по высоте сохранён.');
  }); }

  function opLevel(orientation, up, label) { return run(label + '…', async function (setPct) {
    var c = needCloud(); if (!c) return; var P = pcedit(); if (!P) return;
    setPct(0.4, 'Поиск доминантной плоскости…'); await yieldFrame();
    var r = P.levelCloud(c, { orientation: orientation, up: up }); await yieldFrame();
    if (!r.applied) { toast('Не удалось определить плоскость для выравнивания'); return; }
    setPct(0.85, 'Поворот облака…'); await yieldFrame();
    T().loadCloud({ pos: r.pos, col: r.col, count: r.count }, 'level', { operation: 'cloud.level', parameters: { orientation: orientation, up: up, angleDegrees: r.angleDeg, points: r.count } }); setPct(1, 'Готово');
    toast(label + ': поворот на ' + r.angleDeg.toFixed(2) + '°');
  }); }

  function opMerge() { return run('Объединить…', async function (setPct) {
    var c = needCloud(); if (!c) return; var P = pcedit(); if (!P) return;
    var c2 = await pickSecondCloud(setPct, 'Выберите облако для объединения…', {requireComparable:true}); if (!c2) return;
    setPct(0.7, 'Слияние облаков…'); await yieldFrame();
    var r = P.mergeClouds([c, c2]); setPct(0.9, 'Загрузка результата…'); await yieldFrame();
    T().loadCloud({ pos: r.pos, col: r.col, count: r.count }, 'merge', { operation: 'cloud.merge', parameters: { sourceCloud: c2.path || null, sourceCount: c2.count, outputCount: r.count, frameCheck: c2.frameCheck || null } }); setPct(1, 'Готово');
    toast('Объединено ' + r.clouds + ' облака: ' + nfmt(r.count) + ' точек');
  }); }

  function opOverlay() { return run('Наложение…', async function (setPct) {
    var c = needCloud(); if (!c) return; var P = pcedit(); if (!P) return;
    var c2 = await pickSecondCloud(setPct, 'Выберите облако для наложения…', {requireComparable:true}); if (!c2) return;
    setPct(0.7, 'Совмещение (наложение)…'); await yieldFrame();
    // Наложение = совместный показ обоих облаков (суперпозиция без прореживания).
    var r = P.mergeClouds([c, c2]); setPct(0.9, 'Загрузка…'); await yieldFrame();
    T().loadCloud({ pos: r.pos, col: r.col, count: r.count }, 'overlay', { operation: 'cloud.overlay', parameters: { sourceCloud: c2.path || null, sourceCount: c2.count, outputCount: r.count, frameCheck: c2.frameCheck || null } }); setPct(1, 'Готово');
    toast('Наложение: показаны оба облака (' + nfmt(r.count) + ' точек). Для точного совмещения используйте «Совмещение» (ICP).');
  }); }

  function opExportE57() { return run('Экспорт в E57…', async function (setPct) {
    var c = needCloud(); if (!c) return; var EH = window.ExportHub; if (!EH || !EH.exportE57) { toast('Модуль экспорта недоступен'); return; }
    setPct(0.5, 'Формирование бинарного E57 (ASTM)…'); await yieldFrame();
    var src = (T().getSourceCloud && T().getSourceCloud()) || c;
    var pre = EH.preflightExport ? EH.preflightExport('e57', src) : { ok:true, warnings:[] };
    if (!pre.ok) { toast('Экспорт отменён: ' + (pre.errors || []).join('; ')); return; }
    var e57 = EH.exportE57(src.pos, src.count || c.count, { step: 1, col: src.col || c.col, intensity:src.intensity||null,
      crs: (src.meta && src.meta.crsWkt) || (T().getSourceCrs && T().getSourceCrs()) || '',
      scans: src.meta && src.meta.scans || null }); setPct(0.9, 'Сохранение файла…');
    download('cloud-' + Date.now() + '.e57', e57, 'application/octet-stream'); setPct(1, 'Готово');
    toast('Экспортировано в E57: ' + nfmt(c.count) + ' точек' + (pre.warnings&&pre.warnings.length?' · Предупреждения: '+pre.warnings.join('; '):''));
  }); }

  function opExportRCP() {
    // Честно: формат Autodesk RCP закрыт и требует Autodesk ReCap (внешний движок).
    toast('LAS→RCP требует Autodesk ReCap (внешний движок) и недоступен офлайн. Экспортирую в открытый E57/PLY вместо RCP.');
    return opExportE57();
  }

  function opWriteData() { return run('Запись данных…', async function (setPct) {
    var c = needCloud(); if (!c) return; var P = pcedit(); if (!P) return;
    setPct(0.3, 'Кодирование PLY (binary)…');
    var buf, src=(T().getSourceCloud&&T().getSourceCloud())||c, EH=window.ExportHub;
    if (EH && EH.exportPLYAsync) { buf=await EH.exportPLYAsync(src,function(f){setPct(0.3+0.5*f,'Кодирование PLY…');}); }
    else if (P.toPLYBinaryAsync) { buf = await P.toPLYBinaryAsync(c, { onProgress: function (f) { setPct(0.3 + 0.5 * f, 'Кодирование PLY…'); } }); }
    else { buf = P.toPLYBinary(c); }
    setPct(0.9, 'Сохранение файла…');
    download('cloud-' + Date.now() + '.ply', buf, 'application/octet-stream'); setPct(1, 'Готово');
    toast('Записано облако: ' + nfmt(c.count) + ' точек (PLY)');
  }); }

  // ---------- Приложение ----------
  function robustRange(pos,count,axis){var stride=Math.max(1,Math.ceil(count/50000)),a=[];for(var i=0;i<count;i+=stride){var v=pos[i*3+axis];if(isFinite(v))a.push(v);}a.sort(function(x,y){return x-y;});if(!a.length)return[0,0];return[a[Math.floor((a.length-1)*0.002)],a[Math.ceil((a.length-1)*0.998)]];}

  function opVolume() { return run('Расчёт объёма…', async function (setPct) {
    var c = needCloud(); if (!c) return; var P = pcedit(); if (!P) return;
    // Объём над базовой плоскостью (минимальная высота): сетка верхней поверхности.
    setPct(0.4, 'Построение сетки поверхности…'); await yieldFrame();
    var pos = c.pos, n = c.count, a0 = (UP + 1) % 3, a1 = (UP + 2) % 3;
    var r0=robustRange(pos,n,a0),r1=robustRange(pos,n,a1),rh=robustRange(pos,n,UP);
    var d0 = r0[1] - r0[0], d1 = r1[1] - r1[0]; var cell = (Math.hypot(d0, d1) || 1) / 128; if (cell <= 0) cell = 1e-3; var inv = 1 / cell;
    var g0 = Math.max(1, Math.floor(d0 * inv) + 1), g1 = Math.max(1, Math.floor(d1 * inv) + 1);
    var top = new Float64Array(g0 * g1), has = new Uint8Array(g0 * g1); for (var q = 0; q < g0 * g1; q++) top[q] = -Infinity;
    for (var i = 0; i < n; i++) { var x=pos[i*3+a0],z=pos[i*3+a1],h=pos[i*3+UP];if(x<r0[0]||x>r0[1]||z<r1[0]||z>r1[1]||h<rh[0]||h>rh[1])continue;var u=Math.floor((x-r0[0])*inv);if(u<0)u=0;if(u>=g0)u=g0-1;var w=Math.floor((z-r1[0])*inv);if(w<0)w=0;if(w>=g1)w=g1-1;var ci=w*g0+u;if(h>top[ci]){top[ci]=h;has[ci]=1;} }
    setPct(0.8, 'Интегрирование объёма…'); await yieldFrame();
    var base = rh[0], area = cell * cell, vol = 0, cells = 0;
    for (var ci = 0; ci < g0 * g1; ci++) { if (!has[ci]) continue; cells++; vol += (top[ci] - base) * area; }
    setPct(1, 'Готово');
    toast('Объём над базой: ' + m3(vol) + ' (сетка ' + cell.toFixed(3) + ' м, ячеек ' + nfmt(cells) + ')');
  }); }

  function trimVolumeOutliers(c){var ranges=[0,1,2].map(function(a){return robustRange(c.pos,c.count,a);}),keep=0,mask=new Uint8Array(c.count);for(var i=0;i<c.count;i++){var ok=true;for(var a=0;a<3;a++){var v=c.pos[i*3+a];if(v<ranges[a][0]||v>ranges[a][1]){ok=false;break;}}if(ok){mask[i]=1;keep++;}}if(keep===c.count)return{cloud:c,removed:0};var p=new Float32Array(keep*3),col=c.col?new c.col.constructor(keep*3):null,j=0;for(var i=0;i<c.count;i++)if(mask[i]){p.set(c.pos.subarray(i*3,i*3+3),j*3);if(col)col.set(c.col.subarray(i*3,i*3+3),j*3);j++;}return{cloud:{pos:p,col:col,count:keep},removed:c.count-keep};}

  function opClosedVolume() { return run('Закрытый объём…', async function (setPct) {
    var c = needCloud(); if (!c) return; var P = pcedit(); if (!P) return;
    setPct(0.5, 'Столбцовая заливка объёма…'); await yieldFrame();
    var clipped=trimVolumeOutliers(c),r = P.closedVolume(clipped.cloud, { up: UP }); setPct(1, 'Готово');
    toast('Закрытый объём: ' + m3(r.volume) + ' (воксель ' + r.voxel.toFixed(3) + ' м, столбцов ' + nfmt(r.columns) + (clipped.removed?' · исключены крайние точки: '+nfmt(clipped.removed):'') + ')');
  }); }

  function opCompareVolumes() { return run('Сравнение объёмов…', async function (setPct) {
    var c = needCloud(); if (!c) return; var P = pcedit(); if (!P) return;
    var c2 = await pickSecondCloud(setPct, 'Выберите второе облако для сравнения…', {requireComparable:true}); if (!c2) return;
    setPct(0.7, 'Расчёт выемки/насыпи…'); await yieldFrame();
    var a=trimVolumeOutliers(c),b=trimVolumeOutliers(c2),r = P.compareVolumes(a.cloud, b.cloud, { up: UP }); setPct(1, 'Готово');
    toast('Сравнение: насыпь ' + m3(r.fill) + ', выемка ' + m3(r.cut) + ', баланс ' + m3(r.net) + ' (ячеек ' + nfmt(r.cells) + (a.removed+b.removed?' · исключены крайние точки: '+nfmt(a.removed+b.removed):'') + ')');
  }); }

  function opMesh() { return run('Mesh…', async function (setPct) {
    var c = needCloud(); if (!c) return; var P = pcedit(); if (!P) return;
    setPct(0.4, 'Триангуляция поверхности (heightfield)…'); await yieldFrame();
    var mesh = P.meshHeightGrid(c, { upAxis: UP, resolution: 160 }); setPct(0.8, 'Экспорт OBJ…'); await yieldFrame();
    var obj = P.meshToOBJ(mesh); download('mesh-' + Date.now() + '.obj', obj, 'text/plain'); setPct(1, 'Готово');
    var tris = mesh.indices.length / 3, verts = mesh.vertices.length / 3;
    toast('Mesh: ' + nfmt(tris) + ' треуг., ' + nfmt(verts) + ' вершин (OBJ сохранён)');
  }); }

  function opRemote() {
    // Честно: «Удалённая передача» LixelStudio использует облачный сервис XGrids.
    toast('Удалённая передача LixelStudio недоступна офлайн. Готовлю облако к передаче (экспорт PLY) — файл можно отправить вручную.');
    return opWriteData();
  }

  // ---------- построение риббонов ----------
  function mkBtn(label, title, onClick) {
    var b = document.createElement('button');
    b.className = 'tbtn lx-bigbtn'; b.type = 'button'; b.dataset.lxbig = '1';
    b.title = title || label; b.setAttribute('aria-label', title || label);
    var i = document.createElement('span'); i.className = 'lx-bic'; i.textContent = '▧';
    var l = document.createElement('span'); l.className = 'lx-blabel'; l.textContent = label;
    b.append(i, l); b.addEventListener('click', function () { onClick(); });
    return b;
  }

  function ensureGroup(id, tab, label) {
    var host = document.querySelector('.toolbar .tbtns');
    if (!host) return null;
    var g = document.getElementById(id);
    if (g) return g.querySelector('.tgrow');
    g = document.createElement('div'); g.id = id; g.className = 'tgroup'; g.dataset.lxtab = tab;
    var row = document.createElement('div'); row.className = 'tgrow';
    var cap = document.createElement('div'); cap.className = 'tglabel'; cap.textContent = label;
    g.append(row, cap); host.append(g); return row;
  }

  var built = false;
  function build() {
    if (built) return; var host = document.querySelector('.toolbar .tbtns'); if (!host) return; built = true;
    var inst = ensureGroup('lxToolExtInstrument', 'tool', 'Инструмент');
    if (inst) {
      inst.append(mkBtn('Ресэмпл.', 'Ресэмплирование (понижение плотности, воксель)', opResample));
      inst.append(mkBtn('Сглаживание', 'Сглаживание MLS (проекция на локальную плоскость)', opSmooth));
      inst.append(mkBtn('Выравнивание', 'Выравнивание по доминантной плоскости пола', function () { opLevel('floor', [0, 1, 0], 'Выравнивание'); }));
      inst.append(mkBtn('Горизонт.', 'Сделать пол горизонтальным', function () { opLevel('floor', [0, 1, 0], 'Горизонтальный'); }));
      inst.append(mkBtn('Вертикаль', 'Сделать стену вертикальной', function () { opVertical(); }));
      inst.append(mkBtn('Объединить', 'Объединить с другим облаком', opMerge));
      inst.append(mkBtn('Наложение', 'Наложить (суперпозиция) второе облако', opOverlay));
      inst.append(mkBtn('Экспорт E57', 'Экспорт текущего облака в E57 (ASTM)', opExportE57));
      inst.append(mkBtn('LAS→RCP', 'Экспорт в Autodesk RCP (нужен ReCap)', opExportRCP));
      inst.append(mkBtn('Запись', 'Запись данных: экспорт облака (PLY)', opWriteData));
    }
    var app = ensureGroup('lxToolExtApp', 'app', 'Приложение+');
    if (app) {
      app.append(mkBtn('Объём', 'Расчёт объёма над базовой плоскостью', opVolume));
      app.append(mkBtn('Сравн. объёмов', 'Сравнение объёмов (выемка/насыпь)', opCompareVolumes));
      app.append(mkBtn('Закрытый объём', 'Закрытый (замкнутый) объём', opClosedVolume));
      app.append(mkBtn('Mesh', 'Построение и экспорт поверхности (OBJ)', opMesh));
      app.append(mkBtn('Удал. передача', 'Удалённая передача (экспорт для отправки)', opRemote));
    }
    try { console.log('[LixelStudio tools-ext] риббоны Инструмент/Приложение готовы · v1151'); } catch (e) {}
  }

  function boot() {
    build();
    // повтор, если тулбар строится позже
    var tries = 0; var iv = setInterval(function () { tries++; if (built || tries > 40) { clearInterval(iv); return; } build(); }, 250);
  }
  if (typeof window !== 'undefined') {
    window.__lxToolsExt = { build: build, ops: { opResample: opResample, opSmooth: opSmooth, opLevel: opLevel, opMerge: opMerge, opOverlay: opOverlay, opExportE57: opExportE57, opWriteData: opWriteData, opVolume: opVolume, opClosedVolume: opClosedVolume, opCompareVolumes: opCompareVolumes, opMesh: opMesh } };
    window.addEventListener('lx-pctools-ready', boot);
    if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(boot, 300);
    else window.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 300); });
  }
})();
