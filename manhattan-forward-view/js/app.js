import {
  SETTINGS, PHIS, makeProjection, buildObstacles, measureDirectedEdge, summarize,
  openingAt, closedForm, mphToR, rToMph
} from './geometry.js';
import { PAPER } from './reference.js';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
// The main Overpass instance rejects browser POST preflights, so queries go by GET, with mirrors as fallback.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
const MANHATTAN = { center: [-73.9855, 40.7505], zoom: 15.6, pitch: 58, bearing: 29 };
// Footprints and streets are fetched in fixed tiles (~445 m x 420 m) and kept for the session, so nearby
// clicks reuse them. Missing tiles are fetched together in one query, from whichever server answers first.
const TILE_LAT = 0.004, TILE_LNG = 0.005;
const CLICK_PAD_M = 160;       // area loaded around a click before snapping to a street
const PREFETCH_PAD_M = 260;    // area loaded in the background around the map centre
const MARGIN_FT = 330;         // buildings needed beyond each sample point (wall cap 300 ft + margin)
const SNAP_FT = 120;           // how close a click must be to a street
// Optional: a GeoJSON of your own segment results (see README). Leave null to skip.
const OWN_RESULTS_URL = null;   // e.g. 'data/segments.geojson'

// OSMnx "drive" network filter, written as Overpass QL.
const DRIVE = '["highway"]["area"!~"yes"]["highway"!~"abandoned|bridleway|bus_guideway|construction|corridor|cycleway|elevator|escalator|footway|no|path|pedestrian|planned|platform|proposed|raceway|razed|service|steps|track"]["motor_vehicle"!~"no"]["motorcar"!~"no"]["access"!~"private"]';

const $ = s => document.querySelector(s);
const DEG = Math.PI / 180;
const state = { R: SETTINGS.R, dir: 'both', point: 2, result: null, busy: false };
// One projection for all of Manhattan, so tiles fetched at different times fit together.
const PROJ = makeProjection(-73.97, 40.78);

// ---------------- map ----------------
const map = new maplibregl.Map({
  container: 'map', style: STYLE_URL, ...MANHATTAN,
  maxPitch: 85, attributionControl: { compact: true }, hash: false
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.getCanvas().style.cursor = 'crosshair';

let beforeId;   // our ground layers go below the 3D buildings so buildings hide rays behind them
map.on('load', () => {
  ensureBuildings();
  addLayers();
  loadOwnResults();
  const h = parseHash();
  if (h) { state.R = h.R; syncControls(); analyzeAt([h.lng, h.lat], { fly: true }); }
});

function ensureBuildings() {
  const layers = map.getStyle().layers;
  let ext = layers.find(l => l.type === 'fill-extrusion');
  if (!ext) {
    const src = Object.entries(map.getStyle().sources).find(([, s]) => s.type === 'vector');
    if (src) {
      map.addLayer({
        id: 'fv-buildings-3d', type: 'fill-extrusion', source: src[0], 'source-layer': 'building', minzoom: 14,
        paint: {
          'fill-extrusion-color': '#d8d4cc',
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 12],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.88
        }
      });
      ext = { id: 'fv-buildings-3d' };
    }
  } else {
    map.setPaintProperty(ext.id, 'fill-extrusion-opacity', 0.88);
  }
  beforeId = ext ? ext.id : undefined;
}

const EMPTY = { type: 'FeatureCollection', features: [] };
function addLayers() {
  for (const id of ['fv-footprints', 'fv-edge', 'fv-rays', 'fv-iso', 'fv-circle', 'fv-points', 'fv-own']) {
    map.addSource(id, { type: 'geojson', data: EMPTY });
  }
  map.addLayer({ id: 'fv-own', type: 'line', source: 'fv-own', layout: { visibility: 'none', 'line-cap': 'round' },
    paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1.5, 17, 5],
      'line-color': ['interpolate', ['linear'], ['coalesce', ['get', 'opening_80'], 0], 30, '#3b1f5e', 70, '#8a3b78', 110, '#d8576b', 150, '#f9a65a', 180, '#fde68a'] } }, beforeId);
  map.addLayer({ id: 'fv-footprints', type: 'line', source: 'fv-footprints', layout: { visibility: 'none' },
    paint: { 'line-color': '#1f2937', 'line-width': 1, 'line-opacity': 0.55 } }, beforeId);
  map.addLayer({ id: 'fv-edge', type: 'line', source: 'fv-edge', layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#111827', 'line-width': 6, 'line-opacity': 0.75 } }, beforeId);
  map.addLayer({ id: 'fv-iso', type: 'fill-extrusion', source: 'fv-iso',
    paint: { 'fill-extrusion-color': '#c0392b', 'fill-extrusion-height': 1.4, 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.42 } }, beforeId);
  map.addLayer({ id: 'fv-rays', type: 'line', source: 'fv-rays',
    paint: { 'line-color': ['case', ['get', 'open'], '#c0392b', '#7c8591'],
      'line-width': ['case', ['get', 'open'], 2.2, 1.1], 'line-opacity': ['case', ['get', 'open'], 1, 0.75] } }, beforeId);
  map.addLayer({ id: 'fv-circle', type: 'line', source: 'fv-circle',
    paint: { 'line-color': '#111827', 'line-width': 1.6, 'line-dasharray': [3, 3] } }, beforeId);
  map.addLayer({ id: 'fv-points', type: 'circle', source: 'fv-points',
    paint: { 'circle-radius': ['case', ['get', 'sel'], 7, 4.5], 'circle-color': ['case', ['get', 'sel'], '#ffffff', '#111827'],
      'circle-stroke-color': '#111827', 'circle-stroke-width': ['case', ['get', 'sel'], 3, 1] } });
}

async function loadOwnResults() {
  if (!OWN_RESULTS_URL) return;
  try {
    const r = await fetch(OWN_RESULTS_URL, { cache: 'no-store' });
    if (!r.ok) return;
    map.getSource('fv-own').setData(await r.json());
    $('#ownWrap').hidden = false;
  } catch { /* optional layer; absent by default */ }
}

map.on('click', e => { if (!state.busy) analyzeAt([e.lngLat.lng, e.lngLat.lat], { fly: true }); });

// ---------------- data ----------------
function bboxAround([lng, lat], halfM) {
  const dLat = halfM / 111132, dLng = halfM / (111320 * Math.cos(lat * DEG));
  return { s: lat - dLat, w: lng - dLng, n: lat + dLat, e: lng + dLng };
}

// Lighter query: streets with tags and node ids; building ways as bare geometry (no tags);
// building relations with their member geometry.
function overpassQuery(b) {
  const bb = `${b.s.toFixed(6)},${b.w.toFixed(6)},${b.n.toFixed(6)},${b.e.toFixed(6)}`;
  return `[out:json][timeout:60];` +
    `way${DRIVE}(${bb});out body geom qt;` +
    `way["building"]["building"!~"^(no|roof)$"](${bb});out skel geom qt;` +
    `relation["building"]["building"!~"^(no|roof)$"](${bb});out geom qt;`;
}

// Ask every server at once and keep the first good answer; the others are cancelled.
async function overpass(b) {
  const q = encodeURIComponent(overpassQuery(b));
  const ctls = OVERPASS.map(() => new AbortController());
  const tries = OVERPASS.map(async (ep, i) => {
    const timer = setTimeout(() => ctls[i].abort(), 60000);
    try {
      const res = await fetch(`${ep}?data=${q}`, { signal: ctls[i].signal });
      if (!res.ok) throw new Error(`${new URL(ep).host} returned ${res.status}`);
      const json = await res.json();
      if (!json.elements) throw new Error(`${new URL(ep).host} returned no data`);
      if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(`${new URL(ep).host}: ${json.remark}`);
      return json;
    } finally { clearTimeout(timer); }
  });
  try {
    const json = await Promise.any(tries);
    ctls.forEach(c => c.abort());
    return json;
  } catch (agg) {
    const errs = (agg.errors || []).map(e => e.message).join('; ');
    throw new Error(errs || 'No Overpass server answered');
  }
}

// ---------------- tile cache ----------------
const tiles = new Map();          // key -> array of elements (loaded)
let inflight = null;              // promise of the fetch currently running
const tileKey = (i, j) => `${i}:${j}`;
const tileBox = (i, j) => ({ s: j * TILE_LAT, n: (j + 1) * TILE_LAT, w: i * TILE_LNG, e: (i + 1) * TILE_LNG });

function tilesFor(b) {
  const keys = [];
  for (let i = Math.floor(b.w / TILE_LNG); i <= Math.floor(b.e / TILE_LNG); i++)
    for (let j = Math.floor(b.s / TILE_LAT); j <= Math.floor(b.n / TILE_LAT); j++) keys.push([i, j]);
  return keys;
}

function elementBox(el) {
  const pts = el.geometry || (el.members || []).flatMap(m => m.geometry || []);
  let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
  for (const g of pts) { if (!g) continue; s = Math.min(s, g.lat); n = Math.max(n, g.lat); w = Math.min(w, g.lon); e = Math.max(e, g.lon); }
  return Number.isFinite(s) ? { s, n, w, e } : null;
}

// Make sure every tile touching box b is loaded. Missing tiles are fetched in one query.
async function ensureTiles(b) {
  for (;;) {
    const missing = tilesFor(b).filter(([i, j]) => !tiles.has(tileKey(i, j)));
    if (!missing.length) return;
    if (inflight) { await inflight.catch(() => {}); continue; }   // a fetch (maybe a prefetch) is running: wait, then re-check
    const is = missing.map(t => t[0]), js = missing.map(t => t[1]);
    const box = { w: Math.min(...is) * TILE_LNG, e: (Math.max(...is) + 1) * TILE_LNG, s: Math.min(...js) * TILE_LAT, n: (Math.max(...js) + 1) * TILE_LAT };
    inflight = (async () => {
      const json = await overpass(box);
      const buckets = new Map(missing.map(([i, j]) => [tileKey(i, j), []]));
      for (const el of json.elements) {
        const eb = elementBox(el); if (!eb) continue;
        for (const [i, j] of tilesFor(eb)) { const k = tileKey(i, j); if (buckets.has(k)) buckets.get(k).push(el); }
      }
      for (const [k, v] of buckets) tiles.set(k, v);
    })();
    try { await inflight; } finally { inflight = null; }
  }
}

// Assemble a region from the loaded tiles touching box b (duplicates across tiles removed).
let lastRegion = null;
function regionFromTiles(b) {
  const keys = tilesFor(b).map(([i, j]) => tileKey(i, j));
  const sig = keys.join('|');
  if (lastRegion && lastRegion.sig === sig) return lastRegion;
  const seen = new Set(), elements = [];
  for (const k of keys) for (const el of tiles.get(k) || []) {
    const id = el.type[0] + el.id;
    if (!seen.has(id)) { seen.add(id); elements.push(el); }
  }
  const ts = tilesFor(b);
  const bb = { w: Math.min(...ts.map(t => t[0])) * TILE_LNG, e: (Math.max(...ts.map(t => t[0])) + 1) * TILE_LNG,
               s: Math.min(...ts.map(t => t[1])) * TILE_LAT, n: (Math.max(...ts.map(t => t[1])) + 1) * TILE_LAT };
  lastRegion = { ...buildRegion(elements, bb), sig };
  return lastRegion;
}

function buildRegion(elements, b) {
  const proj = PROJ;
  const roads = [], rings = [], ringsLL = [];
  const coord = new Map(), nbrs = new Map();
  const link = (a, c) => { (nbrs.get(a) || nbrs.set(a, new Set()).get(a)).add(c); };
  for (const el of elements) {
    const t = el.tags || {};
    if (el.type === 'way' && t.highway && el.geometry && el.nodes) {
      const pts = el.geometry.map(g => proj.toXY([g.lon, g.lat]));
      el.nodes.forEach((id, i) => coord.set(id, pts[i]));
      for (let i = 1; i < el.nodes.length; i++) { link(el.nodes[i - 1], el.nodes[i]); link(el.nodes[i], el.nodes[i - 1]); }
      roads.push({ id: el.id, nodes: el.nodes, pts, tags: t });
    } else if (el.type === 'way' && el.geometry && !t.highway) {          // building way (printed without tags)
      rings.push(el.geometry.map(g => proj.toXY([g.lon, g.lat])));
      ringsLL.push(el.geometry.map(g => [g.lon, g.lat]));
    } else if (el.type === 'relation') {                                 // building relation
      for (const m of el.members || []) {
        if (m.type === 'way' && m.geometry && m.role !== 'inner') {
          rings.push(m.geometry.map(g => proj.toXY([g.lon, g.lat])));
          ringsLL.push(m.geometry.map(g => [g.lon, g.lat]));
        }
      }
    }
  }
  const [x0, y0] = proj.toXY([b.w, b.s]), [x1, y1] = proj.toXY([b.e, b.n]);
  return { b, proj, roads, obs: buildObstacles(rings), ringsLL, coord, nbrs, bounds: { x0, y0, x1, y1 }, nBuildings: rings.length };
}

async function regionAround(b, msg) {
  if (tilesFor(b).some(([i, j]) => !tiles.has(tileKey(i, j)))) setStatus(msg, 'busy');
  await ensureTiles(b);
  return regionFromTiles(b);
}

// Load the area around the map centre in the background, so a click there is answered at once.
let prefetchTimer = null;
map.on('moveend', () => {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    if (state.busy || inflight || map.getZoom() < 15) return;
    const c = map.getCenter();
    if (c.lng < -74.05 || c.lng > -73.88 || c.lat < 40.68 || c.lat > 40.89) return;   // Manhattan only
    ensureTiles(bboxAround([c.lng, c.lat], PREFETCH_PAD_M)).catch(err => console.warn('prefetch', err));
  }, 700);
});

// ---------------- street edges ----------------
const EXCLUDED = /^(motorway|trunk_link|primary_link|secondary_link|tertiary_link|motorway_link)$/;
const isEligible = t => !EXCLUDED.test(t.highway) && t.bridge !== 'yes' && t.tunnel !== 'yes';

function snap(reg, [x, y]) {
  let best = null;
  for (const r of reg.roads) {
    if (!isEligible(r.tags)) continue;
    for (let i = 1; i < r.pts.length; i++) {
      const [ax, ay] = r.pts[i - 1], [bx, by] = r.pts[i];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
      const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
      if (!best || d < best.d) best = { d, road: r, i };
    }
  }
  return best && best.d <= SNAP_FT ? best : null;
}

// Walk from the snapped piece to the nearest nodes whose degree is not 2, as OSMnx simplification does.
function edgeFrom(reg, { road, i }) {
  const deg = id => (reg.nbrs.get(id) || new Set()).size;
  const walk = (cur, prev) => {
    const out = []; let guard = 0, len = 0;
    while (deg(cur) === 2 && guard++ < 400 && len < 3000) {
      const next = [...reg.nbrs.get(cur)].find(n => n !== prev);
      if (next === undefined || next === road.nodes[i - 1] || next === road.nodes[i]) break;
      const a = reg.coord.get(cur), c = reg.coord.get(next);
      len += Math.hypot(c[0] - a[0], c[1] - a[1]);
      out.push(next); prev = cur; cur = next;
    }
    return out;
  };
  const a = road.nodes[i - 1], c = road.nodes[i];
  const back = walk(a, c).reverse(), fwd = walk(c, a);
  const ids = [...back, a, c, ...fwd];
  return { ids, line: ids.map(id => reg.coord.get(id)) };
}

function onewayOf(t) {
  const o = (t.oneway || '').toLowerCase();
  if (o === '-1' || o === 'reverse') return -1;
  if (['yes', 'true', '1'].includes(o) || t.junction === 'roundabout') return 1;
  return 0;
}

function postedLimit(t) {
  const m = /^(\d+)\s*mph$/i.exec(t.maxspeed || '');
  if (m) return { mph: +m[1], source: 'OSM maxspeed' };
  const k = /^(\d+)$/.exec(t.maxspeed || '');           // a bare number is km/h in OSM
  if (k) return { mph: Math.round(+k[1] / 1.609344), source: 'OSM maxspeed (km/h)' };
  return { mph: 25, source: 'no maxspeed tag; 25 mph assumed, as in the paper' };
}

const compass = h => ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'][Math.round(((h / DEG) % 360 + 360) % 360 / 45) % 8];

// ---------------- analysis ----------------
async function analyzeAt(lngLat, { fly } = {}) {
  state.busy = true;
  try {
    const LOADING = 'Loading building footprints and streets for this area (first click here only)…';
    let reg = await regionAround(bboxAround(lngLat, CLICK_PAD_M), LOADING);
    let s = snap(reg, reg.proj.toXY(lngLat));
    if (!s) { setStatus('No drivable street within 120 ft of that point. Click closer to a street centerline.', 'warn'); return; }
    let edge = edgeFrom(reg, s);
    // Buildings must reach 330 ft past every part of the edge: load any missing tiles and re-trace the edge.
    for (let pass = 0; pass < 3; pass++) {
      const ll = edge.line.map(p => reg.proj.toLonLat(p));
      const padLat = MARGIN_FT / 3.28084 / 111132, padLng = padLat / Math.cos(lngLat[1] * DEG);
      const need = { s: Math.min(...ll.map(p => p[1])) - padLat, n: Math.max(...ll.map(p => p[1])) + padLat,
                     w: Math.min(...ll.map(p => p[0])) - padLng, e: Math.max(...ll.map(p => p[0])) + padLng };
      const all = { s: Math.min(need.s, lngLat[1] - padLat), n: Math.max(need.n, lngLat[1] + padLat),
                    w: Math.min(need.w, lngLat[0] - padLng), e: Math.max(need.e, lngLat[0] + padLng) };
      const before = reg;
      reg = await regionAround(all, LOADING);
      if (reg === before) break;
      s = snap(reg, reg.proj.toXY(lngLat));
      if (!s) { setStatus('Could not match that street after loading more of the area. Try another click.', 'warn'); return; }
      edge = edgeFrom(reg, s);
    }
    setStatus('Casting rays…', 'busy');
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
    const ow = onewayOf(s.road.tags);
    const lines = ow === 1 ? [edge.line] : ow === -1 ? [[...edge.line].reverse()] : [edge.line, [...edge.line].reverse()];
    const dirs = lines.map(line => {
      const m = measureDirectedEdge(reg.obs, line);
      const h = Math.atan2(line[line.length - 1][1] - line[0][1], line[line.length - 1][0] - line[0][0]);
      return { ...m, line, label: `${compass(h)}-bound` };
    });
    const t = s.road.tags;
    state.result = {
      reg, dirs, tags: t, oneway: ow,
      name: t.name || 'Unnamed street',
      klass: /^(primary|secondary|trunk)$/.test(t.highway) ? 'avenue' : 'local',
      limit: postedLimit(t),
      lngLat
    };
    state.dir = 'both'; state.point = 2;
    syncControls();
    render(fly);
    writeHash();
  } catch (err) {
    console.error(err);
    setStatus(`Could not load OpenStreetMap data (${err.message}). Public Overpass servers are sometimes busy; wait a minute and click again.`, 'warn');
  } finally { state.busy = false; }
}

// ---------------- drawing ----------------
function activeDirs() {
  const d = state.result.dirs;
  if (state.dir === 'both' || d.length === 1) return d;
  return [d[state.dir === 'a' ? 0 : 1]];
}

function render(fly) {
  const res = state.result; if (!res) return;
  const { reg } = res, R = state.R;
  const dirs = activeDirs();
  const show = dirs[0];                      // rays are drawn for one direction
  const p = show.points[state.point];
  const ll = xy => reg.proj.toLonLat(xy);

  const rays = [], iso = [];
  PHIS.forEach((phi, k) => {
    const a = p.heading - phi * DEG, d = p.dists[k];
    const len = d >= R ? Math.min(d, R * 1.35) : d;
    rays.push({ type: 'Feature', properties: { open: d >= R }, geometry: { type: 'LineString',
      coordinates: [ll([p.x, p.y]), ll([p.x + Math.cos(a) * len, p.y + Math.sin(a) * len])] } });
    const r = Math.min(d, R);
    iso.push(ll([p.x + Math.cos(a) * r, p.y + Math.sin(a) * r]));
  });
  const origin = ll([p.x, p.y]);
  const circle = Array.from({ length: 97 }, (_, k) => { const a = (k / 96) * 2 * Math.PI; return ll([p.x + R * Math.cos(a), p.y + R * Math.sin(a)]); });

  map.getSource('fv-rays').setData({ type: 'FeatureCollection', features: rays });
  map.getSource('fv-iso').setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[origin, ...iso, origin]] } });
  map.getSource('fv-circle').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: circle } });
  map.getSource('fv-edge').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: show.line.map(ll) } });
  map.getSource('fv-points').setData({ type: 'FeatureCollection', features: show.points.map((q, k) => ({
    type: 'Feature', properties: { sel: k === state.point }, geometry: { type: 'Point', coordinates: ll([q.x, q.y]) } })) });
  map.getSource('fv-footprints').setData({ type: 'FeatureCollection', features: reg.ringsLL.map(r => ({
    type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: r } })) });

  if (fly) {
    const bearing = 90 - p.heading / DEG;
    map.easeTo({ center: origin, bearing, pitch: 62, zoom: 18.1, duration: 1100, padding: panelPadding() });
  }
  renderPanel();
}

function panelPadding() {
  const wide = window.innerWidth > 820;
  return wide ? { left: 400, right: 0, top: 0, bottom: 0 } : { left: 0, right: 0, top: 0, bottom: Math.round(window.innerHeight * 0.42) };
}

function driverView() {
  const res = state.result; if (!res) return;
  const p = activeDirs()[0].points[state.point];
  const ahead = res.reg.proj.toLonLat([p.x + Math.cos(p.heading) * state.R * 0.55, p.y + Math.sin(p.heading) * state.R * 0.55]);
  map.easeTo({ center: ahead, bearing: 90 - p.heading / DEG, pitch: 80, zoom: 19.4, duration: 1200, padding: panelPadding() });
}

// ---------------- panel ----------------
const f0 = v => Number.isFinite(v) ? Math.round(v).toString() : 'n/a';
const f1 = v => Number.isFinite(v) ? v.toFixed(1) : 'n/a';
const f2 = v => Number.isFinite(v) ? v.toFixed(2) : 'n/a';

function renderPanel() {
  const res = state.result, R = state.R;
  const dirs = activeDirs();
  const S = summarize(dirs, R);
  const ref = PAPER.classMeans[res.klass];
  const Rspeed = mphToR(res.limit.mph);
  const speedMatched = dirs.reduce((a, d) => a + d.opening(Rspeed), 0) / dirs.length;
  const S80 = summarize(dirs, 80);
  const diff80 = S80.theta - ref.opening80;
  const p = dirs[0].points[state.point];

  $('#empty').hidden = true; $('#result').hidden = false;
  $('#streetName').textContent = res.name;
  $('#streetMeta').textContent = [
    res.klass === 'avenue' ? `Avenue class (OSM highway=${res.tags.highway})` : `Local class (OSM highway=${res.tags.highway})`,
    `${f0(dirs[0].length)} ft edge`,
    res.oneway ? 'one-way' : 'two-way',
    `${res.limit.mph} mph (${res.limit.source})`
  ].join(' · ');

  $('#theta').textContent = `${f1(S.theta)}°`;
  $('#thetaLabel').textContent = `forward opening θ(${R} ft)`;
  $('#thetaSub').textContent = `${state.dir === 'both' && res.dirs.length > 1 ? 'mean of both directions, ' : ''}median of 5 points · R ≈ ${f0(rToMph(R))} mph at T = 2 s`;

  const rows = [
    ['Closed form θc', `${f1(S.thetaC)}°`, 'arcsin(wl/R) + arcsin(wr/R), from the two wall distances only (Eq. 2)'],
    ['Residual θ − θc', `${S.residual >= 0 ? '+' : ''}${f1(S.residual)}°`, S.withinTol ? 'within 5° of the closed form: a clean canyon' : 'more than 5° from the closed form: gaps, setbacks or uneven walls'],
    ['Wall distance, left / right', `${f0(S.wl)} / ${f0(S.wr)} ft`, 'median of the rays within 20° of perpendicular, capped at 300 ft'],
    ['Building-face separation w', `${f0(S.sep)} ft`, 'wl + wr'],
    ['Wall asymmetry', f2(S.asymmetry), '|wl − wr| / (wl + wr)'],
    ['Frontage gap share', f2(S.gapShare), 'share of rays at ≥ 45° that pass 1.5× their canyon distance and 20 ft beyond the wall'],
    [`Speed-matched opening`, `${f1(speedMatched)}°`, `at R = ${f0(Rspeed)} ft, set by the ${res.limit.mph} mph limit and T = 2 s`]
  ];
  $('#indices').innerHTML = rows.map(([k, v, h]) => `<div class="row"><dt>${k}</dt><dd>${v}</dd><p>${h}</p></div>`).join('');

  $('#compare').innerHTML = `
    <div class="cmp"><span>This street at 80 ft</span><b>${f1(S80.theta)}°</b></div>
    <div class="cmp"><span>Manhattan ${res.klass} mean</span><b>${ref.opening80}°</b></div>
    <div class="cmp ${diff80 >= 0 ? 'up' : 'down'}"><span>Difference</span><b>${diff80 >= 0 ? '+' : ''}${f1(diff80)}°</b></div>
    <p class="note">Class means are segment means from the paper (Table 6): local 67.2°, avenue 103.5°. Face separation means: ${ref.faceSep} ft (this street ${f0(S.sep)} ft).</p>`;

  drawProfile(S.profile, res.klass);

  const flags = [];
  if (S.noFacing) flags.push('One side has no facing building within 300 ft at most sample points. The paper excludes such segments, so treat these values with care.');
  if (S.insideCount) flags.push(`${S.insideCount} sample point(s) fall inside a mapped footprint (the paper excludes such segments).`);
  if (!res.tags.name) flags.push('Unnamed street: unnamed segments were excluded in the paper.');
  $('#flags').innerHTML = flags.map(f => `<li>${f}</li>`).join('');
  $('#flags').hidden = !flags.length;

  $('#pointInfo').textContent = `Rays drawn from point ${state.point + 1} of 5 (${Math.round((0.3 + 0.1 * state.point) * 100)}% along the edge, ${dirs[0].label}): θ = ${f1(openingAt(p.dists, R))}°, θc = ${f1(closedForm(p.wl, p.wr, R))}°.`;
  $('#dirBoth').disabled = res.dirs.length < 2;
  $('#dirA').textContent = res.dirs[0].label;
  $('#dirB').textContent = res.dirs[1] ? res.dirs[1].label : '–';
  $('#dirB').disabled = res.dirs.length < 2;
  setStatus(`${res.reg.nBuildings.toLocaleString()} footprints loaded around this street.`, 'ok');
}

function drawProfile(profile, klass) {
  const W = 340, H = 190, L = 34, Rt = 10, T = 12, B = 30;
  const Rs = PAPER.profile.R;
  const x = r => L + (r - 30) / 210 * (W - L - Rt), y = v => T + (1 - v / 180) * (H - T - B);
  const path = arr => arr.map((v, i) => `${i ? 'L' : 'M'}${x(Rs[i]).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const mine = profile.map(p => p.theta);
  const grid = [0, 90, 180].map(v => `<line x1="${L}" x2="${W - Rt}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('');
  const xt = [40, 80, 160, 240].map(r => `<text x="${x(r)}" y="${H - B + 16}" text-anchor="middle">${r}</text>`).join('');
  const marker = `<line x1="${x(state.R)}" x2="${x(state.R)}" y1="${T}" y2="${H - B}" class="m"/>`;
  $('#profile').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Opening by look-ahead distance">
    ${grid}${xt}${marker}
    <path d="${path(PAPER.profile.local)}" class="loc"/><path d="${path(PAPER.profile.avenue)}" class="ave"/>
    <path d="${path(mine)}" class="me"/>${mine.map((v, i) => `<circle cx="${x(Rs[i])}" cy="${y(v)}" r="3" class="me-pt"/>`).join('')}
    <text x="${(L + W - Rt) / 2}" y="${H - 2}" text-anchor="middle">look-ahead R (ft)</text></svg>
    <div class="legend"><span><i class="k me"></i>this street</span><span><i class="k ave"></i>Manhattan avenues</span><span><i class="k loc"></i>Manhattan local streets</span></div>
    <p class="note">Manhattan curves: means of streets within neighborhoods (paper, Table 7). This street is a ${klass} street.</p>`;
}

function setStatus(msg, kind) { const el = $('#status'); el.textContent = msg; el.className = `status ${kind || ''}`; }

// ---------------- controls ----------------
function syncControls() {
  $('#R').value = state.R; $('#Rval').textContent = `${state.R} ft ≈ ${Math.round(rToMph(state.R))} mph`;
  document.querySelectorAll('[data-dir]').forEach(b => b.setAttribute('aria-pressed', b.dataset.dir === state.dir));
  document.querySelectorAll('[data-pt]').forEach(b => b.setAttribute('aria-pressed', +b.dataset.pt === state.point));
}
$('#R').addEventListener('input', e => { state.R = +e.target.value; syncControls(); if (state.result) { render(false); writeHash(); } });
document.querySelectorAll('[data-dir]').forEach(b => b.addEventListener('click', () => { if (b.disabled) return; state.dir = b.dataset.dir; syncControls(); render(true); }));
document.querySelectorAll('[data-pt]').forEach(b => b.addEventListener('click', () => { state.point = +b.dataset.pt; syncControls(); if (state.result) render(false); }));
$('#driver').addEventListener('click', driverView);
$('#overview').addEventListener('click', () => state.result ? render(true) : map.easeTo({ ...MANHATTAN, duration: 1000 }));
$('#footprints').addEventListener('change', e => map.setLayoutProperty('fv-footprints', 'visibility', e.target.checked ? 'visible' : 'none'));
$('#own').addEventListener('change', e => map.setLayoutProperty('fv-own', 'visibility', e.target.checked ? 'visible' : 'none'));
$('#toggle').addEventListener('click', () => document.body.classList.toggle('collapsed'));
document.querySelectorAll('[data-fly]').forEach(b => b.addEventListener('click', () => {
  const [lng, lat, zoom] = b.dataset.fly.split(',').map(Number);
  map.easeTo({ center: [lng, lat], zoom, pitch: 58, duration: 1200, padding: panelPadding() });
  setStatus('Now click a street.', '');
}));

// ---------------- shareable links ----------------
function writeHash() {
  if (!state.result) return;
  const [lng, lat] = state.result.lngLat;
  history.replaceState(null, '', `#${lat.toFixed(6)},${lng.toFixed(6)},${state.R}`);
}
function parseHash() {
  const m = /^#(-?\d+\.\d+),(-?\d+\.\d+)(?:,(\d+))?$/.exec(location.hash);
  if (!m) return null;
  const R = m[3] ? Math.min(240, Math.max(30, +m[3])) : SETTINGS.R;
  return { lat: +m[1], lng: +m[2], R };
}

// Test hook (used by the local test script only).
window.__fv = { analyzeAt, state, map, tiles };
syncControls();
