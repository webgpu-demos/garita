// The operations UI: instruments laid over the 3D island. `mountUI(root, { store })` returns an unmount function.
// The root is a fixed, full-viewport, pointer-events:none container; each panel opts back in to pointer events.
import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import type { TwinStore } from '../ontology/types';
import * as S from '../core/state';
import './tokens.css';
import './ui.css';
import { effect } from '@preact/signals';
import { bindStore, storeTick, nowTick, narrow, paletteOpen, railGroup, dockCollapsed, sheetVh, aboutOpen } from './uistate';
import { TopBar } from './topbar';
import { KpiStrip } from './kpi';
import { Rail } from './rail';
import { Dock } from './dock';
import { BottomBar } from './bottombar';
import { SearchPalette } from './search';
import { Toasts } from './toasts';
import { HoverTip, LegendCard } from './hover';
import { BuildingCard } from './building';
import { AboutSheet, maybeShowAboutOnce } from './about';

function App({ store }: { store: TwinStore }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); paletteOpen.value = !paletteOpen.value; }
      else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); paletteOpen.value = true; }
      else if (e.key === 'Escape') {
        if (paletteOpen.value) paletteOpen.value = false;
        else if (railGroup.value) railGroup.value = null;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div class={'garita' + (narrow.value ? ' is-narrow' : '')} lang={S.lang.value}>
      <TopBar store={store} />
      <KpiStrip store={store} />
      <Rail store={store} />
      <Dock store={store} />
      <BottomBar />
      <Toasts store={store} />
      <LegendCard />
      <BuildingCard />
      <HoverTip store={store} />
      {paletteOpen.value && <SearchPalette store={store} />}
      {aboutOpen.value && <AboutSheet />}
    </div>
  );
}

export function mountUI(root: HTMLElement, deps: { store: TwinStore }): () => void {
  const { store } = deps;
  bindStore(store);

  // One debounced tick for every panel: a burst of ingests re-queries once.
  let timer: any = 0;
  const offChange = store.onChange(() => { if (!timer) timer = setTimeout(() => { timer = 0; storeTick.value++; }, 300); });
  store.ready.then(() => { storeTick.value++; }).catch(() => {});
  const clock = setInterval(() => { nowTick.value = Date.now(); }, 30e3);

  const mq = window.matchMedia('(max-width: 760px)');
  const onMq = () => { narrow.value = mq.matches; };
  onMq(); mq.addEventListener('change', onMq);

  render(<App store={store} />, root);

  // Tell the camera how much of the viewport the panels cover, measured from the real rectangles.
  const measure = () => {
    const q = (sel: string) => root.querySelector(sel)?.getBoundingClientRect();
    const W = window.innerWidth, H = window.innerHeight;
    const top = q('.topbar'), kpi = q('.kpis'), rail = q('.rail'), dock = q('.dock'), bottom = q('.bottombar');
    const pad = { left: 0, right: 0, top: Math.round(Math.max(top?.bottom ?? 0, kpi?.bottom ?? 0)), bottom: Math.round(bottom ? H - bottom.top : 0) };
    if (narrow.value) { if (rail) pad.top = Math.round(Math.max(pad.top, rail.bottom)); if (dock) pad.bottom = Math.round(Math.max(pad.bottom, H - dock.top)); }
    else { if (rail) pad.left = Math.round(rail.right); if (dock && dock.height > 80) pad.right = Math.round(W - dock.left); }
    // The same rectangles position the flyout and toasts, so a KPI strip that wraps to two rows pushes them down.
    root.style.setProperty('--kpi-bottom', `${Math.round(kpi?.bottom ?? 0)}px`);
    root.style.setProperty('--rail-bottom', `${Math.round(rail?.bottom ?? 0)}px`);
    root.style.setProperty('--dock-top', `${Math.round(dock?.top ?? H)}px`);
    const cur = S.viewPadding.peek();
    if (cur.left !== pad.left || cur.right !== pad.right || cur.top !== pad.top || cur.bottom !== pad.bottom) S.viewPadding.value = pad;
  };
  const offPad = effect(() => { void S.rightPanel.value; void dockCollapsed.value; void narrow.value; void sheetVh.value; requestAnimationFrame(measure); });
  window.addEventListener('resize', measure);
  const ro = new ResizeObserver(() => measure());
  for (const sel of ['.kpis', '.dock', '.rail']) { const el = root.querySelector(sel); if (el) ro.observe(el); }
  maybeShowAboutOnce();
  return () => {
    offPad(); ro.disconnect(); window.removeEventListener('resize', measure);
    offChange(); clearInterval(clock); clearTimeout(timer); mq.removeEventListener('change', onMq);
    render(null, root);
  };
}
