// The street view of San Juan: procedural-sanjuan (github.com/webgpu-demos/procedural-sanjuan), the same city at
// street level, compiled from OpenStreetMap with FEMA USA Structures heights, with a simulated morning's traffic.
// Garita opens it at a point with ?ll=lat,lon (and the scenario's sea level with ?sea=); it links back here with
// ?pick=lon,lat, which pins the building under that point (world/buildings). Plain functions, tested in Node.

export const STREET_VIEW = {
  url: 'https://webgpu-demos.github.io/procedural-sanjuan/',
  /** The area it covers: its `sanjuan` area (the municipio), tools/pipeline/config.mjs there. West, south, east, north. */
  bbox: [-66.129, 18.296, -65.991, 18.476] as const,
};

export function inStreetView(lon: number, lat: number): boolean {
  const [w, s, e, n] = STREET_VIEW.bbox;
  return Number.isFinite(lon) && Number.isFinite(lat) && lon >= w && lon <= e && lat >= s && lat <= n;
}

/** The street view at (lon, lat), or null outside its area. The sea level goes along when the scenario raised it. */
export function streetViewUrl(lon: number, lat: number, opts: { sea?: number | null; gers?: string | null } = {}): string | null {
  if (!inStreetView(lon, lat)) return null;
  const u = new URL(STREET_VIEW.url);
  u.searchParams.set('ll', `${+lat.toFixed(6)},${+lon.toFixed(6)}`);   // latitude first: that city's convention
  if (opts.sea != null && Number.isFinite(opts.sea) && opts.sea > 0.005) u.searchParams.set('sea', String(+opts.sea.toFixed(2)));
  if (opts.gers && parseGers(opts.gers)) u.searchParams.set('bld', opts.gers.toLowerCase());   // the building itself, when the street view has its id
  u.searchParams.set('from', 'garita');
  return u.href.replace(/%2C/g, ',');
}

/** ?pick=lon,lat (longitude first, as in ?cam) -> the point, or null. */
export function parsePick(s: string | null | undefined): { lon: number; lat: number } | null {
  if (!s) return null;
  const [lon, lat] = s.split(',').map((v) => (v.trim() === '' ? NaN : Number(v)));
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  return { lon, lat };
}

/** ?bld=<GERS id> (with ?pick or ?ll): the building by its Overture id, which wins over the point. */
export function parseGers(s: string | null | undefined): string | null {
  return s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim()) ? s.trim().toLowerCase() : null;
}
