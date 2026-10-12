# Garita walkthrough: narration script

About four minutes. One paragraph per scene; each is recorded as its own clip (01.mp3 to 10.mp3).

01 · Opening
This is Garita: a live digital twin of Puerto Rico, built for housing recovery and disaster response. Everything you see runs in the browser, from public data, and every number can be traced back to where it came from.

02 · The island
The island is real. The terrain is USGS elevation, draped with aerial photography, and the sea is shaded from NOAA's own depth surveys. These are one point seven million buildings: one and a half million from OpenStreetMap, plus footprints detected from imagery where OpenStreetMap has none, flagged as detections. Each one carries its ground elevation from one-metre lidar.

03 · Live feeds
Across the top is the island right now: weather alerts, earthquakes, rivers near flood stage, customers without power, the tide in San Juan, the wind, and tropical cyclones. Live feeds from the National Weather Service, USGS, NOAA, LUMA and others update on their own, and the alerts panel ranks what needs attention first.

04 · Overlays
One map overlay at a time can be draped over the terrain. Rain radar. The GOES weather satellite. And NASA's night lights: the most recent night, or any night back to 2012. Set beside the utility's outage numbers, it shows where the lights actually went out.

05 · Hazards
The hazard maps come with counts. This is NOAA's storm surge map for a Category 3 hurricane: about twenty-six thousand buildings sit inside the mapped area, and the selector steps through Categories 1 to 5. The USGS landslide map covers the other half of the risk, up in the mountains where the surge never reaches. Each map shows its publisher's own limits, right on screen.

06 · Sea level
The scenario panel raises the sea. Pick one of NOAA's projections for San Juan, or drag the slider, and the twin counts what sits at or below that level, municipio by municipio, using the lidar. Shelters and public housing below the line are listed by name. It is a screening tool, a bathtub model, and it says so.

07 · Storm replay
Storm replay runs thirty historical storms across the island, hour by hour. Here is María, in September 2017. The panel tracks which municipios and how many residents fell inside each wind radius, and which shelters and housing developments were under hurricane-force winds.

08 · The database
Under the map is a database, not a pile of layers. Click anything and it opens. San Juan: its population and housing, its flood insurance claims, the disasters declared for it, the shelters and developments inside it. Every link is typed, and the graph lets you walk from one thing to the next.

09 · SQL and lineage
For analysts there is a SQL console with saved questions, like this one: flood insurance policies against buildings in the flood zone, by municipio. And the lineage panel shows where every number comes from, and how fresh it is.

10 · Close
Garita is free to run, built entirely on public data, and honest about what it doesn't know: what is real, modelled or procedural is labelled as such. It is a demonstrator, not an official tool. Open it at webgpu-demos dot github dot io, slash garita.
