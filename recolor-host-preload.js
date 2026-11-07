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
    constructor() { this.dec = null; this.codec = null; this.queue = []; this.err = null; this.ts = 0; this.chain = Promise.resolve(); this.hw = null; }
    async _open(codec, w, h, allowHw) {
      if (typeof VideoDecoder === 'undefined') throw new Error('в этой версии нет декодера видео (WebCodecs)');
      // ревизия 56: сначала пробуем аппаратный декодер (NVIDIA NVDEC и аналоги) — он в разы быстрее софтверного,
      // при любой ошибке откатываемся на программный. Цвет проверяется на кадрах калибровки в recolor-core.
      const hw = { codec, codedWidth: w, codedHeight: h, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true };
      const soft = { codec, codedWidth: w, codedHeight: h, hardwareAcceleration: 'prefer-software', optimizeForLatency: true };
      const any = { codec, codedWidth: w, codedHeight: h, optimizeForLatency: true };
      const tries = allowHw === false ? [soft, any, { codec: 'avc1.640033', codedWidth: w, codedHeight: h }] : [hw, soft, any, { codec: 'avc1.640033', codedWidth: w, codedHeight: h }];
      let cfg = null;
      for (const c of tries) { try { const s = await VideoDecoder.isConfigSupported(c); if (s && s.supported) { cfg = c; break; } } catch (_) {} }
      if (!cfg) throw new Error('декодер H.264 ' + w + '×' + h + ' недоступен');
      if (this.dec) { try { this.dec.close(); } catch (_) {} }
      this.dec = new VideoDecoder({ output: (fr) => { const q = this.queue.shift(); if (q) q.res(fr); else fr.close(); }, error: (e) => { this.err = e; const q = this.queue.splice(0); for (const x of q) x.rej(e); } });
      this.dec.configure(cfg); this.codec = codec; this.hw = cfg.hardwareAcceleration === 'prefer-hardware';
    }
    // bytes — Uint8Array кадра (Annex B), f — { w, h }; → { w, h, Y, U, V, sY, sU, uvStep, fullRange, close }
    decode(bytes, f, allowHw) {
      const open = async () => {
        const codec = codecFromAnnexB(bytes);
        if (!this.dec || this.dec.state === 'closed' || this.codec !== codec || this.err) { this.err = null; await this._open(codec, f.w || 4000, f.h || 3000, allowHw); }
        return codec;
      };
      const once = async () => {
        await open();
        const p = new Promise((res, rej) => this.queue.push({ res, rej }));
        // flush() на каждый кадр держит память под контролем: без него декодер копит кадры и процесс падает
        // по памяти (проверено: «Array buffer allocation failed»). Кадры ключевые, поэтому flush дешёвый.
        this.dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: this.ts++, data: bytes }));
        await this.dec.flush();
        return p;
      };
      const run = async () => {
        try { return await once(); }
        catch (e) {
          // ревизия 56: аппаратный декодер может не справиться с конкретным кадром — тихо откатываемся на программный
          if (!this.hw) throw e;
          this.hw = false; this.dec = null;
          this.softOnly = true;
          await this._open(codecFromAnnexB(bytes), f.w || 4000, f.h || 3000, false);
          return await once();
        }
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
    // Ревизия 56: пул декодеров — кадры .xbin все ключевые, поэтому их можно декодировать параллельно
    // (по умолчанию 3: столько же кадров одновременно готовит recolor-core). На многоядерных машинах это убирает
    // простой на декодировании H.264 4000×3000.
    // Ревизия 56: пул декодеров. Сравнение на окне 120 с (3,08 млн точек, 742 кадра): 1 декодер — 56,6 с,
    // 3 декодера — 45,3 с, 5 декодеров — 41,5 с (на 6 ядрах). По умолчанию — по числу ядер (до 6).
    // Аппаратный декодер (NVDEC) на этой машине оказался медленнее (61,5 с), поэтому включается только явно.
    const opt = cfg.opt || {};
    let cpuN = 6; try { cpuN = require('os').availableParallelism ? require('os').availableParallelism() : require('os').cpus().length; } catch (_) {}
    const poolSize = Math.max(1, Math.min(6, Number(opt.decodePool) || Math.max(2, Math.min(6, cpuN - 1))));
    const pool = []; for (let i = 0; i < poolSize; i++) pool.push(new FrameDecoder());
    let nextDec = 0;
    const hwOn = opt.hardwareDecode === true;
    // ревизия 56: кадров в работе столько же, сколько декодеров (по умолчанию 3) — иначе декодеры простаивают.
    // Замер: 3 кадра — 40,0 с, 5 кадров — 38,3 с, 8 кадров — 42,2 с (память и конкуренция за ядра).
    if (opt.prefetch == null) opt.prefetch = Math.min(6, poolSize);
    const decode = (bytes, f) => { const d = pool[nextDec++ % pool.length]; return d.decode(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), f.src || f, hwOn); };
    try {
      const XB = require(path.join(cfg.appDir, 'xbin-core.js')), RC = require(path.join(cfg.appDir, 'recolor-core.js'));
      ipc.send('recolor:progress', { f: 0, label: 'Цвет по фото: оглавление .xbin…' });
      const index = XB.open(cfg.xbin, (f) => ipc.send('recolor:progress', { f: 0.02 * f, label: 'Цвет по фото: оглавление .xbin…' }));
      const stats = await RC.recolor(cfg.src, cfg.dst, { index, posesText: cfg.posesText, tmpDir: cfg.tmpDir, opt,
        decode,
        onProgress: (f, label) => ipc.send('recolor:progress', { f: 0.02 + 0.98 * f, label }) });
      stats.model = index.calib && index.calib.model;
      stats.decodePool = poolSize;
      stats.hardwareDecode = hwOn && pool.some(d => d.hw);
      // ревизия 51: путь к .xbin — для уплотнения по сырому лидару в той же чистовой обработке (scan-refine-worker.js)
      try { if (cfg.tmpDir) require('fs').writeFileSync(path.join(cfg.tmpDir, 'xbin-source.txt'), String(cfg.xbin)); } catch (_) {}
      ipc.send('recolor:done', { ok: true, stats });
    } catch (e) {
      ipc.send('recolor:done', { ok: false, error: String((e && e.message) || e) });
    } finally { for (const d of pool) { try { d.close(); } catch (_) {} } }
  });
  ipc.send('recolor:ready', {});
})(typeof window !== 'undefined' ? window : globalThis);
