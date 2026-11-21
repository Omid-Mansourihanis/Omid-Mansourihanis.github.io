// Pure geometry and calculations (no Three.js), so they can be tested with Node.
// Coordinates: x = east, z = south (so north = -z), y = up. Units: meters.

/** Street side for each parcel orientation (north parcel = street on its south side). */
export const STREET_SIDE = { north: 'S', south: 'N', east: 'W', west: 'E' };
const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };

/** "Not required" (null) means no setback on that side. */
export const sbVal = (v) => (v == null ? 0 : Number(v));

/**
 * Lot rectangle centered at the origin.
 * frontage = side facing the street, depth = perpendicular side.
 */
export function lotRect(area, frontage, orientation) {
  const depth = area / frontage;
  const nsStreet = orientation === 'north' || orientation === 'south';
  const wx = nsStreet ? frontage : depth; // extent along x
  const wz = nsStreet ? depth : frontage; // extent along z
  return { xMin: -wx / 2, xMax: wx / 2, zMin: -wz / 2, zMax: wz / 2, frontage, depth, area };
}

/** Street rectangle next to the lot. */
export function streetRect(lot, orientation, width, extra = 30) {
  const side = STREET_SIDE[orientation];
  const lenX = lot.xMax - lot.xMin + extra * 2;
  const lenZ = lot.zMax - lot.zMin + extra * 2;
  switch (side) {
    case 'S': return { xMin: lot.xMin - extra, xMax: lot.xMax + extra, zMin: lot.zMax, zMax: lot.zMax + width, along: 'x', side, len: lenX };
    case 'N': return { xMin: lot.xMin - extra, xMax: lot.xMax + extra, zMin: lot.zMin - width, zMax: lot.zMin, along: 'x', side, len: lenX };
    case 'W': return { xMin: lot.xMin - width, xMax: lot.xMin, zMin: lot.zMin - extra, zMax: lot.zMax + extra, along: 'z', side, len: lenZ };
    case 'E': return { xMin: lot.xMax, xMax: lot.xMax + width, zMin: lot.zMin - extra, zMax: lot.zMax + extra, along: 'z', side, len: lenZ };
  }
}

/** Buildable envelope after the setbacks {N,S,E,W}. */
export function envelopeRect(lot, sb) {
  return {
    xMin: lot.xMin + sbVal(sb.W),
    xMax: lot.xMax - sbVal(sb.E),
    zMin: lot.zMin + sbVal(sb.N),
    zMax: lot.zMax - sbVal(sb.S),
  };
}

export const rectArea = (r) => Math.max(0, r.xMax - r.xMin) * Math.max(0, r.zMax - r.zMin);

/**
 * Which edge the building mass is placed against.
 * auto: north and south parcels place the mass on the north (common Iranian practice);
 * east and west parcels place it at the rear of the lot.
 */
export function anchorSide(orientation, anchor) {
  const street = STREET_SIDE[orientation];
  if (anchor === 'street') return street;
  if (anchor === 'rear') return OPPOSITE[street];
  return (orientation === 'north' || orientation === 'south') ? 'N' : OPPOSITE[street];
}

/** Cut a rectangle down to a strip of the given depth, against the anchor side. */
function stripFrom(env, side, depth) {
  const r = { ...env };
  if (side === 'N') r.zMax = env.zMin + depth;
  if (side === 'S') r.zMin = env.zMax - depth;
  if (side === 'W') r.xMax = env.xMin + depth;
  if (side === 'E') r.xMin = env.xMax - depth;
  return r;
}

/**
 * Full layout of one selection.
 * @param {object} p {area, frontage, orientation, roadWidth, floorH, anchor, parts:[{name,far,floors,coverage,setbacks}]}
 */
export function computeLayout(p) {
  const lot = lotRect(p.area, p.frontage, p.orientation);
  const street = streetRect(lot, p.orientation, p.roadWidth);
  const side = anchorSide(p.orientation, p.anchor);
  const depthAxisIsZ = side === 'N' || side === 'S';

  let baseY = 0;
  const parts = p.parts.map((part) => {
    const sb = part.setbacks[p.orientation];
    const env = envelopeRect(lot, sb);
    const envArea = rectArea(env);
    const allowedArea = (part.coverage / 100) * p.area;
    const envWidth = depthAxisIsZ ? env.xMax - env.xMin : env.zMax - env.zMin;
    const envDepth = depthAxisIsZ ? env.zMax - env.zMin : env.xMax - env.xMin;

    let foot, limited = false;
    if (envWidth <= 0 || envDepth <= 0) {
      foot = null;
      limited = true;
    } else {
      const needDepth = allowedArea / envWidth;
      if (needDepth >= envDepth - 1e-9) { foot = { ...env }; limited = allowedArea > envArea + 1e-6; }
      else foot = stripFrom(env, side, needDepth);
    }
    const footArea = foot ? rectArea(foot) : 0;
    const full = Math.floor(part.floors + 1e-9);
    const frac = +(part.floors - full).toFixed(3);
    let fracRect = null;
    if (foot && frac > 0) {
      const fd = (depthAxisIsZ ? foot.zMax - foot.zMin : foot.xMax - foot.xMin) * frac;
      fracRect = stripFrom(foot, side, fd);
    }
    const levels = full + (frac > 0 ? 1 : 0);
    const height = levels * p.floorH;
    const out = {
      name: part.name, far: part.far, floors: part.floors, coverage: part.coverage,
      setbacks: sb, envelope: env, envArea, allowedArea, foot, footArea,
      effCoverage: (footArea / p.area) * 100, limited,
      full, frac, fracRect, baseY, height,
      // As in the table's floor-area columns: exact FAR = floors x coverage (e.g. 316.25%, not the printed 316%)
      gfaTable: (part.floors * part.coverage / 100) * p.area,
      gfaDrawn: footArea * full + (fracRect ? rectArea(fracRect) : 0),
    };
    baseY += height;
    return out;
  });

  return {
    lot, street, side, parts,
    totalHeight: baseY,
    gfaTable: parts.reduce((s, x) => s + x.gfaTable, 0),
    gfaDrawn: parts.reduce((s, x) => s + x.gfaDrawn, 0),
  };
}

/** Default frontage for an area: depth = 2 x frontage. */
export const defaultFrontage = (area, ratio = 2) => Math.sqrt(area / ratio);
export const frontageBounds = (area) => ({ min: Math.sqrt(area / 4), max: Math.sqrt(area * 2) });
