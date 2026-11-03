'use strict';

const fs = require('node:fs');

/**
 * Stream an interleaved PLY vertex table to disk.
 *
 * The viewer stores intensity as a normalized scalar and classification as an
 * integer code. The PLY fields deliberately retain those semantics instead of
 * baking attributes into RGB or silently dropping them during temporary-file
 * conversion (including registration and deviation workflows).
 */
function writePlyBinaryToDisk(filePath, pos, col, hasColor, opts) {
  opts = opts || {};
  if (!pos || !Number.isSafeInteger(pos.length) || pos.length % 3 !== 0) {
    throw new RangeError('invalid_position_array');
  }
  const n = pos.length / 3;
  const doublePrecision = opts.doublePrecision === true;
  const coordType = doublePrecision ? 'double' : 'float';
  const coordBytes = doublePrecision ? 8 : 4;
  const intensity = opts.intensity == null ? null : opts.intensity;
  const classification = opts.classification == null ? null : opts.classification;
  const hasIntensity = intensity !== null;
  const hasClassification = classification !== null;

  if (hasColor && (!col || col.length !== pos.length)) {
    throw new RangeError('color_array_length_mismatch');
  }
  if (hasIntensity && (!intensity || intensity.length !== n)) {
    throw new RangeError('intensity_array_length_mismatch');
  }
  if (hasClassification && (!classification || classification.length !== n)) {
    throw new RangeError('classification_array_length_mismatch');
  }
  if (hasIntensity && !ArrayBuffer.isView(intensity) && !Array.isArray(intensity)) {
    throw new TypeError('invalid_intensity_array');
  }
  if (hasClassification && !ArrayBuffer.isView(classification) && !Array.isArray(classification)) {
    throw new TypeError('invalid_classification_array');
  }

  const H = ['ply', 'format binary_little_endian 1.0', 'comment BIM Twin cloud export'];
  if (opts.upAxis === 'z' || opts.upAxis === 'y') H.push('comment up=' + opts.upAxis);
  if (opts.crsWkt) H.push('comment crs_wkt_uri=' + encodeURIComponent(String(opts.crsWkt)));
  if (opts.coordinateFrame) H.push('comment coordinate_frame=' + String(opts.coordinateFrame).replace(/[^A-Za-z0-9_.:-]/g, '_'));
  H.push('element vertex ' + n, 'property ' + coordType + ' x', 'property ' + coordType + ' y', 'property ' + coordType + ' z');
  if (hasColor) H.push('property uchar red', 'property uchar green', 'property uchar blue');
  if (hasIntensity) H.push('property float intensity');
  if (hasClassification) H.push('property uchar classification');
  H.push('end_header', '');

  let scaled = true; // Float color arrays are normally 0..1; byte arrays are 0..255.
  if (hasColor && col) {
    let mx = 0;
    const lim = Math.min(col.length, 300);
    for (let i = 0; i < lim; i++) if (col[i] > mx) mx = col[i];
    if (mx > 1.0001) scaled = false;
  }
  const toByte = v => {
    v = scaled ? Math.round(v * 255) : Math.round(v);
    return v < 0 ? 0 : (v > 255 ? 255 : v);
  };
  const tempPath = filePath + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 10);
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'wx');
    fs.writeSync(fd, Buffer.from(H.join('\n'), 'ascii'));
    const stride = coordBytes * 3 + (hasColor ? 3 : 0) + (hasIntensity ? 4 : 0) + (hasClassification ? 1 : 0);
    const CHUNK = 200000;
    const buf = Buffer.allocUnsafe(CHUNK * stride);
    let i = 0;
    while (i < n) {
      const mm = Math.min(CHUNK, n - i);
      let off = 0;
      for (let k = 0; k < mm; k++) {
        const pointIndex = i + k;
        const p = pointIndex * 3;
        const x = Number(pos[p]), y = Number(pos[p + 1]), z = Number(pos[p + 2]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          throw new RangeError('non_finite_coordinates');
        }
        if (doublePrecision) {
          buf.writeDoubleLE(x, off); off += 8;
          buf.writeDoubleLE(y, off); off += 8;
          buf.writeDoubleLE(z, off); off += 8;
        } else {
          if (Math.abs(x) > 3.402823466e38 || Math.abs(y) > 3.402823466e38 || Math.abs(z) > 3.402823466e38) {
            throw new RangeError('coordinate_out_of_float32_range');
          }
          buf.writeFloatLE(x, off); off += 4;
          buf.writeFloatLE(y, off); off += 4;
          buf.writeFloatLE(z, off); off += 4;
        }
        if (hasColor) {
          const red = Number(col[p]), green = Number(col[p + 1]), blue = Number(col[p + 2]);
          if (!Number.isFinite(red) || !Number.isFinite(green) || !Number.isFinite(blue)) {
            throw new RangeError('invalid_color_value');
          }
          buf.writeUInt8(toByte(red), off); off += 1;
          buf.writeUInt8(toByte(green), off); off += 1;
          buf.writeUInt8(toByte(blue), off); off += 1;
        }
        if (hasIntensity) {
          const value = Number(intensity[pointIndex]);
          if (!Number.isFinite(value) || Math.abs(value) > 3.402823466e38) {
            throw new RangeError('invalid_intensity_value');
          }
          buf.writeFloatLE(value, off); off += 4;
        }
        if (hasClassification) {
          const value = Number(classification[pointIndex]);
          if (!Number.isInteger(value) || value < 0 || value > 255) {
            throw new RangeError('invalid_classification_value');
          }
          buf.writeUInt8(value, off); off += 1;
        }
      }
      fs.writeSync(fd, buf, 0, off);
      i += mm;
    }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.unlinkSync(tempPath); } catch (_) {}
    throw err;
  }
  return n;
}

module.exports = { writePlyBinaryToDisk };