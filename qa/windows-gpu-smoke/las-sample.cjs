'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseLASFile } = require('../../las-node');

const DEFAULT_MAX_GPU_POINTS = 1000000;

/**
 * Parse the complete LAS point stream with BIM Twin's production parser, then
 * write only its bounded, evenly sampled arrays for the WebGL fixture.
 * The source scan itself is never copied into a workflow artifact.
 */
function createGpuLasSample(inputPath, outputDirectory, options = {}) {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('BIMTWIN_GPU_LAS_PATH must name a LAS file.');
  }
  if (os.endianness() !== 'LE') {
    throw new Error('The GPU LAS sample writer currently requires a little-endian host.');
  }

  const maxPoints = options.maxPoints == null
    ? DEFAULT_MAX_GPU_POINTS
    : Number(options.maxPoints);
  if (!Number.isSafeInteger(maxPoints) || maxPoints < 1 || maxPoints > 5000000) {
    throw new Error('GPU LAS sample point budget must be an integer from 1 to 5,000,000.');
  }

  const sourcePath = path.resolve(inputPath);
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) throw new Error('GPU LAS input is not a regular file.');
  if (stat.size < 227) throw new Error('GPU LAS input is smaller than a LAS public header.');

  const fd = fs.openSync(sourcePath, 'r');
  let cloud;
  try {
    cloud = parseLASFile(fd, stat.size, maxPoints, options.onProgress);
  } finally {
    fs.closeSync(fd);
  }

  if (!cloud || cloud.ok !== true || cloud.kind !== 'points') {
    throw new Error('BIM Twin production LAS parser did not return point data.');
  }
  const count = Number(cloud.count);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error('Production LAS parser returned an empty or invalid sample.');
  }

  const positions = cloud.pos;
  const colors = cloud.col;
  const intensity = cloud.intensity || new Float32Array(count);
  const classification = cloud.classification || new Uint8Array(count);
  if (!(positions instanceof Float32Array) || positions.length !== count * 3) {
    throw new Error('Production LAS parser returned an invalid position array.');
  }
  if (!(colors instanceof Float32Array) || colors.length !== count * 3) {
    throw new Error('Production LAS parser returned an invalid color array.');
  }
  if (!(intensity instanceof Float32Array) || intensity.length !== count) {
    throw new Error('Production LAS parser returned an invalid intensity array.');
  }
  if (!(classification instanceof Uint8Array) || classification.length !== count) {
    throw new Error('Production LAS parser returned an invalid classification array.');
  }

  const arrays = [
    ['positions', positions],
    ['colors', colors],
    ['intensity', intensity],
    ['classification', classification],
  ];
  const sections = {};
  const buffers = [];
  let byteLength = 0;
  for (const [name, array] of arrays) {
    const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    sections[name] = { offset: byteLength, byteLength: bytes.byteLength };
    buffers.push(bytes);
    byteLength += bytes.byteLength;
  }

  const metadata = {
    formatVersion: 1,
    format: String(cloud.meta && cloud.meta.format || 'LAS'),
    fileBytes: stat.size,
    totalPoints: Number(cloud.meta && cloud.meta.total),
    samplePoints: count,
    hasColor: !!(cloud.meta && cloud.meta.colored && colors),
    hasIntensity: !!cloud.intensity,
    hasClassification: !!cloud.classification,
    dimensions: {
      width: Number(cloud.meta && cloud.meta.w) || 0,
      depth: Number(cloud.meta && cloud.meta.d) || 0,
      height: Number(cloud.meta && cloud.meta.h) || 0,
    },
    byteLength,
    sections,
  };
  if (!Number.isSafeInteger(metadata.totalPoints) || metadata.totalPoints < count) {
    throw new Error('Production LAS parser returned an invalid source point count.');
  }

  fs.mkdirSync(outputDirectory, { recursive: true });
  const samplePath = path.join(outputDirectory, 'las-sample.bin');
  const metadataPath = path.join(outputDirectory, 'las-sample.json');
  fs.writeFileSync(samplePath, Buffer.concat(buffers, byteLength));
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

  return { samplePath, metadataPath, metadata };
}

module.exports = {
  DEFAULT_MAX_GPU_POINTS,
  createGpuLasSample,
};