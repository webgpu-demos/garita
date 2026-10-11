// Layer rail: one button per ontology group, plus Scene and Overlays. A flyout lists the group's object types
// with switches bound to S.layerOn, live counts, and the type's colour and icon from the ontology.
import type { TwinStore, ObjectTypeDef } from '../ontology/types';
import * as S from '../core/state';
import { t, L } from '../i18n/index';
import { Icon } from './icons';
import { num, DASH } from './format';
import { railGroup, storeTick, useQuery, narrow, dockCollapsed } from './uistate';
import { OverlayOptions } from './hover';

const GROUPS: { id: string; icon: string }[] = [
  { id: 'hazards', icon: 'alert' }, { id: 'water', icon: 'drop' }, { id: 'housing', icon: 'housing' }, { id: 'infrastructure', icon: 'bolt' },
  { id: 'boundaries', icon: 'boundary' }, { id: 'atmosphere', icon: 'wind' }, { id: 'tracks', icon: 'plane' }, { id: 'records', icon: 'fema' },
];
const SCENE: S.SceneLayerId[] = ['buildings', 'clouds', 'labels', 'municipios', 'ocean_detail', 'markers'];
const OVERLAYS: (S.OverlayId)[] = [null, 'radar', 'goes', 'nightlights', 'nfhl', 'slr', 'surge', 'slide', 'choropleth', 'elevation'];

const setLayer = (id: string, on: boolean) => { S.layerOn.value = { ...S.layerOn.value, [id]: on }; };

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button class={'switch' + (on ? ' on' : '')} role="switch" aria-checked={on} aria-label={label} onClick={(e) => { e.stopPropagation(); onChange(!on); }}>
      <span class="switch-knob" />
    </button>
  );
}

function TypeRows({ types, counts }: { types: ObjectTypeDef[]; counts: Record<string, number> | undefined }) {
  const on = S.layerOn.value;
  const setAll = (v: boolean) => { const next = { ...S.layerOn.value }; for (const ty of types) next[ty.id] = v; S.layerOn.value = next; };
  return (
    <>
      <div class="fly-tools">
        <button class="link-btn" onClick={() => setAll(true)}>{t('rail.all_on')}</button>
        <button class="link-btn" onClick={() => setAll(false)}>{t('rail.all_off')}</button>
      </div>
      <ul class="fly-list">
        {types.map((ty) => {
          const isOn = !!on[ty.id];
          return (
            <li key={ty.id} class={'fly-row' + (isOn ? ' on' : '')} onClick={() => setLayer(ty.id, !isOn)}>
              <span class="type-badge" style={{ '--c': ty.color } as any}><Icon name={ty.icon} size={14} /></span>
              <span class="fly-name">{L(ty.plural)}</span>
              <span class="num fly-count">{counts ? num(counts[ty.id] ?? 0) : DASH}</span>
              <Switch on={isOn} onChange={(v) => setLayer(ty.id, v)} label={L(ty.plural)} />
            </li>
          );
        })}
      </ul>
      {types.some((ty) => ty.id === 'aircraft') && <p class="fly-help fly-note">{t('rail.note.aircraft')}</p>}
    </>
  );
}

function SceneRows() {
  const on = S.layerOn.value;
  return (
    <ul class="fly-list">
      {SCENE.map((id) => (
        <li key={id} class={'fly-row' + (on[id] ? ' on' : '')} onClick={() => setLayer(id, !on[id])}>
          <span class="fly-name">{t('scene.' + id)}</span>
          <Switch on={!!on[id]} onChange={(v) => setLayer(id, v)} label={t('scene.' + id)} />
        </li>
      ))}
    </ul>
  );
}

function OverlayRows({ store }: { store: TwinStore }) {
  const cur = S.overlay.value;
  const muni = store.ontology.objectTypes.find((x) => x.id === 'municipio');
  // Offer only properties that actually have values for municipios; fall back to every numeric one if the store cannot say.
  const avail = useQuery(async () => {
    try { const r = await store.query<{ key: string }>("SELECT key FROM prop WHERE object_id LIKE 'municipio:%' AND vtype = 'number' GROUP BY key"); return r.length ? new Set(r.map((x) => x.key)) : null; } catch { return null; }
  }, [storeTick.value]);
  const numeric = (muni?.properties ?? []).filter((p) => p.type === 'number' && (!avail || avail.has(p.id)));
  return (
    <>
      <p class="fly-help">{t('ov.one')}</p>
      <div class="fly-list" role="radiogroup" aria-label={t('grp.overlays')}>
        {OVERLAYS.map((id) => (
          <label key={String(id)} class={'fly-row radio-row' + (cur === id ? ' on' : '')}>
            <input type="radio" name="garita-overlay" checked={cur === id} onChange={() => { S.overlay.value = id; }} />
            <span class="radio-mark" />
            <span class="fly-name">{t('ov.' + (id ?? 'none'))}</span>
          </label>
        ))}
      </div>
      {cur === 'choropleth' && (
        <label class="field">
          <span class="label">{t('ov.property')}</span>
          <select value={S.choroplethProp.value} onChange={(e) => { S.choroplethProp.value = (e.target as HTMLSelectElement).value; }}>
            {numeric.map((p) => <option key={p.id} value={p.id}>{L(p.label)}</option>)}
          </select>
        </label>
      )}
      {(cur === 'surge' || cur === 'nightlights') && <div class="field"><OverlayOptions />{cur === 'nightlights' && <span class="fly-help">{t('ov.nl.baseline.help')}</span>}</div>}
      <label class={'field' + (cur == null ? ' is-disabled' : '')}>
        <span class="label">{t('ov.opacity')} <span class="num">{Math.round(S.overlayOpacity.value * 100)}%</span></span>
        <input type="range" min="0" max="1" step="0.05" disabled={cur == null} value={S.overlayOpacity.value}
          onInput={(e) => { S.overlayOpacity.value = +(e.target as HTMLInputElement).value; }} />
      </label>
    </>
  );
}

export function Rail({ store }: { store: TwinStore }) {
  const counts = useQuery(() => store.countByType(), [storeTick.value]);
  const open = railGroup.value;
  const on = S.layerOn.value;
  const byGroup = (g: string) => store.ontology.objectTypes.filter((x) => x.group === g);
  const toggle = (id: string) => { railGroup.value = open === id ? null : id; if (railGroup.value && narrow.value) dockCollapsed.value = true; };
  const groups = GROUPS.filter((g) => byGroup(g.id).length);
  const title = open ? t('grp.' + open) : '';
  return (
    <>
      <nav class="rail panel" aria-label={t('rail.layers')}>
        {groups.map((g) => {
          const active = byGroup(g.id).filter((x) => on[x.id]).length;
          return (
            <button key={g.id} class={'rail-btn' + (open === g.id ? ' open' : '')} aria-expanded={open === g.id} title={t('grp.' + g.id)} onClick={() => toggle(g.id)}>
              <Icon name={g.icon} size={18} />
              <span class="rail-cap">{t('grp.' + g.id)}</span>
              {active > 0 && <span class="num rail-n">{active}</span>}
            </button>
          );
        })}
        <span class="rail-sep" />
        <button class={'rail-btn' + (open === 'scene' ? ' open' : '')} aria-expanded={open === 'scene'} title={t('grp.scene')} onClick={() => toggle('scene')}>
          <Icon name="scene" size={18} /><span class="rail-cap">{t('grp.scene')}</span>
        </button>
        <button class={'rail-btn' + (open === 'overlays' ? ' open' : '')} aria-expanded={open === 'overlays'} title={t('grp.overlays')} onClick={() => toggle('overlays')}>
          <Icon name="overlay" size={18} /><span class="rail-cap">{t('grp.overlays')}</span>
          {S.overlay.value && <span class="rail-n rail-n-dot" />}
        </button>
      </nav>
      {open && (
        <aside class="flyout panel" aria-label={title}>
          <header class="fly-head">
            <span class="label">{t('rail.layers')}</span>
            <h2>{title}</h2>
            <button class="icon-btn" aria-label={t('dock.close')} onClick={() => { railGroup.value = null; }}><Icon name="close" size={14} /></button>
          </header>
          <div class="fly-body">
            {open === 'scene' ? <SceneRows /> : open === 'overlays' ? <OverlayRows store={store} /> : <TypeRows types={byGroup(open)} counts={counts} />}
          </div>
        </aside>
      )}
    </>
  );
}
