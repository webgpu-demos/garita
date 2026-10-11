set -u
cd "$OUT"
curl -sS -m 120 "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml" -o cap.xml
python3 - <<'PY' > layers.txt
import re
s=open('cap.xml',encoding='utf8').read()
for lid in ['VIIRS_SNPP_DayNightBand','VIIRS_Night_Lights','VIIRS_SNPP_GapFilled_BRDF_Corrected_DayNightBand_Radiance','VIIRS_NOAA20_GapFilled_BRDF_Corrected_DayNightBand_Radiance']:
    m=re.search(r'<Layer>(?:(?!</Layer>).)*?<ows:Identifier>'+re.escape(lid)+r'</ows:Identifier>.*?</Layer>',s,re.S)
    if not m: print(lid,'NOT FOUND'); continue
    b=m.group(0)
    print(lid)
    print('  title',re.findall(r'<ows:Title[^>]*>(.*?)</ows:Title>',b)[:2])
    print('  matrix',re.findall(r'<TileMatrixSet>(.*?)</TileMatrixSet>',b))
    print('  format',re.findall(r'<Format>(.*?)</Format>',b))
    print('  dims',re.findall(r'<Default>(.*?)</Default>',b),[v[:200] for v in re.findall(r'<Value>(.*?)</Value>',b)][:30])
    print('  meta',re.findall(r'xlink:href="([^"]*)"',b)[:6])
PY
rm -f cap.xml
t() { echo "== $1"; curl -sS -m 40 -o body.bin -D - -H "Origin: https://webgpu-demos.github.io" "$1" | grep -i "^HTTP\|content-type\|access-control-allow\|content-length"; }
B=https://gibs.earthdata.nasa.gov/wmts/epsg3857/best
{
for d in 2017-09-15 2017-09-20 2017-09-25 2017-09-26 2017-10-05 2017-01-15 2018-03-01 2019-06-01 2020-06-01 2021-01-01 2022-09-17 2022-09-20 2023-07-01; do t "$B/VIIRS_SNPP_DayNightBand_ENCC/default/$d/GoogleMapsCompatible_Level8/6/28/20.png"; done
for L in VIIRS_SNPP_DayNightBand VIIRS_SNPP_GapFilled_BRDF_Corrected_DayNightBand_Radiance; do for d in 2017-09-15 2017-09-25 2022-09-20; do for M in GoogleMapsCompatible_Level8 GoogleMapsCompatible_Level7; do t "$B/$L/default/$d/$M/6/28/20.png"; done; done; done
sleep 20
t "$B/VIIRS_SNPP_DayNightBand_ENCC/default/2017-09-25/GoogleMapsCompatible_Level8/6/28/20.png"
} > tiles.txt 2>&1
for d in 2017-09-15 2017-09-25; do for M in 8 7; do curl -sS -m 40 -o gap-$d-L$M.png "$B/VIIRS_SNPP_GapFilled_BRDF_Corrected_DayNightBand_Radiance/default/$d/GoogleMapsCompatible_Level$M/6/28/20.png"; done; done
rm -f body.bin
