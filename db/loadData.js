/*
 * Node-side seed loader. Reads renderer/data.js (SEED model) and ai/findings.json,
 * attaches findings, derives each element's ai_status. Used to seed both stores.
 */
const fs = require('fs');
const path = require('path');

function readSeed() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'data.js'), 'utf8');
  const win = {};
  new Function('window', src)(win);
  return win.SEED;
}

function readFindings() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ai', 'findings.json'), 'utf8')); }
  catch (e) { return []; }
}

function buildData() {
  const seed = readSeed();
  const findings = readFindings();
  const rank = { none: 0, ok: 1, warn: 2, err: 3 };
  const byEl = {};
  for (const f of findings) (byEl[f.element_id] = byEl[f.element_id] || []).push(f);

  const rooms = seed.rooms.map(r => {
    const room = Object.assign({}, r);
    room.elements = (r.elements || []).map(e => Object.assign({}, e));
    room.documents = (r.documents || []).map(d => Object.assign({}, d));
    room.findings = [];
    for (const el of room.elements) {
      const fs2 = byEl[el.id] || [];
      let best = 'none';
      for (const f of fs2) { room.findings.push(Object.assign({}, f)); if (rank[f.severity] > rank[best]) best = f.severity; }
      el.ai_status = best;
    }
    return room;
  });

  return { project: seed.project, floors: seed.floors, rooms };
}

module.exports = { buildData, readSeed, readFindings };
