// Forward isovist geometry, following Mansourihanis (2026), Sections 4.1 to 4.3.
// Pure functions: no map, no network. Units are feet in a local plane.

export const SETTINGS = {
  K: 73,              // rays across the forward half plane
  dPhi: 2.5,          // degrees between rays
  maxLen: 1200,       // ft, ray limit
  R: 80,              // ft, headline look-ahead distance
  profileR: [30, 40, 60, 80, 100, 120, 160, 200, 240],
  T: 2,               // s, assumed look-ahead time (R = v * T); a labelling assumption only
  perpWindow: 20,     // degrees from perpendicular used for wall distances
  wallCap: 300,       // ft; a side whose median exceeds this has no facing building
  nPoints: 5,         // sample points per edge
  from: 0.3, to: 0.7, // sample points between 30% and 70% of the edge
  gapMinAngle: 45,    // frontage gap share uses rays with |phi| >= 45 degrees
  gapFactor: 1.5,     // ... that travel more than 1.5 x their canyon distance
  gapBeyond: 20,      // ... and more than 20 ft beyond the wall
  closedTol: 5        // degrees; "within 5 degrees of the closed form"
};

export const FT_PER_M = 3.28084;
export const PHIS = Array.from({ length: SETTINGS.K }, (_, k) => -90 + SETTINGS.dPhi * k); // negative = left

const DEG = Math.PI / 180;

// Local equirectangular projection around (lon0, lat0), in feet. Accurate to well under 1% over a few km.
export function makeProjection(lon0, lat0) {
  const p = lat0 * DEG;
  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p);
  const mPerDegLon = 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p);
  const kx = mPerDegLon * FT_PER_M, ky = mPerDegLat * FT_PER_M;
  return {
    toXY: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLonLat: ([x, y]) => [lon0 + x / kx, lat0 + y / ky]
  };
}

export function median(arr) {
  const a = arr.filter(v => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ---------------- obstacles ----------------
// polygons: array of rings, each ring an array of [x, y] in feet (closed or open).
export function buildObstacles(rings) {
  const edges = [];
  const polys = [];
  for (const ring of rings) {
    if (ring.length < 3) continue;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const [x, y] of ring) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
    polys.push({ ring, minx, miny, maxx, maxy });
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      edges.push([a[0], a[1], b[0], b[1],
        Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
    }
  }
  return { edges, polys };
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function insideBuilding(obs, x, y) {
  for (const p of obs.polys) {
    if (x < p.minx || x > p.maxx || y < p.miny || y > p.maxy) continue;
    if (pointInRing(x, y, p.ring)) return true;
  }
  return false;
}

// Edges whose bounding box lies within `reach` of (x, y).
function nearbyEdges(obs, x, y, reach) {
  const out = [];
  for (const e of obs.edges) {
    if (e[6] < x - reach || e[4] > x + reach || e[7] < y - reach || e[5] > y + reach) continue;
    out.push(e);
  }
  return out;
}

// Distance from origin along unit direction (dx, dy) to the first edge, or maxLen.
function castRay(edges, ox, oy, dx, dy, maxLen) {
  let best = maxLen;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const ex = e[2] - e[0], ey = e[3] - e[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const ax = e[0] - ox, ay = e[1] - oy;
    const t = (ax * ey - ay * ex) / den;
    if (t < 0 || t >= best) continue;
    const u = (ax * dy - ay * dx) / den;
    if (u < 0 || u > 1) continue;
    best = t;
  }
  return best;
}

// ---------------- per point ----------------
// heading: direction of travel in radians, math convention (0 = +x/east, counter-clockwise).
export function measurePoint(obs, x, y, heading, S = SETTINGS) {
  const edges = nearbyEdges(obs, x, y, S.maxLen);
  const dists = PHIS.map(phi => {
    const a = heading - phi * DEG;          // phi > 0 turns right (clockwise)
    return castRay(edges, x, y, Math.cos(a), Math.sin(a), S.maxLen);
  });
  const side = sgn => median(PHIS.map((phi, k) => (sgn * phi >= 90 - S.perpWindow ? dists[k] : NaN)));
  const mL = side(-1), mR = side(1);
  const wl = Math.min(mL, S.wallCap), wr = Math.min(mR, S.wallCap);
  let gapN = 0, gapD = 0;
  PHIS.forEach((phi, k) => {
    if (Math.abs(phi) < S.gapMinAngle) return;
    const w = phi < 0 ? wl : wr;
    const canyon = w / Math.sin(Math.abs(phi) * DEG);
    gapD++;
    if (dists[k] > S.gapFactor * canyon && dists[k] > canyon + S.gapBeyond) gapN++;
  });
  return {
    x, y, heading, dists, wl, wr,
    noFacingLeft: mL > S.wallCap, noFacingRight: mR > S.wallCap,
    gapShare: gapD ? gapN / gapD : NaN,
    inside: insideBuilding(obs, x, y)
  };
}

export function openingAt(dists, R, S = SETTINGS) {
  const n = dists.reduce((c, d) => c + (d >= R ? 1 : 0), 0);
  return Math.min(180, S.dPhi * n);
}

export function closedForm(wl, wr, R) {
  return (Math.asin(Math.min(1, wl / R)) + Math.asin(Math.min(1, wr / R))) / DEG;
}

// ---------------- edge sampling ----------------
// line: array of [x, y] vertices for one edge, in the direction of travel.
export function samplePoints(line, S = SETTINGS) {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  const L = cum[cum.length - 1];
  const pts = [];
  for (let j = 0; j < S.nPoints; j++) {
    const f = S.from + (S.to - S.from) * (S.nPoints === 1 ? 0.5 : j / (S.nPoints - 1));
    const s = f * L;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const a = line[i - 1], b = line[i];
    const seg = cum[i] - cum[i - 1] || 1;
    const t = (s - cum[i - 1]) / seg;
    pts.push({ x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, heading: Math.atan2(b[1] - a[1], b[0] - a[0]), frac: f });
  }
  return { pts, length: L };
}

// Measure one directed edge: five points, medians as in the paper.
export function measureDirectedEdge(obs, line, S = SETTINGS) {
  const { pts, length } = samplePoints(line, S);
  const points = pts.map(p => measurePoint(obs, p.x, p.y, p.heading, S));
  const at = R => median(points.map(p => openingAt(p.dists, R, S)));
  const cfAt = R => median(points.map(p => closedForm(p.wl, p.wr, R)));
  return {
    length, points,
    wl: median(points.map(p => p.wl)),
    wr: median(points.map(p => p.wr)),
    sep: median(points.map(p => p.wl + p.wr)),
    gapShare: median(points.map(p => p.gapShare)),
    noFacing: points.filter(p => p.noFacingLeft || p.noFacingRight).length > S.nPoints / 2,
    insideCount: points.filter(p => p.inside).length,
    opening: at, closed: cfAt
  };
}

// Summarize one or two directed measurements of the same physical segment at look-ahead R.
export function summarize(dirs, R, S = SETTINGS) {
  const mean = f => dirs.reduce((a, d) => a + f(d), 0) / dirs.length;
  const theta = mean(d => d.opening(R));
  const thetaC = mean(d => d.closed(R));
  const wl = mean(d => d.wl), wr = mean(d => d.wr);
  return {
    R, theta, thetaC,
    residual: theta - thetaC,
    withinTol: Math.abs(theta - thetaC) <= S.closedTol,
    sep: mean(d => d.sep),
    wl, wr,
    asymmetry: Math.abs(wl - wr) / (wl + wr),
    gapShare: mean(d => d.gapShare),
    profile: S.profileR.map(r => ({ R: r, theta: mean(d => d.opening(r)) })),
    noFacing: dirs.some(d => d.noFacing),
    insideCount: Math.max(...dirs.map(d => d.insideCount))
  };
}

// R in feet for a speed in mph under look-ahead time T seconds, and the inverse.
export const mphToR = (mph, T = SETTINGS.T) => mph * 5280 / 3600 * T;
export const rToMph = (R, T = SETTINGS.T) => R / T * 3600 / 5280;
