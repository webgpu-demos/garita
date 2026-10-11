// The one raster overlay draped on the terrain (S.overlay): live rain radar, GOES-East, NASA night lights, FEMA flood
// zones, NOAA sea level rise mapping, baked hazard tiles (storm surge, landslide susceptibility), a municipio
// choropleth drawn in the browser, or the terrain's own elevation tint.
// Every overlay publishes a legend (S.overlayLegend) that says what is shown, for when, and who publishes it.
import { computed, effect, signal, untracked } from '@preact/signals';
import * as S from '../core/state';
import { dataUrl, params } from '../core/config';
import { AST_OFFSET_H, ORIGIN, latToTileY, lonToTileX, tileLat, tileLon } from '../core/geo.ts';
import type { LayerFactory } from './layers';
import type { OverlaySource } from './types';
import { DERIVED_SFHA, NO_DATA, choroplethDef, choroplethValues, formatValue, loadMunicipios, makeChoropleth } from './choropleth';

const tr = (en: string, es: string) => (S.lang.value === 'es' ? es : en);
const ast = (ms: number) => { const d = new Date(ms + AST_OFFSET_H * 3600000); return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} AST`; };
const HALF = 20037508.342789244;

// RainViewer "Universal Blue" (colour scheme 2): values read from the published table,
// rainviewer.com/files/rainviewer_api_colors_table.csv (rain block), at each 5 dBZ step.
const RV_STOPS: [number, string][] = [[15, '#88ddee'], [20, '#00a3e0'], [25, '#0077aa'], [30, '#005588'], [35, '#ffee00'], [40, '#ffaa00'], [45, '#ff4400'], [50, '#c10000'], [55, '#ffaaff'], [60, '#ff77ff'], [65, '#ffffff']];
// Below 15 dBZ the scheme shades weak echoes in tan with rising opacity (#cec087 at 10 dBZ).
const RV_WEAK = '#cec087';
// NWS base reflectivity colours used by the Iowa Environmental Mesonet N0Q tiles.
const NWS_STOPS: [number, string][] = [[5, '#04e9e7'], [10, '#019ff4'], [15, '#0300f4'], [20, '#02fd02'], [25, '#01c501'], [30, '#008e00'], [35, '#fdf802'], [40, '#e5bc00'], [45, '#fd9500'], [50, '#fd0000'], [55, '#d40000'], [60, '#bc0000'], [65, '#f800fd']];
const dbz = (st: [number, string][]) => st.map(([v, color], i) => ({ color, label: i === st.length - 1 ? `≥ ${v}` : `${v}` }));

// Overlays of things in the air (radar, satellite) are carried over the open sea by the terrain's far-sea plane, which
// covers this box (terrain/index.ts, loadAbyssalOverlay). The picture is faded out over the last degrees inside
// it, so that coverage ends in a gradient instead of a hard rectangle. Tiles well inside the box are untouched.
const AIR_BOX = { west: -76, east: -58, south: 11, north: 26 }, AIR_FEATHER = 2.5;
/** tries > 1: a tile that fails on the network or with a server error is asked for again (GIBS answers 502 now and then). */
function feathered(url: (z: number, x: number, y: number) => string, tries = 1): NonNullable<OverlaySource['draw']> {
  return async (z, x, y) => {
    let r: Response | null = null;
    for (let k = 0; k < tries; k++) {
      if (k) await new Promise((res) => setTimeout(res, 500 * k));
      r = await fetch(url(z, x, y), { mode: 'cors' }).catch((e) => { if (k === tries - 1) throw e; return null; });
      if (r && (r.ok || r.status < 500)) break;
    }
    if (!r || !r.ok) return null;
    const blob = await r.blob();
    const w = tileLon(x, z), e = tileLon(x + 1, z), n = tileLat(y, z), s = tileLat(y + 1, z), F = AIR_FEATHER;
    // (straight alpha, as the terrain's own loader asks for: its shader blends by the alpha itself)
    if (w >= AIR_BOX.west + F && e <= AIR_BOX.east - F && s >= AIR_BOX.south + F && n <= AIR_BOX.north - F) return createImageBitmap(blob, { premultiplyAlpha: 'none' });
    const img = await createImageBitmap(blob);
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const g = cv.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0); img.close?.();
    const d = g.getImageData(0, 0, cv.width, cv.height), px = d.data;
    for (let j = 0; j < cv.height; j++) {
      const lat = tileLat(y + (j + 0.5) / cv.height, z), fy = Math.min(lat - AIR_BOX.south, AIR_BOX.north - lat);
      for (let i = 0; i < cv.width; i++) {
        const lon = w + ((i + 0.5) / cv.width) * (e - w);
        const f = Math.max(0, Math.min(1, Math.min(fy, lon - AIR_BOX.west, AIR_BOX.east - lon) / F));
        if (f < 1) px[(j * cv.width + i) * 4 + 3] *= f * f * (3 - 2 * f);
      }
    }
    g.putImageData(d, 0, 0);
    return cv;
  };
}

// ---- night lights (NASA GIBS) ----
// The daily VIIRS Day/Night Band layers GIBS serves and the dates each holds, read from the service's WMTS
// capabilities on 2026-10-10. A request for a date a layer does not hold answers 404. Order = preference.
// The last one is the older, coarser rendering (tiles to zoom 7): it is the only one that answers for many days of
// 2017, where GIBS lists ENCC images but answers 502 for them (seen 2026-10-10 for 2017-09-15, -20, -25, 2017-10-05).
// Not used: the "GapFilled BRDF Corrected" layers. They fill cloudy pixels with earlier clear nights, so the week
// after María looks fully lit in them.
interface NightLayer { id: string; from: string; to: string | null; sat: string; product: [string, string]; level: 7 | 8 }
export const NIGHT_LAYERS: NightLayer[] = [
  { id: 'VIIRS_SNPP_DayNightBand_At_Sensor_Radiance', from: '2020-11-18', to: null, sat: 'Suomi NPP', product: ['at-sensor radiance', 'radiancia en el sensor'], level: 8 },
  { id: 'VIIRS_NOAA20_DayNightBand_At_Sensor_Radiance', from: '2024-03-25', to: null, sat: 'NOAA-20', product: ['at-sensor radiance', 'radiancia en el sensor'], level: 8 },
  { id: 'VIIRS_SNPP_DayNightBand_ENCC', from: '2016-11-30', to: '2023-07-07', sat: 'Suomi NPP', product: ['enhanced near-constant contrast (ENCC)', 'contraste casi constante mejorado (ENCC)'], level: 8 },
  { id: 'VIIRS_SNPP_DayNightBand', from: '2012-03-01', to: null, sat: 'Suomi NPP', product: ['the earlier GIBS rendering, coarser (tiles to zoom 7)', 'la representación anterior de GIBS, más gruesa (teselas hasta zoom 7)'], level: 7 },
];
/** Annual cloud-free composite used as the "normal lights" baseline. */
const NIGHT_BASE = { id: 'VIIRS_Black_Marble', date: '2016-01-01', level: 8 as const };
export const NIGHT_FIRST = '2012-03-01';
/** Layers that hold a given day (YYYY-MM-DD), in order of preference. */
export const nightLayersFor = (day: string) => NIGHT_LAYERS.filter((l) => day >= l.from && (l.to == null || day <= l.to));
const nightTile = (layer: { id: string; level: number }, day: string, z: number, x: number, y: number) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer.id}/default/${day}/GoogleMapsCompatible_Level${layer.level}/${z}/${y}/${x}.png`;
/** Calendar day in Puerto Rico (AST, UTC-4) of a moment. The overpass is near 1:30 a.m. AST, which is the same UTC day. */
export const astDay = (ms: number) => new Date(ms + AST_OFFSET_H * 3600000).toISOString().slice(0, 10);
const dayBefore = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
const PR_BOX = { west: -67.3, east: -65.2, south: 17.88, north: 18.53 };
/** Asks for the one tile that holds Puerto Rico: 'none' = the layer has no image for that day (404); 'error' = the
 *  service failed (GIBS answers 502 without CORS headers for some days it lists, which fetch reports as a network
 *  error); 'empty' = an image exists but under half of the island's box has data in it; 'ok' otherwise. */
async function nightProbe(layer: { id: string; level: number }, day: string): Promise<'ok' | 'empty' | 'none' | 'error'> {
  const z = 6, x = Math.floor(lonToTileX(ORIGIN.lon, z)), y = Math.floor(latToTileY(ORIGIN.lat, z));
  try {
    let r = await fetch(nightTile(layer, day, z, x, y), { mode: 'cors' }).catch(() => null);
    for (let k = 1; k < 3 && (!r || r.status >= 500); k++) { await new Promise((res) => setTimeout(res, 500 * k)); r = await fetch(nightTile(layer, day, z, x, y), { mode: 'cors' }).catch(() => null); }
    if (!r) return 'error';
    if (r.status === 404 || r.status === 400) return 'none';
    if (!r.ok || !(r.headers.get('content-type') ?? 'image').startsWith('image')) return 'error';
    const img = await createImageBitmap(await r.blob());
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const g = cv.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0); img.close?.();
    const w = tileLon(x, z), e = tileLon(x + 1, z);
    const i0 = Math.max(0, Math.floor(((PR_BOX.west - w) / (e - w)) * cv.width)), i1 = Math.min(cv.width, Math.ceil(((PR_BOX.east - w) / (e - w)) * cv.width));
    const j0 = Math.max(0, Math.floor((latToTileY(PR_BOX.north, z) - y) * cv.height)), j1 = Math.min(cv.height, Math.ceil((latToTileY(PR_BOX.south, z) - y) * cv.height));
    if (i1 <= i0 || j1 <= j0) return 'ok';
    const d = g.getImageData(i0, j0, i1 - i0, j1 - j0).data;
    let n = 0;
    for (let k = 3; k < d.length; k += 4) if (d[k] > 8) n++;
    return n >= d.length / 8 ? 'ok' : 'empty';
  } catch { return 'error'; }
}

// ---- baked hazard tiles (pipeline/hazards/README.md, "Overlay tiles") ----
type L2 = { en?: string; es?: string } | string | undefined;
interface BakedIndex {
  minZoom: number; maxZoom: number; tileSize?: number;
  sets?: { id: string; label: { en: string; es: string } }[];
  tiles: [number, number, number][] | Record<string, [number, number, number][]>;
  title?: L2; unit?: string; legend?: { color: string; label: L2 }[]; note?: L2; disclaimer?: L2;
  source?: unknown; citation?: unknown; generated?: string;
}
const bakedIndex = new Map<string, BakedIndex>();
/** The stage's index.json, or null while it is not published (404, or a page that is not the index). Never throws. */
async function loadBaked(stage: 'surge' | 'slide'): Promise<BakedIndex | null> {
  const hit = bakedIndex.get(stage);
  if (hit) return hit;
  try {
    const r = await fetch(dataUrl(`tiles/${stage}/index.json`), { cache: 'no-cache' });
    if (!r.ok) return null;
    const j = JSON.parse(await r.text()) as BakedIndex;
    if (!j || typeof j.minZoom !== 'number' || typeof j.maxZoom !== 'number' || j.tiles == null || typeof j.tiles !== 'object') return null;
    bakedIndex.set(stage, j);
    return j;
  } catch { return null; }
}
const words = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? String((v as any).name ?? (v as any).text ?? (v as any).title ?? JSON.stringify(v)) : String(v));

/** NOAA maps sea level rise in half-foot steps from 0 to 10 ft; the service name spells 1.5 as "1_5". */
export function slrStep(seaLevelM: number): { ft: number; name: string; substituted: boolean } {
  const want = Math.min(10, Math.max(0, Math.round((seaLevelM / 0.3048) * 2) / 2));
  const ft = want === 0 ? 1 : want;
  return { ft, name: String(ft).replace('.', '_'), substituted: want === 0 };
}

export const createOverlays: LayerFactory = ({ world, store }) => {
  const terrain = world.terrain;
  const refresh = signal(0);
  let gen = 0, cur: OverlaySource | null = null, timer: ReturnType<typeof setTimeout> | null = null, tinted = false;
  let nfhlLegend: S.Legend | null = null, nfhlFar: boolean | null = null, lastError = '';
  let bakedLegend: (S.Legend & { minZoom: number }) | null = null, bakedFar: boolean | null = null;
  let nightLegend: S.Legend | null = null, nightLost = 0, nightDark: boolean | null = null, nightSrc = 0;
  // ?surge=1..5 and ?nl=baseline set the two overlay options from the URL.
  const sc = Math.round(+(params.get('surge') ?? NaN));
  if (sc >= 1 && sc <= 5) S.surgeCategory.value = sc;
  if (params.get('nl') === 'baseline') S.nightBaseline.value = true;
  /** What the night-lights overlay must show: '' (off), 'baseline', 'live', or the scene's day in Puerto Rico.
   *  A computed value, so that a running scene clock asks again only when the day changes. */
  const nightKey = computed(() => (S.overlay.value !== 'nightlights' ? '' : S.nightBaseline.value ? 'baseline' : S.clockMode.value === 'manual' ? astDay(S.sceneTime.value) : 'live'));

  const show = (source: OverlaySource | null, legend: S.Legend | null, disclaimer: string | null = null) => {
    cur = source;
    terrain.setOverlay(source, untracked(() => S.overlayOpacity.value));
    S.overlayLegend.value = legend;
    S.overlayDisclaimer.value = disclaimer;
  };
  /** On-demand sources record each request in the lineage; a source the store does not know yet is left alone. */
  const report = (source: string, status: 'ok' | 'error', note: string) => {
    try { if (store.ontology?.sources?.some((x) => x.id === source)) void store.reportRun(source, status, note).catch(() => {}); } catch { /* lineage is not worth breaking the overlay for */ }
  };
  const again = (ms: number) => { if (timer) clearTimeout(timer); timer = setTimeout(() => { refresh.value++; }, ms); };

  async function radar(my: number) {
    try {
      const j = await fetch('https://api.rainviewer.com/public/weather-maps.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))));
      const past = j?.radar?.past as { time: number; path: string }[] | undefined;
      if (!j?.host || !past?.length) throw new Error('no radar frames listed');
      const f = past[past.length - 1], base = `${j.host}${f.path}/256`;
      if (my !== gen) return;
      const rv = (z: number, x: number, y: number) => `${base}/${z}/${x}/${y}/2/1_1.png`;
      show({ id: `radar:rainviewer:${f.time}`, minZoom: 0, maxZoom: 7, tileSize: 256, aboveWater: true, url: rv, draw: feathered(rv) }, {
        title: tr('Rain radar', 'Radar de lluvia'), unit: 'dBZ', stops: [{ color: RV_WEAK, label: tr('< 15 (weak echoes)', '< 15 (ecos débiles)') }, ...dbz(RV_STOPS)],
        note: tr(`Reflectivity, frame of ${ast(f.time * 1000)}. Refreshes every 5 minutes. Mosaic resolution is about 1 km (tiles to zoom 7). The pale fringe around the echoes is reflectivity below 15 dBZ as RainViewer draws it (drizzle, or returns that are not rain).`, `Reflectividad, imagen de ${ast(f.time * 1000)}. Se actualiza cada 5 minutos. Resolución del mosaico: cerca de 1 km (teselas hasta zoom 7). El borde pálido alrededor de los ecos es reflectividad menor de 15 dBZ tal como la dibuja RainViewer (llovizna o ecos que no son lluvia).`),
        source: 'RainViewer radar mosaic (rainviewer.com), from NWS NEXRAD TJUA',
      });
      void store.reportRun('rainviewer', 'ok', `radar frame of ${ast(f.time * 1000)}`).catch(() => {});
    } catch (e) {
      lastError = 'rainviewer: ' + String(e);
      void store.reportRun('rainviewer', 'error', `${String(e).slice(0, 160)}; showing the NWS San Juan radar instead`).catch(() => {});
      if (my !== gen) return;
      const bust = Math.floor(Date.now() / 300000);
      const iem = (z: number, x: number, y: number) => `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::JUA-N0Q-0/${z}/${x}/${y}.png?_=${bust}`;
      show({ id: `radar:iem:${bust}`, minZoom: 0, maxZoom: 10, tileSize: 256, aboveWater: true, url: iem, draw: feathered(iem) }, {
        title: tr('Rain radar · San Juan (TJUA)', 'Radar de lluvia · San Juan (TJUA)'), unit: 'dBZ', stops: dbz(NWS_STOPS),
        note: tr(`Base reflectivity, latest scan available at ${ast(Date.now())} (the tiles carry no time stamp). Refreshes every 5 minutes.`, `Reflectividad base, último barrido disponible a las ${ast(Date.now())} (las teselas no traen hora). Se actualiza cada 5 minutos.`),
        source: 'NWS NEXRAD TJUA via Iowa Environmental Mesonet (mesonet.agron.iastate.edu)',
      });
    }
    again(300000);
  }

  async function goes(my: number) {
    const tile = (time: string, z: number, x: number, y: number) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_GeoColor/default/${time}/GoogleMapsCompatible_Level7/${z}/${y}/${x}.png`;
    const iso = (t: number) => new Date(t).toISOString().slice(0, 19) + 'Z';
    const step = 600000, t0 = Math.floor((Date.now() - 30 * 60000) / step) * step;
    const pz = 6, px = Math.floor(lonToTileX(ORIGIN.lon, pz)), py = Math.floor(latToTileY(ORIGIN.lat, pz));
    let found: number | null = null;
    // The newest image is usually 30 to 60 minutes old: ask for four 10-minute slots at a time, newest first, up to 4 hours back.
    for (let k = 0; k < 24 && found == null; k += 4) {
      const slots = [0, 1, 2, 3].map((i) => t0 - (k + i) * step);
      const ok = await Promise.all(slots.map((t) => fetch(tile(iso(t), pz, px, py), { mode: 'cors' }).then((r) => r.ok && (r.headers.get('content-type') ?? 'image').startsWith('image')).catch(() => false)));
      if (my !== gen) return;
      const i = ok.indexOf(true);
      if (i >= 0) found = slots[i];
    }
    if (my !== gen) return;
    if (found == null) {
      lastError = 'goes: no image answered in the last 4 hours';
      void store.reportRun('nasa_gibs', 'error', 'no GOES-East image from the last 4 hours answered').catch(() => {});
      show(null, { title: 'GOES-East GeoColor', stops: [], note: tr('No image from the last 4 hours answered. Trying again in 5 minutes.', 'No respondió ninguna imagen de las últimas 4 horas. Se intentará de nuevo en 5 minutos.'), source: 'NASA GIBS · NOAA GOES-East ABI' });
      again(300000);
      return;
    }
    const time = iso(found);
    show({ id: `goes:${time}`, minZoom: 0, maxZoom: 7, tileSize: 256, aboveWater: true, url: (z, x, y) => tile(time, z, x, y), draw: feathered((z, x, y) => tile(time, z, x, y)) }, {
      title: tr('Satellite · GOES-East GeoColor', 'Satélite · GOES-East GeoColor'),
      stops: [{ color: '#f4f6f7', label: tr('Cloud (day: true colour)', 'Nubes (día: color real)') }, { color: '#9db7e0', label: tr('Night: low cloud and fog', 'Noche: nubes bajas y niebla') }, { color: '#e9ecef', label: tr('Night: high cloud (infrared)', 'Noche: nubes altas (infrarrojo)') }],
      note: tr(`Image of ${ast(found)}, about ${Math.round((Date.now() - found) / 60000)} min old. Resolution about 1 km (tiles to zoom 7). At night the land under the cloud is a static city-lights picture, not live.`, `Imagen de ${ast(found)}, de hace unos ${Math.round((Date.now() - found) / 60000)} min. Resolución cerca de 1 km (teselas hasta zoom 7). De noche el suelo es una imagen fija de luces urbanas, no en vivo.`),
      source: 'NOAA GOES-East ABI GeoColor (CIRA) via NASA GIBS',
    });
    void store.reportRun('nasa_gibs', 'ok', `image of ${ast(found)}`).catch(() => {});
    again(600000);
  }

  async function nightlights(my: number, key: string) {
    const GIBS = 'NASA GIBS (gibs.earthdata.nasa.gov)';
    const base = tr('Night lights', 'Luces nocturnas');
    // Tiles that still fail after three tries leave holes: the legend counts them instead of leaving them unexplained.
    const source = (layer: { id: string; level: number }, day: string, onLost?: () => void): OverlaySource => {
      const url = (z: number, x: number, y: number) => nightTile(layer, day, z, x, y), get = feathered(url, 3), token = ++nightSrc;
      const miss = () => { if (my === gen && token === nightSrc && nightLegend) { nightLost++; nightNote(true); onLost?.(); } };
      return { id: `nightlights:${layer.id}:${day}`, minZoom: 0, maxZoom: layer.level, tileSize: 256, aboveWater: true, url, draw: async (z, x, y) => { const img = await Promise.resolve(get(z, x, y)).catch(() => null); if (!img) miss(); return img; } };
    };
    const put = (src: OverlaySource, legend: S.Legend) => { nightLost = 0; nightDark = null; nightLegend = legend; show(src, legend); nightNote(true); };
    if (!cur?.id.startsWith('nightlights:')) show(null, { title: base, stops: [], note: tr('Asking NASA for the image…', 'Pidiendo la imagen a la NASA…'), source: GIBS });
    if (key === 'baseline') {
      const got = await nightProbe(NIGHT_BASE, NIGHT_BASE.date);
      if (my !== gen) return;
      if (got === 'none' || got === 'error') {
        nightLegend = null;
        lastError = 'nightlights: the 2016 composite did not answer';
        report('nasa_black_marble', 'error', 'the Black Marble 2016 composite did not answer');
        show(null, { title: base + tr(' · 2016 baseline', ' · referencia 2016'), stops: [], note: tr('The 2016 composite did not answer. Trying again in 5 minutes.', 'El compuesto de 2016 no respondió. Se intentará de nuevo en 5 minutos.'), source: GIBS });
        again(300000);
        return;
      }
      put(source(NIGHT_BASE, NIGHT_BASE.date), {
        title: base + tr(' · 2016 baseline', ' · referencia 2016'), stops: [],
        note: tr('Baseline for comparison, not a night you can date: NASA Black Marble 2016, one cloud-free picture composed from the best nights of that year (Suomi NPP VIIRS, Day/Night Band). Brighter means more light reached the satellite. Lights built or lost since 2016 are not in it. A picture, not a calibrated measure of light or of outages. Switch the baseline off to see the night of the scene date.', 'Referencia para comparar, no una noche con fecha: NASA Black Marble 2016, una imagen sin nubes compuesta con las mejores noches de ese año (Suomi NPP VIIRS, banda día/noche). Más brillo significa que llegó más luz al satélite. No incluye luces añadidas o perdidas desde 2016. Es una imagen, no una medida calibrada de luz ni de apagones. Apague la referencia para ver la noche de la fecha de la escena.'),
        source: `NASA Black Marble 2016 (Suomi NPP VIIRS) via ${GIBS}`,
      });
      report('nasa_black_marble', 'ok', 'Black Marble 2016 composite (baseline)');
      return;
    }
    const live = key === 'live';
    // Scrubbing the timeline crosses many days: wait for it to rest before asking.
    if (!live) { await new Promise((r) => setTimeout(r, 250)); if (my !== gen) return; }
    // Live: the newest night that answers, one day back at a time (the newest image is usually a day or two old).
    // Scrubbed or replayed: the scene's day and no other.
    const first = live ? new Date().toISOString().slice(0, 10) : key;
    let found: { layers: NightLayer[]; day: string; partial: boolean } | null = null, partial: typeof found = null, failed = false;
    for (let k = 0; k < (live ? 10 : 1) && !found; k++) {
      const day = dayBefore(first, k), layers = nightLayersFor(day);
      const got = await Promise.all(layers.map((l) => nightProbe(l, day)));
      if (my !== gen) return;
      const good = layers.filter((_, n) => got[n] === 'ok'), j = got.indexOf('empty');
      if (got.includes('error')) failed = true;
      if (good.length) found = { layers: good, day, partial: false };
      else if (j >= 0 && !partial) partial = { layers: [layers[j]], day, partial: true };
    }
    found ??= partial;
    if (!found) {
      nightLegend = null;
      const held = nightLayersFor(first).length > 0;
      if (live) {
        lastError = 'nightlights: no image answered for the last 10 days';
        report('nasa_black_marble', 'error', 'no night-lights image from the last 10 days answered');
        again(600000);
      } else if (failed) {
        lastError = `nightlights: service error for ${first}`;
        report('nasa_black_marble', 'error', `the service failed for the image dated ${first}`);
      }
      show(null, {
        title: base + (live ? '' : ` · ${first}`), stops: [],
        note: live
          ? tr('No image from the last 10 days answered. Trying again in 10 minutes.', 'No respondió ninguna imagen de los últimos 10 días. Se intentará de nuevo en 10 minutos.')
          : (failed
            ? tr(`NASA's service lists a night-lights image for ${first} but failed to deliver it (server error).`, `El servicio de la NASA lista una imagen de luces nocturnas para el ${first}, pero no la entregó (error del servidor).`)
            : held
            ? tr(`NASA publishes no night-lights image for ${first} (a gap day).`, `La NASA no publica imagen de luces nocturnas para el ${first} (día sin datos).`)
            : tr(`No daily night-lights image exists here for ${first}: the layers NASA serves start on ${NIGHT_FIRST}.`, `No hay imagen diaria de luces nocturnas para el ${first}: las capas que sirve la NASA empiezan el ${NIGHT_FIRST}.`))
            + tr(' Nothing is drawn rather than another night. The 2016 baseline is still available.', ' No se dibuja nada en lugar de otra noche. La referencia de 2016 sigue disponible.'),
        source: GIBS,
      });
      return;
    }
    const { layers: cands, day } = found, age = Math.round((Date.parse(first) - Date.parse(day)) / 86400000), isPartial = found.partial;
    // GIBS lists some days of a layer and then fails on many of their tiles (ENCC in 2017): after four lost tiles the
    // next layer that holds the same day takes over, and the legend names it.
    const use = (n: number) => {
      const layer = cands[n];
      put(source(layer, day, () => { if (nightLost >= 4 && n + 1 < cands.length) use(n + 1); }), legendFor(layer, n > 0));
      report('nasa_black_marble', 'ok', `${layer.id}, image dated ${day}`);
    };
    const legendFor = (layer: NightLayer, swapped: boolean): S.Legend => ({
      title: `${base} · ${day}`,
      stops: [{ color: '#000000', label: tr('Dark: no light detected', 'Oscuro: sin luz detectada') }, { color: '#808080', label: tr('Dim light, moonlit cloud or sea', 'Luz tenue, nubes o mar con luna') }, { color: '#ffffff', label: tr('Brightest: city lights, thick moonlit cloud', 'Más brillante: luces urbanas, nube densa con luna') }],
      note: tr(`${layer.sat} satellite, VIIRS Day/Night Band, ${layer.product[0]}. Image dated ${day} (UTC): a single overpass at about 1:30 a.m. Puerto Rico time. `, `Satélite ${layer.sat}, banda día/noche de VIIRS, ${layer.product[1]}. Imagen con fecha ${day} (UTC): una sola pasada cerca de la 1:30 a.m., hora de Puerto Rico. `)
        + (live ? (age > 0 ? tr(`This is the newest image that answered, ${age} day${age === 1 ? '' : 's'} old. `, `Es la imagen más reciente que respondió, de hace ${age} día${age === 1 ? '' : 's'}. `) : tr('This is the newest image. ', 'Es la imagen más reciente. ')) : tr('Chosen by the scene date. ', 'Elegida por la fecha de la escena. '))
        + (swapped ? tr("NASA's service kept failing on another rendering of this same night, so this one is shown instead. ", 'El servicio de la NASA falló repetidamente con otra representación de esta misma noche, así que se muestra esta. ') : '')
        + (isPartial ? tr('Most of Puerto Rico has no data in this image (the swath missed it). ', 'La mayor parte de Puerto Rico no tiene datos en esta imagen (la franja no la cubrió). ') : '')
        + tr('Cloud hides or smears lights, and moonlight brightens cloud, sea and land, so two nights differ for reasons other than electricity. A picture, not a calibrated measure of light or of outages. Pixels are about 750 m.', 'Las nubes tapan o difuminan las luces, y la luna aclara nubes, mar y tierra: dos noches difieren por razones ajenas a la electricidad. Es una imagen, no una medida calibrada de luz ni de apagones. Píxeles de unos 750 m.'),
      source: `NASA / NOAA ${layer.sat} VIIRS (${layer.id}) via ${GIBS}`,
    });
    use(0);
    if (live) again(3600000);
  }

  /** Two things the night-lights legend must own up to while they are true: tiles that never arrived, and the
   *  scene's own modelled town lights, which the terrain and the buildings draw at night from building density and
   *  only dim (they do not switch off) under an overlay. Neither is part of NASA's image. */
  function nightNote(force = false) {
    if (!nightLegend || untracked(() => S.overlay.value) !== 'nightlights') return;
    const dark = (world.night ?? 0) > 0.05;
    if (!force && dark === nightDark) return;
    nightDark = dark;
    const n = nightLost;
    S.overlayLegend.value = {
      ...nightLegend,
      note: (dark ? tr('The scene is at night, so Garita also draws its own modelled town lights (from building density, dimmed here): they are not part of this image. Set the scene clock to daytime to see the image alone. ', 'La escena está de noche, así que Garita también dibuja sus propias luces modeladas (según la densidad de edificios, atenuadas aquí): no son parte de esta imagen. Ponga el reloj de la escena de día para ver solo la imagen. ') : '')
        + (n ? tr(`${n} map tile${n === 1 ? '' : 's'} did not arrive from NASA's service: the gaps show the base map, not darkness. `, `${n} tesela${n === 1 ? '' : 's'} no llegaron del servicio de la NASA: los huecos muestran el mapa base, no oscuridad. `) : '')
        + (nightLegend.note ?? ''),
    };
  }

  async function baked(my: number, stage: 'surge' | 'slide', cat: number) {
    const lang = untracked(() => S.lang.value);
    const pick = (l: L2) => (l == null ? '' : typeof l === 'string' ? l : (lang === 'es' ? l.es : l.en) || l.en || l.es || '');
    const name = stage === 'surge' ? tr('Storm surge (NHC)', 'Marejada ciclónica (NHC)') : tr('Landslide susceptibility (USGS)', 'Susceptibilidad a deslizamientos (USGS)');
    bakedLegend = null; bakedFar = null;
    const idx = await loadBaked(stage);
    if (my !== gen) return;
    if (!idx) {
      if (stage === 'surge') S.surgeSets.value = [];
      show(null, { title: name, stops: [], note: tr('Not published yet: the tiles for this map have not reached the site. Nothing is drawn. Checking again every 2 minutes.', 'Aún no publicado: las teselas de este mapa no han llegado al sitio. No se dibuja nada. Se revisa cada 2 minutos.') });
      again(120000);
      return;
    }
    let list: [number, number, number][] = [], dir = `tiles/${stage}`, setLabel = '', missingSet = false;
    if (stage === 'surge') {
      const sets = Array.isArray(idx.sets) ? idx.sets : [];
      S.surgeSets.value = sets;
      const set = sets.find((x) => x.id === `c${cat}`);
      if (set && !Array.isArray(idx.tiles)) { list = idx.tiles[set.id] ?? []; dir += `/${set.id}`; setLabel = pick(set.label); } else missingSet = true;
    } else if (Array.isArray(idx.tiles)) list = idx.tiles;
    // Only tiles the index lists are ever requested.
    const have = new Set(list.map((t) => `${t[0]}/${t[1]}/${t[2]}`)), root = dataUrl(dir + '/');
    const title = (pick(idx.title) || name) + (setLabel ? ` · ${setLabel}` : '');
    const src = [words(idx.source), words(idx.citation), idx.generated ? tr('Tiles generated ', 'Teselas generadas ') + String(idx.generated).slice(0, 10) : ''].filter(Boolean).join(' · ');
    const legend: S.Legend = {
      title, unit: idx.unit || undefined,
      stops: missingSet ? [] : (idx.legend ?? []).map((x) => ({ color: x.color, label: pick(x.label) })),
      note: missingSet ? tr(`The published index has no tile set for category ${cat}.`, `El índice publicado no tiene teselas para la categoría ${cat}.`) : pick(idx.note),
      source: src || undefined,
    };
    // What the store counted against this map (municipio totals from the pipeline), stated with the map.
    try {
      const keys = stage === 'surge' ? [`buildings_surge_cat${cat}`] : ['buildings_slide_high', 'buildings_slide_high_25m'];
      const rows = await store.listObjects('municipio', { props: keys, limit: 100 });
      if (my !== gen) return;
      const sum = (k: string) => rows.reduce((a, r) => a + (typeof r.props?.[k] === 'number' ? (r.props[k] as number) : 0), 0);
      const has = (k: string) => rows.filter((r) => typeof r.props?.[k] === 'number' && (r.props[k] as number) > 0).length;
      const n = (v: number) => v.toLocaleString(lang === 'es' ? 'es-PR' : 'en-US');
      if (!missingSet && rows.some((r) => typeof r.props?.[keys[0]] === 'number')) {
        const line = stage === 'surge'
          ? tr(`${n(sum(keys[0]))} mapped buildings stand in this category's surge area, in ${has(keys[0])} municipios (OpenStreetMap footprints; municipio-level screening). `, `${n(sum(keys[0]))} edificios cartografiados están en el área de marejada de esta categoría, en ${has(keys[0])} municipios (huellas de OpenStreetMap; cribado a nivel de municipio). `)
          : tr(`${n(sum(keys[0]))} mapped buildings stand on High or greater susceptibility; ${n(sum(keys[1]))} are within 25 m of it (OpenStreetMap footprints; screening). `, `${n(sum(keys[0]))} edificios cartografiados están en susceptibilidad Alta o mayor; ${n(sum(keys[1]))} están a 25 m de ella (huellas de OpenStreetMap; cribado). `);
        legend.note = line + (legend.note ?? '');
      }
    } catch { /* the map is shown without the count */ }
    bakedLegend = { ...legend, minZoom: idx.minZoom };
    show(have.size ? { id: `${stage}:${dir}:${idx.generated ?? ''}`, minZoom: idx.minZoom, maxZoom: idx.maxZoom, tileSize: 256, url: (z, x, y) => (have.has(`${z}/${x}/${y}`) ? `${root}${z}/${x}/${y}.png` : null) } : null, legend, pick(idx.disclaimer) || null);
    bakedNote();
  }
  /** Baked tiles start at their index's minZoom: from further away the legend says so instead of showing a bare island. */
  function bakedNote() {
    const id = untracked(() => S.overlay.value);
    if (!bakedLegend || (id !== 'surge' && id !== 'slide')) return;
    const far = terrain.stats().maxZoom < bakedLegend.minZoom;
    if (far === bakedFar) return;
    bakedFar = far;
    const { minZoom: _z, ...legend } = bakedLegend;
    S.overlayLegend.value = far ? { ...legend, note: tr('Zoom in to see this map: its tiles start closer in. ', 'Acérquese para ver este mapa: sus teselas empiezan más cerca. ') + (legend.note ?? '') } : legend;
  }

  function nfhl() {
    const url = (z: number, x: number, y: number) => {
      const res = (2 * HALF) / 2 ** z, minx = -HALF + x * res, maxy = HALF - y * res;
      return `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/export?bbox=${minx},${maxy - res},${minx + res},${maxy}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&layers=show:28&f=image`;
    };
    nfhlFar = null;
    nfhlLegend = {
      title: tr('FEMA flood hazard zones', 'Zonas de riesgo de inundación de FEMA'),
      stops: [
        { color: '#00c5ff', label: tr('1 % annual chance (zones A, AE, AH, AO; coastal VE)', '1 % de probabilidad anual (zonas A, AE, AH, AO; costera VE)') },
        { color: '#3b6fd6', label: tr('Regulatory floodway (hatched)', 'Cauce regulatorio (rayado)') },
        { color: '#ff9d3c', label: tr('0.2 % annual chance (shaded zone X)', '0.2 % de probabilidad anual (zona X sombreada)') },
      ],
      note: '',
      source: 'FEMA National Flood Hazard Layer, layer 28 "Flood Hazard Zones" (hazards.fema.gov), drawn by FEMA\'s map service',
    };
    show({ id: 'nfhl', minZoom: 11, maxZoom: 16, tileSize: 256, url }, nfhlLegend);
    nfhlNote();
  }
  function nfhlNote() {
    if (!nfhlLegend || untracked(() => S.overlay.value) !== 'nfhl') return;
    const far = terrain.stats().maxZoom < 11;
    if (far === nfhlFar) return;
    nfhlFar = far;
    const base = tr('Effective flood insurance rate map zones, colours as FEMA draws them. Coastal high hazard zones (V, VE) are 1 % annual chance zones too.', 'Zonas vigentes del mapa de tasas de seguro de inundación, con los colores de FEMA. Las zonas costeras de alto riesgo (V, VE) también son de 1 % anual.');
    S.overlayLegend.value = { ...nfhlLegend, note: far ? tr('Zoom in to see the zones: FEMA\'s service draws them only at close range (tile zoom 11 and deeper). ', 'Acérquese para ver las zonas: el servicio de FEMA solo las dibuja de cerca (zoom 11 o mayor). ') + base : base };
  }

  function slr(seaLevelM: number) {
    const s = slrStep(seaLevelM), m = seaLevelM.toFixed(seaLevelM < 1 ? 2 : 1);
    const shown = tr(`NOAA mapping at +${s.ft} ft`, `Mapa de NOAA a +${s.ft} pies`);
    const why = s.substituted
      ? tr(` (your scenario is +${m} m; +1 ft is the first step shown here)`, ` (su escenario es +${m} m; +1 pie es el primer paso que se muestra)`)
      : tr(` (nearest to your +${m} m)`, ` (el más cercano a su +${m} m)`);
    show({ id: `slr:${s.name}`, minZoom: 0, maxZoom: 16, tileSize: 256, url: (z, x, y) => `https://coast.noaa.gov/arcgis/rest/services/dc_slr/slr_${s.name}ft/MapServer/tile/${z}/${y}/${x}` }, {
      title: tr('Sea level rise inundation', 'Inundación por aumento del nivel del mar'),
      stops: [
        { color: '#a6cee3', label: tr('Water, shallower', 'Agua, menos profunda') },
        { color: '#1f5fa8', label: tr('Water, deeper', 'Agua, más profunda') },
        { color: '#8fd64f', label: tr('Low-lying, not connected to the sea', 'Zona baja sin conexión con el mar') },
      ],
      note: shown + why + tr(' above mean higher high water. A bathtub model on lidar elevation: no waves, storm surge, erosion or drainage.', ' sobre la pleamar media más alta. Modelo de "bañera" sobre elevación lidar: sin oleaje, marejada, erosión ni drenaje.'),
      source: 'NOAA Office for Coastal Management, Sea Level Rise Viewer (coast.noaa.gov/slr)',
    });
  }

  async function choropleth(my: number, prop: string) {
    const def = choroplethDef(store, prop), derived = prop === DERIVED_SFHA;
    const lang = untracked(() => S.lang.value);
    const title = def?.label?.[lang] ?? prop;
    try {
      const [list, got] = await Promise.all([loadMunicipios(), choroplethValues(store, prop)]);
      if (my !== gen) return;
      const { values, sample } = got;
      let source: string | undefined;
      if (sample) {
        const rec = await store.getObject(sample).catch(() => null);
        if (my !== gen) return;
        const sid = rec?.allProps.find((p) => p.key === got.sourceProp)?.source, sd = store.ontology.sources.find((x) => x.id === sid);
        source = sd ? `${sd.name} · ${sd.org}` : sid;
        if (derived) source = tr('Derived here: buildings in the 1 % zone ÷ mapped buildings × 1,000. Inputs: ', 'Derivado aquí: edificios en la zona de 1 % ÷ edificios cartografiados × 1,000. Insumos: ') + (source ?? '');
      }
      const c = makeChoropleth(list, values, prop);
      const fmt = (v: number) => formatValue(v, def, lang);
      const edges = [c.min, ...c.breaks, c.max];
      const stops = c.colors.map((color, i) => ({ color, label: i === c.colors.length - 1 ? `${fmt(edges[i])} – ${fmt(edges[i + 1])}` : `${fmt(edges[i])} – < ${fmt(edges[i + 1])}` }));
      if (c.missing) stops.push({ color: NO_DATA, label: tr(`No data (${c.missing})`, `Sin datos (${c.missing})`) });
      show(values.size ? c.source : null, {
        title, unit: def?.format === 'pct' || def?.format === 'usd' ? undefined : def?.unit, stops: values.size ? stops : [],
        note: values.size
          ? tr(`${values.size} of ${list.length} municipios, ${c.colors.length} classes with equal counts (quantiles); darker = higher.`, `${values.size} de ${list.length} municipios, ${c.colors.length} clases con igual número (cuantiles); más oscuro = mayor.`)
          : tr('The store holds no values for this property.', 'El almacén no tiene valores para esta propiedad.'),
        source,
      });
    } catch (e) {
      lastError = 'choropleth: ' + String(e);
      if (my === gen) show(null, { title, stops: [], note: tr('Could not draw this map: ', 'No se pudo dibujar este mapa: ') + String((e as Error)?.message ?? e) });
    }
  }

  function elevation() {
    const has = typeof terrain.setTint === 'function';
    if (has) { terrain.setTint!('elevation'); tinted = true; }
    const ramp = (terrain as any).tintLegend as { color: string; label: string }[] | undefined;
    show(null, {
      title: tr('Elevation', 'Elevación'), unit: 'm',
      stops: ramp ?? [{ color: '#174085', label: tr('Sea floor, 2,000 m deep', 'Fondo marino, 2,000 m') }, { color: '#4594cc', label: tr('Sea floor, 60 m deep', 'Fondo marino, 60 m') }, { color: '#216633', label: '0' }, { color: '#5c9140', label: '150' }, { color: '#c7bd70', label: '450' }, { color: '#ad855c', label: '850' }, { color: '#f2ede0', label: '≥ 1,300' }],
      note: has ? tr('Height above mean sea level, coloured from the terrain model itself and shaded by the brightness of the photo; colours blend between the heights listed. Highest point: Cerro de Punta, 1,338 m.', 'Altura sobre el nivel medio del mar, coloreada desde el propio modelo del terreno y sombreada con el brillo de la foto; los colores se mezclan entre las alturas indicadas. Punto más alto: Cerro de Punta, 1,338 m.')
        : tr('This build of the terrain has no elevation tint yet; the photo is shown unchanged.', 'Esta versión del terreno aún no tiene tinte de elevación; la foto se muestra sin cambios.'),
      source: 'USGS 3DEP elevation via AWS Terrain Tiles (the terrain model drawn here)',
    });
  }

  const stop = effect(() => {
    const id = S.overlay.value;
    S.lang.value; refresh.value;
    const sea = id === 'slr' ? S.scenario.value.seaLevelM : 0;
    const prop = id === 'choropleth' ? S.choroplethProp.value : '';
    const night = id === 'nightlights' ? nightKey.value : '';
    const cat = id === 'surge' ? S.surgeCategory.value : 0;
    const my = ++gen;
    if (timer) { clearTimeout(timer); timer = null; }
    untracked(() => {
      if (id !== 'elevation' && tinted) { terrain.setTint?.('none'); tinted = false; }
      if (id !== 'nfhl') nfhlLegend = null;
      if (id !== 'surge' && id !== 'slide') bakedLegend = null;
      if (id !== 'nightlights') nightLegend = null;
      if (id === 'radar') void radar(my);
      else if (id === 'goes') void goes(my);
      else if (id === 'nightlights') void nightlights(my, night);
      else if (id === 'surge' || id === 'slide') void baked(my, id, cat);
      else if (id === 'nfhl') nfhl();
      else if (id === 'slr') slr(sea);
      else if (id === 'choropleth') void choropleth(my, prop);
      else if (id === 'elevation') elevation();
      else show(null, null);
    });
  });
  const stopOpacity = effect(() => { const o = S.overlayOpacity.value; terrain.setOverlay(cur, o); });
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const offChange = store.onChange((e) => {
    if (S.overlay.value !== 'choropleth' || !e.types.includes('municipio')) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { refresh.value++; }, 1500);
  });

  return {
    update(f) { if (f.index % 20 === 0) { nfhlNote(); bakedNote(); nightNote(); } },
    dispose() {
      stop(); stopOpacity(); offChange();
      if (timer) clearTimeout(timer); if (debounce) clearTimeout(debounce);
      if (tinted) terrain.setTint?.('none');
      terrain.setOverlay(null, 0); S.overlayLegend.value = null; S.overlayDisclaimer.value = null;
    },
    ...({ debug: () => ({ overlay: S.overlay.value, source: cur?.id ?? null, aboveWater: !!cur?.aboveWater, lastError, legend: S.overlayLegend.value && { title: S.overlayLegend.value.title, note: S.overlayLegend.value.note, stops: S.overlayLegend.value.stops.length } }) } as object),
  };
};
