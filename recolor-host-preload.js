'use strict';
/*
 * recolor-host-preload.js — preload скрытого окна перекраски по фото сканера (ревизия 22).
 * Кадры H.264 из .xbin декодирует WebCodecs VideoDecoder (в Electron есть H.264), сам расчёт — recolor-core.js.
 * Страница окна (recolor-host.html) пустая и без скриптов (CSP default-src 'none'), contextIsolation включена, nodeIntegration
 * выключена: доступ к файлам есть только у этого preload, и он ничего не передаёт странице. Окно не показывается, переходы и
 * новые окна запрещены; главный процесс открывает его на время задачи и закрывает после неё.
 */
(function (root) {
  // ---- декодер одиночных ключевых кадров → I420/NV12 плоскости ----
  function codecFromAnnexB(b) {   // 'avc1.PPCCLL' из SPS (NAL 7)
    for (let i = 0; i + 8 < b.length && i < 4096; i++) {
      if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && (b[i + 3] & 0x1f) === 7) {
        const h = (x) => (x < 16 ? '0' : '') + x.toString(16);
        return 'avc1.' + h(b[i + 4]) + h(b[i + 5]) + h(b[i + 6]);
      }
    }
    return 'avc1.64003c';
  }
  class FrameDecoder {
    constructor() { this.dec = null; this.codec = null; this.queue = []; this.err = null; this.ts = 0; this.chain = Promise.resolve(); }
    async _open(codec, w, h) {
      if (typeof VideoDecoder === 'undefined') throw new Error('в этой версии нет декодера видео (WebCodecs)');
      const tries = [{ codec, codedWidth: w, codedHeight: h, hardwareAcceleration: 'prefer-software', optimizeForLatency: true },
        { codec, codedWidth: w, codedHeight: h, optimizeForLatency: true }, { codec: 'avc1.640033', codedWidth: w, codedHeight: h }];
      let cfg = null;
      for (const c of tries) { try { const s = await VideoDecoder.isConfigSupported(c); if (s && s.supported) { cfg = c; break; } } catch (_) {} }
      if (!cfg) throw new Error('декодер H.264 ' + w + '×' + h + ' недоступен');
      if (this.dec) { try { this.dec.close(); } catch (_) {} }
      this.dec = new VideoDecoder({ output: (fr) => { const q = this.queue.shift(); if (q) q.res(fr); else fr.close(); }, error: (e) => { this.err = e; const q = this.queue.splice(0); for (const x of q) x.rej(e); } });
      this.dec.configure(cfg); this.codec = codec;
    }
    // bytes — Uint8Array кадра (Annex B), f — { w, h }; → { w, h, Y, U, V, sY, sU, uvStep, fullRange, close }
    decode(bytes, f) {
      const run = async () => {
        const codec = codecFromAnnexB(bytes);
        if (!this.dec || this.dec.state === 'closed' || this.codec !== codec || this.err) { this.err = null; await this._open(codec, f.w || 4000, f.h || 3000); }
        const p = new Promise((res, rej) => this.queue.push({ res, rej }));
        this.dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: this.ts++, data: bytes }));
        await this.dec.flush();
        return p;
      };
      const r = this.chain.then(run);
      this.chain = r.then(() => {}, () => {});
      return r.then(async (fr) => {
        try {
          const vr = fr.visibleRect || { x: 0, y: 0, width: fr.displayWidth, height: fr.displayHeight };
          const rect = { x: vr.x, y: vr.y, width: vr.width & ~1, height: vr.height & ~1 };
          const fmt = fr.format; let buf, lay;
          if (fmt === 'I420' || fmt === 'I420A' || fmt === 'NV12') {
            buf = new Uint8Array(fr.allocationSize({ rect })); lay = await fr.copyTo(buf, { rect });
          } else throw new Error('формат кадра ' + fmt + ' не поддерживается');
          const W = rect.width, Hh = rect.height, Y = buf.subarray(lay[0].offset), cs = fr.colorSpace || {};
          const out = { w: W, h: Hh, Y, sY: lay[0].stride, fullRange: !!cs.fullRange, close() {} };
          if (fmt === 'NV12') { out.U = buf.subarray(lay[1].offset); out.V = buf.subarray(lay[1].offset + 1); out.sU = lay[1].stride; out.uvStep = 2; }
          else { out.U = buf.subarray(lay[1].offset); out.V = buf.subarray(lay[2].offset); out.sU = lay[1].stride; out.uvStep = 1; }
          return out;
        } finally { fr.close(); }
      });
    }
    close() { try { this.dec && this.dec.close(); } catch (_) {} this.dec = null; }
  }
  root.BimFrameDecoder = FrameDecoder; root.bimCodecFromAnnexB = codecFromAnnexB;

  // ---- запуск в Electron: задача от главного процесса ----
  if (typeof require !== 'function') return;
  let ipc = null; try { ipc = require('electron').ipcRenderer; } catch (_) { return; }
  ipc.on('recolor:start', async (_e, cfg) => {
    const path = require('path');
    const dec = new FrameDecoder();
    try {
      const XB = require(path.join(cfg.appDir, 'xbin-core.js')), RC = require(path.join(cfg.appDir, 'recolor-core.js'));
      ipc.send('recolor:progress', { f: 0, label: 'Цвет по фото: оглавление .xbin…' });
      const index = XB.open(cfg.xbin, (f) => ipc.send('recolor:progress', { f: 0.02 * f, label: 'Цвет по фото: оглавление .xbin…' }));
      const stats = await RC.recolor(cfg.src, cfg.dst, { index, posesText: cfg.posesText, tmpDir: cfg.tmpDir, opt: cfg.opt || {},
        decode: (bytes, f) => dec.decode(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), f.src || f),
        onProgress: (f, label) => ipc.send('recolor:progress', { f: 0.02 + 0.98 * f, label }) });
      stats.model = index.calib && index.calib.model;
      ipc.send('recolor:done', { ok: true, stats });
    } catch (e) {
      ipc.send('recolor:done', { ok: false, error: String((e && e.message) || e) });
    } finally { dec.close(); }
  });
  ipc.send('recolor:ready', {});
})(typeof window !== 'undefined' ? window : globalThis);
