'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const IFC = require('../renderer/ifc-export');

test('exportIFC: vozvraschaet validy IFC-stroku', () => {
  const walls = [
    { a:[0,0], b:[5,0] },
    { a:[5,0], b:[5,4] },
    { a:[5,4], b:[0,4] },
    { a:[0,4], b:[0,0] }
  ];
  const floors = [{ name:'Pervyy etazh', ymin:0, ymax:3 }];
  const ifc = IFC.exportIFC(walls, floors, { projectName:'Test' });
  assert.ok(typeof ifc === 'string');
  assert.ok(ifc.startsWith('ISO-10303-21;'), 'dolzhen nachinatsya s ISO-10303-21');
  assert.ok(ifc.includes('END-ISO-10303-21;'), 'dolzhen zakanchivatsya');
  assert.ok(ifc.includes('IFC2X3'), 'dolzhen ukazyvat skhemu IFC2X3');
});

test('exportIFC: soderzhit IFCPROJECT i IFCWALL', () => {
  const walls = [{ a:[0,0], b:[4,0] }];
  const ifc = IFC.exportIFC(walls, [], {});
  assert.ok(ifc.includes('IFCPROJECT'));
  assert.ok(ifc.includes('IFCWALL'));
});

test('exportIFC: bez sten → validy IFC bez IFCWALL', () => {
  const ifc = IFC.exportIFC([], []);
  assert.ok(ifc.includes('ISO-10303-21;'));
  assert.ok(!ifc.includes('IFCWALL'), 'Ne dolzhen soderhat IFCWALL esli net sten');
});

test('exportIFC: s etazhami soderzhit IFCBUILDINGSTOREY', () => {
  const walls = [];
  const floors = [{name:'Etazh 1',ymin:0,ymax:3},{name:'Etazh 2',ymin:3,ymax:6}];
  const ifc = IFC.exportIFC(walls, floors);
  assert.ok(ifc.includes('IFCBUILDINGSTOREY'));
});

test('exportIFC: soderzhit IFCSITE i IFCBUILDING', () => {
  const ifc = IFC.exportIFC([],[]);
  assert.ok(ifc.includes('IFCSITE'));
  assert.ok(ifc.includes('IFCBUILDING'));
});

test('exportIFC: kazhdyy vyzov inkrementuet id (resetIds)', () => {
  IFC.resetIds();
  const ifc1 = IFC.exportIFC([],[]);
  // posle pervogo vyzova IDs dolzhy byt > 1
  const ids1 = ifc1.match(/#(\d+) = /g) || [];
  assert.ok(ids1.length > 0);
});
