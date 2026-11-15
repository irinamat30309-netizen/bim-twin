/* short-label.js — короткие подписи кнопок ленты.
   Длинное название команды («Пересечение объектов», «Конвертация и геометрия»)
   сокращается до одного-двух слов, чтобы помещаться под иконкой кнопки.
   UMD: в браузере window.__lxShortLabel, в Node module.exports. */
(function (root) {
  'use strict';

  function normalize(text) {
    return String(text == null ? '' : text)
      .replace(/\([^)]*\)/g, ' ')          // убираем уточнения в скобках
      .replace(/[«»"“”]/g, ' ')
      .replace(/[.,:;!?]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function shortLabel(text, maxLen) {
    var limit = maxLen || 14;
    var s = normalize(text);
    if (!s) return '';
    if (s.length <= limit) return s;
    var words = s.split(' ');
    if (words.length > 1) {
      var acc = '';
      for (var i = 0; i < words.length; i++) {
        var next = acc ? acc + ' ' + words[i] : words[i];
        if (next.length <= limit) acc = next;
        else break;
      }
      if (acc && acc.length >= Math.min(6, limit)) return acc;
      // если первое слово длиннее лимита — режем по словам до лимита
      var short = acc || words[0];
      if (short.length > limit) short = short.slice(0, limit - 1).replace(/[-\s]+$/, '');
      return short;
    }
    return s.slice(0, limit - 1).replace(/[-\s]+$/, '');
  }

  var api = { shortLabel: shortLabel, normalize: normalize };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.__lxShortLabel = shortLabel;
})(typeof window !== 'undefined' ? window : globalThis);
