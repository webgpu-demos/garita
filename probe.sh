set -u
cd "$OUT"
curl -sS -m 120 "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml" -o cap.xml
python3 - <<'PY' > layers.txt
import re
s=open('cap.xml',encoding='utf8').read()
for lid in ['VIIRS_SNPP_DayNightBand_At_Sensor_Radiance','VIIRS_NOAA20_DayNightBand_At_Sensor_Radiance','VIIRS_SNPP_DayNightBand_ENCC','VIIRS_Black_Marble','VIIRS_SNPP_DayNightBand_AtSensor_M15','VIIRS_NOAA20_DayNightBand_ENCC']:
    m=re.search(r'<Layer>(?:(?!</Layer>).)*?<ows:Identifier>'+re.escape(lid)+r'</ows:Identifier>.*?</Layer>',s,re.S)
    if not m: print(lid,'NOT FOUND'); continue
    b=m.group(0)
    print(lid)
    print('  matrix',re.findall(r'<TileMatrixSet>(.*?)</TileMatrixSet>',b))
    print('  format',re.findall(r'<Format>(.*?)</Format>',b))
    print('  dims',re.findall(r'<Default>(.*?)</Default>',b),[v[:200] for v in re.findall(r'<Value>(.*?)</Value>',b)][:12])
    print('  res',re.findall(r'<ResourceURL[^>]*template="([^"]*)"',b))
print([x for x in re.findall(r'<ows:Identifier>(.*?)</ows:Identifier>',s) if 'DayNight' in x or 'Black_Marble' in x or 'Night' in x])
PY
rm -f cap.xml
t() { echo "== $1"; curl -sS -m 40 -o body.bin -D - -H "Origin: https://webgpu-demos.github.io" "$1" | grep -i "^HTTP\|content-type\|access-control\|content-length\|location"; head -c 200 body.bin | tr -c '[:print:]' '.'; echo; }
B=https://gibs.earthdata.nasa.gov/wmts/epsg3857/best
{
t "$B/VIIRS_SNPP_DayNightBand_ENCC/default/2017-09-25/GoogleMapsCompatible_Level8/6/28/20.png"
t "$B/VIIRS_SNPP_DayNightBand_ENCC/default/2017-09-15/GoogleMapsCompatible_Level8/6/28/20.png"
t "$B/VIIRS_SNPP_DayNightBand_ENCC/default/2017-09-25/GoogleMapsCompatible_Level7/6/28/20.png"
t "$B/VIIRS_SNPP_DayNightBand_ENCC/default/2022-09-20/GoogleMapsCompatible_Level8/6/28/20.png"
t "$B/VIIRS_SNPP_DayNightBand_ENCC/default/2017-09-25/GoogleMapsCompatible_Level8/7/57/40.png"
t "$B/VIIRS_SNPP_DayNightBand_At_Sensor_Radiance/default/2022-09-20/GoogleMapsCompatible_Level8/6/28/20.png"
t "$B/VIIRS_SNPP_DayNightBand_At_Sensor_Radiance/default/2026-10-11/GoogleMapsCompatible_Level8/6/28/20.png"
t "$B/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/6/28/20.png"
} > tiles.txt 2>&1
for d in 2017-09-15 2017-09-25 2022-09-20; do curl -sS -m 40 -o encc-$d.png "$B/VIIRS_SNPP_DayNightBand_ENCC/default/$d/GoogleMapsCompatible_Level8/6/28/20.png"; done
curl -sS -m 40 -o rad-2026-10-10.png "$B/VIIRS_SNPP_DayNightBand_At_Sensor_Radiance/default/2026-10-10/GoogleMapsCompatible_Level8/6/28/20.png"
rm -f body.bin
