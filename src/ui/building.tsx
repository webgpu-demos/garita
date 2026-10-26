// The building card: a building clicked in the scene, or named by ?pick=lon,lat (world/buildings pins it). Buildings
// are tile records, not store objects, so this is not the object view: what the tile says, where it stands, and the
// way down to street level where the street view covers it (core/streetview.ts).
import * as S from '../core/state';
import { t } from '../i18n/index';
import { Icon } from './icons';
import { streetViewUrl } from '../core/streetview';

export function BuildingCard() {
  const b = S.pinnedBuilding.value;
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
      {sv
        ? <a class="btn" href={sv} target="_blank" rel="noopener" title={t('bld.street.help')}><Icon name="external" size={14} />{t('bld.street')}{sea > 0.005 ? ` · +${sea.toFixed(1)} m` : ''}</a>
        : <p class="muted bcard-note">{t('bld.nostreet')}</p>}
    </aside>
  );
}
