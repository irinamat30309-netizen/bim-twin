/*
 * IFC (STEP / ISO-10303-21) parser — browser build, zero dependencies (Phase B).
 * Extracts semantic data: project, storeys, spaces, and building elements with
 * their IFC GlobalId. Geometry is NOT evaluated here (that requires web-ifc's
 * WASM BREP kernel); geometry is rendered from glTF/GLB instead, exactly as the
 * plan intends. The GlobalId is the bridge (ifc_guid) to the app database.
 */
(function () {
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

  function parseIFC(text) {
    let project = null; const storeys = [], spaces = [], elements = [];
    for (const st of splitStatements(text)) {
      const m = st.match(/^#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(([\s\S]*)\)$/);
      if (!m) continue;
      const type = m[2].toUpperCase(); const args = splitArgs(m[3]);
      const guid = stripStr(args[0]); const name = stripStr(args[2]);
      if (type === 'IFCPROJECT') project = name;
      else if (type === 'IFCBUILDINGSTOREY') storeys.push({ guid, name });
      else if (type === 'IFCSPACE') spaces.push({ guid, name, longName: stripStr(args[7]) });
      else if (ELEMENT_RE.test(type)) elements.push({ guid, ifcType: type, name });
    }
    return { project, storeys, spaces, elements };
  }

  window.IFCImport = { parseIFC };
})();
