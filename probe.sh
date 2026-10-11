set -x
ID=61087009d34ef8d70565c154
cd "$OUT"
curl -sSL -m 60 "https://www.sciencebase.gov/catalog/item/$ID?format=json" -o item.json
python3 - <<'PY'
import json
j=json.load(open('item.json'))
print('KEYS',list(j.keys()))
for k in ('files','facets','distributionLinks','webLinks','extents','hasChildren','parentId','identifiers','dates','citation','purpose','rights','provenance'):
    print('==',k); print(json.dumps(j.get(k),indent=1)[:6000])
PY
curl -sSL -m 60 "https://www.sciencebase.gov/catalog/items?parentId=$ID&format=json&max=50&fields=title,files,webLinks" -o children.json; head -c 2000 children.json; echo
curl -sSL -m 60 "https://www.sciencebase.gov/catalog/item/$(python3 -c "import json;print(json.load(open('item.json')).get('parentId',''))")?format=json" -o parent.json; python3 -c "
import json;j=json.load(open('parent.json'));print('PARENT',j.get('title'),j.get('hasChildren'))"
curl -sSL -m 60 "https://www.sciencebase.gov/catalog/itemLinks?itemId=$ID&format=json" -o links.json; head -c 3000 links.json; echo
# metadata xml
URL=$(python3 -c "
import json;j=json.load(open('item.json'))
for f in j.get('files',[]): 
    if f['name'].endswith('.xml'): print(f['url'])")
curl -sSL -m 60 "$URL" -o meta.xml; wc -c meta.xml
# all-files zip
curl -sSL -m 120 -D zip_head.txt "https://www.sciencebase.gov/catalog/file/get/$ID" -o all.zip; cat zip_head.txt; ls -la all.zip; file all.zip; unzip -l all.zip | head -40
# publication pages
curl -sSL -m 60 "https://pubs.usgs.gov/publication/ofr20201022" -o pub.html; wc -c pub.html
grep -oE 'href="[^"]+"' pub.html | sort -u | grep -iE 'ofr|of/2020|sciencebase|doi|pdf|zip|tif' | head -60
curl -sSL -m 60 "https://pubs.usgs.gov/of/2020/1022/" -o of_index.html; wc -c of_index.html; grep -oE 'href="[^"]+"' of_index.html | sort -u | head -80
curl -sSL -m 60 -I "https://doi.org/10.5066/P990ZP4C" | head -30
