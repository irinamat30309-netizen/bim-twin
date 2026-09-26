/* convert-hub.js — BIM Twin v1091
 * Меню «Конвертация» — дизайн совпадает с lixel-ui (--accent:#1f47ca).
 * Три конвертера:
 *   1. LAS / LAZ / E57 → PLY   (main-process API)
 *   2. Облако точек → 3DGS     (CloudConvert, загруженное облако, до 30 млн сплэтов)
 *   3. PLY файл → 3DGS .splat  (PlyToSplat / CloudConvert, выбор файла с диска)
 */
(function () {
  'use strict';

  /* ── CSS один раз ──────────────────────────────────────────── */
  var CSS = [
    '#convHub{position:fixed;top:52px;left:50%;transform:translateX(-50%);z-index:14000;',
    'width:740px;max-width:97vw;',
    'background:#1c1d1f;border:1px solid #2a2b2e;border-top:2px solid #1f47ca;',
    'border-radius:0 0 12px 12px;box-shadow:0 16px 50px rgba(0,0,0,.6);',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,system-ui,sans-serif;',
    'color:#e6e6e6;font-size:13px;display:none}',

    '#convHub .ch-head{display:flex;align-items:center;justify-content:space-between;',
    'padding:10px 16px;border-bottom:1px solid #2a2b2e;background:#131314}',
    '#convHub .ch-title{font-size:13px;font-weight:700;letter-spacing:.3px;color:#c8d0dc;display:flex;align-items:center;gap:7px}',
    '#convHub .ch-title svg{opacity:.8}',
    '#convHub .ch-close{background:none;border:none;color:#6b7080;font-size:16px;cursor:pointer;',
    'padding:2px 6px;border-radius:4px;line-height:1;transition:background .12s,color .12s}',
    '#convHub .ch-close:hover{background:rgba(235,87,87,.18);color:#eb5757}',

    '#convHub .ch-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:0;padding:0}',

    '#convHub .ch-card{padding:16px;border-right:1px solid #2a2b2e;display:flex;flex-direction:column;gap:10px;min-height:240px}',
    '#convHub .ch-card:last-child{border-right:none}',
    '#convHub .ch-card:hover{background:rgba(31,71,202,.04)}',

    '#convHub .ch-icon{font-size:20px;line-height:1}',
    '#convHub .ch-name{font-size:12px;font-weight:700;color:#c8d0dc;letter-spacing:.2px}',
    '#convHub .ch-desc{font-size:11px;color:#6b7080;line-height:1.5;flex:1}',
    '#convHub .ch-status{font-size:11px;min-height:14px;line-height:1.4}',
    '#convHub .ch-status.ok{color:#3fb27f}',
    '#convHub .ch-status.err{color:#eb5757}',
    '#convHub .ch-status.busy{color:#7ea6ff}',

    '#convHub .ch-slider-row{display:flex;flex-direction:column;gap:4px}',
    '#convHub .ch-slider-top{display:flex;justify-content:space-between;font-size:11px;color:#6b7080}',
    '#convHub .ch-slider-val{color:#7ea6ff;font-variant-numeric:tabular-nums;font-weight:600}',
    '#convHub input[type=range]{width:100%;accent-color:#1f47ca;cursor:pointer}',

    '#convHub .ch-prog{display:none;background:#0a0a0c;border-radius:4px;height:5px;overflow:hidden}',
    '#convHub .ch-bar{height:100%;width:0%;background:linear-gradient(90deg,#1f47ca,#4a9df8);transition:width .25s}',

    '#convHub .ch-btn{padding:8px 12px;border-radius:7px;border:none;font-size:12px;font-weight:700;',
    'cursor:pointer;width:100%;transition:opacity .15s,background .15s;letter-spacing:.2px}',
    '#convHub .ch-btn.primary{background:#1f47ca;color:#fff}',
    '#convHub .ch-btn.primary:hover{background:#2654e0}',
    '#convHub .ch-btn.primary:disabled{opacity:.45;cursor:not-allowed}',
    '#convHub .ch-btn.secondary{background:#2f3033;color:#c8d0dc;border:1px solid #3a3d44}',
    '#convHub .ch-btn.secondary:hover{background:#3a3d44}',
    '#convHub .ch-btn.secondary:disabled{opacity:.45;cursor:not-allowed}',
  ].join('');

  function injectCss() {
    if (document.getElementById('_convHubCss')) return;
    var s = document.createElement('style'); s.id = '_convHubCss'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ── тост ────────────────────────────────────────────────── */
  function toast(msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._chTid);
    t._chTid = setTimeout(function () { t.classList.remove('show'); }, 3400);
  }

  /* ── DOM-хелперы ──────────────────────────────────────────── */
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls)  e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function div(cls, html) { return el('div', cls, html); }
  function btn(cls, label, fn) {
    var b = el('button', 'ch-btn ' + cls, label);
    b.onclick = fn; return b;
  }
  function statusEl(id) { var s = div('ch-status'); if (id) s.id = id; return s; }
  function setStatus(s, cls, txt) {
    s.className = 'ch-status ' + (cls || ''); s.textContent = txt || '';
  }

  /* ── панель ──────────────────────────────────────────────── */
  var hub = null;
  function getHub() {
    if (hub && hub.parentNode) return hub;
    injectCss();
    hub = div('', '');
    hub.id = 'convHub';

    /* заголовок */
    var head = div('ch-head');
    var titleWrap = div('ch-title');
    titleWrap.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1f47ca" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg> Конвертация форматов';
    var closeBtn = el('button', 'ch-close', '×');
    closeBtn.title = 'Закрыть (Esc)';
    closeBtn.onclick = hideHub;
    head.append(titleWrap, closeBtn);

    var grid = div('ch-grid');
    grid.append(cardLasToPly(), cardCloudTo3dgs(), cardPlyFileTo3dgs());

    hub.append(head, grid);
    document.body.appendChild(hub);
    return hub;
  }

  function showHub() { getHub().style.display = 'block'; refreshStatuses(); }
  function hideHub() { if (hub) hub.style.display = 'none'; }
  function isOpen() { return hub && hub.style.display !== 'none'; }

  function refreshStatuses() {
    /* карточка 2 */
    var s2 = document.getElementById('_chs2');
    if (s2) {
      var vwr = window.__viewer || window.__lxViewer;
      var cc  = vwr && vwr.getEditedCloud && vwr.getEditedCloud();
      if (cc && cc.pos && cc.pos.length) {
        var mln = (cc.pos.length / 3e6).toFixed(2);
        setStatus(s2, 'ok', '✅ Облако загружено: ' + mln + ' млн точек');
      } else {
        setStatus(s2, '', '⚠ Откройте облако точек в главном вьюере');
      }
    }
    /* карточка 3 */
    var s3 = document.getElementById('_chs3');
    if (s3) {
      var buf = window._lastLidarPlyBuf;
      if (buf) {
        var mb = (buf.byteLength / 1e6).toFixed(0);
        setStatus(s3, 'ok', '✅ PLY готов: ' + (window._lastLidarPlyName || 'cloud.ply') + ' · ' + mb + ' МБ');
      } else {
        setStatus(s3, '', 'Или загрузите PLY-файл кнопкой ниже');
      }
    }
  }

  /* ── КАРТОЧКА 1: LAS/LAZ/E57 → PLY ─────────────────────── */
  function cardLasToPly() {
    var c = div('ch-card');
    c.append(
      div('ch-icon', '📦'),
      div('ch-name', 'LAS / LAZ / E57 → PLY'),
      div('ch-desc', 'Конвертирует лазерное облако в PLY для 3D-тура. Работает прямо с диска — не грузит всё в видеопамять.')
    );
    var st = statusEl('_chs1');
    c.appendChild(st);
    var goBtn = btn('primary', '▶ Конвертировать', function () {
      if (!window.__bimAPI || !window.__bimAPI.convertCloudToPly) {
        setStatus(st, 'err', '✕ Доступно только в десктоп-версии');
        toast('Конвертация доступна в десктоп-версии'); return;
      }
      goBtn.disabled = true;
      setStatus(st, 'busy', 'Запуск конвертации…');
      window.__bimAPI.convertCloudToPly()
        .then(function (r) {
          goBtn.disabled = false;
          if (!r) { setStatus(st, '', ''); return; }
          if (r.ok) {
            var mln = Math.round((r.count || 0) / 1e5) / 10;
            setStatus(st, 'ok', '✅ PLY сохранён · ' + mln + ' млн т.');
          } else if (!r.canceled) {
            setStatus(st, 'err', '✕ ' + (r.error || 'ошибка'));
          } else {
            setStatus(st, '', '');
          }
        })
        .catch(function (e) {
          goBtn.disabled = false;
          setStatus(st, 'err', '✕ ' + (e && e.message || 'ошибка'));
        });
    });
    c.appendChild(goBtn);
    return c;
  }

  /* ── КАРТОЧКА 2: Облако → 3DGS (до 30 млн сплэтов) ─────── */
  function cardCloudTo3dgs() {
    var c = div('ch-card');
    c.append(
      div('ch-icon', '✨'),
      div('ch-name', 'Облако точек → 3DGS'),
      div('ch-desc', 'Преобразует уже загруженное облако в Gaussian Splatting. Перекрывающиеся сплэты закрывают чёрные щели → плотный «фото»-вид.')
    );
    var st = statusEl('_chs2');
    c.appendChild(st);

    /* слайдер количества сплэтов */
    var slRow = div('ch-slider-row');
    var slTop = div('ch-slider-top');
    slTop.innerHTML = '<span>Сплэтов:</span>';
    var slVal = div('ch-slider-val', '6 млн');
    slTop.appendChild(slVal);
    var slider = document.createElement('input');
    slider.type = 'range'; slider.min = '1'; slider.max = '30'; slider.step = '1'; slider.value = '6';
    slider.oninput = function () { slVal.textContent = slider.value + ' млн'; };
    slRow.append(slTop, slider);
    c.appendChild(slRow);

    /* доп. слайдер: размер сплэта */
    var szRow = div('ch-slider-row');
    var szTop = div('ch-slider-top');
    szTop.innerHTML = '<span>Размер сплэта (заполнение щелей):</span>';
    var szVal = div('ch-slider-val', '×0.60');
    szTop.appendChild(szVal);
    var szSlider = document.createElement('input');
    szSlider.type = 'range'; szSlider.min = '20'; szSlider.max = '160'; szSlider.step = '5'; szSlider.value = '60';
    szSlider.oninput = function () { szVal.textContent = '×' + (parseInt(szSlider.value) / 100).toFixed(2); };
    szRow.append(szTop, szSlider);
    c.appendChild(szRow);

    var goBtn = btn('primary', '✨ Конвертировать и открыть', function () {
      if (!window.CloudConvert)  { toast('Модуль CloudConvert не загружен'); return; }
      if (!window.SplatViewer)   { toast('Модуль SplatViewer не загружен'); return; }
      var vwr = window.__viewer || window.__lxViewer;
      var cc  = vwr && vwr.getEditedCloud && vwr.getEditedCloud();
      if (!cc || !cc.pos || !cc.pos.length) {
        toast('Сначала откройте облако точек в главном вьюере'); return;
      }
      hideHub();
      toast('Конвертация облака в 3DGS… подождите');
      setTimeout(function () {
        try {
          var res = window.CloudConvert.pointsToSplat(cc.pos, cc.col || null, {
            targetSplats: parseInt(slider.value) * 1000000,
            scaleMul:     parseInt(szSlider.value) / 100,
            opacity:      0.92
          });
          if (!res || !res.buffer) { toast('Пустой результат конвертации'); return; }
          window._lastSplatBuf = res.buffer;
          window._lastSplatName = 'converted-3dgs.ply';
          window._lastConvertedSplat = res.buffer;
          var stage = document.querySelector('.stage');
          if (stage) window.SplatViewer.mount(stage);
          window.SplatViewer.load(res.buffer, 'converted-3dgs.ply');
          toast('✨ 3DGS: ' + res.count.toLocaleString('ru-RU') + ' сплэтов · W/S/A/D — ходьба');
        } catch (e) { toast('Ошибка: ' + (e.message || e)); }
      }, 40);
    });
    c.appendChild(goBtn);
    return c;
  }

  /* ── КАРТОЧКА 3: PLY файл → 3DGS ─────────────────────────── */
  function cardPlyFileTo3dgs() {
    var c = div('ch-card');
    c.append(
      div('ch-icon', '🗂'),
      div('ch-name', 'PLY файл → 3DGS'),
      div('ch-desc', 'Выберите любой PLY-файл с диска (облако точек или 3DGS-сплат). Файл читается в браузере — без загрузки в GPU.')
    );
    var st = statusEl('_chs3');
    c.appendChild(st);

    /* прогресс */
    var prog = div('ch-prog');
    var bar  = div('ch-bar');
    prog.appendChild(bar);
    c.appendChild(prog);

    /* скрытый file input */
    var fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.accept = '.ply'; fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
    fileInput.onchange = function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      setStatus(st, 'busy', 'Чтение ' + file.name + '…');
      var reader = new FileReader();
      reader.onload = function (ev) {
        window._lastLidarPlyBuf  = ev.target.result;
        window._lastLidarPlyName = file.name;
        var mb = (ev.target.result.byteLength / 1e6).toFixed(0);
        setStatus(st, 'ok', '✅ PLY готов: ' + file.name + ' · ' + mb + ' МБ');
        toast('PLY загружен: ' + file.name + ' — теперь нажмите «Конвертировать в 3DGS»');
      };
      reader.onerror = function () { setStatus(st, 'err', '✕ Ошибка чтения файла'); };
      reader.readAsArrayBuffer(file);
    };

    var loadBtn = btn('secondary', '📂 Выбрать PLY-файл', function () { fileInput.click(); });
    c.appendChild(loadBtn);

    var convBtn = btn('primary', '✨ Конвертировать в 3DGS', function () {
      var buf = window._lastLidarPlyBuf;
      if (!buf) { toast('Сначала выберите PLY-файл'); return; }
      hideHub();

      if (window.PlyToSplat) {
        /* путь 1: PlyToSplat — 32-байт бинарный .splat */
        prog.style.display = 'block'; bar.style.width = '0%';
        setStatus(st, 'busy', 'PlyToSplat: конвертация…');
        toast('PLY → 3DGS через PlyToSplat… подождите');
        window.PlyToSplat.convert(buf, {
          downsample: 4,
          progress: function (pct, msg) {
            bar.style.width = pct + '%';
            setStatus(st, 'busy', msg || (pct + '%'));
          }
        }).then(function (res) {
          prog.style.display = 'none';
          window._lastSplatBuf = res.buffer;
          window._lastSplatName = (window._lastLidarPlyName || 'cloud').replace(/\.ply$/i, '') + '-3dgs.splat';
          window._lastConvertedSplat = res.buffer;
          setStatus(st, 'ok', '✅ 3DGS: ' + res.count.toLocaleString('ru-RU') + ' сплэтов');
          if (!window.SplatViewer) { toast('Модуль SplatViewer не загружен'); return; }
          var stage = document.querySelector('.stage');
          if (stage) window.SplatViewer.mount(stage);
          window.SplatViewer.load(res.buffer, window._lastSplatName);
          toast('✨ 3DGS: ' + res.count.toLocaleString('ru-RU') + ' сплэтов · W/S/A/D — ходьба');
        }).catch(function (e) {
          prog.style.display = 'none';
          setStatus(st, 'err', '✕ ' + (e.message || e));
          toast('Ошибка: ' + (e.message || e));
        });

      } else if (window.CloudConvert) {
        /* путь 2: CloudConvert — парсим PLY вручную */
        setStatus(st, 'busy', 'Парсинг PLY…');
        toast('PLY → 3DGS через CloudConvert…');
        setTimeout(function () {
          try {
            var parsed = parsePly(buf);
            if (!parsed) { setStatus(st, 'err', '✕ Не удалось разобрать PLY'); toast('Не удалось разобрать PLY'); return; }
            var res = window.CloudConvert.pointsToSplat(parsed.pos, parsed.col || null,
              { targetSplats: 4000000, scaleMul: 0.65, opacity: 0.92 });
            if (!res || !res.buffer) { setStatus(st, 'err', '✕ Пустой результат'); return; }
            window._lastSplatBuf = res.buffer;
            window._lastSplatName = (window._lastLidarPlyName || 'cloud').replace(/\.ply$/i, '') + '-3dgs.ply';
            window._lastConvertedSplat = res.buffer;
            setStatus(st, 'ok', '✅ 3DGS: ' + res.count.toLocaleString('ru-RU') + ' сплэтов');
            if (window.SplatViewer) {
              var stage = document.querySelector('.stage');
              if (stage) window.SplatViewer.mount(stage);
              window.SplatViewer.load(res.buffer, window._lastSplatName);
            }
            toast('✨ 3DGS: ' + res.count.toLocaleString('ru-RU') + ' сплэтов');
          } catch (e) { setStatus(st, 'err', '✕ ' + (e.message || e)); toast('Ошибка: ' + (e.message || e)); }
        }, 40);
      } else {
        toast('Модуль конвертера не загружен (нет PlyToSplat и CloudConvert)');
      }
    });
    c.appendChild(convBtn);
    return c;
  }

  /* ── простой PLY-парсер (x y z red green blue) ─────────────── */
  function parsePly(buf) {
    try {
      var u8 = new Uint8Array(buf), hdrEnd = -1;
      var END_H = [101,110,100,95,104]; /* end_h */
      for (var i = 0; i < Math.min(u8.length - 12, 16384); i++) {
        if (u8[i]===END_H[0] && u8[i+1]===END_H[1] && u8[i+2]===END_H[2] && u8[i+3]===END_H[3] && u8[i+4]===END_H[4]) { hdrEnd = i; break; }
      }
      if (hdrEnd < 0) return null;
      while (hdrEnd < u8.length && u8[hdrEnd] !== 10) hdrEnd++;
      hdrEnd++;
      var hdr = new TextDecoder().decode(u8.slice(0, hdrEnd));
      var binary = hdr.indexOf('binary_little_endian') >= 0;
      var nMatch = hdr.match(/element vertex (\d+)/);
      if (!nMatch) return null;
      var N = parseInt(nMatch[1], 10); if (!N) return null;
      var props = []; var pm, propRe = /property (\S+) (\S+)/g;
      while ((pm = propRe.exec(hdr))) props.push({ t: pm[1], n: pm[2] });
      var xi=-1,yi=-1,zi=-1,ri=-1,gi=-1,bi=-1;
      props.forEach(function(p,idx){
        if(p.n==='x')xi=idx; else if(p.n==='y')yi=idx; else if(p.n==='z')zi=idx;
        else if(p.n==='red'||p.n==='r'||p.n==='diffuse_red')ri=idx;
        else if(p.n==='green'||p.n==='g'||p.n==='diffuse_green')gi=idx;
        else if(p.n==='blue'||p.n==='b'||p.n==='diffuse_blue')bi=idx;
      });
      if(xi<0||yi<0||zi<0) return null;
      /* размер каждого свойства */
      function sz(t){return t==='float'||t==='float32'||t==='int'||t==='int32'||t==='uint'||t==='uint32'?4:t==='double'||t==='float64'?8:1;}
      var stride=0,offsets=[];
      props.forEach(function(p){offsets.push(stride);stride+=sz(p.t);});
      var LIMIT=10000000, inStr=N>LIMIT?Math.ceil(N/LIMIT):1, Ns=Math.ceil(N/inStr);
      var pos=new Float32Array(Ns*3), col=(ri>=0&&gi>=0&&bi>=0)?new Uint8Array(Ns*3):null;
      if(binary){
        var dv=new DataView(buf,hdrEnd); var j=0;
        for(var k=0;k<N&&j<Ns;k+=inStr){
          var base=k*stride;
          pos[j*3]  =dv.getFloat32(base+offsets[xi],true);
          pos[j*3+1]=dv.getFloat32(base+offsets[yi],true);
          pos[j*3+2]=dv.getFloat32(base+offsets[zi],true);
          if(col){col[j*3]=dv.getUint8(base+offsets[ri]);col[j*3+1]=dv.getUint8(base+offsets[gi]);col[j*3+2]=dv.getUint8(base+offsets[bi]);}
          j++;
        }
        if(j<Ns){pos=pos.subarray(0,j*3);if(col)col=col.subarray(0,j*3);}
      } else {
        var txt=new TextDecoder().decode(u8.slice(hdrEnd)).split('\n'); var j=0;
        for(var li=0;li<txt.length&&j<Ns;li++){
          var pts=txt[li].trim().split(/\s+/);
          if(pts.length<props.length) continue;
          pos[j*3]=parseFloat(pts[xi]);pos[j*3+1]=parseFloat(pts[yi]);pos[j*3+2]=parseFloat(pts[zi]);
          if(col){col[j*3]=parseFloat(pts[ri]);col[j*3+1]=parseFloat(pts[gi]);col[j*3+2]=parseFloat(pts[bi]);}
          j++;
        }
      }
      return {pos:pos,col:col};
    } catch(e){console.warn('parsePly',e);return null;}
  }

  /* ── перехват кнопки vtConvert ─────────────────────────────── */
  function wire() {
    var b = document.getElementById('vtConvert');
    if (!b || b.dataset.chWired) return;
    var nb = b.cloneNode(true);
    b.parentNode.replaceChild(nb, b);
    nb.dataset.chWired = '1';
    nb.addEventListener('click', function (e) {
      e.stopImmediatePropagation();
      isOpen() ? hideHub() : showHub();
    });
  }

  /* ── закрытие ──────────────────────────────────────────────── */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen()) { hideHub(); e.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('pointerdown', function (e) {
    if (!isOpen()) return;
    var btn = document.getElementById('vtConvert');
    if (hub && !hub.contains(e.target) && !(btn && btn.contains(e.target))) hideHub();
  }, true);

  /* ── запуск ────────────────────────────────────────────────── */
  function init() {
    wire();
    new MutationObserver(function () {
      var b = document.getElementById('vtConvert');
      if (b && !b.dataset.chWired) wire();
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', function () { setTimeout(init, 900); });
  else setTimeout(init, 900);

  window.ConvertHub = { show: showHub, hide: hideHub };
})();
