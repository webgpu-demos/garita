// Right dock. Tabs are registered in ONE array: to add a panel (Scenario, Graph, SQL), write
// `src/ui/panels/<name>.tsx` exporting a component that takes `{ store }`, and add a line to TABS below.
// `id` must be a value of S.RightPanel in core/state.ts ('scenario', 'graph' and 'sql' are already reserved there).
import type { ComponentType } from 'preact';
import type { TwinStore } from '../ontology/types';
import * as S from '../core/state';
import { t } from '../i18n/index';
import { Icon } from './icons';
import { dockCollapsed, narrow, sheetVh, railGroup } from './uistate';
import { AlertsPanel } from './panels/alerts';
import { ObjectPanel } from './panels/object';
import { ExplorerPanel } from './panels/explorer';
import { LineagePanel } from './panels/lineage';
import { ScenarioPanel } from './panels/scenario';
import { ReplayPanel } from './panels/replay';
import { GraphPanel } from './panels/graph';
import { SqlPanel } from './panels/sql';
import { LocalPanel } from './panels/local';

export interface DockTab {
  /** A value of S.RightPanel; 'replay' is not in that union yet, hence the plain string. */
  id: string;
  /** i18n key, or a literal label. */
  label: string;
  icon: string;
  component: ComponentType<{ store: TwinStore }>;
}
export const TABS: DockTab[] = [
  { id: 'alerts', label: 'tab.alerts', icon: 'inbox', component: AlertsPanel },
  { id: 'object', label: 'tab.object', icon: 'object', component: ObjectPanel },
  { id: 'scenario', label: 'tab.scenario', icon: 'wave', component: ScenarioPanel },
  { id: 'replay', label: 'tab.replay', icon: 'replay', component: ReplayPanel },
  { id: 'graph', label: 'tab.graph', icon: 'graph', component: GraphPanel },
  { id: 'explorer', label: 'tab.explorer', icon: 'table', component: ExplorerPanel },
  { id: 'lineage', label: 'tab.lineage', icon: 'lineage', component: LineagePanel },
  { id: 'sql', label: 'tab.sql', icon: 'sql', component: SqlPanel },
  { id: 'local', label: 'tab.local', icon: 'note', component: LocalPanel },
];
export function registerTab(tab: DockTab) { if (!TABS.some((x) => x.id === tab.id)) TABS.push(tab); }

/** Narrow layout: drag the grip to resize the bottom sheet; dragging it to the floor folds it. */
function onGrip(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  const startY = e.clientY, start = dockCollapsed.value ? 6 : sheetVh.value;
  const move = (ev: PointerEvent) => {
    const d = ((startY - ev.clientY) / window.innerHeight) * 100;
    if (Math.abs(d) < 0.6) return;
    sheetVh.value = Math.max(12, Math.min(78, start + d));
    dockCollapsed.value = false;
    if (!S.rightPanel.value) S.rightPanel.value = 'alerts';
  };
  const up = () => {
    el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
    if (sheetVh.value < 20) { dockCollapsed.value = true; sheetVh.value = 46; }
  };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}

export function Dock({ store }: { store: TwinStore }) {
  const cur = S.rightPanel.value;
  const tab = TABS.find((x) => x.id === cur);
  const collapsed = dockCollapsed.value || !tab;
  const pick = (id: DockTab['id']) => {
    if (cur === id && !dockCollapsed.value) { if (narrow.value) dockCollapsed.value = true; else S.rightPanel.value = null; return; }
    S.rightPanel.value = id as any; dockCollapsed.value = false;
    if (narrow.value) railGroup.value = null;      // sheet and flyout share the narrow screen: one at a time
  };
  const Body = tab?.component;
  return (
    <aside class={'dock panel' + (collapsed ? ' is-collapsed' : '')} aria-label={tab ? t(tab.label) : 'Panels'}
      style={narrow.value && !collapsed ? { height: `${sheetVh.value}vh` } : undefined}>
      <div class="dock-grip" onPointerDown={onGrip} aria-hidden="true"><span /></div>
      <div class="dock-tabs" role="tablist">
        {TABS.map((x) => (
          <button key={x.id} role="tab" aria-selected={cur === x.id && !collapsed} title={t(x.label)} aria-label={t(x.label)} class={'dock-tab' + (cur === x.id && !collapsed ? ' on' : '')} onClick={() => pick(x.id)}>
            <Icon name={x.icon} size={15} />
            <span>{t(x.label)}</span>
          </button>
        ))}
        <span class="dock-tabs-fill" />
        <button class="icon-btn dock-fold" aria-label={collapsed ? t('dock.expand') : t('dock.collapse')} title={collapsed ? t('dock.expand') : t('dock.collapse')}
          onClick={() => { if (!tab) { S.rightPanel.value = 'alerts'; dockCollapsed.value = false; } else dockCollapsed.value = !dockCollapsed.value; }}>
          <Icon name={collapsed ? 'chevUp' : 'chevDown'} size={14} />
        </button>
      </div>
      {!collapsed && Body && <div class="dock-body" role="tabpanel"><Body store={store} /></div>}
    </aside>
  );
}
