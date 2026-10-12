#!/usr/bin/env python3
"""Writes docs/video/shots.json: the walkthrough's scenes, timed to the narration clips.

Each scene's clock is the footage clock: the narration clip starts at `a` seconds (PRE) into the scene, so an action
for a phrase heard at time x in the clip is placed at a + x. Phrase times come from the pauses in each clip
(ffmpeg silencedetect)."""
import json, sys

POST_UI = sys.argv[1] if len(sys.argv) > 1 else 'basic'   # post-processing for the scenes with the interface
DAY = '2026-10-11T15:00:00Z'      # 11:00 in Puerto Rico
DUSK = '2026-10-10T21:50:00Z'
UI = f'?post={POST_UI}&t={DAY}' if POST_UI == 'basic' else f'?t={DAY}'
CINE = ["S.layerOn.value = { ...S.layerOn.value, markers: false, municipios: false }"]
PRE = 0.6

def at(x, a=PRE):
    return round(a + x, 2)

scenes = []

# 01 Opening: dusk orbit, no interface. Title card added in the edit.
a1 = 1.5
scenes.append({
    'id': 's01', 'url': f'?ui=0&t={DUSK}', 'duration': 16.6, 'cursor': False, 'pre': a1, 'clip': '01',
    'setup': CINE,
    'camera': [
        {'t': 0, 'cam': [-66.52, 18.06, 330000, 332, 33]},
        {'t': 16.6, 'cam': [-66.38, 18.20, 250000, 8, 45], 'ease': 'linear'},
    ],
})

# 02a The island: terrain, photo, sea, buildings (clip 02, 0 - 13.5 s)
scenes.append({
    'id': 's02a', 'url': '?ui=0&t=2026-10-11T14:20:00Z', 'duration': 15.0, 'cursor': False, 'pre': PRE, 'clip': '02', 'clipFrom': 0, 'clipTo': 13.5,
    'setup': CINE,
    'camera': [
        {'t': 0, 'cam': [-66.40, 18.20, 240000, 0, 48]},
        {'t': at(6.2), 'cam': [-65.83, 18.33, 30000, 200, 22]},
        {'t': at(10.0), 'cam': [-65.95, 18.445, 15000, 228, 26]},
        {'t': 15.0, 'cam': [-66.058, 18.447, 4300, 206, 32], 'ease': 'out'},
    ],
})

# 02b Buildings up close: OpenStreetMap vs detected footprints (clip 02, 13.5 s - end), near Cayey
OSM = [-66.105149, 18.197767, 4]
DET = [-66.104727, 18.197849, 2]
DET2 = [-66.104847, 18.197682, 2]
b0 = 13.5 - PRE        # so that at(x, a) = footage time with clip time x
scenes.append({
    'id': 's02b', 'url': UI, 'duration': 12.6, 'pre': PRE, 'clip': '02', 'clipFrom': 13.5, 'clipTo': None,
    'setup': CINE[:0] + ["document.querySelector('.dock-fold')?.click()"],
    'camera': [
        {'t': 0, 'cam': [-66.1049, 18.1979, 380, 345, 48]},
        {'t': 12.6, 'cam': [-66.1049, 18.1979, 360, 352, 49], 'ease': 'linear'},
    ],
    'start': [1200, 760],
    'actions': [
        {'t': at(14.0 - 13.5), 'geo': OSM, 'move': 0.7},
        {'t': at(16.2 - 13.5), 'geo': DET, 'move': 0.8},
        {'t': at(21.3 - 13.5), 'geo': DET2, 'move': 0.6},
    ],
})

# 03 Live feeds: the KPI strip, the feeds chip, the alerts panel
kpis = [('Weather alerts', 2.6), ('Earthquakes', 3.6), ('Rivers', 4.5), ('Customers without power', 6.2), ('San Juan tide', 7.8), ('Wind', 9.4), ('Tropical cyclones', 10.2)]
acts = [{'t': at(x), 'hover': f"button.kpi:has-text('{k}')", 'move': 0.45 if i else 0.9} for i, (k, x) in enumerate(kpis)]
acts += [
    {'t': at(13.0), 'hover': 'button.feed-chip', 'move': 0.8},
    {'t': at(17.0), 'hover': '.dock button.inbox-row', 'move': 0.8},
    {'t': at(18.8), 'scroll': {'sel': '.dock .pane-scroll', 'dy': 320, 'dur': 1.6}},
]
scenes.append({'id': 's03', 'url': UI, 'duration': 23.4, 'pre': PRE, 'clip': '03', 'start': [900, 600], 'actions': acts,
               'camera': [{'t': 0, 'cam': [-66.30, 18.21, 235000, 0, 52]}, {'t': 23.4, 'cam': [-66.28, 18.22, 215000, 0, 53], 'ease': 'linear'}]})

# 04 Overlays: radar, GOES, night lights (the scene clock runs into the night), beside the outage count
# to 20:30 on the same evening: the newest night-lights pass is the one dated by the scene's night (a scene after
# midnight asks for tonight's pass, which is not out yet)
NIGHT_TWEEN = "S.clockMode.value = 'manual'; S.sceneTime.value = Date.parse('2026-10-11T15:00:00Z') + k * 9.5 * 3600e3"
scenes.append({'id': 's04', 'url': UI, 'duration': 18.4, 'pre': PRE, 'clip': '04', 'start': [700, 640],
    'camera': [{'t': 0, 'cam': [-66.30, 18.21, 235000, 0, 52]}, {'t': 18.4, 'cam': [-66.22, 18.28, 150000, 0, 56], 'ease': 'inOut'}],
    'actions': [
        {'t': at(1.2), 'click': "button.rail-btn[title='Overlays']", 'move': 0.9},
        {'t': at(4.0), 'click': "label.fly-row:has-text('Radar')", 'hold': 9000},
        {'t': at(5.3), 'click': "label.fly-row:has-text('GOES')", 'hold': 12000},
        {'t': at(7.1), 'click': "label.fly-row:has-text('Night lights')", 'hold': 14000},
        {'t': at(10.0), 'click': "label:has-text('2016 baseline')", 'move': 0.9, 'hold': 12000},
        {'t': at(12.9), 'hover': "button.kpi:has-text('Customers without power')", 'move': 0.9},
        {'t': at(14.7), 'click': "label:has-text('2016 baseline')", 'move': 0.9, 'hold': 8000},
    ],
    'tweens': [{'from': at(7.1), 'to': at(8.6), 'js': NIGHT_TWEEN}],
})

# 05 Hazards: storm surge by category at San Juan, then landslides in the mountains
CAT = lambda n: f"button[aria-label='Category {n}']"
scenes.append({'id': 's05', 'url': UI, 'duration': 24.4, 'pre': PRE, 'clip': '05', 'start': [700, 640],
    'camera': [
        {'t': 0, 'cam': [-66.10, 18.44, 27000, 180, 62]},
        {'t': at(13.6), 'cam': [-66.12, 18.43, 23000, 188, 60], 'ease': 'linear'},
        {'t': at(17.0), 'cam': [-66.70, 18.25, 34000, 0, 58]},
        {'t': 24.4, 'cam': [-66.70, 18.25, 31000, 8, 58], 'ease': 'linear'},
    ],
    'actions': [
        {'t': at(0.6), 'click': "button.rail-btn[title='Overlays']", 'move': 0.9},
        {'t': at(2.3), 'click': "label.fly-row:has-text('Storm surge')", 'hold': 14000},
        {'t': at(6.6), 'hover': 'aside.legend', 'move': 0.9},
        {'t': at(10.1), 'click': CAT(1), 'hold': 8000, 'move': 0.8},
        {'t': at(10.8), 'click': CAT(2), 'hold': 8000, 'move': 0.35},
        {'t': at(11.5), 'click': CAT(3), 'hold': 8000, 'move': 0.35},
        {'t': at(12.2), 'click': CAT(4), 'hold': 8000, 'move': 0.35},
        {'t': at(12.9), 'click': CAT(5), 'hold': 8000, 'move': 0.35},
        {'t': at(13.6), 'click': "label.fly-row:has-text('Landslide')", 'hold': 14000, 'move': 0.6},
        {'t': at(19.8), 'hover': 'aside.legend', 'move': 1.0},
    ],
})

# 06 Sea level: the scenario panel at Cataño
scenes.append({'id': 's06', 'url': UI, 'duration': 21.8, 'pre': PRE, 'clip': '06', 'start': [800, 600],
    'camera': [{'t': 0, 'cam': [-66.135, 18.437, 7600, 172, 57]}, {'t': 21.8, 'cam': [-66.135, 18.437, 6800, 196, 58], 'ease': 'linear'}],
    'actions': [
        {'t': at(0.9), 'click': "button.dock-tab[aria-label='Scenario']", 'move': 0.9},
        {'t': at(4.4), 'click': 'table.sc-presets tbody tr:nth-child(3) td:last-child button.sc-cell', 'move': 0.9, 'hold': 4000},
        {'t': at(7.0), 'drag': ".dock input[type='range']", 'to': 2.0, 'dur': 1.8, 'move': 0.6},
        {'t': at(9.6), 'scroll': {'sel': '.dock .pane-scroll', 'dy': 300, 'dur': 1.4}},
        {'t': at(13.1), 'scroll': {'sel': '.dock .pane-scroll', 'dy': 330, 'dur': 1.2}},
        {'t': at(14.6), 'click': "button.sc-asset:has-text('Shelters')", 'move': 0.8},
        {'t': at(17.6), 'click': "button.link-btn:has-text('Method and caveats')", 'move': 0.8},
    ],
})

# 07 Storm replay: María
MARIA = ("const r = [...document.querySelectorAll('table.rp-list tbody tr')].find((x) => /mar[ií]a/i.test(x.textContent) && x.textContent.includes('2017'));"
         " r?.scrollIntoView({ block: 'center' }); return r;")
scenes.append({'id': 's07', 'url': UI, 'duration': 18.9, 'pre': PRE, 'clip': '07', 'start': [800, 600],
    'actions': [
        {'t': at(0.8), 'click': "button.dock-tab[aria-label='Replay']", 'move': 0.9},
        {'t': at(5.6), 'clickjs': MARIA, 'move': 0.9, 'hold': 6000},
        {'t': at(5.65), 'js': 'S.sceneTime.value += 9 * 3600e3'},
        {'t': at(8.3), 'click': "button.btn:has-text('1 h/s')", 'move': 0.8},
        {'t': at(11.0), 'scroll': {'sel': '.dock .pane-scroll', 'dy': 260, 'dur': 1.4}},
    ],
})

# 08 The database: search, San Juan, links, graph
scenes.append({'id': 's08', 'url': UI, 'duration': 20.3, 'pre': PRE, 'clip': '08', 'start': [900, 500],
    'actions': [
        {'t': at(2.4), 'click': 'button.tb-search', 'move': 0.9},
        {'t': at(3.0), 'type': 'San Juan', 'cps': 13},
        {'t': at(4.9), 'clickjs': "return [...document.querySelectorAll('button.pal-row')].find((b) => b.querySelector('.pal-meta')?.textContent.trim() === '72127') ?? document.querySelector('button.pal-row');", 'move': 0.7, 'hold': 5000},
        {'t': at(7.2), 'scroll': {'sel': '.dock .pane-scroll', 'dy': 420, 'dur': 2.6}},
        {'t': at(10.6), 'scroll': {'sel': '.dock .pane-scroll', 'dy': 520, 'dur': 2.8}},
        {'t': at(14.6), 'click': "button.dock-tab[aria-label='Graph']", 'move': 0.9, 'hold': 3000},
        {'t': at(17.0), 'hover': '.gr-wrap', 'move': 0.9},
    ],
})

# 09 SQL and lineage
scenes.append({'id': 's09', 'url': UI, 'duration': 15.6, 'pre': PRE, 'clip': '09', 'start': [900, 500],
    'actions': [
        {'t': at(0.9), 'click': "button.dock-tab[aria-label='SQL']", 'move': 0.9},
        {'t': at(4.4), 'select': "select[aria-label='Saved queries']", 'value': 'nfip_gap', 'move': 0.9, 'hold': 5000},
        {'t': at(6.6), 'hover': '.dock table.sql-table', 'move': 0.9},
        {'t': at(9.8), 'click': "button.dock-tab[aria-label='Lineage']", 'move': 0.9, 'hold': 2000},
        {'t': at(12.0), 'scroll': {'sel': '.dock .pane-scroll', 'dy': 300, 'dur': 1.6}},
    ],
})

# 10 Close: pull back from Old San Juan to the island at dusk. End card added in the edit.
scenes.append({'id': 's10', 'url': f'?ui=0&t={DUSK}', 'duration': 22.6, 'cursor': False, 'pre': 0.5, 'clip': '10',
    'setup': CINE,
    'camera': [
        {'t': 0, 'cam': [-66.116, 18.462, 2600, 12, 20]},
        {'t': 6.0, 'cam': [-66.13, 18.44, 14000, 5, 28], 'ease': 'in'},
        {'t': 17.5, 'cam': [-66.42, 18.20, 300000, 355, 40], 'ease': 'out'},
        {'t': 22.6, 'cam': [-66.41, 18.20, 292000, 0, 41], 'ease': 'linear'},
    ],
})

SOURCES = {'s02a': 'USGS 3DEP elevation · USGS National Map photo · NOAA NCEI CUDEM depth', 's02b': 'OpenStreetMap footprints · Google and Microsoft detections via Overture Maps · USGS 3DEP 1 m lidar', 's03': 'Live: NWS · USGS · NOAA · NHC · LUMA · Open-Meteo', 's04': 'RainViewer radar · NOAA GOES-East via NASA GIBS · NASA/NOAA VIIRS night lights', 's05': 'NOAA NHC storm surge risk maps (SLOSH) · USGS landslide susceptibility, OFR 2020-1022', 's06': 'NOAA 2022 sea level scenarios · USGS 3DEP 1 m lidar · Vivienda shelters · HUD public housing', 's07': 'NOAA HURDAT2 storm tracks · Census ACS population', 's08': 'Census ACS · OpenFEMA flood insurance and declarations · HUD · Vivienda', 's09': 'OpenFEMA NFIP policies · FEMA flood zones (NFHL) · OpenStreetMap footprints'}
for sc in scenes:
    if sc['id'] in SOURCES: sc['sources'] = SOURCES[sc['id']]

spec = {'width': 1920, 'height': 1080, 'fps': 30, 'renderScale': 0.67, 'settleMs': 20000, 'scenes': scenes}
out = sys.argv[2] if len(sys.argv) > 2 else 'docs/video/shots.json'
json.dump(spec, open(out, 'w'), indent=1)
print(out, len(scenes), 'scenes', round(sum(s['duration'] for s in scenes), 1), 's of footage')
