# US Census Block Dataset Builder

**Live picker:** <https://omid-mansourihanis.github.io/us-census-block-builder/>
&nbsp;·&nbsp;
[![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/Omid-Mansourihanis/Omid-Mansourihanis.github.io/blob/main/us-census-block-builder/run_pipeline.ipynb)

A no-server tool that lets anyone pick a **state → county → (optional) tract** and
build a reproducible, block-level urban-analysis dataset — Census 2020 (PL + DHC),
ACS 2023 5-year, OpenStreetMap streets & POIs, Microsoft Building Footprints, and
GHSL (building height / volume / urbanization) — then download it as a GeoPackage + CSV.

The geography picker is a static web page (GitHub Pages). The heavy processing runs in
**Google Colab**, which has the disk, memory, and Python libraries the pipeline needs.

## How it works

```
┌─ GitHub Pages (static) ─┐        ┌─ Google Colab (compute) ──────────┐
│  index.html             │        │  run_pipeline.ipynb               │
│  state → county → tract │ token  │  decodes token                    │
│  → builds a token  ─────┼───────▶│  fetches census_pipeline_modular  │
└─────────────────────────┘ paste  │  run_county(...) → GeoPackage/CSV │
                                    └───────────────────────────────────┘
```

The web page can't run the pipeline itself (it needs `geopandas`, `rasterio`, multi-GB
downloads). So it encodes your geography choice into a short **token**; you paste that into
the Colab notebook, which runs the real pipeline and hands you the dataset.

## Files

```
us-census-block-builder/
├── index.html                   ← geography picker (served by GitHub Pages)
├── run_pipeline.ipynb           ← Colab notebook that builds the dataset
├── census_pipeline_modular.py   ← the pipeline: run_county(state_fips, county_fips, ...)
├── data/states_counties.json    ← 51 states/DC and 3,143 counties (2020 Census)
└── README.md
```

The notebook downloads `census_pipeline_modular.py` from this folder
(`raw.githubusercontent.com/.../main/us-census-block-builder/census_pipeline_modular.py`),
so both links already point at this repository. If you fork it, change
`COLAB_NOTEBOOK_URL` in `index.html` and `PIPELINE_RAW_URL` in notebook Cell 2.

## Using it

1. Open the [picker](https://omid-mansourihanis.github.io/us-census-block-builder/).
2. Choose a **state**, then a **county**. Optionally choose one **tract** for a quick test.
3. Click **Build configuration →**, then **Copy token**.
4. Click **Open the builder notebook in Google Colab**.
5. Paste the **token** and your free
   [Census API key](https://api.census.gov/data/key_signup.html) into Cell 1.
6. **Runtime → Run all.** The GeoPackage + CSV download when it finishes.

You can also call the pipeline directly in Python:

```python
from census_pipeline_modular import run_county
gdf = run_county("48", "303", census_api_key="YOUR_KEY", county_name="Lubbock")
```

## What the dataset contains

| Group | Source | Native geography → block |
|---|---|---|
| Population, race, Hispanic origin, housing units | Decennial 2020 PL 94-171 | block |
| Age × sex (P12), occupancy, tenure, urban/rural, vacancy | Decennial 2020 DHC | block group (tract fallback) |
| Income, poverty, rent burden, structure type, year built, labour force, education | ACS 2023 5-year | block group |
| Commute mode, travel time, occupation, industry | ACS 2023 5-year | tract |
| Area, perimeter, Polsby–Popper, Schwartzberg, elongation, water flag | TIGER/Line 2020 (derived) | block |
| Street length & density, intersections, signals, sidewalks, bike lanes, POI distances | OpenStreetMap (OSMnx) | block (buffered join) |
| Building count, area, coverage, density | Microsoft Building Footprints | block (centroid inside) |
| Settlement class, building height, built volume | GHSL R2023A | block (centroid sample) |

Every run also writes `*_metadata.csv`, which lists the source and native geography of each column.
Block-group and tract values are repeated on every block inside them; they are not disaggregated.

## Notes & limits

- **Whole-county builds are heavy.** GHSL (~2 GB first run) and building footprints
  (hundreds of MB per state) mean 10–30 min and several GB of Colab disk. Turn off
  `INCLUDE_GHSL` / `INCLUDE_BUILDINGS` in Cell 1 for a lighter run.
- **Single-tract mode is Census-only** — a fast way to test the geography wiring. The
  built-environment layers (OSM / buildings / GHSL) are county-scoped in the pipeline, so
  run a whole-county build to include them.
- **Traffic (AADT) and transit (GTFS)** columns appear only where the pipeline has a
  regional source (Illinois / Chicago by default). Other counties get the Census + OSM +
  buildings + GHSL layers.
- **Coverage:** the 50 states and DC. Puerto Rico is not offered because there is no
  Microsoft Building Footprints state file for it.
- **States and counties** are bundled with the page (`data/states_counties.json`, the 3,143
  county equivalents of the 2020 Census, matching the 2020 TIGER/Line blocks the pipeline uses),
  so the picker works even where `api.census.gov` is blocked or unreachable.
- **Tracts** are listed live from the Census API. If that request fails, the page switches to a
  text box: leave it empty for the whole county or type a 6-digit tract code.
  The Colab notebook itself runs on Google's servers, so it reaches the Census API either way.
- Nothing is stored on a server; the token is encoded entirely in your browser.

## Variable check (November 2026)

The variable codes were checked against the Census API metadata
(`api.census.gov/data/2023/acs/acs5/variables/…` and `…/2020/dec/dhc/variables/…`),
and these labels were corrected:

- **B08301 (commute mode):** labels from `B08301_007E` on were shifted; they now follow
  the published order (4-person carpool, 5–6, 7+, public transit, bus, subway, commuter
  rail, light rail, ferry, taxi, motorcycle, bicycle, walked, other, worked from home).
- **B08302** is *time of departure to work*, not travel time. It was replaced by
  `B08013_001E` (aggregate travel time) and a derived `Mean_TravelTime_min`
  = aggregate ÷ (workers − worked from home).
- **Poverty:** "above poverty" now uses `B17017_031E` and `B17021_019E`
  (`…_003E` are sub-counts of *below* poverty).
- **DHC housing:** H2 is urban/rural, H3 occupancy, H4 tenure (with mortgage / free and
  clear / renter), H5 vacancy (`Vacant_ForRent`), H8 population in occupied units.
  `Avg_Household_Size` is now derived as H8 ÷ occupied units.
- **Education:** `B15003_022E`–`025E` (bachelor's, master's, professional, doctorate) added.
- **C24010:** `022E`/`023E` relabelled as firefighting & other protective / law enforcement.

## License / attribution

Data sources carry their own terms: US Census Bureau (public domain),
OpenStreetMap (ODbL), Microsoft Building Footprints (ODbL), GHSL / JRC (open).
Cite each in any published work.

Omid Mansourihanis · Texas Tech University ·
[omid-mansourihanis.github.io](https://omid-mansourihanis.github.io/)
