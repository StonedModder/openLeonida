/* GTA 6 — Leonida offline interactive map
 * Self-contained: Leaflet (local) + canvas marker layer + local data payloads.
 * No network access at runtime. Progress lives in localStorage only.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------ error guard */
  var errBox = document.getElementById('errBox');
  var errMsg = document.getElementById('errMsg');
  function fail(msg) {
    if (!errBox) return;
    errMsg.textContent = String(msg);
    errBox.hidden = false;
  }
  window.addEventListener('error', function (e) {
    fail((e.message || 'Script error') + (e.filename ? '  @ ' + e.filename + ':' + e.lineno : ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    fail('Unhandled promise rejection: ' + (r && r.message ? r.message : r));
  });

  var META = window.GTA6_META;
  var MARKERS = window.GTA6_MARKERS;
  var TAX = window.GTA6_TAXONOMY;
  var ICONS = window.GTA6_ICONS;
  var IMGS = window.GTA6_IMAGES || { available: false, count: 0 };
  // v2 payloads — every one of them is optional; a missing global just hides
  // the corresponding feature (heatmap extraction runs in the background).
  var REGIONS = window.GTA6_REGIONS || [];
  var HEAT = window.GTA6_HEATMAPS || { index: [], layers: {}, available: 0, declared: 0, pending: 0, totalPoints: 0 };
  if (!HEAT.index) HEAT.index = [];
  if (!HEAT.layers) HEAT.layers = {};

  if (!META || !MARKERS || !TAX || !ICONS || !window.L) {
    // Name exactly what failed: a generic message sends people looking in the wrong
    // place, which is what happened when a partial download dropped a data file.
    var missing = [];
    if (!window.L) missing.push('vendor/leaflet/leaflet.js');
    if (!MARKERS) missing.push('data/markers.js');
    if (!TAX) missing.push('data/taxonomy.js');
    if (!ICONS) missing.push('data/icons.js');
    if (!META) missing.push('data/meta.js');
    var failed = (window.__mapLoadErrors || []).slice();
    var detail = missing.length ? 'Could not load: ' + missing.join(', ') + '.' : '';
    if (failed.length) {
      detail += (detail ? ' ' : '') + 'The browser reported these files as unloadable: ' + failed.join(', ') + '.';
    }
    fail('Map data failed to load. ' + (detail ||
      'A data payload is missing.') +
      (failed.length >= 4 || missing.length >= 4
        ? ' Nothing beside index.html loaded, so this looks like the page was opened from INSIDE the zip, or from a partially extracted folder. Extract the whole archive (right-click > Extract All, or 7-Zip) and open index.html from the extracted folder.'
        : ' Check that the data/ and vendor/ folders sit next to index.html and that the archive was fully extracted.'));
    return;
  }

  var STORE_KEY = 'gta6-leonida-offline-v1';
  var BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  var ATLAS = META.atlas || { width: 1344, height: 1296, pixelRatio: 2, url: 'assets/atlas.png' };
  var TAU = Math.PI * 2;
  var fmt = function (n) { return n.toLocaleString('en-US'); };

  /* ------------------------------------------------------------ data prep */
  var typeInfo = {};
  var groupInfo = {};
  TAX.sections.forEach(function (s) { s.count = 0; });
  TAX.groups.forEach(function (g) {
    g.count = g.count || 0;
    groupInfo[g.slug] = g;
    g.types.forEach(function (t) {
      typeInfo[t.slug] = {
        slug: t.slug, name: t.name, icon: t.icon, count: t.count,
        group: g.slug, groupName: g.name, section: g.section, sectionName: g.sectionName
      };
    });
  });

  var idIndex = Object.create(null);
  MARKERS.forEach(function (m) {
    m._ti = typeInfo[m.t] || { name: 'Unknown', group: '', groupName: 'Other', section: '', sectionName: 'Other', icon: m.i };
    m._g = m._ti.group;
    m._s = m._ti.section;
    m._q = (m.n + ' ' + m._ti.name + ' ' + m._ti.groupName + ' ' + (m.d || '')).toLowerCase();
    idIndex[m.id] = m;
  });

  var SECTIONS = TAX.sections.map(function (s) {
    var groups = TAX.groups.filter(function (g) { return g.section === s.slug; });
    s.groups = groups;
    s.total = groups.reduce(function (a, g) { return a + g.count; }, 0);
    return s;
  });
  TAX.groups.forEach(function (g) {
    g.types.forEach(function (t) { if (ICONS[t.icon]) t._rect = ICONS[t.icon]; });
  });

  var totalMarkers = MARKERS.length;
  var totalTypes = Object.keys(typeInfo).length;

  /* ---------------------------------------------------------------- state */
  var state = {
    found: new Set(),
    hidden: new Set(),       // type slugs that are filtered OUT
    hideFound: false,
    theme: 'day',
    query: '',
    selectedId: null,
    /* --- v2 (all persisted in the same localStorage document) --- */
    notes: Object.create(null),   // markerId -> free text
    custom: [],                   // [{id,name,lat,lng,color,note}]
    lists: [],                    // [{id,name,markerIds:[...]}]
    completion: 'all',            // 'all' | 'found' | 'unfound'
    onlyNotes: false,
    onlyList: null,               // checklist id used as a hard filter
    adding: false,                // "add marker" click mode
    heatIds: [],                  // enabled heatmap layer ids
    heatOn: false                 // master heatmap overlay switch
  };

  /* ------------------------------------------------------- v2 small utils */
  var CUSTOM_PREFIX = 'custom:';
  var MARKER_COLORS = ['#ff2e88', '#22d3ee', '#fbbf24', '#34d399', '#a78bfa', '#f97316'];

  function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function noteOf(id) {
    var t = state.notes[id];
    return typeof t === 'string' ? t : '';
  }

  function setNote(id, text) {
    var t = typeof text === 'string' ? text.replace(/\s+$/, '') : '';
    if (t) state.notes[id] = t;
    else delete state.notes[id];
  }

  function customById(id) {
    for (var i = 0; i < state.custom.length; i++) if (state.custom[i].id === id) return state.custom[i];
    return null;
  }

  function listById(id) {
    for (var i = 0; i < state.lists.length; i++) if (state.lists[i].id === id) return state.lists[i];
    return null;
  }

  function sanitizeCustom(c) {
    if (!c || typeof c !== 'object') return null;
    var lat = Number(c.lat), lng = Number(c.lng);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    if (lat < 0 || lat > 1.4 || lng < -1.4 || lng > 0) return null;
    var id = typeof c.id === 'string' && c.id ? c.id : uid(CUSTOM_PREFIX);
    if (id.indexOf(CUSTOM_PREFIX) !== 0) id = CUSTOM_PREFIX + id;
    return {
      id: id,
      name: String(c.name || 'Untitled marker').slice(0, 80),
      lat: lat, lng: lng,
      color: /^#[0-9a-f]{6}$/i.test(String(c.color)) ? String(c.color) : MARKER_COLORS[0],
      note: typeof c.note === 'string' ? c.note.slice(0, 500) : ''
    };
  }

  function sanitizeList(l) {
    if (!l || typeof l !== 'object') return null;
    var ids = [];
    var seen = Object.create(null);
    (Array.isArray(l.markerIds) ? l.markerIds : []).forEach(function (id) {
      if (typeof id !== 'string' || seen[id]) return;
      if (!idIndex[id] && !customById(id)) return;   // drop ids we cannot render
      seen[id] = 1;
      ids.push(id);
    });
    return {
      id: typeof l.id === 'string' && l.id ? l.id : uid('list:'),
      name: String(l.name || 'Untitled list').slice(0, 60),
      markerIds: ids
    };
  }

  function loadProgress() {
    var raw;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return; }
    if (!raw) return;
    var d;
    try { d = JSON.parse(raw); } catch (e) { return; }
    var arr = Array.isArray(d) ? d : (d && Array.isArray(d.found) ? d.found : []);
    arr.forEach(function (id) { if (idIndex[id]) state.found.add(id); });
    if (d && !Array.isArray(d)) {
      if (typeof d.hideFound === 'boolean') state.hideFound = d.hideFound;
      if (Array.isArray(d.hidden)) d.hidden.forEach(function (s) { if (typeInfo[s]) state.hidden.add(s); });
      if (d.theme === 'night') state.theme = 'night';

      /* ---- v2 keys. v1 documents simply do not have them; nothing to do. */
      if (d.notes && typeof d.notes === 'object') {
        Object.keys(d.notes).forEach(function (id) {
          if (typeof d.notes[id] !== 'string' || !d.notes[id].trim()) return;
          if (!idIndex[id] && id.indexOf(CUSTOM_PREFIX) !== 0) return;
          state.notes[id] = d.notes[id].slice(0, 4000);
        });
      }
      if (Array.isArray(d.custom)) {
        d.custom.forEach(function (c) { var x = sanitizeCustom(c); if (x) state.custom.push(x); });
      }
      if (Array.isArray(d.lists)) {
        d.lists.forEach(function (l) { var x = sanitizeList(l); if (x) state.lists.push(x); });
      }
      if (d.completion === 'found' || d.completion === 'unfound') state.completion = d.completion;
      if (typeof d.onlyNotes === 'boolean') state.onlyNotes = d.onlyNotes;
      if (typeof d.onlyList === 'string' && listById(d.onlyList)) state.onlyList = d.onlyList;
      if (Array.isArray(d.heat)) state.heatIds = d.heat.filter(function (id) { return typeof id === 'string'; });
      if (typeof d.heatOn === 'boolean') state.heatOn = d.heatOn;
    }
  }

  var storageWarned = false;
  function saveProgress() {
    var payload = {
      v: 2,
      found: Array.from(state.found).sort(),
      hidden: Array.from(state.hidden).sort(),
      hideFound: state.hideFound,
      theme: state.theme,
      notes: state.notes,
      custom: state.custom,
      lists: state.lists,
      completion: state.completion,
      onlyNotes: state.onlyNotes,
      onlyList: state.onlyList,
      heat: state.heatIds,
      heatOn: state.heatOn,
      updated: new Date().toISOString()
    };
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(payload));
    } catch (e) {
      if (!storageWarned) { storageWarned = true; toast('Progress could not be saved (browser storage blocked).'); }
    }
  }

  /* ------------------------------------------------------------------ map */
  var bounds = L.latLngBounds([META.bounds.south, META.bounds.west], [META.bounds.north, META.bounds.east]);
  var map = L.map('map', {
    center: [META.center.lat, META.center.lng],
    zoom: 12,
    minZoom: 9,
    maxZoom: 17,
    zoomControl: false,
    attributionControl: false,
    maxBounds: [[META.bounds.south - 0.06, META.bounds.west - 0.06], [META.bounds.north + 0.06, META.bounds.east + 0.06]],
    maxBoundsViscosity: 0.85,
    zoomSnap: 0.5,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90,
    worldCopyJump: false,
    preferCanvas: true
  });

  map.createPane('markers');
  map.getPane('markers').style.zIndex = 460;
  map.getPane('markers').style.pointerEvents = 'none';

  // region outlines/labels sit above the tiles but *under* the markers
  map.createPane('regions');
  map.getPane('regions').style.zIndex = 350;
  map.getPane('regions').style.pointerEvents = 'none';

  var tileErrors = 0, tileLoads = 0;
  var tileLayer = null;

  function makeTileLayer(theme, extra) {
    var dir = theme === 'night' ? 'tiles-night' : 'tiles';
    // MapLibre world = 512*2^Z, Leaflet world = 256*2^L  =>  tile z = L-1.
    // tileSize 512 + zoomOffset -1 keeps Leaflet's tile grid (x/y) on the z-1
    // pyramid while displaying each 256px tile at 512px, exactly like MapLibre.
    var opts = {
      tileSize: 512,
      minZoom: 9,
      maxZoom: 17,
      zoomOffset: -1,
      noWrap: true,
      bounds: bounds,
      errorTileUrl: BLANK,
      keepBuffer: 3,
      updateWhenIdle: false,
      updateWhenZooming: false,
      attribution: ''
    };
    if (extra) Object.keys(extra).forEach(function (k) { opts[k] = extra[k]; });
    var layer = L.tileLayer(dir + '/{z}/{y}/{x}.jpg', opts);
    layer.on('tileerror', function () { tileErrors++; });
    layer.on('tileload', function () { tileLoads++; });
    return layer;
  }

  var dayLayer = null, nightLayer = null;

  function setTiles(theme) {
    if (!dayLayer) {
      dayLayer = makeTileLayer('day');
      dayLayer.addTo(map);
    }
    dayLayer.setZIndex(1);
    if (nightLayer) { map.removeLayer(nightLayer); nightLayer = null; }
    if (theme === 'night') {
      // night tiles are complete for the whole native pyramid (z8..z16), so the
      // night layer uses exactly the same zoom range as the day layer
      nightLayer = makeTileLayer('night');
      nightLayer.addTo(map);
      nightLayer.setZIndex(2);
      tileLayer = nightLayer;
    } else {
      tileLayer = dayLayer;
    }
  }

  setTiles(state.theme);

  /* ------------------------------------------------------- atlas + canvas */
  var atlasImg = new Image();
  var atlasReady = false;
  atlasImg.onload = function () { atlasReady = true; markers.schedule(); };
  atlasImg.onerror = function () { atlasReady = false; };
  atlasImg.src = ATLAS.url || 'assets/atlas.png';

  function spriteDrawRect(m) {
    var key = m.i;
    if (ICONS[key]) return ICONS[key];
    if (m._ti && m._ti.icon && ICONS[m._ti.icon]) return ICONS[m._ti.icon];
    return null;
  }

  var SEC_COLOR = { '8': '#38bdf8', '6': '#f472b6', '7': '#a3e635' };
  function secColor(m) { return SEC_COLOR[m._s] || '#fbbf24'; }

  /* A note badge drawn on top of a marker dot: a small amber "page" with lines. */
  function drawNoteBadge(ctx, x, y, scale) {
    var s = Math.max(0.75, scale);
    var w = 8 * s, h = 7 * s;
    var bx = x + 0.9 * s, by = y - h - 0.4 * s;
    ctx.save();
    ctx.beginPath();
    ctx.rect(bx, by, w, h);
    ctx.fillStyle = '#fbbf24';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(6,10,18,.85)';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx + 1.6 * s, by + 2.2 * s); ctx.lineTo(bx + w - 1.6 * s, by + 2.2 * s);
    ctx.moveTo(bx + 1.6 * s, by + 4.2 * s); ctx.lineTo(bx + w - 2.6 * s, by + 4.2 * s);
    ctx.strokeStyle = 'rgba(10,16,26,.9)';
    ctx.lineWidth = Math.max(0.8, 0.9 * s);
    ctx.stroke();
    ctx.restore();
  }

  /* Distinct pin for user-created markers (teardrop + white core). */
  function drawCustomPin(ctx, x, y, r, color, selected) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y - r * 0.38, r, Math.PI * 0.82, Math.PI * 0.18, true);
    ctx.lineTo(x, y + r * 1.32);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(6,10,18,.75)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y - r * 0.38, r * 0.38, 0, TAU);
    ctx.fillStyle = '#fff';
    ctx.fill();
    if (selected) {
      ctx.beginPath();
      ctx.arc(x, y - r * 0.38, r + 4, 0, TAU);
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = '#fbbf24';
      ctx.stroke();
    }
    ctx.restore();
  }

  var markers = {
    canvas: null, ctx: null, items: [], hits: [], _raf: 0, _dpr: 1,

    init: function () {
      var c = document.createElement('canvas');
      c.className = 'marker-canvas';
      c.setAttribute('aria-hidden', 'true');
      map.getPane('markers').appendChild(c);
      this.canvas = c;
      this.ctx = c.getContext('2d');
      var self = this;
      map.on('move zoom viewreset resize moveend', function () { self.schedule(); });
      map.on('zoomstart', function () { c.classList.add('zooming'); });
      map.on('zoomend', function () { c.classList.remove('zooming'); self.schedule(); });
      map.on('click', function (e) {
        if (state.adding) { openAddForm(e.latlng, e.containerPoint); return; }
        var hit = self.hitTest(e.containerPoint);
        if (hit && hit.custom) { openCustomPopup(hit.custom, false); return; }
        if (hit) openMarker(hit.m, true);
        else { map.closePopup(); self.select(null); }
      });
      map.on('mousedown', function (e) { self.maybeDrag(e); });
      map.on('mousemove', function (e) { self.hover(e); });
      map.on('mouseout', hideTip);
      this.refilter();
    },

    /* Custom markers are draggable: press, move, release writes the new spot. */
    maybeDrag: function (e) {
      if (state.adding) return;
      var hit = this.hitTest(e.containerPoint);
      if (!hit || !hit.custom) return;
      var c = hit.custom, self = this, moved = false;
      var start = e.containerPoint;
      map.dragging.disable();
      map.getContainer().classList.add('dragging-marker');
      function move(ev) {
        var p = map.mouseEventToContainerPoint(ev);
        if (!moved && Math.abs(p.x - start.x) + Math.abs(p.y - start.y) < 3) return;
        moved = true;
        var ll = map.containerPointToLatLng(p);
        c.lat = Math.max(bounds.getSouth(), Math.min(bounds.getNorth(), ll.lat));
        c.lng = Math.max(bounds.getWest(), Math.min(bounds.getEast(), ll.lng));
        self.schedule();
      }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        map.dragging.enable();
        map.getContainer().classList.remove('dragging-marker');
        if (moved) {
          saveProgress();
          renderCustomList();
          if (popMarker === c) openCustomPopup(c, false);
          toast('Marker moved');
        }
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    },

    refilter: function () {
      var hidden = state.hidden, hideFound = state.hideFound, found = state.found;
      var comp = state.completion || 'all';
      var onlyNotes = state.onlyNotes;
      var onlyList = state.onlyList ? listById(state.onlyList) : null;
      var listSet = null;
      if (onlyList) {
        listSet = Object.create(null);
        for (var li = 0; li < onlyList.markerIds.length; li++) listSet[onlyList.markerIds[li]] = 1;
      }
      var out = [];
      for (var i = 0; i < MARKERS.length; i++) {
        var m = MARKERS[i];
        if (hidden.has(m.t)) continue;
        var isFound = found.has(m.id);
        if (hideFound && isFound) continue;
        if (comp === 'found' && !isFound) continue;
        if (comp === 'unfound' && isFound) continue;
        if (onlyNotes && !noteOf(m.id)) continue;
        if (listSet && !listSet[m.id]) continue;
        out.push(m);
      }
      this.items = out;
      this.schedule();
    },

    select: function (id) {
      state.selectedId = id;
      this.schedule();
    },

    schedule: function () {
      if (this._raf) return;
      var self = this;
      this._raf = requestAnimationFrame(function () { self._raf = 0; self.draw(); });
    },

    draw: function () {
      var map2 = map, c = this.canvas;
      if (!c) return;
      var size = map2.getSize();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (this._dpr !== dpr) this._dpr = dpr;
      var w = Math.round(size.x * dpr), h = Math.round(size.y * dpr);
      if (c.width !== w || c.height !== h) {
        c.width = w; c.height = h;
        c.style.width = size.x + 'px';
        c.style.height = size.y + 'px';
      }
      var ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);
      L.DomUtil.setPosition(c, map2.containerPointToLayerPoint([0, 0]));

      var z = map2.getZoom();
      var r = z >= 15 ? 13.5 : z >= 14 ? 12 : z >= 13 ? 10 : z >= 12 ? 7.5 : 5.4;
      var hits = [];
      var sel = state.selectedId;
      var found = state.found;
      var hasNotes = state.notes;
      var items = this.items;
      var rectCache = Object.create(null);

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      for (var i = 0; i < items.length; i++) {
        var m = items[i];
        var p = map2.latLngToContainerPoint([m.lat, m.lng]);
        if (p.x < -24 || p.y < -24 || p.x > size.x + 24 || p.y > size.y + 24) continue;
        var isFound = found.has(m.id);
        var isSel = m.id === sel;
        hits.push({ m: m, x: p.x, y: p.y, r: r });

        if (r <= 7) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, TAU);
          ctx.fillStyle = isFound ? 'rgba(52,211,153,.35)' : secColor(m);
          ctx.fill();
          ctx.lineWidth = 1.3;
          ctx.strokeStyle = 'rgba(5,10,18,.8)';
          ctx.stroke();
        } else {
          var rect = rectCache[m.i] !== undefined ? rectCache[m.i] : (rectCache[m.i] = spriteDrawRect(m));
          ctx.save();
          ctx.shadowColor = 'rgba(0,0,0,.5)';
          ctx.shadowBlur = 7;
          ctx.shadowOffsetY = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, TAU);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.restore();

          var ir = r - 1.6;
          if (atlasReady && rect) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(p.x, p.y, ir, 0, TAU);
            ctx.clip();
            ctx.globalAlpha = isFound ? 0.45 : 1;
            ctx.drawImage(atlasImg, rect.x, rect.y, rect.width, rect.height, p.x - ir, p.y - ir, ir * 2, ir * 2);
            ctx.globalAlpha = 1;
            ctx.restore();
          } else {
            ctx.beginPath();
            ctx.arc(p.x, p.y, ir, 0, TAU);
            ctx.fillStyle = secColor(m);
            ctx.globalAlpha = isFound ? 0.45 : 1;
            ctx.fill();
            ctx.globalAlpha = 1;
          }

          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, TAU);
          ctx.lineWidth = 1.6;
          ctx.strokeStyle = isFound ? 'rgba(52,211,153,.9)' : 'rgba(8,14,24,.55)';
          ctx.stroke();

          if (isFound) {
            ctx.beginPath();
            ctx.arc(p.x + r * 0.72, p.y + r * 0.72, r * 0.4, 0, TAU);
            ctx.fillStyle = '#22c55e';
            ctx.fill();
            ctx.strokeStyle = '#04121a';
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }

        if (isSel) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + 4.5, 0, TAU);
          ctx.lineWidth = 2.6;
          ctx.strokeStyle = '#fbbf24';
          ctx.stroke();
        }

        if (hasNotes[m.id]) drawNoteBadge(ctx, p.x, p.y, r / 11);
      }

      /* ---- user markers: distinct pins, drawn last so they stay on top ---- */
      var customs = state.custom;
      for (var ci = 0; ci < customs.length; ci++) {
        var cu = customs[ci];
        var cp = map2.latLngToContainerPoint([cu.lat, cu.lng]);
        var cr = z >= 14 ? 10.5 : z >= 12 ? 8.5 : 6.5;
        if (cp.x < -30 || cp.y < -30 || cp.x > size.x + 30 || cp.y > size.y + 30) continue;
        drawCustomPin(ctx, cp.x, cp.y, cr, cu.color || MARKER_COLORS[0], cu.id === sel);
        if (noteOf(cu.id)) drawNoteBadge(ctx, cp.x, cp.y - cr * 0.4, cr / 11);
        hits.push({ m: null, custom: cu, x: cp.x, y: cp.y - cr * 0.38, r: cr });
      }
      this.hits = hits;
    },

    hitTest: function (pt) {
      var best = null, bestD = Infinity;
      for (var i = this.hits.length - 1; i >= 0; i--) {
        var h = this.hits[i];
        var dx = pt.x - h.x, dy = pt.y - h.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        var tol = Math.max(h.r, 7) + 3;
        if (d <= tol && d < bestD) { bestD = d; best = h; }
      }
      return best;
    },

    hover: function (e) {
      var hit = this.hitTest(e.containerPoint);
      var el = map.getContainer();
      el.style.cursor = hit ? 'pointer' : '';
      if (!hit) { hideTip(); return; }
      showTip(hit, e.containerPoint);
    }
  };

  var tipEl = document.getElementById('hoverTip');
  var tipRaf = 0, tipHit = null, tipPt = null;
  function showTip(hit, pt) {
    tipHit = hit; tipPt = pt;
    if (tipRaf) return;
    tipRaf = requestAnimationFrame(function () {
      tipRaf = 0;
      if (!tipHit || !tipPt) return;
      tipEl.innerHTML = '';
      var b = document.createElement('b');
      var s = document.createElement('span');
      if (tipHit.custom) {
        b.textContent = tipHit.custom.name;
        s.textContent = 'My marker · drag to move';
      } else {
        var m = tipHit.m;
        b.textContent = m.n;
        s.textContent = m._ti.name + ' · ' + m._ti.groupName;
      }
      tipEl.appendChild(b); tipEl.appendChild(s);
      tipEl.style.left = tipPt.x + 'px';
      tipEl.style.top = tipPt.y + 'px';
      tipEl.hidden = false;
    });
  }
  function hideTip() { tipHit = null; tipEl.hidden = true; }

  /* ---------------------------------------------------------------- popup */
  var popup = L.popup({
    className: 'gta6-popup',
    maxWidth: 340,
    minWidth: 260,
    autoPanPadding: [24, 80],
    offset: [0, -10],
    closeButton: true,
    autoClose: true,
    closeOnClick: false
  });
  var popBtn = null, popMarker = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderDesc(text) {
    var s = escapeHtml(text);
    // strip markdown links, keep label text (never emit URLs)
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|\n)\s*#{1,6}\s*(.+)/g, '$1<strong>$2</strong>');
    s = s.replace(/(^|\n)\s*[-*•]\s+/g, '$1• ');
    var blocks = s.split(/\n{2,}/);
    var out = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i].trim();
      if (!b) continue;
      out.push('<p>' + b.replace(/\n/g, '<br>') + '</p>');
    }
    return out.join('');
  }

  function swatchCss(iconKey, size) {
    var r = ICONS[iconKey];
    if (!r) return 'width:' + size + 'px;height:' + size + 'px;background:#475569;';
    // Sprite rects are in atlas pixels (2x assets). Map the rect onto a `size` CSS-px
    // box: scale = size / rect width. Dividing by pixelRatio as well drew every icon at
    // double its box, so thumbnails were clipped inside their circular badge.
    var scale = size / r.width;
    return 'width:' + size + 'px;height:' + size + 'px;' +
      'background-image:url(' + (ATLAS.url || 'assets/atlas.png') + ');' +
      'background-size:' + (ATLAS.width * scale) + 'px ' + (ATLAS.height * scale) + 'px;' +
      'background-position:' + (-r.x * scale) + 'px ' + (-r.y * scale) + 'px;';
  }

  /* ------------------------------------------------- image gallery + lightbox */
  // Every file we ever asked about is remembered, so a missing screenshot costs
  // one failed load at most and is then hidden instantly (no 404 spam).
  var imgState = Object.create(null);

  function imgName(b) { return String(b).replace(/^.*[\\/]/, ''); }

  function imgKnown(name) {
    if (name in imgState) return imgState[name] === 1;
    if (IMGS && IMGS.files) {          // explicit manifest from tools/build_app.py
      var ok = Object.prototype.hasOwnProperty.call(IMGS.files, name);
      imgState[name] = ok ? 1 : 0;
      return ok;
    }
    return null;                       // unknown: optimistically show, hide on error
  }

  function imgSrc(name) { return (IMGS.dir || 'assets/img/') + name; }

  function availableImages(m) {
    if (!m || !m.p || !m.p.length) return [];
    var out = [];
    for (var i = 0; i < m.p.length; i++) {
      var name = imgName(m.p[i]);
      if (!name) continue;
      if (imgKnown(name) !== false && out.indexOf(name) < 0) out.push(name);
    }
    return out;
  }

  var lbEl = document.getElementById('lightbox');
  var lbImg = document.getElementById('lbImg');
  var lbCount = document.getElementById('lbCount');
  var lbList = [], lbIndex = 0, lbOpen = false;

  function openLightbox(list, idx) {
    if (!list || !list.length || !lbEl) return;
    lbList = list; lbIndex = Math.max(0, Math.min(list.length - 1, idx || 0));
    lbOpen = true;
    lbEl.hidden = false;
    document.body.classList.add('lb-open');
    showLightboxImage();
    var b = document.getElementById('lbClose');
    if (b) b.focus();
  }

  function showLightboxImage() {
    if (!lbList.length) return;
    var name = lbList[lbIndex];
    lbImg.onerror = function () {   // file vanished: skip, never a broken icon
      imgState[name] = 0;
      closeLightbox();
      toast('Screenshot is not in this offline build');
    };
    lbImg.src = imgSrc(name);
    lbImg.alt = 'Screenshot ' + (lbIndex + 1) + ' of ' + lbList.length;
    lbCount.textContent = (lbIndex + 1) + ' / ' + lbList.length;
    document.getElementById('lbPrev').hidden = lbList.length < 2;
    document.getElementById('lbNext').hidden = lbList.length < 2;
  }

  function lbStep(d) {
    if (!lbList.length) return;
    lbIndex = (lbIndex + d + lbList.length) % lbList.length;
    showLightboxImage();
  }

  function closeLightbox() {
    lbOpen = false;
    lbEl.hidden = true;
    lbImg.src = 'assets/blank.gif';    // never leave a broken <img> in the DOM
    document.body.classList.remove('lb-open');
  }

  if (lbEl) {
    document.getElementById('lbClose').addEventListener('click', closeLightbox);
    document.getElementById('lbPrev').addEventListener('click', function () { lbStep(-1); });
    document.getElementById('lbNext').addEventListener('click', function () { lbStep(1); });
    lbEl.addEventListener('click', function (e) { if (e.target === lbEl) closeLightbox(); });
  }

  /* ------------------------------------------------------------ checklists */
  function addToList(listId, markerId) {
    var l = listById(listId);
    if (!l) return false;
    if (l.markerIds.indexOf(markerId) >= 0) return false;
    l.markerIds.push(markerId);
    saveProgress();
    renderLists();
    recount();
    return true;
  }

  function removeFromList(listId, markerId) {
    var l = listById(listId);
    if (!l) return false;
    var i = l.markerIds.indexOf(markerId);
    if (i < 0) return false;
    l.markerIds.splice(i, 1);
    saveProgress();
    renderLists();
    recount();
    return true;
  }

  function buildPopup(m) {
    var wrap = document.createElement('div');
    wrap.className = 'pop';

    var head = document.createElement('div');
    head.className = 'pop-head';
    var sw = document.createElement('span');
    sw.className = 'pop-swatch';
    sw.setAttribute('style', swatchCss(m.i, 34));

    var titles = document.createElement('div');
    titles.className = 'pop-titles';
    var h3 = document.createElement('h3');
    h3.textContent = m.n;
    var tp = document.createElement('div');
    tp.className = 'pop-type';
    tp.textContent = m._ti.name;
    var sep = document.createElement('span');
    sep.className = 'sep'; sep.textContent = '·';
    tp.appendChild(sep);
    tp.appendChild(document.createTextNode(m._ti.groupName));
    titles.appendChild(h3); titles.appendChild(tp);
    head.appendChild(sw); head.appendChild(titles);
    wrap.appendChild(head);

    var scroll = document.createElement('div');
    scroll.className = 'pop-scroll';
    if (m.d) {
      var d = document.createElement('div');
      d.className = 'pop-desc';
      d.innerHTML = renderDesc(m.d);
      scroll.appendChild(d);
    }

    /* ---- screenshot gallery: every local file, thumbnails open a lightbox ---- */
    var imgs = availableImages(m);
    if (imgs.length) {
      var strip = el('div', 'pop-gallery');
      imgs.forEach(function (name, idx) {
        var b = el('button', 'thumb');
        b.type = 'button';
        b.setAttribute('aria-label', 'Open screenshot ' + (idx + 1) + ' of ' + imgs.length);
        var im = document.createElement('img');
        im.loading = 'lazy';
        im.decoding = 'async';
        im.alt = '';
        im.onerror = function () { imgState[name] = 0; b.remove(); };
        im.src = imgSrc(name);
        b.appendChild(im);
        b.addEventListener('click', function () { openLightbox(imgs, idx); });
        strip.appendChild(b);
      });
      scroll.appendChild(strip);
      if (imgs.length > 1) scroll.appendChild(el('div', 'pop-note', imgs.length + ' screenshots — click to enlarge'));
    } else if (m.p && m.p.length) {
      scroll.appendChild(el('div', 'pop-note', 'Screenshot not included in this offline build'));
    }

    /* ------------------------------------------------------------- my note */
    var noteBox = el('div', 'pop-notes');
    noteBox.appendChild(el('div', 'pop-sec-head', 'My note'));
    var ta = document.createElement('textarea');
    ta.className = 'note-input';
    ta.rows = 3;
    ta.maxLength = 4000;
    ta.placeholder = 'Add a note for this marker…';
    ta.value = noteOf(m.id);
    ta.setAttribute('aria-label', 'Note for ' + m.n);
    var nActions = el('div', 'note-actions');
    var nSave = el('button', 'mini primary', 'Save note');
    nSave.type = 'button';
    var nClear = el('button', 'mini', 'Clear');
    nClear.type = 'button';
    var nStatus = el('span', 'note-status', noteOf(m.id) ? 'saved locally' : '');
    function commitNote() {
      var had = !!noteOf(m.id);
      setNote(m.id, ta.value);
      var has = !!noteOf(m.id);
      saveProgress();
      markers.schedule();
      if (had !== has) recount();
      nStatus.textContent = has ? 'saved locally' : 'note cleared';
      if (state.query) runSearch(state.query);
      if (state.onlyNotes) markers.refilter();
      if (has !== had) toast(has ? 'Note saved' : 'Note cleared');
    }
    nSave.addEventListener('click', commitNote);
    nClear.addEventListener('click', function () {
      ta.value = '';
      commitNote();
    });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitNote(); }
    });
    nActions.appendChild(nSave); nActions.appendChild(nClear); nActions.appendChild(nStatus);
    noteBox.appendChild(ta);
    noteBox.appendChild(nActions);
    scroll.appendChild(noteBox);

    /* ---------------------------------------------------------- checklists */
    if (state.lists.length) {
      var lb = el('div', 'pop-lists');
      lb.appendChild(el('div', 'pop-sec-head', 'My checklists'));
      var inLists = state.lists.filter(function (l) { return l.markerIds.indexOf(m.id) >= 0; });
      if (inLists.length) {
        var chips = el('div', 'list-chips');
        inLists.forEach(function (l) {
          var chip = el('span', 'list-chip');
          chip.appendChild(document.createTextNode(l.name));
          var x = el('button', 'chip-x', '×');
          x.type = 'button';
          x.setAttribute('aria-label', 'Remove from ' + l.name);
          x.addEventListener('click', function () {
            removeFromList(l.id, m.id);
            openMarker(m, false);
          });
          chip.appendChild(x);
          chips.appendChild(chip);
        });
        lb.appendChild(chips);
      }
      var sel = document.createElement('select');
      sel.className = 'list-select';
      sel.setAttribute('aria-label', 'Add to checklist');
      var o0 = document.createElement('option');
      o0.value = ''; o0.textContent = 'Add to checklist…';
      sel.appendChild(o0);
      state.lists.forEach(function (l) {
        if (l.markerIds.indexOf(m.id) >= 0) return;
        var o = document.createElement('option');
        o.value = l.id;
        o.textContent = l.name;
        sel.appendChild(o);
      });
      var addBtn = el('button', 'mini', 'Add');
      addBtn.type = 'button';
      addBtn.addEventListener('click', function () {
        if (!sel.value) { sel.focus(); return; }
        addToList(sel.value, m.id);
        openMarker(m, false);
      });
      var row = el('div', 'list-add-row');
      row.appendChild(sel); row.appendChild(addBtn);
      lb.appendChild(row);
      scroll.appendChild(lb);
    }

    wrap.appendChild(scroll);

    var actions = document.createElement('div');
    actions.className = 'pop-actions';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-found' + (state.found.has(m.id) ? ' on' : '');
    btn.textContent = state.found.has(m.id) ? '✓ Found — tap to undo' : 'Mark as found';
    btn.setAttribute('aria-pressed', state.found.has(m.id) ? 'true' : 'false');
    btn.addEventListener('click', function () { toggleFound(m.id); });
    popBtn = btn; popMarker = m;
    var coords = document.createElement('span');
    coords.className = 'pop-coords';
    coords.textContent = m.lat.toFixed(5) + ', ' + m.lng.toFixed(5);
    actions.appendChild(btn);
    actions.appendChild(coords);
    wrap.appendChild(actions);
    return wrap;
  }

  function openMarker(m, pan) {
    if (!m) return;
    state.selectedId = m.id;
    markers.schedule();
    popBtn = null;
    popup.setLatLng([m.lat, m.lng]).setContent(buildPopup(m));
    if (pan) popup.options.autoPan = true;
    popup.openOn(map);
  }

  /* ------------------------------------------------------- custom marker popup */
  function buildCustomPopup(c) {
    var wrap = el('div', 'pop pop-custom');
    var head = el('div', 'pop-head');
    var sw = el('span', 'pop-swatch custom-swatch');
    sw.setAttribute('style', 'background:' + (c.color || MARKER_COLORS[0]));
    var titles = el('div', 'pop-titles custom-titles');
    var nm = document.createElement('input');
    nm.type = 'text';
    nm.value = c.name;
    nm.maxLength = 80;
    nm.className = 'custom-name';
    nm.setAttribute('aria-label', 'Marker name');
    titles.appendChild(nm);
    titles.appendChild(el('div', 'pop-type', 'My marker'));
    head.appendChild(sw); head.appendChild(titles);
    wrap.appendChild(head);

    var scroll = el('div', 'pop-scroll');
    var colors = el('div', 'af-colors');
    MARKER_COLORS.forEach(function (col) {
      var b = el('button', 'color-dot' + (col === c.color ? ' on' : ''));
      b.type = 'button';
      b.setAttribute('style', 'background:' + col);
      b.setAttribute('aria-label', 'Colour ' + col);
      b.addEventListener('click', function () {
        c.color = col;
        saveProgress();
        markers.schedule();
        openCustomPopup(c, false);
      });
      colors.appendChild(b);
    });
    scroll.appendChild(el('div', 'pop-sec-head', 'Colour'));
    scroll.appendChild(colors);

    scroll.appendChild(el('div', 'pop-sec-head', 'Note'));
    var ta = document.createElement('textarea');
    ta.className = 'note-input';
    ta.rows = 3;
    ta.maxLength = 500;
    ta.value = c.note || '';
    ta.placeholder = 'Note (optional)';
    ta.setAttribute('aria-label', 'Note for this marker');
    scroll.appendChild(ta);
    scroll.appendChild(el('div', 'pop-note', 'Drag the pin to move it. Changes save locally.'));
    wrap.appendChild(scroll);

    var actions = el('div', 'pop-actions');
    var save = el('button', 'btn-found', 'Save');
    save.type = 'button';
    save.addEventListener('click', function () {
      c.name = (nm.value || 'Untitled marker').slice(0, 80);
      c.note = ta.value.slice(0, 500);
      saveProgress();
      renderCustomList();
      markers.schedule();
      openCustomPopup(c, false);
      toast('Marker saved');
    });
    var del = el('button', 'mini danger', 'Delete');
    del.type = 'button';
    del.addEventListener('click', function () {
      if (!window.confirm('Delete “' + c.name + '”?')) return;
      state.custom = state.custom.filter(function (x) { return x.id !== c.id; });
      state.lists.forEach(function (l) {
        var i = l.markerIds.indexOf(c.id);
        if (i >= 0) l.markerIds.splice(i, 1);
      });
      setNote(c.id, '');
      if (state.onlyList && !listById(state.onlyList)) state.onlyList = null;
      saveProgress();
      renderCustomList(); renderLists(); recount();
      map.closePopup(); markers.select(null); markers.schedule();
      toast('Marker deleted');
    });
    var coords = el('span', 'pop-coords', c.lat.toFixed(5) + ', ' + c.lng.toFixed(5));
    actions.appendChild(save); actions.appendChild(del); actions.appendChild(coords);
    wrap.appendChild(actions);
    return wrap;
  }

  function openCustomPopup(c, pan) {
    if (!c) return;
    state.selectedId = c.id;
    popBtn = null; popMarker = c;
    markers.schedule();
    popup.setLatLng([c.lat, c.lng]).setContent(buildCustomPopup(c));
    if (pan) popup.options.autoPan = true;
    popup.openOn(map);
  }

  function toggleFound(id) {
    if (state.found.has(id)) state.found.delete(id);
    else state.found.add(id);
    saveProgress();
    recount();
    markers.schedule();
    if (popBtn && popMarker && popMarker.id === id) {
      var on = state.found.has(id);
      popBtn.classList.toggle('on', on);
      popBtn.textContent = on ? '✓ Found — tap to undo' : 'Mark as found';
      popBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (state.query) runSearch(state.query);
    if (state.hideFound) markers.refilter();
  }

  /* -------------------------------------------------------------- progress */
  var refs = { type: {}, group: {}, section: {} };
  var listRefs = Object.create(null);
  var overall = {
    label: document.getElementById('ovLabel'),
    pct: document.getElementById('ovPct'),
    bar: document.getElementById('ovBar'),
    left: document.getElementById('ovLeft')
  };

  function recount() {
    var byType = {}, byGroup = {}, bySec = {};
    Object.keys(typeInfo).forEach(function (s) { byType[s] = 0; });
    TAX.groups.forEach(function (g) { byGroup[g.slug] = 0; });
    SECTIONS.forEach(function (s) { bySec[s.slug] = 0; });
    var foundTotal = 0;

    state.found.forEach(function (id) {
      var m = idIndex[id];
      if (!m) return;
      foundTotal++;
      byType[m.t] = (byType[m.t] || 0) + 1;
      byGroup[m._g] = (byGroup[m._g] || 0) + 1;
      bySec[m._s] = (bySec[m._s] || 0) + 1;
    });

    Object.keys(refs.type).forEach(function (s) {
      var r = refs.type[s], f = byType[s] || 0, t = typeInfo[s].count;
      r.count.innerHTML = '<b>' + f + '</b>/' + t;
      r.count.classList.toggle('done', f >= t && t > 0);
      if (r.bar) r.bar.style.width = (t ? (f / t) * 100 : 0) + '%';
    });
    Object.keys(refs.group).forEach(function (s) {
      var r = refs.group[s], g = groupInfo[s], f = byGroup[s] || 0;
      r.count.innerHTML = '<b>' + f + '</b>/' + g.count;
      r.count.classList.toggle('done', f >= g.count && g.count > 0);
      if (r.bar) r.bar.style.width = (g.count ? (f / g.count) * 100 : 0) + '%';
    });
    Object.keys(refs.section).forEach(function (s) {
      var r = refs.section[s], f = bySec[s] || 0;
      var sec = SECTIONS.filter(function (x) { return x.slug === s; })[0];
      r.count.innerHTML = '<b>' + f + '</b>/' + sec.total;
      r.count.classList.toggle('done', f >= sec.total && sec.total > 0);
      if (r.bar) r.bar.style.width = (sec.total ? (f / sec.total) * 100 : 0) + '%';
    });

    var pct = totalMarkers ? (foundTotal / totalMarkers) * 100 : 0;
    overall.label.textContent = fmt(foundTotal) + ' / ' + fmt(totalMarkers) + ' found';
    overall.pct.textContent = (pct >= 10 ? pct.toFixed(1) : pct.toFixed(2)).replace(/\.0+$/, '') + '%';
    overall.bar.style.width = pct + '%';
    overall.left.textContent = fmt(totalMarkers - foundTotal) + ' remaining';

    /* ---- tri-state completion counts + checklist progress ---- */
    var cAll = document.getElementById('cAll');
    var cFound = document.getElementById('cFound');
    var cLeft = document.getElementById('cLeft');
    if (cAll) cAll.textContent = fmt(totalMarkers);
    if (cFound) cFound.textContent = fmt(foundTotal);
    if (cLeft) cLeft.textContent = fmt(totalMarkers - foundTotal);

    state.lists.forEach(function (l) {
      var r = listRefs[l.id];
      if (!r) return;
      var lt = l.markerIds.length, ld = 0;
      l.markerIds.forEach(function (id) { if (state.found.has(id)) ld++; });
      r.count.textContent = ld + '/' + lt + (lt ? ' · ' + Math.round(ld / lt * 100) + '%' : '');
      r.fill.style.width = (lt ? (ld / lt) * 100 : 0) + '%';
    });
  }

  /* ------------------------------------------------------------------ tree */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  var CARET = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function makeCheckbox(attrs, onChange) {
    var label = el('label', 'cbx-label');
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = true;
    Object.keys(attrs).forEach(function (k) { input.setAttribute(k, attrs[k]); });
    input.addEventListener('change', function () { onChange(input); });
    var box = el('span', 'cbx');
    label.appendChild(input); label.appendChild(box);
    return { label: label, input: input };
  }

  function countEl(cls) {
    var s = el('span', cls || 'tcount');
    s.innerHTML = '<b>0</b>/0';
    return s;
  }

  function buildTree() {
    var root = document.getElementById('tree');
    var frag = document.createDocumentFragment();

    SECTIONS.forEach(function (sec) {
      var secEl = el('div', 't-sec open');
      secEl.setAttribute('data-sec', sec.slug);
      var row = el('div', 'trow sec');

      var caret = el('button', 'caret');
      caret.type = 'button';
      caret.setAttribute('aria-expanded', 'true');
      caret.setAttribute('aria-label', 'Collapse ' + sec.name);
      caret.innerHTML = CARET;
      caret.addEventListener('click', function () { toggleOpen(secEl, caret, 'Collapse ' + sec.name, 'Expand ' + sec.name); });

      var cb = makeCheckbox({ 'data-sec-check': sec.slug, 'aria-label': sec.name + ' visibility' }, function (input) {
        sec.groups.forEach(function (g) { g.types.forEach(function (t) { setTypeVisible(t.slug, input.checked); }); });
        input.indeterminate = false;
        markers.refilter();
        syncChecks();
      });

      var name = el('button', 'tname', sec.name);
      name.type = 'button';
      name.title = 'Zoom to ' + sec.name;
      name.addEventListener('click', function () { fitMarkers(MARKERS.filter(function (m) { return m._s === sec.slug; })); });

      var count = countEl('tcount');
      var actions = el('div', 't-actions');
      ['all', 'none', 'only'].forEach(function (mode) {
        var b = el('button', 'mini', mode);
        b.type = 'button';
        b.title = mode + ' for ' + sec.name;
        b.addEventListener('click', function (ev) { ev.stopPropagation(); applyMode(sec, mode); });
        actions.appendChild(b);
      });

      row.appendChild(caret); row.appendChild(cb.label); row.appendChild(name); row.appendChild(count); row.appendChild(actions);
      secEl.appendChild(row);

      var barWrap = el('div', 'mini-bar');
      var barFill = document.createElement('i');
      barWrap.appendChild(barFill);
      secEl.appendChild(barWrap);

      var body = el('div', 'tbody');

      sec.groups.forEach(function (g) {
        var gEl = el('div', 't-grp open');
        gEl.setAttribute('data-grp', g.slug);
        var gRow = el('div', 'trow grp');

        var gCaret = el('button', 'caret');
        gCaret.type = 'button';
        gCaret.setAttribute('aria-expanded', 'true');
        gCaret.setAttribute('aria-label', 'Collapse ' + g.name);
        gCaret.innerHTML = CARET;
        gCaret.addEventListener('click', function () { toggleOpen(gEl, gCaret, 'Collapse ' + g.name, 'Expand ' + g.name); });

        var gCb = makeCheckbox({ 'data-grp-check': g.slug, 'aria-label': g.name + ' visibility' }, function (input) {
          g.types.forEach(function (t) { setTypeVisible(t.slug, input.checked); });
          input.indeterminate = false;
          markers.refilter();
          syncChecks();
          syncSectionChecks();
        });

        var gName = el('button', 'tname', g.name);
        gName.type = 'button';
        gName.title = 'Zoom to ' + g.name;
        gName.addEventListener('click', function () { fitMarkers(MARKERS.filter(function (m) { return m._g === g.slug; })); });

        var gCount = countEl('tcount');
        var gActions = el('div', 't-actions');
        ['all', 'none', 'only'].forEach(function (mode) {
          var b = el('button', 'mini', mode);
          b.type = 'button';
          b.title = mode + ' for ' + g.name;
          b.addEventListener('click', function (ev) { ev.stopPropagation(); applyMode(g, mode); });
          gActions.appendChild(b);
        });

        gRow.appendChild(gCaret); gRow.appendChild(gCb.label); gRow.appendChild(gName); gRow.appendChild(gCount); gRow.appendChild(gActions);
        gEl.appendChild(gRow);

        var gBarWrap = el('div', 'mini-bar');
        var gBarFill = document.createElement('i');
        gBarWrap.appendChild(gBarFill);
        gEl.appendChild(gBarWrap);

        var gBody = el('div', 'tbody');
        g.types.forEach(function (t) {
          var tRow = el('div', 'type-row');
          tRow.setAttribute('data-type', t.slug);
          var tCb = makeCheckbox({ 'data-type-check': t.slug, 'aria-label': 'Show ' + t.name }, function (input) {
            setTypeVisible(t.slug, input.checked);
            markers.refilter();
            syncSectionChecks();
          });
          var sw = el('span', 'swatch');
          sw.setAttribute('style', swatchCss(t.icon, 18));
          var tName = el('button', 'tname', t.name);
          tName.type = 'button';
          tName.title = 'Zoom to ' + t.name + ' (' + t.count + ')';
          tName.addEventListener('click', function () { fitMarkers(MARKERS.filter(function (m) { return m.t === t.slug; })); });
          var tCount = countEl('tcount');
          tRow.appendChild(tCb.label); tRow.appendChild(sw); tRow.appendChild(tName); tRow.appendChild(tCount);
          gBody.appendChild(tRow);
          refs.type[t.slug] = { count: tCount, bar: null, check: tCb.input };
        });

        gEl.appendChild(gBody);
        body.appendChild(gEl);
        refs.group[g.slug] = { count: gCount, bar: gBarFill, check: gCb.input, el: gEl, def: g };
      });

      secEl.appendChild(body);
      frag.appendChild(secEl);
      refs.section[sec.slug] = { count: count, bar: barFill, check: cb.input, el: secEl, def: sec };
    });

    root.appendChild(frag);
    syncChecks();
  }

  function toggleOpen(container, caret, collapseLabel, expandLabel) {
    var open = container.classList.toggle('open');
    caret.setAttribute('aria-expanded', open ? 'true' : 'false');
    caret.setAttribute('aria-label', open ? collapseLabel : expandLabel);
  }

  function setTypeVisible(slug, visible) {
    if (visible) state.hidden.delete(slug);
    else state.hidden.add(slug);
    var ref = refs.type[slug];
    if (ref) ref.check.checked = visible;
  }

  function syncChecks() {
    Object.keys(refs.type).forEach(function (s) {
      var r = refs.type[s];
      r.check.checked = !state.hidden.has(s);
    });
    Object.keys(refs.group).forEach(function (s) {
      var g = groupInfo[s];
      var hiddenCount = g.types.filter(function (t) { return state.hidden.has(t.slug); }).length;
      var input = refs.group[s].check;
      input.checked = hiddenCount === 0;
      input.indeterminate = hiddenCount > 0 && hiddenCount < g.types.length;
    });
    syncSectionChecks();
  }

  function syncSectionChecks() {
    SECTIONS.forEach(function (sec) {
      var all = [];
      sec.groups.forEach(function (g) { g.types.forEach(function (t) { all.push(t.slug); }); });
      var hiddenCount = all.filter(function (s) { return state.hidden.has(s); }).length;
      var input = refs.section[sec.slug].check;
      input.checked = hiddenCount === 0;
      input.indeterminate = hiddenCount > 0 && hiddenCount < all.length;
    });
  }

  function applyMode(node, mode) {
    var types = [];
    if (node.types) types = node.types;
    else node.groups.forEach(function (g) { g.types.forEach(function (t) { types.push(t); }); });
    if (mode === 'all') {
      types.forEach(function (t) { state.hidden.delete(t.slug); });
    } else if (mode === 'none') {
      types.forEach(function (t) { state.hidden.add(t.slug); });
    } else {
      var keep = {};
      types.forEach(function (t) { keep[t.slug] = true; });
      Object.keys(typeInfo).forEach(function (s) { if (!keep[s]) state.hidden.add(s); });
      types.forEach(function (t) { state.hidden.delete(t.slug); });
    }
    syncChecks();
    markers.refilter();
    toast(mode === 'only' ? 'Showing only: ' + node.name : mode === 'none' ? 'Hid ' + node.name : 'Showing ' + node.name);
  }

  function fitMarkers(list) {
    if (!list || !list.length) return;
    if (list.length === 1) { map.flyTo([list[0].lat, list[0].lng], 16, { duration: 0.6 }); return; }
    var b = L.latLngBounds(list.map(function (m) { return [m.lat, m.lng]; }));
    map.flyToBounds(b, { padding: [60, 60], maxZoom: 15, duration: 0.6 });
  }

  /* ---------------------------------------------------------------- search */
  var searchEl = document.getElementById('search');
  var searchClear = document.getElementById('searchClear');
  var searchPanel = document.getElementById('searchPanel');
  var treePanel = document.getElementById('treePanel');
  var resultsEl = document.getElementById('results');
  var searchCountEl = document.getElementById('searchCount');
  var typeJumpsEl = document.getElementById('typeJumps');

  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function highlight(text, terms) {
    var out = escapeHtml(text);
    terms.forEach(function (t) {
      if (!t) return;
      out = out.replace(new RegExp('(' + escRe(escapeHtml(t)) + ')', 'gi'), '<mark>$1</mark>');
    });
    return out;
  }

  function snippet(m, terms) {
    if (!m.d) return '';
    var low = m.d.toLowerCase();
    var at = -1;
    for (var i = 0; i < terms.length; i++) {
      var k = low.indexOf(terms[i]);
      if (k >= 0 && (at < 0 || k < at)) at = k;
    }
    if (at < 0) at = 0;
    var start = Math.max(0, at - 55);
    var text = m.d.slice(start, start + 180).replace(/\s+/g, ' ').trim();
    return (start > 0 ? '… ' : '') + highlight(text, terms) + (start + 180 < m.d.length ? ' …' : '');
  }

  var NOTE_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h7.5L13 5v8.5H3z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5 6h6M5 8.5h6M5 11h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  var IMG_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="6" cy="6.5" r="1.1" fill="currentColor"/><path d="M3 11.5l3-3 2.5 2.5L11 8.5l2 3" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';

  function makeResult(m, terms) {
    var b = el('button', 'res' + (state.found.has(m.id) ? ' is-found' : ''));
    b.type = 'button';
    b.setAttribute('data-id', m.id);
    var sw = el('span', 'swatch');
    sw.setAttribute('style', swatchCss(m.i, 20));

    var main = el('span', 'res-main');
    var nm = el('span', 'res-name');
    nm.innerHTML = highlight(m.n, terms);
    var meta = el('span', 'res-meta');
    meta.textContent = m._ti.name + ' · ' + m._ti.groupName;
    main.appendChild(nm); main.appendChild(meta);
    var sn = snippet(m, terms);
    if (sn) {
      var snEl = el('span', 'res-snip');
      snEl.innerHTML = sn;
      main.appendChild(snEl);
    }

    var badges = el('span', 'res-badges');
    if (m.d) { var nb = el('span'); nb.innerHTML = NOTE_SVG; nb.title = 'Guide notes available'; badges.appendChild(nb); }
    if (m.p && m.p.length) { var ib = el('span'); ib.innerHTML = IMG_SVG; ib.title = m.p.length + ' screenshot(s)' + (IMGS.available ? '' : ' (not downloaded)'); badges.appendChild(ib); }
    if (noteOf(m.id)) {
      var nb2 = el('span', 'res-mynote');
      nb2.innerHTML = NOTE_SVG;
      nb2.title = 'My note: ' + noteOf(m.id).slice(0, 120);
      badges.appendChild(nb2);
    }

    b.appendChild(sw); b.appendChild(main); b.appendChild(badges);
    if (state.found.has(m.id)) { var f = el('span', 'res-found', '✓'); b.appendChild(f); }
    b.addEventListener('click', function () { focusMarker(m); });
    return b;
  }

  function focusMarker(m) {
    markers.select(m.id);
    var z = Math.max(map.getZoom(), 15);
    map.flyTo([m.lat, m.lng], z, { duration: 0.7 });
    var open = function () { openMarker(m, false); map.off('moveend', open); };
    map.once('moveend', open);
    setTimeout(function () { if (state.selectedId === m.id) openMarker(m, false); }, 850);
    if (window.innerWidth <= 980) closeSidebar();
  }

  function runSearch(q) {
    state.query = q;
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    resultsEl.innerHTML = '';
    typeJumpsEl.innerHTML = '';

    if (!terms.length) {
      searchPanel.hidden = true;
      treePanel.hidden = false;
      searchClear.hidden = true;
      return;
    }
    searchClear.hidden = false;
    searchPanel.hidden = false;
    treePanel.hidden = true;

    var matches = [];
    // Search must obey the same filters as the map itself, otherwise it reports
    // markers that are not on screen. Keep this list in step with markers.refilter().
    var onlyList = state.onlyList ? listById(state.onlyList) : null;
    var listSet = null;
    if (onlyList) {
      listSet = Object.create(null);
      for (var li = 0; li < onlyList.markerIds.length; li++) listSet[onlyList.markerIds[li]] = 1;
    }
    for (var i = 0; i < MARKERS.length; i++) {
      var m = MARKERS[i];
      if (state.hidden.has(m.t)) continue;
      var isFound = state.found.has(m.id);
      if (state.hideFound && isFound) continue;
      if (state.completion === 'found' && !isFound) continue;
      if (state.completion === 'unfound' && isFound) continue;
      if (state.onlyNotes && !noteOf(m.id)) continue;
      if (listSet && !listSet[m.id]) continue;
      var noteLow = state.notes[m.id] ? String(state.notes[m.id]).toLowerCase() : '';
      var ok = true;
      for (var t = 0; t < terms.length; t++) {
        if (m._q.indexOf(terms[t]) < 0 && noteLow.indexOf(terms[t]) < 0) { ok = false; break; }
      }
      if (ok) matches.push(m);
    }

    var typeMatches = Object.keys(typeInfo).filter(function (s) {
      var ti = typeInfo[s];
      var hay = (ti.name + ' ' + ti.groupName).toLowerCase();
      return terms.every(function (t) { return hay.indexOf(t) >= 0; });
    });
    typeMatches.slice(0, 8).forEach(function (s) {
      var ti = typeInfo[s];
      var tb = el('button', null, ti.name + ' (' + ti.count + ')');
      tb.type = 'button';
      tb.addEventListener('click', function () { fitMarkers(MARKERS.filter(function (m) { return m.t === s; })); });
      typeJumpsEl.appendChild(tb);
    });

    searchCountEl.textContent = fmt(matches.length) + (matches.length === 1 ? ' result' : ' results');

    var frag = document.createDocumentFragment();
    var limit = Math.min(matches.length, 250);
    for (var j = 0; j < limit; j++) frag.appendChild(makeResult(matches[j], terms));
    resultsEl.appendChild(frag);
    if (matches.length > limit) {
      resultsEl.appendChild(el('div', 'more-note', 'Showing first ' + limit + ' of ' + fmt(matches.length) + ' — refine your search'));
    }
    if (!matches.length) {
      resultsEl.appendChild(el('div', 'more-note', 'No markers match “' + q + '”.'));
    }
  }

  var searchTimer = 0;
  searchEl.addEventListener('input', function () {
    clearTimeout(searchTimer);
    var v = searchEl.value;
    searchTimer = setTimeout(function () { runSearch(v.trim()); }, 130);
  });
  searchEl.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { searchEl.value = ''; runSearch(''); searchEl.blur(); }
    if (e.key === 'Enter') {
      var first = resultsEl.querySelector('.res');
      if (first) first.click();
    }
  });
  searchClear.addEventListener('click', function () { searchEl.value = ''; runSearch(''); searchEl.focus(); });

  /* ------------------------------------------------------------- jump/type */
  function buildJumpSelect() {
    var sel = document.getElementById('typeJump');
    var none = document.createElement('option');
    none.value = ''; none.textContent = 'Jump to type…';
    sel.appendChild(none);
    TAX.groups.forEach(function (g) {
      var og = document.createElement('optgroup');
      og.label = g.name;
      g.types.forEach(function (t) {
        var o = document.createElement('option');
        o.value = t.slug;
        o.textContent = t.name + ' (' + t.count + ')';
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    sel.addEventListener('change', function () {
      var s = sel.value;
      sel.value = '';
      if (!s) return;
      state.hidden.delete(s);
      syncChecks();
      markers.refilter();
      fitMarkers(MARKERS.filter(function (m) { return m.t === s; }));
      var r = refs.type[s];
      if (r) r.count.scrollIntoView({ block: 'center', nearest: 'nearest' });
    });
  }

  /* ---------------------------------------------------------------- regions */
  var regionsUI = { shapes: true, labels: true, polyGroup: null, labelGroup: null, labels: [] };

  function buildRegions() {
    var host = document.getElementById('regions');
    var ctl = document.getElementById('regionCtl');
    if (!REGIONS.length) {
      if (ctl) ctl.hidden = true;
      if (host) host.hidden = true;
      return;
    }

    regionsUI.polyGroup = L.layerGroup().addTo(map);
    regionsUI.labelGroup = L.layerGroup().addTo(map);

    REGIONS.forEach(function (r) {
      var isState = !r.parent;
      // regions_full.json ring is a flat list of [lng, lat] pairs
      var latlngs = (r.ring || []).map(function (p) { return [p[1], p[0]]; });
      if (latlngs.length < 3) return;
      var poly = L.polygon(latlngs, {
        pane: 'regions',
        interactive: false,
        color: isState ? '#f472b6' : '#67e8f9',
        weight: isState ? 1.6 : 1,
        opacity: isState ? 0.8 : 0.5,
        dashArray: isState ? '7 6' : null,
        fillColor: isState ? '#f472b6' : '#38bdf8',
        fillOpacity: isState ? 0.03 : 0.055,
        className: 'region-shape ' + (isState ? 'region-state' : 'region-county')
      });
      poly.addTo(regionsUI.polyGroup);

      var label = L.marker([r.lat, r.lng], {
        pane: 'regions',
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: 'region-label' + (isState ? ' state' : ''),
          html: '<span>' + escapeHtml(r.title) + '</span>',
          iconSize: null,
          iconAnchor: [0, 0]
        })
      });
      label._minZoom = isState ? 10 : 12.5;
      regionsUI.labels.push(label);
      label.addTo(regionsUI.labelGroup);

      var b = el('button', 'region-chip' + (isState ? ' state' : ''), r.title);
      b.type = 'button';
      b.title = 'Zoom to ' + r.title;
      b.addEventListener('click', function () { flyToRegion(r); });
      host.appendChild(b);
    });

    function flyToRegion(r) {
      var bb = r.bounds ? L.latLngBounds(r.bounds[0], r.bounds[1])
                        : L.latLngBounds([r.lat, r.lng], [r.lat, r.lng]);
      map.flyToBounds(bb, { padding: [40, 40], maxZoom: 14, duration: 0.7 });
    }

    var shapesCb = document.getElementById('regionsShapes');
    var labelsCb = document.getElementById('regionsLabels');
    if (shapesCb) {
      shapesCb.checked = regionsUI.shapes;
      shapesCb.addEventListener('change', function () { setRegionShapes(shapesCb.checked); });
    }
    if (labelsCb) {
      labelsCb.checked = regionsUI.labels;
      labelsCb.addEventListener('change', function () { setRegionLabels(labelsCb.checked); });
    }
    map.on('zoomend', syncRegionLabels);
    syncRegionLabels();
  }

  function setRegionShapes(on) {
    regionsUI.shapes = !!on;
    if (!regionsUI.polyGroup) return;
    if (on) regionsUI.polyGroup.addTo(map);
    else map.removeLayer(regionsUI.polyGroup);
  }

  function setRegionLabels(on) {
    regionsUI.labelsOn = !!on;
    var cb = document.getElementById('regionsLabels');
    if (cb) cb.checked = !!on;
    syncRegionLabels();
  }

  /* labels stay hidden below their own zoom threshold so the map stays clean */
  function syncRegionLabels() {
    var z = map.getZoom();
    var on = regionsUI.labelsOn !== false;
    regionsUI.labels.forEach(function (m) {
      var want = on && z >= (m._minZoom || 10);
      var has = map.hasLayer(m);
      if (want && !has) m.addTo(map);
      else if (!want && has) map.removeLayer(m);
    });
    regionsUI.labelsVisible = on;
  }

  /* --------------------------------------------------------------- heatmaps */
  var heatUI = {
    on: false,
    sel: null,                 // Set of enabled layer ids
    layerById: Object.create(null),
    rows: Object.create(null),
    groups: [],
    filter: ''
  };
  var heatLayer = null;

  function buildHeatPanel() {
    var idx = HEAT.index || [];
    var panel = document.getElementById('heatPanel');
    var body = document.getElementById('heatBody');
    var host = document.getElementById('heatGroups');
    var metaEl = document.getElementById('heatMeta');
    var statEl = document.getElementById('heatStat');
    if (!panel) return;

    heatUI.sel = new Set();
    var valid = Object.create(null);
    idx.forEach(function (h) {
      heatUI.layerById[h.id] = h;
      valid[h.id] = 1;
    });
    (state.heatIds || []).forEach(function (id) { if (valid[id]) heatUI.sel.add(id); });
    state.heatIds = Array.from(heatUI.sel);
    heatUI.on = !!state.heatOn && heatUI.sel.size > 0;

    if (!idx.length) {
      metaEl.textContent = 'not in this build';
      if (statEl) statEl.textContent = 'No heatmap layers were extracted for this build.';
      var on0 = document.getElementById('heatOn');
      if (on0) on0.disabled = true;
      return;
    }

    metaEl.textContent = fmt(idx.length) + ' layers';

    /* group by label, preserving the ordering the data itself ships with */
    var groups = [];
    var byLabel = Object.create(null);
    idx.forEach(function (h) {
      var key = h.label || 'Other';
      var g = byLabel[key];
      if (!g) { g = byLabel[key] = { label: key, layers: [] }; groups.push(g); }
      g.layers.push(h);
    });
    groups.sort(function (a, b) { return a.label.localeCompare(b.label); });
    heatUI.groups = groups;

    var frag = document.createDocumentFragment();
    groups.forEach(function (g) {
      var gi = heatUI.groups.indexOf(g);
      var box = el('div', 'h-grp');
      var row = el('div', 'hrow');
      var caret = el('button', 'caret');
      caret.type = 'button';
      caret.setAttribute('aria-expanded', 'false');
      caret.setAttribute('aria-label', 'Expand ' + g.label);
      caret.innerHTML = CARET;
      caret.addEventListener('click', function () {
        var open = box.classList.toggle('open');
        caret.setAttribute('aria-expanded', open ? 'true' : 'false');
        caret.setAttribute('aria-label', (open ? 'Collapse ' : 'Expand ') + g.label);
      });
      var cb = makeCheckbox({ 'data-heat-grp': g.label, 'aria-label': g.label + ' heatmap layers' }, function (input) {
        g.layers.forEach(function (h) {
          if (input.checked) heatUI.sel.add(h.id);
          else heatUI.sel.delete(h.id);
        });
        input.indeterminate = false;
        heatChanged();
      });
      cb.input.checked = false;
      var name = el('button', 'hname', g.label);
      name.type = 'button';
      name.title = 'Zoom to ' + g.label;
      name.addEventListener('click', function () {
        var pts = [];
        g.layers.forEach(function (h) {
          var l = HEAT.layers[h.id];
          if (l && l.points && l.points.length) pts.push(l.points[0]);
        });
        if (pts.length) map.flyToBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 14, duration: 0.6 });
      });
      var count = el('span', 'tcount', String(g.layers.length));
      row.appendChild(caret); row.appendChild(cb.label); row.appendChild(name); row.appendChild(count);

      var bodyEl = el('div', 'hbody');
      g.layers.forEach(function (h) {
        var lrow = el('label', 'h-layer');
        var inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.setAttribute('data-heat-layer', h.id);
        inp.setAttribute('aria-label', 'Show ' + h.title + ' heatmap');
        inp.checked = heatUI.sel.has(h.id);
        var box2 = el('span', 'cbx');
        inp.addEventListener('change', function () {
          if (inp.checked) heatUI.sel.add(h.id);
          else heatUI.sel.delete(h.id);
          heatChanged();
        });
        var title = el('span', 'h-title', h.title || h.id);
        title.title = h.title || h.id;
        var n = el('span', 'h-n', fmt(h.n || 0));
        lrow.appendChild(inp); lrow.appendChild(box2); lrow.appendChild(title); lrow.appendChild(n);
        bodyEl.appendChild(lrow);
        heatUI.rows[h.id] = { input: inp, row: lrow, layer: h };
      });
      box.appendChild(row); box.appendChild(bodyEl);
      heatUI.groups[gi].el = box;
      heatUI.groups[gi].check = cb.input;
      frag.appendChild(box);
    });
    host.appendChild(frag);

    var masterCb = document.getElementById('heatOn');
    if (masterCb) {
      masterCb.checked = !!heatUI.on;
      masterCb.addEventListener('change', function () {
        heatUI.on = masterCb.checked;
        if (heatUI.on && !heatUI.sel.size) {
          // first enable: pre-select the currently visible group's first layer
          var first = idx[0];
          if (first) { heatUI.sel.add(first.id); var r = heatUI.rows[first.id]; if (r) r.input.checked = true; }
        }
        heatChanged();
      });
    }

    var toggle = document.getElementById('heatToggle');
    if (toggle && body) {
      toggle.addEventListener('click', function () {
        var open = body.hidden;
        body.hidden = !open;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        panel.classList.toggle('open', open);
        if (open) ensureHeatLayer();     // lazily create the canvas
        heatChanged();
      });
    }

    var filter = document.getElementById('heatFilter');
    if (filter) {
      filter.addEventListener('input', function () {
        heatUI.filter = filter.value.trim().toLowerCase();
        applyHeatFilter();
      });
    }

    document.querySelectorAll('[data-heat]').forEach(function (b) {
      b.addEventListener('click', function () {
        var mode = b.getAttribute('data-heat');
        if (mode === 'none') {
          heatUI.sel.clear();
        } else {
          idx.forEach(function (h) {
            if (heatUI.filter && (h.title + ' ' + h.label).toLowerCase().indexOf(heatUI.filter) < 0) return;
            heatUI.sel.add(h.id);
          });
          if (mode === 'all' && !heatUI.on) {
            heatUI.on = true;
            var mc = document.getElementById('heatOn');
            if (mc) mc.checked = true;
          }
        }
        heatChanged();
      });
    });

    syncHeatInputs();
    heatChanged();
  }

  function applyHeatFilter() {
    var q = heatUI.filter;
    heatUI.groups.forEach(function (g) {
      var shown = 0;
      g.layers.forEach(function (h) {
        var r = heatUI.rows[h.id];
        if (!r) return;
        var hit = !q || (h.title + ' ' + h.label).toLowerCase().indexOf(q) >= 0;
        r.row.hidden = !hit;
        if (hit) shown++;
      });
      if (g.el) g.el.hidden = shown === 0;
    });
  }

  function syncHeatInputs() {
    heatUI.groups.forEach(function (g) {
      var on = 0;
      g.layers.forEach(function (h) {
        var r = heatUI.rows[h.id];
        if (!r) return;
        r.input.checked = heatUI.sel.has(h.id);
        if (r.input.checked) on++;
      });
      if (g.check) {
        g.check.checked = on === g.layers.length && on > 0;
        g.check.indeterminate = on > 0 && on < g.layers.length;
      }
    });
  }

  function ensureHeatLayer() {
    if (heatLayer || !window.GTA6Heat) return heatLayer;
    heatLayer = window.GTA6Heat.create(map, { pane: 'heat' });
    return heatLayer;
  }

  function heatChanged() {
    state.heatIds = Array.from(heatUI.sel);
    state.heatOn = heatUI.on;
    syncHeatInputs();
    applyHeat();
    saveProgress();
  }

  function heatPoints() {
    var total = 0;
    heatUI.sel.forEach(function (id) {
      var h = heatUI.layerById[id];
      if (h) total += h.n || 0;
    });
    return total;
  }

  var MAX_RENDER_LAYERS = 16;   // per-frame render cap; the data itself is never trimmed

  function applyHeat() {
    var statEl = document.getElementById('heatStat');
    var n = heatUI.sel.size;
    var pts = heatPoints();
    var host = document.getElementById('heatGroups');
    var panelOpen = host && host.offsetParent !== null;

    if (!heatUI.on || !n || !panelOpen) {
      if (heatLayer) heatLayer.setLayers([]);
      if (statEl) {
        var why = !panelOpen ? ' (open the panel to draw)' : (!heatUI.on ? ' (overlay off)' : '');
        statEl.textContent = n
          ? fmt(pts) + ' points in ' + fmt(n) + (n === 1 ? ' layer' : ' layers') + why
          : (HEAT.pending ? fmt(HEAT.available) + ' of ' + fmt(HEAT.declared) + ' layers available in this build'
                          : 'No layers enabled');
      }
      return;
    }

    var picked = [];
    heatUI.sel.forEach(function (id) {
      var h = heatUI.layerById[id];
      var l = HEAT.layers[id];
      if (!h || !l || !l.points || !l.points.length) return;   // degrade silently
      picked.push({ id: id, h: h, l: l, n: h.n || l.points.length });
    });
    // Drawing hundreds of layers at once is a canvas cost with no visual gain:
    // render the densest ones and say so. No point data is ever discarded.
    picked.sort(function (a, b) { return b.n - a.n; });
    var capped = picked.length > MAX_RENDER_LAYERS;
    var layers = picked.slice(0, MAX_RENDER_LAYERS).map(function (x) {
      return { id: x.id, points: x.l.points, style: x.h.style || {} };
    });

    var hl = ensureHeatLayer();
    if (!hl) return;
    hl.setLayers(layers);
    if (statEl) {
      var s = hl.stats();
      statEl.textContent = fmt(pts) + ' points in ' + fmt(n) + (n === 1 ? ' layer' : ' layers') +
        (capped ? ' · drawing ' + MAX_RENDER_LAYERS + ' densest' : '') +
        (s.ms ? ' · ' + s.ms + ' ms' : '') + (s.budgeted ? ' · ' + fmt(s.budgeted) + ' subsampled' : '');
    }
  }

  /* ------------------------------------------------------------- checklists */
  function renderLists() {
    var host = document.getElementById('lists');
    var meta = document.getElementById('listMeta');
    if (!host) return;
    host.innerHTML = '';
    listRefs = Object.create(null);
    if (meta) meta.textContent = String(state.lists.length);

    if (!state.lists.length) {
      host.appendChild(el('div', 'empty-note', 'No checklists yet — create one above, then add markers from their popup.'));
      syncListFilterUI();
      return;
    }

    state.lists.forEach(function (l) {
      var total = l.markerIds.length;
      var done = 0;
      l.markerIds.forEach(function (id) { if (state.found.has(id)) done++; });
      var item = el('div', 'list-item' + (state.onlyList === l.id ? ' active' : ''));
      var top = el('div', 'li-top');
      top.appendChild(el('b', 'li-name', l.name));
      var countEl2 = el('span', 'li-count', done + '/' + total + (total ? ' · ' + Math.round(done / total * 100) + '%' : ''));
      top.appendChild(countEl2);
      item.appendChild(top);
      var bar = el('div', 'bar thin');
      var fill = document.createElement('i');
      fill.style.width = (total ? (done / total) * 100 : 0) + '%';
      bar.appendChild(fill);
      item.appendChild(bar);
      listRefs[l.id] = { count: countEl2, fill: fill };

      var acts = el('div', 'li-actions');
      var only = el('button', 'mini', state.onlyList === l.id ? 'Showing only' : 'Show only');
      only.type = 'button';
      only.addEventListener('click', function () {
        state.onlyList = state.onlyList === l.id ? null : l.id;
        saveProgress();
        renderLists();
        markers.refilter();
        toast(state.onlyList ? 'Showing only: ' + l.name : 'Filter cleared');
      });
      var ren = el('button', 'mini', 'Rename');
      ren.type = 'button';
      ren.addEventListener('click', function () {
        var v = window.prompt('Checklist name', l.name);
        if (v == null) return;
        v = String(v).trim().slice(0, 60);
        if (!v) return;
        l.name = v;
        saveProgress();
        renderLists();
      });
      var del = el('button', 'mini danger', 'Delete');
      del.type = 'button';
      del.addEventListener('click', function () {
        if (!window.confirm('Delete checklist “' + l.name + '”?')) return;
        state.lists = state.lists.filter(function (x) { return x.id !== l.id; });
        if (state.onlyList === l.id) state.onlyList = null;
        saveProgress();
        renderLists();
        recount();
        markers.refilter();
      });
      acts.appendChild(only); acts.appendChild(ren); acts.appendChild(del);
      item.appendChild(acts);
      host.appendChild(item);
    });
    syncListFilterUI();
  }

  function syncListFilterUI() {
    var wrap = document.getElementById('onlyListWrap');
    var cb = document.getElementById('onlyList');
    var nameEl = document.getElementById('onlyListName');
    var l = state.onlyList ? listById(state.onlyList) : null;
    if (!wrap || !cb) return;
    if (!state.lists.length) {
      wrap.hidden = true;
      cb.checked = false;
      if (state.onlyList) state.onlyList = null;
      return;
    }
    wrap.hidden = false;
    cb.checked = !!state.onlyList;
    if (nameEl) nameEl.textContent = l ? 'Only: ' + l.name : 'Only selected list';
  }

  function buildListPanel() {
    var addBtn = document.getElementById('newListBtn');
    var input = document.getElementById('newListName');
    var body = document.getElementById('listsBody');
    var toggle = document.getElementById('listsToggle');
    if (toggle && body) {
      toggle.addEventListener('click', function () {
        var open = body.hidden;
        body.hidden = !open;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        var fold = toggle.closest ? toggle.closest('.fold') : null;
        if (fold) fold.classList.toggle('open', open);
      });
    }
    function create() {
      var name = (input.value || '').trim().slice(0, 60);
      if (!name) { input.focus(); return; }
      var l = { id: uid('list:'), name: name, markerIds: [] };
      state.lists.push(l);
      input.value = '';
      saveProgress();
      renderLists();
      toast('Checklist “' + name + '” created');
    }
    if (addBtn) addBtn.addEventListener('click', create);
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') create(); });

    var onlyCb = document.getElementById('onlyList');
    if (onlyCb) onlyCb.addEventListener('change', function () {
      if (!onlyCb.checked) state.onlyList = null;
      else if (!state.onlyList && state.lists.length) {
        var missing = state.lists.filter(function (l) { return l.markerIds.length; })[0];
        state.onlyList = (missing || state.lists[0]).id;
      }
      saveProgress();
      renderLists();
      markers.refilter();
    });

    renderLists();
  }

  /* ---------------------------------------------------------- custom markers */
  var addForm = document.getElementById('addForm');
  var addState = { latlng: null, color: MARKER_COLORS[0], point: null };

  function buildCustomPanel() {
    var body = document.getElementById('customBody');
    var toggle = document.getElementById('customToggle');
    if (toggle && body) {
      toggle.addEventListener('click', function () {
        var open = body.hidden;
        body.hidden = !open;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        var fold = toggle.closest ? toggle.closest('.fold') : null;
        if (fold) fold.classList.toggle('open', open);
      });
    }
    var addBtn = document.getElementById('addMarkerBtn');
    if (addBtn) addBtn.addEventListener('click', function () { setAddMode(!state.adding); });

    var colors = document.getElementById('afColors');
    if (colors) {
      MARKER_COLORS.forEach(function (col) {
        var b = el('button', 'color-dot' + (col === addState.color ? ' on' : ''), '');
        b.type = 'button';
        b.setAttribute('style', 'background:' + col);
        b.setAttribute('aria-label', 'Colour ' + col);
        b.addEventListener('click', function () {
          addState.color = col;
          Array.prototype.forEach.call(colors.children, function (n) { n.classList.toggle('on', n === b); });
        });
        colors.appendChild(b);
      });
    }
    var save = document.getElementById('afSave');
    if (save) save.addEventListener('click', saveAddForm);
    var cancel = document.getElementById('afCancel');
    if (cancel) cancel.addEventListener('click', closeAddForm);
    var nameI = document.getElementById('afName');
    if (nameI) nameI.addEventListener('keydown', function (e) { if (e.key === 'Enter') saveAddForm(); });

    renderCustomList();
    updateAddModeUI();
  }

  function setAddMode(on) {
    state.adding = !!on;
    if (!state.adding && addForm) addForm.hidden = true;   // never recurse into closeAddForm
    updateAddModeUI();
    if (state.adding) {
      toast('Click the map to place a marker');
      if (window.innerWidth <= 980) closeSidebar();
    }
  }

  function updateAddModeUI() {
    var addBtn = document.getElementById('addMarkerBtn');
    if (addBtn) {
      addBtn.classList.toggle('on', state.adding);
      addBtn.setAttribute('aria-pressed', state.adding ? 'true' : 'false');
      addBtn.textContent = state.adding ? 'Click the map… (Esc to cancel)' : '＋ Add marker — then click the map';
    }
    var mapEl = document.getElementById('map');
    if (mapEl) mapEl.classList.toggle('adding', state.adding);
  }

  function openAddForm(latlng, point) {
    if (!addForm) return;
    addState.latlng = latlng;
    addState.point = point;
    addState.color = MARKER_COLORS[0];
    var nameI = document.getElementById('afName');
    var noteI = document.getElementById('afNote');
    if (nameI) nameI.value = '';
    if (noteI) noteI.value = '';
    var colors = document.getElementById('afColors');
    if (colors) Array.prototype.forEach.call(colors.children, function (n, i) { n.classList.toggle('on', i === 0); });
    var wrapEl = document.getElementById('mapwrap');
    var size = map.getSize();
    var px = Math.min(Math.max(12, point.x + 12), Math.max(12, size.x - 220));
    var py = Math.min(Math.max(12, point.y - 10), Math.max(12, size.y - 190));
    addForm.style.left = px + 'px';
    addForm.style.top = py + 'px';
    addForm.hidden = false;
    if (nameI) nameI.focus();
  }

  function closeAddForm() {
    if (addForm) addForm.hidden = true;
    addState.latlng = null;
    addState.point = null;
    setAddMode(false);
  }

  function saveAddForm() {
    if (!addState.latlng) { closeAddForm(); return; }
    var nameI = document.getElementById('afName');
    var noteI = document.getElementById('afNote');
    var name = ((nameI && nameI.value) || '').trim().slice(0, 80) || 'Untitled marker';
    var c = sanitizeCustom({
      id: uid(CUSTOM_PREFIX),
      name: name,
      lat: addState.latlng.lat,
      lng: addState.latlng.lng,
      color: addState.color,
      note: (noteI && noteI.value) || ''
    });
    if (!c) { toast('Could not place a marker there'); return; }
    state.custom.push(c);
    addState.latlng = null;
    saveProgress();
    renderCustomList();
    markers.schedule();
    var f = addForm;
    if (f) f.hidden = true;
    setAddMode(false);
    toast('Marker “' + c.name + '” added');
    openCustomPopup(c, false);
  }

  function renderCustomList() {
    var host = document.getElementById('customList');
    var meta = document.getElementById('customMeta');
    if (!host) return;
    host.innerHTML = '';
    if (meta) meta.textContent = String(state.custom.length);
    if (!state.custom.length) {
      host.appendChild(el('div', 'empty-note', 'No personal markers yet.'));
      return;
    }
    state.custom.forEach(function (c) {
      var row = el('div', 'custom-item');
      var dot = el('i', 'cd');
      dot.setAttribute('style', 'background:' + (c.color || MARKER_COLORS[0]));
      var name = el('button', 'ci-name', c.name);
      name.type = 'button';
      name.title = c.name + ' — click to fly';
      name.addEventListener('click', function () { map.flyTo([c.lat, c.lng], Math.max(map.getZoom(), 15), { duration: 0.6 }); openCustomPopup(c, false); });
      var del = el('button', 'mini danger', '✕');
      del.type = 'button';
      del.setAttribute('aria-label', 'Delete ' + c.name);
      del.addEventListener('click', function () {
        if (!window.confirm('Delete “' + c.name + '”?')) return;
        state.custom = state.custom.filter(function (x) { return x.id !== c.id; });
        state.lists.forEach(function (l) {
          var i = l.markerIds.indexOf(c.id);
          if (i >= 0) l.markerIds.splice(i, 1);
        });
        setNote(c.id, '');
        saveProgress(); renderCustomList(); renderLists(); recount(); markers.schedule();
      });
      row.appendChild(dot); row.appendChild(name); row.appendChild(del);
      host.appendChild(row);
    });
  }

  /* ------------------------------------------------- completion + chips */
  function buildFilterUI() {
    var seg = document.getElementById('completionSeg');
    if (seg) {
      seg.querySelectorAll('[data-completion]').forEach(function (b) {
        b.addEventListener('click', function () {
          state.completion = b.getAttribute('data-completion');
          saveProgress();
          syncFilterUI();
          markers.refilter();
          if (state.query) runSearch(state.query);
        });
      });
    }
    var onlyNotes = document.getElementById('onlyNotes');
    if (onlyNotes) {
      onlyNotes.checked = !!state.onlyNotes;
      onlyNotes.addEventListener('change', function () {
        state.onlyNotes = onlyNotes.checked;
        saveProgress();
        markers.refilter();
      });
    }
    syncFilterUI();
  }

  function syncFilterUI() {
    var seg = document.getElementById('completionSeg');
    if (seg) {
      seg.querySelectorAll('[data-completion]').forEach(function (b) {
        var on = b.getAttribute('data-completion') === state.completion;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    var onlyNotes = document.getElementById('onlyNotes');
    if (onlyNotes) onlyNotes.checked = !!state.onlyNotes;
  }

  /* ---------------------------------------------------------------- tools */
  var toastEl = document.getElementById('toast');
  var toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2600);
  }

  document.getElementById('hideFound').addEventListener('change', function (e) {
    state.hideFound = e.target.checked;
    saveProgress();
    markers.refilter();
    if (state.query) runSearch(state.query);
  });

  /* ------------------------------------------------------- export / import */
  function exportData() {
    return {
      app: 'gta6-leonida-offline',
      version: 2,
      exportedAt: new Date().toISOString(),
      total: totalMarkers,
      found: Array.from(state.found).sort(),
      notes: state.notes,
      custom: state.custom,
      lists: state.lists,
      hidden: Array.from(state.hidden).sort(),
      hideFound: state.hideFound,
      theme: state.theme,
      completion: state.completion,
      onlyNotes: state.onlyNotes,
      onlyList: state.onlyList,
      heat: state.heatIds,
      heatOn: state.heatOn
    };
  }

  function refreshAllUI() {
    var hf = document.getElementById('hideFound');
    if (hf) hf.checked = state.hideFound;
    document.documentElement.setAttribute('data-theme', state.theme);
    syncChecks();
    syncFilterUI();
    renderLists();
    renderCustomList();
    recount();
    markers.refilter();
    if (heatUI.sel) {
      var valid = Object.create(null);
      (HEAT.index || []).forEach(function (h) { valid[h.id] = 1; });
      var next = new Set();
      (state.heatIds || []).forEach(function (id) { if (valid[id]) next.add(id); });
      heatUI.sel = next;
      heatUI.on = !!state.heatOn && next.size > 0;
      var mc = document.getElementById('heatOn');
      if (mc) mc.checked = heatUI.on;
      syncHeatInputs();
      applyHeat();
    }
    syncRegionLabels();
    if (state.query) runSearch(state.query);
  }

  /* Accepts both v1 (found-only) and v2 documents; v1 never wipes v2 data. */
  function importData(data) {
    if (!data || typeof data !== 'object') return { ok: false, reason: 'not-an-object' };
    var arr = Array.isArray(data) ? data : (Array.isArray(data.found) ? data.found : null);
    if (!arr) return { ok: false, reason: 'no-found-list' };

    var added = 0, unknown = 0;
    var next = new Set();
    arr.forEach(function (id) {
      if (typeof id !== 'string') return;
      if (idIndex[id]) { next.add(id); added++; }
      else unknown++;
    });
    state.found = next;
    var counts = { found: added, unknown: unknown, notes: 0, custom: 0, lists: 0 };

    if (!Array.isArray(data)) {
      if (data.notes && typeof data.notes === 'object') {
        var notes = Object.create(null);
        Object.keys(data.notes).forEach(function (id) {
          if (typeof data.notes[id] !== 'string' || !data.notes[id].trim()) return;
          if (!idIndex[id] && id.indexOf(CUSTOM_PREFIX) !== 0) return;
          notes[id] = data.notes[id].slice(0, 4000);
        });
        state.notes = notes;
        counts.notes = Object.keys(notes).length;
      }
      if (Array.isArray(data.custom)) {
        state.custom = [];
        var seen = Object.create(null);
        data.custom.forEach(function (c) {
          var x = sanitizeCustom(c);
          if (!x || seen[x.id]) return;
          seen[x.id] = 1;
          state.custom.push(x);
        });
        counts.custom = state.custom.length;
      }
      if (Array.isArray(data.lists)) {
        state.lists = [];
        data.lists.forEach(function (l) {
          var x = sanitizeList(l);
          if (x) state.lists.push(x);
        });
        counts.lists = state.lists.length;
      }
      if (typeof data.hideFound === 'boolean') state.hideFound = data.hideFound;
      if (Array.isArray(data.hidden)) {
        state.hidden = new Set();
        data.hidden.forEach(function (s) { if (typeInfo[s]) state.hidden.add(s); });
      }
      if (data.theme === 'night' || data.theme === 'day') state.theme = data.theme;
      if (data.completion === 'all' || data.completion === 'found' || data.completion === 'unfound') {
        state.completion = data.completion;
      }
      if (typeof data.onlyNotes === 'boolean') state.onlyNotes = data.onlyNotes;
      if (Array.isArray(data.heat)) state.heatIds = data.heat.filter(function (id) { return typeof id === 'string'; });
      if (typeof data.heatOn === 'boolean') state.heatOn = data.heatOn;
      state.onlyList = (typeof data.onlyList === 'string' && listById(data.onlyList)) ? data.onlyList : null;
    }

    saveProgress();
    setTiles(state.theme);
    refreshAllUI();
    return { ok: true, added: added, unknown: unknown, notes: counts.notes, custom: counts.custom, lists: counts.lists };
  }

  document.getElementById('btnExport').addEventListener('click', function () {
    var payload = exportData();
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'gta6-leonida-progress-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('Exported ' + fmt(state.found.size) + ' found · ' +
          Object.keys(state.notes).length + ' notes · ' + state.custom.length + ' markers · ' + state.lists.length + ' lists');
  });

  var fileInput = document.getElementById('fileInput');
  document.getElementById('btnImport').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    var f = fileInput.files && fileInput.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(String(reader.result)); }
      catch (e) { toast('Import failed: not valid JSON'); return; }
      var arr = Array.isArray(data) ? data : (data && Array.isArray(data.found) ? data.found : null);
      if (!arr) { toast('Import failed: no "found" list in file'); return; }
      if (state.found.size && !window.confirm('Replace current progress (' + state.found.size + ' found) with ' + arr.length + ' entries from this file?')) {
        fileInput.value = '';
        return;
      }
      var res = importData(data);
      toast('Imported ' + fmt(res.added) + ' found markers' +
            (res.unknown ? ' (' + res.unknown + ' unknown ignored)' : '') +
            (res.notes ? ' · ' + res.notes + ' notes' : '') +
            (res.custom ? ' · ' + res.custom + ' markers' : '') +
            (res.lists ? ' · ' + res.lists + ' lists' : ''));
      fileInput.value = '';
    };
    reader.onerror = function () { toast('Import failed: could not read file'); };
    reader.readAsText(f);
  });

  document.getElementById('btnReset').addEventListener('click', function () {
    if (!state.found.size) { toast('Nothing to reset'); return; }
    if (!window.confirm('Reset all progress? This clears all ' + fmt(state.found.size) + ' found markers (notes, checklists and your own markers are kept).')) return;
    state.found.clear();
    saveProgress();
    recount();
    markers.refilter();
    if (state.query) runSearch(state.query);
    if (popMarker) openMarker(popMarker, false);
    toast('Progress reset');
  });

  /* ---------------------------------------------------------------- theme */
  var themeBtn = document.getElementById('themeBtn');
  var nightOk = false;

  function probeNight(cb) {
    var img = new Image();
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; cb(false); } }, 3500);
    img.onload = function () { if (done) return; done = true; clearTimeout(timer); cb(img.naturalWidth > 1); };
    img.onerror = function () { if (done) return; done = true; clearTimeout(timer); cb(false); };
    img.src = 'tiles-night/8/127/127.jpg';
  }

  function setTheme(t) {
    state.theme = t;
    document.documentElement.setAttribute('data-theme', t);
    setTiles(t);
    themeBtn.setAttribute('aria-pressed', t === 'night' ? 'true' : 'false');
    themeBtn.title = t === 'night' ? 'Night tiles — click for daytime' : 'Day tiles — click for night';
    saveProgress();
  }

  themeBtn.addEventListener('click', function () {
    if (state.theme === 'day' && !nightOk) { toast('Night tiles are not in this offline build (optional download).'); return; }
    setTheme(state.theme === 'night' ? 'day' : 'night');
  });

  /* ---------------------------------------------------- map buttons + hash */
  document.getElementById('zoomIn').addEventListener('click', function () { map.zoomIn(0.5); });
  document.getElementById('zoomOut').addEventListener('click', function () { map.zoomOut(0.5); });
  document.getElementById('fitBtn').addEventListener('click', function () {
    map.flyToBounds(bounds, { padding: [30, 30], duration: 0.7 });
  });

  var hashLock = false, lastHash = '';
  function writeHash() {
    if (hashLock) return;
    var c = map.getCenter();
    var h = '#' + (Math.round(map.getZoom() * 100) / 100) + '/' + c.lat.toFixed(6) + '/' + c.lng.toFixed(6);
    if (h === lastHash) return;
    lastHash = h;
    try {
      history.replaceState(null, '', h);
    } catch (e) {
      hashLock = true;
      location.hash = h;
      setTimeout(function () { hashLock = false; }, 80);
    }
  }
  map.on('moveend', writeHash);

  function readHash() {
    var m = /^#(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/.exec(location.hash || '');
    if (!m) return null;
    var z = parseFloat(m[1]), lat = parseFloat(m[2]), lng = parseFloat(m[3]);
    if (!isFinite(z) || !isFinite(lat) || !isFinite(lng)) return null;
    if (lat < 0 || lat > 1.4 || lng < -1.4 || lng > 0) return null;
    return { z: Math.max(9, Math.min(17, z)), lat: lat, lng: lng };
  }

  window.addEventListener('hashchange', function () {
    if (hashLock) return;
    var h = readHash();
    if (!h) return;
    if (String(location.hash) === lastHash) return;
    map.setView([h.lat, h.lng], h.z);
  });

  /* ----------------------------------------------------------- responsive */
  var body = document.body;
  var sbToggle = document.getElementById('sbToggle');
  var backdrop = document.getElementById('backdrop');
  function openSidebar() { body.classList.add('sb-open'); backdrop.hidden = false; sbToggle.setAttribute('aria-expanded', 'true'); }
  function closeSidebar() { body.classList.remove('sb-open'); backdrop.hidden = true; sbToggle.setAttribute('aria-expanded', 'false'); }
  sbToggle.addEventListener('click', function () {
    if (body.classList.contains('sb-open')) closeSidebar(); else openSidebar();
  });
  backdrop.addEventListener('click', closeSidebar);
  document.getElementById('sbClose').addEventListener('click', closeSidebar);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (lbOpen) { closeLightbox(); return; }
      if (state.adding || (addForm && !addForm.hidden)) { closeAddForm(); return; }
      if (body.classList.contains('sb-open')) closeSidebar();
      else if (state.selectedId) { map.closePopup(); markers.select(null); }
    }
    if (lbOpen) {
      if (e.key === 'ArrowRight') { e.preventDefault(); lbStep(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); lbStep(-1); }
      return;
    }
    if (e.key === '/' && document.activeElement !== searchEl) {
      e.preventDefault();
      if (window.innerWidth <= 980) openSidebar();
      searchEl.focus();
    }
  });

  /* ------------------------------------------------------------------ boot */
  loadProgress();
  document.documentElement.setAttribute('data-theme', state.theme);
  buildTree();
  buildJumpSelect();
  buildRegions();
  buildFilterUI();
  buildHeatPanel();
  buildListPanel();
  buildCustomPanel();
  markers.init();
  recount();

  var hideFoundEl = document.getElementById('hideFound');
  hideFoundEl.checked = state.hideFound;

  var start = readHash();
  if (start) map.setView([start.lat, start.lng], start.z);
  else map.setView([META.center.lat, META.center.lng], 12);

  markers.schedule();
  setTimeout(function () { map.invalidateSize(); markers.schedule(); }, 80);

  probeNight(function (ok) {
    nightOk = ok;
    themeBtn.setAttribute('aria-disabled', ok ? 'false' : 'true');
    if (!ok && state.theme === 'night') setTheme('day');
  });

  window.addEventListener('resize', function () { markers.schedule(); });

  // Tile health: probe a known tile directly. Leaflet's errorTileUrl placeholder fires
  // 'tileload' even when the real tile 404s, so event counters cannot tell "no imagery"
  // apart from "imagery present" — an explicit Image() probe can.
  (function tileHealthProbe() {
    var note = document.getElementById('mapNote');
    if (!note) return;
    var probe = new Image();
    probe.onerror = function () {
      note.textContent = '\u26a0 Map imagery is missing from this copy — the tiles/ folder (and tiles-night/) was not included.';
      note.hidden = false;
      note.classList.add('warn');
    };
    probe.onload = function () { note.hidden = true; note.classList.remove('warn'); };
    probe.src = 'tiles/8/127/127.jpg';
  })();

  /* ----------------------------------------------------------- debug hook */
  window.__gta6 = {
    map: map,
    state: state,
    markers: markers,
    openMarker: openMarker,
    toggleFound: toggleFound,
    fitMarkers: fitMarkers,
    runSearch: runSearch,
    openCustomPopup: openCustomPopup,
    exportData: exportData,
    importData: importData,
    addCustom: function (name, lat, lng, color, note) {
      var c = sanitizeCustom({ id: uid(CUSTOM_PREFIX), name: name, lat: lat, lng: lng, color: color, note: note });
      if (!c) throw new Error('invalid custom marker');
      state.custom.push(c);
      saveProgress(); renderCustomList(); markers.schedule();
      return c.id;
    },
    addList: function (name, ids) {
      var l = sanitizeList({ id: uid('list:'), name: name, markerIds: ids || [] });
      state.lists.push(l);
      saveProgress(); renderLists();
      return l.id;
    },
    setNote: function (id, text) { setNote(id, text); saveProgress(); markers.schedule(); recount(); },
    refresh: function () { refreshAllUI(); },
    heat: {
      index: function () { return HEAT.index; },
      enabled: function () { return Array.from(heatUI.sel || []); },
      enable: function (ids, on) {
        if (on === undefined) on = true;
        (Array.isArray(ids) ? ids : [ids]).forEach(function (id) {
          if (!heatUI.layerById[id]) return;
          if (on) heatUI.sel.add(id); else heatUI.sel.delete(id);
        });
        if (on && !heatUI.on) heatUI.on = true;
        var mc = document.getElementById('heatOn');
        if (mc) mc.checked = heatUI.on;
        heatChanged();
      },
      setOn: function (on) {
        heatUI.on = !!on;
        var mc = document.getElementById('heatOn');
        if (mc) mc.checked = heatUI.on;
        heatChanged();
      },
      open: function (open) {
        var body = document.getElementById('heatBody');
        if (body) { body.hidden = !open; document.getElementById('heatToggle').setAttribute('aria-expanded', open ? 'true' : 'false'); }
        if (open) ensureHeatLayer();
        heatChanged();
      },
      stats: function () { return heatLayer ? heatLayer.stats() : null; },
      sample: function (step) { return heatLayer ? heatLayer.sample(step) : { nonEmpty: 0, maxAlpha: 0 }; },
      canvas: function () { return heatLayer ? heatLayer.canvas : null; },
      layerCount: function () { return HEAT.index.length; },
      totalPoints: function () { return HEAT.totalPoints || 0; }
    },
    regions: {
      count: function () { return REGIONS.length; },
      shapesVisible: function () { return !!(regionsUI.polyGroup && map.hasLayer(regionsUI.polyGroup)); },
      labelsVisible: function () { return regionsUI.labels.filter(function (m) { return map.hasLayer(m); }).length; },
      setShapes: setRegionShapes,
      setLabels: setRegionLabels,
      /* preferCanvas is on, so the outlines land in a canvas inside the pane */
      sample: function () {
        var c = document.querySelector('.leaflet-regions-pane canvas');
        if (!c) return { found: false, nonEmpty: 0 };
        try {
          var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          var n = 0;
          for (var i = 3; i < d.length; i += 4 * 7) if (d[i] > 0) n++;
          return { found: true, nonEmpty: n, w: c.width, h: c.height };
        } catch (e) {
          return { found: true, nonEmpty: 0, error: String(e) };
        }
      },
      labels: function () {
        return Array.prototype.map.call(document.querySelectorAll('.leaflet-regions-pane .region-label span'),
          function (n) { return n.textContent; });
      }
    },
    lists: function () { return state.lists.map(function (l) { var d = 0; l.markerIds.forEach(function (id) { if (state.found.has(id)) d++; }); return { id: l.id, name: l.name, total: l.markerIds.length, done: d }; }); },
    custom: function () { return state.custom; },
    notes: function () { return state.notes; },
    storage: function () { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); },
    counts: function () { return { markers: MARKERS.length, types: totalTypes, found: state.found.size, visible: markers.items.length, custom: state.custom.length, lists: state.lists.length, notes: Object.keys(state.notes).length, heat: (heatUI.sel ? heatUI.sel.size : 0), tiles: { loads: tileLoads, errors: tileErrors } }; }
  };
})();
