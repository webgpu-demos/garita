// App state shared by the UI (ui/), the scene (world/) and the feeds (feeds/). Plain signals: read `.value`
// anywhere, write `.value` from event handlers. The scene watches these with `effect()`; it never imports ui/.
import { signal, computed } from '@preact/signals';
import type { Lang, TwinStore } from '../ontology/types';

export const lang = signal<Lang>('en');

/** The store, set once at boot. */
export const store = signal<TwinStore | null>(null);

// ---- selection ----
export const selectedId = signal<string | null>(null);   // object id shown in the object view
export const hoveredId = signal<string | null>(null);
/** Objects to emphasise in the scene (search results, alert footprint, scenario exposure). */
export const highlightIds = signal<string[]>([]);

// ---- layers ----
/** Object layers are keyed by object type id; scene layers and overlays by the ids below. */
export type SceneLayerId = 'buildings' | 'clouds' | 'labels' | 'municipios' | 'ocean_detail' | 'markers';
export const layerOn = signal<Record<string, boolean>>({
  // object types shown as markers at start
  weather_alert: true, earthquake: true, tropical_cyclone: true, stream_gauge: false, tide_station: true, buoy: false,
  shelter: true, public_housing: true, hospital: false, power_region: true, weather_station: false, reservoir: false,
  assisted_housing: false, school: false, fire_station: false, police_station: false, power_plant: false, substation: false,
  water_plant: false, airport: false, seaport: false, aircraft: true, clinic: false,
  // scene
  buildings: true, clouds: true, labels: true, municipios: true, ocean_detail: true, markers: true,
});
/** One raster overlay draped on the terrain at a time. null = none. */
export type OverlayId = 'radar' | 'goes' | 'nightlights' | 'nfhl' | 'slr' | 'surge' | 'slide' | 'choropleth' | 'elevation' | null;
export const overlay = signal<OverlayId>(null);
export const overlayOpacity = signal(0.75);
/** For overlay === 'choropleth': a municipio property id (see ontology.json), e.g. 'poverty_pct'. */
export const choroplethProp = signal<string>('vacancy_pct');
/** For overlay === 'surge': the hurricane category whose tile set is shown, 1..5 (?surge=4). */
export const surgeCategory = signal<number>(3);
/** Tile sets the published surge index offers, written by the overlay layer once tiles/surge/index.json is read. */
export const surgeSets = signal<{ id: string; label: { en: string; es: string } }[]>([]);
/** For overlay === 'nightlights': show the 2016 cloud-free composite instead of the night of the scene date (?nl=baseline). */
export const nightBaseline = signal<boolean>(false);
/** The publisher's own use limits for the active overlay, shown in full with the legend (never behind a click). */
export const overlayDisclaimer = signal<string | null>(null);

// ---- scene clock ----
/** live = follows the wall clock; manual = the timeline scrubber or a replay drives it. */
export const clockMode = signal<'live' | 'manual'>('live');
export const sceneTime = signal<number>(Date.now());      // epoch ms the scene is drawn for (sun, moon, tide)
export const playbackRate = signal<number>(0);            // manual mode: scene seconds per real second

// ---- scenario ----
export interface Scenario {
  /** Water level added on top of mean sea level, metres. Drives the ocean surface and the exposure counts. */
  seaLevelM: number;
  /** Where the number came from, for the legend: 'manual', 'NOAA Intermediate 2070 at San Juan', 'observed tide', ... */
  label: string;
  /** Use the live tide anomaly instead of 0 as the base. */
  followTide: boolean;
}
export const scenario = signal<Scenario>({ seaLevelM: 0, label: 'present day', followTide: false });

// ---- camera ----
export interface CameraView { lon: number; lat: number; range: number; heading: number; pitch: number; altitude: number }
/** Written by the scene every few frames. */
export const cameraView = signal<CameraView>({ lon: -66.45, lat: 18.22, range: 260000, heading: 0, pitch: 55, altitude: 150000 });
/** Written by the UI; the scene consumes it and sets it back to null. range in metres, heading/pitch in degrees (pitch 90 = straight down). */
export interface FlyTo { lon: number; lat: number; range?: number; heading?: number; pitch?: number; seconds?: number }
export const flyTo = signal<FlyTo | null>(null);
/** Ground under the pointer, written by the scene. */
export const cursorGeo = signal<{ lon: number; lat: number; elev: number } | null>(null);

// ---- environment read by the scene, written by feeds ----
export interface Weather {
  windMs: number; windDirDeg: number;        // meteorological: direction the wind comes FROM
  cloudCover: number;                        // 0..1
  waveHeightM: number; wavePeriodS: number; waveDirDeg: number;
  tideM: number;                             // observed water level relative to MSL at San Juan, metres
  observedAt: number;
  source: 'default' | 'live';
}
export const weather = signal<Weather>({ windMs: 6, windDirDeg: 80, cloudCover: 0.3, waveHeightM: 1.2, wavePeriodS: 8, waveDirDeg: 60, tideM: 0, observedAt: 0, source: 'default' });

// ---- render quality ----
export type Quality = 'low' | 'medium' | 'high';
export const quality = signal<Quality>('medium');
export const stats = signal<{ fps: number; tiles: number; pending: number; drawCalls: number; tris: number }>({ fps: 0, tiles: 0, pending: 0, drawCalls: 0, tris: 0 });

// ---- ui chrome ----
export type RightPanel = 'object' | 'scenario' | 'replay' | 'alerts' | 'explorer' | 'lineage' | 'graph' | 'sql' | null;
export const rightPanel = signal<RightPanel>('alerts');
export const fixturesMode = signal<boolean>(false);       // ?fixtures=1: read recorded payloads instead of the network
export const booted = signal<boolean>(false);
export const bootStage = signal<string>('Starting');

export const isSelected = computed(() => selectedId.value != null);

export function select(id: string | null, opts: { fly?: boolean } = {}) {
  selectedId.value = id;
  if (id) rightPanel.value = 'object';
  if (id && opts.fly) pendingFlyToObject.value = id;
}
/** The scene or main resolves this to coordinates through the store, then clears it. */
export const pendingFlyToObject = signal<string | null>(null);

// ---- added for the scene layers ----
/** Pointer position over the canvas in CSS pixels, or null when outside. Written by the app, read by tooltips. */
export const pointerPx = signal<{ x: number; y: number } | null>(null);
/** Screen area covered by panels, CSS pixels. Written by the UI; the camera centres its target in what is left. */
export const viewPadding = signal<{ left: number; right: number; top: number; bottom: number }>({ left: 0, right: 0, top: 0, bottom: 0 });
/** Legend for the active overlay, written by whichever layer draws it. */
export interface Legend { title: string; unit?: string; note?: string; stops: { color: string; label: string }[]; source?: string }
export const overlayLegend = signal<Legend | null>(null);
/** Historical storm being replayed (id from data/replay/storms.json), or null. The scene clock drives it. */
export const replayStormId = signal<string | null>(null);
/** Short text for the hovered thing that is not a store object (e.g. "Bayamón · municipio"). */
export const hoverText = signal<string | null>(null);
/** A building clicked, or named by ?pick=lon,lat: where it stands and what the tile says about it (the building card).
 *  Buildings are tile records, not store objects; `tile` and `index` say which record. */
export interface PinnedBuilding { lon: number; lat: number; text: string; tile: string; index: number }
export const pinnedBuilding = signal<PinnedBuilding | null>(null);
/** ?pick=lon,lat: the buildings layer pins the footprint under this point once its tile is in, then clears it. */
export const pendingPick = signal<{ lon: number; lat: number; at: number } | null>(null);

/** Multiplies the render resolution. 1 normally; automated screenshots load at a fraction (software GL is slow) and
 *  switch to 1 for the final frame. */
export const renderScale = signal(1);
