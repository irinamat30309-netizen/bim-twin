/* convert-hub.js — BIM Twin v1091
 * Окно «Конвертация форматов»: карточки на общих компонентах интерфейса (ui/components.css, ui/tools.css).
 * Три конвертера:
 *   1. LAS / LAZ / E57 → PLY   (main-process API)
 *   2. Облако точек → 3DGS     (CloudConvert, загруженное облако, до 30 млн сплэтов)
 *   3. PLY файл → 3DGS .splat  (PlyToSplat / CloudConvert, выбор файла с диска)
 */
(function () {
  'use strict';

  /* ── тост ────────────────────────────────────────────────── */
  function toast(msg) {
    if (window.__lxKit && window.__lxKit.toast) { window.__lxKit.toast(msg); return; }
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
  function hydrate(root) { try { if (window.__lxKit && window.__lxKit.hydrate) window.__lxKit.hydrate(root); } catch (e) {} }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function btn(cls, label, fn, ico) {
    var b = el('button', 'btn sm ' + cls); b.type = 'button';
    if (ico) b.setAttribute('data-ico', ico);
    b.textContent = label;
    b.onclick = fn; return b;
  }
  function statusEl(id) { var s = div('cv-status'); s.setAttribute('role', 'status'); s.setAttribute('aria-live', 'polite'); if (id) s.id = id; return s; }
  var STATUS_ICO = { ok: 'circle-check', err: 'circle-alert', warn: 'triangle-alert' };
  function setStatus(s, cls, txt) {
    s.className = 'cv-status ' + (cls || '');
    var lead = cls === 'busy' ? '<span class="cv-spin" aria-hidden="true"></span>' : (STATUS_ICO[cls] ? '<span data-ico="' + STATUS_ICO[cls] + '"></span>' : '');
    s.innerHTML = lead + (txt ? '<span>' + esc(txt) + '</span>' : '');
    if (lead) hydrate(s);
  }
  function card(ico, name, desc) {
    var c = div('cv-card');
    c.appendChild(div('cv-ico', '<span data-ico="' + ico + '"></span>'));
    c.appendChild(div('cv-name', name));
    c.appendChild(div('cv-desc', desc));
    return c;
  }

  /* ── панель ──────────────────────────────────────────────── */
  var hub = null, opener = null;
  function getHub() {
    if (hub && hub.parentNode) return hub;
    hub = div('modal', '');
    hub.id = 'convHub';

    var cardWrap = div('modal-card cv-wrap');
    cardWrap.setAttribute('role', 'dialog'); cardWrap.setAttribute('aria-modal', 'true'); cardWrap.setAttribute('aria-labelledby', 'convHubTitle');
    /* заголовок */
    var head = div('modal-head');
    head.innerHTML = '<span class="cv-title" id="convHubTitle"><span data-ico="repeat"></span>Конвертация форматов</span>';
    var closeBtn = el('button', 'x'); closeBtn.type = 'button';
    closeBtn.setAttribute('data-ico', 'x'); closeBtn.setAttribute('aria-label', 'Закрыть'); closeBtn.setAttribute('data-tip', 'Закрыть (Esc)');
    closeBtn.onclick = hideHub;
    head.appendChild(closeBtn);

    var grid = div('cv-grid');
    grid.append(cardLasToPly(), cardCloudTo3dgs(), cardPlyFileTo3dgs());

    cardWrap.append(head, grid);
    hub.appendChild(cardWrap);
    hub.addEventListener('mousedown', function (e) { if (e.target === hub) hideHub(); });
    document.body.appendChild(hub);
    hydrate(hub);
    return hub;
  }

  function showHub() {
    opener = document.activeElement;
    getHub().classList.add('open'); refreshStatuses();
    var first = hub.querySelector('.cv-card .btn:not([disabled])'); if (first) { try { first.focus({ preventScroll: true }); } catch (e) {} }
  }
  function hideHub() {
    if (!hub || !hub.classList.contains('open')) return;
    hub.classList.remove('open');
    if (opener && opener.focus && document.contains(opener)) { try { opener.focus({ preventScroll: true }); } catch (e) {} }
    opener = null;
  }
  function isOpen() { return !!(hub && hub.classList.contains('open')); }

  function refreshStatuses() {
    /* карточка 2 */
    var s2 = document.getElementById('_chs2');
    if (s2) {
      var vwr = window.__viewer || window.__lxViewer;
      var cc  = vwr && vwr.getEditedCloud && vwr.getEditedCloud();
      if (cc && cc.pos && cc.pos.length) {
        var mln = (cc.pos.length / 3e6).toFixed(2);
        setStatus(s2, 'ok', 'Облако загружено: ' + mln + ' млн точек');
      } else {
        setStatus(s2, 'warn', 'Откройте облако точек в главном вьюере');
      }
    }
    /* карточка 3 */
    var s3 = document.getElementById('_chs3');
    if (s3) {
      var buf = window._lastLidarPlyBuf;
      if (buf) {
        var mb = (buf.byteLength / 1e6).toFixed(0);
        setStatus(s3, 'ok', 'PLY готов: ' + (window._lastLidarPlyName || 'cloud.ply') + ' · ' + mb + ' МБ');
      } else {
        setStatus(s3, '', 'Или загрузите PLY-файл кнопкой ниже');
      }
    }
  }

  /* ── КАРТОЧКА 1: LAS/LAZ/E57 → PLY ─────────────────────── */
  function cardLasToPly() {
    var c = card('package', 'LAS / LAZ / E57 → PLY', 'Конвертирует лазерное облако в PLY для 3D-тура. Работает прямо с диска — не грузит всё в видеопамять.');
    var st = statusEl('_chs1');
    c.appendChild(st);
    var goBtn = btn('primary', 'Конвертировать', function () {
      if (!window.__bimAPI || !window.__bimAPI.convertCloudToPly) {
        setStatus(st, 'err', 'Доступно только в десктоп-версии');
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
            setStatus(st, 'ok', 'PLY сохранён · ' + mln + ' млн т.');
          } else if (!r.canceled) {
            setStatus(st, 'err', r.error || 'ошибка');
          } else {
            setStatus(st, '', '');
          }
        })
        .catch(function (e) {
          goBtn.disabled = false;
          setStatus(st, 'err', e && e.message || 'ошибка');
        });
    });
    goBtn.setAttribute('data-ico', 'play');
    c.appendChild(goBtn);
    return c;
  }

  /* ── КАРТОЧКА 2: Облако → 3DGS (до 30 млн сплэтов) ─────── */
  function cardCloudTo3dgs() {
    var c = card('sparkles', 'Облако точек → 3DGS', 'Преобразует уже загруженное облако в Gaussian Splatting. Перекрывающиеся сплэты закрывают чёрные щели → плотный «фото»-вид.');
    var st = statusEl('_chs2');
    c.appendChild(st);

    /* слайдер количества сплэтов */
    var slRow = div('cv-slider');
    var slTop = div('cv-slider-top');
    slTop.innerHTML = '<span>Сплэтов</span>';
    var slVal = el('output', 'cv-slider-val', '6 млн');
    slTop.appendChild(slVal);
    var slider = document.createElement('input');
    slider.type = 'range'; slider.setAttribute('aria-label', 'Число сплэтов, млн'); slider.min = '1'; slider.max = '30'; slider.step = '1'; slider.value = '6';
    slider.oninput = function () { slVal.textContent = slider.value + ' млн'; };
    slRow.append(slTop, slider);
    c.appendChild(slRow);

    /* доп. слайдер: размер сплэта */
    var szRow = div('cv-slider');
    var szTop = div('cv-slider-top');
    szTop.innerHTML = '<span>Размер сплэта (заполнение щелей)</span>';
    var szVal = el('output', 'cv-slider-val', '×0.60');
    szTop.appendChild(szVal);
    var szSlider = document.createElement('input');
    szSlider.type = 'range'; szSlider.setAttribute('aria-label', 'Размер сплэта'); szSlider.min = '20'; szSlider.max = '160'; szSlider.step = '5'; szSlider.value = '60';
    szSlider.oninput = function () { szVal.textContent = '×' + (parseInt(szSlider.value) / 100).toFixed(2); };
    szRow.append(szTop, szSlider);
    c.appendChild(szRow);

    var goBtn = btn('primary', 'Конвертировать и открыть', function () {
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
          toast('3DGS: ' + res.count.toLocaleString('ru-RU') + ' сплэтов · W/S/A/D — ходьба');
        } catch (e) { toast('Ошибка: ' + (e.message || e)); }
      }, 40);
    });
    c.appendChild(goBtn);
    return c;
  }

  /* ── КАРТОЧКА 3: PLY файл → 3DGS ─────────────────────────── */
  function cardPlyFileTo3dgs() {
    var c = card('file-box', 'PLY файл → 3DGS', 'Выберите любой PLY-файл с диска (облако точек или 3DGS-сплат). Файл читается в браузере — без загрузки в GPU.');
    var st = statusEl('_chs3');
    c.appendChild(st);

    /* прогресс */
    var prog = div('cv-prog');
    var bar  = div('cv-bar');
    prog.appendChild(bar);
    c.appendChild(prog);

    /* скрытый file input */
    var fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.accept = '.ply'; fileInput.hidden = true;
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
        setStatus(st, 'ok', 'PLY готов: ' + file.name + ' · ' + mb + ' МБ');
        toast('PLY загружен: ' + file.name + ' — теперь нажмите «Конвертировать в 3DGS»');
      };
      reader.onerror = function () { setStatus(st, 'err', 'Ошибка чтения файла'); };
      reader.readAsArrayBuffer(file);
    };

    var loadBtn = btn('', 'Выбрать PLY-файл', function () { fileInput.click(); }, 'folder-open');
    c.appendChild(loadBtn);

    var convBtn = btn('primary', 'Конвертировать в 3DGS', function () {
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
          setStatus(st, 'ok', '3DGS: ' + res.count.toLocaleString('ru-RU') + ' сплэтов');
          if (!window.SplatViewer) { toast('Модуль SplatViewer не загружен'); return; }
          var stage = document.querySelector('.stage');
          if (stage) window.SplatViewer.mount(stage);
          window.SplatViewer.load(res.buffer, window._lastSplatName);
          toast('3DGS: ' + res.count.toLocaleString('ru-RU') + ' сплэтов · W/S/A/D — ходьба');
        }).catch(function (e) {
          prog.style.display = 'none';
          setStatus(st, 'err', e.message || e);
          toast('Ошибка: ' + (e.message || e));
        });

      } else if (window.CloudConvert) {
        /* путь 2: CloudConvert — парсим PLY вручную */
        setStatus(st, 'busy', 'Парсинг PLY…');
        toast('PLY → 3DGS через CloudConvert…');
        setTimeout(function () {
          try {
            var parsed = parsePly(buf);
            if (!parsed) { setStatus(st, 'err', 'Не удалось разобрать PLY'); toast('Не удалось разобрать PLY'); return; }
            var res = window.CloudConvert.pointsToSplat(parsed.pos, parsed.col || null,
              { targetSplats: 4000000, scaleMul: 0.65, opacity: 0.92 });
            if (!res || !res.buffer) { setStatus(st, 'err', 'Пустой результат'); return; }
            window._lastSplatBuf = res.buffer;
            window._lastSplatName = (window._lastLidarPlyName || 'cloud').replace(/\.ply$/i, '') + '-3dgs.ply';
            window._lastConvertedSplat = res.buffer;
            setStatus(st, 'ok', '3DGS: ' + res.count.toLocaleString('ru-RU') + ' сплэтов');
            if (window.SplatViewer) {
              var stage = document.querySelector('.stage');
              if (stage) window.SplatViewer.mount(stage);
              window.SplatViewer.load(res.buffer, window._lastSplatName);
            }
            toast('3DGS: ' + res.count.toLocaleString('ru-RU') + ' сплэтов');
          } catch (e) { setStatus(st, 'err', e.message || e); toast('Ошибка: ' + (e.message || e)); }
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

  /* ── перехват кнопки vtConvert: окно вместо прямой конвертации ─────── */
  function wire() {
    var b = document.getElementById('vtConvert');
    if (!b || b.dataset.chWired) return;
    b.dataset.chWired = '1';
    b.addEventListener('click', function (e) {
      e.stopImmediatePropagation();
      e.preventDefault();
      if (isOpen()) hideHub(); else showHub();
    }, true);
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
