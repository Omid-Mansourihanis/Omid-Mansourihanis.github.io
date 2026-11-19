"""
================================================================================
US Census + Built-Environment Block Pipeline — Modular Edition
================================================================================
Wraps the full Cook County notebook into run_county(state_fips, county_fips, ...)
so the same workflow runs for ANY US county by changing two arguments.

    from census_pipeline_modular import run_county
    gdf = run_county("17", "031", census_api_key="YOUR_KEY")          # Cook County, IL
    gdf = run_county("04", "013", census_api_key="YOUR_KEY")          # Maricopa, AZ
    gdf = run_county("53", "033", census_api_key="YOUR_KEY")          # King County, WA

WHAT GENERALIZES (works for any county, no edits):
    - Census 2020 PL + DHC, ACS 2023 5-year   (national APIs)
    - Block geometries (pygris / TIGER)        (national)
    - Geometric attributes                     (derived)
    - OSM streets / POIs / buildings           (global)
    - Microsoft Building Footprints            (per-STATE files, auto-resolved)
    - GHSL SMOD / BUILT-H / BUILT-V            (global)

WHAT IS REGION-SPECIFIC (handled via flags / config, NOT silently wrong):
    - metric_crs        -> auto-derived UTM zone from county centroid
    - DOT AADT          -> Illinois-only endpoint; skipped unless state==17
                           (other states have different DOT APIs / schemas)
    - Transit GTFS      -> caller supplies a list of GTFS URLs; defaults to
                           CTA+Metra only for Cook County, IL

IMPORTANT HONESTY NOTES:
    - The AADT and GTFS steps are NOT universal. For a non-IL county they are
      skipped by default. To add traffic/transit elsewhere, pass your region's
      DOT endpoint / GTFS URLs explicitly (see TransitConfig / aadt_config).
    - Heavy downloads: MBF per-state file (hundreds of MB) and GHSL 100m globals
      (~2 GB each) are cached on disk; first run for a new STATE re-downloads MBF,
      but GHSL globals are shared across all counties once fetched.
================================================================================
"""

import os
import io
import re
import time
import zipfile
import requests
import numpy as np
import pandas as pd
import geopandas as gpd
from pathlib import Path
from math import hypot

# ------------------------------------------------------------------ #
#  STATE FIPS -> (USPS abbr, Microsoft-footprints file basename)
# ------------------------------------------------------------------ #
STATE_FIPS = {
    "01": ("AL", "Alabama"), "02": ("AK", "Alaska"), "04": ("AZ", "Arizona"),
    "05": ("AR", "Arkansas"), "06": ("CA", "California"), "08": ("CO", "Colorado"),
    "09": ("CT", "Connecticut"), "10": ("DE", "Delaware"),
    "11": ("DC", "DistrictofColumbia"), "12": ("FL", "Florida"),
    "13": ("GA", "Georgia"), "15": ("HI", "Hawaii"), "16": ("ID", "Idaho"),
    "17": ("IL", "Illinois"), "18": ("IN", "Indiana"), "19": ("IA", "Iowa"),
    "20": ("KS", "Kansas"), "21": ("KY", "Kentucky"), "22": ("LA", "Louisiana"),
    "23": ("ME", "Maine"), "24": ("MD", "Maryland"), "25": ("MA", "Massachusetts"),
    "26": ("MI", "Michigan"), "27": ("MN", "Minnesota"), "28": ("MS", "Mississippi"),
    "29": ("MO", "Missouri"), "30": ("MT", "Montana"), "31": ("NE", "Nebraska"),
    "32": ("NV", "Nevada"), "33": ("NH", "NewHampshire"), "34": ("NJ", "NewJersey"),
    "35": ("NM", "NewMexico"), "36": ("NY", "NewYork"), "37": ("NC", "NorthCarolina"),
    "38": ("ND", "NorthDakota"), "39": ("OH", "Ohio"), "40": ("OK", "Oklahoma"),
    "41": ("OR", "Oregon"), "42": ("PA", "Pennsylvania"), "44": ("RI", "RhodeIsland"),
    "45": ("SC", "SouthCarolina"), "46": ("SD", "SouthDakota"), "47": ("TN", "Tennessee"),
    "48": ("TX", "Texas"), "49": ("UT", "Utah"), "50": ("VT", "Vermont"),
    "51": ("VA", "Virginia"), "53": ("WA", "Washington"), "54": ("WV", "WestVirginia"),
    "55": ("WI", "Wisconsin"), "56": ("WY", "Wyoming"),
}

# Chicago-region default transit feeds (only sensible for Cook County, IL)
CHICAGO_GTFS = {
    "CTA":   "https://www.transitchicago.com/downloads/sch_data/google_transit.zip",
    "Metra": "https://schedules.metrarail.com/gtfs/schedule.zip",
}


# ================================================================== #
#  UTILITY: pick an appropriate metric CRS (UTM zone) for a county
# ================================================================== #
def utm_crs_for(lon, lat):
    """Return an EPSG code string for the UTM zone containing (lon, lat).
    UTM is in METERS (not feet), so all downstream feet conversions are
    handled by a unit factor returned alongside."""
    zone = int((lon + 180) // 6) + 1
    if lat >= 0:
        epsg = 32600 + zone   # northern hemisphere
    else:
        epsg = 32700 + zone
    return f"EPSG:{epsg}"


# ================================================================== #
#  CENSUS API CLIENT (unchanged logic, just encapsulated)
# ================================================================== #
class CensusAPI:
    BASE = "https://api.census.gov/data"
    MAX_VARS = 49

    def __init__(self, api_key=""):
        self.api_key = api_key
        self.session = requests.Session()

    def _get(self, url, params):
        if self.api_key:
            params = {**params, "key": self.api_key}
        r = self.session.get(url, params=params, timeout=60)
        if r.status_code != 200:
            raise RuntimeError(f"Census API {r.status_code} on {url}: {r.text[:300]}")
        return r.json()

    def fetch(self, dataset, variables, geography, state_fips, county_fips,
              tract_fips="*", verbose=True):
        url = f"{self.BASE}/{dataset}"
        in_clause = f"state:{state_fips} county:{county_fips}"
        if geography in ("block", "block group"):
            in_clause += f" tract:{tract_fips}"
        chunks = [variables[i:i + self.MAX_VARS]
                  for i in range(0, len(variables), self.MAX_VARS)]
        frames = []
        for i, chunk in enumerate(chunks):
            params = {"get": "NAME," + ",".join(chunk),
                      "for": f"{geography}:*", "in": in_clause}
            try:
                data = self._get(url, params)
            except RuntimeError as e:
                if verbose:
                    print(f"    ⚠ batch {i} failed: {str(e)[:150]}")
                continue
            header, *rows = data
            frames.append(pd.DataFrame(rows, columns=header))
            time.sleep(0.2)
        if not frames:
            return pd.DataFrame()
        geo_cols = [c for c in frames[0].columns
                    if c in {"state", "county", "tract", "block group", "block", "NAME"}]
        out = frames[0]
        for f in frames[1:]:
            out = out.merge(f, on=geo_cols, how="outer")
        for v in variables:
            if v in out.columns:
                out[v] = pd.to_numeric(out[v], errors="coerce")
        return out


# ================================================================== #
#  VARIABLE -> ALIAS MAPS  (identical to notebook Cells 2 + 13)
# ================================================================== #
def build_alias_maps():
    PL_VARS = {
        "H1_001N": "Total_Housing_Units", "H1_002N": "Occupied_Units",
        "H1_003N": "Vacant_Units", "P1_001N": "Total_Population",
        "P1_002N": "Pop_One_Race", "P1_003N": "Pop_White", "P1_004N": "Pop_Black",
        "P1_005N": "Pop_Native", "P1_006N": "Pop_Asian",
        "P1_007N": "Pop_Pacific_Islander", "P1_008N": "Pop_Other_Race",
        "P2_002N": "Pop_Hispanic",
    }
    _p12 = [
        "Pop_Age_Sex_Total","Pop_Male","Male_Under5","Male_5to9","Male_10to14",
        "Male_15to17","Male_18to19","Male_20","Male_21","Male_22to24","Male_25to29",
        "Male_30to34","Male_35to39","Male_40to44","Male_45to49","Male_50to54",
        "Male_55to59","Male_60to61","Male_62to64","Male_65to66","Male_67to69",
        "Male_70to74","Male_75to79","Male_80to84","Male_85Plus","Pop_Female",
        "Female_Under5","Female_5to9","Female_10to14","Female_15to17","Female_18to19",
        "Female_20","Female_21","Female_22to24","Female_25to29","Female_30to34",
        "Female_35to39","Female_40to44","Female_45to49","Female_50to54","Female_55to59",
        "Female_60to61","Female_62to64","Female_65to66","Female_67to69","Female_70to74",
        "Female_75to79","Female_80to84","Female_85Plus",
    ]
    DHC_P12 = {f"P12_{i+1:03d}N": a for i, a in enumerate(_p12)}
    # Codes checked against api.census.gov/data/2020/dec/dhc/variables
    # (H2 = urban/rural, H3 = occupancy, H4 = tenure, H5 = vacancy status,
    #  H8 = population in occupied housing units).
    DHC_HOUSING = {
        "H2_002N": "Urban_Housing_Units", "H2_003N": "Rural_Housing_Units",
        "H3_002N": "Occupied_Units_DHC", "H3_003N": "Vacant_Units_DHC",
        "H4_002N": "Owned_With_Mortgage", "H4_003N": "Owned_Free_Clear",
        "H4_004N": "Renter_Occupied", "H5_002N": "Vacant_ForRent",
        "H8_001N": "Pop_in_Occupied_Units",
    }
    DHC_VARS = {**DHC_P12, **DHC_HOUSING}

    ACS_VARS = {
        "B19013_001E": "Median_HH_Income", "B19001_001E": "Total_HH_Income",
        "B19001_002E": "HH_Inc_Under10K", "B19001_003E": "HH_Inc_10to15K",
        "B19001_004E": "HH_Inc_15to20K", "B19001_005E": "HH_Inc_20to25K",
        "B19001_006E": "HH_Inc_25to30K", "B19001_007E": "HH_Inc_30to35K",
        "B19001_008E": "HH_Inc_35to40K", "B19001_009E": "HH_Inc_40to45K",
        "B19001_010E": "HH_Inc_45to50K", "B19001_011E": "HH_Inc_50to60K",
        "B19001_012E": "HH_Inc_60to75K", "B19001_013E": "HH_Inc_75to100K",
        "B19001_014E": "HH_Inc_100to125K", "B19001_015E": "HH_Inc_125to150K",
        "B19001_016E": "HH_Inc_150to200K", "B19001_017E": "HH_Inc_200KPlus",
        "B19301_001E": "Per_Capita_Income",
        "B17017_001E": "Total_HH_Poverty", "B17017_002E": "HH_Below_Poverty",
        "B17017_031E": "HH_Above_Poverty", "B17021_001E": "Total_Pop_Poverty",
        "B17021_002E": "Pop_Below_Poverty", "B17021_019E": "Pop_Above_Poverty",
        "C17002_001E": "Total_Pop_PovRatio", "C17002_002E": "Pop_Under50Pct_Pov",
        "C17002_003E": "Pop_50to99Pct_Pov", "C17002_004E": "Pop_100to124Pct_Pov",
        "C17002_005E": "Pop_125to149Pct_Pov", "C17002_006E": "Pop_150to184Pct_Pov",
        "C17002_007E": "Pop_185to199Pct_Pov", "C17002_008E": "Pop_200PctPlus_Pov",
        "B25003_001E": "Total_Occupied_Tenure", "B25003_002E": "Owner_Occupied_ACS",
        "B25003_003E": "Renter_Occupied_ACS", "B25002_001E": "Total_Units_Occupancy",
        "B25002_002E": "Occupied_ACS", "B25002_003E": "Vacant_ACS",
        "B25077_001E": "Median_Home_Value", "B25064_001E": "Median_Gross_Rent",
        "B25070_001E": "Total_Renters_GrossRent", "B25070_002E": "Rent_Under10Pct",
        "B25070_003E": "Rent_10to15Pct", "B25070_004E": "Rent_15to20Pct",
        "B25070_005E": "Rent_20to25Pct", "B25070_006E": "Rent_25to30Pct",
        "B25070_007E": "Rent_30to35Pct", "B25070_008E": "Rent_35to40Pct",
        "B25070_009E": "Rent_40to50Pct", "B25070_010E": "Rent_50PctPlus",
        "B25070_011E": "Rent_NotComputed",
        "B25024_001E": "Total_Units_Structure", "B25024_002E": "Units_1Detached",
        "B25024_003E": "Units_1Attached", "B25024_004E": "Units_2",
        "B25024_005E": "Units_3to4", "B25024_006E": "Units_5to9",
        "B25024_007E": "Units_10to19", "B25024_008E": "Units_20to49",
        "B25024_009E": "Units_50Plus", "B25024_010E": "Units_Mobile",
        "B25024_011E": "Units_Vehicle",
        "B25034_001E": "Total_Units_YearBuilt", "B25034_002E": "Built_2020Plus",
        "B25034_003E": "Built_2010to2019", "B25034_004E": "Built_2000to2009",
        "B25034_005E": "Built_1990to1999", "B25034_006E": "Built_1980to1989",
        "B25034_007E": "Built_1970to1979", "B25034_008E": "Built_1960to1969",
        "B25034_009E": "Built_1950to1959", "B25034_010E": "Built_1940to1949",
        "B25034_011E": "Built_Pre1940",
        "B23025_001E": "Pop_16Plus", "B23025_002E": "In_LaborForce",
        "B23025_003E": "Civilian_LaborForce", "B23025_004E": "Employed",
        "B23025_005E": "Unemployed", "B23025_006E": "Armed_Forces",
        "B23025_007E": "Not_in_LaborForce",
        "B15003_001E": "Pop_25Plus", "B15003_002E": "Edu_NoSchool",
        "B15003_003E": "Edu_Nursery", "B15003_004E": "Edu_Kindergarten",
        "B15003_005E": "Edu_Grade1", "B15003_006E": "Edu_Grade2",
        "B15003_007E": "Edu_Grade3", "B15003_008E": "Edu_Grade4",
        "B15003_009E": "Edu_Grade5", "B15003_010E": "Edu_Grade6",
        "B15003_011E": "Edu_Grade7", "B15003_012E": "Edu_Grade8",
        "B15003_013E": "Edu_Grade9", "B15003_014E": "Edu_Grade10",
        "B15003_015E": "Edu_Grade11", "B15003_016E": "Edu_Grade12_NoDiploma",
        "B15003_017E": "Edu_HS_Diploma", "B15003_018E": "Edu_GED",
        "B15003_019E": "Edu_SomeCollege_Under1Yr",
        "B15003_020E": "Edu_SomeCollege_NoDegree", "B15003_021E": "Edu_Associates",
        "B15003_022E": "Edu_Bachelors", "B15003_023E": "Edu_Masters",
        "B15003_024E": "Edu_Professional", "B15003_025E": "Edu_Doctorate",
    }

    # Tract-only ACS, with FINAL occupation/industry aliases (Cells 2 + 13)
    C24010 = ["Total_Employed_Occ","Male_Employed","Male_Mgmt_Prof","Male_Mgmt_Bus",
        "Male_Management","Male_Business_Finance","Male_Computer_Eng_Sci","Male_Computer_Math",
        "Male_Architecture_Eng","Male_Science","Male_Edu_Arts_Media","Male_Social_Service",
        "Male_Legal","Male_Education","Male_Arts_Media","Male_Healthcare_Tech",
        "Male_Healthcare_Pract","Male_Health_Technician","Male_Service","Male_Healthcare_Support",
        "Male_Protective_Service","Male_Firefighting_OtherProtective","Male_Law_Enforcement","Male_Food_Service",
        "Male_Cleaning_Maint","Male_Personal_Care","Male_Sales_Office","Male_Sales",
        "Male_Office_Admin","Male_NatRes_Constr_Maint","Male_Farming_Fish_Forest","Male_Construction",
        "Male_Install_Repair","Male_Prod_Transport","Male_Production","Male_Transportation",
        "Male_Material_Moving","Female_Employed","Female_Mgmt_Prof","Female_Mgmt_Bus",
        "Female_Management","Female_Business_Finance","Female_Computer_Eng_Sci","Female_Computer_Math",
        "Female_Architecture_Eng","Female_Science","Female_Edu_Arts_Media","Female_Social_Service",
        "Female_Legal","Female_Education","Female_Arts_Media","Female_Healthcare_Tech",
        "Female_Healthcare_Pract","Female_Health_Technician","Female_Service","Female_Healthcare_Support",
        "Female_Protective_Service","Female_Firefighting_OtherProtective","Female_Law_Enforcement"]
    C24030 = ["Total_Employed_Ind","Male_Employed_Ind","Male_Agri_Mining","Male_Agriculture",
        "Male_Mining","Male_Construction_Ind","Male_Manufacturing","Male_Wholesale","Male_Retail",
        "Male_Transport_Utilities","Male_Transport_Warehouse","Male_Utilities","Male_Information",
        "Male_Finance_RealEstate","Male_Finance_Insurance","Male_RealEstate","Male_Professional_Sci",
        "Male_Professional_Tech","Male_Mgmt_Companies","Male_Admin_Waste","Male_Edu_Healthcare",
        "Male_Education_Ind","Male_Healthcare_Ind","Male_Arts_Food","Male_Arts_Recreation",
        "Male_Hotel_Food","Male_Other_Services","Male_Public_Admin","Female_Employed_Ind",
        "Female_Agri_Mining","Female_Agriculture","Female_Mining","Female_Construction_Ind",
        "Female_Manufacturing","Female_Wholesale","Female_Retail","Female_Transport_Utilities",
        "Female_Transport_Warehouse","Female_Utilities","Female_Information","Female_Finance_RealEstate",
        "Female_Finance_Insurance","Female_RealEstate","Female_Professional_Sci","Female_Professional_Tech",
        "Female_Mgmt_Companies","Female_Admin_Waste","Female_Edu_Healthcare","Female_Education_Ind",
        "Female_Healthcare_Ind","Female_Arts_Food","Female_Arts_Recreation","Female_Hotel_Food",
        "Female_Other_Services","Female_Public_Admin"]
    # B08301_001E..021E in published order (checked against the ACS 2023 API)
    B08301 = ["Total_Workers_Commute","Commute_Vehicle","Commute_DroveAlone","Commute_Carpooled",
        "Carpool_2Person","Carpool_3Person","Carpool_4Person","Carpool_5to6Person",
        "Carpool_7PlusPerson","Commute_PublicTransit","Commute_Bus","Commute_Subway_ElevatedRail",
        "Commute_CommuterRail","Commute_LightRail","Commute_Ferry","Commute_Taxi",
        "Commute_Motorcycle","Commute_Bicycle","Commute_Walked","Commute_OtherMeans",
        "Commute_WorkedHome"]
    B08134 = ["Total_Workers_TravelTime","TravelTime_Under10","TravelTime_10to14","TravelTime_15to19",
        "TravelTime_20to24","TravelTime_25to29","TravelTime_30to34","TravelTime_35to44",
        "TravelTime_45to59","TravelTime_60Plus"]

    ACS_TRACT_ONLY_VARS = {}
    for i, a in enumerate(B08301): ACS_TRACT_ONLY_VARS[f"B08301_{i+1:03d}E"] = a
    for i, a in enumerate(B08134): ACS_TRACT_ONLY_VARS[f"B08134_{i+1:03d}E"] = a
    # B08302 is "time of departure to work", not travel time, so it is not used.
    # Mean travel time is derived in run_county() from this aggregate.
    ACS_TRACT_ONLY_VARS["B08013_001E"] = "Aggregate_TravelTime_min"
    for i, a in enumerate(C24010): ACS_TRACT_ONLY_VARS[f"C24010_{i+1:03d}E"] = a
    for i, a in enumerate(C24030): ACS_TRACT_ONLY_VARS[f"C24030_{i+1:03d}E"] = a

    return dict(PL=PL_VARS, DHC_P12=DHC_P12, DHC_HOUSING=DHC_HOUSING,
                DHC=DHC_VARS, ACS=ACS_VARS, ACS_TRACT=ACS_TRACT_ONLY_VARS)


# ================================================================== #
#  MAIN ENTRY POINT
# ================================================================== #
def run_county(
    state_fips,
    county_fips,
    census_api_key,
    *,
    county_name=None,
    decennial_year=2020,
    acs_year=2023,
    acs_dataset="acs5",
    output_dir="./census_pipeline_output",
    metric_crs=None,                 # None -> auto UTM zone
    storage_crs="EPSG:4326",
    # --- toggles for the heavy / region-specific layers ---
    include_osm=True,
    include_buildings=True,
    include_ghsl=True,
    include_aadt="auto",             # "auto" -> only if state_fips == "17" (IL)
    transit_gtfs="auto",             # "auto" -> CTA+Metra only for Cook County
    verbose=True,
):
    """Run the full block-level pipeline for one US county.

    Returns the assembled GeoDataFrame (also written to output_dir as GPKG/CSV).

    Region-specific layers:
      include_aadt: Illinois IDOT endpoint only. For other states pass a dict
                    {"base_url","county_field","county_value","aadt_field","year_field"}
                    pointing at that state's DOT ArcGIS service, or False to skip.
      transit_gtfs: dict {agency_name: gtfs_zip_url}. "auto" loads CTA+Metra for
                    Cook County IL only; {} or None disables transit everywhere else.
    """
    abbr, _statename = STATE_FIPS.get(state_fips, ("??", None))
    if _statename is None:
        raise ValueError(f"Unknown state FIPS {state_fips!r}")
    county_name = county_name or f"{abbr}{county_fips}"

    def log(*a):
        if verbose: print(*a)

    out = Path(output_dir); out.mkdir(parents=True, exist_ok=True)
    stem = f"census_{county_name}_{state_fips}{county_fips}"
    out_gpkg = out / f"{stem}.gpkg"
    out_csv  = out / f"{stem}.csv"
    out_meta = out / f"{stem}_metadata.csv"

    api = CensusAPI(census_api_key)
    AL = build_alias_maps()

    log(f"\n{'='*60}\n  {county_name} County  (FIPS {state_fips}{county_fips}, {abbr})\n{'='*60}")

    # ---------------------------------------------------------------- #
    # 1. PL 94-171 at block level (the spine)
    # ---------------------------------------------------------------- #
    log("→ PL 94-171 (block)…")
    pl = api.fetch(f"{decennial_year}/dec/pl", list(AL["PL"]), "block",
                   state_fips, county_fips)
    pl["GEOID20"] = pl["state"] + pl["county"] + pl["tract"] + pl["block"]
    pl["TRACT_GEOID"] = pl["state"] + pl["county"] + pl["tract"]
    pl["BG_GEOID"] = pl["TRACT_GEOID"] + pl["block"].str[0]
    log(f"  {len(pl):,} blocks")

    # ---------------------------------------------------------------- #
    # 2. DHC (block group preferred, tract fallback)
    # ---------------------------------------------------------------- #
    def dhc_fallback(vars_, label):
        for geo in ("block group", "tract"):
            df = api.fetch(f"{decennial_year}/dec/dhc", vars_, geo,
                           state_fips, county_fips, verbose=False)
            if len(df) and df[[v for v in vars_ if v in df.columns]].notna().sum().sum() > 0:
                log(f"  DHC {label}: {len(df):,} rows @ {geo}")
                return df, geo
        log(f"  DHC {label}: FAILED at all geographies")
        return pd.DataFrame(), None

    def add_keys(df, geo):
        if df.empty: return df
        df = df.copy()
        df["TRACT_GEOID"] = df["state"] + df["county"] + df["tract"]
        if geo == "block group":
            df["BG_GEOID"] = df["TRACT_GEOID"] + df["block group"]
        return df

    dhc_p12, g1 = dhc_fallback(list(AL["DHC_P12"]), "P12")
    dhc_h,   g2 = dhc_fallback(list(AL["DHC_HOUSING"]), "housing")
    dhc_p12 = add_keys(dhc_p12, g1); dhc_h = add_keys(dhc_h, g2)

    # ---------------------------------------------------------------- #
    # 3. ACS (BG for most, tract for commute/occ/ind)
    # ---------------------------------------------------------------- #
    log("→ ACS block-group…")
    acs_bg = api.fetch(f"{acs_year}/acs/{acs_dataset}", list(AL["ACS"]),
                       "block group", state_fips, county_fips)
    acs_bg["TRACT_GEOID"] = acs_bg["state"] + acs_bg["county"] + acs_bg["tract"]
    acs_bg["BG_GEOID"] = acs_bg["TRACT_GEOID"] + acs_bg["block group"]
    log("→ ACS tract…")
    acs_tr = api.fetch(f"{acs_year}/acs/{acs_dataset}", list(AL["ACS_TRACT"]),
                       "tract", state_fips, county_fips)
    acs_tr["TRACT_GEOID"] = acs_tr["state"] + acs_tr["county"] + acs_tr["tract"]
    for df in (acs_bg, acs_tr):
        num = df.select_dtypes(include=[np.number]).columns
        df[num] = df[num].where(df[num] > -1e8, np.nan)

    # ---------------------------------------------------------------- #
    # 4. Block geometries via pygris
    # ---------------------------------------------------------------- #
    import pygris
    log("→ Block geometries (pygris/TIGER)…")
    blocks = pygris.blocks(state=state_fips, county=county_fips, year=decennial_year)
    for c in ("GEOID20", "STATEFP20", "COUNTYFP20", "TRACTCE20", "BLOCKCE20"):
        blocks[c] = blocks[c].astype(str)
    blocks["TRACT_GEOID"] = blocks["STATEFP20"] + blocks["COUNTYFP20"] + blocks["TRACTCE20"]
    blocks["BG_GEOID"] = blocks["TRACT_GEOID"] + blocks["BLOCKCE20"].str[0]
    log(f"  {len(blocks):,} geometries")

    # auto metric CRS from county centroid
    if metric_crs is None:
        c = blocks.to_crs(storage_crs).geometry.union_all().centroid
        metric_crs = utm_crs_for(c.x, c.y)
        log(f"  auto metric CRS: {metric_crs} (UTM, meters)")
    # detect unit: UTM/3857 are meters, IL state plane 3435 is US feet
    crs_is_feet = metric_crs in ("EPSG:3435", "EPSG:3436")
    ft2m   = 0.3048006096012 if crs_is_feet else 1.0
    ft2_m2 = 0.092903412     if crs_is_feet else 1.0
    acres_div = 43560.0 if crs_is_feet else 4046.8564224  # m² per acre

    # ---------------------------------------------------------------- #
    # 5. Merge all sources onto the block spine
    # ---------------------------------------------------------------- #
    def strip_geo(df, keep=("TRACT_GEOID","BG_GEOID","GEOID20")):
        drop = [c for c in ["state","county","tract","block group","block","NAME"]
                if c in df.columns and c not in keep]
        return df.drop(columns=drop)

    gdf = blocks.copy()
    gdf = gdf.merge(strip_geo(pl).drop(columns=["TRACT_GEOID","BG_GEOID"], errors="ignore"),
                    on="GEOID20", how="left")
    if not dhc_p12.empty:
        key = "BG_GEOID" if g1 == "block group" else "TRACT_GEOID"
        gdf = gdf.merge(strip_geo(dhc_p12).drop(columns=["TRACT_GEOID"], errors="ignore")
                        if key == "BG_GEOID" else strip_geo(dhc_p12).drop(columns=["BG_GEOID"], errors="ignore"),
                        on=key, how="left")
    if not dhc_h.empty:
        key = "BG_GEOID" if g2 == "block group" else "TRACT_GEOID"
        gdf = gdf.merge(strip_geo(dhc_h).drop(columns=["TRACT_GEOID"], errors="ignore")
                        if key == "BG_GEOID" else strip_geo(dhc_h).drop(columns=["BG_GEOID"], errors="ignore"),
                        on=key, how="left")
    gdf = gdf.merge(strip_geo(acs_bg).drop(columns=["TRACT_GEOID"], errors="ignore"),
                    on="BG_GEOID", how="left")
    gdf = gdf.merge(strip_geo(acs_tr).drop(columns=["BG_GEOID"], errors="ignore"),
                    on="TRACT_GEOID", how="left")
    log(f"  merged: {len(gdf):,} rows × {len(gdf.columns)} cols")

    # Derived ratios (Census definitions)
    #   mean commute = aggregate minutes / workers who did not work from home
    if {"B08013_001E", "B08301_001E", "B08301_021E"} <= set(gdf.columns):
        commuters = gdf["B08301_001E"] - gdf["B08301_021E"]
        gdf["Mean_TravelTime_min"] = np.where(commuters > 0, gdf["B08013_001E"] / commuters, np.nan)
    if {"H8_001N", "H3_002N"} <= set(gdf.columns):
        gdf["Avg_Household_Size"] = np.where(gdf["H3_002N"] > 0, gdf["H8_001N"] / gdf["H3_002N"], np.nan)

    # ---------------------------------------------------------------- #
    # 6. Geometric attributes
    # ---------------------------------------------------------------- #
    gdf_m = gdf.to_crs(metric_crs)
    gdf["area_native"]   = gdf_m.geometry.area
    gdf["perimeter_native"] = gdf_m.geometry.length
    gdf["area_m2"]       = gdf["area_native"] * ft2_m2
    gdf["perimeter_m"]   = gdf["perimeter_native"] * ft2m
    gdf["area_acres"]    = gdf["area_native"] / (43560.0 if crs_is_feet else acres_div)
    gdf["polsby_popper"] = np.where(gdf["perimeter_native"] > 0,
        (4*np.pi*gdf["area_native"]) / (gdf["perimeter_native"]**2), np.nan)
    eq = 2*np.pi*np.sqrt(gdf["area_native"]/np.pi)
    gdf["schwartzberg"] = np.where(gdf["perimeter_native"] > 0, eq/gdf["perimeter_native"], np.nan)

    def elong(geom):
        if geom is None or geom.is_empty: return np.nan
        try:
            mbr = geom.minimum_rotated_rectangle
            cc = list(mbr.exterior.coords)
            s1 = hypot(cc[1][0]-cc[0][0], cc[1][1]-cc[0][1])
            s2 = hypot(cc[2][0]-cc[1][0], cc[2][1]-cc[1][1])
            s, l = min(s1, s2), max(s1, s2)
            return 1 - s/l if l > 0 else np.nan
        except Exception:
            return np.nan
    gdf["elongation"] = gdf_m.geometry.apply(elong)
    gdf["building_coverage_ratio"] = np.nan  # filled by buildings step

    # ---------------------------------------------------------------- #
    # 7. Rename to aliases
    # ---------------------------------------------------------------- #
    rename = {**AL["PL"], **AL["DHC"], **AL["ACS"], **AL["ACS_TRACT"],
              "STATEFP20":"State_FIPS", "COUNTYFP20":"County_FIPS",
              "TRACTCE20":"Tract_Code", "BLOCKCE20":"Block_Code",
              "GEOID20":"GeoID", "NAME20":"Block_Name"}
    gdf = gdf.rename(columns={k: v for k, v in rename.items() if k in gdf.columns})

    # water-block flag
    gdf["is_water_block"] = (
        (gdf["Tract_Code"].astype(str).str.startswith("99")) |
        ((pd.to_numeric(gdf["ALAND20"], errors="coerce") == 0) &
         (pd.to_numeric(gdf["AWATER20"], errors="coerce") > 0))
    ).astype(int)

    # metadata table
    def src_geo(col):
        if col in AL["PL"].values():       return ("Decennial 2020 PL","block")
        if col in AL["DHC_P12"].values():  return ("Decennial 2020 DHC P12", f"{g1} → block")
        if col in AL["DHC_HOUSING"].values(): return ("Decennial 2020 DHC housing", f"{g2} → block")
        if col in AL["ACS"].values():      return (f"ACS {acs_year} 5yr","block group → block")
        if col in AL["ACS_TRACT"].values():return (f"ACS {acs_year} 5yr","tract → block")
        if col in ("State_FIPS","County_FIPS","Tract_Code","Block_Code","GeoID",
                   "Block_Name","TRACT_GEOID","BG_GEOID","ALAND20","AWATER20",
                   "POP20","HOUSING20","is_water_block","geometry"):
            return ("TIGER/Line 2020","block")
        if col in ("Mean_TravelTime_min", "Avg_Household_Size"):
            return ("derived (ACS / DHC ratio)", "tract / block group → block")
        if col.startswith(("area_","perimeter_","polsby","schwartz","elong","building_cov")):
            return ("derived","block")
        return ("","")
    meta_df = pd.DataFrame([{"column": c, **dict(zip(("source","geography"), src_geo(c)))}
                            for c in gdf.columns])

    gdf_out = gdf.to_crs(storage_crs)

    def export():
        gdf_out.to_file(out_gpkg, driver="GPKG", layer="blocks")
        pd.DataFrame(gdf_out.drop(columns="geometry")).to_csv(out_csv, index=False)
        meta_df.to_csv(out_meta, index=False)
    export()
    log(f"  ✓ core dataset written ({len(gdf_out):,} × {len(gdf_out.columns)})")

    # ============================================================== #
    #  Shared helpers for the built-environment layers
    # ============================================================== #
    ctx = dict(gdf=gdf, gdf_out=gdf_out, meta_df=meta_df, metric_crs=metric_crs,
               storage_crs=storage_crs, ft2m=ft2m, ft2_m2=ft2_m2, out=out, stem=stem,
               out_gpkg=out_gpkg, out_csv=out_csv, out_meta=out_meta, log=log,
               state_fips=state_fips, county_fips=county_fips, county_name=county_name,
               abbr=abbr, statename=_statename, acres_div=acres_div, crs_is_feet=crs_is_feet)

    if include_osm:
        ctx = _layer_osm(ctx)
    if include_aadt == "auto":
        include_aadt = (state_fips == "17")  # IDOT endpoint is Illinois-only
    if include_aadt:
        ctx = _layer_aadt(ctx, include_aadt)
    if transit_gtfs == "auto":
        transit_gtfs = CHICAGO_GTFS if (state_fips == "17" and county_fips == "031") else {}
    if include_osm and transit_gtfs:
        ctx = _layer_transit(ctx, transit_gtfs)
    if include_buildings:
        ctx = _layer_buildings(ctx)
    if include_ghsl:
        ctx = _layer_ghsl(ctx)

    # final export
    ctx["gdf_out"].to_file(out_gpkg, driver="GPKG", layer="blocks")
    pd.DataFrame(ctx["gdf_out"].drop(columns="geometry")).to_csv(out_csv, index=False)
    ctx["meta_df"].to_csv(out_meta, index=False)
    log(f"\n✓ DONE — {len(ctx['gdf_out']):,} blocks × {len(ctx['gdf_out'].columns)} cols")
    log(f"  {out_gpkg}\n  {out_csv}\n  {out_meta}")
    return ctx["gdf_out"]


# ================================================================== #
#  LAYER: OSM streets + POIs   (Cells 14, 15, 15b, 15c, 17 POIs)
# ================================================================== #
def _layer_osm(ctx):
    import osmnx as ox
    import networkx as nx
    ox.settings.use_cache = True
    log = ctx["log"]; gdf_out = ctx["gdf_out"]; gdf = ctx["gdf"]
    metric_crs = ctx["metric_crs"]; ft2m = ctx["ft2m"]
    log("\n→ OSM layer (streets + POIs)…")

    county_poly = gdf_out.geometry.union_all()
    blocks_m = gdf_out.to_crs(metric_crs)[["GeoID","geometry","area_acres"]].copy()
    blocks_buf = blocks_m.copy(); blocks_buf["geometry"] = blocks_m.geometry.buffer(5.0/ft2m if ctx["crs_is_feet"] else 5.0)
    blocks_buf2 = blocks_m.copy(); blocks_buf2["geometry"] = blocks_m.geometry.buffer(10.0/ft2m if ctx["crs_is_feet"] else 10.0)

    graph_path = ctx["out"] / f"{ctx['stem']}_osm_drive.graphml"
    if graph_path.exists():
        G = ox.load_graphml(graph_path)
    else:
        G = ox.graph_from_polygon(county_poly, network_type="drive", simplify=True)
        ox.save_graphml(G, graph_path)
    nodes, edges = ox.graph_to_gdfs(G)
    log(f"  {len(edges):,} edges, {len(nodes):,} nodes")

    edges_m = edges.to_crs(metric_crs).reset_index(drop=False)
    nodes_m = nodes.to_crs(metric_crs).reset_index(drop=False)

    def first(x): return x[0] if isinstance(x, list) and x else x
    def pspeed(s):
        s = first(s)
        if s is None or pd.isna(s): return None
        if isinstance(s,(int,float)): return float(s)
        m = re.match(r"(\d+(?:\.\d+)?)\s*(mph|km/h)?", str(s).lower().strip())
        if not m: return None
        v = float(m.group(1)); return v if (m.group(2) or "mph")=="mph" else v*0.621371
    def pint(x):
        x = first(x)
        try: return float(x)
        except: return None
    edges_m["seg_length_m"] = edges_m.geometry.length * ft2m
    edges_m["maxspeed_mph"] = edges_m["maxspeed"].apply(pspeed) if "maxspeed" in edges_m else np.nan
    edges_m["lanes_n"] = edges_m["lanes"].apply(pint) if "lanes" in edges_m else np.nan
    CB = {"motorway":"Motorway","motorway_link":"Motorway","trunk":"Primary","trunk_link":"Primary",
          "primary":"Primary","primary_link":"Primary","secondary":"Secondary","secondary_link":"Secondary",
          "tertiary":"Tertiary","tertiary_link":"Tertiary","residential":"Residential",
          "living_street":"Residential","service":"Service"}
    edges_m["road_cat"] = edges_m["highway"].apply(first).map(CB).fillna("Other")

    j = gpd.sjoin(edges_m[["road_cat","maxspeed_mph","lanes_n","seg_length_m","geometry"]],
                  blocks_buf[["GeoID","geometry"]], predicate="intersects", how="inner")
    main = j.groupby("GeoID").agg(OSM_StreetLength_m=("seg_length_m","sum"),
        OSM_SegmentCount=("seg_length_m","size"), OSM_MeanSpeed_mph=("maxspeed_mph","mean"),
        OSM_MeanLanes=("lanes_n","mean")).reset_index()
    bycat = (j.pivot_table(index="GeoID", columns="road_cat", values="seg_length_m",
             aggfunc="sum", fill_value=0).add_prefix("OSM_Length_").add_suffix("_m").reset_index())
    flags = j.groupby("GeoID")["road_cat"].agg(lambda s: set(s)).reset_index()
    flags["OSM_HasMotorway"] = flags["road_cat"].apply(lambda s: int("Motorway" in s))
    flags["OSM_HasPrimary_or_Higher"] = flags["road_cat"].apply(lambda s: int(bool({"Motorway","Primary"}&s)))
    flags = flags[["GeoID","OSM_HasMotorway","OSM_HasPrimary_or_Higher"]]

    # intersections / dead-ends (buffered, fixed)
    deg = dict(nx.MultiGraph(G).degree())
    nodes_m["degree"] = nodes_m["osmid"].map(deg)
    nodes_m["is_int"] = (nodes_m["degree"]>=3).astype(int)
    nodes_m["is_de"]  = (nodes_m["degree"]==1).astype(int)
    nj = gpd.sjoin(nodes_m[["is_int","is_de","geometry"]], blocks_buf2[["GeoID","geometry"]],
                   predicate="intersects", how="inner")
    nag = nj.groupby("GeoID").agg(OSM_IntersectionCount=("is_int","sum"),
                                  OSM_DeadEndCount=("is_de","sum")).reset_index()

    osm = (main.merge(bycat,on="GeoID",how="outer").merge(flags,on="GeoID",how="outer")
           .merge(nag,on="GeoID",how="outer")
           .merge(blocks_m[["GeoID","area_acres"]],on="GeoID",how="left"))
    osm["OSM_StreetDensity_m_per_acre"] = osm["OSM_StreetLength_m"]/osm["area_acres"]
    osm["OSM_IntersectionDensity_per_acre"] = osm["OSM_IntersectionCount"]/osm["area_acres"]
    osm = osm.drop(columns=["area_acres"])

    # extra OSM point/line features
    def feats(tags):
        try: return ox.features_from_polygon(county_poly, tags=tags).to_crs(metric_crs)
        except Exception: return gpd.GeoDataFrame(geometry=[], crs=metric_crs)
    def lines_len(g, col):
        if len(g)==0: return pd.DataFrame(columns=["GeoID",col])
        g = g[g.geometry.geom_type.isin(["LineString","MultiLineString"])].copy()
        g["L"] = g.geometry.length*ft2m
        jj = gpd.sjoin(g[["L","geometry"]], blocks_buf2[["GeoID","geometry"]],
                       predicate="intersects", how="inner")
        return jj.groupby("GeoID")["L"].sum().rename(col).reset_index()
    def pts_cnt(g, col):
        if len(g)==0: return pd.DataFrame(columns=["GeoID",col])
        g = g[g.geometry.geom_type=="Point"]
        jj = gpd.sjoin(g[["geometry"]], blocks_buf2[["GeoID","geometry"]],
                       predicate="intersects", how="inner")
        return jj.groupby("GeoID").size().rename(col).reset_index()

    extra = feats({"highway":["traffic_signals","stop","cycleway"]})
    sig = pts_cnt(extra[extra.get("highway","")=="traffic_signals"], "OSM_TrafficSignalCount") if len(extra) else pd.DataFrame(columns=["GeoID","OSM_TrafficSignalCount"])
    stp = pts_cnt(extra[extra.get("highway","")=="stop"], "OSM_StopSignCount") if len(extra) else pd.DataFrame(columns=["GeoID","OSM_StopSignCount"])
    ded = lines_len(extra[extra.get("highway","")=="cycleway"], "OSM_DedicatedCycle_Length_m") if len(extra) else pd.DataFrame(columns=["GeoID","OSM_DedicatedCycle_Length_m"])
    sw = feats({"footway":["sidewalk","crossing"]})
    swl = lines_len(sw[sw.get("footway","")=="sidewalk"], "OSM_Sidewalk_Length_m") if len(sw) else pd.DataFrame(columns=["GeoID","OSM_Sidewalk_Length_m"])
    cr  = sw[sw.get("footway","")=="crossing"] if len(sw) else sw
    crc = (pd.concat([pts_cnt(cr,"_p").rename(columns={"_p":"c"}),
                      lines_len(cr,"_l").rename(columns={"_l":"c"})]).groupby("GeoID")["c"].sum()
           .rename("OSM_PedestrianCrossingCount").reset_index()) if len(cr) else pd.DataFrame(columns=["GeoID","OSM_PedestrianCrossingCount"])
    bl = feats({"cycleway":True})
    bll = lines_len(bl, "OSM_OnRoadBikeLane_Length_m") if len(bl) else pd.DataFrame(columns=["GeoID","OSM_OnRoadBikeLane_Length_m"])

    for extra_df in (sig, stp, ded, swl, crc, bll):
        osm = osm.merge(extra_df, on="GeoID", how="left")

    # POIs: nearest distance + 800m count
    R800 = (800.0/ft2m) if ctx["crs_is_feet"] else 800.0
    cen = gdf_out[["GeoID"]].copy()
    cen = gpd.GeoDataFrame(cen, geometry=gdf_out.geometry.centroid, crs=ctx["storage_crs"]).to_crs(metric_crs)
    POI = {"Hospital":{"amenity":"hospital"},"School":{"amenity":"school"},
           "Grocery":{"shop":["supermarket","grocery"]},"Park":{"leisure":"park"}}
    poi_out = cen[["GeoID"]].copy()
    for nm, tags in POI.items():
        layer = feats(tags)
        layer = layer[~layer.geometry.is_empty & layer.geometry.notna()] if len(layer) else layer
        if len(layer)==0:
            poi_out[f"POI_{nm}_NearestDist_m"]=np.nan; poi_out[f"POI_{nm}_Count_800m"]=0; continue
        near = gpd.sjoin_nearest(cen[["GeoID","geometry"]], layer[["geometry"]],
                                 how="left", distance_col="d")
        near = near.sort_values("d").drop_duplicates("GeoID")[["GeoID","d"]]
        near[f"POI_{nm}_NearestDist_m"] = near["d"]*ft2m
        poi_out = poi_out.merge(near[["GeoID",f"POI_{nm}_NearestDist_m"]],on="GeoID",how="left")
        buf = cen[["GeoID","geometry"]].copy(); buf["geometry"]=cen.geometry.buffer(R800)
        cj = gpd.sjoin(layer[["geometry"]], buf[["GeoID","geometry"]], predicate="intersects", how="inner")
        cnt = cj.groupby("GeoID").size().rename(f"POI_{nm}_Count_800m").reset_index()
        poi_out = poi_out.merge(cnt,on="GeoID",how="left")
        poi_out[f"POI_{nm}_Count_800m"]=poi_out[f"POI_{nm}_Count_800m"].fillna(0).astype(int)

    osm = osm.merge(poi_out, on="GeoID", how="left")
    # Zero-fill ONLY counts/lengths/volumes/densities (absence = 0).
    # NEVER zero-fill distances (NearestDist) — 0 m would falsely mean "adjacent",
    # and NaN correctly means "no such feature found within search".
    def _zero_fillable(c):
        if c == "GeoID" or c.endswith("NearestDist_m"):
            return False
        return (c.endswith("_m") or c.endswith("_per_acre")
                or "Count" in c or c.startswith("OSM_Has"))
    for c in osm.columns:
        if _zero_fillable(c):
            osm[c] = osm[c].fillna(0)

    gdf_out = gdf_out.merge(osm, on="GeoID", how="left")
    gdf     = gdf.merge(osm, on="GeoID", how="left")
    for c in osm.columns:
        if c!="GeoID":
            ctx["meta_df"]=pd.concat([ctx["meta_df"],pd.DataFrame([{"column":c,
                "source":"OSM/OSMnx + GTFS-free POIs","geography":"block (buffered join / centroid)"}])],ignore_index=True)
    log(f"  OSM added {len([c for c in osm.columns if c!='GeoID'])} columns")
    # stash reusable objects for transit layer
    ctx.update(gdf=gdf, gdf_out=gdf_out, county_poly=county_poly, blocks_buf2=blocks_buf2,
               centroids_m=cen, R800=R800)
    return ctx


# ================================================================== #
#  LAYER: DOT AADT  (Illinois IDOT by default; generic ArcGIS schema)
# ================================================================== #
def _layer_aadt(ctx, cfg):
    from shapely.geometry import LineString, MultiLineString
    log = ctx["log"]; gdf_out=ctx["gdf_out"]; gdf=ctx["gdf"]; ft2m=ctx["ft2m"]
    metric_crs=ctx["metric_crs"]
    log("\n→ DOT AADT layer…")

    if cfg is True:   # default = Illinois IDOT
        cfg = dict(base="https://gis1.dot.illinois.gov/arcgis/rest/services/AdministrativeData/AADT/MapServer",
                   layer=0, county_field="COUNTY_NAM", aadt_field="AADT", year_field="AADT_YR",
                   where="UPPER(COUNTY_NAM) LIKE '%s%%'" % ctx["county_name"].upper())
    base=cfg["base"]; lid=cfg["layer"]
    meta = requests.get(f"{base}/{lid}?f=json", timeout=30).json()
    MAX = meta.get("maxRecordCount",1000)
    feats=[]; off=0
    while True:
        p={"where":cfg["where"],"outFields":"*","outSR":"4326","f":"geojson",
           "resultOffset":off,"resultRecordCount":MAX}
        page=requests.get(f"{base}/{lid}/query",params=p,timeout=180).json()
        fs=page.get("features",[])
        if not fs: break
        feats+=fs
        if not (page.get("exceededTransferLimit") or len(fs)==MAX): break
        off+=len(fs)
        if off>500000: break
    log(f"  {len(feats):,} AADT features")

    def pgeom(g):
        if not g: return None
        t=g.get("type"); co=g.get("coordinates")
        if not co: return None
        def cl(part): return [(c[0],c[1]) for c in part if isinstance(c,(list,tuple)) and len(c)>=2 and c[0] is not None and c[1] is not None]
        if t=="LineString":
            pts=cl(co); return LineString(pts) if len(pts)>=2 else None
        if t=="MultiLineString":
            ls=[LineString(cl(p)) for p in co if len(cl(p))>=2]
            return MultiLineString(ls) if ls else None
        return None
    rows=[{**(f.get("properties") or {}),"geometry":pgeom(f.get("geometry"))} for f in feats]
    rows=[r for r in rows if r["geometry"] is not None and not r["geometry"].is_empty]
    if not rows:
        log("  no usable AADT geometries — skipping"); return ctx
    aadt=gpd.GeoDataFrame(rows,geometry="geometry",crs="EPSG:4326").to_crs(metric_crs)
    aadt["AADT_val"]=pd.to_numeric(aadt[cfg["aadt_field"]],errors="coerce")
    aadt=aadt[aadt["AADT_val"]>0].copy()
    aadt["seg_length_m"]=aadt.geometry.length*ft2m

    blocks_buf=gdf_out.to_crs(metric_crs)[["GeoID","geometry"]].copy()
    blocks_buf["geometry"]=blocks_buf.geometry.buffer(5.0/ft2m if ctx["crs_is_feet"] else 5.0)
    j=gpd.sjoin(aadt[["AADT_val","seg_length_m","geometry"]],blocks_buf,predicate="intersects",how="inner")
    def lwm(g):
        w=g["seg_length_m"].values; v=g["AADT_val"].values
        return (v*w).sum()/w.sum() if w.sum()>0 else np.nan
    ag=j.groupby("GeoID").apply(lambda g: pd.Series({
        "DOT_AADT_Mean":g["AADT_val"].mean(),"DOT_AADT_Max":g["AADT_val"].max(),
        "DOT_AADT_Min":g["AADT_val"].min(),"DOT_AADT_LengthWeighted":lwm(g),
        "DOT_AADT_SegmentCount":len(g),
        "DOT_AADT_VehicleMeters":(g["AADT_val"]*g["seg_length_m"]).sum()}),
        include_groups=False).reset_index()
    ag["DOT_AADT_HasHighVolume"]=(ag["DOT_AADT_Max"]>=20000).astype(int)
    gdf_out=gdf_out.merge(ag,on="GeoID",how="left"); gdf=gdf.merge(ag,on="GeoID",how="left")
    for c in ag.columns:
        if c!="GeoID":
            ctx["meta_df"]=pd.concat([ctx["meta_df"],pd.DataFrame([{"column":c,
                "source":f"DOT AADT ({base.split('//')[1].split('/')[0]})","geography":"block (5ft buffer)"}])],ignore_index=True)
    log(f"  AADT added {len(ag.columns)-1} columns")
    ctx.update(gdf=gdf,gdf_out=gdf_out)
    return ctx


# ================================================================== #
#  LAYER: Transit GTFS (CTA + Metra default)
# ================================================================== #
def _layer_transit(ctx, gtfs_urls):
    log=ctx["log"]; gdf_out=ctx["gdf_out"]; gdf=ctx["gdf"]
    metric_crs=ctx["metric_crs"]; ft2m=ctx["ft2m"]
    blocks_buf2=ctx["blocks_buf2"]; cen=ctx["centroids_m"]; R800=ctx["R800"]
    log("\n→ Transit GTFS layer…")
    for agency, url in gtfs_urls.items():
        try:
            r=requests.get(url,timeout=180); r.raise_for_status()
            z=zipfile.ZipFile(io.BytesIO(r.content))
            stops=pd.read_csv(z.open("stops.txt"), skipinitialspace=True)
            stops.columns=[c.strip() for c in stops.columns]
        except Exception as e:
            log(f"  {agency}: failed ({str(e)[:80]}) — skipping"); continue
        if "stop_lon" not in stops or "stop_lat" not in stops:
            log(f"  {agency}: no stop_lon/stop_lat — skipping"); continue
        sg=gpd.GeoDataFrame(stops,geometry=gpd.points_from_xy(stops["stop_lon"],stops["stop_lat"]),crs="EPSG:4326")
        if "location_type" in sg:
            sg["location_type"]=pd.to_numeric(sg["location_type"],errors="coerce").fillna(0)
            sg=sg[sg["location_type"].isin([0,1])]
        sm=sg.to_crs(metric_crs)
        inb=gpd.sjoin(sm[["geometry"]],blocks_buf2[["GeoID","geometry"]],predicate="intersects",how="inner").groupby("GeoID").size().rename(f"Transit_{agency}_StopCount").reset_index()
        buf=cen[["GeoID","geometry"]].copy(); buf["geometry"]=cen.geometry.buffer(R800)
        w8=gpd.sjoin(sm[["geometry"]],buf[["GeoID","geometry"]],predicate="intersects",how="inner").groupby("GeoID").size().rename(f"Transit_{agency}_StopCount_800m").reset_index()
        nr=gpd.sjoin_nearest(cen[["GeoID","geometry"]],sm[["geometry"]],how="left",distance_col="d")
        nr=nr.sort_values("d").drop_duplicates("GeoID")[["GeoID","d"]]
        nr[f"Transit_{agency}_NearestDist_m"]=nr["d"]*ft2m
        ta=inb.merge(w8,on="GeoID",how="outer").merge(nr[["GeoID",f"Transit_{agency}_NearestDist_m"]],on="GeoID",how="outer")
        gdf_out=gdf_out.merge(ta,on="GeoID",how="left"); gdf=gdf.merge(ta,on="GeoID",how="left")
        for c in (f"Transit_{agency}_StopCount",f"Transit_{agency}_StopCount_800m"):
            gdf_out[c]=gdf_out[c].fillna(0).astype(int); gdf[c]=gdf[c].fillna(0).astype(int)
        for c in ta.columns:
            if c!="GeoID":
                ctx["meta_df"]=pd.concat([ctx["meta_df"],pd.DataFrame([{"column":c,
                    "source":f"{agency} GTFS","geography":"block"}])],ignore_index=True)
        log(f"  {agency}: {len(sm):,} stops")
    ctx.update(gdf=gdf,gdf_out=gdf_out)
    return ctx


# ================================================================== #
#  LAYER: Microsoft Building Footprints (per-state file)
# ================================================================== #
def _layer_buildings(ctx):
    log=ctx["log"]; gdf_out=ctx["gdf_out"]; gdf=ctx["gdf"]
    metric_crs=ctx["metric_crs"]; ft2m=ctx["ft2m"]; ft2_m2=ctx["ft2_m2"]
    statename=ctx["statename"]; out=ctx["out"]; stem=ctx["stem"]
    log("\n→ Microsoft Building Footprints layer…")
    url=f"https://minedbuildings.z5.web.core.windows.net/legacy/usbuildings-v2/{statename}.geojson.zip"
    zp=out/f"{statename}_buildings.geojson.zip"; gj=out/f"{statename}.geojson"
    cache=out/f"{stem}_buildings.gpkg"
    county_poly = gdf_out.geometry.union_all()
    if cache.exists():
        bldg=gpd.read_file(cache)
    else:
        if not gj.exists():
            if not zp.exists():
                log(f"  downloading {statename} footprints…")
                with requests.get(url,stream=True,timeout=900) as r:
                    r.raise_for_status()
                    with open(zp,"wb") as f:
                        for ch in r.iter_content(1<<20): f.write(ch)
            with zipfile.ZipFile(zp) as z: z.extractall(out)
            cand=list(out.glob(f"{statename}*.geojson"))
            if cand: gj=cand[0]
        log("  loading + filtering to county…")
        b=gpd.read_file(gj)
        minx,miny,maxx,maxy=gdf_out.total_bounds
        b=b.cx[minx:maxx,miny:maxy]
        b=b[b.geometry.intersects(county_poly)].copy()
        b.to_file(cache,driver="GPKG"); bldg=b
    log(f"  {len(bldg):,} buildings")
    bm=bldg.to_crs(metric_crs); bm["a_m2"]=bm.geometry.area*ft2_m2
    cc=gpd.GeoDataFrame(bm[["a_m2"]],geometry=bm.geometry.centroid,crs=metric_crs)
    bp=gdf_out[["GeoID","geometry","ALAND20","area_acres"]].to_crs(metric_crs)
    bp["ALAND20"]=pd.to_numeric(bp["ALAND20"],errors="coerce")
    j=gpd.sjoin(cc,bp[["GeoID","geometry"]],predicate="within",how="inner")
    ag=j.groupby("GeoID").agg(Building_Count=("a_m2","size"),
        Building_Total_Area_m2=("a_m2","sum"),Building_Mean_Area_m2=("a_m2","mean"),
        Building_Median_Area_m2=("a_m2","median")).reset_index()
    ag=ag.merge(pd.DataFrame(bp.drop(columns="geometry"))[["GeoID","ALAND20","area_acres"]],on="GeoID",how="left")
    ag["building_coverage_ratio"]=np.where(ag["ALAND20"]>0,(ag["Building_Total_Area_m2"]/ag["ALAND20"]).clip(0,1),np.nan)
    ag["Building_Density_per_acre"]=np.where(ag["area_acres"]>0,ag["Building_Count"]/ag["area_acres"],np.nan)
    ag=ag.drop(columns=["ALAND20","area_acres"])
    for c in ["building_coverage_ratio","Building_Count","Building_Total_Area_m2",
              "Building_Mean_Area_m2","Building_Median_Area_m2","Building_Density_per_acre"]:
        if c in gdf_out: gdf_out=gdf_out.drop(columns=[c])
        if c in gdf: gdf=gdf.drop(columns=[c])
    gdf_out=gdf_out.merge(ag,on="GeoID",how="left"); gdf=gdf.merge(ag,on="GeoID",how="left")
    al=pd.to_numeric(gdf_out["ALAND20"],errors="coerce")
    for c in ("Building_Count","Building_Total_Area_m2","Building_Density_per_acre"):
        gdf_out[c]=gdf_out[c].fillna(0); gdf[c]=gdf[c].fillna(0)
    gdf_out.loc[al>0,"building_coverage_ratio"]=gdf_out.loc[al>0,"building_coverage_ratio"].fillna(0)
    for c in ag.columns:
        if c!="GeoID":
            ctx["meta_df"]=pd.concat([ctx["meta_df"],pd.DataFrame([{"column":c,
                "source":"Microsoft Building Footprints","geography":"block (centroid-inside)"}])],ignore_index=True)
    log(f"  buildings added {len(ag.columns)-1} columns")
    ctx.update(gdf=gdf,gdf_out=gdf_out)
    return ctx


# ================================================================== #
#  LAYER: GHSL (global rasters; shared cache across all counties)
# ================================================================== #
def _layer_ghsl(ctx):
    import rasterio
    log=ctx["log"]; gdf_out=ctx["gdf_out"]; gdf=ctx["gdf"]
    log("\n→ GHSL layer (SMOD + BUILT-H + BUILT-V)…")
    B="https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL"
    DIR=Path(ctx["out"]).parent/"GHSL_global"  # shared across counties
    DIR.mkdir(exist_ok=True,parents=True)
    PRODS=[
        ("GHSL_SMOD_2020", f"{B}/GHS_SMOD_GLOBE_R2023A/GHS_SMOD_E2020_GLOBE_R2023A_54009_1000/V1-0/GHS_SMOD_E2020_GLOBE_R2023A_54009_1000_V1_0.zip","GHS_SMOD_E2020_GLOBE_R2023A_54009_1000_V1_0"),
        ("GHSL_BuildingHeight_ANBH_m", f"{B}/GHS_BUILT_H_GLOBE_R2023A/GHS_BUILT_H_ANBH_E2018_GLOBE_R2023A_54009_100/V1-0/GHS_BUILT_H_ANBH_E2018_GLOBE_R2023A_54009_100_V1_0.zip","GHS_BUILT_H_ANBH_E2018_GLOBE_R2023A_54009_100_V1_0"),
        ("GHSL_BuiltVolume_2020_m3", f"{B}/GHS_BUILT_V_GLOBE_R2023A/GHS_BUILT_V_E2020_GLOBE_R2023A_54009_100/V1-0/GHS_BUILT_V_E2020_GLOBE_R2023A_54009_100_V1_0.zip","GHS_BUILT_V_E2020_GLOBE_R2023A_54009_100_V1_0"),
    ]
    def ensure(stem,url):
        tif=DIR/f"{stem}.tif"; zp=DIR/f"{stem}.zip"
        if tif.exists(): return tif
        if not zp.exists():
            with requests.get(url,stream=True,timeout=1800,headers={"User-Agent":"px/1.0"}) as r:
                r.raise_for_status()
                with open(zp,"wb") as f:
                    for ch in r.iter_content(1<<20): f.write(ch)
        with zipfile.ZipFile(zp) as z:
            t=[n for n in z.namelist() if n.lower().endswith(".tif")][0]
            with z.open(t) as s,open(tif,"wb") as d:
                for blk in iter(lambda:s.read(1<<20),b""): d.write(blk)
        zp.unlink(); return tif
    cen=gpd.GeoDataFrame(gdf_out[["GeoID"]],geometry=gdf_out.geometry.centroid,
                         crs=ctx["storage_crs"]).to_crs("ESRI:54009")
    coords=list(zip(cen.geometry.x,cen.geometry.y))
    res=pd.DataFrame({"GeoID":cen["GeoID"].values})
    for col,url,stem in PRODS:
        tif=ensure(stem,url)
        with rasterio.open(tif) as src:
            nd=src.nodata; vals=np.array([s[0] for s in src.sample(coords)],dtype=float)
        if nd is not None: vals=np.where(vals==nd,np.nan,vals)
        res[col]=vals
        log(f"  {col}: sampled")
    SMOD={30:"Urban Centre",23:"Dense Urban Cluster",22:"Semi-dense Urban Cluster",
          21:"Suburban / Peri-urban",13:"Rural Cluster",12:"Low Density Rural",
          11:"Very Low Density Rural",10:"Water"}
    res["GHSL_SMOD_2020_Label"]=res["GHSL_SMOD_2020"].round().astype("Int64").map(SMOD).fillna("Unknown")
    for c in res.columns:
        if c=="GeoID": continue
        if c in gdf_out: gdf_out=gdf_out.drop(columns=[c])
        if c in gdf: gdf=gdf.drop(columns=[c])
    gdf_out=gdf_out.merge(res,on="GeoID",how="left"); gdf=gdf.merge(res,on="GeoID",how="left")
    for c in res.columns:
        if c!="GeoID":
            ctx["meta_df"]=pd.concat([ctx["meta_df"],pd.DataFrame([{"column":c,
                "source":"GHSL R2023A","geography":"block (centroid sample, Mollweide)"}])],ignore_index=True)
    log(f"  GHSL added {len([c for c in res.columns if c!='GeoID'])} columns")
    ctx.update(gdf=gdf,gdf_out=gdf_out)
    return ctx


# ================================================================== #
if __name__ == "__main__":
    import sys
    key = os.environ.get("CENSUS_API_KEY", "")
    # Example: Cook County, IL
    run_county("17", "031", census_api_key=key, county_name="Cook")
