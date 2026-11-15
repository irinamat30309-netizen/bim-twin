'use strict';
/**
 * JSON-модель scan2bim-v2.py (интерьер или фасад) → IFC4 через renderer/scan2bim.js toIFC
 * (единый IFC-writer приложения, поддерживает storeys[], окна/двери, IfcSpace, плиты).
 * Нужен, чтобы Python-движок не дублировал IFC-писатель.
 *
 * r131: добавлена геопривязка для релиза — `--georef` (по умолчанию EPSG:25833, как в
 * py2-final-v2-georef.ifc: sourceTransform zup t=[500000, 6000000, 120], тождественная
 * карта координат), либо явные `--crs-wkt=...`, `--source-t=x,y,z`, `--source-axis=zup|yup`.
 *
 *   node tools/scan2bim-py/json-to-ifc.js model.json out.ifc [--name="Модель по облаку"]
 *        [--georef] [--crs-wkt="PROJCRS[...]"] [--source-t=500000,6000000,120]
 *        [--source-axis=zup|yup] [--project="Название"]
 */
const fs = require('node:fs');
const path = require('node:path');
const S = require('../../renderer/scan2bim.js');

// WKT EPSG:25833 (ETRS89 / UTM zone 33N) — проверено ifcopenshell (0 ERROR, арность OK),
// совпадает с py2-final-v2-georef.ifc / py2-georef.ifc (фаза 3).
const DEFAULT_WKT = 'PROJCRS["ETRS89 / UTM zone 33N",BASEGEOGCRS["ETRS89",DATUM["European Terrestrial Reference System 1989",ELLIPSOID["GRS 1980",6378137,298.257222101,LENGTHUNIT["metre",1]]],PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]]],CONVERSION["UTM zone 33N",METHOD["Transverse Mercator",ID["EPSG",9807]],PARAMETER["Latitude of natural origin",0,ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Longitude of natural origin",15,ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Scale factor at natural origin",0.9996,SCALEUNIT["unity",1]],PARAMETER["False easting",500000,LENGTHUNIT["metre",1]],PARAMETER["False northing",0,LENGTHUNIT["metre",1]]],CS[Cartesian,2],AXIS["easting (X)",east,ORDER[1],LENGTHUNIT["metre",1]],AXIS["northing (Y)",north,ORDER[2],LENGTHUNIT["metre",1]],ID["EPSG",25833]]';
const DEFAULT_T = [500000, 6000000, 120];

function main(argv) {
  const [jsonPath, outPath] = argv;
  if (!jsonPath || !outPath) {
    console.error('нужно: node tools/scan2bim-py/json-to-ifc.js model.json out.ifc [--name=...] [--georef]');
    process.exit(2);
  }
  const arg = (k) => {
    const i = argv.findIndex(a => a === '--' + k || a.startsWith('--' + k + '='));
    return i >= 0 ? (argv[i].includes('=') ? argv[i].slice(argv[i].indexOf('=') + 1) : argv[i + 1]) : null;
  };
  const model = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (!model || !model.ok) { console.error('модель не ok'); process.exit(1); }
  const name = arg('name') || ('Модель по облаку: ' + path.basename(jsonPath));
  const georefFlag = argv.includes('--georef') || arg('georef') === '1' || arg('georef') === 'true';
  const crsWkt = arg('crs-wkt') || (georefFlag ? DEFAULT_WKT : null);
  const sourceT = (arg('source-t') || '').trim()
    ? (arg('source-t').trim().split(',').map(Number))
    : (georefFlag ? DEFAULT_T.slice() : null);
  const sourceAxis = arg('source-axis') || 'zup';
  const project = arg('project');
  if (sourceT && (sourceT.length !== 3 || !sourceT.every(Number.isFinite))) {
    console.error('--source-t: нужны три числа через запятую');
    process.exit(2);
  }
  const opts = { name, fileName: path.basename(outPath) };
  if (sourceT) opts.sourceTransform = { axis: sourceAxis, t: sourceT };
  if (crsWkt) opts.crsWkt = crsWkt;
  if (project) opts.project = project;
  const text = S.toIFC(model, opts);
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
    georef: crsWkt ? { crs: 'EPSG:25833/WKT', sourceTransform: opts.sourceTransform || null } : null,
    inferredWalls: (model.walls || []).filter(w => w.inferred || w.material === 'inferred').length,
    counts: summary
  }));
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { main };
