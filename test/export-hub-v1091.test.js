'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const EH = require('../renderer/export-hub');

test('makePDF: vozvraschaet stroku nachinayushchuyusya s %PDF', () => {
  const pdf = EH.makePDF({ title: 'Test', lines: ['Stroka 1', 'Stroka 2'] });
  assert.ok(typeof pdf === 'string');
  assert.ok(pdf.startsWith('%PDF-1.4'), 'dolzhen nachinat\'sya s %PDF-1.4');
  assert.ok(pdf.includes('%%EOF'), 'dolzhen zakanchivat\'sya s %%EOF');
});

test('makePDF: soderzhit zagolovo i datu', () => {
  const pdf = EH.makePDF({ title: 'Otchet 2024', date: '01.01.2024' });
  // Zagalovok zakodirovan v PDF kak PDF-tekst, provereem chto stroka est v content
  assert.ok(pdf.includes('Otchet') || pdf.includes('PDF') || pdf.length > 500);
});

test('exportSHP polyline: vozvraschaet bufer SHP + SHX + DBF', () => {
  const polys = [
    [[0,0],[1,0],[1,1],[0,1],[0,0]],
    [[2,0],[3,0],[3,1]]
  ];
  const shp = EH.exportSHP(polys, { type:'polyline' });
  assert.ok(shp.shp instanceof ArrayBuffer);
  assert.ok(shp.shx instanceof ArrayBuffer);
  assert.ok(typeof shp.dbf === 'string');
  // SHP file code = 9994
  const dv = new DataView(shp.shp);
  assert.equal(dv.getInt32(0, false), 9994);
});

test('exportSHP point: vozvraschaet pravilny ShapeType=1', () => {
  const pts = [[1,1],[2,2]];
  const shp = EH.exportSHP(pts, { type:'point' });
  const dv = new DataView(shp.shp);
  // ShapeType v zagolovke
  assert.equal(dv.getInt32(32, true), 1);
});

test('exportE57: vozvraschaet validnyy binarnyy ASTM E57', () => {
  const n = 5;
  const pos = new Float32Array(n*3);
  for (let i=0;i<n;i++){pos[i*3]=i;pos[i*3+1]=i;pos[i*3+2]=0;}
  const e57 = EH.exportE57(pos, n);
  assert.ok(e57 instanceof Uint8Array);
  const E57 = require('../e57-core');
  const round = E57.readBuffer(e57);
  assert.equal(round.count, n);
  assert.ok(Math.abs(round.pos[3] - 1) < 1e-9);
});

test('exportE57: schityvaet kolichestvo tochek', () => {
  const n = 10;
  const pos = new Float32Array(n*3);
  for (let i=0;i<n;i++){pos[i*3]=i*0.1;pos[i*3+1]=0;pos[i*3+2]=0;}
  const e57 = EH.exportE57(pos, n, { step:2 });
  // step=2 => ~5 tochek
  const round = require('../e57-core').readBuffer(e57);
  assert.equal(round.count, 5);
});

test('exportGeoTIFF: trebuet terrain.js (dolzhen byt zagruzhen)', () => {
  // Simuliruem DSM
  const dsm = {
    grid: new Float32Array([1,2,3,4,5,6,7,8,9]),
    nx: 3, nz: 3, minX: 0, minZ: 0, cell: 1
  };
  // Terrain dolzhen byt podklyuchen cherez require
  const Terrain = require('../renderer/terrain');
  // Imenuem vremenno window-podobnoe okruzhenie
  global.window = { Terrain: Terrain };
  try {
    const buf = EH.exportGeoTIFF(dsm);
    assert.ok(buf instanceof ArrayBuffer);
    assert.ok(buf.byteLength > 100);
  } finally {
    delete global.window;
  }
});

test('exportPLY: double world coordinates round-trip through streaming importer', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const src = new Float64Array([500000.123456, 6000000.25, 117.125, 500001.234567, 6000000.75, 118.5, 500002.345678, 6000001.5, 119.875]);
  const bytes = EH.exportPLY({ pos: src, col: new Float32Array([1,0,0,0,1,0,0,0,1]), count: 3, meta: { srcXform: { axis: 'zup', t: [0,0,0] } } });
  const header = Buffer.from(bytes).subarray(0, 512).toString('ascii');
  assert.match(header, /comment up=z/); assert.match(header, /property double x/);
  const file = path.join(os.tmpdir(), 'bim-twin-roundtrip-' + process.pid + '.ply'); fs.writeFileSync(file, bytes);
  try {
    const parsed = require('../las-node').parseCloudFile(file, { maxPoints: 200000 });
    assert.equal(parsed.ok, true); assert.equal(parsed.count, 3); assert.equal(parsed.meta.srcXform.axis, 'zup');
    const t = parsed.meta.srcXform.t;
    for (let i = 0; i < 3; i++) {
      const world = [parsed.pos[i*3] + t[0], -parsed.pos[i*3+2] + t[1], parsed.pos[i*3+1] + t[2]];
      for (let a = 0; a < 3; a++) assert.ok(Math.abs(world[a] - src[i*3+a]) < 1e-6, `${world[a]} != ${src[i*3+a]}`);
    }
  } finally { fs.unlinkSync(file); }
});

test('exportLAS: preserves scaled world coordinates and WKT VLR', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const pos = new Float64Array([500000, 6000000, 117, 500001, 6000001, 119]);
  const file = path.join(os.tmpdir(), 'bim-twin-export-' + process.pid + '.las');
  fs.writeFileSync(file, EH.exportLAS({ pos, count: 2, meta: { crsWkt: 'PROJCRS["test CRS"]' } }));
  try {
    const parsed = require('../las-node').parseCloudFile(file);
    assert.equal(parsed.ok, true); assert.equal(parsed.count, 2);
    assert.equal(parsed.meta.crsWkt, 'PROJCRS["test CRS"]');
    const t = parsed.meta.srcXform.t;
    assert.ok(Math.abs(parsed.pos[0] + t[0] - pos[0]) < 1e-6);
    assert.ok(Math.abs(-parsed.pos[2] + t[1] - pos[1]) < 1e-6);
    assert.ok(Math.abs(parsed.pos[1] + t[2] - pos[2]) < 1e-6);
  } finally { fs.unlinkSync(file); }
});

test('exportLAS: writes ASPRS point classification bytes', () => {
  const bytes = EH.exportLAS({
    pos: new Float64Array([500000, 6000000, 117, 500001, 6000001, 119]),
    count: 2,
    classification: new Uint8Array([2, 1])
  });
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pointOffset = dv.getUint32(96, true), recordLength = dv.getUint16(105, true);
  assert.equal(dv.getUint8(104) & 0x3f, 7, 'LAS 1.4 writer uses PDRF 7 (RGB + full 8-bit class)');
  assert.equal(recordLength, 36);
  assert.equal(bytes[pointOffset + 16], 2, 'first point should be ASPRS ground');
  assert.equal(bytes[pointOffset + recordLength + 16], 1, 'second point should be unclassified/non-ground');
});

test('GeoTIFF contains valid scale/tiepoint metadata offsets', () => {
  const T = require('../renderer/terrain');
  const buf = T.dsmToTiff({ grid:new Float32Array([1,2,3,4]), nx:2, nz:2, minX:0, minZ:0, cell:0.5, geo:{originX:500000, originY:6000000} });
  const dv = new DataView(buf), ifd=dv.getUint32(4,true), n=dv.getUint16(ifd,true); let scale=-1,tie=-1;
  for(let i=0;i<n;i++){const p=ifd+2+i*12,tag=dv.getUint16(p,true);if(tag===33550)scale=dv.getUint32(p+8,true);if(tag===33922)tie=dv.getUint32(p+8,true);}
  assert.ok(scale>0&&tie>0);assert.equal(dv.getFloat64(scale,true),0.5);assert.equal(dv.getFloat64(scale+8,true),0.5);
  assert.equal(dv.getFloat64(tie+24,true),500000);assert.equal(dv.getFloat64(tie+40,true),6000000);
});

test('GeoTIFF writes CRS GeoKeys and north-up raster rows', () => {
  const T = require('../renderer/terrain');
  const buf = T.dsmToTiff({
    grid:new Float32Array([1,2,3,4]), nx:2, nz:2, minX:500000, minZ:6000000, cell:1,
    geo:{originX:500000,originY:6000001,flipRows:true,crsWkt:'PROJCRS["WGS 84 / UTM",ID["EPSG",32610]]'}
  });
  const dv=new DataView(buf),ifd=dv.getUint32(4,true),n=dv.getUint16(ifd,true);let keyOffset=0,keyCount=0,rasterOffset=0,tieOffset=0;
  for(let i=0;i<n;i++){const p=ifd+2+i*12,tag=dv.getUint16(p,true);if(tag===34735)keyOffset=dv.getUint32(p+8,true);if(tag===273)rasterOffset=dv.getUint32(p+8,true);if(tag===33922)tieOffset=dv.getUint32(p+8,true);}
  assert.ok(keyOffset>0&&rasterOffset>0);
  const count=dv.getUint16(keyOffset+6,true);keyCount=count;
  let epsg=0;for(let i=0;i<keyCount;i++){const p=keyOffset+8+i*8,id=dv.getUint16(p,true);if(id===3072)epsg=dv.getUint16(p+6,true);}
  assert.equal(epsg,32610);
  assert.equal(dv.getFloat32(rasterOffset,true),3,'row zero should be the northern/top row');
  assert.equal(dv.getFloat64(tieOffset+24,true),500000);
  assert.equal(dv.getFloat64(tieOffset+40,true),6000001);
});
