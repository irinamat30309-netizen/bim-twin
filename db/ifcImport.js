/*
 * IFC (STEP / ISO-10303-21) parser — Node build for the Electron main process.
 * Mirrors renderer/ifc-import.js. Extracts project / storeys / spaces / elements
 * with their IFC GlobalId. Geometry is intentionally not evaluated (needs web-ifc).
 */
'use strict';
const ELEMENT_RE = /^IFC(WALL|DOOR|WINDOW|SLAB|BEAM|COLUMN|MEMBER|PLATE|COVERING|RAILING|STAIR|ROOF|DUCT\w*|PIPE\w*|CABLE\w*|FLOW\w*|AIRTERMINAL\w*|FAN\w*|PUMP\w*|VALVE\w*|SANITARY\w*|FURNISH\w*|BUILDINGELEMENTPROXY)$/;

function stripStr(v) { if (v == null) return null; v = v.trim(); if (v === '$' || v === '*') return null; if (v[0] === "'" && v[v.length - 1] === "'") return v.slice(1, -1).replace(/''/g, "'"); return v; }

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

function parseIFC(text) {
  let project = null;
  const storeyMap = new Map(), spaceMap = new Map(), elemMap = new Map();
  const aggregates = [], contains = [];
  for (const st of splitStatements(text)) {
    const m = st.match(/^#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(([\s\S]*)\)$/);
    if (!m) continue;
    const id = '#' + m[1]; const type = m[2].toUpperCase(); const args = splitArgs(m[3]);
    const guid = stripStr(args[0]); const name = stripStr(args[2]);
    if (type === 'IFCPROJECT') project = name;
    else if (type === 'IFCBUILDINGSTOREY') storeyMap.set(id, { id, guid, name });
    else if (type === 'IFCSPACE') spaceMap.set(id, { id, guid, name, longName: stripStr(args[7]), storeyId: null });
    else if (type === 'IFCRELAGGREGATES') aggregates.push({ relating: refList(args[4])[0] || null, related: refList(args[5]) });
    else if (type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE') contains.push({ elements: refList(args[4]), structure: refList(args[5])[0] || null });
    else if (ELEMENT_RE.test(type)) elemMap.set(id, { id, guid, ifcType: type, name, containerId: null });
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
  return { project, storeys: [...storeyMap.values()], spaces: [...spaceMap.values()], elements: [...elemMap.values()] };
}

function mapIfcType(t) { t = (t || '').toUpperCase(); if (t.includes('DUCT') || t.includes('AIRTERMINAL') || t.includes('FAN')) return 'вентшахта'; if (t.includes('PIPE') || t.includes('VALVE') || t.includes('PUMP')) return 'труба'; if (t.includes('DOOR')) return 'дверь'; if (t.includes('CABLE')) return 'кабель-канал'; return 'оборудование'; }

module.exports = { parseIFC, mapIfcType };
