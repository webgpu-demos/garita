// Saved queries for the SQL console. Every one of these was run against the published seed (data/twin.db) through
// the Node store before it was added. Keep them answering a question an analyst would actually ask.
export interface SavedQuery { id: string; title: [en: string, es: string]; sql: string }

const SFHA = "(z.value LIKE 'A%' OR z.value LIKE 'V%')";

export const SAVED_QUERIES: SavedQuery[] = [
  { id: 'ph_by_muni', title: ['Public housing by municipio, share of developments in the FEMA 1% flood zone', 'Vivienda pública por municipio, parte de los residenciales en la zona inundable FEMA 1%'], sql:
`-- Public housing developments and units by municipio; share of developments whose point falls in an A or V zone
SELECT m.value AS municipio, COUNT(*) AS developments, SUM(u.value) AS units,
       SUM(CASE WHEN ${SFHA} THEN 1 ELSE 0 END) AS in_flood_zone,
       ROUND(100.0 * SUM(CASE WHEN ${SFHA} THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_in_flood_zone,
       SUM(CASE WHEN ${SFHA} THEN u.value ELSE 0 END) AS units_in_flood_zone,
       SUM(CASE WHEN z.value IS NULL THEN 1 ELSE 0 END) AS not_assessed   -- point is approximate: no zone derived
FROM object o
LEFT JOIN prop_best m ON m.object_id = o.id AND m.key = 'municipio_name'
LEFT JOIN prop_best u ON u.object_id = o.id AND u.key = 'units'
LEFT JOIN prop_best z ON z.object_id = o.id AND z.key = 'flood_zone'
WHERE o.type = 'public_housing' AND o.expired = 0
GROUP BY m.value ORDER BY units DESC` },
  { id: 'shelters_3m', title: ['Shelters with ground at or below 3 m', 'Refugios con terreno en o bajo 3 m'], sql:
`-- Listed shelters whose ground elevation (1 m lidar at the shelter's point; shelters without a location are not included) is at or below 3 m
SELECT o.id, o.name, m.value AS municipio, e.value AS ground_elev_m, z.value AS flood_zone, c.value AS capacity
FROM object o
JOIN prop_best e ON e.object_id = o.id AND e.key = 'ground_elev_m'
LEFT JOIN prop_best m ON m.object_id = o.id AND m.key = 'municipio_name'
LEFT JOIN prop_best z ON z.object_id = o.id AND z.key = 'flood_zone'
LEFT JOIN prop_best c ON c.object_id = o.id AND c.key = 'capacity'
WHERE o.type = 'shelter' AND o.expired = 0 AND e.value <= 3
ORDER BY e.value, o.name` },
  { id: 'surge_assets', title: ['Shelters, housing and hospitals inside the mapped storm surge area, by hurricane category', 'Refugios, vivienda y hospitales dentro del área de marejada cartografiada, por categoría de huracán'], sql:
`-- NOAA storm surge risk map (2018, high tide) at each asset's point. Awareness only: NOAA says the map is not for
-- parcel-level assessment and does not replace evacuation zones. "Lowest category" = the weakest hurricane whose map reaches the point.
SELECT o.type, o.name, m.value AS municipio, c.value AS lowest_category, d.value AS mapped_depth_by_category, e.value AS ground_elev_m
FROM object o
JOIN prop_best c ON c.object_id = o.id AND c.key = 'surge_category'
LEFT JOIN prop_best d ON d.object_id = o.id AND d.key = 'surge_by_category'
LEFT JOIN prop_best e ON e.object_id = o.id AND e.key = 'ground_elev_m'
LEFT JOIN prop_best m ON m.object_id = o.id AND m.key = 'municipio_name'
WHERE o.type IN ('shelter', 'public_housing', 'assisted_housing', 'hospital') AND o.expired = 0
ORDER BY c.value, o.type, o.name` },
  { id: 'hazards_by_muni', title: ['Municipios: buildings exposed to surge, flood zone and landslide', 'Municipios: edificios expuestos a marejada, zona inundable y deslizamientos'], sql:
`-- Building footprints (OpenStreetMap) per municipio against three published hazard maps; screening, not an inventory
SELECT o.name AS municipio, b.value AS buildings,
       s1.value AS surge_cat1, s3.value AS surge_cat3, s5.value AS surge_cat5,
       f.value AS fema_1pct_zone, l1.value AS at_or_below_1m_lidar,
       h.value AS landslide_high_or_above, h25.value AS within_25m_of_high_or_above,
       ROUND(100.0 * h25.value / b.value, 1) AS pct_within_25m
FROM object o
JOIN prop_best b ON b.object_id = o.id AND b.key = 'buildings'
LEFT JOIN prop_best s1 ON s1.object_id = o.id AND s1.key = 'buildings_surge_cat1'
LEFT JOIN prop_best s3 ON s3.object_id = o.id AND s3.key = 'buildings_surge_cat3'
LEFT JOIN prop_best s5 ON s5.object_id = o.id AND s5.key = 'buildings_surge_cat5'
LEFT JOIN prop_best f ON f.object_id = o.id AND f.key = 'buildings_sfha'
LEFT JOIN prop_best l1 ON l1.object_id = o.id AND l1.key = 'buildings_le_1m'
LEFT JOIN prop_best h ON h.object_id = o.id AND h.key = 'buildings_slide_high'
LEFT JOIN prop_best h25 ON h25.object_id = o.id AND h25.key = 'buildings_slide_high_25m'
WHERE o.type = 'municipio' AND o.expired = 0
ORDER BY s3.value DESC` },
  { id: 'sfha_per_1000', title: ['Municipios by buildings in the 1% flood zone per 1,000 buildings', 'Municipios por edificios en la zona 1% por cada 1,000 edificios'], sql:
`-- Buildings whose centroid is in a FEMA special flood hazard area (A or V zones), per 1,000 buildings
SELECT o.id, o.name AS municipio, b.value AS buildings, s.value AS buildings_in_flood_zone,
       ROUND(1000.0 * s.value / b.value, 1) AS per_1000_buildings
FROM object o
JOIN prop_best b ON b.object_id = o.id AND b.key = 'buildings'
JOIN prop_best s ON s.object_id = o.id AND s.key = 'buildings_sfha'
WHERE o.type = 'municipio' AND b.value > 0
ORDER BY per_1000_buildings DESC` },
  { id: 'maria_ihp', title: ['Hurricane María (DR-4339): FEMA individual assistance (IHP) approved per valid registration', 'Huracán María (DR-4339): asistencia individual de FEMA (IHP) aprobada por registro válido'], sql:
`-- FEMA Individuals and Households Program, DR-4339, by municipio
SELECT m.value AS municipio, r.value AS valid_registrations, a.value AS approved_usd,
       ROUND(a.value / r.value) AS usd_per_registration, d.value AS total_damage_usd
FROM object o
JOIN prop_best n ON n.object_id = o.id AND n.key = 'disaster_number' AND n.value = 4339
JOIN prop_best r ON r.object_id = o.id AND r.key = 'valid_registrations'
JOIN prop_best a ON a.object_id = o.id AND a.key = 'approved_usd'
LEFT JOIN prop_best m ON m.object_id = o.id AND m.key = 'municipio_name'
LEFT JOIN prop_best d ON d.object_id = o.id AND d.key = 'total_damage_usd'
WHERE o.type = 'disaster_impact' AND r.value > 0
ORDER BY usd_per_registration DESC` },
  { id: 'disagree', title: ['Properties where two sources disagree', 'Propiedades donde dos fuentes difieren'], sql:
`-- Same object, same property, different values from different sources
SELECT a.object_id AS id, a.key, a.value AS value_a, a.source_id AS source_a, b.value AS value_b, b.source_id AS source_b
FROM prop a JOIN prop b ON b.object_id = a.object_id AND b.key = a.key AND b.source_id > a.source_id
WHERE a.value IS NOT b.value
ORDER BY a.object_id, a.key LIMIT 500` },
  { id: 'per_source', title: ['Objects and property values per source', 'Objetos y valores por fuente'], sql:
`-- What each source contributed
SELECT s.id AS source, s.kind, s.org,
       (SELECT COUNT(*) FROM object o WHERE o.source_id = s.id) AS objects,
       (SELECT COUNT(*) FROM prop p WHERE p.source_id = s.id) AS property_values,
       (SELECT COUNT(*) FROM link l WHERE l.source_id = s.id) AS links
FROM source s ORDER BY property_values DESC` },
  { id: 'most_linked', title: ['The 20 most-linked objects', 'Los 20 objetos con más vínculos'], sql:
`-- Degree = links in either direction
SELECT x.id, o.name, o.type, COUNT(*) AS links
FROM (SELECT src AS id FROM link UNION ALL SELECT dst FROM link) x
JOIN object o ON o.id = x.id
GROUP BY x.id ORDER BY links DESC LIMIT 20` },
  { id: 'runs', title: ['Latest ingest runs', 'Últimas corridas de ingesta'], sql:
`-- Lineage: the most recent fetches, newest first (times in AST)
SELECT source_id AS source, status, datetime(finished_at / 1000, 'unixepoch', '-4 hours') AS finished_ast,
       objects, created, changed, links, obs, bytes, note
FROM ingest_run ORDER BY finished_at DESC LIMIT 50` },
  { id: 'types', title: ['Objects by type', 'Objetos por tipo'], sql:
`SELECT t.id AS type, t.label_en AS label, t.grp AS layer_group, COUNT(o.id) AS objects,
       SUM(CASE WHEN o.id IS NOT NULL AND o.lon IS NULL THEN 1 ELSE 0 END) AS without_point
FROM object_type t LEFT JOIN object o ON o.type = t.id AND o.expired = 0
GROUP BY t.id ORDER BY objects DESC` },
  { id: 'ph_low', title: ['Public housing residents by ground elevation band', 'Residentes de vivienda pública por franja de elevación'], sql:
`-- Bathtub screen: developments, units and residents by ground elevation band (one point per development)
SELECT CASE WHEN e.value <= 1 THEN '0-1 m' WHEN e.value <= 2 THEN '1-2 m' WHEN e.value <= 3 THEN '2-3 m'
            WHEN e.value <= 5 THEN '3-5 m' WHEN e.value <= 10 THEN '5-10 m' ELSE 'above 10 m' END AS ground_elevation,
       COUNT(*) AS developments, SUM(u.value) AS units, SUM(r.value) AS residents, MIN(e.value) AS lowest_m
FROM object o
JOIN prop_best e ON e.object_id = o.id AND e.key = 'ground_elev_m'
LEFT JOIN prop_best u ON u.object_id = o.id AND u.key = 'units'
LEFT JOIN prop_best r ON r.object_id = o.id AND r.key = 'residents'
WHERE o.type = 'public_housing' AND o.expired = 0
GROUP BY 1 ORDER BY MIN(e.value)` },
];
