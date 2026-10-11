set -x
UA="garita (github.com/webgpu-demos/garita)"
# --- NHC storm surge risk maps: download links
curl -sL -A "$UA" https://www.nhc.noaa.gov/nationalsurge/ -o $OUT/nhc_page.html
grep -oiE '(href|src)="[^"]+"' $OUT/nhc_page.html | grep -iE 'zip|tif|arcgis|mapserver|imageserver|tiles|pr_|puerto|hazardmap' | sort -u > $OUT/nhc_links.txt
for u in https://www.nhc.noaa.gov/gis/hazardmaps/PR_SLOSH_MOM_Inundation.zip https://www.nhc.noaa.gov/gis/hazardmaps/Puerto_Rico_SLOSH_MOM_Inundation.zip; do curl -sIL -A "$UA" "$u" | grep -iE '^HTTP|content-length|content-type|last-modified' | tr '\n' ' '; echo " <- $u"; done > $OUT/nhc_head.txt 2>&1
# --- USGS 1 m DEM products over Puerto Rico (TNM Access API)
curl -sL -A "$UA" "https://tnmaccess.nationalmap.gov/api/v1/products?datasets=Digital%20Elevation%20Model%20(DEM)%201%20meter&bbox=-67.35,17.85,-65.2,18.55&max=500&outputFormat=JSON" -o $OUT/tnm_1m.json
python3 - <<'PY' > $OUT/tnm_1m_summary.txt 2>&1
import json,os,collections
j=json.load(open(os.environ['OUT']+'/tnm_1m.json'))
items=j.get('items',[]); print('total',j.get('total'),'returned',len(items))
proj=collections.Counter(); size=0
for it in items:
    u=it.get('downloadURL',''); size+=it.get('sizeInBytes') or 0
    proj['/'.join(u.split('/')[:-2])]+=1
print('total bytes',size)
for k,v in proj.most_common(): print(v,k)
for it in items[:5]: print({k:it.get(k) for k in ('title','downloadURL','sizeInBytes','format','publicationDate','boundingBox')})
PY
curl -sL -A "$UA" "https://prd-tnm.s3.amazonaws.com/?list-type=2&prefix=StagedProducts/Elevation/1m/Projects/PR&delimiter=/" -o $OUT/s3_1m_projects.xml
curl -sL -A "$UA" "https://tnmaccess.nationalmap.gov/api/v1/datasets" -o $OUT/tnm_datasets.json
# 3DEP dynamic service: what is the best resolution at a point in San Juan?
curl -sL -A "$UA" "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples?geometry=%7B%22points%22%3A%5B%5B-66.105%2C18.455%5D%2C%5B-66.13%2C18.44%5D%5D%2C%22spatialReference%22%3A%7B%22wkid%22%3A4326%7D%7D&geometryType=esriGeometryMultipoint&returnFirstValueOnly=true&f=json" -o $OUT/3dep_getsamples.json
# --- USGS landslide susceptibility, Puerto Rico (ScienceBase)
curl -sL -A "$UA" "https://www.sciencebase.gov/catalog/item/5e2f53f5e4b0a79317d42330?format=json" -o $OUT/sb_item.json
python3 - <<'PY' > $OUT/sb_summary.txt 2>&1
import json,os
j=json.load(open(os.environ['OUT']+'/sb_item.json'))
print(j.get('title')); print(j.get('citation')); print([l for l in j.get('webLinks',[])][:8])
for f in j.get('files',[]): print(f.get('name'),f.get('size'),f.get('downloadUri') or f.get('url'))
print('hasChildren',j.get('hasChildren'), j.get('link'))
for fct in j.get('facets',[]): print('facet',{k:fct.get(k) for k in ('className','name','boundingBox','nativeCrs','rasterType','cellCount')}, [ (f.get('name'),f.get('size')) for f in fct.get('files',[])][:6])
PY
curl -sL -A "$UA" "https://www.sciencebase.gov/catalog/items?parentId=5e2f53f5e4b0a79317d42330&format=json&max=50&fields=title,files,webLinks" -o $OUT/sb_children.json
curl -sL -A "$UA" "https://www.sciencebase.gov/catalog/items?q=Puerto%20Rico%20landslide%20susceptibility&format=json&max=20&fields=title,files,citation" -o $OUT/sb_search.json
# --- NASA GIBS: night lights layers
curl -sL -A "$UA" "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml" -o /tmp/caps.xml
python3 - <<'PY' > $OUT/gibs_night_layers.txt 2>&1
import re
x=open('/tmp/caps.xml',encoding='utf8',errors='ignore').read()
print('capabilities bytes',len(x))
for m in re.finditer(r'<Layer>.*?</Layer>', x, re.S):
    b=m.group(0)
    idm=re.search(r'<ows:Identifier>([^<]+)</ows:Identifier>', b)
    if not idm: continue
    i=idm.group(1)
    if re.search(r'night|DayNight|Black_Marble|DNB|Lights', i, re.I):
        t=re.search(r'<ows:Title[^>]*>([^<]+)<', b); fm=re.findall(r'<Format>([^<]+)<', b); tms=re.findall(r'<TileMatrixSet>([^<]+)<', b)
        dim=re.search(r'<Dimension>.*?</Dimension>', b, re.S); d=''
        if dim:
            dd=re.search(r'<Default>([^<]+)<', dim.group(0)); vv=re.findall(r'<Value>([^<]+)<', dim.group(0)); d=f"default {dd.group(1) if dd else None} values {vv[:2]}..{vv[-2:]}"
        res=re.search(r'<ResourceURL[^>]*resourceType="tile"[^>]*template="([^"]+)"', b)
        print(i,'|',t.group(1) if t else '','|',fm,'|',tms,'|',d,'|',res.group(1) if res else '')
PY
for L in VIIRS_SNPP_DayNightBand_At_Sensor_Radiance VIIRS_NOAA20_DayNightBand_At_Sensor_Radiance VIIRS_SNPP_DayNightBand_ENCC VIIRS_Black_Marble; do
  for D in 2026-10-08 2026-10-01 2017-09-25 2016-01-01; do
    curl -s -o /tmp/t.png -D - -H "Origin: https://webgpu-demos.github.io" "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/$L/default/$D/GoogleMapsCompatible_Level8/7/57/40.png" | grep -iE '^HTTP|content-type|access-control-allow-origin|content-length' | tr '\r\n' '  '; echo " <- $L $D $(stat -c %s /tmp/t.png)"
  done
done > $OUT/gibs_tiles.txt 2>&1
cp /tmp/t.png $OUT/last_tile.png 2>/dev/null
ls -la $OUT
