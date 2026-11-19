import {
  SETTINGS, PHIS, makeProjection, buildObstacles, measureDirectedEdge, summarize,
  openingAt, closedForm, mphToR, rToMph
} from './geometry.js';
import { PAPER } from './reference.js';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';   // recoloured black & white by monoBasemap()
// The main Overpass instance rejects browser POST preflights, so queries go by GET, with mirrors as fallback.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
const MANHATTAN = { center: [-73.9855, 40.7505], zoom: 15.6, pitch: 58, bearing: 29 };
const LOAD_RADIUS_M = 420;     // half-size of the box fetched around a click
const MARGIN_FT = 330;         // buildings needed beyond each sample point (wall cap 300 ft + margin)
const SNAP_FT = 120;           // how close a click must be to a street
// Optional: a GeoJSON of your own segment results (see README). Leave null to skip.
const OWN_RESULTS_URL = null;   // e.g. 'data/segments.geojson'

// OSMnx "drive" network filter, written as Overpass QL.
const DRIVE = '["highway"]["area"!~"yes"]["highway"!~"abandoned|bridleway|bus_guideway|construction|corridor|cycleway|elevator|escalator|footway|no|path|pedestrian|planned|platform|proposed|raceway|razed|service|steps|track"]["motor_vehicle"!~"no"]["motorcar"!~"no"]["access"!~"private"]';

const $ = s => document.querySelector(s);
const DEG = Math.PI / 180;
const state = { R: SETTINGS.R, dir: 'both', point: 2, result: null, regions: [], busy: false };

// ---------------- map ----------------
// Turn a light vector basemap style into a black & white (terminal-style) one.
// Every colour in the style's paint properties is converted to a grey whose
// brightness depends on the property: land and water become near-black,
// roads mid-grey, labels light grey on a black halo. Used with
// map.setStyle(url, { transformStyle: (_, next) => monoBasemap(next) }).
function monoBasemap(style) {
  try {
    const NAMED = { white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0] };
    const hsl2rgb = (h, s, l) => {
      s /= 100; l /= 100;
      const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
      const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
      return [255 * f(0), 255 * f(8), 255 * f(4)];
    };
    const parse = str => {
      const s = str.trim().toLowerCase();
      if (NAMED[s]) return NAMED[s];
      let m = s.match(/^#([0-9a-f]{3,8})$/);
      if (m) {
        let h = m[1];
        if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('');
        if (h.length !== 6 && h.length !== 8) return null;
        const n = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
        return [...n, h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
      }
      m = s.match(/^rgba?\(([^)]+)\)$/);
      if (m) { const p = m[1].split(',').map(parseFloat); return p.length >= 3 ? [p[0], p[1], p[2], p[3] ?? 1] : null; }
      m = s.match(/^hsla?\(([^)]+)\)$/);
      if (m) { const p = m[1].split(',').map(parseFloat); return p.length >= 3 ? [...hsl2rgb(p[0], p[1], p[2]), p[3] ?? 1] : null; }
      return null;
    };
    // brightness rules per paint property (y = luminance of the original colour, 0–1)
    const RULES = {
      'background-color': y => 4 + 40 * (1 - y),
      'fill-color': y => 6 + 90 * (1 - y),
      'fill-outline-color': y => 26 + 40 * (1 - y),
      'fill-extrusion-color': y => 34 + 70 * y,
      'line-color': y => 30 + 92 * y,
      'text-color': y => 238 - 120 * y,
      'text-halo-color': () => 0,
      'icon-color': () => 200,
      'icon-halo-color': () => 0,
      'circle-color': y => 60 + 90 * y,
      'circle-stroke-color': () => 0
    };
    const conv = (str, rule) => {
      const c = parse(str);
      if (!c) return str;
      const y = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
      const v = Math.max(0, Math.min(255, Math.round(rule(y))));
      return c[3] < 1 ? `rgba(${v},${v},${v},${+c[3].toFixed(3)})` : `rgb(${v},${v},${v})`;
    };
    const walk = (v, rule) => typeof v === 'string' ? conv(v, rule)
      : Array.isArray(v) ? v.map(x => walk(x, rule))
      : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, rule)]))
      : v;
    for (const layer of style.layers || []) {
      const paint = layer.paint || {};
      for (const key of Object.keys(paint)) if (RULES[key]) paint[key] = walk(paint[key], RULES[key]);
      if (layer.type === 'symbol' && layer.layout && layer.layout['icon-image'] && paint['icon-opacity'] === undefined) {
        paint['icon-opacity'] = 0.5;      // colour POI icons, dimmed
      }
      layer.paint = paint;
    }
  } catch (err) {
    console.warn('monoBasemap: keeping the original colours', err);
  }
  return style;
}

const map = new maplibregl.Map({
  container: 'map', ...MANHATTAN,
  maxPitch: 85, attributionControl: { compact: true }, hash: false
});
map.setStyle(STYLE_URL, { transformStyle: (_, next) => monoBasemap(next) });
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
          'fill-extrusion-color': '#5c5c5c',
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
    paint: { 'line-color': '#bdbdbd', 'line-width': 1, 'line-opacity': 0.55 } }, beforeId);
  map.addLayer({ id: 'fv-edge', type: 'line', source: 'fv-edge', layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.75 } }, beforeId);
  map.addLayer({ id: 'fv-iso', type: 'fill-extrusion', source: 'fv-iso',
    paint: { 'fill-extrusion-color': '#c0392b', 'fill-extrusion-height': 1.4, 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.42 } }, beforeId);
  map.addLayer({ id: 'fv-rays', type: 'line', source: 'fv-rays',
    paint: { 'line-color': ['case', ['get', 'open'], '#c0392b', '#7c8591'],
      'line-width': ['case', ['get', 'open'], 2.2, 1.1], 'line-opacity': ['case', ['get', 'open'], 1, 0.75] } }, beforeId);
  map.addLayer({ id: 'fv-circle', type: 'line', source: 'fv-circle',
    paint: { 'line-color': '#ffffff', 'line-width': 1.6, 'line-dasharray': [3, 3] } }, beforeId);
  map.addLayer({ id: 'fv-points', type: 'circle', source: 'fv-points',
    paint: { 'circle-radius': ['case', ['get', 'sel'], 7, 4.5], 'circle-color': ['case', ['get', 'sel'], '#000000', '#ffffff'],
      'circle-stroke-color': '#ffffff', 'circle-stroke-width': ['case', ['get', 'sel'], 3, 1] } });
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

async function overpass(b) {
  const bb = `${b.s.toFixed(6)},${b.w.toFixed(6)},${b.n.toFixed(6)},${b.e.toFixed(6)}`;
  const q = `[out:json][timeout:60];(way${DRIVE}(${bb});way["building"]["building"!~"^(no|roof)$"](${bb});relation["building"]["building"!~"^(no|roof)$"](${bb}););out geom;`;
  let lastErr;
  for (const ep of OVERPASS) {
    try {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 70000);
      const res = await fetch(`${ep}?data=${encodeURIComponent(q)}`, { signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`${new URL(ep).host} returned ${res.status}`);
      const json = await res.json();
      if (!json.elements || !json.elements.length) throw new Error(`${new URL(ep).host} returned no data`);
      return json;
    } catch (err) { lastErr = err; console.warn('Overpass', ep, err); }
  }
  throw lastErr || new Error('No Overpass server answered');
}

function buildRegion(json, b) {
  const proj = makeProjection((b.w + b.e) / 2, (b.s + b.n) / 2);
  const roads = [], rings = [], ringsLL = [];
  const coord = new Map(), nbrs = new Map();
  const link = (a, c) => { (nbrs.get(a) || nbrs.set(a, new Set()).get(a)).add(c); };
  for (const el of json.elements) {
    const t = el.tags || {};
    if (el.type === 'way' && t.highway && el.geometry) {
      const pts = el.geometry.map(g => proj.toXY([g.lon, g.lat]));
      el.nodes.forEach((id, i) => coord.set(id, pts[i]));
      for (let i = 1; i < el.nodes.length; i++) { link(el.nodes[i - 1], el.nodes[i]); link(el.nodes[i], el.nodes[i - 1]); }
      roads.push({ id: el.id, nodes: el.nodes, pts, tags: t });
    } else if (t.building && el.type === 'way' && el.geometry) {
      rings.push(el.geometry.map(g => proj.toXY([g.lon, g.lat])));
      ringsLL.push(el.geometry.map(g => [g.lon, g.lat]));
    } else if (t.building && el.type === 'relation') {
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

const inRegion = (reg, [lng, lat], marginM) => {
  const bb = bboxAround([lng, lat], marginM);
  return bb.s >= reg.b.s && bb.n <= reg.b.n && bb.w >= reg.b.w && bb.e <= reg.b.e;
};

async function regionFor(lngLat) {
  const hit = state.regions.find(r => inRegion(r, lngLat, 250));
  if (hit) return hit;
  return fetchRegion(bboxAround(lngLat, LOAD_RADIUS_M));
}

async function fetchRegion(b) {
  setStatus('Loading building footprints and streets from OpenStreetMap…', 'busy');
  const reg = buildRegion(await overpass(b), b);
  state.regions.push(reg);
  if (state.regions.length > 4) state.regions.shift();
  return reg;
}

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
    let reg = await regionFor(lngLat);
    let s = snap(reg, reg.proj.toXY(lngLat));
    if (!s) { setStatus('No drivable street within 120 ft of that point. Click closer to a street centerline.', 'warn'); return; }
    let edge = edgeFrom(reg, s);
    // Make sure the loaded buildings reach 330 ft past every part of the edge; otherwise reload around it.
    const xs = edge.line.map(p => p[0]), ys = edge.line.map(p => p[1]);
    const B = reg.bounds;
    if (Math.min(...xs) - MARGIN_FT < B.x0 || Math.max(...xs) + MARGIN_FT > B.x1 || Math.min(...ys) - MARGIN_FT < B.y0 || Math.max(...ys) + MARGIN_FT > B.y1) {
      const ll = edge.line.map(p => reg.proj.toLonLat(p));
      const lats = ll.map(p => p[1]), lngs = ll.map(p => p[0]);
      const pad = (MARGIN_FT + 150) / 3.28084;
      const c = [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
      const half = Math.max(LOAD_RADIUS_M, pad + 111132 * Math.max(Math.max(...lats) - Math.min(...lats), (Math.max(...lngs) - Math.min(...lngs)) * Math.cos(c[1] * DEG)) / 2);
      reg = await fetchRegion(bboxAround(c, half));
      s = snap(reg, reg.proj.toXY(lngLat));
      if (!s) { setStatus('Could not match that street after reloading. Try another click.', 'warn'); return; }
      edge = edgeFrom(reg, s);
    }
    setStatus('Casting rays…', 'busy');
    await new Promise(r => setTimeout(r, 20));
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
window.__fv = { analyzeAt, state, map };
syncControls();
