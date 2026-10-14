'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E57 = require('../renderer/e57-stations.js');

// Маленький синтетический XML-заголовок E57 с двумя станциями и одним сферическим снимком.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<e57Root>
  <data3D type="Vector">
    <vectorChild type="Structured">
      <guid>{AAA}</guid>
      <name>Setup 1</name>
      <pose type="Structure">
        <rotation type="Structure"><w>1</w><x>0</x><y>0</y><z>0</z></rotation>
        <translation type="Structure"><x>10</x><y>20</y><z>1.5</z></translation>
      </pose>
    </vectorChild>
    <vectorChild type="Structured">
      <guid>{BBB}</guid>
      <name>Setup 2</name>
      <pose type="Structure">
        <rotation type="Structure"><w>0.7</w><x>0</x><y>0.7</y><z>0</z></rotation>
        <translation type="Structure"><x>14</x><y>22</y><z>1.6</z></translation>
      </pose>
    </vectorChild>
  </data3D>
  <images2D type="Vector">
    <vectorChild type="Structure">
      <guid>{IMG1}</guid>
      <associatedData3DGuid>{AAA}</associatedData3DGuid>
      <sphericalRepresentation type="Structure"><jpegImage type="Blob" fileOffset="100" length="5"/></sphericalRepresentation>
    </vectorChild>
  </images2D>
</e57Root>`;

test('parseE57Header извлекает станции и снимки', () => {
  const r = E57.parseE57Header(XML);
  assert.strictEqual(r.stations.length, 2);
  assert.strictEqual(r.stations[0].name, 'Setup 1');
  assert.strictEqual(r.stations[0].guid, '{AAA}');
  assert.deepStrictEqual(r.stations[0].survey, [10, 20, 1.5]);
  assert.deepStrictEqual(r.stations[0].rot, [1, 0, 0, 0]);
  assert.deepStrictEqual(r.stations[1].survey, [14, 22, 1.6]);
  assert.strictEqual(r.images.length, 1);
  assert.strictEqual(r.images[0].type, 'spherical');
  assert.strictEqual(r.images[0].assoc, '{AAA}');
});

test('parseE57Header не падает на пустом/мусорном вводе', () => {
  assert.deepStrictEqual(E57.parseE57Header('').stations, []);
  assert.deepStrictEqual(E57.parseE57Header(null).stations, []);
  assert.deepStrictEqual(E57.parseE57Header('<garbage/>').stations, []);
});

test('toViewerPos повторяет трансформацию las-node (Z-up → Y-up)', () => {
  // survey (X,Y,Z), offset {cx,cy,mnz} → [X-cx, Z-mnz, -(Y-cy)]
  const off = { cx: 10, cy: 20, mnz: 0 };
  assert.deepStrictEqual(E57.toViewerPos([10, 20, 1.5], off), [0, 1.5, -0]);
  assert.deepStrictEqual(E57.toViewerPos([14, 22, 1.6], off), [4, 1.6, -2]);
  // без offset — только смена осей
  assert.deepStrictEqual(E57.toViewerPos([1, 2, 3], null), [1, 3, -2]);
});

test('stationsFromE57 строит станции RealView с выровненными координатами', () => {
  const parsed = E57.parseE57Header(XML);
  const st = E57.stationsFromE57(parsed, { cx: 10, cy: 20, mnz: 0 });
  assert.strictEqual(st.length, 2);
  assert.strictEqual(st[0].id, 'e57_1');
  assert.strictEqual(st[0].name, 'Setup 1');
  assert.deepStrictEqual(st[0].pos, [0, 1.5, -0]);
  assert.strictEqual(st[0].yaw, 0);
  assert.strictEqual(st[0].panoUrl, null);
});

test('stripCrcPages собирает логические байты через CRC-границы страниц', () => {
  // pageSize=8 → 4 байта данных + 4 байта CRC на страницу.
  // Логический текст "ABCDEFG" (7 байт) раскладывается на 2 страницы.
  const pageSize = 8;
  const page0 = Buffer.from([0x41, 0x42, 0x43, 0x44, 0xDE, 0xAD, 0xBE, 0xEF]); // ABCD + CRC
  const page1 = Buffer.from([0x45, 0x46, 0x47, 0x00, 0xDE, 0xAD, 0xBE, 0xEF]); // EFG. + CRC
  const file = Buffer.concat([page0, page1]);
  const xml = E57.stripCrcPages(file, 0, 0, 7, pageSize);
  assert.strictEqual(xml, 'ABCDEFG');
});

test('parseFileHeader читает 48-байтный заголовок E57', () => {
  const buf = Buffer.alloc(48);
  buf.write('ASTM-E57', 0, 'ascii');
  buf.writeUInt32LE(1, 8);  // major
  buf.writeUInt32LE(0, 12); // minor
  buf.writeBigUInt64LE(2048n, 16); // filePhysicalLength
  buf.writeBigUInt64LE(1024n, 24); // xmlPhysicalOffset
  buf.writeBigUInt64LE(200n, 32);  // xmlLogicalLength
  buf.writeBigUInt64LE(1024n, 40); // pageSize
  const h = E57.parseFileHeader(buf);
  assert.strictEqual(h.major, 1);
  assert.strictEqual(h.xmlPhysicalOffset, 1024);
  assert.strictEqual(h.xmlLogicalLength, 200);
  assert.strictEqual(h.pageSize, 1024);
  assert.strictEqual(E57.parseFileHeader(Buffer.alloc(10)), null);
  assert.strictEqual(E57.parseFileHeader(Buffer.from('NOTE57XXyyyy')), null);
});
