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

function writeCloud(file, points, attributes) {
  attributes = attributes || {};
  const hasIntensity = attributes.intensity != null;
  const hasClassification = attributes.classification != null;
  const header = [
    'ply', 'format binary_little_endian 1.0', 'comment up=y',
    'element vertex ' + points.length, 'property float x', 'property float y',
    'property float z', 'property uchar red', 'property uchar green',
    'property uchar blue'
  ];
  if (hasIntensity) header.push('property float intensity');
  if (hasClassification) header.push('property uchar classification');
  header.push('end_header', '');
  const stride = 15 + (hasIntensity ? 4 : 0) + (hasClassification ? 1 : 0);
  const body = Buffer.alloc(points.length * stride);
  points.forEach((p, i) => {
    const o = i * stride;
    body.writeFloatLE(p[0], o); body.writeFloatLE(p[1], o + 4); body.writeFloatLE(p[2], o + 8);
    body[o + 12] = 200; body[o + 13] = 100; body[o + 14] = 50;
    let attrOffset = o + 15;
    if (hasIntensity) { body.writeFloatLE(attributes.intensity[i], attrOffset); attrOffset += 4; }
    if (hasClassification) body.writeUInt8(attributes.classification[i], attrOffset);
  });
  fs.writeFileSync(file, Buffer.concat([Buffer.from(header.join('\n'), 'ascii'), body]));
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

test('registration and deviation preserve per-point intensity/classification tuples', { skip: !canRunNumpy }, () => {
  const sourceFile = tmp('_attrs_source.ply');
  const targetFile = tmp('_attrs_target.ply');
  const registeredFile = tmp('_attrs_registered.ply');
  const referenceFile = tmp('_attrs_reference.ply');
  const comparedFile = tmp('_attrs_compared.ply');
  const deviationFile = tmp('_attrs_deviation.ply');
  const source = [[0, 0, 0], [1, 0, 0], [0, 2, 0], [0, 0, 3], [1, 2, 3], [2, 0.5, 1]];
  const shift = [0.02, -0.01, 0.015];
  const target = source.map(p => [p[0] + shift[0], p[1] + shift[1], p[2] + shift[2]]);
  const intensity = [0, 0.125, 0.25, 0.5, 0.75, 1];
  const classification = [1, 2, 2, 5, 6, 255];
  const attrs = { intensity, classification };
  const assertAttrs = (file, expectedIntensity, expectedClass) => {
    const parsed = LAS.parseCloudFile(file, { maxPoints: 1000 });
    assert.equal(parsed.ok, true, parsed.message);
    assert.deepEqual(Array.from(parsed.intensity), expectedIntensity);
    assert.deepEqual(Array.from(parsed.classification), expectedClass);
  };
  try {
    writeCloud(sourceFile, source, attrs);
    writeCloud(targetFile, target);
    const register = spawnSync(python, [path.join(__dirname, '..', 'tools', 'pointcloud_geometry.py')], {
      input: JSON.stringify({
        mode: 'register', source: sourceFile, target: targetFile, output: registeredFile,
        threshold: 0.2, maxIter: 20
      }),
      encoding: 'utf8', timeout: 30000
    });
    assert.equal(register.status, 0, register.stderr || register.stdout);
    const registered = JSON.parse(register.stdout.trim().split('\n').filter(Boolean).pop());
    assert.equal(registered.ok, true, JSON.stringify(registered));
    assertAttrs(registeredFile, intensity, classification);

    writeCloud(referenceFile, target);
    writeCloud(comparedFile, source, attrs);
    const deviation = spawnSync(python, [path.join(__dirname, '..', 'tools', 'pointcloud_geometry.py')], {
      input: JSON.stringify({
        mode: 'deviate', reference: referenceFile, compared: comparedFile, output: deviationFile,
        maxDist: 0.2
      }),
      encoding: 'utf8', timeout: 30000
    });
    assert.equal(deviation.status, 0, deviation.stderr || deviation.stdout);
    const result = JSON.parse(deviation.stdout.trim().split('\n').filter(Boolean).pop());
    assert.equal(result.ok, true, JSON.stringify(result));
    assertAttrs(deviationFile, intensity, classification);
  } finally {
    for (const p of [sourceFile, targetFile, registeredFile, referenceFile, comparedFile, deviationFile]) {
      try { fs.unlinkSync(p); } catch (_) {}
    }
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

test('trimmed ICP recovers a small pose with partial overlap and balanced clutter', { skip: !canRunNumpy }, () => {
  const sourceFile = tmp('_robust_source.ply'), targetFile = tmp('_robust_target.ply'), outputFile = tmp('_robust_registered.ply');
  let seed = 0x12345678;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const source = [];
  for (let i = 0; i < 360; i++) {
    const x = random() * 2 - 1, y = random() * 1.6 - 0.8;
    source.push([x, y, 0.23 * Math.sin(2.1 * x) + 0.17 * Math.cos(2.7 * y) + random() * 0.04]);
  }
  const angle = 1.2 * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const translation = [0.045, -0.032, 0.02];
  const overlap = source.slice(0, 288).map(([x, y, z]) => [
    c * x - s * y + translation[0],
    s * x + c * y + translation[1],
    z + translation[2]
  ]);
  // 72 target points are unrelated clutter, balanced over the source footprint.
  const clutter = Array.from({ length: 72 }, () => [
    random() * 2 - 1, random() * 1.6 - 0.8, random() * 0.8 - 0.4
  ]);
  const target = overlap.concat(clutter);
  try {
    writeCloud(sourceFile, source);
    writeCloud(targetFile, target);
    const run = spawnSync(python, [path.join(__dirname, '..', 'tools', 'pointcloud_geometry.py')], {
      input: JSON.stringify({
        mode: 'register', source: sourceFile, target: targetFile, output: outputFile,
        threshold: 0.12, voxel: 0.025, maxIter: 89, trimFraction: 0.75, minOverlap: 0.55
      }),
      encoding: 'utf8', timeout: 30000
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(run.stdout.trim().split('\n').filter(Boolean).pop());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.fitness > 0.7, 'overlap/fitness: ' + result.fitness);
    assert.ok(result.inlierRatio > 0.5, 'retained inlier ratio: ' + result.inlierRatio);
    assert.ok(result.rmse < 0.01, 'robust inlier RMSE: ' + result.rmse);
    assert.ok(Number.isFinite(result.initialFitness));
    assert.ok(Number.isFinite(result.initialRmse));
    assert.ok(result.initialCorrespondences >= 0);
    assert.equal(result.sampledSourcePoints, source.length);
    assert.ok(result.iterations > 0 && result.iterations <= 89);
    assert.equal(result.transform.length, 16);
    const T = result.transform;
    assert.ok(Math.abs(Math.atan2(T[4], T[0]) - angle) < 0.003, 'recovered yaw');
    assert.ok(Math.abs(T[3] - translation[0]) < 0.004, 'recovered X translation');
    assert.ok(Math.abs(T[7] - translation[1]) < 0.004, 'recovered Y translation');
    assert.ok(Math.abs(T[11] - translation[2]) < 0.004, 'recovered Z translation');
    assert.equal(fs.existsSync(outputFile), true);
  } finally {
    for (const p of [sourceFile, targetFile, outputFile]) { try { fs.unlinkSync(p); } catch (_) {} }
  }
});

test('trimmed ICP rejects invalid robust-estimation parameters without writing output', { skip: !canRunNumpy }, () => {
  const sourceFile = tmp('_invalid_source.ply'), targetFile = tmp('_invalid_target.ply'), outputFile = tmp('_invalid_output.ply');
  const points = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]];
  try {
    writeCloud(sourceFile, points);
    writeCloud(targetFile, points);
    const run = spawnSync(python, [path.join(__dirname, '..', 'tools', 'pointcloud_geometry.py')], {
      input: JSON.stringify({ mode: 'register', source: sourceFile, target: targetFile, output: outputFile, trimFraction: 1.2 }),
      encoding: 'utf8', timeout: 30000
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(run.stdout.trim().split('\n').filter(Boolean).pop());
    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid_trim_fraction');
    assert.equal(fs.existsSync(outputFile), false);
  } finally {
    for (const p of [sourceFile, targetFile, outputFile]) { try { fs.unlinkSync(p); } catch (_) {} }
  }
});

test('ICP refuses a near-zero-overlap scene instead of emitting a misleading transform', { skip: !canRunNumpy }, () => {
  const sourceFile = tmp('_no_overlap_source.ply'), targetFile = tmp('_no_overlap_target.ply'), outputFile = tmp('_no_overlap_output.ply');
  let seedA = 44, seedB = 991;
  const random = seed => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const ra = random(seedA), rb = random(seedB);
  const source = Array.from({ length: 40 }, () => [ra(), ra(), ra()]);
  const target = Array.from({ length: 40 }, () => [rb(), rb(), rb()]);
  try {
    writeCloud(sourceFile, source);
    writeCloud(targetFile, target);
    const run = spawnSync(python, [path.join(__dirname, '..', 'tools', 'pointcloud_geometry.py')], {
      input: JSON.stringify({
        mode: 'register', source: sourceFile, target: targetFile, output: outputFile,
        threshold: 1e-9, voxel: 0, maxIter: 12, minOverlap: 0.5
      }),
      encoding: 'utf8', timeout: 30000
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(run.stdout.trim().split('\n').filter(Boolean).pop());
    assert.equal(result.ok, false);
    assert.match(result.error, /insufficient_correspondences|insufficient_final_overlap/);
    assert.equal(fs.existsSync(outputFile), false);
  } finally {
    for (const p of [sourceFile, targetFile, outputFile]) { try { fs.unlinkSync(p); } catch (_) {} }
  }
});

test('geometry PLY writer refuses misaligned attributes rather than silently dropping a point field', { skip: !canRunNumpy }, () => {
  const outputFile = tmp('_bad_attr_output.ply');
  const script = [
    'import importlib.util, sys, numpy as np',
    'spec=importlib.util.spec_from_file_location("geom",sys.argv[1])',
    'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'm.write_ply_numpy(sys.argv[2],np.zeros((2,3)),intensity=np.array([0.1]))'
  ].join(';');
  try {
    const run = spawnSync(python, ['-c', script, path.join(__dirname, '..', 'tools', 'pointcloud_geometry.py'), outputFile], {
      encoding: 'utf8', timeout: 30000
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /invalid_intensity_shape_or_values/);
    assert.equal(fs.existsSync(outputFile), false);
  } finally { try { fs.unlinkSync(outputFile); } catch (_) {} }
});