#!/usr/bin/env bash
cat > /tmp/p2.mjs <<'JS'
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const OUT = process.env.OUT; const B = 'https://www.fema.gov/api/open';
const log = []; const say = (m) => { console.log(m); log.push(m); };
async function get(url, raw) {
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'garita (github.com/webgpu-demos/garita)' }, signal: AbortSignal.timeout(170000) });
      const text = await r.text();
      say(`${r.status} ${Date.now() - t0}ms ${text.length}B ${url}`);
      if (!r.ok) return { error: r.status, text: text.slice(0, 600) };
      return raw ? text : JSON.parse(text);
    } catch (e) { say(`ERR ${e.message} ${url}`); await new Promise((r) => setTimeout(r, 3000)); }
  }
  return { error: 'failed' };
}
const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
async function all(path, filter, extra = {}) {
  const rows = []; let meta = null;
  for (let skip = 0; ; skip += 10000) {
    const j = await get(`${B}/${path}?${q({ $filter: filter, $top: 10000, $skip: skip, ...extra })}`);
    if (j.error) return { error: j, rows };
    const k = Object.keys(j).find((k) => k !== 'metadata'); meta ||= j.metadata;
    rows.push(...j[k]); if (j[k].length < 10000) break;
  }
  return { rows, meta };
}
const save = (name, data) => { const z = gzipSync(JSON.stringify(data)); writeFileSync(`${OUT}/${name}.json.gz`, z); say(`saved ${name} ${z.length}B gz`); };

const ds = await get(`${B}/v1/OpenFemaDataSets?${q({ $top: 1000 })}`);
const dk = Object.keys(ds).find((k) => k !== 'metadata');
const want = (ds[dk] || []).filter((d) => /nfip|publicassistance|hma|mitigation|housingassistance|declarations/i.test(d.name));
writeFileSync(`${OUT}/datasets.json`, JSON.stringify(want, null, 1));
say('datasets: ' + want.map((d) => `${d.name} v${d.version}${d.depDate ? ' DEP ' + d.depDate : ''} n=${d.recordCount} refreshed ${d.lastDataSetRefresh}`).join(' | '));
for (const n of ['NfipClaims', 'NfipPolicies', 'HmaSubapplications', 'HmaSubapplicationsProjectSiteInventories', 'PublicAssistanceFundedProjectsDetails']) {
  const f = await get(`${B}/v1/OpenFemaDataSetFields?${q({ $filter: `openFemaDataSet eq '${n}'`, $top: 1000 })}`);
  const k = Object.keys(f).find((k) => k !== 'metadata');
  writeFileSync(`${OUT}/fields.${n}.json`, JSON.stringify((f[k] || []).map((r) => ({ v: r.datasetVersion, name: r.name, type: r.type, searchable: r.isSearchable, desc: r.description })), null, 1));
}
const terms = await get('https://www.fema.gov/about/openfema/terms-conditions', true);
if (typeof terms === 'string') writeFileSync(`${OUT}/terms.txt`, terms.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));

// claims: try v3 first
let c = await all('v3/NfipClaims', "state eq 'PR'");
say(`NfipClaims v3: ${c.rows.length} rows ${c.error ? JSON.stringify(c.error).slice(0, 500) : ''}`);
if (c.rows.length) { writeFileSync(`${OUT}/claims.meta.json`, JSON.stringify(c.meta)); save('claims.v3', c.rows); }
else { c = await all('v2/FimaNfipClaims', "state eq 'PR'"); save('claims.v2', c.rows); }
// policies
for (const [path, tag] of [['v3/NfipPolicies', 'v3'], ['v2/FimaNfipPolicies', 'v2']]) {
  const n = await get(`${B}/${path}?${q({ $filter: "propertyState eq 'PR'", $top: 1, $count: 'true' })}`);
  say(`${path} PR count ${JSON.stringify(n.metadata?.count)} ${n.error ? JSON.stringify(n).slice(0, 400) : ''}`);
  if (n.error) continue;
  writeFileSync(`${OUT}/policies.${tag}.meta.json`, JSON.stringify(n.metadata));
  const p = await all(path, "propertyState eq 'PR' and policyTerminationDate ge '2025-06-01T00:00:00.000Z'");
  say(`${path} PR terminating on/after 2025-06-01: ${p.rows.length} ${p.error ? JSON.stringify(p.error).slice(0, 400) : ''}`);
  if (p.rows.length) save(`policies.${tag}`, p.rows);
}
const pa = await all('v2/PublicAssistanceFundedProjectsDetails', "stateAbbreviation eq 'PR'");
say(`PA ${pa.rows.length}`); writeFileSync(`${OUT}/pa.meta.json`, JSON.stringify(pa.meta)); save('pa', pa.rows);
for (const [path, f] of [['v2/HmaSubapplications', "state eq 'Puerto Rico'"], ['v4/HazardMitigationAssistanceProjects', "state eq 'Puerto Rico'"]]) {
  const h = await all(path, f); say(`${path}: ${h.rows.length} ${h.error ? JSON.stringify(h.error).slice(0, 400) : ''}`);
  if (h.rows.length) { save(path.replace('/', '.'), h.rows); writeFileSync(`${OUT}/${path.replace('/', '.')}.meta.json`, JSON.stringify(h.meta)); }
}
writeFileSync(`${OUT}/log.txt`, log.join('\n'));
JS
node /tmp/p2.mjs
