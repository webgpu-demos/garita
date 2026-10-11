// Scenario: who is exposed as the sea rises. A water level (S.scenario) and a bathtub screen of what sits at or
// below it, every count read from the store. Building counts come from the municipio `elev_hist` histograms and are
// never interpolated inside a bin: the level is snapped DOWN to a 0.1 m step (the lidar histogram's) and the step is stated.
import { useEffect, useState } from 'preact/hooks';
import type { TwinStore, ObjectSummary } from '../../ontology/types';
import * as S from '../../core/state';
import { dataUrl } from '../../core/config';
import { t, L } from '../../i18n/index';
import { Icon } from '../icons';
import { num, DASH } from '../format';
import { storeTick, useQuery, typeDef } from '../uistate';

type Curves = Record<string, [number, number][]>;
const SCEN = ['Low', 'Intermediate-Low', 'Intermediate', 'Intermediate-High', 'High'];
const DECADES = [2040, 2050, 2070, 2100];
const ASSETS = ['public_housing', 'shelter', 'assisted_housing', 'hospital', 'school', 'power_plant', 'substation', 'water_plant'];
const INCLUSIVE = ['0.5', '1', '1.5', '2', '3', '5'];

/** Buildings for one municipio at or below a level. With the lidar histogram (bin i = buildings at i/10 m) the count
 *  is inclusive at every step; with an older 0.25 m histogram it is inclusive only where the pipeline published it. */
function countAt(hist: any, edge: number): { n: number; inclusive: boolean } | null {
  if (!hist || !Array.isArray(hist.bins)) return null;
  const bin = hist.bin_m || 0.25;
  let n = +hist.below_0 || 0;
  if (hist.inclusive) {
    const k = Math.min(hist.bins.length - 1, Math.round(edge / bin));
    for (let i = 0; i <= k; i++) n += +hist.bins[i] || 0;
    if (edge >= hist.bins.length * bin) n += +hist.above_10 || 0;
    return { n, inclusive: true };
  }
  const key = INCLUSIVE.find((k) => Math.abs(+k - edge) < 1e-6);
  if (key && hist.at_or_below && hist.at_or_below[key] != null) return { n: +hist.at_or_below[key], inclusive: true };
  const k = Math.min(hist.bins.length, Math.round(edge / bin));
  for (let i = 0; i < k; i++) n += +hist.bins[i] || 0;
  return { n, inclusive: false };
}

function Chart({ curves, level }: { curves: Curves; level: number }) {
  const W = 340, H = 120, l = 30, r = 8, tp = 6, b = 18, y1 = 2.2;
  const x = (yr: number) => l + ((yr - 2020) / 80) * (W - l - r);
  const y = (m: number) => H - b - (Math.min(m, y1) / y1) * (H - tp - b);
  return (
    <svg class="sc-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="NOAA 2022 relative sea level scenarios, San Juan, 2020–2100">
      {[0, 0.5, 1, 1.5, 2].map((m) => <g key={m}><line x1={l} x2={W - r} y1={y(m)} y2={y(m)} class="sc-grid" /><text x={l - 4} y={y(m) + 3} class="sc-ax" text-anchor="end">{m.toFixed(1)}</text></g>)}
      {[2020, 2040, 2060, 2080, 2100].map((yr) => <text key={yr} x={x(yr)} y={H - 4} class="sc-ax" text-anchor={yr === 2100 ? 'end' : yr === 2020 ? 'start' : 'middle'}>{yr}</text>)}
      {SCEN.map((s, i) => {
        const pts = (curves[s] ?? []).filter((p) => p[0] >= 2020 && p[0] <= 2100);
        return pts.length ? <path key={s} class={'sc-curve c' + i} d={pts.map((p, j) => (j ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join('')} /> : null;
      })}
      {level <= y1 && <line x1={l} x2={W - r} y1={y(level)} y2={y(level)} class="sc-level" />}
    </svg>
  );
}

/** Headline counts to two significant figures: the elevation source terraces at whole metres in the coastal plain,
 *  so the last digits of a count are not information. The exact figure is in the tooltip and the table. */
const approx = (n: number) => { if (n < 100) return num(n); const k = Math.pow(10, Math.floor(Math.log10(n)) - 1); return '≈ ' + num(Math.round(n / k) * k); };

export function ScenarioPanel({ store }: { store: TwinStore }) {
  const sc = S.scenario.value;
  const tide = S.weather.value.source === 'live' ? S.weather.value.tideM : null;
  const level = sc.seaLevelM + (sc.followTide && tide != null ? tide : 0);
  const edge = Math.floor(level / 0.1 + 1e-6) * 0.1;   // the lidar histogram's step
  const [curves, setCurves] = useState<Curves | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [method, setMethod] = useState(false);
  useEffect(() => {
    fetch(dataUrl('data/replay/slr_projections.json')).then((r) => (r.ok ? r.json() : null)).then((j) => setCurves(j?.['9755371']?.scenarios ?? null)).catch(() => setCurves(null));
    return () => { S.highlightIds.value = []; };
  }, []);
  const set = (m: number, label: string) => { S.scenario.value = { ...S.scenario.peek(), seaLevelM: Math.max(0, Math.min(3, Math.round(m * 100) / 100)), label }; };

  const munis = useQuery(() => store.listObjects('municipio', { limit: 200, props: ['elev_hist', 'buildings'] }), [storeTick.value]);
  const assets = useQuery(async () => {
    const out: Record<string, ObjectSummary[]> = {};
    await Promise.all(ASSETS.map(async (ty) => {
      out[ty] = await store.listObjects(ty, { where: { ground_elev_m: ['<=', level] }, limit: 5000, orderBy: 'name', props: ['ground_elev_m', 'units', 'residents', 'municipio_name'] }).catch(() => []);
    }));
    return out;
  }, [storeTick.value, Math.round(level * 100)]);
  useEffect(() => { if (assets) S.highlightIds.value = Object.values(assets).flat().slice(0, 2000).map((o) => o.id); }, [assets]);

  const rows = (munis ?? []).map((m) => {
    let hist: any = null;
    try { hist = typeof m.props?.elev_hist === 'string' ? JSON.parse(m.props.elev_hist as string) : null; } catch { hist = null; }
    const c = countAt(hist, edge);
    const total = typeof m.props?.buildings === 'number' ? (m.props.buildings as number) : null;
    return { m, n: c?.n ?? null, inclusive: c?.inclusive ?? false, total };
  }).filter((r) => r.n != null);
  const island = rows.length ? rows.reduce((a, r) => a + (r.n as number), 0) : null;
  const inclusive = rows.length > 0 && rows.every((r) => r.inclusive);
  const top = [...rows].sort((a, b) => (b.n as number) - (a.n as number)).slice(0, 10);
  const sumProp = (list: ObjectSummary[], k: string) => { const v = list.map((o) => o.props?.[k]).filter((x): x is number => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) : null; };

  return (
    <div class="pane scenario">
      <header class="pane-head pane-head-col">
        <div class="sc-level-row">
          <div><span class="label">{t('sc.level')}</span><h2 class="num sc-big">+{level.toFixed(2)} m <i>{(level * 3.28084).toFixed(1)} ft</i></h2></div>
          <span class="sc-label">{sc.label}{sc.followTide && tide != null ? ` + ${t('sc.tide.short')} ${tide >= 0 ? '+' : '−'}${Math.abs(tide).toFixed(2)} m` : ''}</span>
        </div>
        <input type="range" min="0" max="3" step="0.05" value={sc.seaLevelM} aria-label={t('sc.level')} onInput={(e) => set(+(e.target as HTMLInputElement).value, t('sc.manual'))} />
        <div class="sc-tools">
          <label class="check"><input type="checkbox" checked={sc.followTide} onChange={(e) => { S.scenario.value = { ...sc, followTide: (e.target as HTMLInputElement).checked }; }} />
            <span class="check-mark" /><span>{t('sc.tide')} <span class="num">{tide != null ? `${tide >= 0 ? '+' : '−'}${Math.abs(tide).toFixed(2)} m` : DASH}</span></span></label>
          <span class="sc-surge"><span class="label">{t('sc.surge')}</span>{[1, 2, 3].map((m) => <button key={m} class="btn" onClick={() => set(sc.seaLevelM + m, `${sc.label} + ${m} m ${t('sc.surge.label')}`)}>+{m} m</button>)}</span>
        </div>
      </header>
      <div class="pane-scroll">
        <section class="sec">
          <h3 class="label">{t('sc.noaa')}</h3>
          {!curves ? <p class="muted">{t('sc.noaa.none')}</p> : (
            <>
              <Chart curves={curves} level={level} />
              <table class="grid sc-presets">
                <thead><tr><th>{t('sc.scenario')}</th>{DECADES.map((d) => <th key={d} class="r num">{d}</th>)}</tr></thead>
                <tbody>
                  {SCEN.map((s, i) => (
                    <tr key={s}><td><span class={'sc-key c' + i} />{s}</td>
                      {DECADES.map((d) => {
                        const v = curves[s]?.find((p) => p[0] === d)?.[1];
                        const on = v != null && Math.abs(v - sc.seaLevelM) < 0.005 && sc.label.includes(String(d)) && sc.label.includes(`NOAA ${s},`);
                        return <td key={d} class="r">{v == null ? DASH : <button class={'sc-cell num' + (on ? ' on' : '')} onClick={() => set(v, `NOAA ${s}, ${d}, San Juan: +${v.toFixed(2)} m vs 2005`)}>{v.toFixed(2)}</button>}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p class="muted sc-fine">{t('sc.noaa.note')}</p>
            </>
          )}
        </section>
        <section class="sec">
          <h3 class="label">{t('sc.buildings')}</h3>
          <div class="sc-headline"><span class="num sc-big" title={island != null ? num(island) : undefined}>{island != null ? approx(island) : DASH}</span>
            <span>{inclusive ? t('sc.atorbelow') : t('sc.below')} <b class="num">{edge.toFixed(2)} m</b>{Math.abs(edge - level) > 0.001 ? <i> · {t('sc.binned')}</i> : null}</span></div>
          {top.length > 0 && (
            <table class="grid sc-top">
              <thead><tr><th>{t('sc.muni')}</th><th class="r">{t('sc.count')}</th><th class="r">{t('sc.share')}</th></tr></thead>
              <tbody>{top.map((r) => (
                <tr key={r.m.id} tabIndex={0} onClick={() => S.select(r.m.id, { fly: true })} onKeyDown={(e) => { if (e.key === 'Enter') S.select(r.m.id, { fly: true }); }}>
                  <td class="name-cell">{r.m.name}</td><td class="r num">{num(r.n)}</td><td class="r num">{r.total ? ((100 * (r.n as number)) / r.total).toFixed(1) + '%' : DASH}</td>
                </tr>))}</tbody>
            </table>
          )}
          {munis && !rows.length && <p class="muted">{t('sc.nohist')}</p>}
        </section>
        <section class="sec">
          <h3 class="label">{t('sc.assets')} <span class="num">≤ {level.toFixed(2)} m</span></h3>
          <ul class="sc-assets">
            {ASSETS.map((ty) => {
              const def = typeDef(ty); const list = assets?.[ty];
              const units = ty === 'public_housing' && list ? sumProp(list, 'units') : null, res = ty === 'public_housing' && list ? sumProp(list, 'residents') : null;
              return (
                <li key={ty}>
                  <button class="sc-asset" aria-expanded={open === ty} disabled={!list?.length} onClick={() => setOpen(open === ty ? null : ty)}>
                    <span class="type-badge sm" style={{ '--c': def?.color } as any}><Icon name={def?.icon ?? 'dot'} size={12} /></span>
                    <span class="sc-asset-name">{def ? L(def.plural) : ty}</span>
                    {units != null && <span class="num muted">{num(units)} {t('sc.units')}{res != null ? ` · ${num(res)} ${t('sc.residents')}` : ''}</span>}
                    <span class="num sc-asset-n">{list ? num(list.length) : DASH}</span>
                    <Icon name={open === ty ? 'chevUp' : 'chevDown'} size={12} />
                  </button>
                  {open === ty && list && (
                    <ul class="sc-names">{list.slice(0, 200).map((o) => (
                      <li key={o.id}><button class="link-row" onClick={() => S.select(o.id, { fly: true })}><span class="link-name">{o.name}</span>
                        <span class="num link-type">{typeof o.props?.ground_elev_m === 'number' ? (o.props.ground_elev_m as number).toFixed(1) + ' m' : DASH}</span></button></li>))}</ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
        <section class="sec">
          <button class="link-btn" aria-expanded={method} onClick={() => setMethod(!method)}>{t('sc.method')}</button>
          {method && <p class="sc-method">{t('sc.method.body')}</p>}
          <p><button class="btn" onClick={() => { S.overlay.value = 'slr'; }}><Icon name="overlay" size={14} />{t('sc.overlay')}</button></p>
        </section>
      </div>
    </div>
  );
}
