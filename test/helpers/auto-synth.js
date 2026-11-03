'use strict';
/* Синтетические сцены для проверки auto-measure: плоскости с дырами, цилиндры (полная окружность/дуга), шум, любой наклон осей.
 * Детерминированно (rng с зерном): одна и та же сцена даёт одни и те же точки. Размеры «истины» известны заранее. */
function rng(seed) { var a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r) { var u = Math.max(1e-12, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function norm(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function cr(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function Scene(seed, step, noise) { this.r = rng(seed || 1); this.step = step || 0.008; this.noise = noise == null ? 0.0004 : noise; this.p = []; }
Scene.prototype.plane = function (o, u, v, w, h, opt) {
  opt = opt || {}; var st = (opt.step || this.step), nx = Math.round(w / st), ny = Math.round(h / st), n = cr(u, v);
  for (var i = 0; i < nx; i++) for (var j = 0; j < ny; j++) {
    var x = (i + this.r()) * st, y = (j + this.r()) * st;
    if (opt.hole && opt.hole(x, y)) continue;
    var e = gauss(this.r) * this.noise;
    this.p.push(o[0] + u[0] * x + v[0] * y + n[0] * e, o[1] + u[1] * x + v[1] * y + n[1] * e, o[2] + u[2] * x + v[2] * y + n[2] * e);
  }
};
/* Цилиндр: центр c оси, направление a, радиус r, вдоль оси t∈[t0,t1]; arc0..arc1 — видимая дуга (°); keep(x,y,z) — фильтр видимости. */
Scene.prototype.cyl = function (c, a, r, t0, t1, opt) {
  opt = opt || {}; a = norm(a); var e1 = Math.abs(a[1]) > 0.9 ? norm(cr(a, [1, 0, 0])) : norm(cr(a, [0, 1, 0])), e2 = cr(a, e1), st = opt.step || this.step;
  var a0 = (opt.arc0 == null ? 0 : opt.arc0) * Math.PI / 180, a1 = (opt.arc1 == null ? 360 : opt.arc1) * Math.PI / 180, nt = Math.round((t1 - t0) / st), na = Math.max(8, Math.round(r * (a1 - a0) / st));
  for (var i = 0; i < nt; i++) for (var j = 0; j < na; j++) {
    var t = t0 + (i + this.r()) * st, th = a0 + (j + this.r()) / na * (a1 - a0), rr = r + gauss(this.r) * this.noise;
    var cx = Math.cos(th), sx = Math.sin(th);
    if (opt.keep && !opt.keep(c[0] + a[0] * t + r * (cx * e1[0] + sx * e2[0]), c[1] + a[1] * t + r * (cx * e1[1] + sx * e2[1]), c[2] + a[2] * t + r * (cx * e1[2] + sx * e2[2]))) continue;
    this.p.push(c[0] + a[0] * t + rr * (cx * e1[0] + sx * e2[0]), c[1] + a[1] * t + rr * (cx * e1[1] + sx * e2[1]), c[2] + a[2] * t + rr * (cx * e1[2] + sx * e2[2]));
  }
};
Scene.prototype.f32 = function (shift) { shift = shift || [0, 0, 0]; var o = new Float32Array(this.p.length); for (var i = 0; i < this.p.length; i += 3) { o[i] = this.p[i] + shift[0]; o[i + 1] = this.p[i + 1] + shift[1]; o[i + 2] = this.p[i + 2] + shift[2]; } return o; };

/* Стена z=0 (x∈[−3,3], y∈[0,3]) с проёмом x∈[−w/2,w/2], y∈[0,h]; откосы и перемычка на глубину d, пол y=0. */
function doorScene(opt) {
  opt = opt || {}; var w = opt.w || 1.5, h = opt.h || 2.2, d = opt.d || 0.26, sc = new Scene(opt.seed || 7, opt.step || 0.008, opt.noise == null ? 0.0004 : opt.noise);
  sc.plane([-3, 0, 0], [1, 0, 0], [0, 1, 0], 6, 3, { hole: function (x, y) { return x > 3 - w / 2 && x < 3 + w / 2 && y < h; } });
  if (!opt.noJambs) {
    sc.plane([-w / 2, 0, 0], [0, 1, 0], [0, 0, -1], h, d, { step: 0.0075 });             // откос слева (нормаль +x)
    sc.plane([w / 2, 0, 0], [0, 1, 0], [0, 0, -1], h, d, { step: 0.0075 });              // откос справа
  }
  sc.plane([-w / 2, h, 0], [1, 0, 0], [0, 0, -1], w, d, { step: 0.0075 });                // перемычка
  sc.plane([-3, 0, 3], [1, 0, 0], [0, 0, -1], 6, 3.0, {});                                // пол перед стеной
  sc.plane([-w / 2, 0, 0], [1, 0, 0], [0, 0, -1], w, d, {});                              // порог
  return sc;
}
module.exports = { rng: rng, gauss: gauss, Scene: Scene, doorScene: doorScene, norm: norm, cr: cr };
