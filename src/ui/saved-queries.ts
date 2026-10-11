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
  { id: 'nfip_gap', title: ['Flood insurance gap: policies in force against buildings in the FEMA 1% flood zone', 'Brecha de seguro de inundación: pólizas vigentes frente a edificios en la zona inundable FEMA 1%'], sql:
`-- Compares NFIP flood insurance policy contracts in force in the whole municipio (FEMA's redacted records, any flood zone,
-- counted on the date in the last column) with OpenStreetMap building footprints whose centroid is in a FEMA A or V zone.
-- A screen, not a penetration rate: footprints include buildings that are not homes and miss unmapped ones, policies outside
-- the zone are counted too, one condominium contract insures many units (insured_units), and private flood insurance is not in the data.
SELECT o.name AS municipio, s.value AS buildings_in_1pct_zone, c.value AS contracts_in_force, u.value AS insured_units,
       s.value - c.value AS buildings_minus_contracts,
       ROUND(100.0 * c.value / s.value, 1) AS contracts_per_100_buildings_in_zone,
       cov.value AS building_coverage_usd, date(d.value / 1000, 'unixepoch') AS policies_counted_on
FROM object o
JOIN prop_best s ON s.object_id = o.id AND s.key = 'buildings_sfha'
JOIN prop_best c ON c.object_id = o.id AND c.key = 'nfip_contracts'
LEFT JOIN prop_best u ON u.object_id = o.id AND u.key = 'nfip_policies'
LEFT JOIN prop_best cov ON cov.object_id = o.id AND cov.key = 'nfip_building_coverage_usd'
LEFT JOIN prop_best d ON d.object_id = o.id AND d.key = 'nfip_policies_date'
WHERE o.type = 'municipio' AND o.expired = 0 AND s.value > 0
ORDER BY buildings_minus_contracts DESC` },
  { id: 'maria_three_programs', title: ['Hurricane María per municipio: flood insurance paid, housing assistance and Public Assistance', 'Huracán María por municipio: seguro de inundación pagado, asistencia de vivienda y Asistencia Pública'], sql:
`-- Three FEMA programmes side by side, nominal dollars. Flood insurance: NFIP claims FEMA names Hurricane Maria (claims filed by
-- policyholders, not a count of flooded homes; claims without a location are in no municipio). Housing assistance: DR-4339
-- registrations and aid approved (Individuals and Households). Public Assistance: DR-4339 projects of applicants listed in the
-- municipio only; island-wide projects, most of the money, are in the island-level record (see the next query).
SELECT o.name AS municipio, nc.value AS nfip_claims, np.value AS nfip_paid_usd,
       ir.value AS housing_registrations, ia.value AS housing_approved_usd,
       pp.value AS pa_projects, pf.value AS pa_federal_obligated_usd,
       ROUND(1000.0 * nc.value / ir.value, 1) AS nfip_claims_per_1000_registrations
FROM object o
LEFT JOIN prop_best nc ON nc.object_id = o.id AND nc.key = 'nfip_claims_maria'
LEFT JOIN prop_best np ON np.object_id = o.id AND np.key = 'nfip_paid_usd_maria'
LEFT JOIN prop_best ir ON ir.object_id = o.id AND ir.key = 'ihp_registrations_maria'
LEFT JOIN prop_best ia ON ia.object_id = o.id AND ia.key = 'ihp_approved_usd_maria'
LEFT JOIN prop_best pp ON pp.object_id = o.id AND pp.key = 'pa_projects_maria'
LEFT JOIN prop_best pf ON pf.object_id = o.id AND pf.key = 'pa_federal_obligated_usd_maria'
WHERE o.type = 'municipio' AND o.expired = 0
ORDER BY ia.value DESC` },
  { id: 'pa_by_disaster', title: ['Public Assistance by disaster: island-wide projects against projects of municipio applicants', 'Asistencia Pública por desastre: proyectos de toda la isla frente a proyectos de solicitantes municipales'], sql:
`-- FEMA Public Assistance, federal share obligated, nominal dollars. "Island-wide" = projects FEMA lists under county Statewide,
-- kept as one record per disaster and not spread over municipios. A municipio is where the applicant is listed, not always where the work is.
SELECT n.value AS disaster, COALESCE(d.name, 'no declaration row') AS declaration,
       SUM(p.value) AS projects, ROUND(SUM(f.value), 2) AS federal_obligated_usd,
       ROUND(SUM(CASE WHEN sc.value = 'island' THEN f.value ELSE 0 END), 2) AS island_wide_usd,
       ROUND(SUM(CASE WHEN sc.value = 'municipio' THEN f.value ELSE 0 END), 2) AS municipio_applicants_usd,
       ROUND(100.0 * SUM(CASE WHEN sc.value = 'island' THEN f.value ELSE 0 END) / NULLIF(SUM(f.value), 0), 1) AS pct_island_wide,
       SUM(CASE WHEN sc.value = 'municipio' THEN 1 ELSE 0 END) AS municipios_with_projects,
       ROUND(SUM(e.value), 2) AS emergency_work_usd, ROUND(SUM(w.value), 2) AS permanent_work_usd
FROM object o
JOIN prop_best n ON n.object_id = o.id AND n.key = 'disaster_number'
JOIN prop_best sc ON sc.object_id = o.id AND sc.key = 'scope'
JOIN prop_best p ON p.object_id = o.id AND p.key = 'projects'
JOIN prop_best f ON f.object_id = o.id AND f.key = 'federal_share_obligated_usd'
LEFT JOIN prop_best e ON e.object_id = o.id AND e.key = 'emergency_work_federal_usd'
LEFT JOIN prop_best w ON w.object_id = o.id AND w.key = 'permanent_work_federal_usd'
LEFT JOIN object d ON d.id = 'disaster_declaration:' || CAST(n.value AS INTEGER)
WHERE o.type = 'pa_record' AND o.expired = 0
GROUP BY n.value ORDER BY federal_obligated_usd DESC` },
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
