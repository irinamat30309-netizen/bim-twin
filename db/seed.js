/* Seed a fresh SQLite database from buildData() (data.js + findings.json). */
const { buildData } = require('./loadData');

function seed(db) {
  const data = buildData();
  const tx = db.transaction(() => {
    db.prepare('INSERT OR REPLACE INTO projects(id,name,address,status) VALUES (?,?,?,?)')
      .run(data.project.id, data.project.name, data.project.address, data.project.status);
    for (const f of data.floors)
      db.prepare('INSERT OR REPLACE INTO floors(id,project_id,number,name) VALUES (?,?,?,?)')
        .run(f.id, data.project.id, f.number, f.name);
    for (const r of data.rooms) {
      db.prepare('INSERT OR REPLACE INTO rooms(id,floor_id,name,number,type,area_m2,height_m,material,cost,status) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(r.id, r.floor_id, r.name, r.number, r.type, r.area_m2, r.height_m, r.material, r.cost, r.status);
      for (const e of (r.elements || []))
        db.prepare('INSERT OR REPLACE INTO elements(id,room_id,ifc_guid,type,name,ai_status) VALUES (?,?,?,?,?,?)')
          .run(e.id, r.id, e.ifc_guid, e.type, e.name, e.ai_status || 'none');
      for (const d of (r.documents || [])) {
        db.prepare("INSERT OR REPLACE INTO documents(id,room_id,element_id,type,name,version,date,author,file,is_upload,created_at) VALUES (?,?,?,?,?,?,?,?,?,0,datetime('now'))")
          .run(d.id, r.id, d.element_id || null, d.type, d.name, d.version, d.date, d.author, d.file || '');
        for (const v of (d.versions || []))
          db.prepare('INSERT OR REPLACE INTO document_versions(id,document_id,v,date,file) VALUES (?,?,?,?,?)')
            .run(d.id + '_v' + v.v, d.id, v.v, v.date, '');
      }
      for (const f of (r.findings || []))
        db.prepare('INSERT OR REPLACE INTO ai_findings(id,element_id,document_id,kind,severity,confidence,text) VALUES (?,?,?,?,?,?,?)')
          .run(f.id, f.element_id, f.document_id || null, f.kind, f.severity, f.confidence, f.text);
    }
  });
  tx();
}

module.exports = { seed };
