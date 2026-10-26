// Your data: a file of your own records (inspections, cases, model outputs) joined to the buildings, in this browser
// only. The rows go into this browser's database (core/localdata.ts); nothing is uploaded, and Forget removes them.
import { useState } from 'preact/hooks';
import type { TwinStore } from '../../ontology/types';
import * as S from '../../core/state';
import { t } from '../../i18n/index';
import { Icon } from '../icons';
import { storeTick, useQuery } from '../uistate';
import { dataUrl } from '../../core/config';
import { parseFile, joinRows, fetchTileLoader, type JoinResult } from '../../core/localdata';
import { validateBatch } from '../../ontology/validate';

const MAX_BYTES = 60e6;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));

export function LocalPanel({ store }: { store: TwinStore }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<{ file: string; counts: JoinResult['counts']; problems: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const files = useQuery(() => store.query<{ file: string; n: number }>(
    "SELECT value AS file, COUNT(*) AS n FROM prop WHERE source_id = 'local_file' AND key = 'file' GROUP BY value ORDER BY value"), [storeTick.value]);
  const nStruct = useQuery(() => store.query<{ n: number }>("SELECT COUNT(*) AS n FROM object WHERE type = 'structure' AND source_id = 'local_file'").then((r) => r[0]?.n ?? 0), [storeTick.value]);

  const load = async (f: File) => {
    setErr(null); setLast(null);
    if (f.size > MAX_BYTES) { setErr(fill(t('local.toobig'), { mb: Math.round(MAX_BYTES / 1e6) })); return; }
    try {
      setBusy(t('local.reading'));
      const parsed = parseFile(f.name, await f.text());
      setBusy(fill(t('local.joining'), { n: parsed.rows.length }));
      const res = await joinRows(f.name, parsed, fetchTileLoader(dataUrl));
      const problems = validateBatch(res.batch, store.ontology, { maxProblems: 5 }).filter((p) => p.level === 'error');
      if (problems.length) throw new Error(problems.map((p) => `${p.where}: ${p.message}`).join('; '));
      setBusy(t('local.saving'));
      await store.ingest(res.batch);
      setLast({ file: f.name, counts: res.counts, problems: parsed.problems });
      S.layerOn.value = { ...S.layerOn.value, structure: true };
    } catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(null); }
  };
  const show = async () => {
    const rows = await store.listObjects('structure', { limit: 5000 });
    const pts = rows.filter((r) => r.lon != null && r.lat != null);
    if (!pts.length) return;
    const lons = pts.map((r) => r.lon!), lats = pts.map((r) => r.lat!);
    const w = Math.min(...lons), e = Math.max(...lons), s = Math.min(...lats), n = Math.max(...lats);
    const span = Math.max((e - w) * 105000, (n - s) * 110600, 400);
    S.layerOn.value = { ...S.layerOn.value, structure: true };
    S.flyTo.value = { lon: (w + e) / 2, lat: (s + n) / 2, range: Math.min(250000, span * 1.6), heading: 0, pitch: 55 };
  };
  const forget = async () => {
    if (!confirm(t('local.forget.confirm'))) return;
    const r = await store.forgetSource('local_file');
    setLast(null); setErr(null);
    setBusy(null);
    if (S.selectedId.peek()?.match(/^(structure|local_record):/)) S.select(null);
    console.info('[garita/local] forgotten', r);
  };

  return (
    <div class="pane local">
      <h3 class="label">{t('local.title')}</h3>
      <p class="local-privacy"><Icon name="flag" size={12} /> {t('local.privacy')}</p>
      <label class={'local-drop' + (busy ? ' busy' : '')}
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f && !busy) load(f); }}>
        <input type="file" accept=".csv,.geojson,.json,text/csv,application/geo+json,application/json" disabled={!!busy}
          onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) load(f); (e.target as HTMLInputElement).value = ''; }} />
        <span>{busy ?? t('local.pick')}</span>
      </label>
      <p class="muted local-formats">{t('local.formats')}</p>
      {err && <p class="local-err">{err}</p>}
      {last && (
        <div class="local-result">
          <b>{last.file}</b>
          <p class="num">{fill(t('local.result'), { rows: last.counts.rows, structures: last.counts.structures, gers: last.counts.gers, osm: last.counts.osm, point: last.counts.point, unmatched: last.counts.unmatched, nopos: last.counts.noPosition })}</p>
          {last.problems.map((p, i) => <p key={i} class="local-err">{p}</p>)}
        </div>
      )}
      {!!files?.length && (
        <>
          <h4 class="label">{t('local.files')}</h4>
          <ul class="local-files">{files.map((f) => <li key={f.file}><span>{f.file}</span><span class="num muted">{f.n}</span></li>)}</ul>
          <div class="ob-actions">
            <button class="btn" onClick={show} disabled={!nStruct}><Icon name="fly" size={14} />{fill(t('local.show'), { n: nStruct ?? 0 })}</button>
            <button class="btn" onClick={forget}><Icon name="close" size={14} />{t('local.forget')}</button>
          </div>
        </>
      )}
    </div>
  );
}
