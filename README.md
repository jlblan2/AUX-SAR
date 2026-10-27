# AUX-SAR

Phone app (installable web app / PWA) for Coast Guard Auxiliary search and rescue
coxswains. Runs on iPhone and Android, works offline once installed, and keeps all
data on the phone.

## What it does

**Datum** — drifted position of the search object.
- Last known position (LKP) and time, typed or from GPS.
- Total water current (TWC): measure it with two GPS fixes alongside a datum marker
  buoy (the Set & Drift method), or type in set and drift.
- Wind and search object: leeway from the USCG leeway table (Allen & Plourde 1999,
  the data behind IAMSAR), giving left and right datums and the search datum between them.
- "Use for search pattern" carries the datum and the direction of drift (first leg)
  to the Search tab and records it in the mission log.

**Search** — single-unit patterns from the Coxswain SAR Guide and the CG search pattern slides:
Expanding Square (SS, and 2nd search +45°), Sector (VS, 2nd search +30°, VM −90°),
Parallel (PS), Creeping Line (CS), Trackline Return (TSR) and Non-return (TSN).
Shows the CSP, every leg's course in °T and °M (WMM2025 variation), distance, time at
search speed and turn-point position, plus a plot. The initial track spacing table
(PIW / vessels < 15 ft / ≥ 15 ft, good / poor conditions) is built in.

**Commence search** — the second tab on the Search screen. Follows the phone's GPS
along the planned pattern and plots the boat on it. The voice calls (all courses
magnetic): the course to the CSP, "CSP reached ... leg one, course XXX magnetic",
the next leg's course about 10 seconds before each turn, a five-second countdown,
and "Turn now". The screen stays awake while guiding; progress is saved so a
reloaded app can resume at the same leg. CSP reached and search complete go into
the mission log.

**Log** — mission header, the six briefing items, time-stamped entries with optional
GPS position (Underway, On scene, Commence search, Sighting, SITREP, Weather, ...).
Export by share/email, CSV file, or print/PDF. Several missions can be kept.

## Sources

- `Dropbox\USCGAUX-General Info\SAR\SAR_Guide.pdf` — USCG *Search and Rescue: A Guide
  for Boat Coxswains* (2006, timing chart updated Jan 2007).
- `Dropbox\USCGAUX-General Info\SAR\CGSearches.ppt` — CG search patterns training slides.
- `wmm.js` and the set/drift and GPS code come from Set & Drift (`Z:\Claude\SetAndDrift`).
- `tools/OBJECTPROP.DAT` — USCG SAROPS leeway table as published with OpenDrift;
  `python tools/make_leeway.py` rebuilds `leeway.js` from it.

## Files

| File | Purpose |
|---|---|
| `index.html`, `style.css`, `app.js` | Screens and wiring |
| `geo.js` | Positions, rhumb lines, coordinate parsing/formatting, variation |
| `patterns.js` | Search pattern legs |
| `drift.js` | TWC from fixes, leeway, datum |
| `leeway.js` | Generated leeway coefficients |
| `log.js` | Mission log storage and export |
| `wmm.js` | WMM2025 magnetic model (valid 2025–2030) |
| `sw.js`, `manifest.json`, `icons/` | Offline and home-screen install |
| `nav.js` | Commence search: live guidance and voice calls |
| `tests.html` | Open in a browser to run the tests (59) |

## Running and testing

From `Z:\Claude`, the `auxsar` entry in `.claude/launch.json` serves this folder on
http://localhost:8440. Open `/tests.html` to run the tests.

When you change any file, bump `CACHE` in `sw.js` (e.g. `auxsar-v2`) so installed
phones pick up the new version.

## Disclaimer

A planning aid only. Follow the SMC's Search Action Plan; the coxswain is responsible
for the safety of the crew and the safe navigation of the boat.
