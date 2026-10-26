// The intro: the narrated walkthrough (docs/video/) played over the app as it starts, with Skip intro.
// Plain DOM, so it can open before the store and the UI have loaded; the app boots underneath while it plays.
//
// When it plays by itself: on a browser's first plain visit (remembered in localStorage). Not for a shared deep link
// (?select= ?cam= ?overlay= …: the link should land where it points), not with ?ui=0, and never in automated renders
// (?shot ?video, webdriver). ?intro=1 forces it, ?intro=0 turns it off. It can be watched again from About.
//
// Browsers only autoplay muted video: sound is tried first and, when refused, it plays muted (the captions are burned
// in) with a Sound on button. With reduced motion or Save-Data it opens paused on its first frame instead.
// The media files live on the gh-pages branch under media/ (published by tools/publish-intro.sh), not in the bundle.
import { signal } from '@preact/signals';
import { dataUrl, params } from '../core/config';
import { tr } from '../i18n/index';

const VERSION = '20261012';
const SEEN_KEY = 'garita.intro.seen.v1';
export const introOpen = signal(false);
/** True once the intro has opened by itself during this page load (the About sheet then stays closed). */
export let introShownThisLoad = false;

const DEEP_LINK = ['select', 'cam', 'overlay', 'sea', 't', 'panel', 'surge', 'nl', 'q', 'pick'];
const ICON = {
  play: '<path d="M4.5 3v10l8.5-5z" fill="currentColor"/>',
  pause: '<path d="M5 3v10M11 3v10" stroke="currentColor" stroke-width="2"/>',
  muted: '<path d="M2 6h2.5L8 3v10L4.5 10H2z" fill="currentColor"/><path d="M10.5 6l4 4M14.5 6l-4 4" stroke="currentColor" stroke-width="1.4"/>',
  sound: '<path d="M2 6h2.5L8 3v10L4.5 10H2z" fill="currentColor"/><path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.3 3.6a6 6 0 0 1 0 8.8" stroke="currentColor" stroke-width="1.3" fill="none"/>',
  next: '<path d="M3 3v10l7-5zM12 3v10" stroke="currentColor" stroke-width="1.6" fill="currentColor"/>',
};
const svg = (name: keyof typeof ICON, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true" fill="none">${ICON[name]}</svg>`;
const mmss = (s: number) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '–:––');

function automated(): boolean {
  return !!(navigator as any).webdriver || /[?&](shot|video)=/.test(location.search);
}

/** Opens the intro if this is a plain first visit. Call once, early, from the site's entry point. */
export function maybePlayIntro(): boolean {
  const force = params.get('intro');
  if (force === '0') return false;
  if (force !== '1') {
    if (automated() || params.get('ui') === '0' || DEEP_LINK.some((k) => params.has(k))) return false;
    try { if (localStorage.getItem(SEEN_KEY)) return false; localStorage.setItem(SEEN_KEY, String(Date.now())); }
    catch { return false; }      // storage blocked: stay quiet rather than replay on every load
  }
  introShownThisLoad = true;
  openIntro({ auto: true });
  return true;
}

/** Plays the intro: with sound where the browser allows it (always after a click, as from About), else muted. */
export function openIntro(opts: { auto?: boolean } = {}) {
  if (introOpen.value) return;
  introOpen.value = true;
  const g = globalThis as any;
  const conn = (navigator as any).connection;
  const saveData = !!conn?.saveData;
  const reduced = matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const big = Math.max(innerWidth, innerHeight) * (devicePixelRatio || 1) >= 1500 && !saveData && !/(^|-)(2g|3g)$/.test(conn?.effectiveType ?? '');
  const holdStill = opts.auto && (reduced || saveData);

  const root = document.createElement('div');
  root.className = 'intro';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', tr('Introduction video', 'Video de introducción'));
  root.innerHTML = `
    <video class="intro-video" playsinline preload="${holdStill ? 'metadata' : 'auto'}" poster="${dataUrl(`media/garita-intro-${VERSION}-poster.jpg`)}"></video>
    <button class="intro-big" hidden>${svg('play', 22)}<span>${tr('Play the intro', 'Ver la introducción (en inglés)')}</span><i class="num">3:22</i></button>
    <div class="intro-top">
      <button class="intro-btn intro-sound"></button>
      <button class="intro-btn intro-pp"></button>
    </div>
    <button class="intro-skip">${tr('Skip intro', 'Saltar intro')}${svg('next', 13)}</button>
    <div class="intro-seek">
      <span class="num intro-time">0:00</span>
      <input type="range" min="0" max="1000" step="1" value="0" aria-label="${tr('Position in the video', 'Posición en el video')}">
      <span class="num intro-dur">3:22</span>
    </div>`;
  const v = root.querySelector('video')!;
  const big$ = root.querySelector<HTMLButtonElement>('.intro-big')!;
  const sound$ = root.querySelector<HTMLButtonElement>('.intro-sound')!;
  const pp$ = root.querySelector<HTMLButtonElement>('.intro-pp')!;
  const skip$ = root.querySelector<HTMLButtonElement>('.intro-skip')!;
  const seek$ = root.querySelector<HTMLInputElement>('.intro-seek input')!;
  const time$ = root.querySelector<HTMLElement>('.intro-time')!;
  const dur$ = root.querySelector<HTMLElement>('.intro-dur')!;

  const paint = () => {
    const playing = !v.paused && !v.ended;
    pp$.innerHTML = svg(playing ? 'pause' : 'play', 14);
    pp$.setAttribute('aria-label', playing ? tr('Pause', 'Pausa') : tr('Play', 'Reproducir'));
    sound$.innerHTML = `${svg(v.muted ? 'muted' : 'sound', 15)}<span>${v.muted ? tr('Sound on', 'Activar sonido') : tr('Mute', 'Silenciar')}</span>`;
    sound$.classList.toggle('is-muted', v.muted);
    big$.hidden = playing || v.currentTime > 0.2;
    root.classList.toggle('is-paused', !playing);
  };
  const tick = () => {
    if (!dragging && v.duration) seek$.value = String(Math.round((v.currentTime / v.duration) * 1000));
    time$.textContent = mmss(v.currentTime);
  };
  let dragging = false;

  const start = async (withSound: boolean) => {
    v.muted = !withSound;
    try { await v.play(); }
    catch (e: any) {
      if (e?.name === 'NotAllowedError' && withSound) {       // sound refused without a click: play muted instead
        v.muted = true;
        try { await v.play(); } catch { /* even muted autoplay refused (power saving): wait for a click */ }
      }
    }
    paint();
  };

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    g.__garitaSkipDraw = false;          // the scene draws again as the curtain fades
    removeEventListener('keydown', onKey, true);
    removeEventListener('keyup', onKeyUp, true);
    root.classList.add('is-leaving');
    v.pause();
    setTimeout(() => {
      v.removeAttribute('src'); v.load();
      root.remove();
      introOpen.value = false;
      (document.getElementById('scene') as HTMLElement | null)?.focus({ preventScroll: true });
    }, 650);
  };
  const toggle = () => { if (v.paused || v.ended) void start(!v.muted); else v.pause(); };

  // Keys while the intro is up go to it, not to the camera or the search palette underneath.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Tab') {
      const f = [...root.querySelectorAll<HTMLElement>('button:not([hidden]), input')];
      const i = f.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) { f[f.length - 1]?.focus(); e.preventDefault(); }
      else if (!e.shiftKey && i === f.length - 1) { f[0]?.focus(); e.preventDefault(); }
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    const k = e.key.toLowerCase();
    if (k === 'escape') { e.preventDefault(); close(); }
    else if (k === ' ' || k === 'k') { e.preventDefault(); if (!e.repeat) toggle(); }      // Space is play/pause even on a focused button
    else if (k === 'm') { e.preventDefault(); v.muted = !v.muted; paint(); }
    else if (k === 'arrowright' || k === 'arrowleft') { if (e.target !== seek$) { e.preventDefault(); v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + (k === 'arrowright' ? 5 : -5))); } }
  };
  // (a button activates on Space's keyup: swallow it so Space never also presses the focused button)
  const onKeyUp = (e: KeyboardEvent) => { e.stopPropagation(); if (e.key === ' ') e.preventDefault(); };
  addEventListener('keydown', onKey, true);
  addEventListener('keyup', onKeyUp, true);

  skip$.addEventListener('click', close);
  sound$.addEventListener('click', () => { v.muted = !v.muted; if (v.paused && !v.muted) void start(true); paint(); });
  pp$.addEventListener('click', () => { toggle(); });
  big$.addEventListener('click', () => { skip$.focus({ preventScroll: true }); void start(true); });
  v.addEventListener('click', () => { toggle(); });
  seek$.addEventListener('input', () => { dragging = true; if (v.duration) { v.currentTime = (+seek$.value / 1000) * v.duration; time$.textContent = mmss(v.currentTime); } });
  seek$.addEventListener('change', () => { dragging = false; });
  for (const ev of ['play', 'pause', 'volumechange', 'playing']) v.addEventListener(ev, paint);
  v.addEventListener('timeupdate', tick);
  v.addEventListener('loadedmetadata', () => { dur$.textContent = mmss(v.duration); });
  v.addEventListener('ended', close);
  // A file that will not load must not leave a black screen over the app. Next visit tries again.
  v.addEventListener('error', () => { try { localStorage.removeItem(SEEN_KEY); } catch { /* ignore */ } close(); });

  v.src = dataUrl(`media/garita-intro-${VERSION}-${big ? 1080 : 720}.mp4`);
  document.body.appendChild(root);
  // The scene is hidden while the intro covers it: keep loading tiles, skip the drawing.
  g.__garitaSkipDraw = true;
  paint();
  requestAnimationFrame(() => root.classList.add('is-in'));
  skip$.focus({ preventScroll: true });
  if (!holdStill) void start(true);
}
