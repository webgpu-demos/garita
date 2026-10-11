set -x
mkdir -p /tmp/w && cd /tmp/w
pip install -q pymupdf pillow 2>&1 | tail -2
for f in sheet sheet_esp pamphlet_esp pamphlet; do curl -sSL -m 200 "https://pubs.usgs.gov/of/2020/1022/ofr20201022_$f.pdf" -o $f.pdf & done; wait; ls -la
python3 - <<'PY'
import fitz, os, json
OUT=os.environ['OUT']
for name in ('sheet','sheet_esp'):
    d=fitz.open(name+'.pdf'); p=d[0]; print(name,'pages',len(d),'rect',p.rect)
    open(f'{OUT}/{name}.txt','w').write(p.get_text())
    words=p.get_text('words')
    keys=['Extremely','Very','High','Moderate','Low','Extremadamente','Muy','Alta','Moderada','Baja','EXPLANATION','EXPLICACI']
    hits=[w for w in words if any(w[4].startswith(k) for k in keys)]
    for w in hits[:80]: print('  W',[round(v,1) for v in w[:4]],w[4])
    # legend: find the tightest cluster containing 'Extremely'/'Extremadamente'
    anchors=[w for w in words if w[4].startswith('Extrem')]
    try: dr=p.get_drawings()
    except Exception as e: dr=[]; print('drawings failed',e)
    print('  drawings',len(dr))
    for a in anchors:
        x0,y0,x1,y1=a[:4]
        box=fitz.Rect(x0-150,y0-120,x1+250,y1+120)
        print('  ANCHOR',[round(v,1) for v in a[:4]],a[4])
        for w in words:
            if fitz.Rect(w[:4]).intersects(box): print('     near',[round(v,1) for v in w[:4]],w[4])
        for g in dr:
            r=g['rect']
            if r.intersects(box) and r.width<120 and r.height<60 and g.get('fill'):
                print('     FILL',[round(v,1) for v in r],'#%02x%02x%02x'%tuple(int(round(c*255)) for c in g['fill'][:3]), g.get('fill_opacity'))
        pix=p.get_pixmap(clip=box,dpi=200); pix.save(f'{OUT}/{name}_legend_{int(x0)}_{int(y0)}.png')
    pix=p.get_pixmap(dpi=30); pix.save(f'{OUT}/{name}_30dpi.png')
for name,n in (('pamphlet_esp',14),('pamphlet',14)):
    d=fitz.open(name+'.pdf'); print(name,'pages',len(d))
    t=''
    for i in range(min(n,len(d))): t+=f'\n\n=== page {i+1} ===\n'+d[i].get_text()
    open(f'{OUT}/{name}_first.txt','w').write(t)
    # table 5 / tabla 5
    for i in range(len(d)):
        tx=d[i].get_text()
        if ('Table 5' in tx or 'Tabla 5' in tx) and ('percentil' in tx.lower()):
            open(f'{OUT}/{name}_table5_p{i+1}.txt','w').write(tx)
PY
ls -la "$OUT"
