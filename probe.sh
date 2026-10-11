set -x
t0=$(date +%s)
nproc; free -g | head -2; df -h . | tail -1
sudo apt-get update -qq && sudo apt-get install -y -qq gdal-bin python3-gdal python3-numpy python3-pil >/dev/null
echo "apt took $(( $(date +%s) - t0 )) s"
gdalinfo --version
B=https://prd-tnm.s3.amazonaws.com
P=StagedProducts/Elevation/1m/Projects
curl -s "$B/?list-type=2&prefix=$P/PR_&delimiter=/" > $OUT/projects.xml
for p in $(grep -o '<Prefix>[^<]*</Prefix>' $OUT/projects.xml | sed 's/<[^>]*>//g' | grep '/$'); do
  n=$(basename $p)
  curl -s "$B/?list-type=2&prefix=${p}&delimiter=/" > $OUT/ls_${n}.xml
  curl -s "$B/?list-type=2&prefix=${p}TIFF/" > $OUT/tiff_${n}.xml
  curl -s "$B/?list-type=2&prefix=${p}metadata/&max-keys=20" > $OUT/meta_${n}.xml
done
export GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.tif
D24=$B/$P/PR_PuertoRicoUSVI_D24/TIFF/USGS_1M_19_x80y205_PR_PuertoRicoUSVI_D24.tif
time gdalinfo -json /vsicurl/$D24 > $OUT/gdalinfo_d24.json
gdalinfo /vsicurl/$D24 > $OUT/gdalinfo_d24.txt
for k in $(grep -oh '<Key>[^<]*x80y205[^<]*\.tif</Key>' $OUT/tiff_*2018*.xml | sed 's/<[^>]*>//g'); do
  n=$(basename $k .tif)
  gdalinfo /vsicurl/$B/$k > $OUT/gdalinfo_$n.txt
  gdalinfo -json /vsicurl/$B/$k > $OUT/gdalinfo_$n.json
  LAST=$B/$k
done
# sidecar metadata
curl -s "https://thor-f5.er.usgs.gov/ngtoc/metadata/waf/elevation/1_meter/geotiff/PR_PuertoRicoUSVI_D24/USGS_1M_19_x80y205_PR_PuertoRicoUSVI_D24.xml" -m 30 > $OUT/vendor_meta_d24.xml
# timing: download + read
time curl -s -o /tmp/d24.tif $D24; ls -l /tmp/d24.tif
time curl -s -o /tmp/o18.tif $LAST; ls -l /tmp/o18.tif
python3 - <<'PY'
import time
from osgeo import gdal, osr
import numpy as np
for f in ('/tmp/d24.tif','/tmp/o18.tif'):
    t=time.time(); ds=gdal.Open(f); b=ds.GetRasterBand(1)
    a=b.ReadAsArray(); nd=b.GetNoDataValue()
    print(f, a.shape, a.dtype, 'nodata', nd, 'read %.1f s'%(time.time()-t), 'valid share', float((a!=nd).mean()), 'min', float(a[a!=nd].min()), 'max', float(a.max()))
    print(' gt', ds.GetGeoTransform(), 'unit', repr(b.GetUnitType()), 'desc', repr(b.GetDescription()), 'block', b.GetBlockSize(), 'ovr', b.GetOverviewCount())
    s=ds.GetSpatialRef(); print(' compound', s.IsCompound(), 'name', s.GetName(), 'utm', s.GetUTMZone(), 'auth', s.GetAuthorityCode(None), 'vert', s.GetAttrValue('VERT_CS'), s.GetAttrValue('VERT_DATUM'))
    print(' md', ds.GetMetadata(), b.GetMetadata())
    # value near (-66.105, 18.455)
    w=osr.SpatialReference(); w.ImportFromEPSG(4326); w.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    h=s.Clone(); 
    if h.IsCompound(): h.StripVertical()
    h.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    ct=osr.CoordinateTransformation(w,h)
    for lon,lat in ((-66.105,18.455),(-66.1165,18.4655),(-66.13,18.44)):
        e,n,_=ct.TransformPoint(lon,lat); gt=ds.GetGeoTransform()
        c=int((e-gt[0])/gt[1]); r=int((n-gt[3])/gt[5])
        if 2<=c<a.shape[1]-2 and 2<=r<a.shape[0]-2: print('  pt',lon,lat,'EN',round(e,2),round(n,2),'rc',r,c, a[r-2:r+3,c-2:c+3].round(2).tolist())
        else: print('  pt',lon,lat,'EN',round(e,2),round(n,2),'outside')
PY
echo "total $(( $(date +%s) - t0 )) s"
