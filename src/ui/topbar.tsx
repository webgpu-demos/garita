import { useEffect, useState } from 'preact/hooks';
import type { TwinStore, SourceStatus } from '../ontology/types';
import * as S from '../core/state';
import { t } from '../i18n/index';
import { Icon, GaritaMark } from './icons';
import { fmtTime, fmtDay } from './format';
import { paletteOpen, aboutOpen, storeTick, nowTick, useQuery } from './uistate';

export type Fresh = 'ok' | 'stale' | 'error' | 'static' | 'unknown' | 'ondemand';
/** Live sources that are not polled: map tiles this browser asks for only while their overlay is switched on
 *  (src/world/overlays.ts). They record each request, but are not feeds that can be on time or late. */
export const ON_DEMAND: Record<string, NonNullable<S.OverlayId>> = { rainviewer: 'radar', nasa_gibs: 'goes', nasa_black_marble: 'nightlights', noaa_slr: 'slr' };
/** ok / stale (older than 3x the expected cadence) / error. Sources without a cadence are static. */
export function freshness(s: SourceStatus, now: number): Fresh {
  const live = s.source.kind === 'live' || s.source.kind === 'relay';
  if (s.source.id in ON_DEMAND) return 'ondemand';   // (their card still shows the last request and any error)
  if (!s.lastRun) return live ? 'unknown' : 'static';
  if (s.lastRun.status === 'error') return 'error';
  if (s.lastRun.status === 'stale') return 'stale';
  if (s.source.cadence_s && now - s.lastRun.finishedAt > 3 * s.source.cadence_s * 1000) return 'stale';
  return live ? 'ok' : 'static';
}
export interface FeedTally { ok: SourceStatus[]; stale: SourceStatus[]; error: SourceStatus[]; unknown: SourceStatus[]; ondemand: SourceStatus[]; polled: number; state: 'ok' | 'stale' | 'error' | 'unknown' }
/** The feed count shown in the top bar: live and relayed sources that are polled on a schedule, by state. */
export function tallyFeeds(src: SourceStatus[], now: number): FeedTally {
  const out: FeedTally = { ok: [], stale: [], error: [], unknown: [], ondemand: [], polled: 0, state: 'unknown' };
  for (const s of src) {
    if (s.source.kind !== 'live' && s.source.kind !== 'relay') continue;
    out[freshness(s, now) as 'ok' | 'stale' | 'error' | 'unknown' | 'ondemand'].push(s);
  }
  out.polled = out.ok.length + out.stale.length + out.error.length + out.unknown.length;
  out.state = out.ok.length + out.stale.length + out.error.length === 0 ? 'unknown' : out.error.length ? 'error' : out.stale.length ? 'stale' : 'ok';
  return out;
}
/** The tally in words, one fact per line: how many are on time, which are not and why, and what is left out of the count. */
export function feedSummary(f: FeedTally): string[] {
  const names = (l: SourceStatus[]) => l.map((s) => s.source.name).join(', ');
  const lines = [t('feeds.sum').replace('{ok}', String(f.ok.length)).replace('{n}', String(f.polled))];
  if (f.error.length) lines.push(`${t('feeds.failing')}: ${names(f.error)}`);
  if (f.stale.length) lines.push(`${t('feeds.late')}: ${names(f.stale)}`);
  if (f.unknown.length) lines.push(`${t('feeds.waiting')}: ${names(f.unknown)}`);
  if (f.ondemand.length) lines.push(`${t('feeds.ondemand').replace('{n}', String(f.ondemand.length))}: ${names(f.ondemand)}`);
  return lines;
}

function Clock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  return (
    <div class="tb-clock" title="Atlantic Standard Time (UTC−4)">
      <span class="num tb-time">{fmtTime(now, true)}</span>
      <span class="label">{t('app.ast')}</span>
      <span class="num tb-date">{fmtDay(now)}</span>
    </div>
  );
}

function FeedChip({ store }: { store: TwinStore }) {
  const src = useQuery(() => store.sources(), [storeTick.value, nowTick.value]);
  const f = tallyFeeds(src ?? [], nowTick.value);
  const state = src ? f.state : 'unknown';
  // The denominator is the feeds that are polled; overlay tile services are named in the tooltip, not counted as missing.
  const title = src ? feedSummary(f).join('\n') : t('feeds.none');
  return (
    <button class={'chip feed-chip fresh-' + state} title={title} aria-label={title} onClick={() => { S.rightPanel.value = 'lineage'; }}>
      <span class={'fdot fresh-' + state} />
      <span class="num">{src ? `${f.ok.length}/${f.polled}` : '—'}</span>
      <span class="label tb-hide-narrow">{t('feeds.chip')}</span>
    </button>
  );
}

export function TopBar({ store }: { store: TwinStore }) {
  const q = S.quality.value;
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  return (
    <header class="topbar panel">
      <button class="tb-brand" onClick={() => { aboutOpen.value = true; }} title={t('app.about')} aria-haspopup="dialog">
        <GaritaMark />
        <span class="wordmark">GARITA</span>
        <span class="tb-sub">{t('app.subtitle')}</span>
      </button>
      <button class="tb-search" onClick={() => { paletteOpen.value = true; }} aria-label={t('app.search')}>
        <Icon name="search" size={14} />
        <span class="tb-search-text">{t('app.search')}</span>
        <kbd class="num">{mac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <div class="tb-right">
        <Clock />
        <FeedChip store={store} />
        <div class="seg" role="group" aria-label={t('app.lang')}>
          {(['en', 'es'] as const).map((l) => (
            <button key={l} class={S.lang.value === l ? 'on' : ''} aria-pressed={S.lang.value === l} onClick={() => { S.lang.value = l; }}>{l.toUpperCase()}</button>
          ))}
        </div>
        <div class="seg seg-quality" role="group" aria-label={t('app.quality')} title={t('app.quality')}>
          {(['low', 'medium', 'high'] as const).map((k) => (
            <button key={k} class={q === k ? 'on' : ''} aria-pressed={q === k} onClick={() => { S.quality.value = k; }}>{t('q.' + k)}</button>
          ))}
        </div>
      </div>
    </header>
  );
}
