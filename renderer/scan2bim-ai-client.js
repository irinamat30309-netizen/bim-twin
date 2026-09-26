/*
 * scan2bim-ai-client.js — v1170
 * Единая панель «Скан → BIM (1:1)».
 *
 * ГЛАВНОЕ (v1170): сервер поднимается АВТОМАТИЧЕСКИ вместе с приложением
 * (Electron main → scan2bim-server.js) — запускать ничего вручную не нужно.
 * Клиент нормализует localhost → 127.0.0.1 (обход IPv6 ::1) и разрешён в CSP.
 * BIM также строится ПРЯМО В ПРИЛОЖЕНИИ встроенным
 * геометрическим движком window.Scan2BIM — без сервера, без отдельных папок.
 * Серверный ИИ-движок (GPU) — ОПЦИОНАЛЬНЫЙ апгрейд качества:
 *   • режим auto — пробует сервер, при любой ошибке автоматически строит офлайн;
 *   • режим geom — только встроенный движок (офлайн);
 *   • режим ai   — только сервер (GPU).
 * URL сервера хранится в localStorage['s2bAiServerUrl'].
 * window.__lxScan2BIMAI = { open, close, reconstruct, buildLocal, health, getServer, setServer, buildPLY }.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  var DEFAULT_URL = 'http://localhost:8765';
  function getServer() { try { return localStorage.getItem('s2bAiServerUrl') || DEFAULT_URL; } catch (e) { return DEFAULT_URL; } }
  function setServer(u) { try { localStorage.setItem('s2bAiServerUrl', u); } catch (e) {} }
  // localhost может резолвиться в IPv6 (::1), а сервер слушает IPv4 127.0.0.1 → принудительно IPv4.
  function resolveHost(u) { return String(u || '').replace('://localhost', '://127.0.0.1'); }

  function mainV() { try { if (window.__pcTools && window.__pcTools.viewer) return window.__pcTools.viewer(); } catch (e) {} return window.__viewer || null; }
  function toast(msg, err) { try { if (window.__toast) return window.__toast(msg, err ? 'error' : 'info'); } catch (e) {} console[err ? 'error' : 'log']('[scan2bim-ai] ' + msg); }
  function el(tag, css, html) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (html != null) e.innerHTML = html; return e; }
  function bcss(bg) { return 'display:inline-flex;align-items:center;gap:6px;justify-content:center;padding:7px 10px;margin:3px 3px 0 0;border:none;border-radius:8px;background:' + bg + ';color:#fff;font:600 12px/1.1 system-ui,Segoe UI,Arial;cursor:pointer'; }
  function nfmt(x, d) { return (x == null || !isFinite(x)) ? '—' : (+x).toFixed(d == null ? 2 : d); }
  function nowMs() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }

  function collectPoints(v) {
    if (!v || !v.base) return null;
    var chunks = [], total = 0;
    for (var i = 0; i < v.base.length; i++) { var o = v.base[i]; if (o && o.points && o.pos && o.pos.length) { chunks.push(o.pos); total += o.pos.length; } }
    if (!total) return null;
    if (chunks.length === 1) return chunks[0];
    var out = new Float32Array(total), off = 0;
    for (var c = 0; c < chunks.length; c++) { out.set(chunks[c], off); off += chunks[c].length; }
    return out;
  }

  // v1178: RGB tochek dlya klassifikatsii materiala. Vozvrashaet null esli tsvet ne u vseh chankov.
  var __s2bCols = null;
  function collectColors(v) {
    if (!v || !v.base) return null;
    var chunks = [], total = 0, posTotal = 0, ok = true;
    for (var i = 0; i < v.base.length; i++) { var o = v.base[i]; if (o && o.points && o.pos && o.pos.length) { posTotal += o.pos.length; if (o.col && o.col.length === o.pos.length) { chunks.push(o.col); total += o.col.length; } else { ok = false; } } }
    if (!ok || !total || total !== posTotal) return null;
    if (chunks.length === 1) return chunks[0];
    var out = new Float32Array(total), off = 0;
    for (var c = 0; c < chunks.length; c++) { out.set(chunks[c], off); off += chunks[c].length; }
    return out;
  }

  // Строит binary_little_endian PLY (float x/y/z) из Float32Array с чередующимися xyz.
  function buildPLY(xyz) {
    var n = (xyz.length / 3) | 0;
    var header = 'ply\nformat binary_little_endian 1.0\ncomment BIM Twin AI client export\n' +
      'element vertex ' + n + '\nproperty float x\nproperty float y\nproperty float z\nend_header\n';
    var henc = new TextEncoder().encode(header);
    var buf = new ArrayBuffer(henc.length + n * 12);
    var u8 = new Uint8Array(buf); u8.set(henc, 0);
    var dv = new DataView(buf, henc.length);
    for (var i = 0; i < n * 3; i++) dv.setFloat32(i * 4, xyz[i], true);
    return new Blob([buf], { type: 'application/octet-stream' });
  }

  function b64ToBlob(b64, mime) {
    var bin = atob(b64); var len = bin.length; var arr = new Uint8Array(len);
    for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime || 'application/octet-stream' });
  }
  function downloadBlob(blob, name) {
    try {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 400);
    } catch (e) { toast('Не удалось сохранить: ' + (e && e.message || e), true); }
  }

  var lastResult = null;  // результат сервера (base64 IFC/OBJ)
  var lastModel = null;   // модель встроенного движка (window.Scan2BIM)
  var __s2bServerReady = false; // v1182: podnyat li AI-server (obnovlyaetsya v autoHealthPoll)

  // ===================== ПРЕДПРОСМОТР В 3D (для офлайн-модели) =====================
  function boxEdgesXform(cx, cy, cz, ax, ay, hx, hy, hz, out) {
    var nx = -ay, nz = ax;
    function P(sx, sy, sz) { return [cx + ax * sx * hx + nx * sz * hz, cy + sy * hy, cz + ay * sx * hx + nz * sz * hz]; }
    var c = [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1)];
    var E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    for (var i = 0; i < E.length; i++) { var a = c[E[i][0]], b = c[E[i][1]]; out.push(a[0], a[1], a[2], b[0], b[1], b[2]); }
  }
  // v1174: сплошной бокс (треугольники + нормали) — для «сплошной модели» поверх облака (как в FARO).
  function boxSolidXform(cx, cy, cz, ax, ay, hx, hy, hz, pos, nor) {
    var nx = -ay, nz = ax;
    function P(sx, sy, sz) { return [cx + ax * sx * hx + nx * sz * hz, cy + sy * hy, cz + ay * sx * hx + nz * sz * hz]; }
    var c = [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1)];
    var F = [[[1, 2, 6, 5], [ax, 0, ay]], [[0, 3, 7, 4], [-ax, 0, -ay]], [[4, 5, 6, 7], [0, 1, 0]], [[0, 1, 2, 3], [0, -1, 0]], [[2, 3, 7, 6], [nx, 0, nz]], [[0, 1, 5, 4], [-nx, 0, -nz]]];
    for (var f = 0; f < F.length; f++) {
      var q = F[f][0], n = F[f][1], A = c[q[0]], B = c[q[1]], C = c[q[2]], D = c[q[3]];
      pos.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2], A[0], A[1], A[2], C[0], C[1], C[2], D[0], D[1], D[2]);
      for (var t = 0; t < 6; t++) nor.push(n[0], n[1], n[2]);
    }
  }
  function cylinderSolid(a, b, r, sides, pos, nor) {
    sides = sides || 12; var dx=b[0]-a[0], dy=b[1]-a[1], dz=b[2]-a[2], L=Math.hypot(dx,dy,dz); if(L<1e-6)return;
    var ux=dx/L,uy=dy/L,uz=dz/L, tx=Math.abs(uy)<.9?0:1,ty=Math.abs(uy)<.9?1:0,tz=0;
    var vx=uy*tz-uz*ty,vy=uz*tx-ux*tz,vz=ux*ty-uy*tx, vl=Math.hypot(vx,vy,vz)||1; vx/=vl;vy/=vl;vz/=vl;
    var wx=uy*vz-uz*vy,wy=uz*vx-ux*vz,wz=ux*vy-uy*vx;
    function P(p,c,s){return[p[0]+r*(vx*c+wx*s),p[1]+r*(vy*c+wy*s),p[2]+r*(vz*c+wz*s)];}
    for(var i=0;i<sides;i++){var t0=2*Math.PI*i/sides,t1=2*Math.PI*(i+1)/sides,c0=Math.cos(t0),s0=Math.sin(t0),c1=Math.cos(t1),s1=Math.sin(t1),A=P(a,c0,s0),B=P(b,c0,s0),C=P(b,c1,s1),D=P(a,c1,s1);pos.push.apply(pos,A.concat(B,C,A,C,D));for(var k=0;k<6;k++){var c=k===1||k===2?c1:c0,s=k===1||k===2?s1:s0;nor.push(vx*c+wx*s,vy*c+wy*s,vz*c+wz*s);}}
  }
  function wallParts(w){var L=w.length,H=w.height,base=w.base,ops=(w.openings||[]).slice().sort(function(a,b){return a.along-b.along;}),out=[],cur=0;function add(s,e,y,h){if(e-s>.01&&h>.01)out.push({s:s,e:e,y:y,h:h});}for(var i=0;i<ops.length;i++){var o=ops[i],s=Math.max(0,o.along),e=Math.min(L,s+o.width),sill=Math.max(0,o.sill||0),head=Math.min(H,o.head!=null?o.head:(o.kind==='door'?2.1:2.2));if(head-sill<.5){sill=o.kind==='door'?0:.9;head=Math.min(H,2.1);}add(cur,s,0,H);add(s,e,0,sill);add(s,e,head,H-head);cur=Math.max(cur,e);}add(cur,L,0,H);return out;}
  function wallTexture(w,pos,nor,col){var ap=w.appearance;if(!ap||!ap.colors||!ap.cols||!ap.rows)return;var L=w.length,H=w.height,ux=w.dir[0]/L,uz=w.dir[1]/L,nx=-uz,nz=ux,th=w.thickness/2,ops=w.openings||[];function inside(s,y){for(var i=0;i<ops.length;i++){var o=ops[i],si=o.along,ei=si+o.width,lo=o.sill||0,hi=o.head!=null?o.head:(o.kind==='door'?2.1:2.2);if(s>=si&&s<=ei&&y>=lo&&y<=hi)return true;}return false;}function V(s,y,side){return[w.a[0]+ux*s+nx*th*side,w.base+y,w.a[1]+uz*s+nz*th*side];}for(var iy=0;iy<ap.rows;iy++)for(var ix=0;ix<ap.cols;ix++){var s0=L*ix/ap.cols,s1=L*(ix+1)/ap.cols,y0=H*iy/ap.rows,y1=H*(iy+1)/ap.rows;if(inside((s0+s1)/2,(y0+y1)/2))continue;var ci=(iy*ap.cols+ix)*3,c=[ap.colors[ci]/255,ap.colors[ci+1]/255,ap.colors[ci+2]/255];for(var side=-1;side<=1;side+=2){var A=V(s0,y0,side),B=V(s1,y0,side),C=V(s1,y1,side),D=V(s0,y1,side);pos.push.apply(pos,A.concat(B,C,A,C,D));for(var k=0;k<6;k++){nor.push(nx*side,0,nz*side);col.push(c[0],c[1],c[2]);}}}}
  // v1174: состояние просмотра/ручной правки модели. del — удалённые элементы (по индексам), флаги — видимость категорий.
  var S2B_VIEW = { walls: true, pipes: true, services:true, beams: true, objects: true, footprint: true, solid: true, cables: true, del: { walls: {}, pipes: {}, services:{}, beams: {}, objects: {}, cables: {} } };

  // Строит overlay ПОВЕРХ облака точек. Учитывает видимость/удаления/режим сплошной модели; hl — подсветка элемента.
  function showPreview(v, model, hl) {
    v = v || mainV(); model = model || lastModel;
    if (!v || !v._setOverlay || !model || !model.ok) return;
    var solid = S2B_VIEW.solid, objs = [];
    function pushWire(pos, color) { if (pos.length) objs.push({ line: true, gkind: 'wire', pos: new Float32Array(pos), color: color }); }
    function pushSolid(pos, nor, color, col) { if (pos.length) objs.push({ gkind: 'solid', pos: new Float32Array(pos), nor: new Float32Array(nor), color: color || [0.7,0.75,0.8], col: col&&col.length===pos.length?new Float32Array(col):null }); }
    // --- Стены (сплошные с реальной толщиной либо каркасные) ---
    if (S2B_VIEW.walls) {
      // v1178: gruppiruem steny po materialu i krasim ih realnym tsvetom (kirpich/beton/metall)
      (model.walls || []).forEach(function (w, i) {
        if (S2B_VIEW.del.walls[i]) return;
        var L=Math.hypot(w.dir[0],w.dir[1])||1,parts=wallParts(w),bp=[],bn=[],wp=[],wn=[],wc=[];
        for(var j=0;j<parts.length;j++){var p=parts[j],mid=(p.s+p.e)/2,mx=w.a[0]+w.dir[0]/L*mid,mz=w.a[1]+w.dir[1]/L*mid;if(solid)boxSolidXform(mx,w.base+p.y+p.h/2,mz,w.dir[0]/L,w.dir[1]/L,(p.e-p.s)/2,p.h/2,w.thickness/2,bp,bn);else boxEdgesXform(mx,w.base+p.y+p.h/2,mz,w.dir[0]/L,w.dir[1]/L,(p.e-p.s)/2,p.h/2,w.thickness/2,bp);}
        if(solid){pushSolid(bp,bn,w.color||[.65,.68,.7]);wallTexture(w,wp,wn,wc);pushSolid(wp,wn,w.color||[.65,.68,.7],wc);}else pushWire(bp,w.color||[.2,.85,1]);
      });
    }
    // --- Трубы (сплошные трубы либо осевые линии) ---
    if (S2B_VIEW.pipes) {
      var pgroups = {};
      (model.pipes || []).forEach(function (p, i) {
        if (S2B_VIEW.del.pipes[i]) return;
        var ck = (p.color ? p.color.join(',') : 'def'); if (!pgroups[ck]) pgroups[ck] = { pos: [], nor: [], lines: [], color: p.color || null };
        if (solid) {
          var mx = (p.a[0] + p.b[0]) / 2, mz = (p.a[1] + p.b[1]) / 2, dx = p.b[0] - p.a[0], dz = p.b[1] - p.a[1], L = Math.hypot(dx, dz) || 1, r = p.radius || 0.05;
          cylinderSolid([p.a[0],p.y,p.a[1]],[p.b[0],p.y,p.b[1]],r,14,pgroups[ck].pos,pgroups[ck].nor);
        } else pgroups[ck].lines.push(p.a[0], p.y, p.a[1], p.b[0], p.y, p.b[1]);
      });
      Object.keys(pgroups).forEach(function (ck) { var g = pgroups[ck]; if (solid) pushSolid(g.pos, g.nor, g.color || [0.4, 0.95, 0.5]); else pushWire(g.lines, g.color || [0.25, 1, 0.45]); });
    }
    // --- v1178: Kabeli/provoda (tonkie kruglye niti, svisayut ot potolka) ---
    if (S2B_VIEW.cables) {
      var cpos = [], cnor = [], clines = [];
      (model.cables || []).forEach(function (cab, i) {
        if (S2B_VIEW.del.cables && S2B_VIEW.del.cables[i]) return;
        var r=cab.radius||.012,poly=cab.polyline||[];for(var j=0;j+1<poly.length;j++){var a=poly[j],b=poly[j+1];if(solid)cylinderSolid(a,b,r,8,cpos,cnor);else clines.push(a[0],a[1],a[2],b[0],b[1],b[2]);}
      });
      if (solid) pushSolid(cpos, cnor, [0.95, 0.62, 0.12]); else pushWire(clines, [1.0, 0.7, 0.15]);
    }
    if(S2B_VIEW.services){var spos=[],snor=[],slines=[];(model.services||[]).forEach(function(s,i){if(S2B_VIEW.del.services[i])return;var dx=s.b[0]-s.a[0],dz=s.b[1]-s.a[1],L=Math.hypot(dx,dz)||1,mx=(s.a[0]+s.b[0])/2,mz=(s.a[1]+s.b[1])/2;if(solid)boxSolidXform(mx,s.y,mz,dx/L,dz/L,L/2,(s.height||.2)/2,(s.width||.3)/2,spos,snor);else boxEdgesXform(mx,s.y,mz,dx/L,dz/L,L/2,(s.height||.2)/2,(s.width||.3)/2,slines);});if(solid)pushSolid(spos,snor,[.62,.72,.76]);else pushWire(slines,[.55,.8,.9]);}
    // --- Балки ---
    if (S2B_VIEW.beams) {
      var bgroups = {};
      (model.beams || []).forEach(function (bm, i) {
        if (S2B_VIEW.del.beams[i]) return;
        var mx = (bm.a[0] + bm.b[0]) / 2, mz = (bm.a[1] + bm.b[1]) / 2, dx = bm.b[0] - bm.a[0], dz = bm.b[1] - bm.a[1], L = Math.hypot(dx, dz) || 1;
        var bk = (bm.color ? bm.color.join(',') : 'def'); if (!bgroups[bk]) bgroups[bk] = { pos: [], nor: [], color: bm.color || null };
        if (solid) boxSolidXform(mx, bm.y, mz, dx / L, dz / L, (bm.length || L) / 2, (bm.depth || 0.1) / 2, (bm.width || 0.1) / 2, bgroups[bk].pos, bgroups[bk].nor);
        else boxEdgesXform(mx, bm.y, mz, dx / L, dz / L, (bm.length || L) / 2, (bm.depth || 0.1) / 2, (bm.width || 0.1) / 2, bgroups[bk].pos);
      });
      Object.keys(bgroups).forEach(function (bk) { var g = bgroups[bk]; if (solid) pushSolid(g.pos, g.nor, g.color || [0.95, 0.85, 0.3]); else pushWire(g.pos, g.color || [1, 0.9, 0.25]); });
    }
    // --- Объекты: column=колонны, equipment=оборуд./щитки/вентиляция ---
    if (S2B_VIEW.objects) {
      var okinds = { column: [0.72, 0.78, 0.9], equipment: [1, 0.35, 0.85], object: [1, 0.5, 0.3] };
      var groups = {};
      (model.objects || []).forEach(function (o, i) {
        if (S2B_VIEW.del.objects[i]) return;
        var k = o.color ? o.color.join(',') : (o.kind || 'object'); if (!groups[k]) groups[k] = { pos: [], nor: [], color: o.color || okinds[o.kind || 'object'] || [1, 0.5, 0.3] };
        if (solid) boxSolidXform(o.cx, o.cy, o.cz, 1, 0, o.hx, o.hy, o.hz, groups[k].pos, groups[k].nor);
        else boxEdgesXform(o.cx, o.cy, o.cz, 1, 0, o.hx, o.hy, o.hz, groups[k].pos);
      });
      Object.keys(groups).forEach(function (k) {
        if (solid) pushSolid(groups[k].pos, groups[k].nor, groups[k].color);
        else pushWire(groups[k].pos, groups[k].color);
      });
    }
    // --- Контур этажа (всегда линиями) ---
    if (S2B_VIEW.footprint) {
      var foot = model.footprint || [], fpos = [];
      for (var i = 0; i < foot.length; i++) {
        var a = foot[i], b = foot[(i + 1) % foot.length];
        fpos.push(a[0], model.storey.floorY, a[1], b[0], model.storey.floorY, b[1]);
        fpos.push(a[0], model.storey.ceilY, a[1], b[0], model.storey.ceilY, b[1]);
      }
      pushWire(fpos, [1, 0.75, 0.2]);
    }
    // --- Подсветка выбранного элемента (наведение в списке правки) ---
    if (hl) {
      var hp = [], arr = model[hl.cat] || [], el2 = arr[hl.idx];
      if (el2) {
        if (hl.cat === 'pipes') hp.push(el2.a[0], el2.y, el2.a[1], el2.b[0], el2.y, el2.b[1]);
        else if (hl.cat === 'walls') { var mxw = (el2.a[0] + el2.b[0]) / 2, mzw = (el2.a[1] + el2.b[1]) / 2, Lw = Math.hypot(el2.dir[0], el2.dir[1]) || 1; boxEdgesXform(mxw, el2.base + el2.height / 2, mzw, el2.dir[0] / Lw, el2.dir[1] / Lw, el2.length / 2, el2.height / 2, el2.thickness / 2, hp); }
        else if (hl.cat === 'beams') { var mxb = (el2.a[0] + el2.b[0]) / 2, mzb = (el2.a[1] + el2.b[1]) / 2, dxb = el2.b[0] - el2.a[0], dzb = el2.b[1] - el2.a[1], Lb = Math.hypot(dxb, dzb) || 1; boxEdgesXform(mxb, el2.y, mzb, dxb / Lb, dzb / Lb, (el2.length || Lb) / 2, (el2.depth || 0.1) / 2, (el2.width || 0.1) / 2, hp); }
        else if (hl.cat === 'objects') boxEdgesXform(el2.cx, el2.cy, el2.cz, 1, 0, el2.hx, el2.hy, el2.hz, hp);
        else if (hl.cat === 'cables') { var cp=el2.polyline||[]; for(var ci=0;ci+1<cp.length;ci++)hp.push(cp[ci][0],cp[ci][1],cp[ci][2],cp[ci+1][0],cp[ci+1][1],cp[ci+1][2]); }
        else if (hl.cat === 'services') { var dsx=el2.b[0]-el2.a[0],dsz=el2.b[1]-el2.a[1],dsl=Math.hypot(dsx,dsz)||1;boxEdgesXform((el2.a[0]+el2.b[0])/2,el2.y,(el2.a[1]+el2.b[1])/2,dsx/dsl,dsz/dsl,dsl/2,(el2.height||.2)/2,(el2.width||.3)/2,hp); }
        if (hp.length) objs.push({ line: true, gkind: 'wire', pos: new Float32Array(hp), color: [1, 0.12, 0.12] });
      }
    }
    try { v._setOverlay(objs); v.render && v.render(); } catch (e) {}
  }
  function rebuildPreview(hl) { try { showPreview(mainV(), lastModel, hl); } catch (e) {} }
  function clearPreview(v) { try { v && v._setOverlay && v._setOverlay([]); v && v.render && v.render(); } catch (e) {} }

  // v1174: текущая модель с учётом ручных удалений — идёт в экспорт (IFC/OBJ/DXF).
  function currentModel() {
    if (lastModel && lastModel.__server) return null; // v1182: servernaya model eksportiruetsya cherez lastResult (IFC/OBJ servera)
    if (!lastModel || !lastModel.ok) return lastModel;
    var m = lastModel, out = {}; for (var k in m) out[k] = m[k];
    function filt(key) { return (m[key] || []).filter(function (_, i) { return !S2B_VIEW.del[key][i]; }); }
    out.walls = filt('walls'); out.pipes = filt('pipes'); out.services=filt('services'); out.beams = filt('beams'); out.objects = filt('objects'); out.cables = filt('cables');
    if (m.stats) { var s = {}; for (var sk in m.stats) s[sk] = m.stats[sk]; s.wallCount = out.walls.length; s.pipeCount = out.pipes.length; s.beamCount = out.beams.length; s.objectCount = out.objects.length; s.cableCount = out.cables.length; out.stats = s; }
    return out;
  }

  // v1174: панель ручной правки модели (скрыть/удалить элементы, сплошная/каркас).
  function s2bPanel() {
    var id = 'lxS2BEditPanel', ex = document.getElementById(id);
    if (ex) { ex.style.display = 'block'; return ex; }
    var p = document.createElement('div'); p.id = id;
    p.className = 'lx-tool-panel'; p.style.cssText = 'right:14px;top:70px;width:236px;max-height:calc(100vh - 120px);overflow:auto;font:12px/1.45 system-ui,Segoe UI,sans-serif;padding:12px';
    document.body.appendChild(p); return p;
  }
  function mkBtn(txt, css) { var b = document.createElement('button'); b.textContent = txt; b.style.cssText = css; return b; }
  var TONE = { blue: 'var(--lx-blue)', green: 'var(--lx-green)', purple: 'var(--lx-purple)', orange: 'var(--lx-orange)', neutral: 'var(--lx-neutral)' };
  function renderEditPanel() {
    if (!lastModel || !lastModel.ok) return;
    var m = lastModel, p = s2bPanel(); p.innerHTML = '';
    var head = document.createElement('div'); head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px';
    var ht = document.createElement('div'); ht.textContent = '✏️ Правка модели 1:1'; ht.style.cssText = 'font:700 13px system-ui;color:var(--txt)';
    var hx = mkBtn('×', 'border:none;background:transparent;color:var(--muted);font-size:18px;cursor:pointer;line-height:1'); hx.onclick = function () { p.style.display = 'none'; };
    head.appendChild(ht); head.appendChild(hx); p.appendChild(head);
    p.appendChild((function () { var d = document.createElement('div'); d.style.cssText = 'font:11px system-ui;color:var(--muted);margin-bottom:8px'; d.textContent = 'Наведите на элемент — он подсветится красным. ✕ — удалить лишнее.'; return d; })());
    var st = document.createElement('label'); st.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0 8px;cursor:pointer';
    var sc = document.createElement('input'); sc.type = 'checkbox'; sc.checked = S2B_VIEW.solid;
    sc.onchange = function () { S2B_VIEW.solid = sc.checked; rebuildPreview(); };
    st.appendChild(sc); st.appendChild(document.createTextNode('Сплошная модель (как в FARO)')); p.appendChild(st);
    var cats = [['walls', 'Стена', m.walls], ['pipes', 'Труба', m.pipes], ['services', 'Вентиляция/лоток', m.services], ['beams', 'Балка', m.beams], ['objects', 'Объект', m.objects], ['cables', 'Провод', m.cables]];
    cats.forEach(function (c) {
      var key = c[0], label = c[1], arr = c[2] || [];
      var live = arr.filter(function (_, i) { return !S2B_VIEW.del[key][i]; }).length;
      var sec = document.createElement('div'); sec.style.cssText = 'border-top:1px solid var(--line);padding-top:6px;margin-top:6px';
      var row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:6px;font-weight:600';
      var vc = document.createElement('input'); vc.type = 'checkbox'; vc.checked = S2B_VIEW[key]; vc.title = 'Показывать/скрыть';
      vc.onchange = function () { S2B_VIEW[key] = vc.checked; rebuildPreview(); };
      var lb = document.createElement('span'); lb.textContent = label + 'ы (' + live + ')'; lb.style.flex = '1';
      var clr = mkBtn('очистить', 'font:11px system-ui;cursor:pointer;background:color-mix(in srgb, var(--err) 15%, transparent);color:var(--err);border:1px solid color-mix(in srgb, var(--err) 45%, transparent);border-radius:6px;padding:1px 6px');
      clr.onclick = function () { arr.forEach(function (_, i) { S2B_VIEW.del[key][i] = 1; }); rebuildPreview(); renderEditPanel(); };
      row.appendChild(vc); row.appendChild(lb); row.appendChild(clr); sec.appendChild(row);
      var list = document.createElement('div'); list.style.cssText = 'margin-top:4px;max-height:150px;overflow:auto';
      arr.forEach(function (el3, i) {
        if (S2B_VIEW.del[key][i]) return;
        var it = document.createElement('div'); it.style.cssText = 'display:flex;align-items:center;gap:6px;padding:1px 2px;border-radius:4px;cursor:default';
        var nm = document.createElement('span'); nm.textContent = label + ' ' + (i + 1); nm.style.flex = '1';
        var del = mkBtn('✕', 'cursor:pointer;background:transparent;color:var(--err);border:none;font-size:12px;line-height:1');
        it.onmouseenter = function () { it.style.background = 'var(--panel2)'; rebuildPreview({ cat: key, idx: i }); };
        it.onmouseleave = function () { it.style.background = 'transparent'; rebuildPreview(); };
        del.onclick = function (e) { e.stopPropagation(); S2B_VIEW.del[key][i] = 1; rebuildPreview(); renderEditPanel(); };
        it.appendChild(nm); it.appendChild(del); list.appendChild(it);
      });
      sec.appendChild(list); p.appendChild(sec);
    });
    var rb = mkBtn('↺ Сбросить правки', 'margin-top:10px;width:100%;cursor:pointer;background:var(--panel2);color:var(--lx-blue);border:1px solid var(--line);border-radius:8px;padding:5px');
    rb.onclick = function () { S2B_VIEW.del = { walls: {}, pipes: {}, services:{}, beams: {}, objects: {}, cables: {} }; S2B_VIEW.walls = S2B_VIEW.pipes = S2B_VIEW.services = S2B_VIEW.beams = S2B_VIEW.objects = S2B_VIEW.cables = true; rebuildPreview(); renderEditPanel(); };
    p.appendChild(rb);
  }

  // ===================== ВСТРОЕННЫЙ ДВИЖОК (ОФЛАЙН, БЕЗ СЕРВЕРА) =====================
  function localOpts() {
    return { voxel: 0.03, wallThreshold: 0.05, minWallLen: 0.4, defaultThickness: 0.15, snapAngles: true, closeCorners: true };
  }
  function buildLocal(pts, v, note) {
    if (!window.Scan2BIM) { toast('Встроенный движок Scan2BIM не загружен', true); setStatus('Нет движка'); return; }
    v = v || mainV();
    setStatus((note ? note + ' · ' : '') + 'Считаю геометрию встроенным движком (офлайн)…');
    var _stop = (window.__pcTools && window.__pcTools.beginProgress) ? window.__pcTools.beginProgress('Построение BIM (офлайн)…') : null;
    var t0 = nowMs();
    setTimeout(function () {
      var model;
      try { var _o = localOpts(); if (__s2bCols && pts && __s2bCols.length === pts.length) _o.colors = __s2bCols; model = window.Scan2BIM.reconstruct(pts, _o); }
      catch (e) { try { if (_stop) _stop(); } catch (e2) {} toast('Ошибка реконструкции: ' + (e && e.message || e), true); setStatus('Ошибка'); return; }
      try { if (_stop) _stop(); } catch (e2) {}
      if (!model || !model.ok) { toast((model && model.error) || 'Не удалось построить', true); setStatus((model && model.error) || 'Нет результата'); return; }
      lastModel = model; lastResult = null;
      try { showPreview(v, model); } catch (e3) {}
      try { renderEditPanel(); } catch (e3b) {}
      var dt = ((nowMs() - t0) / 1000).toFixed(1);
      renderStatsLocal(model, dt);
      var s = model.stats;
      setStatus('Готово (встроенный движок 1:1, ' + dt + ' с)' + (note ? ' · ' + note : ''));
      toast('BIM 1:1 построен офлайн: стен ' + s.wallCount + ', труб ' + s.pipeCount + ', объектов ' + s.objectCount);
    }, 30);
  }

  function health() {
    var url = resolveHost(getServer().replace(/\/$/, '')) + '/health';
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var to = setTimeout(function () { try { if (ctrl) ctrl.abort(); } catch (e) {} }, 4000);
    return fetch(url, { method: 'GET', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { clearTimeout(to); return r.json(); })
      .catch(function (e) { clearTimeout(to); throw e; });
  }

  // ===================== ГЛАВНАЯ КНОПКА: ПОСТРОИТЬ BIM =====================
  function reconstruct() {
    var v = mainV();
    if (!v) { toast('Нет активного вьюера', true); return; }
    var pts = collectPoints(v);
    if (!pts) { toast('Сначала откройте облако точек', true); return; }
    // v1170: единый режим «1:1» — детерминированный встроенный геометрический движок (офлайн).
    // Сервер/GPU не требуется: результат стабильный и одинаковый при каждом запуске.
    __s2bCols = collectColors(v);
    // v1182/v1183: esli AI-server (Cloud2BIM + truby + kabeli + Mask3D) podnyat - stroim cherez nego.
    if (__s2bServerReady) { reconstructViaServer(pts, v); return; }
    // v1188: OFFLINE-FIRST - knopka nikogda ne zavisaet v ozhidanii servera.
    // Server (Cloud2BIM + truby + kabeli + Mask3D) - opcionalnoe fonovoe uluchshenie:
    // esli fonovyy pul's podtverdil gotovnost (__s2bServerReady) - stroim cherez nego (vyshe),
    // inache SRAZU stroim vstroennym dvizhkom (offline), bez ozhidaniya i zависаний.
    buildLocal(pts, v); return;
  }

  // v1182: postroenie cherez avtozapuschennyy AI-server. Pri lyuboy oshibke - otkat na vstroennyy dvizhok.
  function reconstructViaServer(pts, v) {
    v = v || mainV();
    setStatus('Строю BIM через AI-сервер (Cloud2BIM + трубы + кабели + Mask3D)…');
    var _stop = (window.__pcTools && window.__pcTools.beginProgress) ? window.__pcTools.beginProgress('Построение BIM (AI-сервер)…') : null;
    var t0 = nowMs();
    var url = resolveHost(getServer().replace(/\/$/, '')) + '/reconstruct';
    var fd = new FormData();
    try { fd.append('file', buildPLY(pts), 'cloud.ply'); } catch (e) {}
    fd.append('mode', 'auto'); fd.append('name', 'Scan2BIM AI');
    var fell = false;
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    function fallback(msg) { if (fell) return; fell = true; try { clearTimeout(tmo); } catch (e1) {} try { if (_stop) _stop(); } catch (e2) {} __s2bServerReady = false; toast('AI-сервер недоступен (' + msg + ') — строю встроенным движком', true); buildLocal(pts, v, 'ИИ не сработал: ' + msg); }
    var tmo = setTimeout(function () { try { if (ctrl) ctrl.abort(); } catch (e0) {} fallback('тайм-аут 15 мин'); }, 900000);
    fetch(url, { method: 'POST', body: fd, signal: ctrl ? ctrl.signal : undefined }).then(function (r) {
      clearTimeout(tmo);
      if (!r.ok) { return r.json().catch(function () { return {}; }).then(function (j) { throw new Error((j && j.error) || ('HTTP ' + r.status)); }); }
      return r.json();
    }).then(function (j) {
      if (!j || !j.ok || !j.model) { fallback('пустой ответ'); return; }
      var pm = null; try { pm = mapServerModel(j.model); } catch (e) { pm = null; }
      if (!pm || !pm.ok || !(pm.walls && pm.walls.length)) { fallback('не удалось разобрать модель'); return; }
      try { if (_stop) _stop(); } catch (e2) {}
      lastModel = pm; lastResult = { ifc_base64: j.ifc_base64 || null, ifc2x3_base64: j.ifc2x3_base64 || null, ifc4_base64: j.ifc4_base64 || null, obj_base64: j.obj_base64 || null, revit_zip_base64: j.revit_zip_base64 || null };
      try { showPreview(v, pm); } catch (e3) {}
      try { renderEditPanel(); } catch (e3b) {}
      var dt = ((nowMs() - t0) / 1000).toFixed(1);
      try { renderStats({ engine: j.engine, stats: j.stats, height: j.height, floor_area: j.floor_area }); } catch (e4) {}
      var s = pm.stats || {};
      setStatus('Готово (AI-сервер ' + (j.engine === 'ai' ? 'ИИ/GPU' : 'Cloud2BIM/CPU') + ', ' + dt + ' с)');
      if (j.ai_error) { try { if (navigator.clipboard) navigator.clipboard.writeText('ai_error: ' + j.ai_error + (j.ai_trace ? (' | ' + j.ai_trace) : '')); } catch (eAi) {} toast('ИИ не применился (' + j.ai_error + ') — построено геометрией. Причина скопирована.', true); }
      toast('BIM построен на сервере: стен ' + (s.wallCount || 0) + ', труб ' + (s.pipeCount || 0) + ', объектов ' + (s.objectCount || 0));
    }).catch(function (e) { fallback(e && e.message || e); });
  }

  // v1182: model servera (koordinaty otnositelno pmin/floor, up=y) -> model predprosmotra (absolyutnye koordinaty vyuvera, y vverh).
  function mapServerModel(sm) {
    if (!sm) return null;
    var px = (sm.pmin && sm.pmin[0]) || 0, pz = (sm.pmin && sm.pmin[1]) || 0;
    var fabs = (typeof sm.floor_abs === 'number') ? sm.floor_abs : 0;
    var H = sm.height || (((sm.ceil || 0) - (sm.floor || 0)) || 3);
    var floorY = fabs, ceilY = fabs + H;
    function PXf(a) { return a + px; } function PZf(b) { return b + pz; } function VYf(y) { return y + fabs; }
    var PMAT = { copper: [0.72, 0.45, 0.2], steel: [0.7, 0.72, 0.78], cast_iron: [0.33, 0.33, 0.36], painted: [0.3, 0.6, 0.85], plastic: [0.85, 0.85, 0.5] };
    var out = { ok: true, __server: true, units: 'm', storey: { floorY: floorY, ceilY: ceilY, height: H } };
    out.walls = (sm.walls || []).map(function (w) {
      var a = [PXf(w.p0[0]), PZf(w.p0[1])], b = [PXf(w.p1[0]), PZf(w.p1[1])];
      var dir = [b[0] - a[0], b[1] - a[1]];
      var ops=(w.openings||[]).map(function(o){var q={};for(var k in o)q[k]=o[k];q.along=Math.max(0,(o.along||0)-(o.width||0)/2);if(q.kind==='door'&&(!isFinite(q.head)||q.head>2.6))q.head=Math.min(H,2.2);if(q.kind==='window'&&(!isFinite(q.head)||q.head>H-.15))q.head=Math.min(H,2.3);return q;});
      return { a: a, b: b, dir: dir, base: floorY, height: H, thickness: (w.thickness || 0.12), length: (w.length || Math.hypot(dir[0], dir[1])), openings: ops, appearance:w.appearance||null };
    });
    out.pipes = (sm.pipes || []).map(function (p) {
      return { a: [PXf(p.p0[0]), PZf(p.p0[1])], b: [PXf(p.p1[0]), PZf(p.p1[1])], y: VYf(p.y || 0), radius: (p.radius || 0.05), color: (PMAT[p.material] || null), material: p.material, dn: p.dn, diameter_mm: p.diameter_mm };
    });
    out.services=(sm.services||[]).map(function(s){return{a:[PXf(s.p0[0]),PZf(s.p0[1])],b:[PXf(s.p1[0]),PZf(s.p1[1])],y:VYf(s.y||0),width:s.width||.3,height:s.height||.2,kind:s.kind||'duct'};});
    out.cables = (sm.cables || []).map(function (c) {
      var poly = c.polyline || []; if (!poly.length) return null;
      var xs = [], zs = [], ys = [];
      for (var i = 0; i < poly.length; i++) { xs.push(poly[i][0]); zs.push(poly[i][1]); ys.push(poly[i][2] != null ? poly[i][2] : 0); }
      var outPoly=[];for(var j=0;j<poly.length;j++)outPoly.push([PXf(poly[j][0]),VYf(poly[j][2]||0),PZf(poly[j][1])]);
      return { polyline:outPoly, radius: (c.radius || 0.012) };
    }).filter(Boolean);
    out.objects = (sm.objects || []).map(function (o) {
      return { cx: PXf(o.cx), cz: PZf(o.cy), cy: VYf((o.base || 0) + (o.hz || 0) / 2), hx: (o.hx || 0.2), hy: (o.hz || 0.4) / 2, hz: (o.hy || 0.2), kind: (o.kind || 'object') };
    });
    out.beams = [];
    var fp = sm.footprint || [];
    if (fp.length >= 2) { var x0 = PXf(fp[0][0]), z0 = PZf(fp[0][1]), x1 = PXf(fp[1][0]), z1 = PZf(fp[1][1]); out.footprint = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]; }
    else out.footprint = [];
    var st = sm.stats || {};
    out.stats = { wallCount: (st.wall_count != null ? st.wall_count : out.walls.length), openingCount: (st.opening_count || 0), pipeCount: (st.pipe_count != null ? st.pipe_count : out.pipes.length), beamCount: 0, columnCount: 0, objectCount: (st.object_count != null ? st.object_count : out.objects.length), cableCount: (st.cable_count != null ? st.cable_count : out.cables.length), floorArea: (sm.floor_area || 0), height: H };
    return out;
  }

  // ===================== ЭКСПОРТ (работает и для офлайн-модели, и для серверной) =====================
  function saveIfc() {
    if (lastResult && (lastResult.ifc2x3_base64 || lastResult.ifc_base64)) { downloadBlob(b64ToBlob(lastResult.ifc2x3_base64 || lastResult.ifc_base64), 'bim-twin-revit-ifc2x3.ifc'); return; }
    var _cm = currentModel(); if (_cm && window.Scan2BIM) { downloadBlob(new Blob([window.Scan2BIM.toIFC(_cm, { name: 'scan2bim.ifc', includeBeams: false, includePipes: false })], { type: 'application/x-step' }), 'scan2bim-1v1.ifc'); var _st = _cm.stats || {}; if (_st.beamCount || _st.pipeCount || _st.cableCount) toast('IFC4: непроверенные авто-кандидаты MEP/балок не включены', false); return; }
    toast('Сначала постройте модель', true);
  }
  function saveRevitPack() {
    if (lastResult && lastResult.revit_zip_base64) { downloadBlob(b64ToBlob(lastResult.revit_zip_base64, 'application/zip'), 'bim-twin-revit-pack.zip'); return; }
    toast('Revit Pack создаётся AI-сервером. Сначала постройте модель при запущенном сервере.', true);
  }
  function saveObj() {
    var _cm = currentModel(); if (_cm && window.Scan2BIM) { downloadBlob(new Blob([window.Scan2BIM.toOBJ(_cm)], { type: 'text/plain' }), 'scan2bim-1v1.obj'); return; }
    if (lastResult && lastResult.obj_base64) { downloadBlob(b64ToBlob(lastResult.obj_base64), 'scan2bim-ai.obj'); return; }
    toast('Сначала постройте модель', true);
  }
  function saveDxf() {
    var _cm = currentModel(); if (_cm && window.Scan2BIM) { downloadBlob(new Blob([window.Scan2BIM.toDXF(_cm, { includeCandidates: false })], { type: 'application/dxf' }), 'scan2bim-1v1.dxf'); return; }
    if (lastResult && lastResult.dxf_base64) { downloadBlob(b64ToBlob(lastResult.dxf_base64), 'scan2bim-ai.dxf'); return; }
    toast('DXF-план доступен для встроенной модели (режим auto/geom)', true);
  }

  var panel = null, statusEl = null, statsEl = null, urlInput = null, modeSel = null;
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  function row(k, v) { return '<div style="display:flex;justify-content:space-between;gap:8px;font:12px system-ui;color:var(--muted);padding:1px 0"><span>' + k + '</span><b style="color:var(--txt)">' + v + '</b></div>'; }
  function renderStats(j) {
    if (!statsEl) return; var s = j.stats || {};
    statsEl.innerHTML = '<div style="font:600 12px system-ui;color:var(--ok);margin-bottom:4px">🤖 Модель (' + (j.engine === 'ai' ? 'ИИ/GPU' : 'геометрия') + ')</div>' +
      row('Стен', s.wall_count || 0) + row('Труб', s.pipe_count || 0) + row('Объектов', s.object_count || 0) +
      row('Высота', (j.height != null ? j.height.toFixed(2) : '—') + ' м') +
      row('Площадь', (j.floor_area != null ? j.floor_area.toFixed(1) : '—') + ' м²');
  }
  function renderStatsLocal(m, dt) {
    if (!statsEl) return; var s = m.stats, st = m.storey;
    statsEl.innerHTML = '<div style="font:600 12px system-ui;color:var(--ok);margin-bottom:4px">🏗️ Модель 1:1 (встроенный движок)</div>' +
      row('Стен', s.wallCount) + row('Проёмов', s.openingCount) + row('Труб', s.pipeCount) +
      row('Балок', s.beamCount || 0) + row('Колонн', s.columnCount || 0) + row('Оборуд./щитки', Math.max(0, (s.objectCount || 0) - (s.columnCount || 0))) +
      row('Высота этажа', nfmt(st.height) + ' м') +
      row('Площадь пола', nfmt(s.floorArea, 1) + ' м²') +
      row('Сумм. длина стен', nfmt(s.totalWallLength) + ' м') +
      row('Ср. RMS подгонки', nfmt(s.meanWallRms * 1000, 1) + ' мм') +
      (dt != null ? row('Время', dt + ' с') : '');
  }

  function buildPanel() {
    if (panel) return panel;
    panel = el('div', ''); panel.className = 'lx-tool-panel'; panel.style.cssText = 'left:14px;bottom:132px;width:280px;max-height:calc(100vh - 170px);overflow-y:auto;padding:12px;display:none';
    var head = el('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px');
    head.appendChild(el('div', 'font:700 13px system-ui;color:var(--txt)', '🏗️ Скан → BIM (1:1)'));
    var x = el('button', 'border:none;background:transparent;color:var(--muted);font-size:18px;cursor:pointer;line-height:1', '×'); x.onclick = close; head.appendChild(x);
    panel.appendChild(head);
    panel.appendChild(el('div', 'font:11px system-ui;color:var(--muted);margin-bottom:6px', 'Сервер поднимается автоматически вместе с приложением. Пока он загружается или если недоступен — модель 1:1 строится встроенным движком (офлайн).'));
    // v1170: селектор режимов убран — теперь есть один режим «1:1», чтобы не путать.
    modeSel = null;
    panel.appendChild(el('div', 'font:11px system-ui;color:var(--muted);margin:2px 0 4px', 'Единый режим «1:1»: модель строится встроенным движком по геометрии облака точек.'));

    var bGo = el('button', bcss(TONE.blue) + ';width:100%;margin-top:6px', '🏗️ Построить BIM 1:1'); bGo.id = 'lxS2BBuildBtn'; bGo.onclick = reconstruct;
    panel.appendChild(bGo);

    // Сервер (опционально) — сворачиваемый блок.
    var det = document.createElement('details'); det.style.cssText = 'margin-top:8px';
    var sum = document.createElement('summary'); sum.style.cssText = 'font:600 11px system-ui;color:var(--muted);cursor:pointer'; sum.textContent = '⚙️ Сервер GPU (опционально)'; det.appendChild(sum);
    var ul = el('label', 'display:block;font:12px system-ui;color:var(--muted);margin:6px 0 4px');
    ul.appendChild(el('span', 'display:block;margin-bottom:3px', 'URL сервера'));
    urlInput = document.createElement('input'); urlInput.type = 'text'; urlInput.value = getServer();
    urlInput.style.cssText = 'width:100%;padding:5px 7px;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--txt);font:12px system-ui;box-sizing:border-box';
    urlInput.addEventListener('change', function () { setServer(urlInput.value.trim()); });
    ul.appendChild(urlInput); det.appendChild(ul);
    var bHealth = el('button', bcss(TONE.neutral) + ';width:100%;margin-top:4px', '➕ Проверить сервер');
    bHealth.onclick = function () { setStatus('Проверка…'); health().then(function (h) { setStatus('Сервер ok · GPU: ' + (h.gpu ? 'да' : 'нет') + ' · модель: ' + (h.checkpoint ? 'да' : 'нет')); }).catch(function (e) { setStatus('Недоступен: ' + (e && e.message || e)); }); };
    det.appendChild(bHealth);
    var bDiag = el('button', bcss(TONE.purple) + ';width:100%;margin-top:4px', '🔬 Диагностика ИИ');
    bDiag.onclick = function () {
      setStatus('Диагностика ИИ…');
      var url = resolveHost(getServer().replace(/\/$/, '')) + '/diag';
      fetch(url).then(function (r) { return r.json(); }).then(function (d) {
        var mb = Math.round(((d.checkpoint_size || 0) / 1048576) * 10) / 10;
        var msg = 'torch=' + (d.torch || '-') + ' · cuda=' + (d.cuda ? 'да' : 'НЕТ') + ' · gpu=' + (d.device_name || '-')
          + ' · spconv=' + (d.spconv ? 'да' : 'НЕТ') + ' · ptv3=' + (d.ptv3_import ? 'да' : 'НЕТ')
          + ' · веса=' + (d.checkpoint_exists ? ('да, ' + mb + 'МБ') : 'НЕТ')
          + ' · загрузка=' + (d.load_ok ? 'OK' : 'НЕТ')
          + ' · форвард=' + (d.forward_ok === true ? 'OK' : (d.forward_ok === false ? 'НЕТ' : '?'))
          + (d.error ? (' · ОШИБКА: ' + d.error) : (d.note ? (' · ' + d.note) : ''))
          + (d.forward_trace ? (' · TRACE: ' + d.forward_trace) : (d.error_trace ? (' · TRACE: ' + d.error_trace) : ''))
          + (d.head_scan ? (' · ГОЛОВЫ[' + (d.head_count != null ? d.head_count : (d.head_scan.length || 0)) + ']: ' + (Array.isArray(d.head_scan) ? d.head_scan.join(' | ') : d.head_scan)) : '');
        setStatus(msg);
        try { if (navigator.clipboard) navigator.clipboard.writeText(msg); } catch (e) {}
        toast('Диагностика скопирована в буфер — пришлите её мне', false);
      }).catch(function (e) { setStatus('Диагностика недоступна: ' + (e && e.message || e) + ' (сервер не запущен?)'); });
    };
    det.appendChild(bDiag);
    panel.appendChild(det);

    statusEl = el('div', 'font:11px system-ui;color:var(--muted);margin-top:6px;min-height:14px', '');
    panel.appendChild(statusEl);
    statsEl = el('div', 'margin-top:8px'); panel.appendChild(statsEl);
    panel.appendChild(el('div', 'height:1px;background:var(--line);margin:10px 0'));
    panel.appendChild(el('div', 'font:600 11px system-ui;color:var(--muted);margin-bottom:2px', 'ЭКСПОРТ'));
    var exp = el('div', 'display:flex;flex-wrap:wrap');
    var bRevit = el('button', bcss(TONE.green), 'Revit ZIP'); bRevit.onclick = saveRevitPack;
    var bIfc = el('button', bcss(TONE.green), 'IFC 2x3'); bIfc.onclick = saveIfc;
    var bObj = el('button', bcss(TONE.purple), 'OBJ'); bObj.onclick = saveObj;
    var bDxf = el('button', bcss(TONE.orange), 'DXF'); bDxf.onclick = saveDxf;
    var bClr = el('button', bcss(TONE.neutral), 'Очистить'); bClr.onclick = function () { clearPreview(mainV()); };
    exp.appendChild(bRevit); exp.appendChild(bIfc); exp.appendChild(bObj); exp.appendChild(bDxf); exp.appendChild(bClr); panel.appendChild(exp);
    document.body.appendChild(panel);
    return panel;
  }
  var _healthTimer = null, _hbTimer = null, _hbOn = false;
  function applyHealth(h) {
    __s2bServerReady = !!(h && h.status === 'ok');
    if (__s2bServerReady) setStatus('Сервер готов · GPU: ' + (h.gpu ? 'да' : 'нет') + ' · нейросеть: ' + ((h.checkpoint || h.engine_ready) ? 'да' : 'нет'));
  }
  // v1183: bystraya proverka /health s tajm-autom. resolvit true, esli server otvetil status ok.
  function healthProbe(ms) {
    return new Promise(function (resolve) {
      var done = false; function fin(ok) { if (done) return; done = true; resolve(ok); }
      var to = setTimeout(function () { fin(false); }, ms || 2000);
      health().then(function (h) { clearTimeout(to); if (h && h.status === 'ok') { applyHealth(h); fin(true); } else fin(false); })
              .catch(function () { clearTimeout(to); fin(false); });
    });
  }
  // v1183: fonovyy pul's - derzhit __s2bServerReady v aktualnom sostoyanii posle holodnogo starta servera.
  function startBackgroundHeartbeat() {
    if (_hbOn) return; _hbOn = true;
    (function beat() {
      health().then(function (h) { applyHealth(h); }).catch(function () { __s2bServerReady = false; })
        .then(function () { _hbTimer = setTimeout(beat, __s2bServerReady ? 5000 : 2500); });
    })();
  }
  // При открытии панели опрашиваем автозапущенный сервер. Сервер (GPU + нейросеть) может
  // прогреваться до ~2 минут, поэтому опрос НЕ прекращаем — переходим в фоновый пульс.
  function autoHealthPoll(tries) {
    if (_hbOn) { healthProbe(1500); return; } // uzhe est' fonovyy pul's - prosto obnovim status
    if (_healthTimer) { clearTimeout(_healthTimer); _healthTimer = null; }
    var left = (tries == null ? 90 : tries); // ~90 x 1.5s = ozhidanie holodnogo starta do ~2 min
    setStatus('Офлайн-движок 1:1 готов — можно строить сразу. AI-сервер (опционально) проверяю в фоне…');
    (function ping() {
      health().then(function (h) {
        applyHealth(h);
        startBackgroundHeartbeat();
      }).catch(function () {
        __s2bServerReady = false;
        if (--left > 0) { setStatus('Офлайн-движок 1:1 готов — стройте в любой момент. AI-сервер (опционально) ещё запускается…'); _healthTimer = setTimeout(ping, 1500); }
        else { setStatus('AI-сервер не поднялся — работает встроенный офлайн-движок 1:1 (готов к построению).'); startBackgroundHeartbeat(); }
      });
    })();
  }
  function open() { buildPanel().style.display = 'block'; autoHealthPoll(); }
  function close() { if (panel) panel.style.display = 'none'; var ep = document.getElementById('lxS2BEditPanel'); if (ep) ep.style.display = 'none'; clearPreview(mainV()); }

  function mountButton() {
    if (document.getElementById('lxScan2BimAiBtn')) return;
    var b = el('button', 'position:fixed;left:150px;bottom:52px;z-index:99998;' + bcss(TONE.blue), '🏗️ BIM 1:1');
    b.id = 'lxScan2BimAiBtn';
    b.onclick = function () { if (panel && panel.style.display === 'block') close(); else open(); };
    document.body.appendChild(b);
  }
  function boot() { try { mountButton(); } catch (e) { console.error('[scan2bim-ai] boot', e); } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.addEventListener('lx-viewer-ready', boot);
  window.addEventListener('lx-pctools-ready', boot);

  window.__lxScan2BIMAI = { open: open, close: close, reconstruct: reconstruct, buildLocal: buildLocal, health: health, getServer: getServer, setServer: setServer, buildPLY: buildPLY };
})();
