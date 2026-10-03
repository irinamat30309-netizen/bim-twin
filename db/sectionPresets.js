'use strict';

const MAX_SECTION_PRESETS = 100;
const MAX_NAME_LENGTH = 80;
const AXES = new Set(['x', 'y', 'z', 'profile']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value, label, maxLength) {
  if (typeof value !== 'string') throw new TypeError(label + ' must be text');
  const text = value.trim();
  if (!text) throw new TypeError(label + ' is required');
  if (text.length > maxLength) throw new RangeError(label + ' is too long');
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new TypeError(label + ' contains control characters');
  return text;
}

function optionalText(value, label, maxLength) {
  if (value == null || value === '') return '';
  return requiredText(String(value), label, maxLength);
}

function number(value, label, min, max, nullable) {
  if (nullable && value == null) return null;
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) {
    throw new TypeError(label + ' must be a finite number');
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new RangeError(label + ' is outside the supported range');
  }
  return parsed;
}

function finiteVector(value, label) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError(label + ' must contain three coordinates');
  }
  return value.map((v, i) => number(v, label + '[' + i + ']', -1e12, 1e12, false));
}

function normalizeDraft(input) {
  if (!isObject(input)) throw new TypeError('Section preset must be an object');
  const name = requiredText(input.name, 'Preset name', MAX_NAME_LENGTH);
  const sourceInput = input.source == null ? {} : input.source;
  if (!isObject(sourceInput)) throw new TypeError('Preset source must be an object');

  let bounds = null;
  if (sourceInput.bounds != null) {
    if (!isObject(sourceInput.bounds)) throw new TypeError('Source bounds must be an object');
    const min = finiteVector(sourceInput.bounds.min, 'Source bounds min');
    const max = finiteVector(sourceInput.bounds.max, 'Source bounds max');
    if (min.some((v, i) => v > max[i])) throw new RangeError('Source bounds are inverted');
    bounds = { min, max };
  }

  let srcXform = null;
  if (sourceInput.srcXform != null) {
    const tr = sourceInput.srcXform;
    if (!isObject(tr) || !['zup', 'yup'].includes(tr.axis)) {
      throw new TypeError('Source coordinate transform is invalid');
    }
    srcXform = { axis: tr.axis, t: finiteVector(tr.t, 'Source transform') };
  }

  const pointCount = sourceInput.pointCount == null
    ? null
    : number(sourceInput.pointCount, 'Source point count', 1, Number.MAX_SAFE_INTEGER, false);
  if (pointCount != null && !Number.isSafeInteger(pointCount)) {
    throw new RangeError('Source point count must be an integer');
  }

  const paramsInput = input.params || input.parameters;
  if (!isObject(paramsInput)) throw new TypeError('Preset parameters are required');
  const axis = String(paramsInput.axis || '').toLowerCase();
  if (!AXES.has(axis)) throw new TypeError('Section axis must be X, Y, Z, or profile');
  const params = {
    axis,
    level: number(paramsInput.level, 'Section level', -1e12, 1e12, axis === 'profile'),
    thickness: number(paramsInput.thickness, 'Band thickness', 0.01, 100, false),
    cell: number(paramsInput.cell, 'Raster cell size', 0.01, 10, false),
    minArea: number(paramsInput.minArea, 'Minimum contour area', 0, 10000, false),
    azimuthDeg: number(paramsInput.azimuthDeg == null ? 0 : paramsInput.azimuthDeg, 'Profile azimuth', -3600, 3600, false),
    originX: number(paramsInput.originX == null ? 0 : paramsInput.originX, 'Profile origin X', -1e12, 1e12, false),
    originZ: number(paramsInput.originZ == null ? 0 : paramsInput.originZ, 'Profile origin Z', -1e12, 1e12, false),
    offset: number(paramsInput.offset == null ? 0 : paramsInput.offset, 'Profile offset', -1e6, 1e6, false)
  };
  if (axis !== 'profile' && params.level == null) throw new TypeError('Section level is required');

  return {
    name,
    source: {
      name: optionalText(sourceInput.name, 'Source name', 256),
      pointCount,
      pointSampleHash: optionalText(sourceInput.pointSampleHash, 'Source sample fingerprint', 64),
      bounds,
      srcXform,
      crsCode: optionalText(sourceInput.crsCode, 'Source CRS code', 128)
    },
    params
  };
}

function validDate(value, fallback) {
  if (typeof value !== 'string' || !value) return fallback;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function normalizePreset(input, options) {
  const opts = options || {};
  const draft = normalizeDraft(input);
  const now = validDate(opts.now, new Date().toISOString());
  const id = requiredText(String(opts.id || input.id || ''), 'Preset ID', 128);
  return {
    id,
    name: draft.name,
    source: draft.source,
    params: draft.params,
    createdAt: validDate(opts.createdAt || input.createdAt, now),
    updatedAt: validDate(opts.updatedAt || input.updatedAt, now)
  };
}

function nameKey(name) {
  return String(name).normalize('NFKC').trim().toLocaleLowerCase('ru-RU');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  MAX_SECTION_PRESETS,
  MAX_NAME_LENGTH,
  normalizeDraft,
  normalizePreset,
  nameKey,
  clone
};