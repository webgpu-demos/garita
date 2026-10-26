// The object view: what this thing is, what we know about it, who said so and when, and what it is linked to.
import { useEffect, useState } from 'preact/hooks';
import type { TwinStore, ObjectRecord, LinkRecord, PropRecord, Series, MetricDef } from '../../ontology/types';
import * as S from '../../core/state';
import { t, L } from '../../i18n/index';
import { Icon } from '../icons';
import { formatProp, ago, fmtDateTime, fmtTime, dd, dmm, num, unitLabel, DASH } from '../format';
import { streetViewUrl } from '../../core/streetview';
import { storeTick, nowTick, useQuery, typeDef, sourceDef, linkDef, propDef, sevClass, paletteOpen, aircraftFixAt } from '../uistate';

function SourceChip({ id }: { id: string }) {
  const s = sourceDef(id);
  const tip = s ? `${s.name}\n${s.org}\n${s.license}\n${s.url}` : id;
  return <span class={'src-chip kind-' + (s?.kind ?? 'unknown')} title={tip}><span class="src-chip-dot" />{s?.name ?? id}</span>;
}

/** 72 h sparkline: faint area, 1.5 px line, emphasised endpoint; min / max / last in mono beside it. */
function Spark({ series, metric }: { series: Series | undefined; metric: MetricDef }) {
  const W = 220, H = 36, P = 3;
  const unit = unitLabel(metric.unit);
  if (!series) return <div class="spark-row"><span class="spark-name">{L(metric.label)}</span><span class="muted">…</span></div>;
  const nPts = series.t.length;
  if (nPts < 2) return (
    <div class="spark-row is-empty"><span class="spark-name">{L(metric.label)}</span><span class="muted">{nPts === 1 ? <span class="num">{num(series.v[0], 2)} {unit}</span> : t('ob.noseries')}</span></div>
  );
  let lo = Infinity, hi = -Infinity;
  for (const v of series.v) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const t0 = series.t[0], t1 = series.t[nPts - 1], span = hi - lo || 1;
  const x = (tt: number) => P + ((tt - t0) / (t1 - t0 || 1)) * (W - 2 * P);
  const y = (v: number) => H - P - ((v - lo) / span) * (H - 2 * P);
  let d = '';
  for (let i = 0; i < nPts; i++) d += (i ? 'L' : 'M') + x(series.t[i]).toFixed(1) + ' ' + y(series.v[i]).toFixed(1);
  const last = series.v[nPts - 1];
  const digits = Math.abs(hi) >= 100 ? 0 : Math.abs(hi) >= 10 ? 1 : 2;
  return (
    <div class="spark-row">
      <div class="spark-head">
        <span class="spark-name">{L(metric.label)}</span>
        <span class="num spark-last">{num(last, digits)}<i> {unit}</i></span>
      </div>
      <div class="spark-body">
        <svg class="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${L(metric.label)}: ${num(lo, digits)} – ${num(hi, digits)} ${unit}`}>
          <path d={`${d}L${x(t1).toFixed(1)} ${H}L${x(t0).toFixed(1)} ${H}Z`} class="spark-area" />
          <path d={d} class="spark-line" vector-effect="non-scaling-stroke" />
        </svg>
        <span class="spark-end" style={{ top: `${(y(last) / H) * 100}%` }} />
        <dl class="spark-stats num">
          <div><dt>{t('ob.max')}</dt><dd>{num(hi, digits)}</dd></div>
          <div><dt>{t('ob.min')}</dt><dd>{num(lo, digits)}</dd></div>
        </dl>
      </div>
      <div class="spark-axis num"><span>{fmtDateTime(t0)}</span><span>{fmtDateTime(t1)}</span></div>
    </div>
  );
}

function Sparks({ store, o }: { store: TwinStore; o: ObjectRecord }) {
  const ty = typeDef(o.type);
  const metrics = (ty?.metrics ?? []).filter((m) => !o.metrics?.length || o.metrics.includes(m.id));
  const data = useQuery(async () => {
    const since = Date.now() - 72 * 3600e3;
    const out: Record<string, Series> = {};
    await Promise.all(metrics.map(async (m) => { out[m.id] = await store.series(o.id, m.id, { since, maxPoints: 240 }).catch(() => ({ t: [], v: [] })); }));
    return out;
  }, [o.id, storeTick.value]);
  if (!ty?.metrics?.length) return null;
  return (
    <section class="sec">
      <h3 class="label">{t('ob.trend')}</h3>
      {metrics.length === 0 && <p class="muted">{t('ob.noseries')}</p>}
      {metrics.map((m) => <Spark key={m.id} metric={m} series={data?.[m.id]} />)}
    </section>
  );
}

function AllProps({ o }: { o: ObjectRecord }) {
  const now = nowTick.value;
  const groups = new Map<string, PropRecord[]>();
  for (const p of o.allProps) { if (p.source === 'user') continue; const g = groups.get(p.key); if (g) g.push(p); else groups.set(p.key, [p]); }
  if (!groups.size) return <p class="muted">{t('ob.noprops')}</p>;
  const order = (typeDef(o.type)?.properties ?? []).map((p) => p.id);
  const keys = [...groups.keys()].sort((a, b) => (order.indexOf(a) < 0 ? 999 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 999 : order.indexOf(b)));
  return (
    <table class="grid props">
      <thead><tr><th>{t('ob.prop')}</th><th class="r">{t('ob.value')}</th><th>{t('ob.source')}</th><th class="r">{t('ob.observed')}</th></tr></thead>
      <tbody>
        {keys.map((key) => {
          const recs = groups.get(key)!;
          const def = propDef(o.type, key);
          // One row per source. When they disagree, show every row and mark the value the store treats as best.
          const distinct = new Set(recs.map((r) => String(r.value))).size > 1;
          const bestVal = o.props && key in o.props ? o.props[key] : recs[0].value;
          const bestIdx = Math.max(0, recs.findIndex((r) => r.value === bestVal));
          const rows = distinct ? recs : recs.slice(0, 1);
          return rows.map((r, i) => {
            const f = formatProp(def, r.value, r.unit);
            const long = typeof r.value === 'string' && r.value.length > 48;
            return (
              <tr key={key + r.source + i} class={(distinct ? 'conflict ' : '') + (distinct && i !== bestIdx ? 'not-best' : '')}>
                <td class="prop-key" title={key}>{i === 0 ? (def ? L(def.label) : key) : ''}{i === 0 && distinct && <span class="pill pill-warn" title={t('ob.disagree')}>{recs.length}</span>}</td>
                <td class={(f.numeric ? 'r num ' : 'r ') + (long ? 'long' : '')} title={long ? String(r.value) : undefined}>
                  {def?.type === 'url' && typeof r.value === 'string' ? <a href={r.value} target="_blank" rel="noopener noreferrer">{r.value.replace(/^https?:\/\/(www\.)?/, '').slice(0, 30)}</a> : f.text}
                  {f.unit && f.text !== DASH && <i> {f.unit}</i>}
                  {distinct && i === bestIdx && <span class="pill pill-best">{t('ob.best')}</span>}
                </td>
                <td><SourceChip id={r.source} /></td>
                <td class="r num muted" title={fmtDateTime(r.observedAt)}>{ago(r.observedAt, now)}</td>
              </tr>
            );
          });
        })}
      </tbody>
    </table>
  );
}

function Links({ o, links }: { o: ObjectRecord; links: LinkRecord[] | undefined }) {
  const [openAll, setOpenAll] = useState<Record<string, boolean>>({});
  if (!links) return <p class="muted">…</p>;
  if (!links.length) return <p class="muted">{t('ob.nolinks')}</p>;
  const groups = new Map<string, { label: string; rows: { id: string; name: string; type: string; link: LinkRecord }[] }>();
  for (const l of links) {
    const out = l.src === o.id;
    const def = linkDef(l.type);
    const key = l.type + (out ? '>' : '<');
    const other = out ? { id: l.dst, name: l.dstName, type: l.dstType } : { id: l.src, name: l.srcName, type: l.srcType };
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { label: def ? L(out ? def.label : def.inverse) : l.type, rows: [] }));
    g.rows.push({ id: other.id, name: other.name ?? other.id, type: other.type ?? other.id.split(':')[0], link: l });
  }
  return (
    <div class="links">
      {[...groups.entries()].map(([key, g]) => {
        const all = openAll[key]; const rows = all ? g.rows : g.rows.slice(0, 6);
        return (
          <div key={key} class="link-group">
            <h4><span class="link-verb">{g.label}</span><span class="num link-n">{g.rows.length}</span></h4>
            <ul>
              {rows.map((r) => {
                const ty = typeDef(r.type);
                return (
                  <li key={r.id}>
                    <button class="link-row" onClick={() => S.select(r.id, { fly: true })} title={`${r.id} · ${sourceDef(r.link.source)?.name ?? r.link.source}`}>
                      <span class="type-badge sm" style={{ '--c': ty?.color } as any}><Icon name={ty?.icon ?? 'dot'} size={12} /></span>
                      <span class="link-name">{r.name}</span>
                      <span class="link-type">{ty ? L(ty.label) : r.type}</span>
                      <Icon name="chevRight" size={12} />
                    </button>
                  </li>
                );
              })}
            </ul>
            {g.rows.length > 6 && <button class="link-btn" onClick={() => setOpenAll({ ...openAll, [key]: !all })}>{all ? '−' : `+ ${g.rows.length - 6} ${t('ob.more')}`}</button>}
          </div>
        );
      })}
    </div>
  );
}

export function ObjectPanel({ store }: { store: TwinStore }) {
  const id = S.selectedId.value;
  const now = nowTick.value;
  const data = useQuery(async () => {
    if (!id) return null;
    const [o, links, log] = await Promise.all([store.getObject(id), store.getLinks(id, { direction: 'both', limit: 5000 }), store.actionLog(200).catch(() => [])]);
    return { id, o, links, log: log.filter((a) => a.objectId === id) };
  }, [id, storeTick.value]);
  const [form, setForm] = useState<null | 'note' | 'status'>(null);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<{ key: string; value: string; t: number }[]>([]);
  useEffect(() => { setForm(null); setText(''); setPending([]); setCopied(false); }, [id]);

  if (!id) return (
    <div class="pane object is-blank">
      <div class="blank">
        <Icon name="object" size={28} />
        <h2>{t('ob.none')}</h2>
        <p>{t('ob.none.body')} <button class="kbd-btn num" onClick={() => { paletteOpen.value = true; }}>/</button></p>
      </div>
    </div>
  );
  if (!data || data.id !== id) return <div class="pane object"><p class="muted pad">{t('ob.loading')}…</p></div>;
  const o = data.o;
  if (!o) return <div class="pane object"><p class="muted pad">{t('ob.missing')} <span class="num">{id}</span></p></div>;

  const ty = typeDef(o.type);
  const hasPoint = o.lon != null && o.lat != null;
  const best = (key: string) => (o.props && key in o.props ? o.props[key] : o.allProps.find((p) => p.key === key && p.source !== 'user')?.value);
  const primary = (ty?.properties ?? []).filter((p) => p.primary && p.type !== 'json');
  const userRecs = o.allProps.filter((p) => p.source === 'user');
  const notes = [...pending.filter((p) => !userRecs.some((u) => u.key === p.key && String(u.value) === p.value)).map((p) => ({ key: p.key, value: p.value, observedAt: p.t })), ...userRecs];
  const userStatus = notes.find((x) => x.key === 'status')?.value;
  const status = (userStatus as string) ?? o.status;
  const fixAt = aircraftFixAt(o);
  const street = hasPoint ? streetViewUrl(o.lon!, o.lat!, { sea: S.scenario.value.seaLevelM }) : null;
  const copy = () => { navigator.clipboard?.writeText(o.id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {}); };
  const save = async () => {
    const v = text.trim(); if (!v || !form) return;
    const key = form === 'note' ? 'note' : 'status';
    setPending((p) => [{ key, value: v, t: Date.now() }, ...p]);      // show at once; the store confirms on its next change event
    setForm(null); setText('');
    try { await store.annotate(o.id, key, v, form === 'note' ? v : `status → ${v}`); } catch (e) { console.warn('[ui] annotate failed', e); setPending((p) => p.filter((x) => x.value !== v)); }
  };
  return (
    <div class="pane object">
      <header class={'ob-head ' + sevClass(o.severity)}>
        <div class="ob-type">
          <span class="type-badge" style={{ '--c': ty?.color } as any}><Icon name={ty?.icon ?? 'dot'} size={14} /></span>
          <span class="label">{ty ? L(ty.label) : o.type}</span>
          <span class="ob-pills">
            {o.severity != null && o.severity > 0 && <span class={'pill ' + sevClass(o.severity)}>{t('sev.' + Math.min(4, Math.round(o.severity)))}</span>}
            {status && <span class={'pill pill-status' + (userStatus ? ' pill-user' : '')}>{String(status).replace(/_/g, ' ')}</span>}
          </span>
        </div>
        <h2 class="ob-name">{o.name || o.key}</h2>
        <div class="ob-meta num">
          <button class="id-btn" onClick={copy} title={t('ob.copy')}><span>{o.id}</span><Icon name="copy" size={12} />{copied && <em>{t('ob.copied')}</em>}</button>
          {hasPoint
            ? <span title={`${dd(o.lat)}, ${dd(o.lon)}`}>{dmm(o.lat!, 'lat')}  {dmm(o.lon!, 'lon')}</span>
            : <span class="muted">{t('ob.noloc')}{o.geometry?.type ? ` · ${o.geometry.type}` : ''}</span>}
        </div>
        {fixAt != null && <p class="ob-relay">{t('ac.relayed').replace('{time}', fmtTime(fixAt)).replace('{ago}', ago(fixAt, now))}</p>}
        <div class="ob-actions">
          <button class="btn" onClick={() => { S.pendingFlyToObject.value = o.id; }}><Icon name="fly" size={14} />{t('ob.fly')}</button>
          {hasPoint && street && <a class="btn" href={street} target="_blank" rel="noopener" title={t('ob.street.help')}><Icon name="external" size={14} />{t('ob.street')}</a>}
          <button class={'btn' + (form === 'note' ? ' on' : '')} onClick={() => { setForm(form === 'note' ? null : 'note'); setText(''); }}><Icon name="note" size={14} />{t('ob.note')}</button>
          <button class={'btn' + (form === 'status' ? ' on' : '')} onClick={() => { setForm(form === 'status' ? null : 'status'); setText(''); }}><Icon name="flag" size={14} />{t('ob.status')}</button>
        </div>
        {form && (
          <form class="ob-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
            {form === 'note'
              ? <textarea rows={2} placeholder={t('ob.note.ph')} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} autoFocus />
              : <input class="text" placeholder={t('ob.status.ph')} value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} autoFocus />}
            <div class="ob-form-foot">
              <span class="muted">{t('ob.usernote')}</span>
              <button type="button" class="btn ghost" onClick={() => setForm(null)}>{t('ob.cancel')}</button>
              <button type="submit" class="btn primary" disabled={!text.trim()}>{t('ob.save')}</button>
            </div>
          </form>
        )}
      </header>
      <div class="pane-scroll">
        {notes.length > 0 && (
          <section class="sec">
            <h3 class="label">{t('ob.notes')}</h3>
            <ul class="notes">
              {notes.map((x, i) => (
                <li key={i}><span class="note-key label">{x.key}</span><span class="note-text">{String(x.value)}</span><span class="num muted">{ago(x.observedAt, now)}</span></li>
              ))}
            </ul>
          </section>
        )}
        {primary.length > 0 && (
          <section class="sec">
            <h3 class="label">{t('ob.key')}</h3>
            <dl class="facts">
              {primary.map((p) => {
                const f = formatProp(p, best(p.id));
                return (
                  <div key={p.id} class={f.numeric ? '' : 'wide-text'}>
                    <dt>{L(p.label)}</dt>
                    <dd class={f.numeric ? 'num' : ''} title={f.text.length > 28 ? f.text : undefined}>{f.text}{f.unit && f.text !== DASH && !L(p.label).toLowerCase().includes(f.unit.toLowerCase()) && <i> {f.unit}</i>}</dd>
                  </div>
                );
              })}
            </dl>
          </section>
        )}
        <Sparks store={store} o={o} />
        <section class="sec">
          <h3 class="label">{t('ob.links')}{data.links.length > 0 && <span class="num"> {data.links.length}</span>}</h3>
          <Links o={o} links={data.links} />
        </section>
        <section class="sec">
          <h3 class="label">{t('ob.all')}</h3>
          <AllProps o={o} />
        </section>
        <section class="sec">
          <h3 class="label">{t('ob.ids')}</h3>
          <ul class="ids num">
            <li><span class="muted">{ty?.keyScheme ?? 'key'}</span><span>{o.key}</span></li>
            {o.identities.filter((x) => !(x.scheme === ty?.keyScheme && x.key === o.key)).map((x, i) => <li key={i}><span class="muted">{x.scheme}</span><span>{x.key}</span></li>)}
          </ul>
          <dl class="prov num">
            <div><dt class="label">{t('ob.createdby')}</dt><dd><SourceChip id={o.source} /></dd></div>
            <div><dt class="label">{t('ob.first')}</dt><dd>{fmtDateTime(o.firstSeen)}</dd></div>
            <div><dt class="label">{t('ob.updated')}</dt><dd>{fmtDateTime(o.updatedAt)}</dd></div>
            {(o.validFrom != null || o.validTo != null) && <div><dt class="label">{t('ob.valid')}</dt><dd>{fmtDateTime(o.validFrom)} → {fmtDateTime(o.validTo)}</dd></div>}
          </dl>
        </section>
        {data.log.length > 0 && (
          <section class="sec">
            <h3 class="label">{t('ob.audit')}</h3>
            <ul class="audit num">
              {data.log.slice(0, 20).map((a, i) => <li key={i}><span class="muted">{fmtDateTime(a.t)}</span><span>{a.action}</span><span class="audit-payload">{typeof a.payload === 'string' ? a.payload : JSON.stringify(a.payload)}</span></li>)}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
