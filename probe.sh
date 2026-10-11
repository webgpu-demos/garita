B=https://prd-tnm.s3.amazonaws.com
curl -s -m 120 -o /tmp/WESM.csv $B/StagedProducts/Elevation/metadata/WESM.csv; ls -l /tmp/WESM.csv
head -1 /tmp/WESM.csv > $OUT/wesm_pr.csv
grep -E '(^|,)PR_' /tmp/WESM.csv >> $OUT/wesm_pr.csv
curl -s "$B/?list-type=2&prefix=StagedProducts/Elevation/metadata/PR_&delimiter=/" > $OUT/meta_projects.xml
for p in $(grep -o '<Prefix>[^<]*</Prefix>' $OUT/meta_projects.xml | sed 's/<[^>]*>//g' | grep '/$'); do
  n=$(basename $p); curl -s "$B/?list-type=2&prefix=${p}&max-keys=300" | grep -o '<Key>[^<]*</Key>' | sed 's/<[^>]*>//g' > $OUT/metatree_${n}.txt
done
# sidecar xml on S3 for one D24 tile and one 2018 tile
curl -s -o $OUT/s3meta_d24.xml $B/StagedProducts/Elevation/1m/Projects/PR_PuertoRicoUSVI_D24/metadata/USGS_1M_19_x80y205_PR_PuertoRicoUSVI_D24.xml
curl -s -o $OUT/s3meta_2018E.xml $B/StagedProducts/Elevation/1m/Projects/PR_PRVI_E_2018/metadata/USGS_1m_x80y205_PR_PRVI_E_2018.xml
# first xml found in each metadata tree that looks like project metadata
for f in $OUT/metatree_*.txt; do
  k=$(grep -iE '\.xml$' $f | head -1); [ -n "$k" ] && curl -s -o "$OUT/$(basename $f .txt)_first.xml" "$B/$k"
done
# TIFF tags of a tile, raw (GeoKeys incl. vertical)
sudo apt-get install -y -qq libtiff-tools >/dev/null 2>&1
curl -s -r 0-65535 -o /tmp/h.tif $B/StagedProducts/Elevation/1m/Projects/PR_PuertoRicoUSVI_D24/TIFF/USGS_1M_19_x80y205_PR_PuertoRicoUSVI_D24.tif
tiffinfo /tmp/h.tif > $OUT/tiffinfo_d24.txt 2>&1 | head -5
strings -n 6 /tmp/h.tif | head -40 > $OUT/strings_d24.txt
