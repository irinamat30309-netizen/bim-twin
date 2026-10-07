/*
 * renderer/app-utils.js — чистые вспомогательные функции UI, вынесенные из app.js (r13).
 * Загружается ПЕРЕД app.js: <script src="app-utils.js">. Экспортирует window.AppUtils.
 * Для юнит-тестов доступен через module.exports (Node).
 */
(function (root, factory) {
  'use strict';
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof root !== 'undefined') root.AppUtils = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function is3DModelName(name) { return /\.(glb|gltf|obj|stl|ply|las|laz|e57)$/i.test(name || ''); }

  function fmtSize(n) { if (n == null) return ''; if (n < 1024) return n + ' Б'; if (n < 1048576) return (n / 1024).toFixed(1) + ' КБ'; return (n / 1048576).toFixed(1) + ' МБ'; }

  function guessDocType(name) {
    const n = String(name || '').toLowerCase();
    if (n.match(/\.(dwg|dxf|ifc)$/) || (n.match(/\.pdf$/) && n.includes('ар'))) return 'чертеж';
    if (n.match(/\.(xls|xlsx|csv|ods)$/)) return 'смета';
    if (n.includes('акт')) return 'акт';
    if (n.match(/\.(png|jpg|jpeg|tif|tiff|bmp)$/)) return 'фото';
    return 'документ';
  }

  // Браузерные хелперы (используют atob/FileReader) — вызываются только в renderer.
  function b64ToU8(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function fileToBase64(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); }); }
  function fileToArrayBuffer(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(file); }); }

  return {
    is3DModelName: is3DModelName,
    fmtSize: fmtSize,
    guessDocType: guessDocType,
    b64ToU8: b64ToU8,
    fileToBase64: fileToBase64,
    fileToArrayBuffer: fileToArrayBuffer,
  };
});
