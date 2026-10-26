# Garita: architecture

Garita is a live digital twin of Puerto Rico for the Departamento de la Vivienda: disaster response, sea level
rise, housing. It is a static site (GitHub Pages) with a database in the browser. Guide: `simplifaisoul/osiris`
(feed aggregation, HUD, layers), plus the two things Osiris lacks: an ontology and a store. Visual references:
`webgpu-demos/clear-Vieques` (water optics over real bathymetry) and `webgpu-demos/procedural-sanjuan` (sky,
aerial perspective, clouds, buildings).

## Hard constraints

- **No server.** Everything runs in the browser from `https://webgpu-demos.github.io/garita/`.
- **The dev sandbox cannot reach data hosts** (only GitHub and npm). Three consequences:
  1. Baked data is fetched and compiled **on the GitHub Actions runner** (`pipeline/`, `.github/workflows/`).
  2. Live feeds are fetched **by the browser**, so they must send CORS headers. Feeds that do not (NHC, NDBC,
     LUMA outages) are snapshotted by a scheduled Action to the `relay` branch and read from
     `https://raw.githubusercontent.com/webgpu-demos/garita/relay/<file>`.
  3. Local tests run on recorded payloads in `tests/fixtures/` (captured from the real endpoints by the runner).
     The app's `?fixtures=1` mode reads the same files from `/fixtures/`.
- **Nothing invented is presented as real.** Every value carries its source. Synthetic or modelled content is
  labelled as such in the UI and in the store (`source.kind = 'derived'`). No fabricated case, inspection or
  grant records.

## Branches

| Branch | Holds | Written by |
|---|---|---|
| `main` | source, pipeline, tests, docs | developers |
| `gh-pages` | the site: `index.html`, `assets/` (app build), `tiles/`, `data/`, `fixtures/` | app deploy + pipeline |
| `relay` | `nhc.json`, `ndbc.json`, `luma.json`, ... refreshed every 5 min | `relay.yml` cron |

Local checkout of `gh-pages` lives at `site/` (git worktree, ignored by `main`). Vite serves it as `publicDir`
so `fetch('tiles/dem/9/160/229.png')` works the same in dev and in production. All URLs in the app are
**relative** (`base: './'`).

## Layout

```
src/core/geo.ts        world frame, Web Mercator tile maths (also imported by pipeline/)
src/core/state.ts      app state as @preact/signals (selection, layers, scene clock, scenario, language)
src/ontology/          types.ts (THE contract), ontology.json, schema, sqlite worker, client
src/feeds/             one module per live source: fetch -> IngestBatch; scheduler; registry
src/world/             three.js scene: terrain quadtree, ocean, sky, clouds, buildings, markers, overlays
src/ui/                Preact panels
pipeline/              Node scripts run on the Actions runner
tests/                 node:test, fixtures
```

## World frame (`src/core/geo.ts`)

Metres, **x east, y up (above mean sea level), z south**; origin 18.22 N, 66.45 W. Local equirectangular.
Rendered geometry is lowered by `curveDrop(x, z)` so the scene is a cap of the globe. Coverage: Web Mercator
zoom-8 tiles x 79..81, y 114..115.

## Tiles on `gh-pages`

| Path | Content | Source |
|---|---|---|
| `tiles/dem/{z}/{x}/{y}.png` | Terrarium-encoded elevation, 256 px, quantised to 0.5 m; z 8..10 everywhere, z 11..12 where land | AWS Terrain Tiles (USGS 3DEP on land) |
| `tiles/img/{z}/{x}/{y}.jpg` | aerial photo, 256 px; z 8..10 everywhere, z 11..13 where land | USGS The National Map `USGSImageryOnly` (public domain) |
| `tiles/bld/{z}/{x}/{y}.bin` | building footprints + heights, z 14; bit 7 of `kind` marks a footprint detected from imagery by a machine where OSM has none | OpenStreetMap (ODbL); additions from Overture Maps: Google Open Buildings (CC BY 4.0), Microsoft ML Buildings (ODbL). Rule and counts in `tiles/bld/index.json` (`added_source`) |
| `tiles/surge/c{1..5}/{z}/{x}/{y}.png`, `tiles/slide/{z}/{x}/{y}.png` | pre-coloured hazard overlays, z 8..13, with `index.json` (legend, disclaimer, tile list) | NOAA NHC surge risk maps; USGS OFR 2020-1022 |
| `data/hazards/{lidar,surge,slide}/` | each raster's value at every building and asset, method and QA (`pipeline/hazards/README.md`) | hazard stages; folded into the tiles and the seed by `pipeline/hazards/merge.mjs` and `pipeline/derive.mjs` |
| `data/twin.db` | seed SQLite database (objects, links, properties, sources) | `pipeline/build-db.mjs` |
| `data/manifest.json` | seed version and build time | pipeline |

Deeper zooms are streamed at run time from the upstream services (terrain to z 15, imagery to z 16).

## Rebuilding the buildings

Building tiles are the root of a chain; a rebuild goes through all of it or the parts disagree.

1. `vector.yml` (push to `pipe-vector`): OSM extract, Overture additions, flood zones, tiles. It publishes under
   `staging/` on `gh-pages` (tiles only when the commit message contains `[publish-tiles]`), never over the live paths.
2. Promote: in a checkout of `gh-pages`, replace `tiles/bld`, `data/osm`, `data/derived`, `data/geo` with their
   `staging/` copies, delete `staging/`, push.
3. Run `lidar.yml`, `surge.yml`, `slide.yml` (workflow dispatch): each samples its raster at every building in tile
   order and publishes `data/hazards/<stage>/`. `heights.yml` (dispatch with `publish = yes`) measures every
   building's height in the lidar point cloud and publishes `data/hazards/heights/`.
4. In the checkout: `node pipeline/hazards/merge.mjs <site>` (lidar ground into the tiles, measured heights where
   OSM has no height tag, exposure per municipio),
   `node pipeline/derive.mjs <site>` (batches 50 to 53), `node src/ontology/build-seed.ts <site>/data/seed
   <site>/data/twin.db --version <v>`, new `data/manifest.json`, push, then `tools/deploy.sh`.

Between steps 2 and 4 the live tiles carry the coarse terrain elevation instead of lidar; nothing breaks.

## Store and ontology

`src/ontology/types.ts` is the contract; read it first. Summary:

- **Object** `id = "<type>:<key>"`, where key is the id in the type's canonical scheme (Census GEOID, USGS site
  number, NOAA CO-OPS id, NWS alert id, USGS event id, OSM `way/123`, HUD id). Other ids go in `identity` so two
  sources naming the same thing merge instead of duplicating.
- **Property**: one row per (object, key, source) with `observedAt` and `confidence`. Sources may disagree; the
  UI shows all of them and the "best" value is a user's if there is one, otherwise the most recently observed.
- **Link**: typed, directed, with source and confidence (`located_in`, `affects`, `monitors`, `serves`, ...).
- **Observation**: `(object, metric, t, value)` time series (gauge stage, water level, customers out).
- **Source / ingest_run**: lineage. Every fetch writes a run row (ok, error, rows, bytes).
- **action_log**: audit trail of user writeback (`annotate`).

Engine: `@sqlite.org/sqlite-wasm` in a Worker. The seed `data/twin.db` is built by the pipeline with the same
schema, imported on first load, and kept in OPFS (`opfs-sahpool`) so history accumulates across visits; falls
back to memory. FTS5 for search, R*Tree for bbox queries.

Feeds never touch the scene or the UI. A feed returns an `IngestBatch`; the store ingests it and emits a
`ChangeEvent`; the scene and the panels re-query. One path for baked, live and user data.

## Conventions

- TypeScript, ES modules, no semicolon wars: follow the file you are in. Comments say why, not what.
- No network calls outside `src/feeds/` and `src/world/` tile loaders. No API keys anywhere.
- Times are epoch milliseconds UTC in data; the UI shows AST (UTC-4, no daylight saving).
- UI strings go through `t()` in `src/i18n/` with English and Spanish.
- Do not run `git` in the main working tree unless you were told you own a branch. One owner per directory.

## Working on one part

- `createEngine(canvas, { terrain, controls, post })` (`src/world/engine.ts`) takes a factory per part and falls
  back to `src/world/placeholder.ts` (a synthetic island, a plain render, a fixed camera) for the rest.
- A part gets its own root-level test page (`r1.html`, `store.html`, ...) that imports only what it needs. The
  shared dev server at `http://127.0.0.1:5280/` serves every root-level page; do not start another on that port.
- `node tools/shot.mjs <url> out.png --w 1600 --h 900 --wait 4000` takes a headless screenshot (software GL, slow).
  The page must set `globalThis.__garita = { ready: true, debug() {...} }`.
- `ENTRY=r1.html tools/deploy.sh dev/r1` publishes a test page to
  `https://webgpu-demos.github.io/garita/dev/r1/r1.html` (about a minute to go live) where it can be
  opened on a real GPU with live network. `tools/sync-site.sh` refreshes the local copy of `gh-pages`.
- Files that Node tests import use explicit `.ts` extensions on relative imports and erasable TypeScript only
  (no enums, no parameter properties): Node 22 runs them directly (`node --test tests/*.test.ts`).
