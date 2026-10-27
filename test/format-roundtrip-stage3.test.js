'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExportHub = require('../renderer/export-hub');
const SmartSaveFmt = require('../renderer/lixel-smart-save');
const LAS = require('../las-node');
const E57 = require('../e57-core');

const CRS = 'PROJCRS["BIM Twin UTM",ID["EPSG",32610]]';
const WORLD = new Float64Array([
  500000.125, 6000000.25, 117.5,
  500001.125, 6000001.25, 119.0,
  500000.5,   6000000.875, 118.25
]);
const RGB = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
const INTENSITY = new Float32Array([0,0.5,1]);
const CLASSIFICATION = new Uint8Array([2,42,255]);
function temp(ext) { return path.join(os.tmpdir(), 'bimtwin-stage3-' + process.pid + '-' + Math.random().toString(36).slice(2) + ext); }
function parseFile(ext, bytes) {
  const file = temp(ext);
  fs.writeFileSync(file, bytes);
  try { return LAS.parseCloudFile(file, { maxPoints: 200000 }); }
  finally { fs.rmSync(file, { force: true }); }
}
function worldAt(cloud, i) {
  const p = cloud.pos, t = cloud.meta.srcXform.t;
  return cloud.meta.srcXform.axis === 'zup'
    ? [p[i*3] + t[0], -p[i*3+2] + t[1], p[i*3+1] + t[2]]
    : [p[i*3] + t[0], p[i*3+1] + t[1], p[i*3+2] + t[2]];
}
function assertWorld(actual, expected, tol) {
  for (let i=0;i<expected.length/3;i++) for (let a=0;a<3;a++)
    assert.ok(Math.abs(worldAt(actual,i)[a]-expected[i*3+a]) <= tol, `point ${i} axis ${a}: ${worldAt(actual,i)[a]} != ${expected[i*3+a]}`);
}
function baseCloud() {
  return { pos:WORLD, col:RGB, intensity:INTENSITY, classification:CLASSIFICATION, count:3,
    meta:{ srcXform:{axis:'zup',t:[0,0,0]},crsWkt:CRS,units:'m' } };
}

test('LAS 1.4 PDRF 7 round-trip preserves WKT, RGB, normalized intensity and full 8-bit class', () => {
  const bytes = ExportHub.exportLAS(baseCloud()), dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(dv.getUint8(104) & 0x3f, 7);
  assert.equal(dv.getUint16(105,true),36);
  const pointOffset=dv.getUint32(96,true);
  assert.equal(dv.getUint8(pointOffset+14),0x11);
  assert.equal(dv.getUint16(pointOffset+12,true),0);
  assert.equal(dv.getUint16(pointOffset+36+12,true),32768);
  assert.equal(dv.getUint8(pointOffset+36+16),42);
  assert.equal(dv.getUint8(pointOffset+72+16),255);
  const parsed=parseFile('.las',bytes);
  assert.equal(parsed.ok,true,parsed.message);
  assert.equal(parsed.meta.crsWkt,CRS);
  assert.deepEqual(Array.from(parsed.classification),Array.from(CLASSIFICATION));
  assert.ok(Math.abs(parsed.intensity[1]-INTENSITY[1])<2/65535);
  for(let i=0;i<3;i++)for(let a=0;a<3;a++)assert.ok(Math.abs(parsed.col[i*3+a]-RGB[i*3+a])<0.005);
  assertWorld(parsed,WORLD,0.0011);
});

test('PLY binary round-trip retains double world coordinates, CRS, units and per-point fields', () => {
  const bytes=ExportHub.exportPLY(baseCloud());
  const header=Buffer.from(bytes).subarray(0,2048).toString('ascii');
  assert.match(header,/property double x/);
  assert.match(header,/property float intensity/);
  assert.match(header,/property uchar classification/);
  assert.match(header,/comment crs_wkt_uri=/);
  const parsed=parseFile('.ply',bytes);
  assert.equal(parsed.ok,true,parsed.message);
  assert.equal(parsed.meta.crsWkt,CRS);assert.equal(parsed.meta.units,'m');
  assert.deepEqual(Array.from(parsed.classification),Array.from(CLASSIFICATION));
  assert.deepEqual(Array.from(parsed.intensity),Array.from(INTENSITY));
  assertWorld(parsed,WORLD,1e-6);
});

test('E57 round-trip carries coordinateMetadata and normalized intensity', () => {
  const bytes=ExportHub.exportE57(WORLD,3,{col:RGB,intensity:INTENSITY,crs:CRS});
  function logical(offset,length){const out=Buffer.alloc(length);let at=0;while(at<length){const inPage=offset%1020,take=Math.min(1020-inPage,length-at),phys=Math.floor(offset/1020)*1024+inPage;out.set(bytes.subarray(phys,phys+take),at);offset+=take;at+=take;}return out;}
  const packet=logical(80,6),packetLength=packet.readUInt16LE(2)+1,streamCount=packet.readUInt16LE(4),streamLengths=logical(86,streamCount*2);
  let needed=6+streamCount*2;for(let i=0;i<streamCount;i++)needed+=streamLengths.readUInt16LE(i*2);
  assert.equal(packetLength%4,0,'E57 DataPacket length must be four-byte aligned');
  assert.ok(packetLength>=needed&&packetLength-needed<=3,'E57 packet padding must be 0–3 bytes');
  assert.ok(logical(80+needed,packetLength-needed).every(v=>v===0),'E57 packet padding must be zero');
  const parsed=E57.readBuffer(bytes);
  assert.equal(parsed.count,3);assert.equal(parsed.crs,CRS);
  assert.deepEqual(Array.from(parsed.intensity),Array.from(INTENSITY));
  for(let i=0;i<9;i++)assert.ok(Math.abs(parsed.pos[i]-WORLD[i])<1e-9);
  assert.deepEqual(Array.from(parsed.col),Array.from(RGB));
  const nodeParsed=parseFile('.e57',bytes);
  assert.equal(nodeParsed.ok,true,nodeParsed.message);assert.equal(nodeParsed.meta.crsWkt,CRS);
  assert.deepEqual(Array.from(nodeParsed.intensity),Array.from(INTENSITY));
  assert.deepEqual(Array.from(nodeParsed.col),Array.from(RGB));
  assertWorld(nodeParsed,WORLD,1e-6);
});

test('E57 XML CDATA preserves scanner names and coordinate metadata verbatim', () => {
  const name='Scan & <north> ]]> "déjà vu" ]]>';
  const crs='WKT2 & <metadata> ]]> tail';
  const pose={T:[0,0,0],quaternion:{w:1,x:0,y:0,z:0}};
  const single=E57.readBuffer(E57.write({pos:WORLD,count:3,name,crs}));
  assert.equal(single.scans[0].name,name);
  assert.equal(single.crs,crs);
  for(let i=0;i<WORLD.length;i++)assert.ok(Math.abs(single.pos[i]-WORLD[i])<1e-9);

  const secondName='Station B & <west> ]]> end';
  const multi=E57.readBuffer(E57.write({pos:WORLD,count:3,crs,scans:[
    {name,start:0,count:1,pose},
    {name:secondName,start:1,count:2,pose}
  ]}));
  assert.deepEqual(multi.scans.map(scan=>scan.name),[name,secondName]);
  assert.equal(multi.crs,crs);
  for(let i=0;i<WORLD.length;i++)assert.ok(Math.abs(multi.pos[i]-WORLD[i])<1e-9);
});

test('E57 export preserves a single scan name, pose and world coordinates', () => {
  const q={w:Math.SQRT1_2,x:0,y:0,z:Math.SQRT1_2};
  const scan={name:'One station',start:0,count:3,pose:{T:[100,-20,7],quaternion:q}};
  const local=[[1,2,3],[2,0,1],[-1,4,2]],world=new Float64Array(9);
  for(let i=0;i<local.length;i++){
    const [x,y,z]=local[i],{w,x:qx,y:qy,z:qz}=q;
    const R=[1-2*(qy*qy+qz*qz),2*(qx*qy-w*qz),2*(qx*qz+w*qy),
      2*(qx*qy+w*qz),1-2*(qx*qx+qz*qz),2*(qy*qz-w*qx),
      2*(qx*qz-w*qy),2*(qy*qz+w*qx),1-2*(qx*qx+qy*qy)];
    world[i*3]=R[0]*x+R[1]*y+R[2]*z+scan.pose.T[0];
    world[i*3+1]=R[3]*x+R[4]*y+R[5]*z+scan.pose.T[1];
    world[i*3+2]=R[6]*x+R[7]*y+R[8]*z+scan.pose.T[2];
  }
  const parsed=E57.readBuffer(ExportHub.exportE57(world,3,{crs:CRS,scans:[scan]}));
  assert.equal(parsed.scans.length,1);
  assert.equal(parsed.scans[0].name,'One station');
  assert.equal(parsed.scans[0].count,3);
  assert.deepEqual(parsed.scans[0].pose.T,scan.pose.T);
  assert.ok(Math.abs(parsed.scans[0].pose.quaternion.w-q.w)<1e-12);
  assert.ok(Math.abs(parsed.scans[0].pose.quaternion.z-q.z)<1e-12);
  assert.equal(parsed.crs,CRS);
  for(let i=0;i<world.length;i++)assert.ok(Math.abs(parsed.pos[i]-world[i])<1e-9);
  const sampled=E57.readBuffer(ExportHub.exportE57(world,3,{step:2,crs:CRS,scans:[scan]}));
  assert.equal(sampled.scans.length,1);
  assert.equal(sampled.scans[0].name,'One station');
  assert.equal(sampled.scans[0].count,2);
  assert.deepEqual(sampled.scans[0].pose.T,scan.pose.T);
  for(let i=0;i<3;i++){
    assert.ok(Math.abs(sampled.pos[i]-world[i])<1e-9);
    assert.ok(Math.abs(sampled.pos[i+3]-world[i+6])<1e-9);
  }
});

test('E57 mini-XML parser rejects truncated or mismatched markup without hanging', () => {
  const malformed=[
    '<root><![CDATA[unterminated</root>',
    '<root><!-- unterminated',
    '<?xml version="1.0"?',
    '<root',
    '<root><child></root>',
    '<root><child/>'
  ];
  for(const xml of malformed)assert.throws(()=>E57.parseXML(xml),/E57 XML:/,xml);
  const valid=E57.parseXML('<?xml version="1.0"?><root note="a > b"><child><![CDATA[x]]]]><![CDATA[>y]]></child></root>');
  assert.equal(valid.attrs.note,'a > b');
  assert.equal(valid.children[0].text,'x]]>y');
  assert.equal(E57.parseXML('<root>&#x1F680;&#128512;</root>').text,'🚀😀');
  assert.throws(()=>E57.parseXML('<root>&#0;</root>'),/E57 XML:/);
});

test('E57 export preserves multiple scan groups, rigid poses, names and world coordinates', () => {
  const q={w:Math.SQRT1_2,x:0,y:0,z:Math.SQRT1_2};
  const scans=[
    {name:'Station A',start:0,count:2,pose:{T:[100,200,300],quaternion:{w:1,x:0,y:0,z:0}}},
    {name:'Station B',start:2,count:2,pose:{T:[-10,5,2],quaternion:q}}
  ];
  const local=[[1,2,3],[2,3,4],[1,0,0],[0,1,0]],world=new Float64Array(12);
  for(let i=0;i<4;i++){
    const s=i<2?scans[0]:scans[1],p=local[i],{w,x,y,z}=s.pose.quaternion;
    const R=[1-2*(y*y+z*z),2*(x*y-w*z),2*(x*z+w*y),
      2*(x*y+w*z),1-2*(x*x+z*z),2*(y*z-w*x),
      2*(x*z-w*y),2*(y*z+w*x),1-2*(x*x+y*y)];
    for(let a=0;a<3;a++)world[i*3+a]=R[a*3]*p[0]+R[a*3+1]*p[1]+R[a*3+2]*p[2]+s.pose.T[a];
  }
  const color=new Float32Array([1,0,0,0,1,0,0,0,1,.5,.25,.75]);
  const intensity=new Float32Array([.1,.2,.7,.9]);
  const bytes=ExportHub.exportE57(world,4,{col:color,intensity,crs:CRS,scans});
  const parsed=E57.readBuffer(bytes);
  assert.equal(parsed.count,4);
  assert.equal(parsed.crs,CRS);
  assert.deepEqual(parsed.scans.map(s=>[s.name,s.start,s.count,s.recordCount]),[
    ['Station A',0,2,2],['Station B',2,2,2]
  ]);
  assert.deepEqual(Array.from(parsed.intensity),Array.from(intensity));
  for(let i=0;i<world.length;i++)assert.ok(Math.abs(parsed.pos[i]-world[i])<1e-9);
  for(let i=0;i<color.length;i++)assert.ok(Math.abs(parsed.col[i]-color[i])<1/255+1e-8);
  assert.equal(ExportHub.preflightExport('e57',{
    pos:world,col:color,intensity,meta:{crsWkt:CRS,scans}
  }).warnings.some(w=>/merges .*source scans/.test(w)),false);

  const nodeParsed=parseFile('.e57',bytes);
  assert.equal(nodeParsed.ok,true,nodeParsed.message);
  assert.deepEqual(nodeParsed.meta.scans.map(s=>[s.name,s.start,s.count]),[
    ['Station A',0,2],['Station B',2,2]
  ]);
  assertWorld(nodeParsed,world,1e-6);
});

test('E57 export remaps scan ranges after sampling and safely flattens stale scan metadata', () => {
  const pos=new Float64Array([0,0,0,1,0,0,2,0,0,3,0,0,4,0,0]);
  const scans=[
    {name:'A',start:0,count:3,pose:{T:[0,0,0],quaternion:{w:1,x:0,y:0,z:0}}},
    {name:'B',start:3,count:2,pose:{T:[0,0,0],quaternion:{w:1,x:0,y:0,z:0}}}
  ];
  const sampled=E57.readBuffer(ExportHub.exportE57(pos,5,{step:2,scans}));
  assert.deepEqual(sampled.scans.map(s=>[s.name,s.start,s.count]),[['A',0,2],['B',2,1]]);

  const stale={pos:new Float64Array([0,0,0,1,0,0,2,0,0]),meta:{scans:[
    {name:'A',start:0,count:1},{name:'B',start:1,count:1}
  ]}};
  assert.ok(ExportHub.preflightExport('e57',stale).warnings.some(w=>/metadata no longer matches/.test(w)));
  const flattened=E57.readBuffer(ExportHub.exportE57(stale.pos,3,{scans:stale.meta.scans}));
  assert.equal(flattened.scans.length,1,'stale scan ranges must not be written as corrupt scan organization');
});

test('BIM Twin PCD ASCII round-trip keeps CRS/up/units/color/intensity/classification', () => {
  const text=SmartSaveFmt.toPCDText(baseCloud());
  assert.match(text,/^# BIM_TWIN_UP=z/m);assert.match(text,/^FIELDS x y z intensity classification rgb/m);
  const parsed=parseFile('.pcd',Buffer.from(text,'utf8'));
  assert.equal(parsed.ok,true,parsed.message);assert.equal(parsed.meta.crsWkt,CRS);assert.equal(parsed.meta.units,'m');
  assert.deepEqual(Array.from(parsed.classification),Array.from(CLASSIFICATION));
  assert.deepEqual(Array.from(parsed.intensity),Array.from(INTENSITY));
  assert.deepEqual(Array.from(parsed.col),Array.from(RGB));
  assertWorld(parsed,WORLD,1e-6);
});

test('PCD binary interleaved records preserve packed RGB, intensity and classification', () => {
  const header=Buffer.from([
    'VERSION .7','FIELDS x y z intensity rgb classification','SIZE 4 4 4 2 4 1',
    'TYPE F F F U U U','COUNT 1 1 1 1 1 1','WIDTH 2','HEIGHT 1','POINTS 2','DATA binary',''
  ].join('\n'));
  const rows=Buffer.alloc(2*19);
  function row(i,x,y,z,int,rgb,cls){const o=i*19;rows.writeFloatLE(x,o);rows.writeFloatLE(y,o+4);rows.writeFloatLE(z,o+8);rows.writeUInt16LE(int,o+12);rows.writeUInt32LE(rgb,o+14);rows.writeUInt8(cls,o+18);}
  row(0,100,200,300,0,0xff0000,7);row(1,101,201,301,65535,0x00ff00,200);
  const parsed=parseFile('.pcd',Buffer.concat([header,rows]));
  assert.equal(parsed.ok,true,parsed.message);assert.equal(parsed.meta.format,'PCD binary');
  assert.deepEqual(Array.from(parsed.classification),[7,200]);
  assert.deepEqual(Array.from(parsed.intensity),[0,1]);
  assert.deepEqual(Array.from(parsed.col),[1,0,0,0,1,0]);
  assertWorld(parsed,new Float64Array([100,200,300,101,201,301]),1e-6);
});

test('PCD binary_compressed LZF planar fields decode RGB, intensity and classification', () => {
  const n=2, cols=[];
  const xyz=[Buffer.alloc(n*4),Buffer.alloc(n*4),Buffer.alloc(n*4)];
  xyz[0].writeFloatLE(10,0);xyz[0].writeFloatLE(11,4);
  xyz[1].writeFloatLE(20,0);xyz[1].writeFloatLE(21,4);
  xyz[2].writeFloatLE(30,0);xyz[2].writeFloatLE(31,4);
  const inten=Buffer.alloc(n*2);inten.writeUInt16LE(0,0);inten.writeUInt16LE(65535,2);
  const rgb=Buffer.alloc(n*4);rgb.writeUInt32LE(0xff0000,0);rgb.writeUInt32LE(0x0000ff,4);
  const cls=Buffer.from([5,201]);
  const raw=Buffer.concat([...xyz,inten,rgb,cls]);
  function lzfLiteral(buf){const out=[];for(let i=0;i<buf.length;i+=32){const chunk=buf.subarray(i,Math.min(buf.length,i+32));out.push(Buffer.from([chunk.length-1]),chunk);}return Buffer.concat(out);}
  const compressed=lzfLiteral(raw),sizes=Buffer.alloc(8);sizes.writeUInt32LE(compressed.length,0);sizes.writeUInt32LE(raw.length,4);
  const header=Buffer.from([
    'VERSION .7','FIELDS x y z intensity rgb classification','SIZE 4 4 4 2 4 1',
    'TYPE F F F U U U','COUNT 1 1 1 1 1 1','WIDTH 2','HEIGHT 1','POINTS 2','DATA binary_compressed',''
  ].join('\n'));
  const parsed=parseFile('.pcd',Buffer.concat([header,sizes,compressed]));
  assert.equal(parsed.ok,true,parsed.message);assert.equal(parsed.meta.format,'PCD binary_compressed');
  assert.deepEqual(Array.from(parsed.classification),[5,201]);assert.deepEqual(Array.from(parsed.intensity),[0,1]);
  assert.deepEqual(Array.from(parsed.col),[1,0,0,0,0,1]);
  assertWorld(parsed,new Float64Array([10,20,30,11,21,31]),1e-6);
});

test('PCD LZF decodes overlapping back-references and rejects mismatched or trailing payloads', () => {
  const head = mode => Buffer.from([
    'VERSION .7','FIELDS x y z intensity rgb classification','SIZE 4 4 4 2 4 1',
    'TYPE F F F U U U','COUNT 1 1 1 1 1 1','WIDTH 2','HEIGHT 1','POINTS 2','DATA ' + mode,''
  ].join('\n'));
  // PCL LZF: one literal zero followed by a 37-byte overlapping reference to it.
  const overlap = Buffer.from([0, 0, 0xe0, 28, 0]);
  const sizes = Buffer.alloc(8); sizes.writeUInt32LE(overlap.length, 0); sizes.writeUInt32LE(38, 4);
  const parsed = parseFile('.pcd', Buffer.concat([head('binary_compressed'), sizes, overlap]));
  assert.equal(parsed.ok, true, parsed.message);
  assert.equal(parsed.count, 2);
  assert.ok(Array.from(parsed.pos).every(v => v === 0));
  assert.deepEqual(Array.from(parsed.classification), [0,0]);
  assert.deepEqual(Array.from(parsed.intensity), [0,0]);
  assert.deepEqual(Array.from(parsed.col), [0,0,0,0,0,0]);

  const mismatched = Buffer.alloc(8); mismatched.writeUInt32LE(1, 0); mismatched.writeUInt32LE(512 * 1024 * 1024 + 1, 4);
  const badSize = parseFile('.pcd', Buffer.concat([head('binary_compressed'), mismatched, Buffer.from([0])]));
  assert.equal(badSize.ok, false);
  assert.match(badSize.message, /uncompressed size does not match declared fields/);

  const trailingPayload = Buffer.concat([Buffer.from([11]), Buffer.alloc(12), Buffer.from([123])]);
  const trailing = Buffer.alloc(8); trailing.writeUInt32LE(trailingPayload.length, 0); trailing.writeUInt32LE(12, 4);
  const onePointHead = Buffer.from([
    'VERSION .7','FIELDS x y z','SIZE 4 4 4','TYPE F F F','COUNT 1 1 1',
    'WIDTH 1','HEIGHT 1','POINTS 1','DATA binary_compressed',''
  ].join('\n'));
  const extra = parseFile('.pcd', Buffer.concat([onePointHead, trailing, trailingPayload]));
  assert.equal(extra.ok, false);
  assert.match(extra.message, /trailing bytes/);

  const truncated = parseFile('.pcd', Buffer.from([
    'VERSION .7','FIELDS x y z','SIZE 4 4 4','TYPE F F F','COUNT 1 1 1',
    'WIDTH 2','HEIGHT 1','POINTS 2','DATA ascii','0 0 0\n'
  ].join('\n')));
  assert.equal(truncated.ok, false);
  assert.match(truncated.message, /truncated ASCII payload/);
});

test('PTS round-trip preserves standard RGB/intensity and preflight explicitly warns about CRS/class loss', () => {
  const text=SmartSaveFmt.toPTSText(baseCloud());
  const parsed=parseFile('.pts',Buffer.from(text,'utf8'));
  assert.equal(parsed.ok,true,parsed.message);for(let i=0;i<INTENSITY.length;i++)assert.ok(Math.abs(parsed.intensity[i]-INTENSITY[i])<2/65535);
  assert.deepEqual(Array.from(parsed.col),Array.from(RGB));assert.equal(parsed.classification,null);
  assert.equal(parsed.meta.crsWkt,null);assertWorld(parsed,WORLD,1e-6);
  const pre=ExportHub.preflightExport('pts',baseCloud());
  assert.equal(pre.ok,true);assert.ok(pre.warnings.some(w=>/classification/i.test(w)));assert.ok(pre.warnings.some(w=>/CRS/i.test(w)));
});

test('PTX writer emits one row, preserves source XYZ/RGB/intensity and safely encodes the origin', () => {
  const text = SmartSaveFmt.toPTXText(baseCloud());
  const lines = text.trimEnd().split(/\r?\n/);
  assert.equal(lines[0], '3');
  assert.equal(lines[1], '1');
  assert.equal(lines.length, 13);
  const parsed = parseFile('.ptx', Buffer.from(text, 'utf8'));
  assert.equal(parsed.ok, true, parsed.message);
  assert.equal(parsed.count, 3);
  assert.equal(parsed.meta.scanCount, 1);
  assert.equal(parsed.meta.scans[0].columns, 3);
  assert.equal(parsed.meta.scans[0].rows, 1);
  assert.equal(parsed.meta.crsWkt, null);
  assert.deepEqual(Array.from(parsed.col), Array.from(RGB));
  assert.deepEqual(Array.from(parsed.intensity), Array.from(INTENSITY));
  assert.equal(parsed.classification, null);
  assertWorld(parsed, WORLD, 1e-6);

  const zero = {
    pos: new Float64Array([0, 0, 0, 10, 20, 30]),
    col: new Float32Array([1, 0, 0, 0, 1, 0]),
    intensity: new Float32Array([0.2, 0.8]),
    count: 2,
    meta: { srcXform: { axis: 'zup', t: [0, 0, 0] } }
  };
  const zeroParsed = parseFile('.ptx', Buffer.from(SmartSaveFmt.toPTXText(zero), 'utf8'));
  assert.equal(zeroParsed.ok, true, zeroParsed.message);
  assert.equal(zeroParsed.count, 2, 'the valid origin must not be mistaken for a missing PTX return');
  assertWorld(zeroParsed, zero.pos, 1e-6);

  const pre = ExportHub.preflightExport('ptx', baseCloud());
  assert.equal(pre.ok, true);
  assert.ok(pre.warnings.some(w => /classification/i.test(w)));
  assert.ok(pre.warnings.some(w => /CRS/i.test(w)));
  const multiScan = baseCloud(); multiScan.meta.scans = [{}, {}];
  assert.ok(ExportHub.preflightExport('ptx', multiScan).warnings.some(w => /flattened|one row|one scan/i.test(w)));
});

test('rich XYZ text round-trip uses named columns and carries CRS, units and attributes', () => {
  const text=SmartSaveFmt.toXYZText(baseCloud()),parsed=parseFile('.xyz',Buffer.from(text,'utf8'));
  assert.equal(parsed.ok,true,parsed.message);assert.equal(parsed.meta.crsWkt,CRS);assert.equal(parsed.meta.units,'m');
  assert.deepEqual(Array.from(parsed.classification),Array.from(CLASSIFICATION));
  assert.deepEqual(Array.from(parsed.intensity),Array.from(INTENSITY));assert.deepEqual(Array.from(parsed.col),Array.from(RGB));
  assertWorld(parsed,WORLD,1e-6);
});

test('CSV importer honors named geospatial columns and BIM Twin CRS/up comments', () => {
  const text=[
    '# BIM_TWIN_UP=z',
    '# BIM_TWIN_UNITS=m',
    '# BIM_TWIN_CRS_WKT_URI='+encodeURIComponent(CRS),
    'easting,northing,elevation,intensity,red,green,blue,classification',
    '500000,6000000,117,0.25,255,0,0,2',
    '500001,6000001,118,0.75,0,255,0,42'
  ].join('\n')+'\n';
  const parsed=parseFile('.csv',Buffer.from(text,'utf8'));
  assert.equal(parsed.ok,true,parsed.message);assert.equal(parsed.meta.crsWkt,CRS);assert.equal(parsed.meta.units,'m');
  assert.deepEqual(Array.from(parsed.classification),[2,42]);
  assert.deepEqual(Array.from(parsed.intensity),[0.25,0.75]);
  assert.deepEqual(Array.from(parsed.col),[1,0,0,0,1,0]);
  assertWorld(parsed,new Float64Array([500000,6000000,117,500001,6000001,118]),1e-6);
});

test('CSV writer/importer round-trip keeps source XYZ, RGB, intensity, classification, units and CRS', () => {
  const text = SmartSaveFmt.toCSVText(baseCloud());
  assert.match(text, /^# BIM_TWIN_UP=z/m);
  assert.match(text, /^# BIM_TWIN_CRS_WKT_URI=/m);
  assert.match(text, /^x,y,z,intensity,red,green,blue,classification$/m);
  const parsed = parseFile('.csv', Buffer.from(text, 'utf8'));
  assert.equal(parsed.ok, true, parsed.message);
  assert.equal(parsed.meta.crsWkt, CRS);
  assert.equal(parsed.meta.units, 'm');
  assert.deepEqual(Array.from(parsed.classification), Array.from(CLASSIFICATION));
  assert.deepEqual(Array.from(parsed.intensity), Array.from(INTENSITY));
  assert.deepEqual(Array.from(parsed.col), Array.from(RGB));
  assertWorld(parsed, WORLD, 1e-6);
  assert.equal(ExportHub.preflightExport('csv', baseCloud()).ok, true);
  const multiScan = baseCloud(); multiScan.meta.scans = [{}, {}];
  assert.ok(ExportHub.preflightExport('csv', multiScan).warnings.some(w => /flattens 2 source scan/.test(w)));
});

test('Stage 3 capability registry distinguishes partial/unsupported formats', () => {
  assert.equal(ExportHub.getFormatCapabilities('las').export,'supported');
  assert.equal(ExportHub.getFormatCapabilities('csv').export,'supported');
  assert.equal(ExportHub.getFormatCapabilities('ptx').import,'supported');
  assert.equal(ExportHub.getFormatCapabilities('ptx').export,'supported');
  assert.equal(ExportHub.getFormatCapabilities('copc').import,'unsupported');
  assert.equal(ExportHub.getFormatCapabilities('dwg').export,'unsupported');
  assert.equal(ExportHub.preflightExport('copc',baseCloud()).ok,false);
  const pcdLimits = ExportHub.getFormatCapabilities('pcd').limits;
  assert.ok(pcdLimits.some(x => /binary_compressed preview import now streams.*temporary planar disk store/i.test(x)));
  assert.ok(pcdLimits.some(x => /not a full out-of-core viewer/i.test(x)));
  assert.equal(pcdLimits.some(x => /512 MiB cap/i.test(x)), false);
  const mismatch=baseCloud();mismatch.count=2;
  assert.equal(ExportHub.preflightExport('las',mismatch).ok,false);
  const invalid=baseCloud();invalid.pos=new Float64Array([500000,6000000,117,NaN,0,0]);invalid.count=2;
  assert.ok(ExportHub.preflightExport('las',invalid).errors.some(x => /нечисловую координату/.test(x)));
  const shortIntensity=baseCloud();shortIntensity.intensity=new Float32Array([0]);
  assert.ok(ExportHub.preflightExport('ply',shortIntensity).errors.some(x => /intensity/.test(x)));
});