# Hazard stages: lidar, surge, slide

Three rasters are sampled at every building and every asset, on a GitHub runner (the development sandbox has no
route to data hosts). Each stage is one script and one workflow, owns one branch and two paths on `gh-pages`, and
knows nothing about the others. A later step, run in the sandbox, folds the three results into the building tiles,
the municipio exposure numbers and the seed database.

| Stage | Branch / workflow | Source | Owns on gh-pages |
|---|---|---|---|
| `lidar` | `pipe-lidar` / `lidar.yml` | USGS 3DEP 1 m DEM (lidar), `prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/PR_*` | `data/hazards/lidar/` |
| `surge` | `pipe-surge` / `surge.yml` | NOAA NHC National Storm Surge Risk Maps, `nhc.noaa.gov/gis/hazardmaps/PR_SLOSH_MOM_Inundation.zip` | `data/hazards/surge/`, `tiles/surge/` |
| `slide` | `pipe-slide` / `slide.yml` | USGS OFR 2020-1022 landslide susceptibility raster (ScienceBase item 61087009d34ef8d70565c154) | `data/hazards/slide/`, `tiles/slide/` |
| `heights` | `pipe-heights` / `heights.yml` | USGS 3DEP lidar point clouds, Entwine Point Tiles in `usgs-lidar-public` (`USGS_LPC_PR_PRVI_*_2018`) | `data/hazards/heights/` (published only when dispatched with `publish = yes`) |

## Points (`common.py`)

`load_buildings(site)` gives the centroid of all 1,500,471 buildings in **canonical order** (tiles in
`tiles/bld/index.json` order, buildings in tile order). `load_assets(site)` gives 3,988 assets as
`("<type>:<key>", lon, lat)`: shelters, public and assisted housing, OSM facilities. `site` is a sparse checkout of
`gh-pages` holding `tiles/bld`, `data/seed`, `data/osm`.

## Outputs (`write_stage`, `publish.sh`)

`data/hazards/<stage>/buildings.bin`: one record per building in canonical order, raw little-endian.

| Stage | Record | Meaning |
|---|---|---|
| `lidar` | `int16` | Ground elevation, decimetres above the DEM's vertical datum (state it in meta); -32768 = no lidar there |
| `surge` | `uint8 x 5` | Categories 1..5: the raster's own class at the point (0 dry, 1..21 = one-foot inundation bins, 99 leveed), 255 = outside the raster |
| `slide` | `uint8` | The raster's susceptibility class as published; 0 = no data |

`data/hazards/<stage>/assets.json`: `{ "<type>:<key>": value }` with the same meaning (lidar: metres, a number
with two decimals, or null; surge: `[c1, c2, c3, c4, c5]`; slide: class).

`data/hazards/<stage>/meta.json`: written by `write_stage`, plus what the stage adds: `source` (name, URLs, version,
date, licence, citation), `method` (one paragraph a reviewer can check: what is sampled, how, datum, units),
`classes` (value -> meaning, for surge and slide), `disclaimer` (the publisher's own use limits, quoted), `qa`
(counts per class, how many points had no data, a handful of spot values at named places), `generated`.

`data/hazards/<stage>/qa.jpg`: one picture of the result over the island (or San Juan), to be looked at.

### Lidar: what the number is

`lidar.py` (workflow `lidar.yml`: plan -> 12 shards -> merge, about ten minutes) gives each point the **median of
the 1 m DEM cells whose centre lies within 2 m of it**, accepted only when at least half of those cells hold data;
otherwise no data. The DEMs are bare earth, so this is the ground at the building, not its roof or floor. The newest
collection with a value wins (`PR_PuertoRicoUSVI_D24`, then `PR_PRVI_*_2018`); `meta.json` counts buildings per
project and measures how far the two collections disagree. Metres above the **Puerto Rico Vertical Datum of 2002**
(EPSG:6641): the GeoTIFFs carry no vertical CRS and their sidecar XML only repeats a national boilerplate, so the
datum is taken from USGS's work-unit register (`WESM.csv`, `vert_crs`) and the vendor DEM metadata (`altdatum`),
both quoted in `meta.json` under `datum`. `log.txt` is published by every run, failed or not. `LIDAR_ONLY` in the
workflow limits a run to tiles matching a regular expression (a test; `meta.json` says so).

### Heights: what the number is

`heights.py` (workflow `heights.yml`: plan -> 30 shards -> merge) measures every footprint in the 2018 lidar point
cloud: the **90th percentile of the roof** (last returns of unclassified points inside the outline and more than
0.5 m from it, more than 2 m above the ground) **minus the ground beside it** (median of ground-class points 1 to 8 m
outside the outline, out to 25 m when there are fewer than 3). No value without at least 6 roof and 3 ground points,
or when fewer than half of the last returns inside the outline are roof (bare ground, ruins, not yet built in 2018,
mostly under trees). Read with PDAL `readers.ept` at 2 m resolution, one query per zoom-16 cell; the collections
read for a cell are those whose source files meet it. Heights are differences within one point cloud, so the
vertical datum cancels out. Over Condado against OpenStreetMap height tags (8 398 buildings): median difference
+0.24 m, median absolute 0.53 m, 83 % within 2 m; 91 % of footprints get a value (94 % of OSM's, 39 % of the
machine-detected ones, many of which are sheds and cars). `buildings.bin` is `uint16` decimetres (0 = no value),
`buildings_p50.bin` the median roof, `buildings_cover.bin` the roof share (percent, 255 = not measured).
`merge.mjs` folds it in when it is there: the height byte takes the measured value, except where OpenStreetMap
tags the building's own height, and the ids file says `lidar`.

### Overlay tiles (surge and slide)

Pre-coloured RGBA PNG, 256 px, Web Mercator XYZ, zoom 8 to 13, transparent where there is nothing to show; no empty
tiles are written.

- slide: `tiles/slide/{z}/{x}/{y}.png`
- surge: `tiles/surge/c{1..5}/{z}/{x}/{y}.png`, one set per hurricane category

`tiles/<stage>/index.json`:

```json
{ "stage": "surge", "minZoom": 8, "maxZoom": 13, "tileSize": 256,
  "sets": [{ "id": "c1", "label": { "en": "Category 1", "es": "Categoría 1" } }],
  "tiles": { "c1": [[8, 80, 114]] },
  "title": { "en": "…", "es": "…" }, "unit": "ft above ground",
  "legend": [{ "color": "#rrggbb", "label": { "en": "…", "es": "…" } }],
  "note": { "en": "…", "es": "…" }, "disclaimer": { "en": "…", "es": "…" },
  "source": "…", "citation": "…", "generated": "…" }
```

For slide there is no `sets` and `tiles` is a flat list `[[z, x, y], …]`. Colours follow the publisher's own
legend. Keep each stage's tiles under about 15 MB in total.

## Rules

- Nothing invented. A point the raster does not cover is "no data", never a guess.
- The publisher's use limits go into `meta.json` and `index.json` verbatim; the app shows them.
- Free only: public downloads, no keys, public-repository runners. Every workflow keeps the line
  `if: github.event.repository.private == false`.
- Look at a source first with `tools/probe.sh <name> <script.sh>` (runs the script on a runner in under a minute and
  brings back what it wrote).
