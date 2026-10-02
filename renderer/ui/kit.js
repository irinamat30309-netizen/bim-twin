/* BIM Twin — UI-kit: иконки, подсказки, всплывающие меню, тосты, индикатор фоновых операций.
 * Загружается до app.js. Глобал: window.__lxKit. */
(function () {
  'use strict';
  var W = window, D = document;
  var $ = function (id) { return D.getElementById(id); };
  var raf = W.requestAnimationFrame ? W.requestAnimationFrame.bind(W) : function (f) { return setTimeout(f, 16); };

  /* ---------- Иконки ---------- */
  function ic(name, size, cls) { return W.__lxIcons ? W.__lxIcons.svg(name, size, cls) : ''; }
  function leadIcons(scope) {
    var list = (scope || D).querySelectorAll ? (scope || D).querySelectorAll('[data-ico-lead]') : [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.querySelector(':scope > .lx-lead')) continue;
      var s = D.createElement('span'); s.className = 'lx-lead'; s.setAttribute('data-ico', el.getAttribute('data-ico-lead')); s.setAttribute('data-ico-size', '15');
      el.insertBefore(s, el.firstChild);
    }
  }
  function hydrate(scope) {
    scope = scope || D;
    leadIcons(scope);
    if (W.__lxIcons) W.__lxIcons.hydrate(scope);
  }
  function watchIcons() {
    if (!W.MutationObserver) return;
    var queue = [], pending = false;
    function flush() {
      pending = false;
      var q = queue; queue = [];
      for (var i = 0; i < q.length; i++) {
        var n = q[i];
        if (!n.isConnected) continue;
        if (n.matches && n.matches('[data-ico-lead]')) leadIcons(n.parentNode || D);
        hydrate(n);
        fadeAll(n);
        if (n.matches && n.matches('[data-ico]')) W.__lxIcons.hydrate(n.parentNode || D);
      }
    }
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var a = muts[i].addedNodes;
        for (var j = 0; j < a.length; j++) {
          var nd = a[j];
          if (nd.nodeType === 1) queue.push(nd);
          // код, который перезаписал textContent у кнопки с иконкой, не должен оставлять её без иконки
          else if (nd.nodeType === 3 && nd.parentNode && nd.parentNode.nodeType === 1 && nd.parentNode.hasAttribute('data-ico')) queue.push(nd.parentNode);
        }
      }
      if (queue.length && !pending) { pending = true; raf(flush); }
    }).observe(D.documentElement, { childList: true, subtree: true });
  }

  /* ---------- Тосты ---------- */
  var EMOJI = /^[\s\u200d\ufe0f]*(?:[\u2600-\u27bf]|[\ud83c-\ud83e][\udc00-\udfff]|\u2b50|\u2b06|\u2b07|\u23f1|\u23f3)[\s\u200d\ufe0f\ud83c-\ud83e\udc00-\udfff\u2600-\u27bf]*/;
  var TONE_BY_EMOJI = [[/^[\s]*(?:\u2705|\u2714|\u2713|\ud83c\udf89)/, 'ok'], [/^[\s]*(?:\u26a0|\ud83d\udea7)/, 'warn'], [/^[\s]*(?:\u274c|\u2716|\ud83d\udeab|\u26d4)/, 'err']];
  var PICTO = /[\u25a0-\u25ff\u2600-\u27bf\u2b00-\u2bff\u200d\ufe0f]|[\ud83c-\ud83e][\udc00-\udfff]/g;
  var TONE_ICO = { ok: 'circle-check', warn: 'triangle-alert', err: 'circle-x', info: 'info' };
  /** Убирает пиктограммы и эмодзи из текста интерфейса: значки рисуем SVG-иконками. */
  function plain(s) { return String(s == null ? '' : s).replace(PICTO, '').replace(/[ \t]{2,}/g, ' ').replace(/^\s+|\s+$/g, ''); }
  function toneOf(raw, explicit) {
    if (explicit) return explicit;
    for (var i = 0; i < TONE_BY_EMOJI.length; i++) if (TONE_BY_EMOJI[i][0].test(raw)) return TONE_BY_EMOJI[i][1];
    if (/^(ошибка|не удалось|не найден|недоступн)/i.test(raw.replace(EMOJI, ''))) return 'err';
    if (/^(готово|сохранено|добавлен|создан|импортировано|скопирован)/i.test(raw.replace(EMOJI, ''))) return 'ok';
    return 'info';
  }
  /* Стек уведомлений: несколько сообщений подряд не теряются, одинаковые склеиваются в «×N», пауза по наведению, закрытие крестиком */
  var toastHost = null;
  function toastMax() { return W.innerHeight < 800 ? 3 : 4; }   // в невысоких окнах стопка не должна дотягиваться до кнопок навигации сцены
  function toastRoot() {
    if (toastHost && toastHost.parentNode) return toastHost;
    toastHost = D.createElement('div'); toastHost.id = 'lxToasts'; toastHost.className = 'lx-toasts';
    toastHost.setAttribute('role', 'region'); toastHost.setAttribute('aria-label', 'Уведомления');
    D.body.appendChild(toastHost); return toastHost;
  }
  function dismissToast(el) {
    if (!el || el._gone) return;
    el._gone = true; clearTimeout(el._t);
    el.style.maxHeight = el.offsetHeight + 'px'; void el.offsetHeight;
    el.classList.add('leaving'); el.style.maxHeight = '0px';
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 280);
  }
  function armToast(el, ms) {
    clearTimeout(el._t); el._left = ms; el._from = Date.now();
    el._t = setTimeout(function () { dismissToast(el); }, ms);
    var bar = el.querySelector('.t-bar');
    if (bar) { bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = ''; bar.style.animationDuration = ms + 'ms'; }
  }
  function toast(msg, opts) {
    opts = opts || {};
    var raw = String(msg == null ? '' : msg);
    var tone = toneOf(raw, opts.tone);
    var text = plain(raw.replace(EMOJI, '')) || raw;
    var root = toastRoot();
    var ms = opts.ms || Math.min(tone === 'err' ? 10000 : 6500, (tone === 'err' ? 5000 : 2400) + text.length * 22);
    for (var i = root.children.length - 1; i >= 0; i--) {
      var k = root.children[i];
      if (!k._gone && k._text === text && k._tone === tone) {
        k._n = (k._n || 1) + 1;
        var cnt = k.querySelector('.t-n'); cnt.textContent = '×' + k._n; cnt.hidden = false;
        k.classList.remove('bump'); void k.offsetWidth; k.classList.add('bump');
        armToast(k, ms); return;
      }
    }
    var el = D.createElement('div');
    el.className = 'lx-toast'; el.setAttribute('data-tone', tone); el.setAttribute('role', tone === 'err' ? 'alert' : 'status');
    el._text = text; el._tone = tone; el._n = 1;
    el.innerHTML = '<span class="t-ico">' + ic(TONE_ICO[tone], 18) + '</span><span class="t-msg"></span><span class="t-n" hidden></span>' +
      '<button type="button" class="t-x" aria-label="Закрыть уведомление">' + ic('x', 14) + '</button><i class="t-bar"></i>';
    el.querySelector('.t-msg').textContent = text;
    el.querySelector('.t-x').addEventListener('click', function () { dismissToast(el); });
    el.addEventListener('mouseenter', function () { if (el._gone) return; clearTimeout(el._t); el._left = Math.max(800, el._left - (Date.now() - el._from)); el.classList.add('paused'); });
    el.addEventListener('mouseleave', function () { if (el._gone) return; el.classList.remove('paused'); el._from = Date.now(); el._t = setTimeout(function () { dismissToast(el); }, el._left); });
    root.appendChild(el);
    var live = []; for (var j = 0; j < root.children.length; j++) if (!root.children[j]._gone) live.push(root.children[j]);
    while (live.length > toastMax()) dismissToast(live.shift());
    armToast(el, ms);
  }

  /* ---------- Подсказки ---------- */
  var tip = null, tipTimer = 0, tipEl = null, lastTipAt = 0;
  function ensureTip() {
    if (tip) return tip;
    tip = D.createElement('div'); tip.className = 'lx-tip'; tip.setAttribute('role', 'tooltip'); tip.id = 'lxTip';
    D.body.appendChild(tip); return tip;
  }
  function tipHost(node) {
    while (node && node.nodeType === 1) {
      if (node.hasAttribute('title') || node.hasAttribute('data-tip')) return node;
      node = node.parentNode;
    }
    return null;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function tipContent(host) {
    if (host.hasAttribute('title')) {
      var t = host.getAttribute('title');
      if (t) host.setAttribute('data-tip', t);
      host.removeAttribute('title');
    }
    var desc = host.getAttribute('data-tip') || '';
    var lbl = host.getAttribute('data-tip-title') || '';
    if (!lbl && host.hasAttribute('data-cmd')) { var l = host.querySelector('.lbl'); lbl = l ? l.textContent.trim() : ''; }
    var keys = host.getAttribute('data-keys') || '';
    var idle = host.getAttribute('data-idle-tip') && host.getAttribute('aria-disabled') === 'true' ? host.getAttribute('data-idle-tip') : '';
    if (!lbl && desc && desc.length <= 42 && !idle) { lbl = desc; desc = ''; }
    if (lbl && desc && lbl === desc) desc = '';
    if (!lbl && !desc && !idle) return '';
    return (lbl ? '<b>' + esc(lbl) + '</b>' : '') + (desc ? '<span>' + esc(desc) + '</span>' : '') + (idle ? '<span class="lx-tip-hint">' + esc(idle) + '</span>' : '') + (keys ? '<kbd>' + esc(keys) + '</kbd>' : '');
  }
  function placeTip(host) {
    var t = tip, r = host.getBoundingClientRect(), vw = W.innerWidth, vh = W.innerHeight;
    t.style.left = '0px'; t.style.top = '0px';
    var w = t.offsetWidth, h = t.offsetHeight, gap = 8;
    var pop = host.closest && host.closest('.lx-pop');
    if (pop) { // описание пункта меню — сбоку от меню, чтобы не закрывать соседние пункты
      var pr = pop.getBoundingClientRect(), lx = pr.right + gap;
      if (lx + w > vw - 8) lx = Math.max(8, pr.left - w - gap);
      t.style.left = Math.round(lx) + 'px'; t.style.top = Math.round(Math.max(8, Math.min(r.top, vh - h - 8))) + 'px';
      return;
    }
    var left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, vw - w - 8));
    var top = r.bottom + gap;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - gap);
    t.style.left = Math.round(left) + 'px'; t.style.top = Math.round(top) + 'px';
  }
  function showTip(host) {
    var html = tipContent(host); if (!html) return;
    ensureTip().innerHTML = html; tipEl = host; placeTip(host);
    tip.classList.add('show'); lastTipAt = Date.now();
    host.setAttribute('aria-describedby', 'lxTip');
  }
  function hideTip() {
    clearTimeout(tipTimer);
    if (tip) tip.classList.remove('show');
    if (tipEl) { tipEl.removeAttribute('aria-describedby'); tipEl = null; }
  }
  function wireTips() {
    D.addEventListener('pointerover', function (e) {
      if (e.pointerType === 'touch') return;
      var host = tipHost(e.target);
      if (!host || host === tipEl) return;
      if (host.closest('#viewer, .lx-palette, .docview-body, .dxf-wrap') || (host.closest('.lx-pop') && !host.matches('.lx-pop-item'))) return;
      hideTip();
      var delay = Date.now() - lastTipAt < 500 ? 60 : 420;
      tipTimer = setTimeout(function () { if (host.isConnected) showTip(host); }, delay);
    }, true);
    D.addEventListener('pointerout', function (e) { var host = tipHost(e.target); if (host && (!e.relatedTarget || !host.contains(e.relatedTarget))) hideTip(); }, true);
    D.addEventListener('focusin', function (e) { var host = tipHost(e.target); if (host && e.target.matches && e.target.matches(':focus-visible')) { hideTip(); showTip(host); } }, true);
    D.addEventListener('focusout', hideTip, true);
    ['pointerdown', 'wheel', 'keydown', 'scroll', 'resize'].forEach(function (n) { W.addEventListener(n, hideTip, true); });
  }

  /* ---------- Всплывающие меню / поповеры ---------- */
  var openPop = null;
  function closePopover(focus) {
    var p = openPop; if (!p) return false;
    openPop = null;
    var el = p.el, done = function () { if (el.parentNode) el.parentNode.removeChild(el); };
    el.style.pointerEvents = 'none'; el.style.transition = 'opacity 90ms ease, transform 90ms ease'; el.style.opacity = '0'; el.style.transform = 'scale(.98)';
    setTimeout(done, 100);
    D.removeEventListener('pointerdown', p.onDown, true); D.removeEventListener('keydown', p.onKey, true); W.removeEventListener('resize', p.onResize);
    if (p.anchor) { p.anchor.setAttribute('aria-expanded', 'false'); if (focus && p.anchor.focus) p.anchor.focus(); }
    if (p.onClose) { try { p.onClose(); } catch (e) {} }
    return true;
  }
  function place(el, anchor, o) {
    var r = anchor.getBoundingClientRect(), vw = W.innerWidth, vh = W.innerHeight, gap = 6;
    el.style.left = '0px'; el.style.top = '0px'; el.style.visibility = 'hidden';
    var w = el.offsetWidth, h = el.offsetHeight;
    var left = o.align === 'end' ? r.right - w : o.align === 'center' ? r.left + r.width / 2 - w / 2 : r.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    var below = vh - r.bottom, top, up = false;
    if (o.placement === 'top' || (below < h + gap + 8 && r.top > below)) { top = r.top - h - gap; up = true; } else top = r.bottom + gap;
    top = Math.max(8, Math.min(top, vh - h - 8));
    el.style.left = Math.round(left) + 'px'; el.style.top = Math.round(top) + 'px';
    el.style.setProperty('--ox', Math.round(r.left + r.width / 2 - left) + 'px'); el.style.setProperty('--oy', up ? '100%' : '0');
    el.style.visibility = '';
  }
  function popover(o) {
    closePopover();
    var el = D.createElement('div'); el.className = 'lx-pop' + (o.className ? ' ' + o.className : ''); if (o.id) el.id = o.id;
    el.setAttribute('role', o.role || 'menu'); if (o.label) el.setAttribute('aria-label', o.label);
    var body = D.createElement('div'); body.className = 'lx-pop-scroll'; el.appendChild(body);
    if (typeof o.content === 'string') body.innerHTML = o.content; else if (o.content) body.appendChild(o.content);
    if (o.minWidth) el.style.minWidth = o.minWidth + 'px';
    D.body.appendChild(el);
    hydrate(el);
    fade(body, 'y');
    place(el, o.anchor, o);
    var p = { el: el, anchor: o.anchor, onClose: o.onClose };
    p.onDown = function (e) { if (el.contains(e.target) || (o.anchor && o.anchor.contains(e.target))) return; closePopover(); };
    p.onKey = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopover(true); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        var items = [].slice.call(el.querySelectorAll('.lx-pop-item:not([disabled])')); if (!items.length) return;
        e.preventDefault(); var i = items.indexOf(D.activeElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      }
    };
    p.onResize = function () { closePopover(); };
    setTimeout(function () { D.addEventListener('pointerdown', p.onDown, true); }, 0);
    D.addEventListener('keydown', p.onKey, true); W.addEventListener('resize', p.onResize);
    if (o.anchor) o.anchor.setAttribute('aria-expanded', 'true');
    openPop = p;
    return { el: el, close: closePopover };
  }
  /** Пункт меню: { label, sub, ico, tip, danger, disabled, onClick }; по клику меню закрывается. */
  function menuItem(it) {
    var b = D.createElement('button'); b.type = 'button'; b.className = 'lx-pop-item' + (it.danger ? ' danger' : ''); b.setAttribute('role', 'menuitem'); if (it.id) b.id = it.id;
    var full = it.tip || (it.sub && plain(it.sub).length > 68 ? plain(it.sub) : '');
    if (full) { b.setAttribute('data-tip', full); b.setAttribute('data-tip-title', plain(it.label)); }
    b.innerHTML = (it.ico ? '<span data-ico="' + it.ico + '"></span>' : '') + '<span class="lx-pop-t">' + esc(plain(it.label)) + (it.sub ? '<small>' + esc(plain(it.sub)) + '</small>' : '') + '</span>';
    if (it.disabled) b.disabled = true;
    b.addEventListener('click', function () { closePopover(); if (it.onClick) it.onClick(); });
    return b;
  }
  function menu(anchor, items, o) {
    o = o || {};
    var box = D.createElement('div');
    if (o.title) { var t = D.createElement('div'); t.className = 'lx-pop-title'; t.textContent = o.title; box.appendChild(t); }
    items.forEach(function (it) {
      if (it.sep) { var s = D.createElement('div'); s.className = 'lx-pop-sep'; box.appendChild(s); return; }
      if (it.head) { var h = D.createElement('div'); h.className = 'lx-pop-title'; h.textContent = it.head; box.appendChild(h); return; }
      box.appendChild(menuItem(it));
    });
    var h = popover({ anchor: anchor, content: box, className: o.className, minWidth: o.minWidth || 240, label: o.title, id: o.id, align: o.align });
    var first = h.el.querySelector('.lx-pop-item'); if (first && o.focus !== false) first.focus({ preventScroll: true });
    return h;
  }

  /** Виртуальный якорь в точке экрана — для контекстных меню по правому клику. */
  function pointAnchor(x, y) {
    return {
      getBoundingClientRect: function () { return { left: x, right: x, top: y, bottom: y, width: 0, height: 0 }; },
      setAttribute: function () {}, removeAttribute: function () {}, contains: function () { return false; }, focus: function () {}
    };
  }

  /* ---------- Диалог вопроса вместо window.prompt / window.confirm (в Electron prompt() не поддерживается) ----------
   * ask({ title, message, hint, input:true, multiline, wide, value, placeholder, type, okLabel, cancelLabel, danger }) → Promise:
   *   с полем ввода: строка или null при отмене; без поля: true / false. Esc и клик по фону — отмена, Enter — подтверждение
   *   (в многострочном поле — Ctrl+Enter). */
  var askSeq = 0;
  function ask(o) {
    o = o || {};
    if (o.multiline && !o.input) o = Object.assign({}, o, { input: true });   // многострочный диалог всегда с полем ввода
    return new Promise(function (resolve) {
      var prev = D.activeElement, done = false, tid = 'lxAskT' + (++askSeq);
      var back = D.createElement('div'); back.className = 'modal lx-ask';
      var card = D.createElement('div'); card.className = 'modal-card ' + (o.wide || o.multiline ? 'md' : 'sm');
      card.setAttribute('role', o.input ? 'dialog' : 'alertdialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', tid);
      var head = D.createElement('div'); head.className = 'modal-head';
      head.innerHTML = '<span id="' + tid + '">' + esc(o.title || (o.input ? 'Введите значение' : 'Подтвердите действие')) + '</span><button type="button" class="x" data-ico="x" aria-label="Закрыть"></button>';
      var body = D.createElement('div'); body.className = 'form-body lx-ask-body';
      if (o.message) { var m = D.createElement('p'); m.className = 'lx-ask-msg'; m.textContent = o.message; body.appendChild(m); }
      var inp = null;
      if (o.input) {
        if (o.multiline) { inp = D.createElement('textarea'); inp.rows = o.rows || 7; inp.value = o.value == null ? '' : String(o.value); }
        else { inp = D.createElement('input'); inp.type = o.type || 'text'; inp.value = o.value == null ? '' : String(o.value); }
        if (o.placeholder) inp.placeholder = o.placeholder;
        if (o.step) inp.step = o.step; if (o.min != null) inp.min = o.min; if (o.max != null) inp.max = o.max;
        inp.setAttribute('aria-label', o.label || o.message || o.title || 'Значение'); inp.autocomplete = 'off'; inp.spellcheck = false;
        body.appendChild(inp);
      }
      var errEl = null;
      if (inp && typeof o.validate === 'function') {
        errEl = D.createElement('p'); errEl.className = 'lx-ask-err'; errEl.setAttribute('role', 'alert'); errEl.hidden = true; body.appendChild(errEl);
        inp.addEventListener('input', function () { if (errEl.hidden) return; errEl.hidden = true; inp.classList.remove('invalid'); inp.removeAttribute('aria-invalid'); });
      }
      if (o.hint) { var hn = D.createElement('p'); hn.className = 'lx-ask-hint'; hn.textContent = o.hint; body.appendChild(hn); }
      var act = D.createElement('div'); act.className = 'form-actions';
      var cancel = D.createElement('button'); cancel.type = 'button'; cancel.className = 'btn sm'; cancel.textContent = o.cancelLabel || 'Отмена';
      var ok = D.createElement('button'); ok.type = 'button'; ok.className = 'btn sm ' + (o.danger ? 'danger' : 'primary'); ok.textContent = o.okLabel || 'OK';
      if (o.multiline) { var keys = D.createElement('span'); keys.className = 'lx-ask-keys'; keys.innerHTML = '<kbd>Ctrl</kbd> + <kbd>Enter</kbd> — применить'; act.appendChild(keys); }
      act.appendChild(cancel); act.appendChild(ok);
      card.appendChild(head); card.appendChild(body); card.appendChild(act); back.appendChild(card);
      function finish(v) {
        if (done) return; done = true;
        D.removeEventListener('keydown', onKey, true);
        back.classList.add('closing'); setTimeout(function () { if (back.parentNode) back.parentNode.removeChild(back); }, 140);
        if (prev && prev.focus) { try { prev.focus({ preventScroll: true }); } catch (e) {} }
        resolve(v);
      }
      function no() { finish(o.input ? null : false); }
      function yes() {
        if (errEl) {
          var bad = o.validate(inp.value);
          if (bad) { errEl.textContent = String(bad); errEl.hidden = false; inp.classList.add('invalid'); inp.setAttribute('aria-invalid', 'true'); try { inp.focus(); } catch (e) {} return; }
        }
        finish(o.input ? inp.value : true);
      }
      function onKey(e) {
        if (!back.parentNode) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); no(); return; }
        if (e.key === 'Enter' && (e.target === inp || e.target === ok || e.target === card || e.target === D.body)) {
          if (inp && inp.tagName === 'TEXTAREA' && e.target === inp && !(e.ctrlKey || e.metaKey)) return;
          e.preventDefault(); e.stopPropagation(); yes(); return;
        }
        if (e.key === 'Tab') {
          var f = [].slice.call(card.querySelectorAll('input,textarea,button:not([disabled])')), i = f.indexOf(D.activeElement);
          if (!f.length) return;
          e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
        }
      }
      head.querySelector('.x').onclick = no; cancel.onclick = no; ok.onclick = yes;
      back.addEventListener('mousedown', function (e) { if (e.target === back) no(); });
      D.addEventListener('keydown', onKey, true);
      D.body.appendChild(back); hydrate(back); back.classList.add('open');
      setTimeout(function () { var t = inp || ok; try { t.focus({ preventScroll: true }); if (inp) inp.select(); } catch (e) {} }, 30);
    });
  }

  /* ---------- Диалог с несколькими полями (параметры операций над облаком) ----------
   * form({ title, message, hint, okLabel, cancelLabel, wide, validate(values)→текст ошибки|'' ,
   *        fields:[{ key, label, type:'number'|'select'|'checkbox', value, min, max, step, unit, hint, options:[{value,label}],
   *                  showIf(values)→bool }] }) → Promise: объект значений или null при отмене.
   *   number → Number, select → строка, checkbox → boolean. Esc и клик по фону — отмена, Enter — применить. */
  function form(o) {
    o = o || {};
    var fields = o.fields || [];
    return new Promise(function (resolve) {
      var prev = D.activeElement, done = false, tid = 'lxAskT' + (++askSeq);
      var back = D.createElement('div'); back.className = 'modal lx-ask';
      var card = D.createElement('div'); card.className = 'modal-card ' + (o.wide ? 'md' : 'sm');
      card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', tid);
      var head = D.createElement('div'); head.className = 'modal-head';
      head.innerHTML = '<span id="' + tid + '">' + esc(o.title || 'Параметры') + '</span><button type="button" class="x" data-ico="x" aria-label="Закрыть"></button>';
      var body = D.createElement('div'); body.className = 'form-body lx-ask-body lx-form-body';
      if (o.message) { var m = D.createElement('p'); m.className = 'lx-ask-msg'; m.textContent = o.message; body.appendChild(m); }
      var ctls = {}, rows = {}, order = [];
      fields.forEach(function (f, idx) {
        var row = D.createElement('div'); row.className = 'lx-form-row' + (f.type === 'checkbox' ? ' chk' : '');
        var id = tid + 'f' + idx, ctl;
        if (f.type === 'select') {
          ctl = D.createElement('select');
          (f.options || []).forEach(function (op) { var e = D.createElement('option'); e.value = String(op.value); e.textContent = op.label; ctl.appendChild(e); });
          ctl.value = String(f.value);
        } else if (f.type === 'checkbox') {
          ctl = D.createElement('input'); ctl.type = 'checkbox'; ctl.checked = !!f.value;
        } else {
          ctl = D.createElement('input'); ctl.type = 'number'; ctl.value = f.value == null ? '' : String(f.value); ctl.autocomplete = 'off';
          if (f.step) ctl.step = f.step; if (f.min != null) ctl.min = f.min; if (f.max != null) ctl.max = f.max;
        }
        ctl.id = id;
        var lab = D.createElement('label'); lab.className = 'lx-form-lbl'; lab.setAttribute('for', id); lab.textContent = f.label;
        var wrap = D.createElement('span'); wrap.className = 'lx-form-ctl'; wrap.appendChild(ctl);
        if (f.unit) { var u = D.createElement('span'); u.className = 'lx-form-unit'; u.textContent = f.unit; wrap.appendChild(u); }
        if (f.type === 'checkbox') { row.appendChild(wrap); row.appendChild(lab); } else { row.appendChild(lab); row.appendChild(wrap); }
        if (f.hint) { var hn = D.createElement('p'); hn.className = 'lx-ask-hint lx-form-hint'; hn.textContent = f.hint; row.appendChild(hn); }
        body.appendChild(row); ctls[f.key] = ctl; rows[f.key] = row; order.push(f);
        ctl.addEventListener('input', refresh); ctl.addEventListener('change', refresh);
      });
      if (o.hint) { var oh = D.createElement('p'); oh.className = 'lx-ask-hint'; oh.textContent = o.hint; body.appendChild(oh); }
      var errEl = D.createElement('p'); errEl.className = 'lx-ask-err'; errEl.setAttribute('role', 'alert'); errEl.hidden = true; body.appendChild(errEl);
      var act = D.createElement('div'); act.className = 'form-actions';
      var cancel = D.createElement('button'); cancel.type = 'button'; cancel.className = 'btn sm'; cancel.textContent = o.cancelLabel || 'Отмена';
      var ok = D.createElement('button'); ok.type = 'button'; ok.className = 'btn sm primary'; ok.textContent = o.okLabel || 'Применить';
      act.appendChild(cancel); act.appendChild(ok);
      card.appendChild(head); card.appendChild(body); card.appendChild(act); back.appendChild(card);
      function read() {
        var v = {};
        order.forEach(function (f) {
          var c = ctls[f.key];
          if (f.type === 'checkbox') v[f.key] = !!c.checked;
          else if (f.type === 'select') v[f.key] = c.value;
          else v[f.key] = c.value === '' ? NaN : Number(String(c.value).replace(',', '.'));
        });
        return v;
      }
      function refresh() {
        var v = read();
        order.forEach(function (f) { if (typeof f.showIf === 'function') rows[f.key].hidden = !f.showIf(v); });
        if (!errEl.hidden) { errEl.hidden = true; D.querySelectorAll('.lx-form-body input.invalid').forEach(function (e) { e.classList.remove('invalid'); e.removeAttribute('aria-invalid'); }); }
      }
      function fail(text, ctl) {
        errEl.textContent = String(text); errEl.hidden = false;
        if (ctl) { ctl.classList.add('invalid'); ctl.setAttribute('aria-invalid', 'true'); try { ctl.focus(); } catch (e) {} }
      }
      function finish(v) {
        if (done) return; done = true;
        D.removeEventListener('keydown', onKey, true);
        back.classList.add('closing'); setTimeout(function () { if (back.parentNode) back.parentNode.removeChild(back); }, 140);
        if (prev && prev.focus) { try { prev.focus({ preventScroll: true }); } catch (e) {} }
        resolve(v);
      }
      function no() { finish(null); }
      function yes() {
        var v = read();
        for (var i = 0; i < order.length; i++) {
          var f = order[i];
          if (f.type !== 'number' || rows[f.key].hidden) continue;
          var x = v[f.key];
          if (!isFinite(x) || (f.min != null && x < Number(f.min)) || (f.max != null && x > Number(f.max))) {
            var range = f.min != null && f.max != null ? ' от ' + f.min + ' до ' + f.max : (f.min != null ? ' не меньше ' + f.min : (f.max != null ? ' не больше ' + f.max : ''));
            fail('Поле «' + f.label + '»: введите число' + range, ctls[f.key]); return;
          }
        }
        if (typeof o.validate === 'function') { var bad = o.validate(v); if (bad) { fail(bad, null); return; } }
        order.forEach(function (f) { if (rows[f.key].hidden) delete v[f.key]; });
        finish(v);
      }
      function onKey(e) {
        if (!back.parentNode) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); no(); return; }
        if (e.key === 'Enter' && e.target !== cancel && e.target.tagName !== 'SELECT') { e.preventDefault(); e.stopPropagation(); yes(); return; }
        if (e.key === 'Tab') {
          var f = [].slice.call(card.querySelectorAll('input,select,button:not([disabled])')).filter(function (x) { return !x.closest('[hidden]'); }), i = f.indexOf(D.activeElement);
          if (!f.length) return;
          e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
        }
      }
      head.querySelector('.x').onclick = no; cancel.onclick = no; ok.onclick = yes;
      back.addEventListener('mousedown', function (e) { if (e.target === back) no(); });
      D.addEventListener('keydown', onKey, true);
      refresh();
      D.body.appendChild(back); hydrate(back); back.classList.add('open');
      setTimeout(function () { var first = order.length ? ctls[order[0].key] : ok; try { first.focus({ preventScroll: true }); if (first.select && first.type === 'number') first.select(); } catch (e) {} }, 30);
    });
  }

  /* ---------- Индикатор фоновых операций (тонкая полоса сверху) ---------- */
  var acts = [], actSeq = 0;
  function paintActivity() {
    var bar = $('lxTopProgress'); if (!bar) return;
    if (!acts.length) { bar.classList.remove('indeterminate'); bar.firstElementChild.style.width = '100%'; setTimeout(function () { if (!acts.length) { bar.hidden = true; bar.firstElementChild.style.width = '0'; } }, 260); return; }
    bar.hidden = false;
    var last = acts[acts.length - 1];
    if (last.frac == null) { bar.classList.add('indeterminate'); bar.firstElementChild.style.width = ''; }
    else { bar.classList.remove('indeterminate'); bar.firstElementChild.style.width = Math.round(last.frac * 100) + '%'; }
    bar.setAttribute('aria-valuenow', last.frac == null ? '' : String(Math.round(last.frac * 100)));
    bar.setAttribute('aria-label', last.label || 'Фоновая операция');
  }
  function activity(label) {
    var a = { id: ++actSeq, label: label || '', frac: null };
    acts.push(a); paintActivity();
    var h = {
      set: function (f, text) { if (f != null) a.frac = Math.max(0, Math.min(1, +f || 0)); if (text) a.label = text; paintActivity(); W.dispatchEvent(new CustomEvent('lx-activity', { detail: { label: a.label, frac: a.frac, count: acts.length } })); },
      done: function () { var i = acts.indexOf(a); if (i > -1) acts.splice(i, 1); paintActivity(); W.dispatchEvent(new CustomEvent('lx-activity', { detail: { label: '', frac: null, count: acts.length } })); }
    };
    W.dispatchEvent(new CustomEvent('lx-activity', { detail: { label: a.label, frac: null, count: acts.length } }));
    return h;
  }

  /* Кнопка «занято»: класс .busy + блокировка */
  function busy(btn, on) { if (!btn) return; btn.classList.toggle('busy', !!on); if (on) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy'); }

  /* ---------- Ползунки: доля заливки трека (--f) ---------- */
  function paintRange(el) {
    var mn = parseFloat(el.min), mx = parseFloat(el.max), v = parseFloat(el.value);
    if (isNaN(mn)) mn = 0; if (isNaN(mx)) mx = 100; if (isNaN(v)) v = mn;
    el.style.setProperty('--f', String(mx > mn ? Math.max(0, Math.min(1, (v - mn) / (mx - mn))) : 0));
  }
  function initRanges() {
    var proto = W.HTMLInputElement && W.HTMLInputElement.prototype, d = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    // программная запись value (app.js выставляет ползунки сам) тоже перекрашивает трек
    if (d && d.set && d.configurable) {
      try {
        Object.defineProperty(proto, 'value', { configurable: true, enumerable: d.enumerable, get: function () { return d.get.call(this); },
          set: function (v) { d.set.call(this, v); if (this.type === 'range') paintRange(this); } });
      } catch (e) {}
    }
    var onEvt = function (e) { var t = e.target; if (t && t.type === 'range') paintRange(t); };
    D.addEventListener('input', onEvt, true); D.addEventListener('change', onEvt, true);
    var all = function (scope) { var l = scope.querySelectorAll ? scope.querySelectorAll('input[type="range"]') : []; for (var i = 0; i < l.length; i++) paintRange(l[i]); if (scope.matches && scope.matches('input[type="range"]')) paintRange(scope); };
    all(D);
    if (W.MutationObserver) new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'attributes') { if (m.target.type === 'range') paintRange(m.target); continue; }
        for (var j = 0; j < m.addedNodes.length; j++) if (m.addedNodes[j].nodeType === 1) all(m.addedNodes[j]);
      }
    }).observe(D.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['min', 'max', 'value'] });
  }

  /* ---------- Затухание края у прокручиваемых областей ---------- */
  function fade(el, axis) {
    if (!el || el.__lxFade) return el;
    el.__lxFade = 1;
    var y = axis !== 'x', attr = y ? 'data-fade-y' : 'data-fade-x';
    function upd() {
      var pos = y ? el.scrollTop : el.scrollLeft, size = y ? el.clientHeight : el.clientWidth, full = y ? el.scrollHeight : el.scrollWidth;
      var s = pos > 2, e = full - size - pos > 2, v = s && e ? 'both' : e ? 'end' : s ? 'start' : '';
      if (v) { if (el.getAttribute(attr) !== v) el.setAttribute(attr, v); } else if (el.hasAttribute(attr)) el.removeAttribute(attr);
    }
    el.addEventListener('scroll', upd, { passive: true });
    if (W.ResizeObserver) new ResizeObserver(upd).observe(el);
    if (W.MutationObserver) new MutationObserver(function () { raf(upd); }).observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    raf(upd);
    return el;
  }
  var FADE_SEL = [['.stage-side', 'y'], ['.stage-side .fpanel-body', 'y'], ['.elbar', 'x'], ['.tree', 'y'], ['.insp-pane', 'y'], ['.tabbody', 'y'], ['.form-body', 'y'],
    ['.lx-win-sec.grow', 'y'], ['.lx-palette-list', 'y'], ['.lx-edit-list', 'y'], ['.sv-panel', 'y'], ['[data-fade]', '']];
  function fadeAll(scope) {
    if (!scope || !scope.querySelectorAll) return;
    for (var k = 0; k < FADE_SEL.length; k++) {
      var q = FADE_SEL[k][0], l = scope.querySelectorAll(q), i;
      for (i = 0; i < l.length; i++) fade(l[i], FADE_SEL[k][1] || l[i].getAttribute('data-fade'));
      if (scope.matches && scope.matches(q)) fade(scope, FADE_SEL[k][1] || scope.getAttribute('data-fade'));
    }
  }

  function init() {
    hydrate(D);
    watchIcons();
    wireTips();
    initRanges();
    fadeAll(D);
  }
  W.__lxKit = { ic: ic, hydrate: hydrate, fade: fade, toast: toast, popover: popover, menu: menu, menuItem: menuItem, pointAnchor: pointAnchor, ask: ask, form: form, plain: plain, closePopover: closePopover, activity: activity, busy: busy, hideTip: hideTip, esc: esc,
    get popoverOpen() { return !!openPop; } };
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', init); else init();
})();
