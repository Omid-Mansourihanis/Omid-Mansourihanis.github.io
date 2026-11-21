# Manhattan Forward View

An interactive 3D map of Manhattan. Click any street and the page computes the forward view a driver gets on that street segment, using the method in:

> Mansourihanis, O. (2026). *How much of the street ahead can a driver see? Forward views from open building footprints in Manhattan and their association with injury crashes.* Manuscript, not yet peer reviewed.

Each click finds the street segment between two intersections, places five points between 30% and 70% of its length, and casts 73 rays from each point across the half plane ahead of the driver. The **forward opening θ(R)** is the angle covered by rays that travel beyond a look-ahead distance *R* before they meet a building. The rays, the visible area within *R* and the five sample points are drawn on the map, and the panel shows the indices below.

Everything runs in the browser. There is no server and no API key.

## Live site

Published as part of my portfolio site: **https://omid-mansourihanis.github.io/manhattan-forward-view/**

To try it locally, serve this folder with any static server (for example `python -m http.server`) and open `http://localhost:8000`. Opening `index.html` directly from disk will not work, because browsers block ES modules on `file://` pages.

## Shareable links

After each click the address bar updates to `#lat,lng,R`, for example `#40.750500,-73.983900,80`. Opening that link reruns the analysis for the same street and look-ahead distance.

## Settings (fixed, as in the paper)

| Setting | Value |
|---|---|
| Rays per point | 73, every 2.5°, from 90° left to 90° right of the direction of travel |
| Sample points | 5, between 30% and 70% of the edge length |
| Segment value | median over the 5 points; two-way streets average both directions |
| Ray limit | 1,200 ft |
| Headline look-ahead | *R* = 80 ft (slider: 30 to 240 ft) |
| Look-ahead time | *T* = 2 s, an assumption used only to label distances as speeds (*R* = *v* · *T*) |
| Wall distance | median of the rays within 20° of perpendicular on each side, capped at 300 ft |
| Edges | the street is split at nodes whose degree in the drive network is not 2, as OSMnx simplification does |
| Street class | avenue if the OSM tag is `primary`, `secondary` or `trunk`, local otherwise |

## Indices in the panel

- **Forward opening θ(R):** 2.5° times the number of rays with distance ≥ *R*, capped at 180°.
- **Closed form θc:** arcsin(*w*l / *R*) + arcsin(*w*r / *R*), computed from the two wall distances only (Equation 2 in the paper).
- **Residual θ − θc:** how far the street departs from a clean canyon. Within 5° is reported as a clean canyon, as in the paper.
- **Wall distances and building-face separation *w* = *w*l + *w*r.**
- **Wall asymmetry:** |*w*l − *w*r| / (*w*l + *w*r).
- **Frontage gap share:** the share of rays at |φ| ≥ 45° that travel more than 1.5 times their canyon distance and more than 20 ft beyond the wall. The page summarizes it as the median over the five points.
- **Speed-matched opening:** the opening at *R* = posted limit × 2 s. The limit comes from the OSM `maxspeed` tag, or 25 mph when the tag is missing, which is the default the paper used.
- **Comparison with the paper:** this street's opening at 80 ft next to the published Manhattan mean for its class (local 67.2°, avenue 103.5°, Table 6), and its full profile next to the class means at each look-ahead distance (Table 7).

The page does not compute a composite score or a crash risk for a street. The paper reports associations across 4,902 segments without traffic volumes or speeds, and those cannot be turned into a prediction for one street.

## How this differs from the paper

- **Footprints and streets come from OpenStreetMap.** Inside Manhattan they are read from prebuilt tiles in `data/tiles/`, made from the Geofabrik New York extract by `scripts/build_tiles.py` (workflow *Build Manhattan tiles*; run it again from the Actions tab to refresh the data). Outside that box the page falls back to the Overpass API at the moment of the click. The paper used NYC planimetric building footprints and the NYC speed-limit layer. Values for a given street can therefore differ from the paper's.
- The paper excluded motorways, link roads, bridges, tunnels, unnamed segments, segments shorter than 80 ft, and segments with no facing building within 300 ft on one side. The page will not snap to motorways, link roads, bridges or tunnels, and it shows a warning for the other cases instead of hiding them.
- The geometry is planar, as in the paper. Building height, trees, parked cars and terrain do not block rays. The 3D buildings on the map come from the OpenFreeMap basemap and are for display only.

## Data sources and services

- Building footprints and streets: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL, queried through the public Overpass API. The page queries by GET (the main instance, overpass-api.de, rejects browser POST requests) and sends each query to overpass-api.de, `maps.mail.ru` and `overpass.private.coffee` at once, keeping the first answer. Data are loaded in fixed tiles of about 445 m × 420 m and kept for the session, so nearby clicks are answered without a new query, and the area around the map centre is loaded in the background after you pan or zoom. Building ways are requested without tags, which makes each answer smaller. Public Overpass servers are shared and sometimes busy. If a click fails, wait a minute and try again.
- Basemap and 3D buildings: [OpenFreeMap](https://openfreemap.org), Liberty style.
- Map library: [MapLibre GL JS](https://maplibre.org) 5.24.1, pinned. Version 6 has breaking changes.

## Optional: show your own segment results

If you export the paper's segment results as GeoJSON, the page can draw them as a colored street layer. Each feature needs an `opening_80` property in degrees. In `js/app.js`, set:

```js
const OWN_RESULTS_URL = 'data/segments.geojson';
```

A sketch of the export with GeoPandas. Replace the file and column names with the ones in your own output, since they are not reproduced here:

```python
import geopandas as gpd
seg = gpd.read_file("YOUR_SEGMENT_OUTPUT.gpkg")            # your segment-level result file
seg = seg.rename(columns={"YOUR_OPENING_COLUMN": "opening_80"})
seg[["opening_80", "geometry"]].to_crs(4326).to_file("data/segments.geojson", driver="GeoJSON")
```

## Tests

The ray-casting rules are tested on synthetic canyons with known answers, for example 32.5° for faces 44 ft apart and 82.5° for faces 104 ft apart at *R* = 80 ft:

```
node tests/geometry.test.mjs
```

## Files

```
index.html          page and panel
css/style.css       layout and styles
js/geometry.js      ray casting and indices (no map, no network)
js/reference.js     published Manhattan values used for comparison
js/app.js           map, data loading, drawing and panel
tests/              geometry tests
```

## License

No license is set yet. Choose one before inviting reuse of the code. The OpenStreetMap data used at run time remains under the ODbL.
