#!/usr/bin/env bash
set +e
B=https://www.fema.gov/api/open
g() { curl -sS -m 170 -A 'garita (github.com/webgpu-demos/garita)' -w '\n#HTTP %{http_code} %{time_total}s %{size_download}B\n' "$@"; }
# dataset metadata
g -G "$B/v1/OpenFemaDataSets" --data-urlencode '$select=name,title,version,deprecated,recordCount,lastRefresh,lastDataSetRefresh,landingPage,webService,accrualPeriodicity,depApiMessage,depNewURL' --data-urlencode '$top=1000' > $OUT/datasets.json
for d in FimaNfipClaims FimaNfipPolicies PublicAssistanceFundedProjectsDetails HazardMitigationAssistanceProjects PublicAssistanceFundedProjectsSummaries HazardMitigationAssistanceProjectsByNfipCrsCommunities; do
  g -G "$B/v1/OpenFemaDataSetFields" --data-urlencode "\$filter=openFemaDataSet eq '$d'" --data-urlencode '$select=openFemaDataSet,datasetVersion,name,type,description,isSearchable' --data-urlencode '$top=1000' > $OUT/fields.$d.json
done
# counts + samples
t() { n=$1; shift; s=$(date +%s.%N); g "$@" > $OUT/$n; e=$(date +%s.%N); echo "$n $(echo "$e - $s" | bc)s $(wc -c < $OUT/$n)B" >> $OUT/timing.txt; }
t claims.sample.json -G "$B/v2/FimaNfipClaims" --data-urlencode "\$filter=state eq 'PR'" --data-urlencode '$top=5' --data-urlencode '$inlinecount=allpages'
t claims.count2.json -G "$B/v2/FimaNfipClaims" --data-urlencode "\$filter=state eq 'PR'" --data-urlencode '$top=1' --data-urlencode '$count=true'
t policies.sample.json -G "$B/v2/FimaNfipPolicies" --data-urlencode "\$filter=propertyState eq 'PR'" --data-urlencode '$top=5' --data-urlencode '$inlinecount=allpages'
t policies.count2.json -G "$B/v2/FimaNfipPolicies" --data-urlencode "\$filter=propertyState eq 'PR'" --data-urlencode '$top=1' --data-urlencode '$count=true'
t pa.sample.json -G "$B/v2/PublicAssistanceFundedProjectsDetails" --data-urlencode "\$filter=stateAbbreviation eq 'PR'" --data-urlencode '$top=5' --data-urlencode '$inlinecount=allpages'
t pa.sample1.json -G "$B/v1/PublicAssistanceFundedProjectsDetails" --data-urlencode "\$filter=stateCode eq 'PR'" --data-urlencode '$top=5' --data-urlencode '$inlinecount=allpages'
t hma.sample.json -G "$B/v4/HazardMitigationAssistanceProjects" --data-urlencode "\$filter=state eq 'Puerto Rico'" --data-urlencode '$top=5' --data-urlencode '$inlinecount=allpages'
t hma.sample3.json -G "$B/v3/HazardMitigationAssistanceProjects" --data-urlencode "\$filter=state eq 'Puerto Rico'" --data-urlencode '$top=5' --data-urlencode '$inlinecount=allpages'
# paging time: one 10000 page of claims, with a narrow select
t claims.page.json -G "$B/v2/FimaNfipClaims" --data-urlencode "\$filter=state eq 'PR'" --data-urlencode '$select=id,countyCode,censusTract,dateOfLoss,yearOfLoss,amountPaidOnBuildingClaim,amountPaidOnContentsClaim,amountPaidOnIncreasedCostOfComplianceClaim' --data-urlencode '$top=10000'
head -c 1500 $OUT/claims.page.json > $OUT/claims.page.head.txt; tail -c 300 $OUT/claims.page.json >> $OUT/claims.page.head.txt; rm $OUT/claims.page.json
# policies in force candidates
t policies.inforce.json -G "$B/v2/FimaNfipPolicies" --data-urlencode "\$filter=propertyState eq 'PR' and policyTerminationDate ge '2025-01-01T00:00:00.000Z'" --data-urlencode '$top=3' --data-urlencode '$inlinecount=allpages' --data-urlencode '$orderby=policyEffectiveDate desc'
t policies.latest.json -G "$B/v2/FimaNfipPolicies" --data-urlencode "\$filter=propertyState eq 'PR'" --data-urlencode '$top=3' --data-urlencode '$orderby=policyEffectiveDate desc' --data-urlencode '$select=policyEffectiveDate,policyTerminationDate,countyCode,censusTract,totalBuildingInsuranceCoverage,totalContentsInsuranceCoverage,totalInsurancePremiumOfThePolicy,policyCount'
cat $OUT/timing.txt
