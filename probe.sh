set -x
cd "$(mktemp -d)"
UA='garita (github.com/webgpu-demos/garita)'
curl -sSL -A "$UA" -o pr.zip https://www.nhc.noaa.gov/gis/hazardmaps/PR_SLOSH_MOM_Inundation.zip
ls -la pr.zip; sha256sum pr.zip
mkdir z && cd z && unzip -o -q ../pr.zip && cd ..
find z -type f -printf '%s %p\n' | sort -k2 > $OUT/files.txt
cat $OUT/files.txt
# keep small sidecars
mkdir -p $OUT/side
find z -type f ! -iname '*.tif' -size -400k -exec cp {} $OUT/side/ \;
pip install -q rasterio numpy pillow 2>&1 | tail -2
cat > p.py <<'PY'
import rasterio, numpy as np, glob, json, sys, os
from rasterio.warp import transform
out=os.environ['OUT']
spots=[("Catano waterfront",18.4445,-66.1180),("Loiza Pinones",18.4440,-65.9300),("La Parguera",17.9735,-67.0460),("Ponce Playa",17.9810,-66.6190),("Old San Juan hill",18.4665,-66.1170),("Caguas inland",18.2340,-66.0350),("Isabel Segunda Vieques",18.1490,-65.4430),("Esperanza Vieques",18.0950,-65.4710),("Dewey Culebra",18.3030,-65.3010),("Mayaguez waterfront",18.2010,-67.1500),("Fajardo Puerto Real",18.3350,-65.6300),("Mona island",18.0860,-67.8900)]
res={}
for f in sorted(glob.glob('z/**/*.tif',recursive=True)):
    with rasterio.open(f) as d:
        r={'crs':str(d.crs),'wkt':d.crs.to_wkt() if d.crs else None,'transform':list(d.transform)[:6],'w':d.width,'h':d.height,'bounds':list(d.bounds),'dtype':d.dtypes,'nodata':d.nodata,'count':d.count,'colorinterp':[str(c) for c in d.colorinterp],'block':d.block_shapes,'compress':str(d.compression),'tags':d.tags(),'btags':d.tags(1),'overviews':d.overviews(1)}
        try: r['colormap']={k:v for k,v in d.colormap(1).items() if v!=(0,0,0,255)}
        except Exception as e: r['colormap']=str(e)
        a=d.read(1)
        v,c=np.unique(a,return_counts=True)
        r['values']={int(x):int(y) for x,y in zip(v,c)}
        if d.crs:
            from rasterio.warp import transform_bounds
            r['bounds4326']=list(transform_bounds(d.crs,'EPSG:4326',*d.bounds))
            xs,ys=transform('EPSG:4326',d.crs,[s[2] for s in spots],[s[1] for s in spots])
            sp={}
            for (n,la,lo),x,y in zip(spots,xs,ys):
                row,col=d.index(x,y)
                sp[n]=int(a[row,col]) if 0<=row<d.height and 0<=col<d.width else 'outside'
                # also max in 5x5 neighbourhood
                if 0<=row<d.height and 0<=col<d.width:
                    w=a[max(0,row-3):row+4,max(0,col-3):col+4]; sp[n]=[sp[n],sorted(set(int(q) for q in np.unique(w)))]
            r['spots']=sp
            # data extent (where value not nodata/0)
            nd=d.nodata
            m=(a!=nd) if nd is not None else np.ones_like(a,bool)
            rows=np.where(m.any(1))[0]; cols=np.where(m.any(0))[0]
            r['valid_rows']=[int(rows[0]),int(rows[-1])]; r['valid_cols']=[int(cols[0]),int(cols[-1])]
            wet=(a>0)&m
            # wet extent in lon: per 0.25deg column bins count of wet cells east of -65.6 (Vieques/Culebra)
            b=d.bounds
            x0,y0=transform('EPSG:4326',d.crs,[-65.6,-65.2],[18.05,18.37])
            r0,c0=d.index(x0[0],y0[1]); r1,c1=d.index(x0[1],y0[0])
            r['east_islands_window']=[r0,c0,r1,c1]
            sub=a[max(0,min(r0,r1)):max(r0,r1),max(0,min(c0,c1)):max(c0,c1)]
            vv,cc=np.unique(sub,return_counts=True); r['east_islands_values']={int(x):int(y) for x,y in zip(vv,cc)}
        res[os.path.basename(f)]=r
json.dump(res,open(out+'/rasters.json','w'),indent=1,default=str)
print(json.dumps(res,indent=1,default=str)[:6000])
PY
python3 p.py
# legend colours of the NHC viewer
cat > v.py <<'PY'
import urllib.request, json, re, os
out=os.environ['OUT']
def get(u):
    try:
        req=urllib.request.Request(u,headers={'User-Agent':'garita (github.com/webgpu-demos/garita)'})
        return urllib.request.urlopen(req,timeout=40).read()
    except Exception as e:
        return ('ERR '+str(e)).encode()
seen=set(); urls=set(); log=[]
def item(i,depth=0):
    if i in seen or depth>3: return
    seen.add(i)
    info=get(f'https://www.arcgis.com/sharing/rest/content/items/{i}?f=json').decode('utf-8','replace')
    data=get(f'https://www.arcgis.com/sharing/rest/content/items/{i}/data?f=json').decode('utf-8','replace')
    open(f'{out}/item_{i}_info.json','w').write(info); open(f'{out}/item_{i}_data.json','w').write(data[:400000])
    try: j=json.loads(info); log.append((i,j.get('type'),j.get('title'),j.get('url')))
    except Exception: log.append((i,'?',info[:100]))
    for t in (info,data):
        for u in re.findall(r'https?://[^"\\ ]+?/(?:MapServer|ImageServer|FeatureServer|VectorTileServer)',t): urls.add(u)
        for k in set(re.findall(r'\b[0-9a-f]{32}\b',t)): item(k,depth+1)
item('203f772571cb48b1b8b50fdcc3272e2c')
open(out+'/viewer_items.txt','w').write('\n'.join(map(str,log)))
n=0
for u in sorted(urls):
    n+=1
    for suf,name in (('?f=json','svc'),('/legend?f=json','legend')):
        b=get(u+suf)
        open(f'{out}/svc{n:02d}_{name}.json','wb').write(b[:300000])
    open(f'{out}/svc{n:02d}_url.txt','w').write(u)
print(log); print(sorted(urls))
PY
python3 v.py
ls -la $OUT
