#!/usr/bin/env python3
"""
Build static OpenStreetMap tiles of building footprints and drivable streets for Manhattan, so the page
does not have to query the public Overpass servers when a street is clicked.

Input : an .osm.pbf (or .osm) extract covering Manhattan, e.g. made with
        osmium extract --strategy complete_ways -b -74.035,40.69,-73.895,40.89 new-york-latest.osm.pbf -o manhattan.osm.pbf
Output: data/tiles/<i>_<j>.json  (tile grid: 0.005 deg longitude x 0.004 deg latitude, same as js/app.js)
        data/tiles/index.json    (tile list, coverage box, OSM data date)

Each tile holds every street and building whose bounding box touches it:
  {"r": [[way_id, [node ids], [[lon, lat], ...], {tags}], ...],      drivable streets (OSMnx "drive" filter)
   "b": [[way_id, [[lon, lat], ...]], ...],                           building ways
   "m": [[rel_id, [[[lon, lat], ...], ...]], ...]}                   outer rings of building relations

    python build_tiles.py manhattan.osm.pbf --out data/tiles --date 2026-11-20
"""
import argparse, json, math, os, re, sys
from collections import defaultdict
import osmium

TILE_LAT, TILE_LNG = 0.004, 0.005
BBOX = (-74.035, 40.69, -73.895, 40.89)          # w, s, e, n
KEEP_TAGS = ('highway', 'name', 'oneway', 'junction', 'maxspeed', 'bridge', 'tunnel')

# OSMnx "drive" network filter, as in js/app.js (Overpass "!~" = the regex does not match anywhere in the value)
HW_EXCL = re.compile(r'abandoned|bridleway|bus_guideway|construction|corridor|cycleway|elevator|escalator|footway|no|path|'
                     r'pedestrian|planned|platform|proposed|raceway|razed|service|steps|track')
def is_drive(t):
    hw = t.get('highway')
    if hw is None or HW_EXCL.search(hw):
        return False
    if re.search('yes', t.get('area', '')):
        return False
    if re.search('no', t.get('motor_vehicle', '')) or re.search('no', t.get('motorcar', '')):
        return False
    if re.search('private', t.get('access', '')):
        return False
    return True

def is_building(t):
    b = t.get('building')
    return b is not None and not re.fullmatch(r'no|roof', b)

R6 = lambda v: round(v, 6)


class RelPass(osmium.SimpleHandler):
    """Pass 1: building relations and the ids of their outer member ways."""
    def __init__(self):
        super().__init__()
        self.rels = {}                 # rel id -> [outer way ids]
        self.need = set()

    def relation(self, r):
        t = {k: v for k, v in r.tags}
        if not is_building(t):
            return
        outers = [m.ref for m in r.members if m.type == 'w' and m.role != 'inner']
        if outers:
            self.rels[r.id] = outers
            self.need.update(outers)


class WayPass(osmium.SimpleHandler):
    """Pass 2: streets, building ways and the geometry of relation members."""
    def __init__(self, need):
        super().__init__()
        self.need = need
        self.roads, self.buildings, self.member_geom = [], [], {}

    def way(self, w):
        try:
            coords = [(R6(n.lon), R6(n.lat)) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(coords) < 2:
            return
        t = {k: v for k, v in w.tags}
        if w.id in self.need:
            self.member_geom[w.id] = coords
        if 'highway' in t:
            if is_drive(t):
                self.roads.append((w.id, [n.ref for n in w.nodes], coords, {k: t[k] for k in KEEP_TAGS if k in t}))
        elif is_building(t) and len(coords) >= 3:
            self.buildings.append((w.id, coords))


def tiles_of(coords):
    lons = [c[0] for c in coords]; lats = [c[1] for c in coords]
    for i in range(math.floor(min(lons) / TILE_LNG), math.floor(max(lons) / TILE_LNG) + 1):
        for j in range(math.floor(min(lats) / TILE_LAT), math.floor(max(lats) / TILE_LAT) + 1):
            yield i, j


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('osm')
    ap.add_argument('--out', default='data/tiles')
    ap.add_argument('--date', default='')
    a = ap.parse_args()

    rp = RelPass(); rp.apply_file(a.osm)
    wp = WayPass(rp.need); wp.apply_file(a.osm, locations=True)
    w, s, e, n = BBOX
    # only tiles that lie wholly inside the extract box are complete; the page uses Overpass for the rest
    inside = lambda i, j: i * TILE_LNG >= w and (i + 1) * TILE_LNG <= e and j * TILE_LAT >= s and (j + 1) * TILE_LAT <= n

    T = defaultdict(lambda: {'r': [], 'b': [], 'm': []})
    for wid, nodes, coords, tags in wp.roads:
        for k in tiles_of(coords):
            if inside(*k): T[k]['r'].append([wid, nodes, coords, tags])
    for wid, coords in wp.buildings:
        for k in tiles_of(coords):
            if inside(*k): T[k]['b'].append([wid, coords])
    nrel = 0
    for rid, outers in rp.rels.items():
        rings = [wp.member_geom[o] for o in outers if o in wp.member_geom and len(wp.member_geom[o]) >= 3]
        if not rings:
            continue
        nrel += 1
        allc = [c for r in rings for c in r]
        for k in tiles_of(allc):
            if inside(*k): T[k]['m'].append([rid, rings])

    os.makedirs(a.out, exist_ok=True)
    for f in os.listdir(a.out):
        if f.endswith('.json'):
            os.remove(os.path.join(a.out, f))
    total = 0
    for (i, j), d in T.items():
        p = os.path.join(a.out, f'{i}_{j}.json')
        with open(p, 'w') as fh:
            json.dump(d, fh, separators=(',', ':'), ensure_ascii=False)
        total += os.path.getsize(p)
    index = {
        'tileLat': TILE_LAT, 'tileLng': TILE_LNG, 'bbox': list(BBOX),
        'osmDate': a.date, 'tiles': sorted(f'{i}_{j}' for i, j in T),
        'counts': {'streets': len(wp.roads), 'buildings': len(wp.buildings), 'buildingRelations': nrel}
    }
    with open(os.path.join(a.out, 'index.json'), 'w') as fh:
        json.dump(index, fh, separators=(',', ':'))
    print(f'{len(wp.roads):,} drivable street ways, {len(wp.buildings):,} building ways, {nrel:,} building relations')
    print(f'{len(T):,} tiles, {total / 1e6:.1f} MB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
