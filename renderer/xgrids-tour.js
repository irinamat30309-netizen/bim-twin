/* xgrids-tour.js — BIM Twin v1092
 * Встраивает вьюер xgrids.com (Lixel/CoCloud) как полноэкранный iframe.
 * Небо, фото-текстуры, аннотации — всё от нативного вьюера Lixel.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'bimTwin.xgridsUrl';

  /* ─── цветовые токены (lixel-ui.css) ─────────────────── */
  var C = {
    bg     : '#131314',
    panel  : '#1c1d1f',
    card   : '#252628',
    border : '#2a2b2e',
    txt    : '#e6e6e6',
    muted  : '#6b7080',
    accent : '#1f47ca',
    ok     : '#3fb27f',
    err    : '#eb5757'
  };

  /* ─── утилиты ─────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }
  function el(tag, css, html) {
    var e = document.createElement(tag);
    if (css)  e.style.cssText = css;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function toast(msg) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._tid);
    t._tid = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }

  /* ─── нормализация URL → embed ────────────────────────── */
  function normalizeXgridsUrl(raw) {
    var s = (raw || '').trim();
    if (!s) return '';
    /* уже full URL — оставляем; добавляем embed-параметр */
    try {
      var u = new URL(s);
      /* xgrids.com / lixel.com / lixelapp.com */
      if (/xgrids\.com|lixel\.com|lixelapp\.com/.test(u.hostname)) {
        /* /s/XXX  → /embed/XXX */
        u.pathname = u.pathname.replace(/^\/s\//, '/embed/');
        /* если уже /embed/ — оставляем */
        if (!/^\/embed\//.test(u.pathname) && !/\/viewer/.test(u.pathname)) {
          /* добавляем ?embed=1 */
          u.searchParams.set('embed', '1');
        }
        return u.toString();
      }
      /* любой другой URL (CoCloud, corptour и т.п.) */
      return s;
    } catch (e) {
      /* не URL — может быть scene ID */
      if (/^[A-Za-z0-9_-]{6,}$/.test(s)) {
        return 'https://xgrids.com/embed/' + s;
      }
      return s;
    }
  }

  /* ─── панель ──────────────────────────────────────────── */
  var overlay = null;

  function buildOverlay() {
    if (overlay && overlay.parentNode) return;

    overlay = el('div',
      'position:fixed;inset:0;z-index:15000;background:' + C.bg + ';'
      + 'display:none;flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;');
    overlay.id = 'xgridsTourOverlay';

    /* ── шапка ────────────────────────────────────────── */
    var hd = el('div',
      'height:44px;min-height:44px;background:' + C.panel + ';border-bottom:1px solid ' + C.border + ';'
      + 'display:flex;align-items:center;gap:8px;padding:0 12px;flex-shrink:0;');

    /* лого / бейдж */
    var logo = el('div',
      'display:flex;align-items:center;gap:6px;flex-shrink:0');
    var dot = el('span',
      'width:8px;height:8px;border-radius:2px;background:' + C.accent + ';display:inline-block;flex-shrink:0');
    var logoTxt = el('span',
      'font-size:12.5px;font-weight:700;color:#c8d0dc;letter-spacing:.03em',
      'xgrids · Lixel 3D-тур');
    logo.append(dot, logoTxt);

    /* подсказка */
    var hint = el('span',
      'font-size:11px;color:' + C.muted + ';flex-shrink:0;white-space:nowrap',
      '🌐 небо · фото-текстуры · аннотации');

    /* разделитель */
    var sep1 = el('div', 'width:1px;height:20px;background:' + C.border + ';flex-shrink:0');

    /* поле URL */
    var urlWrap = el('div',
      'flex:1;display:flex;align-items:center;gap:6px;min-width:0;background:' + C.card + ';'
      + 'border:1px solid ' + C.border + ';border-radius:7px;padding:3px 8px;'
      + 'transition:border-color .15s');
    var urlIcon = el('span', 'color:' + C.muted + ';font-size:13px;flex-shrink:0', '🔗');
    var urlInp = el('input',
      'flex:1;background:none;border:none;outline:none;font-size:12px;color:' + C.txt + ';min-width:0');
    urlInp.placeholder = 'Вставьте ссылку xgrids.com или Scene ID…';
    urlInp.autocomplete = 'off';
    urlInp.spellcheck = false;
    urlInp.value = localStorage.getItem(STORAGE_KEY) || '';
    urlWrap.onmouseenter = function(){urlWrap.style.borderColor=C.accent;};
    urlWrap.onmouseleave = function(){if(document.activeElement!==urlInp)urlWrap.style.borderColor=C.border;};
    urlInp.onfocus = function(){urlWrap.style.borderColor=C.accent;};
    urlInp.onblur  = function(){urlWrap.style.borderColor=C.border;};
    urlWrap.append(urlIcon, urlInp);

    /* кнопка Открыть */
    var openBtn = el('button',
      'padding:5px 14px;border-radius:7px;border:none;cursor:pointer;font-size:12px;font-weight:700;'
      + 'background:' + C.accent + ';color:#fff;flex-shrink:0;transition:opacity .15s');
    openBtn.textContent = 'Открыть';
    openBtn.onmouseenter=function(){openBtn.style.opacity='.82';};
    openBtn.onmouseleave=function(){openBtn.style.opacity='1';};

    /* разделитель */
    var sep2 = el('div', 'width:1px;height:20px;background:' + C.border + ';flex-shrink:0');

    /* кнопки справа */
    function iconBtn(title, svgPath) {
      var b = el('button',
        'background:none;border:none;color:' + C.muted + ';cursor:pointer;'
        + 'padding:5px 7px;border-radius:6px;display:flex;align-items:center;justify-content:center;'
        + 'transition:background .15s,color .15s;flex-shrink:0');
      b.title = title;
      b.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + svgPath + '</svg>';
      b.onmouseenter=function(){b.style.background='rgba(255,255,255,.07)';b.style.color=C.txt;};
      b.onmouseleave=function(){b.style.background='none';b.style.color=C.muted;};
      return b;
    }

    var fsBtn  = iconBtn('Полный экран браузера',
      '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>');
    var helpBtn = iconBtn('Как получить ссылку xgrids',
      '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>');
    var closeBtn2 = iconBtn('Закрыть (Esc)',
      '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>');
    closeBtn2.style.color = C.muted;

    hd.append(logo, hint, sep1, urlWrap, openBtn, sep2, fsBtn, helpBtn, closeBtn2);
    overlay.appendChild(hd);

    /* ── тело (iframe + заглушка) ─────────────────────── */
    var body = el('div', 'flex:1;position:relative;overflow:hidden;background:#000');
    overlay.appendChild(body);

    /* iframe */
    var iframe = el('iframe',
      'position:absolute;inset:0;width:100%;height:100%;border:none;display:none');
    iframe.id = 'xgridsFrame';
    iframe.allow = 'fullscreen; gyroscope; accelerometer; magnetometer; xr-spatial-tracking';
    iframe.allowFullscreen = true;
    body.appendChild(iframe);

    /* заглушка-экран */
    var stub = el('div',
      'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;padding:32px');
    body.appendChild(stub);

    /* иконка-«звезда» */
    var bigIcon = el('div', 'font-size:52px;line-height:1', '🌐');

    var stubTitle = el('div',
      'font-size:18px;font-weight:700;color:#c8d0dc;text-align:center',
      'Lixel / xgrids 3D-тур');

    var stubDesc = el('div',
      'font-size:13px;color:' + C.muted + ';text-align:center;max-width:540px;line-height:1.65',
      'Вставьте ссылку со страницы xgrids.com (кнопка «Поделиться → Ссылка»)<br>'
      + 'или введите Scene ID из CoCloud — и нажмите <b style="color:#c8d0dc">Открыть</b>.<br><br>'
      + 'В туре будет <b style="color:#c8d0dc">небо</b>, <b style="color:#c8d0dc">фото-текстуры</b>, '
      + 'аннотации и все фишки вьюера Lixel.');

    /* карточки-подсказки */
    var cards = el('div',
      'display:grid;grid-template-columns:repeat(3,1fr);gap:12px;max-width:640px;width:100%');
    [
      ['☁️', 'Небо и окружение', 'HDR-небосвод из панорамы'],
      ['📸', 'Фото-текстуры', 'Чёткие 360°-снимки Lixel'],
      ['📍', 'Аннотации', 'Метки, этажи, навигация']
    ].forEach(function(item){
      var c = el('div',
        'background:' + C.card + ';border:1px solid ' + C.border + ';border-radius:8px;'
        + 'padding:14px;display:flex;flex-direction:column;gap:6px;align-items:center;text-align:center');
      c.innerHTML = '<div style="font-size:24px">' + item[0] + '</div>'
        + '<div style="font-size:12px;font-weight:700;color:#c8d0dc">' + item[1] + '</div>'
        + '<div style="font-size:11px;color:' + C.muted + '">' + item[2] + '</div>';
      cards.appendChild(c);
    });

    stub.append(bigIcon, stubTitle, stubDesc, cards);

    /* ── help-modal ───────────────────────────────────── */
    var helpModal = el('div',
      'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);'
      + 'background:' + C.panel + ';border:1px solid ' + C.border + ';border-radius:10px;'
      + 'padding:24px 28px;max-width:480px;width:90%;z-index:2;display:none;'
      + 'box-shadow:0 20px 60px rgba(0,0,0,.7);color:' + C.txt);
    helpModal.innerHTML = [
      '<div style="font-size:14px;font-weight:700;margin-bottom:14px;color:#c8d0dc">📌 Как получить ссылку xgrids</div>',
      '<ol style="margin:0;padding-left:18px;font-size:12.5px;line-height:2;color:' + C.txt + '">',
      '<li>Откройте <a href="https://xgrids.com" target="_blank" style="color:#7ea6ff">xgrids.com</a> и войдите в аккаунт Lixel.</li>',
      '<li>Выберите сцену → нажмите <b>«Share» / «Поделиться»</b>.</li>',
      '<li>Скопируйте <b>публичную ссылку</b> (начинается с xgrids.com/s/…).</li>',
      '<li>Вставьте в поле выше и нажмите <b>Открыть</b>.</li>',
      '</ol>',
      '<div style="margin-top:14px;font-size:11.5px;color:' + C.muted + '">',
      'Поддерживаются форматы:<br>',
      '<code style="background:' + C.card + ';padding:1px 5px;border-radius:3px">https://xgrids.com/s/XXXX</code><br>',
      '<code style="background:' + C.card + ';padding:1px 5px;border-radius:3px">https://xgrids.com/view/XXXX</code><br>',
      '<code style="background:' + C.card + ';padding:1px 5px;border-radius:3px">XXXX</code> (только Scene ID)',
      '</div>',
      '<button id="xgHelpClose" style="margin-top:18px;width:100%;padding:8px;border-radius:7px;border:1px solid ' + C.border + ';background:' + C.card + ';color:' + C.txt + ';cursor:pointer;font-size:12px">Закрыть</button>'
    ].join('');
    body.appendChild(helpModal);
    helpModal.querySelector('#xgHelpClose').onclick = function(){helpModal.style.display='none';};

    /* ── логика кнопок ───────────────────────────────── */
    function doOpen() {
      var raw = urlInp.value.trim();
      if (!raw) { toast('Вставьте ссылку xgrids или Scene ID'); return; }
      var url = normalizeXgridsUrl(raw);
      localStorage.setItem(STORAGE_KEY, raw);
      iframe.src = url;
      iframe.style.display = 'block';
      stub.style.display   = 'none';
    }

    openBtn.onclick = doOpen;
    urlInp.onkeydown = function(e){ if(e.key==='Enter') doOpen(); };

    /* автозагрузка сохранённого URL */
    if (urlInp.value) {
      /* небольшая задержка чтобы overlay успел отобразиться */
      overlay._autoLoad = true;
    }

    fsBtn.onclick = function(){
      var el2 = overlay;
      if (document.fullscreenElement) {
        document.exitFullscreen && document.exitFullscreen();
      } else {
        el2.requestFullscreen && el2.requestFullscreen();
      }
    };

    helpBtn.onclick = function(){
      helpModal.style.display = helpModal.style.display === 'none' ? 'block' : 'none';
    };

    closeBtn2.onclick = hideOverlay;

    document.body.appendChild(overlay);
  }

  function showOverlay() {
    buildOverlay();
    overlay.style.display = 'flex';
    if (overlay._autoLoad) {
      overlay._autoLoad = false;
      setTimeout(function(){
        var inp = overlay.querySelector('input');
        if (inp && inp.value) {
          var iframe = $('xgridsFrame');
          var stub = overlay.querySelector('div[style*="absolute"][style*="flex"]');
          if(iframe){
            iframe.src = normalizeXgridsUrl(inp.value);
            iframe.style.display='block';
          }
          if(stub) stub.style.display='none';
        }
      }, 80);
    }
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
  }

  /* ── Esc ──────────────────────────────────────────────── */
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    if (overlay && overlay.style.display !== 'none') {
      hideOverlay();
      e.stopImmediatePropagation();
    }
  }, true);

  /* ── подключение к кнопке vtXgrids ──────────────────── */
  function wireBtn() {
    var b = $('vtXgrids');
    if (!b || b.dataset.xgWired) return;
    b.dataset.xgWired = '1';
    b.addEventListener('click', function(e) {
      e.stopPropagation();
      if (overlay && overlay.style.display !== 'none') hideOverlay();
      else showOverlay();
    });
  }

  /* ── подключение к кнопке tsSplatTop (добавляем xgrids рядом) */
  function wireTourBtn() {
    var splat = $('tsSplatTop');
    if (!splat || splat.dataset.xgPeer) return;
    splat.dataset.xgPeer = '1';
    /* создаём кнопку xgrids рядом */
    var b = document.createElement('button');
    b.id = 'tsSplatXgrids';
    b.className = splat.className || 'btn';
    b.style.cssText = 'background:#1f47ca;border-color:#4d72e8;color:#fff;margin-left:4px';
    b.title = 'xgrids / Lixel 3D-тур — нативный вьюер Lixel: небо, фото-текстуры, аннотации';
    b.textContent = '🌐 xgrids';
    b.addEventListener('click', function(e){
      e.stopPropagation();
      if (overlay && overlay.style.display !== 'none') hideOverlay();
      else showOverlay();
    });
    splat.parentNode.insertBefore(b, splat.nextSibling);
  }

  /* ── init ─────────────────────────────────────────────── */
  function init() {
    wireBtn();
    wireTourBtn();
    new MutationObserver(function() {
      if ($('vtXgrids') && !$('vtXgrids').dataset.xgWired)    wireBtn();
      if ($('tsSplatTop') && !$('tsSplatTop').dataset.xgPeer) wireTourBtn();
    }).observe(document.body, { childList:true, subtree:true });
  }

  if (document.readyState === 'loading')
    window.addEventListener('DOMContentLoaded', function(){ setTimeout(init, 800); });
  else
    setTimeout(init, 800);

  window.XgridsTour = { show: showOverlay, hide: hideOverlay };

})();
