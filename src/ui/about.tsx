// "About this twin": what Garita is, what in it is real and what is modelled, and how to move around.
// Opens from the wordmark, and once on a first visit (remembered in localStorage; never in automated screenshots).
import { useEffect } from 'preact/hooks';
import * as S from '../core/state';
import { tr } from '../i18n/index';
import { Icon, GaritaMark } from './icons';
import { aboutOpen } from './uistate';

const KEY = 'garita.about.seen.v1';
export function maybeShowAboutOnce() {
  try {
    if ((navigator as any).webdriver || /[?&](shot|about)=/.test(location.search)) return;
    if (localStorage.getItem(KEY)) return;
    localStorage.setItem(KEY, String(Date.now()));
    aboutOpen.value = true;
  } catch { /* storage blocked: stay quiet rather than nag on every load */ }
}

export function AboutSheet() {
  const close = () => { aboutOpen.value = false; };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  return (
    <div class="palette-scrim about-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="about panel" role="dialog" aria-modal="true" aria-label={tr('About this twin', 'Sobre este gemelo')}>
        <header class="about-head">
          <GaritaMark size={30} />
          <div><span class="wordmark">GARITA</span><p>{tr('A live digital twin of Puerto Rico for housing recovery and disaster response.', 'Un gemelo digital en vivo de Puerto Rico para recuperación de vivienda y respuesta a desastres.')}</p></div>
          <button class="icon-btn" onClick={close} aria-label={tr('Close', 'Cerrar')}><Icon name="close" size={14} /></button>
        </header>
        <div class="about-body">
          <p class="about-flag">{tr('Unofficial demonstrator. Not affiliated with or endorsed by the Puerto Rico Department of Housing, FEMA, HUD, NOAA or USGS. Do not use it to make safety decisions.', 'Demostración no oficial. Sin afiliación ni respaldo del Departamento de la Vivienda de Puerto Rico, FEMA, HUD, NOAA o USGS. No lo uses para tomar decisiones de seguridad.')}</p>
          <div class="about-cols">
            <section>
              <h3 class="label about-real">{tr('Real', 'Real')}</h3>
              <ul>
                <li>{tr('Terrain (USGS 3DEP) and aerial photo (USGS The National Map)', 'Terreno (USGS 3DEP) y foto aérea (USGS The National Map)')}</li>
                <li>{tr('Nearshore bathymetry (NOAA CUDEM)', 'Batimetría costera (NOAA CUDEM)')}</li>
                <li>{tr('Lidar ground elevation at every building (USGS 3DEP, 1 m)', 'Elevación lidar del terreno en cada edificio (USGS 3DEP, 1 m)')}</li>
                <li>{tr('Storm surge maps by hurricane category (NOAA NHC) and landslide susceptibility (USGS), with their publishers\' limits', 'Mapas de marejada por categoría de huracán (NOAA NHC) y susceptibilidad a deslizamientos (USGS), con los límites de sus publicadores')}</li>
                <li>{tr('Night lights from satellite (NASA VIIRS), one overpass a night', 'Luces nocturnas por satélite (NASA VIIRS), un paso por noche')}</li>
                <li>{tr('Building footprints (OpenStreetMap), FEMA flood insurance and recovery spending records', 'Huellas de edificios (OpenStreetMap), registros de seguro de inundación y de gasto de recuperación de FEMA')}</li>
                <li>{tr('Objects and properties from public sources, each with its source. Values Garita computed (ground elevation, flood zone, building counts) are marked "derived"', 'Objetos y propiedades de fuentes públicas, cada uno con su fuente. Los valores calculados por Garita (elevación del terreno, zona inundable, conteos de edificios) se marcan como "derivados"')}</li>
                <li>{tr('Live feeds (NWS, USGS, NOAA, FEMA, LUMA), shown with their age', 'Fuentes en vivo (SNM, USGS, NOAA, FEMA, LUMA), con su antigüedad')}</li>
              </ul>
            </section>
            <section>
              <h3 class="label about-model">{tr('Modelled or procedural', 'Modelado o procedural')}</h3>
              <ul>
                <li>{tr('Clouds and waves (driven by live wind and cloud cover)', 'Nubes y oleaje (según viento y nubosidad en vivo)')}</li>
                <li>{tr('Footprints detected from imagery where OpenStreetMap has none (Google, Microsoft via Overture Maps): detections, flagged as such', 'Huellas detectadas en imágenes donde OpenStreetMap no tiene (Google, Microsoft vía Overture Maps): detecciones, marcadas como tales')}</li>
                <li>{tr('Building heights where OpenStreetMap has none', 'Altura de edificios donde OpenStreetMap no la tiene')}</li>
                <li>{tr('Wall colours, windows and town lights', 'Colores de paredes, ventanas y luces de pueblos')}</li>
                <li>{tr('FEMA flood class, surge and landslide class read at one point per building and per facility (screening level)', 'Clase de inundación FEMA, marejada y clase de deslizamiento leídas en un punto por edificio y por instalación (nivel de cribado)')}</li>
                <li>{tr('The bathtub flood screen in the Scenario tab', 'El filtro de inundación tipo bañera en la pestaña Escenario')}</li>
              </ul>
            </section>
          </div>
          <section>
            <h3 class="label">{tr('Controls', 'Controles')}</h3>
            <dl class="about-keys">
              <div><dt>{tr('Drag', 'Arrastrar')}</dt><dd>{tr('pan', 'mover')}</dd></div>
              <div><dt>{tr('Right-drag or Ctrl-drag', 'Clic derecho o Ctrl + arrastrar')}</dt><dd>{tr('rotate and tilt', 'rotar e inclinar')}</dd></div>
              <div><dt>{tr('Wheel', 'Rueda')}</dt><dd>{tr('zoom to the cursor', 'acercar hacia el cursor')}</dd></div>
              <div><dt>{tr('Double-click', 'Doble clic')}</dt><dd>{tr('fly there', 'volar allí')}</dd></div>
              <div><dt class="num">{mac ? '⌘K' : 'Ctrl K'} / “/”</dt><dd>{tr('search', 'buscar')}</dd></div>
              <div><dt>{tr('Click anything', 'Clic en cualquier cosa')}</dt><dd>{tr('open it', 'abrirlo')}</dd></div>
            </dl>
          </section>
          <p class="muted">{tr('Buildings: © OpenStreetMap contributors, Overture Maps Foundation; Google Open Buildings, available under CC BY 4.0; Global ML Building Footprints, licensed by Microsoft under the Open Database License. Elevation, imagery, hazards and records: USGS, NOAA, NASA, FEMA, HUD, CDC, US Census (public domain).', 'Edificios: © colaboradores de OpenStreetMap, Overture Maps Foundation; Google Open Buildings, disponible bajo CC BY 4.0; Global ML Building Footprints, con licencia de Microsoft bajo la Open Database License. Elevación, imágenes, amenazas y registros: USGS, NOAA, NASA, FEMA, HUD, CDC, Censo de EE. UU. (dominio público).')}</p>
          <p class="muted">{tr('Heavy on older machines? Switch quality to Low (top right).', '¿Va lento en equipos viejos? Cambia la calidad a Baja (arriba a la derecha).')}</p>
        </div>
        <footer class="about-foot">
          <a href="https://github.com/webgpu-demos/garita" target="_blank" rel="noopener noreferrer"><Icon name="external" size={12} />github.com/webgpu-demos/garita</a>
          <button class="link-btn" onClick={() => { S.rightPanel.value = 'lineage'; close(); }}>{tr('Where every number comes from', 'De dónde sale cada número')}</button>
          <button class="btn primary" onClick={close}>{tr('Explore the island', 'Explorar la isla')}</button>
        </footer>
      </div>
    </div>
  );
}
