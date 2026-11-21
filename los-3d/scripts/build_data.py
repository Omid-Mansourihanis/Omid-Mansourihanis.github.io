#!/usr/bin/env python3
"""
Build the web data for the interactive LOS 3D viewer.

Input : the four city CSVs from the Mendeley package (data/notebook_input/*.csv)
        + 2020 TIGER/Line census blocks (downloaded with pygris, same as the paper's notebook)
Output: docs/data/<city>.geojson.gz  (one file per city, loaded on demand by the web pages)
        docs/data/cities.json        (centre, bbox and class counts per city, used for the legend)

Usage:
    pip install geopandas pyogrio pygris pandas numpy
    python scripts/build_data.py --data-dir path/to/data/notebook_input --out docs/data

Property keys are kept short to reduce file size:
    g = GEOID20, l = LOS_Final (A-F), c = Congestion Index (1-6), s = Speed Performance Ratio (%),
    m = street length (m), x = 0 analysed / 1 no probe observations / 2 missing outcome
"""
import argparse, gzip, json, os, sys
import numpy as np
import pandas as pd

CITIES = {  # slug: (label, csv file, county FIPS used in the paper's notebook)
    'chicago':     ('Chicago',     'Chicago_Blocks_Final.csv',    ['17031', '17043']),
    'houston':     ('Houston',     'Houston_Blocks_Final.csv',    ['48201', '48157', '48339']),
    'los-angeles': ('Los Angeles', 'LosAngeles_Blocks_Final.csv', ['06037']),
    'new-york':    ('New York',    'NYC_Blocks_Final.csv',        ['36005', '36047', '36061', '36081', '36085']),
}
KEEP = ['GEOID20', 'LOS_Final', 'Congestion', 'Spd_Perf_P', 'Length', 'analysed', 'exclusion_reason']
EXCL_CODE = {'no probe observations': 1, 'missing outcome': 2}


def read_city_csv(path):
    df = pd.read_csv(path, dtype={'GEOID20': str}, usecols=KEEP, low_memory=False)
    bad = df['GEOID20'].isna() | df['GEOID20'].str.contains('nan', case=False) | df['GEOID20'].str.startswith('000000')
    if bad.any():
        print(f'   {bad.sum()} rows have no usable GEOID (e.g. "000000000000nan") and cannot be mapped '
              f'({int(df.loc[bad, "analysed"].sum())} of them analysed)')
    df = df[~bad].copy()
    df['GEOID20'] = df['GEOID20'].str.zfill(15)
    dup = df['GEOID20'].duplicated(keep='first')
    if dup.any():
        print(f'   {dup.sum()} duplicate GEOIDs dropped (first kept)')
        df = df[~dup]
    return df


def tiger_blocks(fips_list, cache_dir):
    """2020 TIGER/Line blocks for the given counties, cached as GeoParquet."""
    import geopandas as gpd
    parts = []
    for f in fips_list:
        cp = os.path.join(cache_dir, f'tiger2020_blocks_{f}.gpkg')
        if os.path.exists(cp):
            g = gpd.read_file(cp)
        else:
            from pygris import blocks
            g = blocks(state=f[:2], county=f[2:], year=2020, cache=True)
            g = g[['GEOID20', 'geometry']]
            g.to_file(cp, driver='GPKG')
        parts.append(g)
    g = gpd.GeoDataFrame(pd.concat(parts, ignore_index=True), geometry='geometry', crs=parts[0].crs)
    g['GEOID20'] = g['GEOID20'].astype(str).str.zfill(15)
    return g


def round_coords(geom, nd):
    import shapely
    return shapely.transform(geom, lambda c: np.round(c, nd))


def feature(row, geom):
    x = 0 if row.analysed == 1 else EXCL_CODE.get(row.exclusion_reason, 2)
    num = lambda v, f: None if pd.isna(v) else f(v)
    props = {'g': row.GEOID20, 'x': x}
    if x == 0:
        props.update(l=row.LOS_Final, c=num(row.Congestion, int), s=num(row.Spd_Perf_P, lambda v: round(float(v), 1)))
    props['m'] = num(row.Length, lambda v: int(round(float(v))))
    return {'type': 'Feature', 'properties': props, 'geometry': geom.__geo_interface__}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data-dir', required=True, help='folder with the four *_Blocks_Final.csv files')
    ap.add_argument('--out', default='docs/data')
    ap.add_argument('--cache', default='.cache')
    ap.add_argument('--simplify', type=float, default=1.5, help='simplification tolerance in metres (0 = off)')
    ap.add_argument('--precision', type=int, default=6, help='decimal places for lon/lat (6 ~ 0.1 m)')
    ap.add_argument('--include-excluded', action='store_true', default=True,
                    help='also map blocks without probe data (drawn grey, labelled "no data")')
    ap.add_argument('--analysed-only', dest='include_excluded', action='store_false')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True); os.makedirs(a.cache, exist_ok=True)

    summary = {}
    for slug, (label, csv, fips) in CITIES.items():
        print(f'== {label}')
        df = read_city_csv(os.path.join(a.data_dir, csv))
        if not a.include_excluded:
            df = df[df['analysed'] == 1]
        geo = tiger_blocks(fips, a.cache)
        geo = geo[geo['GEOID20'].isin(set(df['GEOID20']))].to_crs(5070)  # equal-area metres, as in the notebook
        if a.simplify > 0:
            geo['geometry'] = geo.geometry.simplify(a.simplify, preserve_topology=True)
        geo = geo.to_crs(4326).set_index('GEOID20')
        df = df[df['GEOID20'].isin(geo.index)]
        print(f'   matched {len(df):,} blocks to TIGER geometry ({int(df.analysed.sum()):,} analysed)')

        feats = [feature(r, round_coords(geo.at[r.GEOID20, 'geometry'], a.precision))
                 for r in df.itertuples(index=False)]
        fc = {'type': 'FeatureCollection', 'features': feats}
        path = os.path.join(a.out, f'{slug}.geojson.gz')
        with gzip.open(path, 'wt', encoding='utf-8', compresslevel=9) as fh:
            json.dump(fc, fh, separators=(',', ':'))
        print(f'   wrote {path} ({os.path.getsize(path) / 1e6:.1f} MB gzipped)')

        an = df[df['analysed'] == 1]
        b = geo.total_bounds  # minx, miny, maxx, maxy
        summary[slug] = {
            'label': label,
            'file': f'{slug}.geojson.gz',
            'bbox': [round(float(v), 5) for v in b],
            'center': [round(float((b[0] + b[2]) / 2), 5), round(float((b[1] + b[3]) / 2), 5)],
            'n_mapped': int(len(df)), 'n_analysed': int(len(an)),
            'los_counts': {k: int(v) for k, v in an['LOS_Final'].value_counts().sort_index().items()},
            'no_data': int((df['analysed'] != 1).sum()),
            'mean_ci': round(float(an['Congestion'].mean()), 3),
        }
    with open(os.path.join(a.out, 'cities.json'), 'w') as fh:
        json.dump(summary, fh, indent=1)
    print('done ->', os.path.join(a.out, 'cities.json'))


if __name__ == '__main__':
    sys.exit(main())
