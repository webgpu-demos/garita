// Storm replay: pick a historical storm (NOAA HURDAT2 best track), drive the scene clock through it, and report who
// was inside its wind field at the scene time. Everything is computed from the best-track radii and the store.
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { TwinStore, ObjectSummary } from '../../ontology/types';
import * as S from '../../core/state';
import { loadStorms, stormAt, windBandAt, saffirSimpson, type Storm } from '../../core/storms';
import { t, tr } from '../../i18n/index';
import { Icon } from '../icons';
import { num, dmm, fmtDateTime, haversineKm, SAN_JUAN, DASH } from '../format';
import { storeTick, useQuery } from '../uistate';

const H = 3600e3;
/** First day of the daily night-light layers NASA GIBS serves (src/world/overlays.ts, NIGHT_FIRST). */
const NL_FIRST = Date.UTC(2012, 2, 1);

export function exitReplay() {
  S.replayStormId.value = null; S.playbackRate.value = 0; S.sceneTime.value = Date.now(); S.clockMode.value = 'live'; S.highlightIds.value = [];
}
function start(s: Storm, at = s.closest_t - 12 * H) {
  S.replayStormId.value = s.id; S.clockMode.value = 'manual';
  S.sceneTime.value = Math.max(s.points[0].t, Math.min(s.points[s.points.length - 1].t, at));
  S.playbackRate.value = 3600;
  S.flyTo.value = { lon: -66.45, lat: 18.22, range: 600000, heading: 0, pitch: 62, seconds: 2 };
}

export function ReplayPanel({ store }: { store: TwinStore }) {
  const [storms, setStorms] = useState<Storm[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [time, setTime] = useState(S.sceneTime.peek());
  useEffect(() => {
    loadStorms().then(setStorms).catch((e) => setFailed(String(e?.message ?? e)));
    const id = setInterval(() => setTime(S.sceneTime.peek()), 300);
    return () => clearInterval(id);
  }, []);
  const places = useQuery(async () => ({
    munis: await store.listObjects('municipio', { limit: 200, props: ['population'] }),
    ph: await store.listObjects('public_housing', { limit: 3000, props: ['units'] }).catch(() => [] as ObjectSummary[]),
    shelters: await store.listObjects('shelter', { limit: 3000, props: ['capacity'] }).catch(() => [] as ObjectSummary[]),
  }), [storeTick.value]);
  const id = S.replayStormId.value;
  const storm = storms?.find((s) => s.id === id) ?? null;
  const p = storm ? stormAt(storm, time) : null;
  // Stop at the end of the best track instead of playing on into empty time.
  useEffect(() => {
    if (!storm) return;
    const end = storm.points[storm.points.length - 1].t;
    const iv = setInterval(() => { if (S.replayStormId.peek() === storm.id && S.sceneTime.peek() > end && S.playbackRate.peek() > 0) { S.playbackRate.value = 0; S.sceneTime.value = end; } }, 300);
    return () => clearInterval(iv);
  }, [storm?.id]);
  const hasRadii = !!storm && storm.points.some((pt) => pt.r34 || pt.r50 || pt.r64);
  const located = (list: ObjectSummary[]) => list.filter((o) => o.lon != null && o.lat != null);

  const inside = useMemo(() => {
    if (!p || !places) return null;
    const munis = located(places.munis);
    if (!munis.length) return null;
    const bands = { 64: { n: 0, pop: 0 }, 50: { n: 0, pop: 0 }, 34: { n: 0, pop: 0 } } as Record<number, { n: number; pop: number }>;
    let popKnown = true;
    for (const m of munis) {
      const b = windBandAt(p, m.lon!, m.lat!);
      const pop = typeof m.props?.population === 'number' ? (m.props.population as number) : null;
      if (pop == null && b) popKnown = false;
      for (const kt of [64, 50, 34]) if (b >= kt) { bands[kt].n++; bands[kt].pop += pop ?? 0; }
    }
    const ph = located(places.ph).filter((o) => windBandAt(p, o.lon!, o.lat!) === 64);
    const sh = located(places.shelters).filter((o) => windBandAt(p, o.lon!, o.lat!) === 64);
    const units = ph.map((o) => o.props?.units).filter((x): x is number => typeof x === 'number');
    return { bands, popKnown, total: munis.length, ph, sh, units: units.length ? units.reduce((a, b) => a + b, 0) : null };
  }, [p ? Math.round(p.t / 600e3) : 0, id, places]);
  useEffect(() => {
    if (!id) return;
    const ids = inside ? [...inside.ph, ...inside.sh].map((o) => o.id) : [];
    const cur = S.highlightIds.peek();
    if (cur.length !== ids.length || cur[0] !== ids[0] || cur[cur.length - 1] !== ids[ids.length - 1]) S.highlightIds.value = ids;
  }, [inside, id]);

  if (failed) return <div class="pane"><p class="muted pad">{tr('Storm tracks are not available:', 'Las trayectorias no están disponibles:')} <span class="num">{failed}</span></p></div>;
  if (!storms) return <div class="pane"><p class="muted pad">{tr('Loading storm tracks', 'Cargando trayectorias')}…</p></div>;

  if (!storm) {
    const list = [...storms].sort((a, b) => b.closest_t - a.closest_t);
    return (
      <div class="pane replay">
        <header class="pane-head pane-head-col">
          <h2>{tr('Replay a historical storm', 'Repetir una tormenta histórica')}</h2>
          <p class="muted">{tr('Historical best track (NOAA HURDAT2). Choosing a storm moves the scene clock to 12 hours before its closest approach to Puerto Rico.', 'Trayectoria histórica (NOAA HURDAT2). Al escoger una tormenta, el reloj de la escena va a 12 horas antes de su punto más cercano a Puerto Rico.')}</p>
        </header>
        <div class="pane-scroll table-wrap">
          <table class="grid rp-list">
            <thead><tr><th><span class="sql-th">{tr('Storm', 'Tormenta')}</span></th><th class="r"><span class="sql-th">{tr('Year', 'Año')}</span></th><th class="r"><span class="sql-th">{tr('Closest', 'Más cerca')} km</span></th><th class="r"><span class="sql-th">{tr('Peak wind', 'Viento máx.')} kt</span></th></tr></thead>
            <tbody>{list.map((s) => {
              const peak = (s as any).max_wind_kt;
              return (
                <tr key={s.id} tabIndex={0} onClick={() => start(s)} onKeyDown={(e) => { if (e.key === 'Enter') start(s); }}>
                  <td class="name-cell">{s.name}{s.year < 2004 ? <i title={tr('No wind radii in the record before 2004', 'Sin radios de viento en el registro antes de 2004')}> *</i> : null}</td>
                  <td class="r num">{s.year}</td><td class="r num">{num(s.closest_km)}</td><td class="r num">{typeof peak === 'number' ? num(peak) : DASH}</td>
                </tr>);
            })}</tbody>
          </table>
          <p class="muted pad rp-fine">* {tr('No wind radii in the record before 2004: track and intensity only.', 'Sin radios de viento en el registro antes de 2004: solo trayectoria e intensidad.')}</p>
        </div>
      </div>
    );
  }

  const t0 = storm.points[0].t, t1 = storm.points[storm.points.length - 1].t;
  const ss = p ? saffirSimpson(p.wind_kt) : null;
  const playing = S.playbackRate.value > 0 && S.clockMode.value === 'manual';
  const nlOn = S.overlay.value === 'nightlights';
  const band = (kt: number, label: string) => {
    const b = inside?.bands[kt];
    return (
      <tr key={kt}><td>{label} <i class="num">≥ {kt} kt</i></td>
        <td class="r num">{b ? `${b.n} / ${inside!.total}` : DASH}</td>
        <td class="r num">{b ? (inside!.popKnown ? num(b.pop) : DASH) : DASH}</td></tr>
    );
  };
  return (
    <div class="pane replay">
      <header class="pane-head pane-head-col">
        <div class="sc-level-row">
          <div><span class="label">{tr('Replaying', 'Repitiendo')} · HURDAT2 {storm.id}</span><h2 class="rp-name">{storm.name} <span class="num">{storm.year}</span></h2></div>
          <button class="btn" onClick={exitReplay}><Icon name="close" size={12} />{tr('Exit replay', 'Salir')}</button>
        </div>
        <input type="range" min={t0} max={t1} step={600e3} value={Math.max(t0, Math.min(t1, time))} aria-label={tr('Time along the track', 'Tiempo en la trayectoria')}
          onInput={(e) => { S.clockMode.value = 'manual'; S.sceneTime.value = +(e.target as HTMLInputElement).value; setTime(S.sceneTime.peek()); }} />
        <div class="sql-bar">
          <button class="btn" onClick={() => { S.clockMode.value = 'manual'; S.playbackRate.value = playing ? 0 : 3600; }}><Icon name={playing ? 'pause' : 'play'} size={12} />{playing ? tr('Pause', 'Pausa') : tr('Play 1 h/s', 'Reproducir 1 h/s')}</button>
          <button class="btn" onClick={() => { S.clockMode.value = 'manual'; S.sceneTime.value = storm.closest_t; }}>{tr('Closest approach', 'Punto más cercano')}</button>
          <span class="sql-meta num">{fmtDateTime(time)} AST</span>
        </div>
      </header>
      <div class="pane-scroll">
        <section class="sec">
          <h3 class="label">{tr('At the scene time', 'A la hora de la escena')}</h3>
          {!p ? <p class="muted">{tr("The scene clock is outside this storm's track.", 'El reloj de la escena está fuera de la trayectoria de esta tormenta.')}</p> : (
            <dl class="facts">
              <div><dt>{tr('Category', 'Categoría')}</dt><dd>{ss!.cat >= 1 ? tr(ss!.label, `Categoría ${ss!.cat}`) : ss!.cat === 0 ? tr(ss!.label, 'Tormenta tropical') : tr(ss!.label, 'Depresión tropical')} <i class="num">{p.status}</i></dd></div>
              <div><dt>{tr('Sustained wind', 'Viento sostenido')}</dt><dd class="num">{num(p.wind_kt)} kt <i>{num(p.wind_kt * 1.852)} km/h</i></dd></div>
              <div><dt>{tr('Central pressure', 'Presión central')}</dt><dd class="num">{p.pressure_mb != null ? `${num(p.pressure_mb)} mb` : DASH}</dd></div>
              <div><dt>{tr('Distance to San Juan', 'Distancia a San Juan')}</dt><dd class="num">{num(haversineKm(p.lat, p.lon, SAN_JUAN.lat, SAN_JUAN.lon))} km</dd></div>
              <div class="wide-text"><dt>{tr('Centre', 'Centro')}</dt><dd class="num">{dmm(p.lat, 'lat')}  {dmm(p.lon, 'lon')}</dd></div>
            </dl>
          )}
        </section>
        <section class="sec rp-nl">
          <h3 class="label">{t('rp.nl.title')}</h3>
          {t1 < NL_FIRST ? <p class="muted rp-fine">{t('rp.nl.none')}</p> : (
            <>
              <div class="sql-bar">
                <button class={'btn' + (nlOn ? ' on' : '')} aria-pressed={nlOn} onClick={() => { if (nlOn) S.overlay.value = null; else { S.nightBaseline.value = false; S.overlay.value = 'nightlights'; } }}><Icon name="overlay" size={12} />{nlOn ? t('rp.nl.hide') : t('rp.nl.show')}</button>
                {nlOn && <label class="ov-opt ov-check"><input type="checkbox" checked={S.nightBaseline.value} onChange={(e) => { S.nightBaseline.value = (e.target as HTMLInputElement).checked; }} /><span>{t('ov.nl.baseline')}</span></label>}
              </div>
              <p class="muted rp-fine">{t('rp.nl.help')}</p>
            </>
          )}
        </section>
        <section class="sec">
          <h3 class="label">{tr('Inside the wind field now', 'Dentro del campo de viento ahora')}</h3>
          {!hasRadii ? <p class="muted">{tr('No wind radii in the record before 2004, so the area inside each wind speed cannot be computed for this storm.', 'No hay radios de viento en el registro antes de 2004; no se puede calcular el área dentro de cada velocidad para esta tormenta.')}</p>
            : !inside ? <p class="muted">{p ? tr('Municipio points are not in the store yet.', 'Los puntos de municipios aún no están en la base de datos.') : DASH}</p> : (
              <>
                <table class="grid rp-bands">
                  <thead><tr><th>{tr('Wind', 'Viento')}</th><th class="r">{tr('Municipios', 'Municipios')}</th><th class="r">{tr('Population', 'Población')}</th></tr></thead>
                  <tbody>{band(64, tr('Hurricane force', 'Fuerza de huracán'))}{band(50, tr('Storm force', 'Fuerza de tormenta'))}{band(34, tr('Tropical storm force', 'Fuerza de tormenta tropical'))}</tbody>
                </table>
                <dl class="facts rp-assets">
                  <div><dt>{tr('Public housing inside 64 kt', 'Vivienda pública dentro de 64 kt')}</dt><dd class="num">{num(inside.ph.length)} <i>{inside.units != null ? `${num(inside.units)} ${tr('units', 'unidades')}` : ''}</i></dd></div>
                  <div><dt>{tr('Listed shelters inside 64 kt', 'Refugios listados dentro de 64 kt')}</dt><dd class="num">{num(inside.sh.length)}</dd></div>
                </dl>
              </>
            )}
          <p class="muted rp-fine">{tr('Historical best track (NOAA HURDAT2). Radii are the maximum extent of each wind speed in each quadrant, so the true area is smaller. A municipio counts when its interior point is inside the radius; population is the whole municipio (Census ACS).', 'Trayectoria histórica (NOAA HURDAT2). Los radios son la extensión máxima de cada velocidad en cada cuadrante, así que el área real es menor. Un municipio cuenta cuando su punto interior está dentro del radio; la población es la del municipio completo (Censo ACS).')}</p>
        </section>
      </div>
    </div>
  );
}
