#!/usr/bin/env bash
set -uo pipefail
cd "$RUNNER_TEMP" 2>/dev/null || cd /tmp
date -u
# releases straight from the bucket listing
curl -s "https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&prefix=release/&delimiter=/" | tr '>' '>\n' | grep -o 'release/[0-9][^<]*' | tee "$OUT/releases.txt" | tail -8
REL=$(tail -1 "$OUT/releases.txt" | sed 's#release/##; s#/##')
echo "latest release: $REL"
curl -s "https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&prefix=release/$REL/theme=buildings/type=building/&max-keys=1000" | tr '>' '>\n' | grep -c '<Size' || true
curl -s "https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&prefix=release/$REL/theme=buildings/type=building/&max-keys=1000" | tr '<' '\n' | grep -E '^(Key|Size)>' | paste - - | awk '{n++; s+=$2} END {print n" files"; }' ; 
curl -s "https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&prefix=release/$REL/theme=buildings/type=building/&max-keys=1000" | tr '<' '\n' | grep -E '^Size>' | sed 's/Size>//' | awk '{s+=$1} END {print s/1e9" GB"}'
curl -sL https://docs.overturemaps.org/attribution/ | sed 's/<[^>]*>/ /g' | tr -s ' \n' | head -c 20000 > "$OUT/attribution.txt"
curl -sL https://stac.overturemaps.org/catalog.json | head -c 3000 > "$OUT/stac_catalog.json"
pip install -q overturemaps duckdb 2>&1 | tail -2
pip show overturemaps | head -3
overturemaps --help | head -30
overturemaps download --help | head -40
T0=$(date +%s)
overturemaps download --bbox=-67.95,17.85,-65.2,18.55 -f geoparquet --type=building -o pr_bld.parquet 2>&1 | tail -5
echo "cli download seconds: $(( $(date +%s) - T0 ))"
ls -l pr_bld.parquet
python3 - <<'PY'
import duckdb, json, os
out=os.environ['OUT']
c=duckdb.connect()
c.execute("install spatial; load spatial;")
f="pr_bld.parquet"
open(out+'/schema.txt','w').write("\n".join(f"{r[0]}\t{r[1]}" for r in c.execute(f"describe select * from read_parquet('{f}')").fetchall()))
print(open(out+'/schema.txt').read())
print('rows', c.execute(f"select count(*) from '{f}'").fetchall())
q=lambda s: c.execute(s).fetchall()
res={}
res['kv_meta']=[(k.decode() if isinstance(k,bytes) else k, (v.decode()[:600] if isinstance(v,bytes) else str(v)[:600])) for k,v in q(f"select key,value from parquet_kv_metadata('{f}')") if (k if isinstance(k,str) else k.decode())!='ARROW:schema']
res['n_sources']=q(f"select len(sources), count(*) from '{f}' group by 1 order by 1")
res['by_first_dataset']=q(f"select sources[1].dataset, count(*), count(sources[1].confidence), min(sources[1].confidence), avg(sources[1].confidence), max(sources[1].confidence), count(height), count(num_floors) from '{f}' group by 1 order by 2 desc")
res['all_datasets']=q(f"select s.dataset, count(*) from (select unnest(sources) s from '{f}') group by 1 order by 2 desc")
res['dataset_combos']=q(f"select list_transform(sources, x->x.dataset)::varchar, count(*) from '{f}' group by 1 order by 2 desc limit 20")
res['source_property']=q(f"select s.dataset, s.property, count(*) from (select unnest(sources) s from '{f}') group by 1,2 order by 3 desc limit 30")
res['license_field']=q(f"select s.dataset, s.license, count(*) from (select unnest(sources) s from '{f}') group by 1,2 order by 3 desc limit 30") if 'license' in open(out+'/schema.txt').read() else None
res['update_time']=q(f"select sources[1].dataset, min(sources[1].update_time), max(sources[1].update_time) from '{f}' group by 1")
res['conf_hist']=q(f"select sources[1].dataset, floor(sources[1].confidence*10)/10 b, count(*) from '{f}' where sources[1].confidence is not null group by 1,2 order by 1,2")
res['height_by_ds']=q(f"select sources[1].dataset, count(*) filter (where height is not null), approx_quantile(height,0.5), min(height), max(height), count(*) filter (where num_floors is not null) from '{f}' group by 1")
res['class_subtype']=q(f"select sources[1].dataset, subtype, class, count(*) from '{f}' group by 1,2,3 order by 4 desc limit 30")
res['geomtype']=q(f"select sources[1].dataset, st_geometrytype(geometry), count(*) from '{f}' group by 1,2 order by 3 desc")
res['area_q']=q(f"select sources[1].dataset, approx_quantile(st_area_spheroid(st_flipcoordinates(geometry)), [0.001,0.01,0.05,0.25,0.5,0.75,0.95,0.99,0.999]) , max(st_area_spheroid(st_flipcoordinates(geometry))) from '{f}' group by 1")
res['area_small']=q(f"select sources[1].dataset, count(*) filter (where a<5), count(*) filter (where a<10), count(*) filter (where a<15), count(*) filter (where a<20), count(*) filter (where a>5000), count(*) filter (where a>20000), count(*) filter (where a>50000) from (select sources, st_area_spheroid(st_flipcoordinates(geometry)) a from '{f}') group by 1")
res['bbox_extent']=q(f"select min(bbox.xmin),min(bbox.ymin),max(bbox.xmax),max(bbox.ymax) from '{f}'")
res['has_parts']=q(f"select has_parts, count(*) from '{f}' group by 1")
res['sample_ml']=[ [str(x)[:500] for x in r] for r in q(f"select id, sources, height, num_floors, subtype, class, st_astext(geometry), version from '{f}' where sources[1].dataset<>'OpenStreetMap' using sample 6")]
res['sample_osm']=[ [str(x)[:500] for x in r] for r in q(f"select id, sources, height, num_floors, subtype, class, names, version from '{f}' where sources[1].dataset='OpenStreetMap' using sample 4")]
res['osm_record_id']=[ [str(x)[:200] for x in r] for r in q(f"select sources[1].record_id from '{f}' where sources[1].dataset='OpenStreetMap' limit 5")]
json.dump(res, open(out+'/overture_probe.json','w'), indent=1, default=str)
print(json.dumps(res, indent=1, default=str)[:12000])
PY
date -u
