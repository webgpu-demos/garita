// Bottom bar: cursor readout, the scene clock, attribution. The scene writes S.sceneTime every frame, so this
// samples it twice a second instead of subscribing (no per-frame re-render of the UI).
import { useEffect, useState } from 'preact/hooks';
import * as S from '../core/state';
import { t } from '../i18n/index';
import { Icon } from './icons';
import { dmm, num, fmtTime, fmtDay, astDayStart, sunTimes, hhmm, DASH } from './format';

const RATES = [0, 600, 3600];

function useSampled<T>(read: () => T, ms: number): T {
  const [v, setV] = useState(read);
  useEffect(() => { const id = setInterval(() => setV(read()), ms); return () => clearInterval(id); }, []);
  return v;
}

function Readout() {
  const c = S.cursorGeo.value;
  const cam = useSampled(() => S.cameraView.peek(), 500);
  const st = useSampled(() => S.stats.peek(), 1000);
  const depth = c != null && c.elev < 0;
  const alt = cam?.altitude;
  return (
    <div class="bb-read">
      <div class="bb-cell bb-cursor">
        <span class="label">{t('bb.cursor')}</span>
        {c ? <span class="num">{dmm(c.lat, 'lat')}  {dmm(c.lon, 'lon')}</span> : <span class="muted">{t('bb.nocursor')}</span>}
      </div>
      <div class="bb-cell">
        <span class="label">{depth ? t('bb.depth') : t('bb.elev')}</span>
        <span class="num">{c ? <>{num(Math.abs(c.elev))} m <i>{num(Math.abs(c.elev) * 3.28084)} ft</i></> : DASH}</span>
      </div>
      <div class="bb-cell">
        <span class="label">{t('bb.cam')}</span>
        <span class="num">{alt != null && Number.isFinite(alt) ? (alt >= 10000 ? `${(alt / 1000).toFixed(1)} km` : `${num(alt)} m`) : DASH}</span>
      </div>
      <div class="bb-cell bb-stats">
        <span class="label">{t('bb.fps')} · {t('bb.tiles')}</span>
        <span class="num">{st.fps > 0 ? Math.round(st.fps) : DASH} · {st.fps > 0 || st.tiles > 0 ? st.tiles : DASH}{st.pending > 0 ? <i> +{st.pending}</i> : null}</span>
      </div>
    </div>
  );
}

function SceneClock() {
  const mode = S.clockMode.value;
  const rate = S.playbackRate.value;
  const time = useSampled(() => S.sceneTime.peek(), 400);
  const [drag, setDrag] = useState<number | null>(null);
  const day0 = astDayStart(time);
  const minute = drag ?? Math.max(0, Math.min(1439, Math.floor((time - day0) / 60e3)));
  const sun = sunTimes(time);
  const nowMin = (Date.now() - astDayStart(Date.now())) / 60e3;
  const sameDay = astDayStart(Date.now()) === day0;
  const set = (m: number) => { S.clockMode.value = 'manual'; S.sceneTime.value = day0 + m * 60e3; };
  const live = () => { S.replayStormId.value = null; S.playbackRate.value = 0; S.sceneTime.value = Date.now(); S.clockMode.value = 'live'; setDrag(null); };
  const playing = mode === 'manual' && rate > 0;
  const togglePlay = () => {
    if (playing) S.playbackRate.value = 0;
    else { if (mode === 'live') S.clockMode.value = 'manual'; S.playbackRate.value = rate || 600; }
  };
  const pct = (m: number) => `${(m / 1440) * 100}%`;
  return (
    <div class={'bb-clock mode-' + mode}>
      <button class={'live-btn' + (mode === 'live' ? ' on' : '')} onClick={live} aria-pressed={mode === 'live'} title={t('bb.live')}>
        <span class="fdot" />{t('bb.live')}
      </button>
      <button class="icon-btn" onClick={togglePlay} aria-label={playing ? t('bb.pause') : t('bb.play')} title={playing ? t('bb.pause') : t('bb.play')}>
        <Icon name={playing ? 'pause' : 'play'} size={14} />
      </button>
      <div class="seg seg-rate" role="group" aria-label={t('bb.rate')} title={t('bb.rate')}>
        {RATES.slice(1).map((r) => (
          <button key={r} class={rate === r && mode === 'manual' ? 'on' : ''} aria-pressed={rate === r}
            onClick={() => { S.clockMode.value = 'manual'; S.playbackRate.value = rate === r ? 0 : r; }}>{r === 600 ? '10 min/s' : '1 h/s'}</button>
        ))}
      </div>
      <div class="scrub">
        <div class="scrub-track">
          <span class="scrub-night" style={{ left: 0, width: pct(sun.rise) }} />
          <span class="scrub-night" style={{ left: pct(sun.set), right: 0 }} />
          <span class="scrub-fill" style={{ width: pct(minute) }} />
          <span class="scrub-tick sun" style={{ left: pct(sun.rise) }} title={`${t('bb.sunrise')} ${hhmm(sun.rise)} · ${t('bb.sanjuan')}`} />
          <span class="scrub-tick sun" style={{ left: pct(sun.set) }} title={`${t('bb.sunset')} ${hhmm(sun.set)} · ${t('bb.sanjuan')}`} />
          {sameDay && mode !== 'live' && <span class="scrub-tick now" style={{ left: pct(nowMin) }} />}
          {[6, 12, 18].map((h) => <span key={h} class="scrub-hour" style={{ left: pct(h * 60) }} />)}
        </div>
        <input type="range" min="0" max="1439" step="1" value={minute} aria-label={t('bb.scrub')}
          onInput={(e) => { const m = +(e.target as HTMLInputElement).value; setDrag(m); set(m); }}
          onChange={() => setDrag(null)} />
        <div class="scrub-labels num">
          <span style={{ left: pct(sun.rise) }}><Icon name="sun" size={10} />{hhmm(sun.rise)}</span>
          <span style={{ left: pct(sun.set) }}><Icon name="sun" size={10} />{hhmm(sun.set)}</span>
        </div>
      </div>
      <div class="bb-time" title={t('bb.scene')}>
        <span class="num bb-time-main">{drag != null ? hhmm(drag) : fmtTime(time)}</span>
        <span class="num bb-time-day">{fmtDay(time)} AST</span>
      </div>
    </div>
  );
}

export function BottomBar() {
  return (
    <footer class="bottombar panel">
      <Readout />
      <SceneClock />
      <button class="bb-attrib" title={t('bb.attrib.title')} onClick={() => { S.rightPanel.value = 'lineage'; }}>
        © OpenStreetMap contributors · Overture Maps Foundation · Google · Microsoft · USGS · NOAA · NASA · FEMA · HUD
      </button>
    </footer>
  );
}
