/* Parses OBJ/STL off the UI thread. mesh-importers.js returns transferable typed arrays. */
'use strict';
self.onmessage = function (event) {
  var request = event.data || {};
  try {
    if (!self.MeshImporters) {
      var own = new URL(self.location.href);
      var version = own.searchParams.get('v') || '1224';
      importScripts(new URL('mesh-importers.js?v=' + encodeURIComponent(version), own.href).href);
    }
    var name = String(request.name || '').toLowerCase();
    var scene;
    if (/\.obj$/.test(name)) scene = self.MeshImporters.parseOBJ(request.buffer);
    else if (/\.stl$/.test(name)) scene = self.MeshImporters.parseSTL(request.buffer);
    else throw new Error('Worker mesh-парсер поддерживает только OBJ/STL');

    var transfers = [], seen = new Set();
    function collect(value) {
      if (!value || !ArrayBuffer.isView(value)) return;
      var buffer = value.buffer;
      if (buffer instanceof ArrayBuffer && !seen.has(buffer)) {
        seen.add(buffer);
        transfers.push(buffer);
      }
    }
    (scene.primitives || []).forEach(function (primitive) {
      collect(primitive.positions);
      collect(primitive.sectionPositions);
      collect(primitive.normals);
      collect(primitive.uvs);
      collect(primitive.colors);
      collect(primitive.indices);
    });
    self.postMessage({ ok: true, requestId: request.requestId, scene: scene }, transfers);
  } catch (error) {
    self.postMessage({
      ok: false,
      requestId: request.requestId,
      error: String(error && error.message ? error.message : error)
    });
  }
};