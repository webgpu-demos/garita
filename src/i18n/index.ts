// UI strings in English and Spanish as used in Puerto Rico. `t(key)` reads the language signal, so any
// component that calls it re-renders when the language changes. `L()` picks a side of an ontology label.
import { lang } from '../core/state';
import type { L10n } from '../ontology/types';

type Dict = Record<string, [en: string, es: string]>;

const D: Dict = {
  'app.subtitle': ['Puerto Rico digital twin · unofficial demo', 'Gemelo digital de Puerto Rico · demo no oficial'],
  'app.search': ['Search places, sensors, alerts', 'Buscar lugares, sensores, avisos'],
  'app.search.short': ['Search', 'Buscar'],
  'app.ast': ['AST', 'AST'],
  'app.lang': ['Language', 'Idioma'],
  'app.quality': ['Render quality', 'Calidad gráfica'],
  'q.low': ['Low', 'Baja'], 'q.medium': ['Med', 'Media'], 'q.high': ['High', 'Alta'],
  'feeds.chip': ['feeds', 'fuentes'],
  'feeds.sum': ['{ok} of {n} polled feeds on time', '{ok} de {n} fuentes sondeadas al día'],
  'feeds.failing': ['Failing', 'Fallando'], 'feeds.late': ['Late', 'Atrasadas'], 'feeds.waiting': ['Waiting for a first run', 'Esperan su primera corrida'],
  'feeds.ondemand': ['Not counted, {n} map tile services fetched only while their overlay is on', 'No se cuentan {n} servicios de teselas que se piden solo con su superposición encendida'],
  'feeds.none': ['No feed has reported yet', 'Ninguna fuente ha respondido aún'],

  // KPI strip
  'kpi.title': ['Island now', 'La isla ahora'],
  'kpi.alerts': ['Weather alerts', 'Avisos del tiempo'],
  'kpi.alerts.sub': ['active', 'vigentes'],
  'kpi.quakes': ['Earthquakes 24 h', 'Temblores 24 h'],
  'kpi.quakes.max': ['max', 'máx'],
  'kpi.gauges': ['Rivers at action stage', 'Ríos en etapa de acción'],
  'kpi.gauges.of': ['of', 'de'],
  'kpi.power': ['Customers without power', 'Clientes sin luz'],
  'kpi.tide': ['San Juan tide', 'Marea en San Juan'],
  'kpi.tide.vs': ['vs pred.', 'vs. pred.'],
  'kpi.wind': ['Wind', 'Viento'],
  'kpi.wind.from': ['from', 'del'],
  'kpi.cyclones': ['Tropical cyclones', 'Ciclones tropicales'],
  'kpi.cyclones.nearest': ['nearest', 'a'],
  'kpi.nodata': ['No reading yet', 'Sin lectura aún'],

  // rail
  'rail.layers': ['Layers', 'Capas'],
  'grp.hazards': ['Hazards', 'Peligros'], 'grp.water': ['Water', 'Agua'], 'grp.housing': ['Housing', 'Vivienda'],
  'grp.infrastructure': ['Infrastructure', 'Infraestructura'], 'grp.boundaries': ['Boundaries', 'Límites'],
  'grp.atmosphere': ['Atmosphere', 'Atmósfera'], 'grp.tracks': ['Tracks', 'Tráfico'], 'grp.records': ['Records', 'Registros'],
  'grp.scene': ['Scene', 'Escena'], 'grp.overlays': ['Overlays', 'Superposiciones'],
  'rail.all_on': ['All on', 'Todas'], 'rail.all_off': ['All off', 'Ninguna'],
  'rail.objects': ['objects', 'objetos'],
  'rail.note.aircraft': ['Aircraft positions are relayed every few minutes, not live: each mark is where the aircraft was, minutes ago. The dashed line and hollow ring are a projection along its last track. The age of each position is in its tooltip and panel, and beside the aircraft when you zoom in.', 'Las posiciones de aeronaves se relevan cada pocos minutos, no en vivo: cada marca es donde estaba la aeronave hace unos minutos. La línea de trazos y el anillo hueco son una proyección sobre su último rumbo. La edad de cada posición está en su etiqueta y su panel, y junto a la aeronave al acercarte.'],
  'ac.age': ['Position from', 'Posición de'],
  'ac.relayed': ['Relayed position, not live: where the aircraft was at {time} AST ({ago}).', 'Posición relevada, no en vivo: donde estaba la aeronave a las {time} AST ({ago}).'],
  'scene.buildings': ['Buildings', 'Edificios'], 'scene.clouds': ['Clouds', 'Nubes'], 'scene.labels': ['Place labels', 'Nombres de lugares'],
  'scene.municipios': ['Municipio outlines', 'Límites de municipios'], 'scene.ocean_detail': ['Ocean detail', 'Detalle del mar'], 'scene.markers': ['Markers', 'Marcadores'],
  'ov.none': ['None', 'Ninguna'], 'ov.radar': ['Radar (rain)', 'Radar (lluvia)'], 'ov.goes': ['GOES satellite', 'Satélite GOES'],
  'ov.nfhl': ['FEMA flood zones', 'Zonas inundables FEMA'], 'ov.slr': ['NOAA sea level rise inundation', 'Inundación por alza del mar (NOAA)'],
  'ov.choropleth': ['Choropleth by municipio', 'Coropleta por municipio'], 'ov.elevation': ['Elevation', 'Elevación'],
  'ov.nightlights': ['Night lights (NASA)', 'Luces nocturnas (NASA)'], 'ov.surge': ['Storm surge (NHC)', 'Marejada ciclónica (NHC)'],
  'ov.slide': ['Landslide susceptibility (USGS)', 'Susceptibilidad a deslizamientos (USGS)'],
  'ov.nl.baseline': ['2016 baseline (cloud-free composite)', 'Referencia 2016 (compuesto sin nubes)'],
  'ov.nl.baseline.help': ['Compare an outage or a recovery with normal lights.', 'Compare un apagón o una recuperación con las luces normales.'],
  'ov.surge.cat': ['Hurricane category', 'Categoría de huracán'],
  'ov.disclaimer': ['Use limits, from the publisher', 'Límites de uso, del publicador'],
  'rp.nl.show': ['Show night lights for this date', 'Mostrar luces nocturnas de esta fecha'],
  'rp.nl.hide': ['Hide night lights', 'Ocultar luces nocturnas'],
  'rp.nl.title': ['Night lights from space', 'Luces nocturnas desde el espacio'],
  'rp.nl.help': ['NASA satellite image of the night of the scene date (one overpass near 1:30 a.m.). Cloud and moonlight change what is seen; it is a picture, not a measure of outages. Compare with the 2016 baseline.', 'Imagen de satélite de la NASA de la noche de la fecha de la escena (una pasada cerca de la 1:30 a.m.). Las nubes y la luna cambian lo que se ve; es una imagen, no una medida de apagones. Compare con la referencia de 2016.'],
  'rp.nl.none': ['Daily night-light images start on 2012-03-01; none exists for this storm.', 'Las imágenes diarias de luces nocturnas empiezan el 2012-03-01; no hay para esta tormenta.'],
  'ov.opacity': ['Opacity', 'Opacidad'], 'ov.property': ['Property', 'Propiedad'],
  'ov.one': ['One overlay is draped on the terrain at a time.', 'Se muestra una superposición a la vez sobre el terreno.'],

  // dock
  'tab.alerts': ['Alerts', 'Avisos'], 'tab.object': ['Object', 'Objeto'], 'tab.explorer': ['Explorer', 'Explorador'], 'tab.lineage': ['Lineage', 'Procedencia'],
  'dock.collapse': ['Collapse panel', 'Contraer panel'], 'dock.expand': ['Expand panel', 'Expandir panel'], 'dock.close': ['Close panel', 'Cerrar panel'],

  'tab.scenario': ['Scenario', 'Escenario'], 'tab.replay': ['Replay', 'Repetición'], 'tab.graph': ['Graph', 'Grafo'], 'tab.sql': ['SQL', 'SQL'],
  'li.dataAt': ['Data as of', 'Datos al'], 'app.about': ['About this twin', 'Sobre este gemelo'],
  'sc.level': ['Water level above mean sea level', 'Nivel del agua sobre el nivel medio del mar'],
  'sc.manual': ['manual', 'manual'], 'sc.tide': ["Add today's tide at San Juan", 'Sumar la marea de hoy en San Juan'], 'sc.tide.short': ['tide', 'marea'],
  'sc.surge': ['What-if surge', 'Marejada hipotética'], 'sc.surge.label': ['what-if surge', 'marejada hipotética'],
  'sc.noaa': ['NOAA 2022 projections · San Juan · metres vs 2005', 'Proyecciones NOAA 2022 · San Juan · metros vs. 2005'],
  'sc.noaa.none': ['Projection file not available.', 'Archivo de proyecciones no disponible.'],
  'sc.noaa.note': ['Relative sea level change at tide station 9755371. Pick a cell to set the level.', 'Cambio relativo del nivel del mar en el mareógrafo 9755371. Escoge una celda para fijar el nivel.'],
  'sc.scenario': ['Scenario', 'Escenario'], 'sc.buildings': ['Buildings by ground elevation', 'Edificios por elevación del terreno'],
  'sc.atorbelow': ['buildings at or below', 'edificios en o bajo'], 'sc.below': ['buildings below', 'edificios bajo'],
  'sc.binned': ['counted at the 0.1 m step under the level', 'contados en el paso de 0.1 m bajo el nivel'],
  'sc.muni': ['Municipio · top 10', 'Municipio · primeros 10'], 'sc.count': ['Buildings', 'Edificios'], 'sc.share': ['Share', 'Parte'],
  'sc.nohist': ['No elevation histograms in the store yet.', 'Aún no hay histogramas de elevación en la base de datos.'],
  'sc.assets': ['Facilities with ground elevation', 'Instalaciones con elevación del terreno'], 'sc.units': ['units', 'unidades'], 'sc.residents': ['residents', 'residentes'],
  'sc.method': ['Method and caveats', 'Método y limitaciones'],
  'sc.method.body': ["Bathtub screen: the ground elevation at each building, from the USGS 1 m lidar elevation model (2024 collection, 2018 where it has gaps; median within 2 m of the footprint's centre; metres above the Puerto Rico Vertical Datum of 2002, which is local mean sea level), compared with a flat water level. It is the ground, not the floor. No waves, drainage, levees or connection to the sea: low ground the sea could not reach is counted too, and so are a few hundred buildings the lidar puts below zero (pits and depressions). On the map, land under the scenario's water level is washed blue; that wash follows the coarser 10 m terrain the scene is drawn with, so its edge can differ from the lidar counts by a street. Building counts: OpenStreetMap footprints, which are not complete everywhere. NOAA's connected-inundation mapping is the 'Sea level rise (NOAA)' overlay: compare the two.", "Filtro de bañera: la elevación del terreno en cada edificio, del modelo de elevación lidar de 1 m del USGS (colección de 2024, y la de 2018 donde hay huecos; mediana a 2 m del centro de la huella; metros sobre el Datum Vertical de Puerto Rico de 2002, que es el nivel medio del mar local), comparada con un nivel de agua plano. Es el terreno, no el piso. Sin oleaje, drenaje, diques ni conexión con el mar: también se cuenta terreno bajo al que el mar no llegaría, y unos cientos de edificios que el lidar sitúa bajo cero (hoyos y depresiones). En el mapa, el terreno bajo el nivel de agua del escenario se tiñe de azul; ese tinte sigue el terreno de 10 m con que se dibuja la escena, así que su borde puede diferir de los conteos lidar por una calle. Conteo de edificios: huellas de OpenStreetMap, que no están completas en todas partes. El mapa de inundación conectada de NOAA es la superposición 'Alza del mar (NOAA)': compara ambos."],
  'sc.overlay': ['Show NOAA sea level rise overlay', 'Mostrar superposición de alza del mar (NOAA)'],

  // alerts
  'al.title': ['Inbox', 'Bandeja'],
  'al.sec.weather': ['Weather watches and warnings', 'Vigilancias y avisos del tiempo'],
  'al.sec.cyclone': ['Tropical cyclones', 'Ciclones tropicales'],
  'al.sec.quake': ['Earthquakes M 3+ · last 7 days', 'Temblores M 3+ · últimos 7 días'],
  'al.sec.gauge': ['Rivers at or above action stage', 'Ríos en etapa de acción o más'],
  'al.sec.power': ['Power regions with 2% or more out', 'Regiones con 2% o más sin luz'],
  'al.empty.weather': ['No active watches or warnings for Puerto Rico from NWS San Juan.', 'No hay vigilancias ni avisos vigentes para Puerto Rico del SNM San Juan.'],
  'al.empty.cyclone': ['No active tropical cyclones reported by the National Hurricane Center.', 'El Centro Nacional de Huracanes no reporta ciclones tropicales activos.'],
  'al.empty.quake': ['No earthquakes of magnitude 3 or more near Puerto Rico in the last 7 days.', 'Ningún temblor de magnitud 3 o más cerca de Puerto Rico en los últimos 7 días.'],
  'al.empty.gauge': ['No river gauge is at or above its action stage.', 'Ningún río está en su etapa de acción o por encima.'],
  'al.empty.power': ['No LUMA region has 2% or more of customers without power.', 'Ninguna región de LUMA tiene 2% o más de clientes sin luz.'],
  'al.expired': ['Include expired, last 7 days', 'Incluir expirados, últimos 7 días'],
  'al.merged': ['By severity, then newest', 'Por severidad, luego más reciente'],
  'al.sections': ['What is watched', 'Qué se vigila'],
  'al.affects': ['municipios', 'municipios'], 'al.affects1': ['municipio', 'municipio'],
  'al.expires': ['until', 'hasta'], 'al.expiredAt': ['expired', 'expiró'],
  'al.count.none': ['Nothing needs attention right now', 'Nada requiere atención ahora'],
  'al.count': ['items', 'elementos'],
  'al.f.region': ['{name} region', 'Región de {name}'],
  'al.f.power': ['{n} customers without power ({pct} %)', '{n} clientes sin luz ({pct} %)'],
  'al.f.power.pct': ['{pct} % of customers without power', '{pct} % de los clientes sin luz'],
  'al.f.depth': ['{v} km deep', 'a {v} km de profundidad'],
  'al.f.wind': ['winds {v} kt', 'vientos de {v} kt'], 'al.f.pressure': ['pressure {v} hPa', 'presión {v} hPa'], 'al.f.dist': ['{v} km from Puerto Rico', 'a {v} km de Puerto Rico'],
  'al.f.cat.action': ['at action stage', 'en etapa de acción'], 'al.f.cat.minor': ['minor flooding', 'inundación menor'],
  'al.f.cat.moderate': ['moderate flooding', 'inundación moderada'], 'al.f.cat.major': ['major flooding', 'inundación mayor'],
  'al.f.stage': ['stage {v} m', 'nivel {v} m'], 'al.f.flow': ['flow {v} m³/s', 'caudal {v} m³/s'],

  // severity
  'sev.0': ['Info', 'Info'], 'sev.1': ['Minor', 'Menor'], 'sev.2': ['Moderate', 'Moderado'], 'sev.3': ['Severe', 'Severo'], 'sev.4': ['Extreme', 'Extremo'],

  // object
  'ob.none': ['Nothing selected', 'Nada seleccionado'],
  'ob.none.body': ['Pick a marker on the island, a row in the Explorer, or search with', 'Escoge un marcador en la isla, una fila del Explorador, o busca con'],
  'ob.missing': ['This object is no longer in the store.', 'Este objeto ya no está en la base de datos.'],
  'ob.loading': ['Loading', 'Cargando'],
  'ob.fly': ['Fly to', 'Volar a'], 'ob.copy': ['Copy id', 'Copiar id'], 'ob.copied': ['Copied', 'Copiado'],
  'ob.note': ['Add note', 'Añadir nota'], 'ob.status': ['Set status', 'Fijar estado'],
  'ob.street': ['Street view', 'Vista de calle'],
  'ob.street.help': ['Open this place at street level in procedural San Juan (the scenario sea level goes along)', 'Abrir este lugar a nivel de calle en procedural San Juan (con el nivel del mar del escenario)'],
  // building card (ui/building.tsx)
  'bld.title': ['Building', 'Edificio'],
  'bld.close': ['Close', 'Cerrar'],
  'bld.street': ['Street view', 'Vista de calle'],
  'bld.street.help': ['Open this building at street level in procedural San Juan (the scenario sea level goes along)', 'Abrir este edificio a nivel de calle en procedural San Juan (con el nivel del mar del escenario)'],
  'bld.nostreet': ['Street view covers the municipio of San Juan only.', 'La vista de calle cubre solo el municipio de San Juan.'],
  'bld.osm.help': ['This building in OpenStreetMap', 'Este edificio en OpenStreetMap'],
  'bld.gers.help': ['Copy its GERS id: Overture Maps\' stable id for this footprint, the key other data can join on', 'Copiar su id GERS: el id estable de Overture Maps para esta huella, la clave para unir otros datos'],
  'ob.note.ph': ['What did you see or decide?', '¿Qué viste o decidiste?'],
  'ob.status.ph': ['e.g. inspected, closed, needs visit', 'p. ej. inspeccionado, cerrado, requiere visita'],
  'ob.save': ['Save', 'Guardar'], 'ob.cancel': ['Cancel', 'Cancelar'],
  'ob.key': ['Key facts', 'Datos clave'], 'ob.trend': ['Last 72 hours', 'Últimas 72 horas'],
  'ob.all': ['All properties', 'Todas las propiedades'], 'ob.links': ['Links', 'Vínculos'], 'ob.ids': ['Identities', 'Identidades'],
  'ob.notes': ['Your notes', 'Tus notas'], 'ob.audit': ['Audit log', 'Bitácora'],
  'ob.prop': ['Property', 'Propiedad'], 'ob.value': ['Value', 'Valor'], 'ob.source': ['Source', 'Fuente'], 'ob.observed': ['Observed', 'Observado'],
  'ob.best': ['best', 'mejor'], 'ob.disagree': ['Sources disagree', 'Las fuentes difieren'],
  'ob.noloc': ['Area or record · no single point', 'Área o registro · sin punto único'],
  'ob.geom': ['geometry', 'geometría'],
  'ob.nolinks': ['No links recorded for this object.', 'No hay vínculos registrados para este objeto.'],
  'ob.noprops': ['No properties recorded.', 'Sin propiedades registradas.'],
  'ob.noseries': ['No observations in the last 72 hours.', 'Sin observaciones en las últimas 72 horas.'],
  'ob.min': ['min', 'mín'], 'ob.max': ['max', 'máx'], 'ob.last': ['last', 'últ.'],
  'ob.first': ['First seen', 'Visto por primera vez'], 'ob.updated': ['Updated', 'Actualizado'], 'ob.createdby': ['Created by', 'Creado por'],
  'ob.valid': ['Valid', 'Vigencia'],
  'ob.more': ['more', 'más'],
  'ob.usernote': ['Saved in this browser only. Source: user.', 'Guardado solo en este navegador. Fuente: usuario.'],

  // explorer
  'ex.type': ['Object type', 'Tipo de objeto'], 'ex.filter': ['Filter rows', 'Filtrar filas'], 'ex.name': ['Name', 'Nombre'],
  'ex.rows': ['rows', 'filas'], 'ex.showing': ['Showing', 'Mostrando'], 'ex.of': ['of', 'de'],
  'ex.empty': ['No objects of this type in the store yet.', 'Aún no hay objetos de este tipo en la base de datos.'],
  'ex.nomatch': ['No row matches the filter.', 'Ninguna fila coincide con el filtro.'],
  'ex.expired': ['Include expired', 'Incluir expirados'],
  'ex.status': ['Status', 'Estado'],

  // lineage
  'li.title': ['Where every number comes from', 'De dónde sale cada número'],
  'li.lead': ['Each value in Garita keeps the source that reported it and when. Nothing is entered by hand except your own notes.', 'Cada valor en Garita guarda la fuente que lo reportó y cuándo. Nada se entra a mano excepto tus notas.'],
  'li.kind.live': ['Live · fetched by this browser', 'En vivo · las busca este navegador'],
  'li.kind.relay': ['Relay · relayed about every 5 minutes by a scheduled job', 'Relevo · una tarea programada las copia cada 5 minutos aprox.'],
  'li.kind.baked': ['Baked · compiled into the seed database', 'Compiladas · incluidas en la base inicial'],
  'li.kind.derived': ['Derived · computed by Garita', 'Derivadas · calculadas por Garita'],
  'li.kind.user': ['User · written in this browser', 'Usuario · escritas en este navegador'],
  'li.licence': ['Licence', 'Licencia'], 'li.cadence': ['Expected every', 'Se espera cada'], 'li.last': ['Last run', 'Última corrida'],
  'li.objects': ['Objects', 'Objetos'], 'li.never': ['not run yet', 'aún sin correr'], 'li.open': ['Open source page', 'Abrir página de la fuente'],
  'li.ok': ['on time', 'al día'], 'li.stale': ['late', 'atrasada'], 'li.error': ['failing', 'fallando'], 'li.static': ['static', 'estática'], 'li.unknown': ['no run yet', 'sin corrida'],
  'li.obs': ['observations', 'observaciones'],
  'li.feeds': ['Feeds now', 'Fuentes ahora'],
  'li.ondemand': ['on demand', 'bajo demanda'],
  'li.ondemand.note': ['Map tiles this browser fetches only while the “{ov}” overlay is on ({state}). Not polled, so there is no run to report and it is not in the feed count.', 'Teselas que este navegador pide solo con la superposición «{ov}» encendida ({state}). No se sondea: no hay corrida que reportar ni entra en el conteo de fuentes.'],
  'li.ov.on': ['on now', 'encendida ahora'], 'li.ov.off': ['off now', 'apagada ahora'],

  // bottom bar
  'bb.cursor': ['Cursor', 'Cursor'], 'bb.elev': ['Elev', 'Elev'], 'bb.depth': ['Depth', 'Prof'], 'bb.cam': ['Eye alt', 'Altura'],
  'bb.fps': ['fps', 'fps'], 'bb.tiles': ['tiles', 'teselas'],
  'bb.nocursor': ['Move over the island', 'Mueve el cursor sobre la isla'],
  'bb.live': ['Live', 'En vivo'], 'bb.play': ['Play', 'Reproducir'], 'bb.pause': ['Pause', 'Pausa'],
  'bb.rate': ['Playback rate', 'Velocidad'], 'bb.scrub': ['Time of day (AST)', 'Hora del día (AST)'],
  'bb.sunrise': ['Sunrise', 'Salida del sol'], 'bb.sunset': ['Sunset', 'Puesta del sol'], 'bb.sanjuan': ['San Juan', 'San Juan'],
  'bb.scene': ['Scene time', 'Hora de la escena'],
  'bb.attrib.title': ['Open data lineage', 'Abrir procedencia de datos'],

  // search
  'se.ph': ['Name, id, or "18.46, -66.10"', 'Nombre, id, o "18.46, -66.10"'],
  'se.hint': ['Type to search every object in the twin. Enter selects and flies there.', 'Escribe para buscar en todos los objetos del gemelo. Enter selecciona y vuela allí.'],
  'se.none': ['Nothing matches', 'Nada coincide con'],
  'se.coord': ['Fly to coordinates', 'Volar a coordenadas'],
  'se.keys': ['↑↓ move · Enter open · Esc close', '↑↓ mover · Enter abrir · Esc cerrar'],
  'se.outside': ['Outside the Puerto Rico area', 'Fuera del área de Puerto Rico'],

  // toasts / time
  'toast.new': ['New', 'Nuevo'], 'toast.dismiss': ['Dismiss', 'Descartar'],
  'ago.now': ['just now', 'ahora'], 'ago.min': ['min ago', 'min'], 'ago.h': ['h ago', 'h'], 'ago.d': ['d ago', 'd'], 'ago.pre': ['', 'hace '],
  'in.pre': ['in ', 'en '],
  'yes': ['Yes', 'Sí'], 'no': ['No', 'No'],
};

export function t(key: string): string {
  const e = D[key];
  if (!e) return key;
  return lang.value === 'es' ? e[1] : e[0];
}
/** Inline bilingual string for copy used in one place. */
export function tr(en: string, es: string): string { return lang.value === 'es' ? es : en; }
export function L(l: L10n | undefined | null): string {
  if (!l) return '';
  return (lang.value === 'es' ? l.es : l.en) || l.en || '';
}
export const locale = () => (lang.value === 'es' ? 'es-PR' : 'en-US');
