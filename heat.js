/* GTA6Heat — tiny dependency-free heatmap renderer for the offline Leonida map.
 *
 * A deliberately small re-implementation of the heatmap.js idea (no upstream
 * code copied, ~200 lines):
 *
 *   1. for every enabled layer, stamp a cached radial-gradient sprite once per
 *      point that falls inside the current viewport (positions come from
 *      map.latLngToContainerPoint, radius scales with zoom);
 *   2. treat the accumulated grayscale alpha as the heat value and colourise it
 *      through a 256-entry lookup table built from the layer's style.color
 *      stops;
 *   3. composite the colourised layer onto the visible canvas with
 *      globalCompositeOperation = 'lighter' and globalAlpha = style.opacity, so
 *      several layers add up;
 *   4. redraw only on moveend / zoomend / resize, and only for layers whose
 *      points are actually on screen.
 *
 * Everything is local: no images, no network, no workers.
 */
window.GTA6Heat = (function () {
  'use strict';

  var MAX_POINTS_PER_LAYER = 40000;   // deterministic subsample above this
  var WORK_SCALE = 0.72;              // colourise at reduced res, upscale on draw
  var MIN_RADIUS = 6;

  /* ------------------------------------------------------- colour helpers */
  var colorCache = Object.create(null);
  var probe = null;

  function cssColorToRgba(css) {
    var key = String(css);
    if (colorCache[key]) return colorCache[key];
    if (!probe) {
      probe = document.createElement('canvas');
      probe.width = probe.height = 1;
    }
    var ctx = probe.getContext('2d');
    var out = { r: 0, g: 0, b: 0, a: 0 };
    try {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = key;                     // invalid values keep '#000'
      ctx.fillRect(0, 0, 1, 1);
      var d = ctx.getImageData(0, 0, 1, 1).data;
      // compare against a known colour to detect "fillStyle was rejected"
      out = { r: d[0], g: d[1], b: d[2], a: d[3] };
    } catch (e) {
      out = { r: 255, g: 0, b: 0, a: 255 };
    }
    colorCache[key] = out;
    return out;
  }

  /* Build a 256-entry RGBA lookup table from [[stop, cssColor], ...]. */
  function buildLut(stops) {
    var pts = [];
    for (var i = 0; i < (stops || []).length; i++) {
      var s = stops[i];
      if (!s || s.length < 2) continue;
      var t = Number(s[0]);
      if (!isFinite(t)) continue;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      var c = cssColorToRgba(s[1]);
      pts.push({ t: t, r: c.r, g: c.g, b: c.b, a: c.a });
    }
    if (!pts.length) pts = [{ t: 0, r: 0, g: 0, b: 255, a: 0 }, { t: 1, r: 255, g: 0, b: 0, a: 255 }];
    pts.sort(function (x, y) { return x.t - y.t; });
    // make sure the ramp covers both ends
    if (pts[0].t > 0) pts.unshift({ t: 0, r: pts[0].r, g: pts[0].g, b: pts[0].b, a: 0 });
    if (pts[pts.length - 1].t < 1) {
      var last = pts[pts.length - 1];
      pts.push({ t: 1, r: last.r, g: last.g, b: last.b, a: last.a });
    }

    var lut = new Uint8ClampedArray(256 * 4);
    var k = 0;
    for (var v = 0; v < 256; v++) {
      var tt = v / 255;
      while (k < pts.length - 2 && tt > pts[k + 1].t) k++;
      var a = pts[k], b = pts[k + 1];
      var span = b.t - a.t;
      var f = span > 0 ? (tt - a.t) / span : 0;
      f = f < 0 ? 0 : f > 1 ? 1 : f;
      var off = v * 4;
      lut[off] = a.r + (b.r - a.r) * f;
      lut[off + 1] = a.g + (b.g - a.g) * f;
      lut[off + 2] = a.b + (b.b - a.b) * f;
      lut[off + 3] = (a.a + (b.a - a.a) * f) * (v / 255);
    }
    return lut;
  }

  /* ------------------------------------------------------------- stamps */
  var stamps = Object.create(null);
  function stampFor(radius) {
    var r = Math.max(MIN_RADIUS, Math.round(radius));
    if (stamps[r]) return stamps[r];
    var size = r * 2;
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.35, 'rgba(0,0,0,0.78)');
    grad.addColorStop(0.65, 'rgba(0,0,0,0.32)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    stamps[r] = c;
    return c;
  }

  function zoomRadiusScale(zoom) {
    // radius is authored for the mid zooms; grow slowly when zooming in
    var s = Math.pow(2, (zoom - 12) * 0.18);
    return s < 0.55 ? 0.55 : s > 2.4 ? 2.4 : s;
  }

  /* ---------------------------------------------------------- the layer */
  function Heat(map, opts) {
    opts = opts || {};
    this.map = map;
    this.paneName = opts.pane || 'heat';
    this.layers = [];
    this._raf = 0;
    this._dirty = true;
    this._ms = 0;
    this._stats = { layers: 0, points: 0, drawn: 0, budgeted: 0, ms: 0 };
    this._setup();
  }

  Heat.prototype._setup = function () {
    var self = this;
    if (!this.map.getPane(this.paneName)) {
      var pane = this.map.createPane(this.paneName);
      pane.style.zIndex = 300;                 // tilePane 200 < heat < overlayPane 400
    }
    var paneEl = this.map.getPane(this.paneName);
    paneEl.style.pointerEvents = 'none';        // never eat touch pans
    var c = document.createElement('canvas');
    c.className = 'heat-canvas';
    c.setAttribute('aria-hidden', 'true');
    paneEl.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext('2d');

    this.work = document.createElement('canvas');
    this.wctx = this.work.getContext('2d');

    // the visible canvas is glued to the map while panning; the pixels are
    // refreshed once the gesture ends (moveend/zoomend)
    this.map.on('move', function () { self._place(); });
    this.map.on('moveend zoomend viewreset resize', function () { self.invalidate(); });
    this._place();
  };

  Heat.prototype._place = function () {
    if (!this.canvas) return;
    var size = this.map.getSize();
    if (this.canvas.style.width !== size.x + 'px') {
      this.canvas.style.width = size.x + 'px';
      this.canvas.style.height = size.y + 'px';
    }
    if (window.L && L.DomUtil) L.DomUtil.setPosition(this.canvas, this.map.containerPointToLayerPoint([0, 0]));
  };

  Heat.prototype.setLayers = function (list) {
    this.layers = (list || []).map(function (l) {
      var pts = l.points || [];
      var b = l.bounds;
      if (!b && pts.length) {
        var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        for (var i = 0; i < pts.length; i++) {
          var p = pts[i];
          if (p[0] < minLat) minLat = p[0];
          if (p[0] > maxLat) maxLat = p[0];
          if (p[1] < minLng) minLng = p[1];
          if (p[1] > maxLng) maxLng = p[1];
        }
        b = [minLat, minLng, maxLat, maxLng];
      }
      return {
        id: l.id,
        points: pts,
        style: l.style || {},
        lut: buildLut((l.style || {}).color),
        bounds: b
      };
    });
    this.invalidate();
  };

  Heat.prototype.schedule = function () {
    if (this._raf) return;
    if (!this._dirty) return;
    var self = this;
    this._raf = requestAnimationFrame(function () { self._raf = 0; self.redraw(); });
  };

  /* Any change that invalidates the current pixels (layers, view, panel). */
  Heat.prototype.invalidate = function () {
    this._dirty = true;
    if (!this.layers.length) { this.clear(); this._dirty = false; return; }
    this.schedule();
  };

  Heat.prototype.clear = function () {
    if (!this.canvas) return;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._stats = { layers: 0, points: 0, drawn: 0, budgeted: 0, ms: 0 };
  };

  Heat.prototype.redraw = function () {
    if (!this.canvas) return;
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    var map = this.map, size = map.getSize();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.round(size.x * dpr), h = Math.round(size.y * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this._place();
    var ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!this.layers.length) {
      this._stats = { layers: 0, points: 0, drawn: 0, budgeted: 0, ms: 0 };
      this._dirty = false;
      return;
    }

    var q = WORK_SCALE * Math.min(dpr, 1.6);
    var ww = Math.max(1, Math.round(size.x * q));
    var wh = Math.max(1, Math.round(size.y * q));
    if (this.work.width !== ww || this.work.height !== wh) {
      this.work.width = ww;
      this.work.height = wh;
    }
    var wctx = this.wctx;

    var zoom = map.getZoom();
    var rScale = zoomRadiusScale(zoom);
    var view = map.getBounds().pad(0.08);
    var sMin = view.getSouth(), sMax = view.getNorth();
    var wMin = view.getWest(), wMax = view.getEast();

    var stats = { layers: this.layers.length, points: 0, drawn: 0, budgeted: 0, ms: 0 };

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'lighter';

    for (var li = 0; li < this.layers.length; li++) {
      var layer = this.layers[li];
      var pts = layer.points;
      if (!pts.length) continue;
      stats.points += pts.length;

      // pass 1 — cheap bounds test, count what is on screen
      var visible = 0;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        if (p[0] < sMin || p[0] > sMax || p[1] < wMin || p[1] > wMax) continue;
        visible++;
      }
      if (!visible) continue;

      var budget = Math.min(visible, MAX_POINTS_PER_LAYER);
      var stride = visible / budget;
      if (budget < visible) stats.budgeted += visible - budget;

      wctx.setTransform(1, 0, 0, 1, 0, 0);
      wctx.globalCompositeOperation = 'source-over';
      wctx.clearRect(0, 0, ww, wh);

      var style = layer.style || {};
      var radius = Math.max(MIN_RADIUS, (Number(style.radius) || 30) * rScale * q);
      var stamp = stampFor(radius);
      var half = stamp.width / 2;
      var weight = Number(style.weight);
      if (!isFinite(weight) || weight <= 0) weight = 1;
      if (weight > 1) weight = 1;
      var intensity = Number(style.intensity);
      if (!isFinite(intensity) || intensity <= 0) intensity = 1;
      wctx.globalAlpha = Math.min(1, weight * intensity);

      var seen = 0, acc = 0;
      var bx0 = ww, by0 = wh, bx1 = -1, by1 = -1;
      for (var j = 0; j < pts.length; j++) {
        var pt = pts[j];
        if (pt[0] < sMin || pt[0] > sMax || pt[1] < wMin || pt[1] > wMax) continue;
        acc += 1;
        if (stride > 1) {
          if (acc < seen + stride) continue;
          seen = acc;
        }
        var cp = map.latLngToContainerPoint([pt[0], pt[1]]);
        var x = cp.x * q, y = cp.y * q;
        if (x < -half || y < -half || x > ww + half || y > wh + half) continue;
        wctx.drawImage(stamp, x - half, y - half);
        if (x - half < bx0) bx0 = x - half;
        if (y - half < by0) by0 = y - half;
        if (x + half > bx1) bx1 = x + half;
        if (y + half > by1) by1 = y + half;
        stats.drawn++;
      }
      wctx.globalAlpha = 1;
      if (bx1 < 0) continue;

      // colourise only the touched rectangle: the full-canvas pass was the
      // dominant cost when many layers are enabled
      var rx = Math.max(0, Math.floor(bx0) - 1);
      var ry = Math.max(0, Math.floor(by0) - 1);
      var rw = Math.min(ww - rx, Math.ceil(bx1 - bx0) + 2);
      var rh = Math.min(wh - ry, Math.ceil(by1 - by0) + 2);
      if (rw <= 0 || rh <= 0) continue;
      var img;
      try {
        img = wctx.getImageData(rx, ry, rw, rh);
      } catch (e) {
        continue;
      }
      var data = img.data, lut = layer.lut;
      for (var k = 0; k < data.length; k += 4) {
        var a = data[k + 3];
        if (!a) continue;
        var off = a * 4;
        data[k] = lut[off];
        data[k + 1] = lut[off + 1];
        data[k + 2] = lut[off + 2];
        data[k + 3] = lut[off + 3];
      }
      wctx.putImageData(img, rx, ry);

      var opacity = Number(style.opacity);
      if (!isFinite(opacity) || opacity <= 0) opacity = 0.85;
      ctx.globalAlpha = Math.min(1, opacity);
      ctx.drawImage(this.work, rx, ry, rw, rh, rx / q, ry / q, rw / q, rh / q);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    stats.ms = Math.round(((window.performance && performance.now) ? performance.now() : Date.now()) - t0);
    this._stats = stats;
    this._ms = stats.ms;
    this._dirty = false;
  };

  /* Diagnostics for the verification harness: sample the visible canvas. */
  Heat.prototype.sample = function (step) {
    if (!this.canvas) return { nonEmpty: 0, maxAlpha: 0 };
    step = step || 8;
    var ctx = this.ctx;
    var w = this.canvas.width, h = this.canvas.height;
    if (!w || !h) return { nonEmpty: 0, maxAlpha: 0 };
    var img;
    try { img = ctx.getImageData(0, 0, w, h); } catch (e) { return { nonEmpty: 0, maxAlpha: 0, error: String(e) }; }
    var d = img.data, n = 0, maxA = 0;
    var rows = Math.ceil(h / step), cols = Math.ceil(w / step);
    for (var y = 0; y < rows; y++) {
      var row = y * step;
      for (var x = 0; x < cols; x++) {
        var i = (row * w + x * step) * 4;
        var a = d[i + 3];
        if (a > 0) n++;
        if (a > maxA) maxA = a;
      }
    }
    return { nonEmpty: n, maxAlpha: maxA, pixels: w * h };
  };

  Heat.prototype.stats = function () {
    var s = {};
    for (var k in this._stats) s[k] = this._stats[k];
    return s;
  };

  return {
    create: function (map, opts) { return new Heat(map, opts); },
    _buildLut: buildLut,             // exported for the harness only
    MAX_POINTS_PER_LAYER: MAX_POINTS_PER_LAYER
  };
})();
