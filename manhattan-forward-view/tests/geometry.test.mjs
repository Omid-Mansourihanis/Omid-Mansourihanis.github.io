// Run with: node tests/geometry.test.mjs
import assert from 'node:assert/strict';
import { buildObstacles, measureDirectedEdge, summarize, openingAt, closedForm, measurePoint, makeProjection, mphToR, rToMph } from '../js/geometry.js';

// Wall distance is the median of the 9 rays within 20 deg of perpendicular: w / sin(80 deg) in a clean canyon.
const W = w => w / Math.sin(80 * Math.PI / 180);
const box = (x0, x1, y0, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const canyon = (wl, wr) => buildObstacles([box(-wl - 200, -wl, -2000, 2000), box(wr, wr + 200, -2000, 2000)]);

// 1. Symmetric canyon, faces 44 ft apart, R = 80: ray count rule and closed form.
{
  const obs = canyon(22, 22);
  const p = measurePoint(obs, 0, 0, Math.PI / 2);          // heading north
  assert.equal(openingAt(p.dists, 80), 32.5);
  assert.ok(Math.abs(p.wl - W(22)) < 1e-6 && Math.abs(p.wr - W(22)) < 1e-6);
  assert.ok(Math.abs(closedForm(22, 22, 80) - 31.93) < 0.01);
}

// 2. Faces 104 ft apart (52 ft each side), R = 80 -> 82.5 (ray count), matches the overview figure.
{
  const p = measurePoint(canyon(52, 52), 0, 0, Math.PI / 2);
  assert.equal(openingAt(p.dists, 80), 82.5);
}

// 3. Saturation: walls 100 ft each side, R = 40 -> fully open 180.
{
  const p = measurePoint(canyon(50, 50), 0, 0, Math.PI / 2);
  assert.equal(openingAt(p.dists, 40), 180);
  assert.equal(closedForm(50, 50, 40), 180);
}

// 4. Direction of travel does not matter in a straight canyon; left/right swap correctly.
{
  const obs = canyon(20, 40);
  const n = measurePoint(obs, 0, 0, Math.PI / 2), s = measurePoint(obs, 0, 0, -Math.PI / 2);
  assert.ok(Math.abs(n.wl - W(20)) < 1e-6 && Math.abs(n.wr - W(40)) < 1e-6);
  assert.ok(Math.abs(s.wl - W(40)) < 1e-6 && Math.abs(s.wr - W(20)) < 1e-6);
}

// 5. Whole edge: five points, both directions, summary fields.
{
  const obs = canyon(22, 22);
  const line = [[0, -200], [0, 200]];
  const a = measureDirectedEdge(obs, line), b = measureDirectedEdge(obs, [...line].reverse());
  const s = summarize([a, b], 80);
  assert.equal(s.theta, 32.5);
  assert.ok(s.withinTol);
  assert.equal(s.asymmetry, 0);
  assert.equal(s.gapShare, 0);
  assert.equal(s.profile.length, 9);
  assert.equal(s.noFacing, false);
}

// 6. A frontage gap on the left raises the gap share and the opening above the closed form.
{
  const obs = buildObstacles([box(-222, -22, -2000, 5), box(-222, -22, 25, 2000), box(22, 222, -2000, 2000)]);
  const p = measurePoint(obs, 0, 0, Math.PI / 2);
  assert.ok(p.gapShare > 0);
  assert.ok(openingAt(p.dists, 80) > closedForm(p.wl, p.wr, 80));
}

// 7. No facing building on one side.
{
  const obs = buildObstacles([box(-222, -22, -2000, 2000)]);
  const p = measurePoint(obs, 0, 0, Math.PI / 2);
  assert.equal(p.noFacingRight, true);
}

// 8. Projection round trip and speed conversion.
{
  const pr = makeProjection(-73.98, 40.75);
  const [lon, lat] = pr.toLonLat(pr.toXY([-73.97, 40.76]));
  assert.ok(Math.abs(lon + 73.97) < 1e-9 && Math.abs(lat - 40.76) < 1e-9);
  assert.ok(Math.abs(rToMph(80) - 27.27) < 0.01);
  assert.ok(Math.abs(mphToR(25) - 73.33) < 0.01);
}
console.log('geometry tests passed');
