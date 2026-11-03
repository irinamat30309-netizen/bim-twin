'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const las = require('../las-node');
const core = require('../las-core');

function tmp(ext) { return path.join(os.tmpdir(), 'bimtwin_' + Date.now() + '_' + Math.random().toString(36).slice(2) + ext); }

function writeBinPly(file, pts) {
  const header = 'ply\nformat binary_little_endian 1.0\nelement vertex ' + pts.length +
    '\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n';
  const recLen = 3 * 4 + 3;
  const body = Buffer.alloc(pts.length * recLen);
  pts.forEach((p, i) => {
    const o = i * recLen;
    body.writeFloatLE(p[0], o); body.writeFloatLE(p[1], o + 4); body.writeFloatLE(p[2], o + 8);
    body.writeUInt8(p[3], o + 12); body.writeUInt8(p[4], o + 13); body.writeUInt8(p[5], o + 14);
  });
  fs.writeFileSync(file, Buffer.concat([Buffer.from(header, 'ascii'), body]));
}

function writeAsciiPly(file, pts) {
  let s = 'ply\nformat ascii 1.0\nelement vertex ' + pts.length +
    '\nproperty float x\nproperty float y\nproperty float z\nend_header\n';
  for (const p of pts) s += p[0] + ' ' + p[1] + ' ' + p[2] + '\n';
  fs.writeFileSync(file, s, 'ascii');
}

const PTS = [[0, 0, 0, 255, 0, 0], [2, 0, 0, 0, 255, 0], [0, 4, 0, 0, 0, 255], [0, 0, 6, 255, 255, 0]];

test('streaming binary PLY point cloud: counts, color, bbox, centering', () => {
  const f = tmp('.ply'); writeBinPly(f, PTS);
  const r = las.parseCloudFile(f, { maxPoints: 1000000 });
  fs.unlinkSync(f);
  assert.equal(r.ok, true);
  assert.equal(r.count, 4);
  assert.equal(r.meta.colored, true);
  assert.ok(Math.abs(r.meta.w - 2) < 1e-4, 'w=2');
  assert.ok(Math.abs(r.meta.h - 4) < 1e-4, 'h=4');
  assert.ok(Math.abs(r.meta.d - 6) < 1e-4, 'd=6');
  // centered on bbox center: min+max ~ 0 per axis
  let mnx = Infinity, mxx = -Infinity;
  for (let i = 0; i < r.count; i++) { const x = r.pos[i * 3]; if (x < mnx) mnx = x; if (x > mxx) mxx = x; }
  assert.ok(Math.abs(mnx + mxx) < 1e-4, 'x centered');
  // first point was red (255,0,0)
  assert.ok(Math.abs(r.col[0] - 1) < 1e-4 && r.col[1] < 1e-4, 'red preserved');
});

test('ascii PLY streaming with elevation ramp (no color)', () => {
  const f = tmp('.ply'); writeAsciiPly(f, PTS);
  const r = las.parseCloudFile(f, { maxPoints: 1000000 });
  fs.unlinkSync(f);
  assert.equal(r.ok, true);
  assert.equal(r.count, 4);
  assert.equal(r.meta.colored, false);
  // ramp fills colors within [0,1]
  for (let i = 0; i < r.col.length; i++) { assert.ok(r.col[i] >= 0 && r.col[i] <= 1); }
});

test('stride sampling caps output points', () => {
  const f = tmp('.ply'); writeBinPly(f, PTS);
  const fd = fs.openSync(f, 'r'); const st = fs.statSync(f);
  const r = las.parsePLYFile(fd, st.size, 2); // budget 2 -> stride 2 -> 2 points
  fs.closeSync(fd); fs.unlinkSync(f);
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
});

test('PLY round-trip keeps double-precision Z-up coordinates and CRS WKT', () => {
  const file = tmp('.ply');
  const crs = 'PROJCRS["Test grid",ID["EPSG",32610]]';
  const points = [
    [500000.012, 6000000.023, 100.034],
    [500001.012, 6000000.023, 100.034],
    [500000.012, 6000001.023, 100.034]
  ];
  const header = [
    'ply', 'format binary_little_endian 1.0', 'comment up=z',
    'comment crs_wkt_uri=' + encodeURIComponent(crs),
    'element vertex ' + points.length, 'property double x', 'property double y',
    'property double z', 'end_header', ''
  ].join('\n');
  const body = Buffer.alloc(points.length * 24);
  points.forEach((p, i) => {
    const o = i * 24;
    body.writeDoubleLE(p[0], o); body.writeDoubleLE(p[1], o + 8); body.writeDoubleLE(p[2], o + 16);
  });
  fs.writeFileSync(file, Buffer.concat([Buffer.from(header, 'ascii'), body]));
  const r = las.parseCloudFile(file, { maxPoints: 1000 });
  fs.unlinkSync(file);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.meta.crsWkt, crs);
  assert.equal(r.meta.srcXform.axis, 'zup');
  for (let i = 0; i < points.length; i++) {
    const t = r.meta.srcXform.t;
    const world = [r.pos[i * 3] + t[0], -r.pos[i * 3 + 2] + t[1], r.pos[i * 3 + 1] + t[2]];
    for (let a = 0; a < 3; a++) assert.ok(Math.abs(world[a] - points[i][a]) < 1e-5, 'world axis ' + a + ' preserved');
  }
  assert.equal(core.plyCrsWkt(['crs_wkt_uri=' + encodeURIComponent(crs)]), crs);
  assert.equal(core.plyCrsWkt(['CRS=EPSG:32610']), 'EPSG:32610');
});

test('unsupported extension returns friendly message', () => {
  const f = tmp('.unsupported'); fs.writeFileSync(f, 'x');
  const r = las.parseCloudFile(f, {});
  fs.unlinkSync(f);
  assert.equal(r.ok, false);
  assert.match(r.message, /\.las|\.ply/);
});
