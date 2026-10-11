// Recovery spending per disaster and municipio: Public Assistance (obligated project worksheets) and Hazard Mitigation
// Assistance (subapplications). Island-wide projects stay island-wide: one record per disaster, linked to the declaration only.
import { openfemaAll, normMuni, num, round, clean } from '../lib.mjs';
const ms = (s) => { if (!s) return null; const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const PA_FIELDS = 'disasterNumber,pwNumber,damageCategoryCode,projectStatus,county,projectAmount,federalShareObligated,totalObligated,mitigationAmount,lastRefresh';
const EMERGENCY = new Set(['A', 'B']), PERMANENT = new Set(['C', 'D', 'E', 'F', 'G']);
const HMA_APPROVED = new Set(['approved', 'awarded', 'closed', 'completed', 'subaward accepted']);
const ISLAND_WORDS = new Set(['statewide', 'puerto rico', 'commonwealth of puerto rico', 'islandwide', 'island wide']);

export async function build(ctx) {
  const muni = await ctx.municipios();
  const byGeoid = new Map(muni.rows.map((r) => [String(r.GEOID), String(r.BASENAME)]));
  const byName = new Map(muni.rows.map((r) => [normMuni(r.BASENAME), String(r.GEOID)]));
  const decl = new Map();
  for (const r of await openfemaAll('DisasterDeclarationsSummaries', "state eq 'PR'", { select: 'disasterNumber,declarationTitle,femaDeclarationString,incidentBeginDate,incidentEndDate', log: ctx.log })) if (!decl.has(r.disasterNumber)) decl.set(r.disasterNumber, r);
  const g = { byGeoid, byName, decl, now: Date.now() };
  const out = [];
  try { out.push(await publicAssistance(ctx, g)); } catch (error) { out.push({ file: '34-public-assistance', error }); }
  try { out.push(await hazardMitigation(ctx, g)); } catch (error) { out.push({ file: '35-hazard-mitigation', error }); }
  return out;
}

async function publicAssistance(ctx, { byGeoid, byName, decl, now }) {
  const rows = await openfemaAll('PublicAssistanceFundedProjectsDetails', "stateAbbreviation eq 'PR'", { select: PA_FIELDS, log: ctx.log });
  if (!rows.length) throw new Error('PublicAssistanceFundedProjectsDetails returned no rows for Puerto Rico');
  if (new Set(rows.map((r) => `${r.disasterNumber}-${r.pwNumber}`)).size !== rows.length) throw new Error('PublicAssistanceFundedProjectsDetails: paging returned repeated project worksheets; pull is not trustworthy');
  const agg = new Map(), leftOut = new Map(), status = new Map();
  const total = { n: 0, fed: 0, amt: 0 }, islandTotal = { n: 0, fed: 0 };
  let negatives = 0, refreshed = '';
  for (const r of rows) {
    const fed = num(r.federalShareObligated) || 0, amt = num(r.projectAmount) || 0, tot = num(r.totalObligated) || 0, mit = num(r.mitigationAmount) || 0;
    status.set(r.projectStatus, (status.get(r.projectStatus) || 0) + 1);
    if (fed < 0 || tot < 0 || mit < 0) negatives++;
    if (String(r.lastRefresh || '') > refreshed) refreshed = String(r.lastRefresh);
    const island = normMuni(r.county) === 'statewide';
    const geoid = island ? null : byName.get(normMuni(r.county));
    if (!island && !geoid) { const k = `disaster ${r.disasterNumber}, county "${r.county}"`; const l = leftOut.get(k) || { n: 0, fed: 0 }; l.n++; l.fed += fed; leftOut.set(k, l); continue; }
    total.n++; total.fed += fed; total.amt += amt; if (island) { islandTotal.n++; islandTotal.fed += fed; }
    const key = `${r.disasterNumber}-${geoid || 'statewide'}`;
    let a = agg.get(key);
    if (!a) agg.set(key, a = { dn: r.disasterNumber, geoid, n: 0, fed: 0, amt: 0, tot: 0, mit: 0, emergency: 0, permanent: 0, cat: {} });
    a.n++; a.fed += fed; a.amt += amt; a.tot += tot; a.mit += mit;
    const c = String(r.damageCategoryCode || '?').trim().toUpperCase();
    if (EMERGENCY.has(c)) a.emergency += fed; else if (PERMANENT.has(c)) a.permanent += fed;
    const cc = (a.cat[c] ||= { projects: 0, federal_usd: 0, project_usd: 0 }); cc.projects++; cc.federal_usd += fed; cc.project_usd += amt;
  }
  const objects = [], links = [], problems = [], maria = new Map();
  for (const [key, a] of [...agg].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const d = decl.get(a.dn);
    const where = a.geoid ? byGeoid.get(a.geoid) : 'island-wide (Statewide)';
    for (const c of Object.values(a.cat)) { c.federal_usd = round(c.federal_usd, 2); c.project_usd = round(c.project_usd, 2); }
    objects.push({ type: 'pa_record', key, name: `Public Assistance, ${d ? d.declarationTitle : `disaster ${a.dn}`}: ${where}`, validFrom: d ? ms(d.incidentBeginDate) : null, validTo: d ? ms(d.incidentEndDate) : null,
      props: clean({ disaster_number: a.dn, municipio_name: a.geoid ? byGeoid.get(a.geoid) : null, scope: a.geoid ? 'municipio' : 'island', projects: a.n, federal_share_obligated_usd: round(a.fed, 2), project_amount_usd: round(a.amt, 2),
        total_obligated_usd: round(a.tot, 2), mitigation_usd: round(a.mit, 2), emergency_work_federal_usd: round(a.emergency, 2), permanent_work_federal_usd: round(a.permanent, 2),
        by_category: JSON.stringify(Object.fromEntries(Object.entries(a.cat).sort())) }),
      text: `Public Assistance ${d ? d.femaDeclarationString : a.dn} ${where}` });
    if (d) links.push({ src: `pa_record:${key}`, type: 'record_of', dst: `disaster_declaration:${a.dn}` });
    if (a.geoid) links.push({ src: `pa_record:${key}`, type: 'record_of', dst: `municipio:${a.geoid}` });
    if (a.dn === 4339 && a.geoid) maria.set(a.geoid, a);
  }
  for (const [geoid, name] of byGeoid) { const a = maria.get(geoid); objects.push({ type: 'municipio', key: geoid, name, props: { pa_projects_maria: a ? a.n : 0, pa_federal_obligated_usd_maria: a ? round(a.fed, 2) : 0 } }); }
  for (const [k, l] of leftOut) problems.push(`${k}: not Statewide and not a municipio; ${l.n} project(s), ${usd(l.fed)} federal share left out`);
  const noDecl = [...new Set([...agg.values()].map((a) => a.dn))].filter((n) => !decl.has(n));
  if (noDecl.length) problems.push(`disaster numbers with Public Assistance projects but no PR declaration row (records kept, no link to a declaration): ${noDecl.join(', ')}`);
  const m = [...agg.values()].filter((a) => a.dn === 4339), mFed = m.reduce((s, a) => s + a.fed, 0), mIsl = m.find((a) => !a.geoid);
  const lo = [...leftOut.values()].reduce((s, l) => ({ n: s.n + l.n, fed: s.fed + l.fed }), { n: 0, fed: 0 });
  ctx.probe('public_assistance', { rows: rows.length, records: agg.size, disasters: new Set([...agg.values()].map((a) => a.dn)).size, projects: total.n, federal_share_obligated_usd: round(total.fed, 2), project_amount_usd: round(total.amt, 2),
    island_wide: { projects: islandTotal.n, federal_usd: round(islandTotal.fed, 2) }, maria_4339: { projects: m.reduce((s, a) => s + a.n, 0), federal_usd: round(mFed, 2), island_wide_federal_usd: round(mIsl?.fed || 0, 2), municipio_federal_usd: round(mFed - (mIsl?.fed || 0), 2) },
    left_out: lo, status: Object.fromEntries(status), negative_rows: negatives, last_refresh: refreshed });
  const note = `OpenFEMA PublicAssistanceFundedProjectsDetails v2, stateAbbreviation eq 'PR', ${rows.length} project worksheets (latest lastRefresh ${refreshed.slice(0, 10)}), summed to ${agg.size} records over ${new Set([...agg.values()].map((a) => a.dn)).size} disasters. `
    + `One record per disaster and municipio, the municipio being the applicant's county as FEMA lists it (where the applicant is, which is not always where the work is). Projects FEMA lists under county "Statewide" (${islandTotal.n} projects, ${usd(islandTotal.fed)} federal share) are one island-level record per disaster, linked to the declaration only and never spread over municipios. `
    + `projects = project worksheets; federal_share_obligated_usd = federalShareObligated; project_amount_usd = projectAmount (estimated total cost, without administrative costs); total_obligated_usd = totalObligated; mitigation_usd = mitigationAmount (Section 406, proposed). Emergency work = categories A and B, permanent work = C to G, by federal share; category Z (management and administrative costs) is in the totals and in by_category only. `
    + `All rows are summed as given, in nominal dollars: every projectStatus (${[...status].map(([k, v]) => `${k} ${v}`).join(', ')}) and ${negatives} rows with a negative amount (FEMA: adjustments and deobligations). Total: ${total.n} projects, ${usd(total.fed)} federal share obligated. Hurricane María (DR-4339): ${usd(mFed)}, of which ${usd(mIsl?.fed || 0)} island-wide and ${usd(mFed - (mIsl?.fed || 0))} under municipio applicants. `
    + `${lo.n ? `${lo.n} project(s) with ${usd(lo.fed)} have a county that is neither Statewide nor a municipio and are left out. ` : ''}Projects still in pre-obligation processing are not in the dataset. municipio.pa_*_maria = the DR-4339 record of the municipio, 0 where no applicant is listed there.`;
  return { file: '34-public-assistance', problems, batch: { source: 'openfema_pa', fetchedAt: now, objects, links, note } };
}

async function hazardMitigation(ctx, { byGeoid, byName, decl, now }) {
  const rows = await openfemaAll('HmaSubapplications', "subapplicantState eq 'Puerto Rico'", { log: ctx.log });
  if (!rows.length) throw new Error('HmaSubapplications returned no rows for Puerto Rico');
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error('HmaSubapplications: paging returned repeated ids; pull is not trustworthy');
  const agg = new Map(), why = { named_island_wide: 0, no_county: 0, several_municipios: 0, not_a_municipio: 0 }, unmatched = new Map(), status = new Map();
  const total = { n: 0, approved: 0, obligated: 0 }, ndPrograms = new Set();
  for (const r of rows) {
    const parts = String(r.benefitingCounties || '').replace(/['´`’]/g, '').split(';').map((s) => normMuni(s)).filter(Boolean);   // "BAYAMO'N MUNICIPIO" is Bayamón
    const ids = new Set(parts.map((p) => byName.get(p)).filter(Boolean));
    const strangers = parts.filter((p) => !byName.has(p));
    let geoid = null;
    if (!parts.length) why.no_county++;
    else if (strangers.length) { if (strangers.every((p) => ISLAND_WORDS.has(p))) why.named_island_wide++; else { why.not_a_municipio++; for (const p of strangers) if (!ISLAND_WORDS.has(p)) unmatched.set(p, (unmatched.get(p) || 0) + 1); } }
    else if (ids.size > 1) why.several_municipios++;
    else geoid = [...ids][0];
    const dn = /^\d+$/.test(String(r.disasterNumber || '').trim()) ? Number(r.disasterNumber) : null;
    if (dn == null) ndPrograms.add(r.program || 'unknown');
    const key = `${dn ?? 'nd'}-${geoid || 'statewide'}`;
    let a = agg.get(key);
    if (!a) agg.set(key, a = { dn, geoid, n: 0, approved: 0, obligated: 0, fed: 0, tot: 0, status: {}, program: {} });
    const st = String(r.status || 'unknown'), ok = HMA_APPROVED.has(st.toLowerCase()), obl = num(r.totalObligatedAmount) || 0;
    a.n++; a.obligated += obl; a.status[st] = (a.status[st] || 0) + 1; status.set(st, (status.get(st) || 0) + 1);
    if (ok) { a.approved++; a.fed += num(r.federalShareAmount) || 0; a.tot += num(r.totalSubapplicationAmount) || 0; }
    const pr = (a.program[r.program || 'unknown'] ||= { subapplications: 0, approved: 0, obligated_usd: 0 }); pr.subapplications++; if (ok) pr.approved++; pr.obligated_usd += obl;
    total.n++; if (ok) total.approved++; total.obligated += obl;
  }
  const objects = [], links = [], problems = [];
  for (const [key, a] of [...agg].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const d = a.dn != null ? decl.get(a.dn) : null;
    const where = a.geoid ? byGeoid.get(a.geoid) : 'island-wide or not tied to one municipio';
    const what = a.dn == null ? 'grants not tied to a disaster' : d ? d.declarationTitle : `disaster ${a.dn}`;
    for (const p of Object.values(a.program)) p.obligated_usd = round(p.obligated_usd, 2);
    objects.push({ type: 'hma_record', key, name: `Hazard Mitigation, ${what}: ${where}`, validFrom: d ? ms(d.incidentBeginDate) : null, validTo: d ? ms(d.incidentEndDate) : null,
      props: clean({ disaster_number: a.dn, municipio_name: a.geoid ? byGeoid.get(a.geoid) : null, scope: a.geoid ? 'municipio' : 'island', subapplications: a.n, approved: a.approved, obligated_usd: round(a.obligated, 2),
        approved_federal_share_usd: round(a.fed, 2), approved_total_usd: round(a.tot, 2), by_status: JSON.stringify(a.status), by_program: JSON.stringify(a.program) }),
      text: `Hazard Mitigation ${d ? d.femaDeclarationString : ''} ${where}` });
    if (d) links.push({ src: `hma_record:${key}`, type: 'record_of', dst: `disaster_declaration:${a.dn}` });
    if (a.geoid) links.push({ src: `hma_record:${key}`, type: 'record_of', dst: `municipio:${a.geoid}` });
  }
  for (const [p, n] of unmatched) problems.push(`benefitingCounties value "${p}" is not a municipio (${n} subapplication(s) kept island-level)`);
  const noDecl = [...new Set([...agg.values()].map((a) => a.dn))].filter((n) => n != null && !decl.has(n));
  if (noDecl.length) problems.push(`disaster numbers with subapplications but no PR declaration row (records kept, no link to a declaration): ${noDecl.join(', ')}`);
  const m = [...agg.values()].filter((a) => a.dn === 4339);
  ctx.probe('hazard_mitigation', { rows: rows.length, records: agg.size, total, kept_island_level: why, status: Object.fromEntries(status), maria_4339: { subapplications: m.reduce((s, a) => s + a.n, 0), approved: m.reduce((s, a) => s + a.approved, 0), obligated_usd: round(m.reduce((s, a) => s + a.obligated, 0), 2) } });
  const isl = Object.values(why).reduce((s, n) => s + n, 0);
  const note = `OpenFEMA HmaSubapplications v2 (replaces HazardMitigationAssistanceProjects v4, frozen 2026-08-31), subapplicantState eq 'Puerto Rico', ${rows.length} subapplications of every type (projects, plans, management costs) and status, summed to ${agg.size} records. `
    + `One record per disaster and municipio when benefitingCounties names exactly one municipio. The other ${isl} subapplications stay in one island-level record per disaster, linked to the declaration only: ${why.named_island_wide} named Statewide or Puerto Rico, ${why.no_county} with no county, ${why.several_municipios} naming several municipios (not spread), ${why.not_a_municipio} naming something that is not a municipio. Grants with no disaster number (${[...ndPrograms].join(', ') || 'none'}) have key prefix "nd" and no declaration link. `
    + `subapplications = all rows; approved = status Approved, Awarded, Closed, Completed or Subaward Accepted (${total.approved} of ${total.n}); obligated_usd = totalObligatedAmount over all rows (${usd(total.obligated)} in all); approved_federal_share_usd = federalShareAmount and approved_total_usd = totalSubapplicationAmount of the approved rows only, since on other rows those fields are requests. Status counts: ${[...status].map(([k, v]) => `${k} ${v}`).join(', ')}. Nominal dollars. FEMA: the data are "subject to a small percentage of human error".`;
  return { file: '35-hazard-mitigation', problems, batch: { source: 'openfema_hma', fetchedAt: now, objects, links, note } };
}
