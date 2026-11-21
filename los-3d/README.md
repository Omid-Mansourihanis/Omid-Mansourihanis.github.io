# Block-level traffic LOS in 3D: Chicago, Houston, Los Angeles, New York

**Live:** https://omid-mansourihanis.github.io/los-3d/ · Data: [Mendeley Data, doi:10.17632/4ghf42bs96](https://doi.org/10.17632/4ghf42bs96) · Omid Mansourihanis

Interactive maps of the Level of Service (LOS) computed for 131,507 census blocks in the paper
*"What Predicts Urban Traffic Congestion? An Interpretable Machine Learning Analysis of Structural and Behavioral
Correlates Across Four Major U.S. Cities"*. Two 3D views share the same data and colours:

| Page | Basemap | Key needed | What you see |
|---|---|---|---|
| `osm3d.html` | OpenStreetMap via OpenFreeMap (MapLibre GL JS) | none | Blocks as 3D columns (height = Congestion Index), or flat blocks under OSM 3D buildings |
| `google3d.html` | Google Photorealistic 3D Tiles (deck.gl) | Google Map Tiles API key | Blocks draped on the photorealistic city surface |

## 1. Build the data

The data in `data/` is built on GitHub's servers by the workflow `.github/workflows/build-los-data.yml`
(run it again from the Actions tab, *Build LOS 3D map data*, if the Mendeley package changes). It downloads the
public Mendeley package with `scripts/fetch_mendeley.py`, then runs:

```bash
pip install -r scripts/requirements.txt
python scripts/build_data.py --data-dir /path/to/Mendeley_LOS_package/data/notebook_input --out data
```

This downloads 2020 TIGER/Line blocks with `pygris` (same counties as the paper's notebook), joins them on
`GEOID20`, simplifies them by 1.5 m and writes one gzipped GeoJSON per city plus `data/cities.json`.
Expect a few MB per city. Check the printed "matched … blocks" lines against the sample table of the paper.

Blocks without probe observations are kept and drawn grey ("no data"). Use `--analysed-only` to drop them.

## 2. Where it lives

This folder (`los-3d/`) is part of the GitHub Pages site of `Omid-Mansourihanis.github.io`; all paths are relative.

## 3. Google Photorealistic 3D (optional)

1. In Google Cloud Console create a project with billing, enable **Map Tiles API**, create an API key.
2. Restrict the key: *Application restriction* → HTTP referrers → `https://<user>.github.io/*`;
   *API restriction* → Map Tiles API only. Set a daily quota.
3. Put the key in `js/config.js` (`googleMapsApiKey`), or leave it empty so each visitor pastes their own key.

Keep Google's attribution visible (the page shows the credits of the tiles in view) and check the current
Map Tiles API pricing and policies before announcing the page.

## Colour scheme

| LOS | SPR (observed / free-flow speed) | Default (RdYlGn) | Colour-blind safe (RdYlBu) | 3-class |
|---|---|---|---|---|
| A | > 85% | `#1A9850` | `#4575B4` | Good `#4CAF50` |
| B | 70–85% | `#91CF60` | `#91BFDB` | Good |
| C | 55–70% | `#D9EF8B` | `#E0F3F8` | Medium `#FFC107` |
| D | 40–55% | `#FEE08B` | `#FEE090` | Medium |
| E | 25–40% | `#FC8D59` | `#FC8D59` | Poor `#E53935` |
| F | ≤ 25% | `#D73027` | `#D73027` | Poor |
| no probe data | – | `#9E9E9E` | `#9E9E9E` | – |

Other colour modes: Congestion Index 1–6 and continuous SPR. Views can be shared by URL
(`?city=chicago&mode=los3&pal=cvd#view=zoom/lat/lng/bearing/pitch`).

## Local preview

```bash
cd los-3d && python -m http.server 8000   # then open http://localhost:8000
```

## Sources

TomTom-derived block values (2024, Monday 07:00–09:00); U.S. Census Bureau TIGER/Line 2020;
© OpenStreetMap contributors (ODbL) via OpenFreeMap; Google Photorealistic 3D Tiles.
