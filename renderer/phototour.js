/*
 * phototour.js — ЛОКАЛЬНЫЙ офлайн фото-тур (аналог CoCloud RealView, но без интернета).
 *
 * Идея: сканер CHCNAV RS10 снимает в каждой станции сферическую (равнопрямоугольную,
 * equirectangular) 360x180 панораму HD-камерами. Этот модуль показывает такие панно
 * как «фото-пузырь»: стоишь в точке съёмки, крутишь мышью, переходишь по стрелкам на
 * соседние станции. Полностью офлайн: панорамы берутся с диска (file picker → objectURL)
 * или генерируются для демо.
 *
 * Изолирован от вьютера облака: свой <canvas> и свой WebGL-контекст поверх сцены,
 * поэтому сбой здесь не ломает основной рендер точек.
 *
 * Данные станции: { id, name, pos:[x,y,z], yaw?, panoUrl? , _img? }
 *   panoUrl — путь/objectURL равнопрямоугольного JPG (ширина = 2*высота).
 *   pos — в координатах облака (для расчёта направлений между станциями).
 *
 * API (window.PhotoTour):
 *   mount(hostEl)      — один раз создать оверлей внутри контейнера сцены (.stage)
 *   load(stations)     — задать станции (панорамы подгружаются лениво при входе)
 *   enter(idOrIndex)   — войти в станцию (показать панораму)
 *   exit()             — выйти (скрыть оверлей)
 *   next()             — перейти к ближайшей станции «вперёд» по взгляду
 *   isOpen()           — открыт ли фото-тур
 *   demo()             — сгенерировать демонстрационный тур из 3 станций (без файлов)
 *   onEnter / onExit   — коллбеки (необязательно)
 */
(function () {
  'use strict';

  var VS = 'attribute vec2 aPos; varying vec2 vUv; void main(){ vUv=aPos*0.5+0.5; gl_Position=vec4(aPos,0.0,1.0); }';
  var FS = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform float uYaw,uPitch,uFov,uAspect;',
    'const float PI=3.14159265358979;',
    'void main(){',
    '  vec2 ndc=vUv*2.0-1.0;',
    '  float t=tan(uFov*0.5);',
    '  vec3 d=normalize(vec3(ndc.x*t*uAspect, ndc.y*t, -1.0));',
    '  float cp=cos(uPitch), sp=sin(uPitch);',
    '  d=vec3(d.x, d.y*cp - d.z*sp, d.y*sp + d.z*cp);',        // pitch (X)
    '  float cy=cos(uYaw), sy=sin(uYaw);',
    '  d=vec3(d.x*cy + d.z*sy, d.y, -d.x*sy + d.z*cy);',      // yaw (Y)
    '  float u=atan(d.x, d.z)/(2.0*PI)+0.5;',
    '  float v=acos(clamp(d.y,-1.0,1.0))/PI;',
    '  gl_FragColor=texture2D(uTex, vec2(u, v));',
    '}'
  ].join('\n');

  function compile(gl, type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
    return s;
  }

  var PT = {
    _mounted: false, _open: false, _stations: [], _cur: -1,
    yaw: 0, pitch: 0, fov: 1.15,
    onEnter: null, onExit: null,

    isOpen: function () { return this._open; },
    getStations: function () { return this._stations; },

    mount: function (host) {
      if (this._mounted) return true;
      host = host || document.querySelector('.stage') || document.body;
      var wrap = document.createElement('div');
      wrap.id = 'panoWrap';
      wrap.style.cssText = 'position:absolute;inset:0;display:none;z-index:40;background:#0b0d10;';
      var cv = document.createElement('canvas');
      cv.id = 'panoCanvas';
      cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;cursor:grab;touch-action:none;';
      wrap.appendChild(cv);
      var hs = document.createElement('div');
      hs.id = 'panoHotspots';
      hs.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
      wrap.appendChild(hs);
      // верхняя плашка + выход
      var bar = document.createElement('div');
      bar.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);display:flex;gap:8px;align-items:center;background:rgba(15,18,22,.82);border:1px solid #2a3038;border-radius:10px;padding:6px 10px;color:#e6e9ee;font:13px system-ui;pointer-events:auto;';
      var label = document.createElement('span'); label.id = 'panoLabel'; label.textContent = 'Фото-тур';
      var bPrev = document.createElement('button'); bPrev.textContent = '‹'; bPrev.title = 'Предыдущая станция';
      var bNext = document.createElement('button'); bNext.textContent = '›'; bNext.title = 'Следующая станция (N)';
      var bExit = document.createElement('button'); bExit.textContent = 'Выйти'; bExit.title = 'Выйти из фото-тура (Esc)';
      [bPrev, bNext, bExit].forEach(function (b) { b.style.cssText = 'background:#1b2129;border:1px solid #2a3038;color:#e6e9ee;border-radius:7px;padding:3px 9px;cursor:pointer;font:13px system-ui;'; });
      bar.appendChild(bPrev); bar.appendChild(label); bar.appendChild(bNext); bar.appendChild(bExit);
      wrap.appendChild(bar);
      host.appendChild(wrap);

      this._wrap = wrap; this._canvas = cv; this._hotspots = hs; this._label = label;
      var self = this;
      bExit.onclick = function () { self.exit(); };
      bNext.onclick = function () { self.next(); };
      bPrev.onclick = function () { self.enter((self._cur - 1 + self._stations.length) % Math.max(1, self._stations.length)); };

      // GL
      var gl = cv.getContext('webgl', { antialias: true, preserveDrawingBuffer: false }) ||
               cv.getContext('experimental-webgl');
      if (!gl) { this._glFail = true; return false; }
      this._gl = gl;
      try {
        var prog = gl.createProgram();
        gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
        this._prog = prog;
        var buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        this._aPos = gl.getAttribLocation(prog, 'aPos');
        this._u = {
          tex: gl.getUniformLocation(prog, 'uTex'),
          yaw: gl.getUniformLocation(prog, 'uYaw'),
          pitch: gl.getUniformLocation(prog, 'uPitch'),
          fov: gl.getUniformLocation(prog, 'uFov'),
          aspect: gl.getUniformLocation(prog, 'uAspect')
        };
        this._tex = gl.createTexture();
      } catch (e) { console.warn('PhotoTour GL init failed', e); this._glFail = true; return false; }

      this._bindInput();
      window.addEventListener('resize', function () { if (self._open) { self._resize(); self._render(); } });
      this._mounted = true;
      return true;
    },

    _bindInput: function () {
      var self = this, cv = this._canvas, drag = false, sx = 0, sy = 0;
      cv.addEventListener('pointerdown', function (e) { drag = true; sx = e.clientX; sy = e.clientY; cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing'; });
      cv.addEventListener('pointermove', function (e) {
        if (!drag) return;
        var dx = e.clientX - sx, dy = e.clientY - sy; sx = e.clientX; sy = e.clientY;
        self.yaw -= dx * 0.005 * (self.fov / 1.15);
        self.pitch += dy * 0.005 * (self.fov / 1.15);
        var lim = Math.PI / 2 - 0.01;
        self.pitch = Math.max(-lim, Math.min(lim, self.pitch));
        self._render();
      });
      var end = function (e) { drag = false; cv.style.cursor = 'grab'; try { cv.releasePointerCapture(e.pointerId); } catch (x) {} };
      cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
      cv.addEventListener('wheel', function (e) {
        e.preventDefault();
        self.fov *= (e.deltaY > 0 ? 1.06 : 0.94);
        self.fov = Math.max(0.45, Math.min(1.9, self.fov));
        self._render();
      }, { passive: false });
      if (!window.__panoKeys) {
        window.__panoKeys = true;
        window.addEventListener('keydown', function (e) {
          if (!self._open) return;
          var k = (e.key || '').toLowerCase();
          if (k === 'escape') { self.exit(); }
          else if (k === 'n' || k === 'т') { self.next(); }
        });
      }
    },

    _resize: function () {
      var cv = this._canvas, dpr = Math.min(2, window.devicePixelRatio || 1);
      var w = cv.clientWidth || cv.offsetWidth || 1280, h = cv.clientHeight || cv.offsetHeight || 720;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      if (this._gl) this._gl.viewport(0, 0, cv.width, cv.height);
    },

    load: function (stations) {
      this._stations = (stations || []).map(function (s, i) {
        return { id: s.id || ('p' + (i + 1)), name: s.name || ('Станция ' + (i + 1)), pos: (s.pos || [0, 0, 0]).slice(), yaw: s.yaw || 0, panoUrl: s.panoUrl || null, _img: s._img || null, _tex: null };
      });
      return this._stations.length;
    },

    _uploadImage: function (img) {
      // приводим к POT-канвасу (для REPEAT по горизонтали и отсутствия шва)
      var W = 4096, H = 2048;
      if (img.width && img.width <= 2048) { W = 2048; H = 1024; }
      var c = document.createElement('canvas'); c.width = W; c.height = H;
      c.getContext('2d').drawImage(img, 0, 0, W, H);
      var gl = this._gl;
      gl.bindTexture(gl.TEXTURE_2D, this._tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    },

    _loadStationImage: function (st) {
      var self = this;
      return new Promise(function (resolve, reject) {
        if (st._img && st._img.width) { self._uploadImage(st._img); resolve(); return; }
        if (!st.panoUrl) { reject(new Error('нет панорамы')); return; }
        var img = new Image();
        img.onload = function () { st._img = img; self._uploadImage(img); resolve(); };
        img.onerror = function () { reject(new Error('не удалось загрузить ' + st.panoUrl)); };
        img.crossOrigin = 'anonymous';
        img.src = st.panoUrl;
      });
    },

    enter: function (idOrIndex) {
      if (this._glFail) { if (window.toast) window.toast('Фото-тур недоступен: нет WebGL'); return Promise.reject(); }
      if (!this._mounted) this.mount();
      var idx = typeof idOrIndex === 'number' ? idOrIndex : this._stations.findIndex(function (s) { return s.id === idOrIndex; });
      if (idx < 0 || idx >= this._stations.length) return Promise.reject(new Error('станция не найдена'));
      var st = this._stations[idx], self = this;
      this._wrap.style.display = 'block';
      this._open = true;
      this._resize();
      this.yaw = st.yaw || 0; this.pitch = 0;
      if (this._label) this._label.textContent = st.name + '  ·  ' + (idx + 1) + '/' + this._stations.length;
      return this._loadStationImage(st).then(function () {
        self._cur = idx;
        self._render();
        if (typeof self.onEnter === 'function') { try { self.onEnter(st); } catch (e) {} }
      }).catch(function (e) {
        if (window.toast) window.toast('Панорама не загрузилась: ' + (e && e.message || e));
      });
    },

    exit: function () {
      if (!this._open) return;
      this._open = false;
      if (this._wrap) this._wrap.style.display = 'none';
      if (typeof this.onExit === 'function') { try { this.onExit(); } catch (e) {} }
    },

    next: function () {
      if (this._cur < 0 || this._stations.length < 2) return;
      var cur = this._stations[this._cur];
      var dir = [Math.sin(this.yaw), 0, Math.cos(this.yaw)]; // направление взгляда (гориз.)
      var pick = null;
      if (window.RealView && window.RealView.pickTeleport) {
        pick = window.RealView.pickTeleport(this._stations, cur.pos, dir, { minStep: 0.2 });
      }
      if (!pick) {
        // ближайшая, кроме текущей
        var best = null, bd = Infinity;
        for (var i = 0; i < this._stations.length; i++) {
          if (i === this._cur) continue;
          var s = this._stations[i], dx = s.pos[0] - cur.pos[0], dy = s.pos[1] - cur.pos[1], dz = s.pos[2] - cur.pos[2];
          var d = dx * dx + dy * dy + dz * dz;
          if (d < bd) { bd = d; best = s; }
        }
        pick = best;
      }
      if (pick) this.enter(pick.id);
    },

    // проекция мировой точки-станции на экран текущей камеры → координаты в px (или null если сзади)
    _project: function (world) {
      var cur = this._stations[this._cur]; if (!cur) return null;
      var dx = world[0] - cur.pos[0], dy = world[1] - cur.pos[1], dz = world[2] - cur.pos[2];
      var len = Math.hypot(dx, dy, dz) || 1; dx /= len; dy /= len; dz /= len;
      var cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      // undo yaw
      var ax = dx * cy - dz * sy, ay = dy, az = dx * sy + dz * cy;
      var cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      // undo pitch
      var bx = ax, by = ay * cp + az * sp, bz = -ay * sp + az * cp;
      if (bz >= -1e-4) return null; // сзади
      var t = Math.tan(this.fov * 0.5);
      var asp = this._canvas.clientWidth / Math.max(1, this._canvas.clientHeight);
      var ndcx = (bx / -bz) / (t * asp), ndcy = (by / -bz) / t;
      if (Math.abs(ndcx) > 1.3 || Math.abs(ndcy) > 1.3) return null;
      var W = this._canvas.clientWidth, H = this._canvas.clientHeight;
      return { x: (ndcx * 0.5 + 0.5) * W, y: (1 - (ndcy * 0.5 + 0.5)) * H, dist: len };
    },

    _renderHotspots: function () {
      var hs = this._hotspots; if (!hs) return;
      hs.innerHTML = '';
      if (this._cur < 0) return;
      var self = this;
      for (var i = 0; i < this._stations.length; i++) {
        if (i === this._cur) continue;
        var st = this._stations[i];
        var p = this._project(st.pos);
        if (!p) continue;
        var el = document.createElement('button');
        el.textContent = '⦿ ' + st.name + '  ' + p.dist.toFixed(1) + ' м';
        el.style.cssText = 'position:absolute;left:' + p.x.toFixed(0) + 'px;top:' + p.y.toFixed(0) + 'px;transform:translate(-50%,-50%);' +
          'pointer-events:auto;background:rgba(20,110,220,.85);border:1px solid #7fb6ff;color:#fff;border-radius:16px;padding:4px 10px;cursor:pointer;font:12px system-ui;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.4);';
        (function (id) { el.onclick = function () { self.enter(id); }; })(st.id);
        hs.appendChild(el);
      }
    },

    _render: function () {
      if (!this._open || !this._gl) return;
      var gl = this._gl;
      gl.useProgram(this._prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.getParameter(gl.ARRAY_BUFFER_BINDING) || null);
      gl.enableVertexAttribArray(this._aPos);
      gl.vertexAttribPointer(this._aPos, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._tex);
      gl.uniform1i(this._u.tex, 0);
      gl.uniform1f(this._u.yaw, this.yaw);
      gl.uniform1f(this._u.pitch, this.pitch);
      gl.uniform1f(this._u.fov, this.fov);
      gl.uniform1f(this._u.aspect, this._canvas.width / Math.max(1, this._canvas.height));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this._renderHotspots();
    },

    // ---- Демо: генерируем 3 равнопрямоугольные панорамы прямо в canvas (без файлов) ----
    _demoPano: function (opts) {
      var W = 2048, H = 1024, c = document.createElement('canvas'); c.width = W; c.height = H;
      var g = c.getContext('2d');
      // потолок / пол
      var sky = g.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, '#2b3446'); sky.addColorStop(0.5, opts.wall || '#6b7280'); sky.addColorStop(1, '#20242b');
      g.fillStyle = sky; g.fillRect(0, 0, W, H);
      // пол (нижняя треть) с сеткой в перспективе
      g.fillStyle = '#3a3f47'; g.fillRect(0, H * 0.68, W, H * 0.32);
      g.strokeStyle = 'rgba(255,255,255,.15)'; g.lineWidth = 1;
      for (var x = 0; x <= W; x += 64) { g.beginPath(); g.moveTo(x, H * 0.68); g.lineTo(x, H); g.stroke(); }
      for (var y = H * 0.68; y <= H; y += 24) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
      // 4 стены по кварталам (С/В/Ю/З) — по горизонтали u = азимут
      var dirs = [['С', '#c0392b'], ['В', '#27ae60'], ['Ю', '#2980b9'], ['З', '#f39c12']];
      g.textAlign = 'center'; g.textBaseline = 'middle';
      for (var i = 0; i < 4; i++) {
        var cx = (i + 0.5) * (W / 4);
        g.fillStyle = dirs[i][1]; g.globalAlpha = 0.22; g.fillRect(i * (W / 4), H * 0.18, W / 4, H * 0.5); g.globalAlpha = 1;
        g.fillStyle = '#eef2f7'; g.font = 'bold 120px system-ui';
        g.fillText(dirs[i][0], cx, H * 0.42);
      }
      // «дверной проём» в сторону следующей станции (яркий прямоугольник)
      if (opts.doorAz != null) {
        var dxpx = ((opts.doorAz / (2 * Math.PI)) + 0.5) * W;
        g.fillStyle = 'rgba(255,240,180,.9)'; g.fillRect(dxpx - 70, H * 0.34, 140, H * 0.34);
        g.fillStyle = '#333'; g.font = 'bold 30px system-ui'; g.fillText('→', dxpx, H * 0.52);
      }
      // подпись станции
      g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(W / 2 - 260, 40, 520, 90);
      g.fillStyle = '#fff'; g.font = 'bold 46px system-ui'; g.fillText(opts.title || 'Демо', W / 2, 86);
      return c;
    },

    demo: function () {
      if (!this._mounted) this.mount();
      if (this._glFail) { if (window.toast) window.toast('Фото-тур недоступен: нет WebGL'); return; }
      var walls = ['#6b7280', '#5b6b5f', '#6b5f6b'];
      var names = ['Вход', 'Коридор', 'Зал'];
      var poses = [[0, 1.6, 0], [4, 1.6, 0], [8, 1.6, 2]];
      var st = [];
      for (var i = 0; i < 3; i++) {
        var next = poses[(i + 1) % 3];
        var az = Math.atan2(next[0] - poses[i][0], next[2] - poses[i][2]);
        var img = this._demoPano({ title: names[i], wall: walls[i], doorAz: az });
        st.push({ id: 'demo' + (i + 1), name: names[i], pos: poses[i], yaw: 0, _img: img });
      }
      this.load(st);
      this.enter(0);
      return st;
    }
  };

  if (typeof window !== 'undefined') window.PhotoTour = PT;
  if (typeof module !== 'undefined' && module.exports) module.exports = PT;
})();
