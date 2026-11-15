/*
 * IFC (STEP / ISO-10303-21) parser — browser build, zero dependencies (Phase B).
 * Extracts semantic data: project, storeys, spaces, and building elements with
 * their IFC GlobalId.
 *
 * r133: добавлена 3D-геометрия для НАШИХ экспортов (renderer/scan2bim.js toIFC):
 * IfcWallStandardCase / IfcSlab / IfcSpace с IfcExtrudedAreaSolid (IfcRectangleProfileDef
 * или IfcArbitraryClosedProfileDef + IfcPolyline), IfcAxis2Placement3D/2D и цепочкой
 * IfcLocalPlacement. Треугольники отдаются в мировых координатах приложения
 * (X — план X, Y — вверх, Z — план Z) для 3D-вьюера (MeshViewer).
 *
 * API: window.IFCImport = { parseIFC(text, { geometry: true }), GEOMETRY_LIMITS, GEOMETRY_ELEMENT_TYPES }.
 * Семантика (project/storeys/spaces/elements) — как раньше; geometry появляется в результате
 * только при opts.geometry === true.
 */
(function () {
  'use strict';
  const ELEMENT_RE = /^IFC(WALLSTANDARDCASE|WALL|DOOR|WINDOW|SLAB|BEAM|COLUMN|MEMBER|PLATE|COVERING|RAILING|STAIR|ROOF|DUCT\w*|PIPE\w*|CABLE\w*|FLOW\w*|AIRTERMINAL\w*|FAN\w*|PUMP\w*|VALVE\w*|SANITARY\w*|FURNISH\w*|BUILDINGELEMENTPROXY)$/;
  const GEOMETRY_ELEMENT_TYPES = { IFCWALLSTANDARDCASE: 1, IFCWALL: 1, IFCSLAB: 1, IFCSPACE: 1 };
  const GEOMETRY_LIMITS = { maxEntities: 500000, maxObjects: 2000, maxTriangles: 400000 };

  // ревизия 39: кодировки STEP для не-ASCII (\X2\…\X0\ — UTF-16, \X\hh — ISO 8859-1, \S\c — верхняя половина)
  function decodeStep(s) { return s.replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (m, h) => { let o = ''; for (let i = 0; i + 3 < h.length; i += 4) o += String.fromCharCode(parseInt(h.substr(i, 4), 16)); return o; }).replace(/\\X\\([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\S\\(.)/g, (m, c) => String.fromCharCode(c.charCodeAt(0) + 128)).replace(/\\\\/g, '\\'); }
  function stripStr(v) { if (v == null) return null; v = v.trim(); if (v === '$' || v === '*') return null; if (v[0] === "'" && v[v.length - 1] === "'") return decodeStep(v.slice(1, -1).replace(/''/g, "'")); return v; }

  function splitStatements(text) {
    let s = text; const di = s.indexOf('DATA;'); if (di >= 0) { const ei = s.indexOf('ENDSEC;', di); s = s.substring(di + 5, ei >= 0 ? ei : s.length); }
    const out = []; let buf = '', inStr = false;
    for (let i = 0; i < s.length; i++) { const c = s[i];
      if (inStr) { buf += c; if (c === "'") { if (s[i + 1] === "'") { buf += s[++i]; } else inStr = false; } continue; }
      if (c === "'") { inStr = true; buf += c; continue; }
      if (c === ';') { const t = buf.trim(); if (t) out.push(t); buf = ''; continue; }
      buf += c;
    }
    return out;
  }

  function splitArgs(s) {
    const out = []; let buf = '', depth = 0, inStr = false;
    for (let i = 0; i < s.length; i++) { const c = s[i];
      if (inStr) { buf += c; if (c === "'") { if (s[i + 1] === "'") { buf += s[++i]; } else inStr = false; } continue; }
      if (c === "'") { inStr = true; buf += c; continue; }
      if (c === '(') { depth++; buf += c; continue; }
      if (c === ')') { depth--; buf += c; continue; }
      if (c === ',' && depth === 0) { out.push(buf.trim()); buf = ''; continue; }
      buf += c;
    }
    if (buf.trim() !== '') out.push(buf.trim());
    return out;
  }

  function refList(s) {
    const out = []; if (s == null) return out; const re = /#(\d+)/g; let m; while ((m = re.exec(String(s)))) out.push('#' + m[1]); return out;
  }

  // ---------- r133: STEP-геометрия (SweptSolid) ----------
  function refId(v) { const m = /^#(\d+)\s*$/.exec(String(v == null ? '' : v).trim()); return m ? '#' + m[1] : null; }
  function numArg(v) { const n = Number(String(v == null ? '' : v).trim()); return Number.isFinite(n) ? n : 0; }
  function tupleNums(v) {
    const s = String(v == null ? '' : v).trim();
    const inner = s.replace(/^\s*\(/, '').replace(/\)\s*$/, '');
    return splitArgs(inner).map(numArg);
  }
  function entPoint(entMap, id) { const e = entMap.get(id); if (!e) return null; const a = tupleNums(e.args[0]); return a.length >= 2 ? a : null; }
  function normVec(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
  function normVec2(v) { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; }
  function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  const IDENTITY_PLACEMENT = { p: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

  function entDirection(entMap, id) { const p = entPoint(entMap, id); return p ? normVec([p[0], p[1], p.length > 2 ? p[2] : 0]) : null; }
  function placement3(entMap, id) {
    const e = entMap.get(id); if (!e || e.type !== 'IFCAXIS2PLACEMENT3D') return null;
    const locId = refId(e.args[0]); const loc = locId ? entPoint(entMap, locId) : null;
    const p = loc ? [loc[0], loc[1], loc.length > 2 ? loc[2] : 0] : [0, 0, 0];
    const z = (e.args[1] && refId(e.args[1]) ? entDirection(entMap, refId(e.args[1])) : null) || [0, 0, 1];
    let x = (e.args[2] && refId(e.args[2]) ? entDirection(entMap, refId(e.args[2])) : null) || [1, 0, 0];
    const dz = dot3(x, z);
    x = normVec(sub3(x, [z[0] * dz, z[1] * dz, z[2] * dz]));
    const y = cross3(z, x);
    return { p, x, y, z };
  }
  function placement2(entMap, id) {
    const e = entMap.get(id); if (!e || e.type !== 'IFCAXIS2PLACEMENT2D') return null;
    const locId = refId(e.args[0]); const loc = locId ? entPoint(entMap, locId) : null;
    const p = loc ? [loc[0], loc[1]] : [0, 0];
    const dId = e.args[1] ? refId(e.args[1]) : null;
    let x = [1, 0];
    if (dId) { const dd = entDirection(entMap, dId); if (dd) x = normVec2([dd[0], dd[1]]); }
    return { p, x, y: [-x[1], x[0]] };
  }
  function applyPlacement(pl, v) {
    const m = pl || IDENTITY_PLACEMENT;
    return [m.p[0] + m.x[0] * v[0] + m.y[0] * v[1] + m.z[0] * v[2],
      m.p[1] + m.x[1] * v[0] + m.y[1] * v[1] + m.z[1] * v[2],
      m.p[2] + m.x[2] * v[0] + m.y[2] * v[1] + m.z[2] * v[2]];
  }
  function rotPlacement(pl, v) {
    return [pl.x[0] * v[0] + pl.y[0] * v[1] + pl.z[0] * v[2],
      pl.x[1] * v[0] + pl.y[1] * v[1] + pl.z[1] * v[2],
      pl.x[2] * v[0] + pl.y[2] * v[1] + pl.z[2] * v[2]];
  }
  function composePlacement(parent, child) {
    return { p: applyPlacement(parent, child.p), x: rotPlacement(parent, child.x), y: rotPlacement(parent, child.y), z: rotPlacement(parent, child.z) };
  }
  function localPlacementMatrix(entMap, id, depth) {
    const lp = entMap.get(id); if (!lp || lp.type !== 'IFCLOCALPLACEMENT') return null;
    const rel = placement3(entMap, refId(lp.args[1])) || IDENTITY_PLACEMENT;
    const parentId = refId(lp.args[0]);
    if (!parentId || (depth || 0) > 32) return rel;
    const parent = localPlacementMatrix(entMap, parentId, (depth || 0) + 1);
    return parent ? composePlacement(parent, rel) : rel;
  }
  function profilePolygon(entMap, profileId) {
    const e = entMap.get(profileId); if (!e) return null;
    let poly = null; let pos = null;
    if (e.type === 'IFCRECTANGLEPROFILEDEF') {
      pos = refId(e.args[2]);
      const x = numArg(e.args[3]); const y = numArg(e.args[4]);
      if (!(x > 0 && y > 0)) return null;
      poly = [[-x / 2, -y / 2], [x / 2, -y / 2], [x / 2, y / 2], [-x / 2, y / 2]];
    } else if (e.type === 'IFCARBITRARYCLOSEDPROFILEDEF') {
      const curve = entMap.get(refId(e.args[2]));
      if (!curve || curve.type !== 'IFCPOLYLINE') return null;
      poly = refList(curve.args[0]).map((pid) => entPoint(entMap, pid)).filter(Boolean);
      if (poly.length > 1 && poly[0][0] === poly[poly.length - 1][0] && poly[0][1] === poly[poly.length - 1][1]) poly.pop();
    } else return null;
    if (!poly || poly.length < 3) return null;
    const p2 = pos ? placement2(entMap, pos) : null;
    const m = p2 || { p: [0, 0], x: [1, 0], y: [0, 1] };
    return poly.map((pt) => [m.p[0] + m.x[0] * pt[0] + m.y[0] * pt[1], m.p[1] + m.x[1] * pt[0] + m.y[1] * pt[1]]);
  }
  function polygonArea2(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; }
    return a / 2;
  }
  function solidTriangles(entMap, solidId) {
    const e = entMap.get(solidId); if (!e || e.type !== 'IFCEXTRUDEDAREASOLID') return null;
    let poly = profilePolygon(entMap, refId(e.args[0])); if (!poly) return null;
    const pos = placement3(entMap, refId(e.args[1])) || IDENTITY_PLACEMENT;
    const dirId = refId(e.args[2]); const dir = dirId ? (entDirection(entMap, dirId) || [0, 0, 1]) : [0, 0, 1];
    const depth = numArg(e.args[3]); if (!(depth > 0)) return null;
    if (polygonArea2(poly) < 0) poly = poly.slice().reverse();
    const base = poly.map((pt) => applyPlacement(pos, [pt[0], pt[1], 0]));
    const esc = rotPlacement(pos, dir);
    const off = [esc[0] * depth, esc[1] * depth, esc[2] * depth];
    const top = base.map((p) => [p[0] + off[0], p[1] + off[1], p[2] + off[2]]);
    const tris = [];
    for (let i = 1; i < poly.length - 1; i++) { tris.push([base[0], base[i + 1], base[i]]); tris.push([top[0], top[i], top[i + 1]]); }
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      tris.push([base[i], base[j], top[j]]); tris.push([base[i], top[j], top[i]]);
    }
    return tris;
  }
  function styleColorMap(entMap) {
    const map = new Map();
    for (const e of entMap.values()) {
      if (e.type !== 'IFCSTYLEDITEM') continue;
      const itemId = refId(e.args[0]); const styleId = refList(e.args[1])[0];
      const style = styleId ? entMap.get(styleId) : null;
      if (!itemId || !style || style.type !== 'IFCSURFACESTYLE') continue;
      const render = entMap.get(refList(style.args[2])[0]);
      if (!render || render.type !== 'IFCSURFACESTYLERENDERING') continue;
      const col = entMap.get(refId(render.args[0]));
      if (!col || col.type !== 'IFCCOLOURRGB') continue;
      map.set(itemId, [numArg(col.args[1]), numArg(col.args[2]), numArg(col.args[3])]);
    }
    return map;
  }
  function emptyGeometry(limits) {
    return { objects: [], bbox: null, stats: { objects: 0, walls: 0, slabs: 0, spaces: 0, triangles: 0, skipped: 0, skippedReason: null }, limits };
  }
  function buildGeometry(entMap, limits, guidIndex) {
    const geo = emptyGeometry(limits);
    if (entMap.size > limits.maxEntities) { geo.stats.skippedReason = 'entities_limit'; return geo; }
    const itemColors = styleColorMap(entMap);
    const mn = [Infinity, Infinity, Infinity]; const mx = [-Infinity, -Infinity, -Infinity];
    const stats = geo.stats;
    for (const productId of guidIndex) {
      if (stats.objects >= limits.maxObjects || stats.triangles >= limits.maxTriangles) {
        stats.skipped += 1; stats.skippedReason = stats.objects >= limits.maxObjects ? 'objects_limit' : 'triangles_limit';
        continue;
      }
      const product = entMap.get(productId); if (!product) continue;
      const lpId = refId(product.args[5]); const repId = refId(product.args[6]);
      const world = lpId ? (localPlacementMatrix(entMap, lpId) || IDENTITY_PLACEMENT) : IDENTITY_PLACEMENT;
      const pds = repId ? entMap.get(repId) : null; if (!pds) { stats.skipped += 1; continue; }
      const tris = []; let color = null;
      for (const shapeRepId of refList(pds.args[2])) {
        const rep = entMap.get(shapeRepId); if (!rep || rep.type !== 'IFCSHAPEREPRESENTATION') continue;
        for (const itemId of refList(rep.args[3])) {
          const t = solidTriangles(entMap, itemId);
          if (t && t.length) { tris.push.apply(tris, t); if (!color && itemColors.has(itemId)) color = itemColors.get(itemId); }
        }
      }
      if (!tris.length) { stats.skipped += 1; continue; }
      if (stats.triangles + tris.length > limits.maxTriangles) { stats.skipped += 1; stats.skippedReason = 'triangles_limit'; continue; }
      const pos = new Float32Array(tris.length * 9); const nor = new Float32Array(tris.length * 9);
      const col = color ? new Float32Array(tris.length * 9) : null;
      let o = 0;
      for (const tri of tris) {
        const a = applyPlacement(world, tri[0]), b = applyPlacement(world, tri[1]), c = applyPlacement(world, tri[2]);
        const A = [a[0], a[2], -a[1]], B = [b[0], b[2], -b[1]], C = [c[0], c[2], -c[1]];
        const n = normVec(cross3(sub3(B, A), sub3(C, A)));
        for (const v of [A, B, C]) { pos[o] = v[0]; pos[o + 1] = v[1]; pos[o + 2] = v[2]; nor[o] = n[0]; nor[o + 1] = n[1]; nor[o + 2] = n[2]; if (col) { col[o] = color[0]; col[o + 1] = color[1]; col[o + 2] = color[2]; } o += 3; }
      }
      const obj = { id: product.id, type: product.type, name: stripStr(product.args[2]), guid: stripStr(product.args[0]), pos, nor, col, triangles: tris.length };
      geo.objects.push(obj); stats.objects += 1; stats.triangles += tris.length;
      if (product.type === 'IFCSLAB') stats.slabs += 1; else if (product.type === 'IFCSPACE') stats.spaces += 1; else stats.walls += 1;
      for (let i = 0; i < pos.length; i += 3) {
        for (let k = 0; k < 3; k++) { const v = pos[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
      }
    }
    if (geo.objects.length) geo.bbox = { mn: mn.slice(), mx: mx.slice() };
    return geo;
  }

  function parseIFC(text, opts) {
    opts = opts || {};
    const wantGeometry = opts.geometry === true;
    const limits = Object.assign({}, GEOMETRY_LIMITS, opts.limits || {});
    let project = null; const storeys = [], spaces = [], elements = [];
    const storeyMap = new Map(), spaceMap = new Map(), elemMap = new Map();
    const aggregates = [], contains = [];
    const entMap = wantGeometry ? new Map() : null;
    const geometryIds = [];
    let statementCount = 0;
    for (const st of splitStatements(text)) {
      const m = st.match(/^#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(([\s\S]*)\)$/);
      if (!m) continue;
      statementCount += 1;
      const id = '#' + m[1];
      const type = m[2].toUpperCase(); const args = splitArgs(m[3]);
      const guid = stripStr(args[0]); const name = stripStr(args[2]);
      if (entMap && statementCount <= limits.maxEntities) entMap.set(id, { id, type, args });
      if (type === 'IFCPROJECT') project = name;
      else if (type === 'IFCBUILDINGSTOREY') { storeys.push({ guid, name }); storeyMap.set(id, { id, guid, name }); }
      else if (type === 'IFCSPACE') {
        spaces.push({ guid, name, longName: stripStr(args[7]) });
        spaceMap.set(id, { id, guid, name, longName: stripStr(args[7]), storeyId: null });
        if (GEOMETRY_ELEMENT_TYPES[type]) geometryIds.push(id);
      } else if (type === 'IFCRELAGGREGATES') aggregates.push({ relating: refList(args[4])[0] || null, related: refList(args[5]) });
      else if (type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE') contains.push({ elements: refList(args[4]), structure: refList(args[5])[0] || null });
      else if (ELEMENT_RE.test(type)) {
        elements.push({ guid, ifcType: type, name });
        elemMap.set(id, { id, guid, ifcType: type, name, containerId: null });
        if (GEOMETRY_ELEMENT_TYPES[type]) geometryIds.push(id);
      }
    }
    // IfcSpace -> IfcBuildingStorey (через IFCRELAGGREGATES)
    for (const a of aggregates) {
      if (a.relating && storeyMap.has(a.relating)) for (const r of a.related) { const sp = spaceMap.get(r); if (sp) sp.storeyId = a.relating; }
    }
    // элементы -> пространство/этаж (через IFCRELCONTAINEDINSPATIALSTRUCTURE)
    for (const c of contains) {
      if (!c.structure) continue;
      for (const e of c.elements) { const el = elemMap.get(e); if (el) el.containerId = c.structure; }
    }
    const result = { project, storeys, spaces, elements };
    if (wantGeometry) {
      result.geometry = (entMap && statementCount <= limits.maxEntities)
        ? buildGeometry(entMap, limits, geometryIds)
        : Object.assign(emptyGeometry(limits), { stats: { objects: 0, walls: 0, slabs: 0, spaces: 0, triangles: 0, skipped: 0, skippedReason: 'entities_limit' } });
    }
    return result;
  }

  window.IFCImport = { parseIFC, GEOMETRY_LIMITS, GEOMETRY_ELEMENT_TYPES };
})();
