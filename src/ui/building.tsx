// The building card: a building clicked in the scene, or named by ?pick=lon,lat (world/buildings pins it). Buildings
// are tile records, not store objects, so this is not the object view: what the tile says, where it stands, and the
// way down to street level where the street view covers it (core/streetview.ts).
import * as S from '../core/state';
import { t } from '../i18n/index';
import { Icon } from './icons';
import { streetViewUrl } from '../core/streetview';
import { storeTick, useQuery } from './uistate';

export function BuildingCard() {
  const b = S.pinnedBuilding.value;
  // your own records about it (ui/panels/local.tsx), found through its GERS id
  const mine = useQuery(async () => (b?.gers && S.store.value ? S.store.value.getObject(`structure:${b.gers}`) : null), [b?.gers, storeTick.value]);
  if (!b) return null;
  const sea = S.scenario.value.seaLevelM;
  const sv = streetViewUrl(b.lon, b.lat, { sea });
  return (
    <aside class="bcard panel" aria-label={t('bld.title')}>
      <div class="bcard-head">
        <b>{t('bld.title')}</b>
        <button class="icon-btn" onClick={() => { S.pinnedBuilding.value = null; }} title={t('bld.close')} aria-label={t('bld.close')}><Icon name="close" size={12} /></button>
      </div>
      <p class="bcard-text">{b.text}</p>
      <p class="num muted bcard-pos">{b.lat.toFixed(5)}, {b.lon.toFixed(5)}</p>
      {(b.osm || b.gers) && (
        <p class="num muted bcard-ids">
          {b.osm && <a href={`https://www.openstreetmap.org/${b.osm[0] === 'r' ? 'relation' : 'way'}/${b.osm.slice(1)}`} target="_blank" rel="noopener" title={t('bld.osm.help')}>OSM {b.osm}</a>}
          {b.osm && b.gers && ' · '}
          {b.gers && <button class="id-btn" onClick={() => navigator.clipboard?.writeText(b.gers!).catch(() => {})} title={t('bld.gers.help')}><span>GERS {b.gers.slice(0, 8)}…</span><Icon name="copy" size={12} /></button>}
        </p>
      )}
      {mine && (
        <button class="btn" onClick={() => S.select(mine.id, { fly: false })}><Icon name="note" size={14} />{t('bld.records').replace('{n}', String(mine.props?.records ?? mine.allProps.find((x) => x.key === 'records')?.value ?? ''))}</button>
      )}
      {sv
        ? <a class="btn" href={sv} target="_blank" rel="noopener" title={t('bld.street.help')}><Icon name="external" size={14} />{t('bld.street')}{sea > 0.005 ? ` · +${sea.toFixed(1)} m` : ''}</a>
        : <p class="muted bcard-note">{t('bld.nostreet')}</p>}
    </aside>
  );
}
