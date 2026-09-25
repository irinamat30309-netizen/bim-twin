'use strict';

// Bounded-working-set PCD reader for the disk-backed octree. ASCII and
// interleaved binary are read directly; field-major binary_compressed is
// LZF-decoded to a temporary planar store and then read in bounded chunks.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./las-core');

const HEADER_LIMIT = 1024 * 1024;
const LINE_LIMIT = 1024 * 1024;
const READ_CHUNK_BYTES = 8 * 1024 * 1024;
const LZF_HISTORY_BYTES = 1 << 13;
function progressAt(callback, phase, fraction, detail) {
  if (typeof callback !== 'function') return;
  const value = { phase, fraction: Math.max(0, Math.min(1, Number(fraction) || 0)) };
  if (detail && typeof detail === 'object') Object.assign(value, detail);
  try { callback(value); } catch (_) {}
}

function assertTemporarySpace(directory, requiredBytes) {
  if (typeof fs.statfsSync !== 'function') return;
  let stat;
  try {
    stat = fs.statfsSync(directory, { bigint: true });
  } catch (error) {
    if (['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL'].includes(error && error.code)) return;
    throw new Error('PCD: не удалось проверить свободное место для временного LZF-файла: ' +
      String((error && error.message) || error));
  }
  const asBigInt = value => typeof value === 'bigint' ? value : BigInt(Math.max(0, Math.trunc(Number(value) || 0)));
  const freeBytes = asBigInt(stat.bavail) * asBigInt(stat.bsize);
  const reserveBytes = BigInt(Math.max(32 * 1024 * 1024, Math.ceil(requiredBytes * 0.02)));
  const neededBytes = BigInt(requiredBytes) + reserveBytes;
  if (freeBytes < neededBytes) {
    const mib = value => (Number(value) / (1024 * 1024)).toLocaleString('ru-RU', { maximumFractionDigits: 0 });
    throw new Error('PCD: недостаточно места для потоковой распаковки LZF — нужно около ' +
      mib(neededBytes) + ' МиБ, свободно ' + mib(freeBytes) + ' МиБ');
  }
}

function readExactAt(fd, buffer, length, position, message) {
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buffer, got, length - got, position + got);
    if (n <= 0) throw new Error(message || 'truncated PCD data');
    got += n;
  }
  return got;
}

function statIdentity(stat) {
  return {
    fileSize: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    device: String(stat.dev),
    inode: String(stat.ino)
  };
}

function integerValue(values, label, fallback) {
  if (!values || !values.length) return fallback;
  const text = String(values[0]).trim();
  if (!/^\d+$/.test(text)) throw new Error('PCD: некорректное поле ' + label);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('PCD: некорректное поле ' + label);
  return value;
}

function parsePcdHeader(fd, fileSize) {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) throw new Error('PCD file size exceeds safe limits');
  const headerBytes = Math.min(fileSize, HEADER_LIMIT);
  const buffer = Buffer.alloc(headerBytes);
  readExactAt(fd, buffer, headerBytes, 0, 'truncated PCD header');
  const text = buffer.toString('latin1');
  const dataMatch = /^DATA\s+([^\r\n]+)\r?\n/im.exec(text);
  if (!dataMatch) throw new Error('PCD: DATA header was not found within 1 MiB');
  const dataOffset = dataMatch.index + dataMatch[0].length;
  const rawHeader = text.slice(0, dataMatch.index);
  const header = Object.create(null);
  const comments = [];
  for (const raw of rawHeader.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === '#') {
      comments.push(line.slice(1).trim());
      continue;
    }
    const tokens = line.split(/\s+/);
    const key = tokens.shift().toUpperCase();
    if (header[key]) throw new Error('PCD: duplicate header field ' + key);
    header[key] = tokens;
  }

  const fields = (header.FIELDS || header.FIELD || []).map(value => String(value).toLowerCase());
  const sizes = (header.SIZE || []).map(Number);
  const types = (header.TYPE || []).map(value => String(value).toUpperCase());
  const counts = (header.COUNT || fields.map(() => '1')).map(Number);
  if (!fields.length || fields.length !== sizes.length ||
      fields.length !== types.length || fields.length !== counts.length) {
    throw new Error('PCD: повреждены FIELDS/SIZE/TYPE/COUNT');
  }
  if (new Set(fields).size !== fields.length) throw new Error('PCD: повторяющиеся имена полей не поддерживаются');
  for (let i = 0; i < fields.length; i++) {
    if (![1, 2, 4, 8].includes(sizes[i]) || !['F', 'U', 'I'].includes(types[i]) ||
        (types[i] === 'F' && sizes[i] !== 4 && sizes[i] !== 8) ||
        !Number.isSafeInteger(counts[i]) || counts[i] < 1 || counts[i] > 1024) {
      throw new Error('PCD: неподдерживаемый тип/размер поля');
    }
  }

  const width = integerValue(header.WIDTH, 'WIDTH', 0);
  const height = integerValue(header.HEIGHT, 'HEIGHT', 1);
  if (!height) throw new Error('PCD: HEIGHT должен быть положительным');
  const declaredPoints = integerValue(header.POINTS, 'POINTS', 0);
  const gridCount = width * height;
  if (!Number.isSafeInteger(gridCount)) throw new Error('PCD: WIDTH × HEIGHT превышает безопасный диапазон');
  const pointCount = declaredPoints || gridCount;
  if (!Number.isSafeInteger(pointCount) || pointCount < 1) throw new Error('PCD: некорректный POINTS/WIDTH');
  if (gridCount > 0 && declaredPoints > 0 && gridCount !== declaredPoints) {
    throw new Error('PCD: POINTS does not match WIDTH × HEIGHT');
  }

  const mode = dataMatch[1].trim().toLowerCase();
  if (mode !== 'ascii' && mode !== 'binary' && mode !== 'binary_compressed') {
    throw new Error('PCD: out-of-core supports DATA ascii/binary/binary_compressed');
  }
  const fieldOffsets = [];
  const tokenOffsets = [];
  const fieldBytes = [];
  let recordLength = 0, tokenCount = 0;
  for (let i = 0; i < fields.length; i++) {
    fieldOffsets.push(recordLength);
    tokenOffsets.push(tokenCount);
    const bytes = sizes[i] * counts[i];
    fieldBytes.push(bytes);
    recordLength += bytes;
    tokenCount += counts[i];
  }
  if (!Number.isSafeInteger(recordLength) || recordLength < 1 || recordLength > HEADER_LIMIT ||
      !Number.isSafeInteger(tokenCount) || tokenCount > 1000000) {
    throw new Error('PCD: размер point record превышает безопасный streaming limit');
  }
  const pointBytes = pointCount * recordLength;
  if (!Number.isSafeInteger(pointBytes)) throw new Error('PCD: point payload exceeds safe file limits');
  let compressedSize = null, uncompressedSize = null, compressedDataOffset = null;
  if (mode === 'binary') {
    const payloadEnd = dataOffset + pointBytes;
    if (!Number.isSafeInteger(payloadEnd)) throw new Error('PCD: point payload end exceeds safe file limits');
    if (payloadEnd > fileSize) throw new Error('PCD: truncated binary payload');
  } else if (mode === 'binary_compressed') {
    compressedDataOffset = dataOffset + 8;
    if (!Number.isSafeInteger(compressedDataOffset) || compressedDataOffset > fileSize) {
      throw new Error('PCD: truncated binary_compressed sizes');
    }
    const sizes = Buffer.alloc(8);
    readExactAt(fd, sizes, sizes.length, dataOffset, 'PCD: truncated binary_compressed sizes');
    compressedSize = sizes.readUInt32LE(0);
    uncompressedSize = sizes.readUInt32LE(4);
    if (uncompressedSize !== pointBytes) {
      throw new Error('PCD: binary_compressed uncompressed size does not match declared fields');
    }
    if (!compressedSize) throw new Error('PCD: empty binary_compressed payload');
    const payloadEnd = compressedDataOffset + compressedSize;
    if (!Number.isSafeInteger(payloadEnd)) throw new Error('PCD: compressed payload end exceeds safe file limits');
    if (payloadEnd > fileSize) throw new Error('PCD: truncated binary_compressed payload');
  }

  const indexOf = (...names) => {
    for (const name of names) {
      const index = fields.indexOf(name);
      if (index >= 0) return index;
    }
    return -1;
  };
  const indices = {
    x: indexOf('x'), y: indexOf('y'), z: indexOf('z'),
    packed: indexOf('rgb', 'rgba'),
    intensity: indexOf('intensity', 'i', 'reflectance'),
    classification: indexOf('classification', 'class', 'label', 'semantic'),
    r: indexOf('r', 'red'), g: indexOf('g', 'green'), b: indexOf('b', 'blue')
  };
  if (indices.x < 0 || indices.y < 0 || indices.z < 0) throw new Error('PCD: нет полей x y z');
  for (const index of Object.values(indices)) {
    if (index < 0 || index === indices.packed) continue;
    if (counts[index] !== 1) throw new Error('PCD: многокомпонентные координаты/скаляры не поддержаны');
  }
  const hasColor = indices.packed >= 0 ||
    (indices.r >= 0 && indices.g >= 0 && indices.b >= 0);
  const requiredTokenCount = Math.max(
    tokenOffsets[indices.x] + 1,
    tokenOffsets[indices.y] + 1,
    tokenOffsets[indices.z] + 1,
    indices.packed >= 0 ? tokenOffsets[indices.packed] + 1 : 0,
    indices.r >= 0 && indices.g >= 0 && indices.b >= 0
      ? Math.max(tokenOffsets[indices.r], tokenOffsets[indices.g], tokenOffsets[indices.b]) + 1 : 0
  );
  const viewpoint = header.VIEWPOINT ? header.VIEWPOINT.map(Number) : null;
  const canonicalHeader = buffer.subarray(0, dataOffset);
  const layoutSignature = crypto.createHash('sha256')
    .update(canonicalHeader)
    .update(JSON.stringify({ pointCount, recordLength, fields, sizes, types, counts, mode, compressedSize, uncompressedSize }))
    .digest('hex');
  return {
    pointCount, mode, dataOffset, pointBytes, compressedSize, uncompressedSize,
    compressedDataOffset, recordLength, fields, sizes, types,
    counts, fieldOffsets, tokenOffsets, fieldBytes, tokenCount, indices,
    hasColor, requiredTokenCount, comments, viewpoint, layoutSignature
  };
}

function infoFromFd(fd, absPath) {
  const stat = fs.fstatSync(fd, { bigint: true });
  if (!stat.isFile()) throw new Error('point-cloud source is not a regular file');
  const fileSize = Number(stat.size);
  if (!Number.isSafeInteger(fileSize)) throw new Error('PCD file size exceeds safe limits');
  const header = parsePcdHeader(fd, fileSize);
  const info = Object.assign(statIdentity(stat), {
    pointCount: header.pointCount,
    mode: header.mode,
    dataOffset: header.dataOffset,
    pointBytes: header.pointBytes,
    compressedSize: header.compressedSize,
    uncompressedSize: header.uncompressedSize,
    recordLength: header.recordLength,
    hasIntensity: header.indices.intensity >= 0,
    hasClassification: header.indices.classification >= 0,
    layoutSignature: header.layoutSignature
  });
  if (absPath) {
    const pathStat = fs.statSync(absPath, { bigint: true });
    if (!pathStat.isFile()) throw new Error('point-cloud source is not a regular file');
    const current = statIdentity(pathStat);
    if (['fileSize', 'mtimeNs', 'device', 'inode'].some(key => info[key] !== current[key])) {
      throw new Error('PCD source changed while reading its header');
    }
  }
  return info;
}

function getOutOfCorePcdPointFileInfo(absPath) {
  let fd = null;
  try {
    fd = fs.openSync(absPath, 'r');
    return infoFromFd(fd, absPath);
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
  }
}

function samePcdPointFileInfo(a, b) {
  if (!a || !b) return false;
  const keys = ['fileSize', 'mtimeNs', 'device', 'inode', 'pointCount',
    'mode', 'dataOffset', 'pointBytes', 'compressedSize', 'uncompressedSize',
    'recordLength', 'hasIntensity', 'hasClassification', 'layoutSignature'];
  return keys.every(key => String(a[key]) === String(b[key]));
}

function isOutOfCorePcdPointFile(absPath) {
  try { getOutOfCorePcdPointFileInfo(absPath); return true; }
  catch (_) { return false; }
}

function numberValue(value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

function scalarValue(buffer, offset, field) {
  const size = field.size;
  if (field.type === 'F') return size === 8 ? buffer.readDoubleLE(offset) : buffer.readFloatLE(offset);
  if (field.type === 'U') {
    if (size === 1) return buffer.readUInt8(offset);
    if (size === 2) return buffer.readUInt16LE(offset);
    if (size === 4) return buffer.readUInt32LE(offset);
    return buffer.readBigUInt64LE(offset);
  }
  if (size === 1) return buffer.readInt8(offset);
  if (size === 2) return buffer.readInt16LE(offset);
  if (size === 4) return buffer.readInt32LE(offset);
  return buffer.readBigInt64LE(offset);
}

function pcdMaxFor(header, index) {
  if (index < 0) return 1;
  const size = header.sizes[index], type = header.types[index];
  if (type === 'F') return 1;
  if (type === 'U') return size === 1 ? 255 : size === 2 ? 65535 :
    size === 4 ? 4294967295 : Number.MAX_SAFE_INTEGER;
  return size === 1 ? 127 : size === 2 ? 32767 :
    size === 4 ? 2147483647 : Number.MAX_SAFE_INTEGER;
}

function packedAscii(value, type, size) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  if (type === 'F' && size === 4 && !Number.isInteger(number)) {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeFloatLE(number, 0);
    return buffer.readUInt32LE(0);
  }
  return Math.trunc(number) >>> 0;
}

function writeExactAt(fd, buffer, length, position, message) {
  let written = 0;
  while (written < length) {
    const count = fs.writeSync(fd, buffer, written, length - written, position + written);
    if (count <= 0) throw new Error(message || 'short write while creating PCD planar store');
    written += count;
  }
  return written;
}

function updateLzfHistory(history, buffer, start, length, absoluteStart) {
  if (!length) return;
  const mask = LZF_HISTORY_BYTES - 1;
  if (length >= LZF_HISTORY_BYTES) {
    const sourceStart = start + length - LZF_HISTORY_BYTES;
    const ringStart = (absoluteStart + length - LZF_HISTORY_BYTES) & mask;
    const first = Math.min(LZF_HISTORY_BYTES - ringStart, LZF_HISTORY_BYTES);
    buffer.copy(history, ringStart, sourceStart, sourceStart + first);
    if (first < LZF_HISTORY_BYTES) {
      buffer.copy(history, 0, sourceStart + first, sourceStart + LZF_HISTORY_BYTES);
    }
    return;
  }
  const ringStart = absoluteStart & mask;
  const first = Math.min(length, LZF_HISTORY_BYTES - ringStart);
  buffer.copy(history, ringStart, start, start + first);
  if (first < length) buffer.copy(history, 0, start + first, start + length);
}

function decompressPcdLzfToFile(sourceFd, header, outputPath, onProgress) {
  let outputFd = null, outputCreated = false;
  try {
    outputFd = fs.openSync(outputPath, 'wx', 0o600);
    outputCreated = true;
    const input = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, header.compressedSize));
    const output = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const history = Buffer.allocUnsafe(LZF_HISTORY_BYTES);
    let sourceRead = 0, inputStart = 0, inputEnd = 0;
    let outputPosition = 0, outputUsed = 0, produced = 0;
    const expected = header.uncompressedSize;

    function refill() {
      if (sourceRead >= header.compressedSize) return false;
      const wanted = Math.min(input.length, header.compressedSize - sourceRead);
      const count = fs.readSync(
        sourceFd, input, 0, wanted, header.compressedDataOffset + sourceRead
      );
      if (count <= 0) throw new Error('PCD: truncated LZF payload');
      sourceRead += count;
      inputStart = 0;
      inputEnd = count;
      return true;
    }
    function requireByte() {
      if (inputStart >= inputEnd && !refill()) throw new Error('PCD: truncated LZF payload');
      return input[inputStart++];
    }
    function flush() {
      if (!outputUsed) return;
      writeExactAt(outputFd, output, outputUsed, outputPosition,
        'short write while creating PCD planar store');
      outputPosition += outputUsed;
      outputUsed = 0;
      const compressedRead = sourceRead - (inputEnd - inputStart);
      progressAt(onProgress, 'decompress-pcd', 0.02 + 0.16 * produced / Math.max(1, expected), {
        bytesRead: compressedRead, bytesTotal: header.compressedSize,
        bytesWritten: produced, bytesExpected: expected
      });
    }
    function appendLiterals(length) {
      if (produced + length > expected) throw new Error('PCD: invalid LZF literal run');
      while (length > 0) {
        if (inputStart >= inputEnd && !refill()) throw new Error('PCD: truncated LZF literal run');
        if (outputUsed === output.length) flush();
        const count = Math.min(
          length, inputEnd - inputStart, output.length - outputUsed
        );
        const outputStart = outputUsed;
        input.copy(output, outputUsed, inputStart, inputStart + count);
        updateLzfHistory(history, output, outputStart, count, produced);
        inputStart += count;
        outputUsed += count;
        produced += count;
        length -= count;
      }
    }

    progressAt(onProgress, 'decompress-start', 0.02, {
      bytesTotal: header.compressedSize, bytesExpected: expected
    });
    while (produced < expected) {
      const control = requireByte();
      if (control < 32) {
        appendLiterals(control + 1);
        continue;
      }
      let length = control >>> 5;
      let referenceOffset = (control & 0x1f) << 8;
      if (length === 7) length += requireByte();
      referenceOffset += requireByte();
      length += 2;
      const distance = referenceOffset + 1;
      if (distance > produced || produced + length > expected) {
        throw new Error('PCD: invalid LZF back-reference');
      }
      for (let i = 0; i < length; i++) {
        if (outputUsed === output.length) flush();
        const value = history[(produced - distance) & (LZF_HISTORY_BYTES - 1)];
        output[outputUsed++] = value;
        history[produced & (LZF_HISTORY_BYTES - 1)] = value;
        produced++;
      }
    }
    if (sourceRead - (inputEnd - inputStart) !== header.compressedSize) {
      throw new Error('PCD: trailing bytes after LZF payload');
    }
    if (produced !== expected) throw new Error('PCD: decompressed length mismatch');
    flush();
    fs.fsyncSync(outputFd);
    fs.closeSync(outputFd);
    outputFd = null;
    progressAt(onProgress, 'decompress-pcd-done', 0.18, {
      bytesRead: header.compressedSize, bytesTotal: header.compressedSize,
      bytesWritten: produced, bytesExpected: expected
    });
    return outputPosition;
  } catch (error) {
    if (outputFd !== null) {
      try { fs.closeSync(outputFd); } catch (_) {}
      outputFd = null;
    }
    if (outputCreated) try { fs.unlinkSync(outputPath); } catch (_) {}
    throw error;
  } finally {
    if (outputFd !== null) try { fs.closeSync(outputFd); } catch (_) {}
  }
}

function forEachPcdRecord(fd, fileSize, header, onRecord, onBatch, phase, base, span, planarFd, extraFieldIndices) {
  if (header.mode === 'binary') {
    const perChunk = Math.max(1, Math.floor(READ_CHUNK_BYTES / header.recordLength));
    const buffer = Buffer.allocUnsafe(perChunk * header.recordLength);
    let currentBase = 0, currentBuffer = buffer;
    const readField = index => {
      if (index < 0) return NaN;
      return scalarValue(currentBuffer, currentBase + header.fieldOffsets[index], {
        size: header.sizes[index], type: header.types[index]
      });
    };
    const readPacked = index => {
      if (index < 0) return 0;
      const offset = currentBase + header.fieldOffsets[index];
      return header.sizes[index] === 4 ? currentBuffer.readUInt32LE(offset) : numberValue(readField(index));
    };
    for (let first = 0; first < header.pointCount; first += perChunk) {
      const count = Math.min(perChunk, header.pointCount - first);
      const bytes = count * header.recordLength;
      readExactAt(fd, buffer, bytes, header.dataOffset + first * header.recordLength,
        'PCD: truncated binary payload');
      for (let j = 0; j < count; j++) {
        currentBase = j * header.recordLength;
        onRecord(first + j, readField, readPacked);
      }
      if (onBatch) onBatch(first + count);
    }
    return header.pointCount;
  }
  if (header.mode === 'binary_compressed') {
    if (!Number.isInteger(planarFd) || planarFd < 0) {
      throw new Error('PCD: missing bounded LZF planar store');
    }
    const requiredFields = Array.from(new Set([
      header.indices.x, header.indices.y, header.indices.z,
      header.indices.packed >= 0 ? header.indices.packed : -1,
      header.indices.packed < 0 ? header.indices.r : -1,
      header.indices.packed < 0 ? header.indices.g : -1,
      header.indices.packed < 0 ? header.indices.b : -1,
      ...(Array.isArray(extraFieldIndices) ? extraFieldIndices : [])
    ].filter(index => index >= 0)));
    const bytesPerPoint = requiredFields.reduce((sum, index) => sum + header.fieldBytes[index], 0);
    const perChunk = Math.max(1, Math.floor(READ_CHUNK_BYTES / Math.max(1, bytesPerPoint)));
    const fieldBuffers = new Map();
    const fieldStarts = new Array(header.fields.length);
    let position = 0;
    for (let index = 0; index < header.fields.length; index++) {
      fieldStarts[index] = position;
      position += header.fieldBytes[index] * header.pointCount;
    }
    if (position !== header.pointBytes) throw new Error('PCD: planar field offsets do not match payload size');
    for (const index of requiredFields) {
      fieldBuffers.set(index, Buffer.allocUnsafe(perChunk * header.fieldBytes[index]));
    }
    for (let first = 0; first < header.pointCount; first += perChunk) {
      const count = Math.min(perChunk, header.pointCount - first);
      for (const index of requiredFields) {
        const byteCount = count * header.fieldBytes[index];
        readExactAt(
          planarFd, fieldBuffers.get(index), byteCount,
          fieldStarts[index] + first * header.fieldBytes[index],
          'PCD: truncated LZF planar store'
        );
      }
      const readField = (index, row) => {
        if (index < 0) return NaN;
        const buffer = fieldBuffers.get(index);
        if (!buffer) throw new Error('PCD: required field was not staged for LZF scan');
        return scalarValue(buffer, row * header.fieldBytes[index], {
          size: header.sizes[index], type: header.types[index]
        });
      };
      const readPacked = (index, row) => {
        if (index < 0) return 0;
        const buffer = fieldBuffers.get(index);
        if (!buffer) throw new Error('PCD: packed field was not staged for LZF scan');
        const offset = row * header.fieldBytes[index];
        return header.sizes[index] === 4
          ? buffer.readUInt32LE(offset)
          : numberValue(scalarValue(buffer, offset, {
            size: header.sizes[index], type: header.types[index]
          }));
      };
      for (let row = 0; row < count; row++) {
        onRecord(first + row,
          index => readField(index, row),
          index => readPacked(index, row));
      }
      if (onBatch) onBatch(first + count, first + count, header.pointCount);
    }
    return header.pointCount;
  }

  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  let filePosition = header.dataOffset, rest = '', seen = 0;
  let currentTokens = [];
  const readField = index => {
    if (index < 0) return NaN;
    return Number(currentTokens[header.tokenOffsets[index]]);
  };
  const readPacked = index => {
    if (index < 0) return 0;
    return packedAscii(currentTokens[header.tokenOffsets[index]],
      header.types[index], header.sizes[index]);
  };
  function consume(raw) {
    const line = raw.trim();
    if (!line || line[0] === '#') return;
    if (seen >= header.pointCount) throw new Error('PCD: more ASCII records than declared in POINTS');
    currentTokens = line.split(/\s+/);
    if (currentTokens.length < header.requiredTokenCount) {
      throw new Error('PCD: truncated ASCII point record ' + (seen + 1));
    }
    onRecord(seen, readField, readPacked);
    seen++;
  }
  while (filePosition < fileSize) {
    const wanted = Math.min(chunk.length, fileSize - filePosition);
    const got = fs.readSync(fd, chunk, 0, wanted, filePosition);
    if (got <= 0) throw new Error('PCD: truncated ASCII payload');
    filePosition += got;
    const lines = (rest + chunk.toString('latin1', 0, got)).split('\n');
    rest = lines.pop();
    if (rest.length > LINE_LIMIT) throw new Error('PCD: ASCII point line exceeds 1 MiB safety limit');
    for (const line of lines) {
      if (line.length > LINE_LIMIT) throw new Error('PCD: ASCII point line exceeds 1 MiB safety limit');
      consume(line);
    }
    if (onBatch) onBatch(seen, filePosition, fileSize);
  }
  if (rest) consume(rest);
  if (seen !== header.pointCount) {
    throw new Error('PCD: truncated ASCII payload (' + seen + ' of ' + header.pointCount + ' points)');
  }
  return seen;
}

function withPcdLzfPlanarStore(sourceFd, fileSize, scratchBaseDir, onProgress, consume) {
  if (!Number.isInteger(sourceFd) || sourceFd < 0) throw new Error('PCD: invalid source descriptor');
  if (typeof consume !== 'function') throw new Error('PCD: LZF preview callback is required');
  const sourceBefore = fs.fstatSync(sourceFd, { bigint: true });
  if (!sourceBefore.isFile() || sourceBefore.size !== BigInt(fileSize)) {
    throw new Error('PCD: source file changed before LZF preview');
  }
  const header = parsePcdHeader(sourceFd, fileSize);
  if (header.mode !== 'binary_compressed') throw new Error('PCD: LZF planar store requires DATA binary_compressed');

  const base = path.resolve(String(scratchBaseDir || os.tmpdir()));
  const baseStat = fs.statSync(base);
  if (!baseStat.isDirectory()) throw new Error('PCD: temporary LZF location is not a directory');
  const scratchDir = fs.mkdtempSync(path.join(base, 'bimtwin-pcd-preview-'));
  const planarPath = path.join(scratchDir, 'planar.bin');
  let planarFd = null;
  let planarCreated = false;
  try {
    assertTemporarySpace(scratchDir, header.uncompressedSize);
    const written = decompressPcdLzfToFile(sourceFd, header, planarPath, onProgress);
    planarCreated = true;
    if (written !== header.uncompressedSize) throw new Error('PCD: temporary LZF store size mismatch');
    planarFd = fs.openSync(planarPath, 'r');
    const result = consume(header, planarFd);
    const sourceAfter = fs.fstatSync(sourceFd, { bigint: true });
    if (sourceAfter.size !== sourceBefore.size || sourceAfter.mtimeNs !== sourceBefore.mtimeNs ||
        sourceAfter.dev !== sourceBefore.dev || sourceAfter.ino !== sourceBefore.ino) {
      throw new Error('PCD: source changed while streaming LZF preview');
    }
    return result;
  } finally {
    if (planarFd !== null) try { fs.closeSync(planarFd); } catch (_) {}
    if (planarCreated) try { fs.unlinkSync(planarPath); } catch (_) {}
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

function commentValue(comments, key) {
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp('^(?:BIM_TWIN_)?' + escaped + '\\s*=\\s*(.*)$', 'i');
  for (const raw of comments || []) {
    const match = expression.exec(String(raw || '').trim());
    if (match) return match[1].trim();
  }
  return null;
}

function commentCrs(comments) {
  const uri = commentValue(comments, 'crs_wkt_uri');
  if (uri) {
    try { return decodeURIComponent(uri); } catch (_) { return uri; }
  }
  return commentValue(comments, 'crs_wkt') || commentValue(comments, 'crs');
}

function commentUp(comments) {
  const value = String(commentValue(comments, 'up') || '').toLowerCase();
  return value === 'y' || value === 'yup' ? 'y' : 'z';
}

function clampByte(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

function preparePcdOctreeFile(sourcePath, canonicalPath, maxPoints, onProgress,
    preferredSourceTransform, expectedSourceInfo) {
  let sourceFd = null, canonicalFd = null, planarFd = null, planarPath = null, planarOwned = false;
  try {
    sourceFd = fs.openSync(sourcePath, 'r');
    const sourceStat = fs.fstatSync(sourceFd, { bigint: true });
    if (!sourceStat.isFile()) throw new Error('point-cloud source is not a regular file');
    const fileSize = Number(sourceStat.size);
    if (!Number.isSafeInteger(fileSize)) throw new Error('PCD file size exceeds safe limits');
    const header = parsePcdHeader(sourceFd, fileSize);
    const sourceInfo = infoFromFd(sourceFd, sourcePath);
    if (expectedSourceInfo && !samePcdPointFileInfo(sourceInfo, expectedSourceInfo)) {
      throw new Error('source PCD changed after resource preflight; retry indexing');
    }
    if (header.mode === 'binary_compressed') {
      planarPath = String(canonicalPath) + '.pcd-planar.tmp';
      decompressPcdLzfToFile(sourceFd, header, planarPath, onProgress);
      planarOwned = true;
      planarFd = fs.openSync(planarPath, 'r');
    }
    const budget = Number.isSafeInteger(maxPoints) && maxPoints > 0 ? maxPoints : 3000000;
    const sampleStride = header.pointCount > budget ? Math.ceil(header.pointCount / budget) : 1;
    let selectedValid = 0, invalidCount = 0, selectedInvalidCount = 0;
    let intensityRawMax = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const idx = header.indices;

    const scanStart = header.mode === 'binary_compressed' ? 0.18 : 0.02;
    const scanEnd = header.mode === 'binary_compressed' ? 0.30 : 0.30;
    progressAt(onProgress, 'scan-start', scanStart,
      { pointsTotal: header.pointCount, mode: 'out-of-core-pcd' });
    forEachPcdRecord(sourceFd, fileSize, header, (pointIndex, read) => {
      const x = numberValue(read(idx.x)), y = numberValue(read(idx.y)), z = numberValue(read(idx.z));
      if (![x, y, z].every(Number.isFinite)) {
        invalidCount++;
        if (!core.keepSampledIndex || core.keepSampledIndex(pointIndex, sampleStride)) {
          selectedInvalidCount++;
        }
        return;
      }
      if (core.keepSampledIndex && !core.keepSampledIndex(pointIndex, sampleStride)) return;
      selectedValid++;
      minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
      if (idx.intensity >= 0) {
        const intensity = numberValue(read(idx.intensity));
        if (Number.isFinite(intensity) && intensity > intensityRawMax) intensityRawMax = intensity;
      }
    }, (pointsRead, bytesRead, bytesTotal) => {
      const fraction = header.mode !== 'ascii'
        ? scanStart + (scanEnd - scanStart) * pointsRead / header.pointCount
        : 0.02 + 0.28 * bytesRead / Math.max(1, bytesTotal);
      progressAt(onProgress, 'scan', fraction, {
        pointsRead, pointsTotal: header.pointCount,
        validPoints: selectedValid, bytesRead, bytesTotal
      });
    }, null, null, null, planarFd,
    [idx.intensity, idx.classification]);
    if (!selectedValid || !Number.isFinite(minX + minY + minZ + maxX + maxY + maxZ)) {
      throw new Error('PCD has no finite indexed XYZ points');
    }

    const up = commentUp(header.comments);
    let axis = up === 'y' ? 'yup' : 'zup';
    let transform;
    if (preferredSourceTransform != null) {
      const candidate = preferredSourceTransform;
      if (!candidate || !['zup', 'yup'].includes(candidate.axis) ||
          !Array.isArray(candidate.t) || candidate.t.length < 3 ||
          !candidate.t.slice(0, 3).every(value => Number.isFinite(Number(value)) && Math.abs(Number(value)) <= 1e12)) {
        throw new Error('PCD out-of-core source transform is invalid');
      }
      axis = candidate.axis;
      transform = candidate.t.slice(0, 3).map(Number);
    } else if (axis === 'zup') {
      transform = [(minX + maxX) / 2, (minY + maxY) / 2, minZ];
    } else {
      transform = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
    }
    if (!transform.every(Number.isFinite)) throw new Error('PCD source transform exceeds safe numeric limits');
    const rangeZ = maxZ - minZ, rangeY = maxY - minY;
    const outputBounds = { mn: [Infinity, Infinity, Infinity], mx: [-Infinity, -Infinity, -Infinity] };

    const outputPath = String(canonicalPath);
    canonicalFd = fs.openSync(outputPath, 'wx', 0o600);
    const hasIntensity = idx.intensity >= 0;
    const hasClassification = idx.classification >= 0;
    const recordStride = 15 + (hasIntensity ? 4 : 0) + (hasClassification ? 1 : 0);
    const outputBuffer = Buffer.allocUnsafe(
      READ_CHUNK_BYTES - (READ_CHUNK_BYTES % recordStride)
    );
    let outputPosition = 0, outputCount = 0, bufferUsed = 0;
    function flushOutput() {
      if (!bufferUsed) return;
      let written = 0;
      while (written < bufferUsed) {
        const count = fs.writeSync(canonicalFd, outputBuffer, written, bufferUsed - written, outputPosition + written);
        if (!count) throw new Error('short write while creating canonical PCD point store');
        written += count;
      }
      outputPosition += bufferUsed;
      bufferUsed = 0;
    }

    const packed = idx.packed;
    const separateColors = idx.r >= 0 && idx.g >= 0 && idx.b >= 0;
    const intensityDivisor = hasIntensity
      ? (header.types[idx.intensity] === 'F'
        ? (intensityRawMax > 1.0001 ? intensityRawMax : 1)
        : pcdMaxFor(header, idx.intensity))
      : 1;
    const colorDivisor = separateColors
      ? Math.max(pcdMaxFor(header, idx.r), pcdMaxFor(header, idx.g), pcdMaxFor(header, idx.b))
      : 1;
    progressAt(onProgress, 'convert-start', 0.32,
      { pointsTotal: header.pointCount, pointsSelected: selectedValid });
    let secondInvalidCount = 0;
    forEachPcdRecord(sourceFd, fileSize, header, (pointIndex, read, readPacked) => {
      if (core.keepSampledIndex && !core.keepSampledIndex(pointIndex, sampleStride)) return;
      const worldX = numberValue(read(idx.x));
      const worldY = numberValue(read(idx.y));
      const worldZ = numberValue(read(idx.z));
      if (![worldX, worldY, worldZ].every(Number.isFinite)) {
        secondInvalidCount++;
        return;
      }
      const xyz = axis === 'zup'
        ? [worldX - transform[0], worldZ - transform[2], -(worldY - transform[1])]
        : [worldX - transform[0], worldY - transform[1], worldZ - transform[2]];
      const viewer = xyz.map(value => {
        const rounded = Math.fround(value);
        return Object.is(rounded, -0) ? 0 : rounded;
      });
      if (!viewer.every(Number.isFinite)) throw new Error('PCD viewer coordinates exceed Float32 range');
      for (let i = 0; i < 3; i++) {
        outputBounds.mn[i] = Math.min(outputBounds.mn[i], viewer[i]);
        outputBounds.mx[i] = Math.max(outputBounds.mx[i], viewer[i]);
      }
      const recordOffset = bufferUsed;
      outputBuffer.writeFloatLE(viewer[0], recordOffset);
      outputBuffer.writeFloatLE(viewer[1], recordOffset + 4);
      outputBuffer.writeFloatLE(viewer[2], recordOffset + 8);
      if (header.hasColor) {
        let r, g, b;
        if (packed >= 0) {
          const value = readPacked(packed) >>> 0;
          r = ((value >>> 16) & 255) / 255;
          g = ((value >>> 8) & 255) / 255;
          b = (value & 255) / 255;
        } else {
          r = Math.max(0, Math.min(1, numberValue(read(idx.r)) / colorDivisor));
          g = Math.max(0, Math.min(1, numberValue(read(idx.g)) / colorDivisor));
          b = Math.max(0, Math.min(1, numberValue(read(idx.b)) / colorDivisor));
        }
        outputBuffer[recordOffset + 12] = clampByte(Math.fround(r));
        outputBuffer[recordOffset + 13] = clampByte(Math.fround(g));
        outputBuffer[recordOffset + 14] = clampByte(Math.fround(b));
      } else {
        const elevation = axis === 'zup' ? worldZ - minZ : worldY - minY;
        const ramp = core.elevationRamp(elevation / ((axis === 'zup' ? rangeZ : rangeY) || 1));
        outputBuffer[recordOffset + 12] = clampByte(ramp[0]);
        outputBuffer[recordOffset + 13] = clampByte(ramp[1]);
        outputBuffer[recordOffset + 14] = clampByte(ramp[2]);
      }
      let attributeOffset = recordOffset + 15;
      if (hasIntensity) {
        const raw = numberValue(read(idx.intensity));
        const normalized = Number.isFinite(raw)
          ? Math.max(0, Math.min(1, raw / (intensityDivisor || 1)))
          : 0;
        outputBuffer.writeFloatLE(normalized, attributeOffset);
        attributeOffset += 4;
      }
      if (hasClassification) {
        const value = numberValue(read(idx.classification));
        outputBuffer[attributeOffset++] = Number.isFinite(value)
          ? Math.max(0, Math.min(255, Math.round(value)))
          : 0;
      }
      bufferUsed += recordStride;
      outputCount++;
      if (bufferUsed === outputBuffer.length) flushOutput();
    }, (pointsRead, bytesRead, bytesTotal) => {
      const fraction = header.mode !== 'ascii'
        ? 0.32 + 0.14 * pointsRead / header.pointCount
        : 0.32 + 0.14 * bytesRead / Math.max(1, bytesTotal);
      progressAt(onProgress, 'convert', fraction, {
        pointsRead, pointsTotal: header.pointCount,
        pointsWritten: outputCount, bytesRead, bytesTotal
      });
    }, null, null, null, planarFd,
    [idx.intensity, idx.classification]);
    flushOutput();
    if (outputCount !== selectedValid || secondInvalidCount !== selectedInvalidCount) {
      throw new Error('PCD changed or point validity differed between the two indexing passes');
    }

    const after = infoFromFd(sourceFd, sourcePath);
    if (!samePcdPointFileInfo(sourceInfo, after)) {
      throw new Error('source PCD changed while out-of-core indexing was running');
    }
    const pathAfter = fs.statSync(sourcePath, { bigint: true });
    const pathIdentity = statIdentity(pathAfter);
    if (['fileSize', 'mtimeNs', 'device', 'inode'].some(key => sourceInfo[key] !== pathIdentity[key])) {
      throw new Error('source PCD path changed while out-of-core indexing was running');
    }
    const epsilon = outputBounds.mn.map((minimum, index) =>
      Math.max(1e-6, (outputBounds.mx[index] - minimum) * 1e-6));
    for (let i = 0; i < 3; i++) outputBounds.mx[i] += epsilon[i];
    const sourceMeta = {
      kind: 'points', points: outputCount, total: header.pointCount,
      w: maxX - minX,
      d: axis === 'zup' ? maxY - minY : maxZ - minZ,
      h: axis === 'zup' ? maxZ - minZ : maxY - minY,
      format: 'PCD ' + header.mode + ' (out-of-core two-pass)',
      colored: header.hasColor,
      hasIntensity,
      hasClassification,
      streamAttributeOmissions: [],
      crsWkt: commentCrs(header.comments),
      units: commentValue(header.comments, 'units'),
      viewpoint: header.viewpoint && header.viewpoint.every(Number.isFinite) ? header.viewpoint : null,
      offset: axis === 'zup'
        ? { cx: transform[0], cy: transform[1], mnz: transform[2] }
        : undefined,
      srcXform: { axis, t: transform },
      outOfCore: true,
      invalidPointCount: invalidCount,
      sampleStride,
      sourcePointCount: header.pointCount,
      colorStorage: 'RGB8'
    };
    progressAt(onProgress, 'convert-done', 0.48, {
      pointsWritten: outputCount, pointsTotal: header.pointCount, invalidPoints: invalidCount
    });
    return {
      ok: true, canonicalPath: outputPath, count: outputCount,
      sourcePointCount: header.pointCount, invalidPointCount: invalidCount,
      hasColor: true, meta: sourceMeta, bbox: outputBounds,
      ingest: header.mode + '-pcd-two-pass'
    };
  } catch (error) {
    if (canonicalFd !== null) {
      try { fs.closeSync(canonicalFd); } catch (_) {}
      canonicalFd = null;
      try { fs.unlinkSync(canonicalPath); } catch (_) {}
    }
    throw error;
  } finally {
    if (sourceFd !== null) try { fs.closeSync(sourceFd); } catch (_) {}
    if (canonicalFd !== null) try { fs.closeSync(canonicalFd); } catch (_) {}
    if (planarFd !== null) try { fs.closeSync(planarFd); } catch (_) {}
    if (planarOwned && planarPath) try { fs.unlinkSync(planarPath); } catch (_) {}
  }
}

module.exports = {
  getOutOfCorePcdPointFileInfo,
  samePcdPointFileInfo,
  isOutOfCorePcdPointFile,
  forEachPcdRecord,
  withPcdLzfPlanarStore,
  preparePcdOctreeFile
};