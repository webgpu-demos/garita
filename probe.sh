set -x
cd $OUT
UA="landfall-exercise (github.com/webgpu-demos)"
curl -sSL -A "$UA" https://www.nhc.noaa.gov/archive/2022/FIONA.shtml -o fiona_index.html; wc -c fiona_index.html
curl -sSL -A "$UA" "https://www.nhc.noaa.gov/gis/archive_forecast_results.php?id=al07&year=2022&name=Hurricane%20FIONA" -o gis_fc.html; wc -c gis_fc.html
curl -sSL -A "$UA" "https://www.nhc.noaa.gov/gis/archive_wsp.php?year=2022" -o gis_wsp.html; wc -c gis_wsp.html
curl -sSL -A "$UA" "https://www.nhc.noaa.gov/gis/forecast/archive/" -o fc_archive_dir.html; wc -c fc_archive_dir.html
grep -o 'al072022[^"<> ]*' fc_archive_dir.html | sort -u > al07_files.txt; wc -l al07_files.txt
grep -o '202209[0-9]*_wsp[^"<> ]*' fc_archive_dir.html | sort -u > wsp_files.txt; wc -l wsp_files.txt
curl -sSL -A "$UA" https://ftp.nhc.noaa.gov/atcf/archive/2022/ -o atcf_dir.html; grep -o '[ab]al072022[^"<> ]*' atcf_dir.html | sort -u
curl -sSL -A "$UA" https://www.nhc.noaa.gov/data/tcr/AL072022_Fiona.pdf -o tcr.pdf; ls -la tcr.pdf; file tcr.pdf
for a in 001 005 010; do curl -sSL -A "$UA" "https://www.nhc.noaa.gov/archive/2022/al07/al072022.public.$a.shtml" -o pub_$a.html; wc -c pub_$a.html; done
