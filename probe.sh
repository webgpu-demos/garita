set -x
ID=61087009d34ef8d70565c154
mkdir -p /tmp/w && cd /tmp/w
time curl -sSL -m 300 "https://www.sciencebase.gov/catalog/file/get/$ID" -o all.zip
unzip -q all.zip; D=landslide_susceptibility_raster
cp $D/*.tfw $D/*.aux.xml $D/*.SLD $D/*.dbf $D/*.cpg $D/*.lyr "$OUT"/
time pip install -q rasterio pillow numpy pypdf 2>&1 | tail -2
python3 - <<'PY'
import rasterio, numpy as np, time, struct
t=time.time()
ds=rasterio.open('landslide_susceptibility_raster/landslide_susceptibility_raster.tif')
print('PROFILE',ds.profile); print('CRS',ds.crs.to_wkt()); print('EPSG',ds.crs.to_epsg()); print('BOUNDS',ds.bounds); print('RES',ds.res); print('NODATA',ds.nodata,'DTYPES',ds.dtypes, 'TAGS',ds.tags(), ds.tags(1))
try: print('COLORMAP',{k:v for k,v in ds.colormap(1).items() if k<20 or k>250})
except Exception as e: print('no colormap',e)
print('colorinterp',ds.colorinterp, 'block',ds.block_shapes, 'overviews',ds.overviews(1))
a=ds.read(1); print('read %.1fs'%(time.time()-t), a.shape, a.dtype)
v,c=np.unique(a,return_counts=True); print('VALUES',dict(zip(v.tolist(),c.tolist())))
tot=c[(v>=1)&(v<=5)].sum(); print('SHARES',{int(k):round(100*n/tot,2) for k,n in zip(v,c) if 1<=k<=5})
# dbf
b=open('landslide_susceptibility_raster/landslide_susceptibility_raster.tif.vat.dbf','rb').read(); print('DBF',b)
PY
cat $D/*.SLD; echo; cat $D/*.aux.xml; echo; strings -n 3 $D/*.lyr | head -80; strings -el -n 3 $D/*.lyr | head -120
cd "$OUT"
for f in ofr20201022_readme.txt; do curl -sSL -m 60 "https://pubs.usgs.gov/of/2020/1022/$f" -o $f; done
for f in ofr20201022_pamphlet_esp.pdf ofr20201022_sheet.pdf ofr20201022_sheet_esp.pdf ofr20201022_kmz.zip ofr20201022_pamphlet.pdf ofr20201022_sheet_georeferenced.tif; do curl -sSL -m 20 -I "https://pubs.usgs.gov/of/2020/1022/$f" | grep -iE '^HTTP|content-length'; done
cd /tmp/w
curl -sSL -m 120 "https://pubs.usgs.gov/of/2020/1022/ofr20201022_sheet_esp.pdf" -o sheet_esp.pdf
curl -sSL -m 120 "https://pubs.usgs.gov/of/2020/1022/ofr20201022_sheet.pdf" -o sheet.pdf
curl -sSL -m 120 "https://pubs.usgs.gov/of/2020/1022/ofr20201022_pamphlet_esp.pdf" -o pam_esp.pdf
curl -sSL -m 120 "https://pubs.usgs.gov/of/2020/1022/ofr20201022_kmz.zip" -o kmz.zip; unzip -l kmz.zip | head; 
which pdftotext pdftoppm || sudo apt-get install -y -qq poppler-utils >/dev/null 2>&1
pdftotext -layout sheet_esp.pdf "$OUT/sheet_esp.txt"; pdftotext -layout sheet.pdf "$OUT/sheet.txt"
pdftotext -layout -l 12 pam_esp.pdf "$OUT/pam_esp_p1-12.txt"
pdftoppm -r 40 -jpeg -jpegopt quality=80 sheet.pdf "$OUT/sheet40"; pdftoppm -r 40 -jpeg -jpegopt quality=80 sheet_esp.pdf "$OUT/sheet_esp40"
pdftoppm -r 150 -png sheet.pdf /tmp/w/sheet150; ls -la /tmp/w
python3 - <<'PY'
# save the full-res render in quarters so the legend can be cropped later
from PIL import Image; import glob,os
Image.MAX_IMAGE_PIXELS=None
f=glob.glob('/tmp/w/sheet150*.png')[0]; im=Image.open(f).convert('RGB'); print(im.size)
W,H=im.size
for i in range(4):
    for j in range(2):
        im.crop((i*W//4,j*H//2,(i+1)*W//4,(j+1)*H//2)).save(os.environ['OUT']+'/sheet150_%d_%d.png'%(i,j))
PY
ls -la "$OUT"
