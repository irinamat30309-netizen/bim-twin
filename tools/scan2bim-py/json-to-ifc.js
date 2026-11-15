'use strict';
/**
 * JSON-модель scan2bim-v2.py (интерьер или фасад) → IFC4 через renderer/scan2bim.js toIFC
 * (единый IFC-writer приложения, поддерживает storeys[], окна/двери, IfcSpace, плиты).
 * Нужен, чтобы Python-движок не дублировал IFC-писатель.
 *
 * Геопривязка:
 *   --georef                 — старая форма: EPSG:25833 + sourceTransform t=[500000,6000000,120]
 *                              (геометрия смещается, карта координат тождественная) — оставлено
 *                              для совместимости с py2-final-v2-georef.ifc;
 *   --georef-file=<georef.json>
 *                              — НОВОЕ (r134): реальная геопривязка из georef-rtk.py:
 *                                * IfcProjectedCRS с WKT из georef.json;
 *                                * IfcMapConversion с РЕАЛЬНЫМИ Eastings/Northings/OrthogonalHeight,
 *                                  XAxisAbscissa/XAxisOrdinate (поворот) и Scale из геопривязки;
 *                                * если georef.json требует зеркалирования плана — sourceTransform
 *                                  axis=zup t=[0,0,0] (геометрия локальная, карта реальная);
 *   --crs-wkt / --source-t / --source-axis — явные значения (приоритет выше --georef).
 *
 *   node tools/scan2bim-py/json-to-ifc.js model.json out.ifc [--name="Модель по облаку"]
 *        [--georef] [--georef-file=georef.json] [--crs-wkt="PROJCRS[...]"]
 *        [--source-t=500000,6000000,120] [--source-axis=zup|yup] [--project="Название"]
 */
const fs = require('node:fs');
const path = require('node:path');
const S = require('../../renderer/scan2bim.js');

// WKT EPSG:25833 (ETRS89 / UTM zone 33N) — проверено ifcopenshell (0 ERROR, арность OK),
// совпадает с py2-final-v2-georef.ifc / py2-georef.ifc (фаза 3).
const DEFAULT_WKT = 'PROJCRS["ETRS89 / UTM zone 33N",BASEGEOGCRS["ETRS89",DATUM["European Terrestrial Reference System 1989",ELLIPSOID["GRS 1980",6378137,298.257222101,LENGTHUNIT["metre",1]]],PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]]],CONVERSION["UTM zone 33N",METHOD["Transverse Mercator",ID["EPSG",9807]],PARAMETER["Latitude of natural origin",0,ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Longitude of natural origin",15,ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Scale factor at natural origin",0.9996,SCALEUNIT["unity",1]],PARAMETER["False easting",500000,LENGTHUNIT["metre",1]],PARAMETER["False northing",0,LENGTHUNIT["metre",1]]],CS[Cartesian,2],AXIS["easting (X)",east,ORDER[1],LENGTHUNIT["metre",1]],AXIS["northing (Y)",north,ORDER[2],LENGTHUNIT["metre",1]],ID["EPSG",25833]]';
const DEFAULT_T = [500000, 6000000, 120];

function stepReal(v) {
  const s = Number(v);
  if (!Number.isFinite(s)) return '0.';
  // STEP REAL: всегда с точкой, без экспоненты
  const t = s.toFixed(9).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
  return t.includes('.') ? t : t + '.';
}

function readGeorefFile(file) {
  const g = JSON.parse(fs.readFileSync(file, 'utf8'));
  const m = (g && g.transform && g.transform.ifc_map_conversion) || {};
  const crs = (g && g.crs) || {};
  return {
    raw: g,
    epsg: crs.epsg || null,
    crsName: crs.name || null,
    wkt: crs.wkt || null,
    map: {
      eastings: Number(m.eastings),
      northings: Number(m.northings),
      orthogonalHeight: Number(m.orthogonal_height),
      abscissa: Number(m.x_axis_abscissa),
      ordinate: Number(m.x_axis_ordinate),
      scale: Number(m.scale)
    },
    sourceTransform: m.source_transform || (m.mirror_z ? { axis: 'zup', t: [0, 0, 0] } : null)
  };
}

function main(argv) {
  const [jsonPath, outPath] = argv;
  if (!jsonPath || !outPath) {
    console.error('нужно: node tools/scan2bim-py/json-to-ifc.js model.json out.ifc [--name=...] [--georef] [--georef-file=georef.json]');
    process.exit(2);
  }
  const arg = (k) => {
    const i = argv.findIndex(a => a === '--' + k || a.startsWith('--' + k + '='));
    return i >= 0 ? (argv[i].includes('=') ? argv[i].slice(argv[i].indexOf('=') + 1) : argv[i + 1]) : null;
  };
  const model = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (!model || !model.ok) { console.error('модель не ok'); process.exit(1); }
  const name = arg('name') || ('Модель по облаку: ' + path.basename(jsonPath));
  const georefFile = arg('georef-file');
  const georefFlag = argv.includes('--georef') || arg('georef') === '1' || arg('georef') === 'true';
  let georef = null;
  if (georefFile) {
    try {
      georef = readGeorefFile(georefFile);
    } catch (e) {
      console.error('не прочитан --georef-file: ' + ((e && e.message) || e));
      process.exit(2);
    }
    const mm = georef.map;
    if (![mm.eastings, mm.northings, mm.orthogonalHeight, mm.abscissa, mm.ordinate, mm.scale].every(Number.isFinite)) {
      console.error('в georef.json нет полного ifc_map_conversion');
      process.exit(2);
    }
  }
  const crsWkt = arg('crs-wkt') || (georef ? georef.wkt : (georefFlag ? DEFAULT_WKT : null));
  const sourceT = (arg('source-t') || '').trim()
    ? (arg('source-t').trim().split(',').map(Number))
    : (georef && georef.sourceTransform ? georef.sourceTransform.t
      : (georefFlag ? DEFAULT_T.slice() : null));
  const sourceAxis = arg('source-axis') || (georef && georef.sourceTransform ? georef.sourceTransform.axis : 'zup');
  const project = arg('project');
  if (sourceT && (sourceT.length !== 3 || !sourceT.every(Number.isFinite))) {
    console.error('--source-t: нужны три числа через запятую');
    process.exit(2);
  }
  const opts = { name, fileName: path.basename(outPath) };
  if (sourceT) opts.sourceTransform = { axis: sourceAxis, t: sourceT };
  if (crsWkt) opts.crsWkt = crsWkt;
  if (project) opts.project = project;
  let text = S.toIFC(model, opts);
  // r134: подмена IfcMapConversion на реальные числа из georef.json (в IFC-writer они
  // исторически тождественные, т.к. геометрия смещалась через sourceTransform).
  let mapConversion = null;
  if (georef) {
    const re = /#(\d+)\s*=\s*IFCMAPCONVERSION\(([^;]*)\);/;
    const m = re.exec(text);
    if (!m) {
      console.error('в IFC не найден IFCMAPCONVERSION (нужен crsWkt/--georef)');
      process.exit(1);
    }
    const parts = m[2].split(',').map(s => s.trim());
    if (parts.length !== 8) {
      console.error('IFCMAPCONVERSION: ожидалось 8 аргументов, получено ' + parts.length);
      process.exit(1);
    }
    const mm = georef.map;
    mapConversion = {
      eastings: mm.eastings, northings: mm.northings, orthogonalHeight: mm.orthogonalHeight,
      abscissa: mm.abscissa, ordinate: mm.ordinate, scale: mm.scale
    };
    const replaced = '#' + m[1] + '=IFCMAPCONVERSION(' + parts[0] + ',' + parts[1] + ',' +
      stepReal(mm.eastings) + ',' + stepReal(mm.northings) + ',' + stepReal(mm.orthogonalHeight) +
      ',' + stepReal(mm.abscissa) + ',' + stepReal(mm.ordinate) + ',' + stepReal(mm.scale) + ');';
    text = text.slice(0, m.index) + replaced + text.slice(m.index + m[0].length);
  }
  fs.writeFileSync(outPath, text);
  const counts = {};
  for (const m of text.matchAll(/=([A-Z0-9]+)\(/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
  const keys = ['IFCBUILDINGSTOREY', 'IFCWALLSTANDARDCASE', 'IFCOPENINGELEMENT', 'IFCWINDOW',
    'IFCDOOR', 'IFCSLAB', 'IFCSPACE', 'IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT',
    'IFCPROJECTEDCRS', 'IFCMAPCONVERSION', 'IFCSURFACESTYLE', 'IFCSTYLEDITEM'];
  const summary = keys.filter(k => counts[k]).map(k => k + ' ' + counts[k]).join(', ');
  console.log(JSON.stringify({
    json: path.basename(jsonPath), ifc: path.basename(outPath), bytes: fs.statSync(outPath).size,
    storeys: (model.storeys || []).length, walls: (model.walls || []).length,
    openings: (model.walls || []).reduce((s, w) => s + (w.openings || []).length, 0),
    georef: crsWkt ? {
      crs: (georef && georef.epsg) ? ('EPSG:' + georef.epsg) : 'EPSG:25833/WKT',
      sourceTransform: opts.sourceTransform || null,
      mapConversion
    } : null,
    inferredWalls: (model.walls || []).filter(w => w.inferred || w.material === 'inferred').length,
    counts: summary
  }));
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { main, readGeorefFile };
