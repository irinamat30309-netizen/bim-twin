'use strict';
/**
 * Ревизия r109 (фаза 2): JSON-модель scan2bim-v2.py (интерьер или фасад) → IFC4 через
 * renderer/scan2bim.js toIFC (единый IFC-writer приложения, поддерживает storeys[], окна/двери,
 * IfcSpace, плиты). Нужен, чтобы Python-движок не дублировал IFC-писатель.
 *
 *   node tools/scan2bim-py/json-to-ifc.js model.json out.ifc [--name="Модель по облаку"]
 */
const fs = require('node:fs');
const path = require('node:path');
const S = require('../../renderer/scan2bim.js');

function main(argv) {
  const [jsonPath, outPath] = argv;
  if (!jsonPath || !outPath) {
    console.error('нужно: node tools/scan2bim-py/json-to-ifc.js model.json out.ifc [--name=...]');
    process.exit(2);
  }
  const arg = (k) => {
    const i = argv.findIndex(a => a === '--' + k || a.startsWith('--' + k + '='));
    return i >= 0 ? (argv[i].includes('=') ? argv[i].slice(argv[i].indexOf('=') + 1) : argv[i + 1]) : null;
  };
  const model = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (!model || !model.ok) { console.error('модель не ok'); process.exit(1); }
  const name = arg('name') || ('Модель по облаку: ' + path.basename(jsonPath));
  const text = S.toIFC(model, { name, fileName: path.basename(outPath) });
  fs.writeFileSync(outPath, text);
  const counts = {};
  for (const m of text.matchAll(/=([A-Z0-9]+)\(/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
  const keys = ['IFCBUILDINGSTOREY', 'IFCWALLSTANDARDCASE', 'IFCOPENINGELEMENT', 'IFCWINDOW',
    'IFCDOOR', 'IFCSLAB', 'IFCSPACE', 'IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT'];
  const summary = keys.filter(k => counts[k]).map(k => k + ' ' + counts[k]).join(', ');
  console.log(JSON.stringify({
    json: path.basename(jsonPath), ifc: path.basename(outPath), bytes: fs.statSync(outPath).size,
    storeys: (model.storeys || []).length, walls: (model.walls || []).length,
    openings: (model.walls || []).reduce((s, w) => s + (w.openings || []).length, 0),
    counts: summary
  }));
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { main };
