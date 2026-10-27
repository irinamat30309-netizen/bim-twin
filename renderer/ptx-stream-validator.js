'use strict';

// Incremental validator for the multi-scan, one-row-per-scan PTX stream
// emitted by BIM Twin.
// It intentionally keeps only a partial line and counters in memory, so the
// validation pass remains bounded even for very large exports.
const MAX_POINTS = 2147483647;
const MAX_LINE_CHARS = 512;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

class PTXStreamValidator {
  constructor(expectedPoints) {
    if (!Number.isSafeInteger(expectedPoints) || expectedPoints < 1 || expectedPoints > MAX_POINTS) {
      throw new Error('invalid PTX point count');
    }
    this.expectedPoints = expectedPoints;
    this.pending = '';
    this.lineNumber = 0;
    this.pointCount = 0;
    this.pointFields = null;
    this.headerLine = 0;
    this.scanColumns = 0;
    this.scanRowsExpected = 0;
    this.scanRowsSeen = 0;
    this.scanCount = 0;
    this.bytes = 0;
    this.finished = false;
  }

  push(text) {
    if (this.finished) throw new Error('PTX stream already finished');
    if (typeof text !== 'string' || text.length === 0) throw new Error('PTX chunk must be a non-empty string');
    // PTX numeric interchange is ASCII. Reject control characters, NUL and
    // non-ASCII data before writing it to disk.
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (!(code === 10 || code === 13 || code === 32 || (code >= 33 && code <= 126))) {
        throw new Error('PTX stream contains a non-ASCII or control character');
      }
    }
    this.bytes += text.length; // ASCII-only, so UTF-8 byte count equals length.
    this.pending += text;
    let newline;
    while ((newline = this.pending.indexOf('\n')) !== -1) {
      let line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this._consume(line);
    }
    if (this.pending.length > MAX_LINE_CHARS) throw new Error('PTX line exceeds the safety limit');
    return { bytes: this.bytes, points: this.pointCount };
  }

  _consume(line) {
    if (!line || line.length > MAX_LINE_CHARS || line.trim() !== line) throw new Error('invalid or empty PTX line');
    const fields = line.split(/ +/);
    if (fields.some(field => !field)) throw new Error('invalid PTX field separator');

    if (this.headerLine > 0) {
      this._consumeHeader(fields);
    } else if (this.scanRowsExpected > this.scanRowsSeen) {
      this._consumePoint(fields);
    } else {
      this._consumeHeader(fields);
    }
  }

  _consumeHeader(fields) {
    if (this.headerLine === 0) {
      if (fields.length !== 1 || !/^\d+$/.test(fields[0])) {
        throw new Error('PTX scan header must begin with a positive column count');
      }
      const columns = Number(fields[0]);
      if (!Number.isSafeInteger(columns) || columns < 1 || columns > this.expectedPoints - this.pointCount) {
        throw new Error('PTX header point count exceeds the remaining export points');
      }
      this.scanColumns = columns;
    } else if (this.headerLine === 1) {
      if (fields.length !== 1 || !/^\d+$/.test(fields[0])) {
        throw new Error('PTX scan header must contain a positive row count');
      }
      const rows = Number(fields[0]);
      const scanPoints = this.scanColumns * rows;
      if (!Number.isSafeInteger(rows) || rows < 1 || !Number.isSafeInteger(scanPoints) ||
          scanPoints < 1 || scanPoints > this.expectedPoints - this.pointCount) {
        throw new Error('PTX scan grid exceeds the remaining export points');
      }
      this.scanRowsExpected = scanPoints;
      this.scanRowsSeen = 0;
    } else {
      const expectedFields = this.headerLine < 6 ? 3 : 4;
      if (fields.length !== expectedFields) throw new Error('invalid PTX transform/header row');
      this._parseNumbers(fields);
    }
    this.headerLine++;
    this.lineNumber++;
    if (this.headerLine === 10) {
      this.headerLine = 0;
      this.scanCount++;
      if (this.scanCount > this.expectedPoints) throw new Error('PTX stream contains too many scan blocks');
    }
  }

  _consumePoint(fields) {
    if (![3, 4, 7].includes(fields.length)) throw new Error('PTX point row must contain 3, 4 or 7 fields');
    const values = this._parseNumbers(fields);
    if (this.pointFields == null) this.pointFields = fields.length;
    if (fields.length !== this.pointFields) throw new Error('PTX point rows have inconsistent field counts');
    if (values[0] === 0 && values[1] === 0 && values[2] === 0) {
      throw new Error('PTX origin is reserved as a missing-return sentinel');
    }
    if (fields.length >= 4 && (values[3] < 0 || values[3] > 1)) {
      throw new Error('PTX normalized intensity must be in the range 0..1');
    }
    if (fields.length === 7 && values.slice(4).some(value => value < 0 || value > 255)) {
      throw new Error('PTX RGB values must be in the range 0..255');
    }
    this.pointCount++;
    this.scanRowsSeen++;
    if (this.pointCount > this.expectedPoints) throw new Error('PTX stream contains too many points');
    this.lineNumber++;
  }

  _parseNumbers(fields) {
    const values = fields.map(field => {
      if (!NUMBER.test(field)) throw new Error('PTX contains an invalid numeric value');
      const value = Number(field);
      if (!Number.isFinite(value)) throw new Error('PTX contains a non-finite numeric value');
      return value;
    });
    return values;
  }

  finish() {
    if (this.finished) throw new Error('PTX stream already finished');
    if (this.pending.length) throw new Error('PTX stream ends with an incomplete line');
    if (this.headerLine !== 0 || this.scanCount < 1 ||
        this.scanRowsExpected < 1 || this.scanRowsSeen !== this.scanRowsExpected) {
      throw new Error('PTX scan header or point grid is incomplete');
    }
    if (this.pointCount !== this.expectedPoints) {
      throw new Error('PTX point rows do not match the declared total point count');
    }
    this.finished = true;
    return { bytes: this.bytes, points: this.pointCount };
  }
}

module.exports = { PTXStreamValidator, MAX_POINTS };