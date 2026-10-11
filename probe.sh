#!/usr/bin/env bash
cat > /tmp/p3.mjs <<'JS'
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const OUT = process.env.OUT; const B = 'https://www.fema.gov/api/open';
const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const log = [];
async function all(path, filter) {
  const rows = [];
  for (let skip = 0; ; skip += 10000) {
    const url = `${B}/${path}?${q({ $filter: filter, $top: 10000, $skip: skip })}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'garita (github.com/webgpu-demos/garita)' } }); const text = await r.text();
    log.push(`${r.status} ${text.length}B ${url}`);
    if (!r.ok) { log.push(text.slice(0, 500)); break; }
    const j = JSON.parse(text); const k = Object.keys(j).find((k) => k !== 'metadata'); rows.push(...j[k]); if (j[k].length < 10000) break;
  }
  return rows;
}
for (const [name, path, f] of [['hmasub', 'v2/HmaSubapplications', "subapplicantStateAbbreviation eq 'PR'"], ['hmasub_state', 'v2/HmaSubapplications', "subapplicantState eq 'Puerto Rico'"], ['hmasites', 'v2/HmaSubapplicationsProjectSiteInventories', "stateAbbreviation eq 'PR'"], ['hmasites2', 'v1/HmaSubapplicationsProjectSiteInventories', "stateAbbreviation eq 'PR'"]]) {
  const rows = await all(path, f); log.push(`${name}: ${rows.length}`);
  if (rows.length) writeFileSync(`${OUT}/${name}.json.gz`, gzipSync(JSON.stringify(rows)));
}
const f = await (await fetch(`${B}/v1/OpenFemaDataSetFields?${q({ $filter: "openFemaDataSet eq 'HmaSubapplications'", $top: 1000 })}`)).json();
writeFileSync(`${OUT}/fields.json`, JSON.stringify(f.OpenFemaDataSetFields.map((r) => ({ name: r.name, desc: r.description })), null, 1));
writeFileSync(`${OUT}/log.txt`, log.join('\n')); console.log(log.join('\n'));
JS
node /tmp/p3.mjs
