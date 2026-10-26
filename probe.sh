#!/usr/bin/env bash
# Point clouds for Puerto Rico: USGS EPT on AWS (usgs-lidar-public), LPC projects on prd-tnm; classes, density, a sample read.
set -u
date -u
echo "== usgs-lidar-public prefixes with PR"
curl -sS -m 120 "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/?list-type=2&delimiter=/" > /tmp/l1.xml
grep -o '<Prefix>[^<]*</Prefix>' /tmp/l1.xml | sed 's/<[^>]*>//g' | grep -iE '^PR_|PuertoRico|PRVI' | head -40
grep -c '<Prefix>' /tmp/l1.xml; grep -o '<IsTruncated>[^<]*' /tmp/l1.xml
# the listing pages at 1000: walk it
TOKEN=$(grep -o '<NextContinuationToken>[^<]*' /tmp/l1.xml | sed 's/<NextContinuationToken>//')
while [ -n "$TOKEN" ]; do
  curl -sS -m 120 "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/?list-type=2&delimiter=/&continuation-token=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$TOKEN")" > /tmp/l2.xml
  grep -o '<Prefix>[^<]*</Prefix>' /tmp/l2.xml | sed 's/<[^>]*>//g' | grep -iE '^PR_|PuertoRico|PRVI' | head -40
  TOKEN=$(grep -o '<NextContinuationToken>[^<]*' /tmp/l2.xml | sed 's/<NextContinuationToken>//')
done
echo "== prd-tnm LPC projects for PR"
curl -sS -m 120 "https://prd-tnm.s3.amazonaws.com/?list-type=2&prefix=StagedProducts/Elevation/LPC/Projects/PR&delimiter=/" | grep -o '<Prefix>[^<]*</Prefix>' | sed 's/<[^>]*>//g' | head -20
curl -sS -m 120 "https://prd-tnm.s3.amazonaws.com/?list-type=2&prefix=StagedProducts/Elevation/LPC/Projects/PR_PuertoRicoUSVI_D24/&delimiter=/" | grep -o '<Prefix>[^<]*</Prefix>' | sed 's/<[^>]*>//g' | head -20
for ept in PR_PuertoRicoUSVI_D24 PR_PRVI_A_2018 PR_PRVI_D_2018; do
  echo "== ept $ept"; curl -sS -m 60 "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/$ept/ept.json" | head -c 1500; echo
done
date -u
