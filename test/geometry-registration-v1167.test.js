'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const LAS = require('../las-node');

const python = process.env.PYTHON || 'python3';
const probe = spawnSync(python, ['-c', 'import numpy'], { encoding: 'utf8', timeout: 10000 });
const canRunNumpy = probe.status === 0;

function tmp(suffix) {
  return path.join(os.tmpdir(), 'bimtwin_icp_' + process.pid + '_' + Math.random().toString(36).slice(2) + suffix);
}

function writeCloud(file, points) {
  const header = [
    'ply', 'format binary_little_endian 1.0', 'comment up=y',
    'element vertex ' + points.length, 'property float x', 'property float y',
    'property float z', 'property uchar red', 'property uchar green',
    'property uchar blue', 'end_header', ''
  ].join('\n');
  const stride = 15;
  const body = Buffer.alloc(points.length * stride);
  points.forEach((p, i) => {
    const o = i * stride;
    body.writeFloatLE(p[0], o); body.writeFloatLE(p[1], o + 4); body.writeFloatLE(p[2], o + 8);
    body[o + 12] = 200; body[o + 13] = 100; body[o + 14] = 50;
  });
  fs.writeFileSync(file, Buffer.concat([Buffer.from(header, 'ascii'), body]));
}

test('ICP writes the result in the target CRS with double-precision PLY coordinates', { skip: !canRunNumpy }, () => {
  const sourceFile = tmp('_source.ply'), targetFile = tmp('_target.ply'), outputFile = tmp('_registered.ply');
  const source = [[0, 0, 0], [1, 0, 0], [0, 2, 0], [0, 0, 3], [1, 2, 3], [2, 0.5, 1]];
  const delta = [0.1, -0.05, 0.03];
  const target = source.map(p => [p[0] + delta[0], p[1] + delta[1], p[2] + delta[2]]);
  const crs = 'PROJCRS["Test grid",ID["EPSG",32610]]';
  const origin = [500000, 6000000, 100];
  try {
    writeCloud(sourceFile, source);
    writeCloud(targetFile, target);
    const run = spawnSync(python, [path.join(__dirname, '..', 'tools', 'pointcloud_geometry.py')], {
      input: JSON.stringify({
        mode: 'register', source: sourceFile, target: targetFile, output: outputFile,
        threshold: 0.5, maxIter: 20,
        targetFrame: { axis: 'zup', t: origin },
        outputCrsWkt: crs
      }),
      encoding: 'utf8',
      timeout: 30000
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(run.stdout.trim().split('\n').filter(Boolean).pop());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.coordinateFrame, 'target-source');
    assert.equal(result.georeferenced, true);
    assert.ok(result.fitness > 0.9);
    assert.ok(result.rmse < 0.005);

    const head = fs.readFileSync(outputFile).subarray(0, 4096).toString('ascii');
    assert.match(head, /comment up=z/);
    assert.match(head, /comment coordinate_frame=target-source/);
    assert.match(head, /property double x/);
    const parsed = LAS.parseCloudFile(outputFile, { maxPoints: 1000 });
    assert.equal(parsed.ok, true, parsed.message);
    assert.equal(parsed.meta.crsWkt, crs);
    assert.equal(parsed.meta.srcXform.axis, 'zup');
    for (let i = 0; i < source.length; i++) {
      const t = parsed.meta.srcXform.t;
      const got = [
        parsed.pos[i * 3] + t[0],
        -parsed.pos[i * 3 + 2] + t[1],
        parsed.pos[i * 3 + 1] + t[2]
      ];
      const expected = [
        source[i][0] + delta[0] + origin[0],
        -(source[i][2] + delta[2]) + origin[1],
        source[i][1] + delta[1] + origin[2]
      ];
      for (let a = 0; a < 3; a++) assert.ok(Math.abs(got[a] - expected[a]) < 1e-4, 'point ' + i + ', axis ' + a);
      assert.ok(Math.abs(parsed.col[i * 3] - 200 / 255) < 1e-4);
    }
  } finally {
    for (const p of [sourceFile, targetFile, outputFile]) { try { fs.unlinkSync(p); } catch (_) {} }
  }
});

test('deviation heatmap preserves the compared cloud source frame and CRS', { skip: !canRunNumpy }, () => {
  const comparedFile = tmp('_compared.ply'), referenceFile = tmp('_reference.ply'), outputFile = tmp('_deviation.ply');
  const compared = [[0, 0, 0], [1, 0, 0], [0, 2, 0], [0, 0, 3], [1, 2, 3], [2, 0.5, 1]];
  const delta = [0.1, -0.05, 0.03];
  const reference = compared.map(p => [p[0] + delta[0], p[1] + delta[1], p[2] + delta[2]]);
  const crs = 'PROJCRS["Test grid",ID["EPSG",32610]]';
  const origin = [500000, 6000000, 100];
  try {
    writeCloud(comparedFile, compared);
    writeCloud(referenceFile, reference);
    const run = spawnSync(python, [path.join(__dirname, '..', 'tools', 'pointcloud_geometry.py')], {
      input: JSON.stringify({
        mode: 'deviate', reference: referenceFile, compared: comparedFile, output: outputFile,
        maxDist: 0.2, comparedFrame: { axis: 'zup', t: origin }, outputCrsWkt: crs
      }),
      encoding: 'utf8',
      timeout: 30000
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(run.stdout.trim().split('\n').filter(Boolean).pop());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.coordinateFrame, 'target-source');
    assert.equal(result.georeferenced, true);
    assert.ok(result.mean > 0.1 && result.mean < 0.13);
    const parsed = LAS.parseCloudFile(outputFile, { maxPoints: 1000 });
    assert.equal(parsed.ok, true, parsed.message);
    assert.equal(parsed.meta.crsWkt, crs);
    for (let i = 0; i < compared.length; i++) {
      const t = parsed.meta.srcXform.t;
      const got = [
        parsed.pos[i * 3] + t[0],
        -parsed.pos[i * 3 + 2] + t[1],
        parsed.pos[i * 3 + 1] + t[2]
      ];
      const expected = [
        compared[i][0] + origin[0],
        -compared[i][2] + origin[1],
        compared[i][1] + origin[2]
      ];
      for (let a = 0; a < 3; a++) assert.ok(Math.abs(got[a] - expected[a]) < 1e-4, 'point ' + i + ', axis ' + a);
      assert.ok(parsed.col[i * 3] >= 0 && parsed.col[i * 3] <= 1);
    }
  } finally {
    for (const p of [comparedFile, referenceFile, outputFile]) { try { fs.unlinkSync(p); } catch (_) {} }
  }
});

test('mesh PLY writer supports a georeferenced double-precision header', { skip: !canRunNumpy }, () => {
  const outputFile = tmp('_mesh.ply');
  const script = [
    'import importlib.util, sys, numpy as np',
    'spec=importlib.util.spec_from_file_location("geom",sys.argv[1])',
    'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'm.write_mesh_ply(sys.argv[2],np.array([[500000.001,6000000.002,100.003],[500001,6000000,100],[500000,6000001,100]],dtype=np.float64),np.array([[0,1,2]]),up_axis="z",crs_wkt="PROJCRS[\\"Test\\",ID[\\"EPSG\\",32610]]",double_precision=True,coordinate_frame="source")'
  ].join(';');
  try {
    const run = spawnSync(python, ['-c', script, path.join(__dirname, '..', 'tools', 'pointcloud_geometry.py'), outputFile], {
      encoding: 'utf8', timeout: 30000
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const header = fs.readFileSync(outputFile).subarray(0, 4096).toString('ascii');
    assert.match(header, /comment up=z/);
    assert.match(header, /comment coordinate_frame=source/);
    assert.match(header, /comment crs_wkt_uri=/);
    assert.match(header, /property double x/);
    assert.match(header, /element face 1/);
  } finally { try { fs.unlinkSync(outputFile); } catch (_) {} }
});