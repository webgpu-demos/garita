// National Flood Insurance Program, Puerto Rico: claims since 1978 and policies in force, per municipio and census tract.
// OpenFEMA NfipClaims v3 and NfipPolicies v3 (the FimaNfip* v2 datasets were frozen on 2026-06-01 and are being removed).
// Claims are insurance claims filed by policyholders. They are not a count of flooded homes.
import { openfemaAll, fetchJson, num, round } from '../lib.mjs';
import { fetchTractIds } from './census_tiger.mjs';

const CLAIM_FIELDS = 'id,asOfDate,dateOfLoss,yearOfLoss,floodEvent,amountPaidOnBuildingClaim,amountPaidOnContentsClaim,amountPaidOnIncreasedCostOfComplianceClaim,countyCode,censusGeoid';
const POLICY_FIELDS = 'id,asOfDate,policyEffectiveDate,policyTerminationDate,cancellationDateOfFloodPolicy,policyCount,totalBuildingInsuranceCoverage,totalContentsInsuranceCoverage,totalInsurancePremiumOfThePolicy,censusGeoid';
const day = (s) => (s ? String(s).slice(0, 10) : null);
const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const isMaria = (r) => /\bmaria\b/i.test(String(r.floodEvent || '').normalize('NFD').replace(/[̀-ͯ]/g, ''));

/** Where a redacted record is: the block-group GEOID first (address-based), then the county code. Null = no usable location. */
function place(r, muniIds) {
  const g = r.censusGeoid ? String(r.censusGeoid) : '';
  if (g.length >= 11 && muniIds.has(g.slice(0, 5))) return { muni: g.slice(0, 5), tract: g.slice(0, 11), by: 'geoid' };
  const c = r.countyCode ? String(r.countyCode) : '';
  if (muniIds.has(c)) return { muni: c, tract: null, by: 'county' };
  return null;
}

export async function build(ctx) {
  const muni = await ctx.municipios();
  const name = new Map(muni.rows.map((r) => [String(r.GEOID), String(r.BASENAME)]));
  const muniIds = new Set(name.keys());
  const tractIds = ctx.tractIds ? await ctx.tractIds() : await fetchTractIds(ctx);
  const now = Date.now();
  const out = [];
  try { out.push(await claims(ctx, name, muniIds, tractIds, now)); } catch (error) { out.push({ file: '32-nfip-claims', error }); }
  try { out.push(await policies(ctx, name, muniIds, tractIds, now)); } catch (error) { out.push({ file: '33-nfip-policies', error }); }
  return out;
}

async function claims(ctx, name, muniIds, tractIds, now) {
  const rows = await openfemaAll('NfipClaims', "state eq 'PR'", { select: CLAIM_FIELDS, log: ctx.log, version: 'v3' });
  if (!rows.length) throw new Error('NfipClaims v3 returned no rows for Puerto Rico');
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error('NfipClaims v3: paging returned repeated ids; pull is not trustworthy');
  const asOf = rows.map((r) => day(r.asOfDate)).filter(Boolean).sort().pop();
  const blank = () => ({ n: 0, paidN: 0, b: 0, c: 0, icc: 0, mariaN: 0, mariaPaid: 0, years: new Map() });
  const add = (a, r, paid) => {
    a.n++; if (paid.total > 0) a.paidN++; a.b += paid.b; a.c += paid.c; a.icc += paid.icc;
    if (isMaria(r)) { a.mariaN++; a.mariaPaid += paid.total; }
    const y = num(r.yearOfLoss) ?? Number(String(r.dateOfLoss).slice(0, 4));
    const yy = a.years.get(y) || [0, 0]; yy[0]++; yy[1] += paid.total; a.years.set(y, yy);
  };
  const island = blank(), nowhere = blank(), byMuni = new Map([...muniIds].map((g) => [g, blank()])), byTract = new Map();
  let noAmount = 0, negative = 0, viaCounty = 0, nowhereBefore2000 = 0, tractNotCurrent = 0, mariaSep = 0, sep2017 = 0, sep2017Other = new Map();
  for (const r of rows) {
    if (r.amountPaidOnBuildingClaim == null && r.amountPaidOnContentsClaim == null && r.amountPaidOnIncreasedCostOfComplianceClaim == null) noAmount++;
    const paid = { b: num(r.amountPaidOnBuildingClaim) || 0, c: num(r.amountPaidOnContentsClaim) || 0, icc: num(r.amountPaidOnIncreasedCostOfComplianceClaim) || 0 };
    paid.total = paid.b + paid.c + paid.icc;
    if (paid.b < 0 || paid.c < 0 || paid.icc < 0) negative++;
    const inSep = String(r.dateOfLoss).startsWith('2017-09');
    if (inSep) { sep2017++; if (isMaria(r)) mariaSep++; else sep2017Other.set(r.floodEvent || 'no event name', (sep2017Other.get(r.floodEvent || 'no event name') || 0) + 1); }
    add(island, r, paid);
    const p = place(r, muniIds);
    if (!p) { add(nowhere, r, paid); if (String(r.dateOfLoss) < '2000') nowhereBefore2000++; continue; }
    if (p.by === 'county') viaCounty++;
    add(byMuni.get(p.muni), r, paid);
    if (p.tract) { if (tractIds.has(p.tract)) { if (!byTract.has(p.tract)) byTract.set(p.tract, blank()); add(byTract.get(p.tract), r, paid); } else tractNotCurrent++; }
  }
  const series = (a) => { const ys = [...a.years.keys()].sort((x, y) => x - y); return JSON.stringify({ years: ys, claims: ys.map((y) => a.years.get(y)[0]), paid_usd: ys.map((y) => Math.round(a.years.get(y)[1])) }); };
  const objects = [];
  for (const [g, a] of byMuni) objects.push({ type: 'municipio', key: g, name: name.get(g), props: {
    nfip_claims: a.n, nfip_claims_paid: a.paidN, nfip_paid_usd: round(a.b + a.c + a.icc, 2), nfip_paid_building_usd: round(a.b, 2), nfip_paid_contents_usd: round(a.c, 2), nfip_paid_icc_usd: round(a.icc, 2),
    nfip_claims_by_year: series(a), nfip_claims_maria: a.mariaN, nfip_paid_usd_maria: round(a.mariaPaid, 2) } });
  for (const [t, a] of byTract) objects.push({ type: 'tract', key: t, props: { nfip_claims: a.n, nfip_paid_usd: round(a.b + a.c + a.icc, 2), nfip_claims_maria: a.mariaN } });
  const tot = (a) => a.b + a.c + a.icc;
  const top = [...byMuni].sort((x, y) => y[1].n - x[1].n).slice(0, 5).map(([g, a]) => `${name.get(g)} ${a.n}`).join(', ');
  ctx.probe('nfip_claims', { rows: rows.length, asOf, island: { claims: island.n, with_payment: island.paidN, paid_usd: round(tot(island), 2), building_usd: round(island.b, 2), contents_usd: round(island.c, 2), icc_usd: round(island.icc, 2), maria_claims: island.mariaN, maria_paid_usd: round(island.mariaPaid, 2) },
    no_location: { claims: nowhere.n, paid_usd: round(tot(nowhere), 2), maria_claims: nowhere.mariaN, maria_paid_usd: round(nowhere.mariaPaid, 2) }, located_by_county_code_only: viaCounty, tracts: byTract.size, in_tracts_not_current: tractNotCurrent,
    no_amount_recorded: noAmount, negative_amounts: negative, sep2017: { claims: sep2017, named_maria: mariaSep, other: Object.fromEntries(sep2017Other) }, top });
  const note = `OpenFEMA NfipClaims v3, state eq 'PR', ${rows.length} claim records, data as of ${asOf}. Island total: ${island.n} claims since ${Math.min(...island.years.keys())}, ${island.paidN} with a payment, ${usd(tot(island))} paid (building ${usd(island.b)}, contents ${usd(island.c)}, increased cost of compliance ${usd(island.icc)}); nominal dollars, not adjusted for inflation. `
    + `Summed: amountPaidOnBuildingClaim + amountPaidOnContentsClaim + amountPaidOnIncreasedCostOfComplianceClaim, gross of later recoveries; ${noAmount} records carry no amounts and count as claims with $0 paid; records with a negative amount (FEMA: a reissued check), summed as given: ${negative}. nfip_claims_paid = claims whose three amounts sum to more than zero. `
    + `Municipio = first five digits of censusGeoid (FEMA's block-group code), else countyCode (${viaCounty} records). ${nowhere.n} claims (${usd(tot(nowhere))}) have neither, or a code outside Puerto Rico, and are in no municipio (${nowhereBefore2000} of them with a loss before 2000): municipio values are a floor. FEMA redacts the address, so nothing finer than a block group is known. `
    + `Hurricane María = floodEvent names Maria: ${island.mariaN} claims, ${usd(island.mariaPaid)} paid, of which ${nowhere.mariaN} claims (${usd(nowhere.mariaPaid)}) have no municipio. ${mariaSep} of them have a date of loss in September 2017; September 2017 holds ${sep2017} claims in all, the rest being ${[...sep2017Other].map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}, which are not counted as María. `
    + `Tract values use the first eleven digits of censusGeoid and only tracts that exist in the current TIGER set (${byTract.size} tracts); ${tractNotCurrent} located claims carry a tract code that is not current and appear at municipio level only. A claim is one policyholder's filing: not a count of flooded homes, since homes without a policy file nothing.`;
  return { file: '32-nfip-claims', batch: { source: 'openfema_nfip_claims', fetchedAt: now, observedAt: Date.parse(asOf) || now, objects, links: [], note } };
}

async function policies(ctx, name, muniIds, tractIds, now) {
  // The national dataset has about 75 million policy terms. One row tells us the snapshot date; then only terms that end after it are pulled.
  const first = await fetchJson(`https://www.fema.gov/api/open/v3/NfipPolicies?$filter=${encodeURIComponent("propertyState eq 'PR'")}&$select=asOfDate&$top=1&$count=true`, { timeout: 180000 });
  const head = (first.NfipPolicies || [])[0];
  if (!head?.asOfDate) throw new Error('NfipPolicies v3: no asOfDate for Puerto Rico');
  const allTerms = first.metadata?.count || null;
  const filter = `propertyState eq 'PR' and policyTerminationDate gt '${day(head.asOfDate)}T00:00:00.000Z'`;
  const rows = await openfemaAll('NfipPolicies', filter, { select: POLICY_FIELDS, log: ctx.log, version: 'v3' });
  if (!rows.length) throw new Error('NfipPolicies v3 returned no rows for Puerto Rico');
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error('NfipPolicies v3: paging returned repeated ids; pull is not trustworthy');
  const D = rows.map((r) => day(r.asOfDate)).filter(Boolean).sort().pop();       // the date policies are counted on
  const blank = () => ({ contracts: 0, units: 0, b: 0, c: 0, prem: 0 });
  const add = (a, r) => { a.contracts++; a.units += num(r.policyCount) || 0; a.b += num(r.totalBuildingInsuranceCoverage) || 0; a.c += num(r.totalContentsInsuranceCoverage) || 0; a.prem += num(r.totalInsurancePremiumOfThePolicy) || 0; };
  const island = blank(), nowhere = blank(), byMuni = new Map([...muniIds].map((g) => [g, blank()])), byTract = new Map();
  let notYet = 0, cancelled = 0, ended = 0, tractNotCurrent = 0;
  for (const r of rows) {
    const eff = day(r.policyEffectiveDate), end = day(r.policyTerminationDate), can = day(r.cancellationDateOfFloodPolicy);
    if (!eff || eff > D) { notYet++; continue; }
    if (!end || end <= D) { ended++; continue; }
    if (can && can <= D) { cancelled++; continue; }
    add(island, r);
    const p = place(r, muniIds);
    if (!p) { add(nowhere, r); continue; }
    add(byMuni.get(p.muni), r);
    if (p.tract) { if (tractIds.has(p.tract)) { if (!byTract.has(p.tract)) byTract.set(p.tract, blank()); add(byTract.get(p.tract), r); } else tractNotCurrent++; }
  }
  const at = Date.parse(D);
  const objects = [];
  for (const [g, a] of byMuni) objects.push({ type: 'municipio', key: g, name: name.get(g), props: { nfip_policies: a.units, nfip_contracts: a.contracts, nfip_building_coverage_usd: a.b, nfip_contents_coverage_usd: a.c, nfip_premium_usd: a.prem, nfip_policies_date: at } });
  for (const [t, a] of byTract) objects.push({ type: 'tract', key: t, props: { nfip_policies: a.units, nfip_contracts: a.contracts } });
  ctx.probe('nfip_policies', { pr_terms_all_years: allTerms, pulled: rows.length, filter, in_force_on: D, island, no_location: nowhere, not_yet_effective: notYet, cancelled_by_date: cancelled, ended_by_date: ended, tracts: byTract.size, in_tracts_not_current: tractNotCurrent,
    top: [...byMuni].sort((x, y) => y[1].contracts - x[1].contracts).slice(0, 5).map(([g, a]) => `${name.get(g)} ${a.contracts}`).join(', ') });
  const note = `OpenFEMA NfipPolicies v3. Pulled with ${filter}: ${rows.length} policy terms${allTerms ? ` of the ${allTerms} Puerto Rico terms the dataset holds since 2009` : ''}; the filter leaves out every term that ended on or before the snapshot date, so no history of past years is kept. `
    + `In force on ${D} (the asOfDate FEMA stamps on the records, the latest date the data can speak for) = policyEffectiveDate on or before that date, policyTerminationDate after it, and no cancellationDateOfFloodPolicy on or before it. Pulled but not counted: ${notYet} terms not yet effective on that date, ${cancelled} cancelled by it, ${ended} ended by it. `
    + `Island total: ${island.contracts} policy contracts covering ${island.units} insured units (FEMA's policyCount: a condominium association contract insures many units), building coverage ${usd(island.b)}, contents coverage ${usd(island.c)}, premium ${usd(island.prem)} (totalInsurancePremiumOfThePolicy for the term; fees and surcharges not included). `
    + `Municipio = first five digits of censusGeoid; this version has no county field. ${nowhere.contracts} contracts (${nowhere.units} units) have no usable code and are in no municipio, so municipio values are a floor. FEMA says the dataset lags the system of record, so terms that began shortly before the date may still be missing. `
    + `Tracts: first eleven digits of censusGeoid, current TIGER tracts only (${byTract.size} tracts; ${tractNotCurrent} contracts in tract codes that are not current). Derived from redacted records; not FEMA's official policies-in-force count, and private flood insurance is not included.`;
  return { file: '33-nfip-policies', batch: { source: 'openfema_nfip_policies', fetchedAt: now, observedAt: at || now, objects, links: [], note } };
}
