'use strict';

const path = require('node:path');

const MAX_PIPELINE_BYTES = 1024 * 1024;
const MAX_STAGES = 128;
const MAX_DEPTH = 12;
const MAX_NODES = 4096;
const MAX_STRING_LENGTH = 64 * 1024;

// Raw PDAL pipelines execute native plugins.  Keep the desktop workflow useful,
// but only expose local file readers/writers and filters that do not execute
// user supplied code or open their own data connections.
const SAFE_READERS = new Set([
  'readers.bpf',
  'readers.e57',
  'readers.las',
  'readers.obj',
  'readers.pcd',
  'readers.ply',
  'readers.ptx',
  'readers.pts',
  'readers.qfit',
  'readers.rxp',
  'readers.sbet',
  'readers.text'
]);

const SAFE_WRITERS = new Set([
  'writers.gdal',
  'writers.las',
  'writers.nitf',
  'writers.null',
  'writers.obj',
  'writers.pcd',
  'writers.ply',
  'writers.sbet',
  'writers.text'
]);

const SAFE_FILTERS = new Set([
  'filters.approximatecoplanar',
  'filters.assign',
  'filters.chipper',
  'filters.cluster',
  'filters.covariancefeatures',
  'filters.crop',
  'filters.csf',
  'filters.dbscan',
  'filters.decimation',
  'filters.delaunay',
  'filters.dem',
  'filters.duplicate',
  'filters.eigenvalues',
  'filters.elmad',
  'filters.estimate_rank',
  'filters.expression',
  'filters.ferry',
  'filters.greedyprojection',
  'filters.hag',
  'filters.hag_delaunay',
  'filters.hag_nn',
  'filters.head',
  'filters.icp',
  'filters.info',
  'filters.locate',
  'filters.merge',
  'filters.mortonorder',
  'filters.neighborclassifier',
  'filters.normal',
  'filters.optimalneighborhood',
  'filters.outlier',
  'filters.overlay',
  'filters.planefit',
  'filters.pmf',
  'filters.poisson',
  'filters.radialdensity',
  'filters.range',
  'filters.reciprocity',
  'filters.relaxationdartthrowing',
  'filters.reprojection',
  'filters.returns',
  'filters.sample',
  'filters.skewnessbalancing',
  'filters.smrf',
  'filters.sort',
  'filters.splitter',
  'filters.stats',
  'filters.tail',
  'filters.teaser',
  'filters.transformation',
  'filters.voxelcenternearestneighbor',
  'filters.voxelcentroidnearestneighbor',
  'filters.voxelgrid'
]);

const EXTERNAL_RESOURCE_KEYS = /^(?:aws_.+|azure_.+|bucket|command|connection|datasource|driver|dsn|endpoint|file|filename|function|gdalopts|host|key|module|password|path|program|raster|script|token|uri|url|user|username)$/iu;
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const REMOTE_URI = /(?:^|[\s"'(])(?:https?|ftp|s3|gs|azure|file):\/\//iu;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneBounded(value) {
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch (_) { fail('pdal_pipeline_not_json'); }
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > MAX_PIPELINE_BYTES) {
    fail('pdal_pipeline_too_large');
  }
  return JSON.parse(encoded);
}

function valueLooksLikePath(value) {
  if (typeof value !== 'string') return false;
  if (value.includes('\0') || REMOTE_URI.test(value)) return true;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return true;
  return value.split(/[\\/]+/u).includes('..');
}

function inspectOptions(value, key, state, depth) {
  if (depth > MAX_DEPTH) fail('pdal_pipeline_too_deep');
  state.nodes += 1;
  if (state.nodes > MAX_NODES) fail('pdal_pipeline_too_complex');

  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) fail('pdal_option_too_long');
    if (REMOTE_URI.test(value)) fail('pdal_remote_resource_not_allowed');
    if (key && EXTERNAL_RESOURCE_KEYS.test(key)) fail('pdal_external_resource_not_allowed');
    if (valueLooksLikePath(value)) fail('pdal_external_resource_not_allowed');
    return;
  }
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    if (value.length > MAX_NODES) fail('pdal_pipeline_too_complex');
    for (const item of value) inspectOptions(item, key, state, depth + 1);
    return;
  }
  if (!isPlainObject(value)) fail('pdal_invalid_option');
  for (const [childKey, child] of Object.entries(value)) {
    if (PROTOTYPE_KEYS.has(childKey)) fail('pdal_invalid_option');
    inspectOptions(child, childKey, state, depth + 1);
  }
}

function pipelineStages(pipeline) {
  if (Array.isArray(pipeline)) return pipeline;
  if (!isPlainObject(pipeline)) fail('pdal_invalid_pipeline');
  const keys = Object.keys(pipeline);
  if (keys.length !== 1 || keys[0] !== 'pipeline' || !Array.isArray(pipeline.pipeline)) {
    fail('pdal_invalid_pipeline');
  }
  return pipeline.pipeline;
}

function sanitizeSuggestedName(value, fallback) {
  const name = path.win32.basename(path.posix.basename(String(value || '')));
  if (!name || name === '.' || name === '..' || /[\u0000-\u001f<>:"/\\|?*]/u.test(name)) return fallback;
  return name.slice(0, 180);
}

function inspectPdalPipeline(input) {
  const pipeline = cloneBounded(input);
  const stages = pipelineStages(pipeline);
  if (!stages.length || stages.length > MAX_STAGES) fail('pdal_invalid_stage_count');

  const files = [];
  const state = { nodes: 0 };
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    if (!isPlainObject(stage) || typeof stage.type !== 'string') {
      fail('pdal_explicit_stage_required');
    }
    const type = stage.type.trim().toLowerCase();
    if (type !== stage.type || !/^(?:readers|filters|writers)\.[a-z0-9_]+$/u.test(type)) {
      fail('pdal_invalid_stage_type');
    }

    let kind = null;
    if (type.startsWith('readers.')) {
      if (!SAFE_READERS.has(type)) fail('pdal_reader_not_allowed');
      kind = 'input';
    } else if (type.startsWith('writers.')) {
      if (!SAFE_WRITERS.has(type)) fail('pdal_writer_not_allowed');
      if (type !== 'writers.null') kind = 'output';
    } else if (!SAFE_FILTERS.has(type)) {
      fail('pdal_filter_not_allowed');
    }

    for (const [key, value] of Object.entries(stage)) {
      if (key === 'type') continue;
      if (PROTOTYPE_KEYS.has(key)) fail('pdal_invalid_option');
      if (key === 'filename' && kind) continue;
      inspectOptions(value, key, state, 1);
    }

    if (kind) {
      if (typeof stage.filename !== 'string' || !stage.filename.trim()) {
        fail(kind === 'input' ? 'pdal_reader_filename_required' : 'pdal_writer_filename_required');
      }
      const fallback = kind === 'input' ? `input-${index + 1}.bin` : `output-${index + 1}.bin`;
      files.push({
        id: `stage-${index}`,
        index,
        kind,
        type,
        suggestedName: sanitizeSuggestedName(stage.filename, fallback)
      });
      // A validated pipeline is deliberately non-runnable until main has
      // replaced every claimed path with a native-dialog selection.
      stage.filename = '';
    }
  }
  if (!files.some(item => item.kind === 'input')) fail('pdal_reader_required');
  return { pipeline, files };
}

function bindPdalFile(policy, fileId, selectedPath) {
  if (!policy || !policy.pipeline || !Array.isArray(policy.files)) fail('pdal_invalid_policy');
  const descriptor = policy.files.find(item => item.id === fileId);
  if (!descriptor) fail('pdal_unknown_file_slot');
  if (typeof selectedPath !== 'string' || !path.isAbsolute(selectedPath) || selectedPath.includes('\0')) {
    fail('pdal_invalid_selected_path');
  }
  const stages = pipelineStages(policy.pipeline);
  stages[descriptor.index].filename = selectedPath;
  descriptor.selectedPath = selectedPath;
  return selectedPath;
}

function assertPdalFilesBound(policy) {
  if (!policy || !Array.isArray(policy.files)) fail('pdal_invalid_policy');
  const stages = pipelineStages(policy.pipeline);
  for (const descriptor of policy.files) {
    const selected = stages[descriptor.index] && stages[descriptor.index].filename;
    if (typeof selected !== 'string' || !path.isAbsolute(selected)) fail('pdal_unbound_file_slot');
  }
  return policy.pipeline;
}

module.exports = {
  MAX_PIPELINE_BYTES,
  MAX_STAGES,
  SAFE_READERS,
  SAFE_WRITERS,
  SAFE_FILTERS,
  inspectPdalPipeline,
  bindPdalFile,
  assertPdalFilesBound
};