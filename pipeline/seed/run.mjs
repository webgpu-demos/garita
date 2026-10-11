// Seed pipeline runner: node pipeline/seed/run.mjs --out out [--only a,b] [--skip a,b] [--report report.json]
// Each source builds IngestBatches independently; a failing source is recorded in the report and the others continue.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { validateBatch } from '../../src/ontology/validate.ts';
import { stats } from './lib.mjs';
import { fetchMunicipios } from './sources/census_tiger.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ontology = JSON.parse(readFileSync(join(here, '../../src/ontology/ontology.json'), 'utf8'));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const out = arg('out', 'out'), only = arg('only', '').split(',').filter(Boolean), skip = arg('skip', '').split(',').filter(Boolean), reportName = arg('report', 'report.json');
const seedDir = join(out, 'data/seed'), replayDir = join(out, 'data/replay'), probeDir = join(seedDir, '_probe');
for (const d of [seedDir, replayDir, probeDir]) mkdirSync(d, { recursive: true });

// Chains run in parallel (different hosts); sources inside a chain run in order.
const CHAINS = [['census_tiger', 'hurdat2'], ['hud', 'cdbg'], ['openfema', 'nfip', 'fema_recovery'], ['coops', 'ndbc'], ['usgs', 'nwps'], ['nws', 'luma'], ['cdc_svi'], ['shelters'], ['census_acs']];
const report = { startedAt: new Date().toISOString(), ontologyVersion: ontology.version, sources: {}, replay: [] };
const probes = {};
let muniP = null;
const mkctx = (name) => ({
  tmp: join(tmpdir(), 'garita-seed'),
  log: (m) => console.log(`[${name}] ${m}`),
  probe: (k, v) => { probes[k] = v; },
  writeProbeFile: (f, text) => writeFileSync(join(probeDir, f), text),
  writeReplay: (f, data) => { writeFileSync(join(replayDir, f), JSON.stringify(data)); report.replay.push({ file: `data/replay/${f}`, by: name, bytes: JSON.stringify(data).length }); },
  municipios: () => (muniP ||= fetchMunicipios({ log: (m) => console.log(`[municipios] ${m}`) })),
  usgsType: usgsType,
});
const usgsType = new Map();

async function runSource(name) {
  const t0 = Date.now();
  const rep = (report.sources[name] = { status: 'ok', files: [], objects: {}, links: 0, problems: [] });
  try {
    const mod = await import(`./sources/${name}.mjs`);
    const res = [await mod.build(mkctx(name))].flat().filter(Boolean);
    for (const r of res) {
      if (r.error) { rep.status = 'partial'; rep.problems.push(`${r.file}: ${r.error.message}`); console.error(`[${name}] ${r.file} FAILED`, r.error); continue; }
      const b = r.batch;
      const probs = validateBatch(b, ontology, { maxProblems: 30 });
      const errors = probs.filter((p) => p.level === 'error');
      const counts = {};
      for (const o of b.objects || []) counts[o.type] = (counts[o.type] || 0) + 1;
      const f = { file: `data/seed/${r.file}.batch.json`, source: b.source, objects: counts, links: (b.links || []).length, validationErrors: errors.length, validationWarnings: probs.length - errors.length, published: errors.length === 0, note: b.note };
      rep.files.push(f);
      for (const [k, v] of Object.entries(counts)) rep.objects[k] = (rep.objects[k] || 0) + v;
      rep.links += (b.links || []).length;
      rep.problems.push(...(r.problems || []).slice(0, 60), ...probs.map((p) => `${p.level} ${p.where}: ${p.message}`));
      if (errors.length) { rep.status = 'partial'; console.error(`[${name}] ${r.file}: ${errors.length} validation errors, not published`, errors.slice(0, 5)); continue; }
      writeFileSync(join(seedDir, `${r.file}.batch.json`), JSON.stringify(b));
      console.log(`[${name}] wrote ${r.file}: ${JSON.stringify(counts)} links ${(b.links || []).length}`);
    }
    if (rep.status === 'partial' && !rep.files.some((f) => f.published)) rep.status = 'error';
  } catch (e) {
    rep.status = 'error'; rep.error = String(e?.stack || e).slice(0, 1500);
    console.error(`[${name}] FAILED`, e);
  }
  rep.ms = Date.now() - t0;
}
const wanted = (n) => (only.length ? only.includes(n) : !skip.includes(n));
await Promise.all(CHAINS.map(async (chain) => { for (const n of chain) if (wanted(n)) await runSource(n); }));
report.finishedAt = new Date().toISOString(); report.requests = stats.requests; report.bytes = stats.bytes;
writeFileSync(join(seedDir, reportName), JSON.stringify(report, null, 1));
writeFileSync(join(probeDir, reportName.replace('report', 'probe')), JSON.stringify(probes, null, 1));
console.log(JSON.stringify(Object.fromEntries(Object.entries(report.sources).map(([k, v]) => [k, { status: v.status, objects: v.objects, links: v.links, problems: v.problems.length, error: v.error?.split('\n')[0] }])), null, 1));
