import {
  formatDMM, parseCoord, formatMinSec, fmtCourse, norm360, variationAt, formatVariation,
  getFix, vecFromPolar,
} from './geo.js';
import {
  INITIAL_TRACK_SPACING, CORNERS, cornerName, expandingSquare, sector,
  parallelOrCreeping, trackline, legHours,
} from './patterns.js';
import { currentFromFixes, leewaySpeeds, divergence, computeDatum } from './drift.js';
import { LEEWAY_OBJECTS } from './leeway.js';
import {
  BRIEFING, HEADER, ENTRY_TYPES, loadMissions, saveMissions, newMission, missionTitle,
  entryPosition, entryTime, toText, toCSV, fileName,
} from './log.js';

const $ = (id) => document.getElementById(id);

// ---------- storage ----------

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch (e) {
    return { ...fallback };
  }
}

function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
}

const DEFAULT_SETTINGS = { varMode: 'auto', varDeg: 0, varDir: 'W', minInterval: 60 };
let settings = load('auxsar.settings', DEFAULT_SETTINGS);

// Form values survive the app being closed or reloaded (iOS often reloads home-screen apps).
const FORM_IDS = [
  'lkpLat', 'lkpLon', 'lkpTime', 'twcSet', 'twcDrift', 'windFrom', 'windSpeed', 'objectSel', 'datumTime',
  'patternSel', 'sDatumLat', 'sDatumLon', 'origLat', 'origLon', 'destLat', 'destLon', 'sideSel',
  'spacing', 'speed', 'firstCourse', 'ssLegs', 'ssRot', 'vsRot', 'areaLen', 'areaWid', 'areaAxis', 'cornerSel',
];
const FORM_DEFAULTS = {
  objectSel: 'PIW-1', patternSel: 'SS', spacing: '0.5', speed: '10', firstCourse: '0', ssLegs: '12',
  areaLen: '10', areaWid: '6', areaAxis: '0', cornerSel: '0', twcSet: '', twcDrift: '',
};
let form = load('auxsar.form', FORM_DEFAULTS);
let twcState = load('auxsar.twc', { mode: 'measure', fix1: null, fix2: null });

function saveForm() {
  for (const id of FORM_IDS) form[id] = $(id).value;
  save('auxsar.form', form);
}

// ---------- helpers ----------

function num(id) {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : NaN;
}

function readPos(prefix, label) {
  const lat = parseCoord($(`${prefix}Lat`).value, true);
  const lon = parseCoord($(`${prefix}Lon`).value, false);
  if (!Number.isFinite(lat)) throw new Error(`${label} latitude is missing or not readable (e.g. 26 07.500 N).`);
  if (!Number.isFinite(lon)) throw new Error(`${label} longitude is missing or not readable (e.g. 080 05.000 W).`);
  return { lat, lon };
}

function setPos(prefix, lat, lon) {
  const [la, lo] = formatDMM(lat, lon).split(' ');
  $(`${prefix}Lat`).value = la;
  $(`${prefix}Lon`).value = lo;
  saveForm();
}

function toLocalInput(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function readTime(id, label) {
  const ms = new Date($(id).value).getTime();
  if (!Number.isFinite(ms)) throw new Error(`${label} is not set.`);
  return ms;
}

function clockTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

function showError(id, err) {
  const el = $(id);
  if (!err) { el.hidden = true; return; }
  el.textContent = err.message || String(err);
  el.hidden = false;
}

function magnetic(courseT, v) { return norm360(courseT - v.value); }

function gpsError(err) {
  if (err && err.code === 1) return 'Location permission denied. Allow location for this app in your phone settings.';
  return `Could not get location: ${(err && err.message) || err}`;
}

async function shareText(title, text) {
  if (navigator.share) {
    try { await navigator.share({ title, text }); return 'Shared.'; } catch (e) {
      if (e && e.name === 'AbortError') return '';
    }
  }
  try { await navigator.clipboard.writeText(text); return 'Copied to clipboard.'; } catch (e) { /* fall through */ }
  downloadFile(`${title.replace(/[^\w-]+/g, '_')}.txt`, text, 'text/plain');
  return 'Saved as a text file.';
}

async function downloadFile(name, content, type) {
  const file = new File([content], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- tabs ----------

const TAB_TITLES = { datum: 'Datum', search: 'Search pattern', log: 'Mission log' };

function showTab(name) {
  for (const t of Object.keys(TAB_TITLES)) $(`tab-${t}`).hidden = t !== name;
  for (const b of $('tabbar').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === name);
  $('tabTitle').textContent = TAB_TITLES[name];
  try { localStorage.setItem('auxsar.tab', name); } catch (e) { /* ignore */ }
  window.scrollTo(0, 0);
}

$('tabbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
});

// "Use my GPS" buttons fill the matching lat/lon pair.
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-gps]');
  if (!b) return;
  const label = b.textContent;
  b.disabled = true;
  b.textContent = 'Getting GPS…';
  try {
    const fix = await getFix();
    setPos(b.dataset.gps, fix.lat, fix.lon);
    if (b.dataset.gps === 'lkp') { $('lkpTime').value = toLocalInput(fix.time); saveForm(); }
    b.textContent = `±${Math.round(fix.accuracy)} m`;
    setTimeout(() => { b.textContent = label; }, 2500);
  } catch (err) {
    alert(gpsError(err));
    b.textContent = label;
  } finally {
    b.disabled = false;
  }
});

// ---------- datum: total water current (Set & Drift) ----------

function renderFix(fix, n) {
  $(`fix${n}Coord`).textContent = fix ? formatDMM(fix.lat, fix.lon) : '—';
  $(`fix${n}Time`).textContent = fix ? clockTime(fix.time) + (fix.accuracy ? ` (±${Math.round(fix.accuracy)} m)` : '') : '—';
}

function renderTwc() {
  const { mode, fix1, fix2 } = twcState;
  for (const btn of $('twcModeSeg').querySelectorAll('.seg-btn')) btn.classList.toggle('active', btn.dataset.mode === mode);
  $('twcMeasure').hidden = mode !== 'measure';
  renderFix(fix1, 1);
  renderFix(fix2, 2);
  $('startBtn').disabled = !!fix1;
  $('stopBtn').disabled = !fix1 || !!fix2;
  $('twcResetBtn').hidden = !fix1;
  if (!fix1) $('twcStatus').textContent = 'Ready. Press START to mark Fix 1.';
  else if (!fix2) $('twcStatus').textContent = `Fix 1 marked at ${clockTime(fix1.time)}. Press STOP alongside the marker to mark Fix 2.`;
  updateTwcMeta();
}

function updateTwcMeta() {
  const set = num('twcSet'), drift = num('twcDrift');
  if (!Number.isFinite(set) || !Number.isFinite(drift)) { $('twcMeta').textContent = ''; return; }
  let pos = twcState.fix1;
  if (!pos) { try { pos = readPos('lkp', 'LKP'); } catch (e) { pos = null; } }
  if (!pos) { $('twcMeta').textContent = `Set ${fmtCourse(set)}°T, drift ${drift.toFixed(2)} kn.`; return; }
  const v = variationAt(pos.lat, pos.lon, Date.now(), settings);
  $('twcMeta').textContent = `Set ${fmtCourse(set)}°T / ${fmtCourse(magnetic(set, v))}°M, drift ${drift.toFixed(2)} kn. Variation ${formatVariation(v)}.`;
}

function finishMeasurement() {
  const { fix1, fix2 } = twcState;
  const r = currentFromFixes(fix1, fix2);
  const secs = r.hours * 3600;
  if (secs < settings.minInterval) {
    $('twcStatus').textContent = `Only ${Math.round(secs)} s between fixes; need at least ${settings.minInterval} s for a reliable drift. Press New measurement and drift longer.`;
    return;
  }
  $('twcSet').value = Math.round(r.setT);
  $('twcDrift').value = r.driftKn.toFixed(2);
  saveForm();
  $('twcStatus').textContent = `Measured ${r.distNm.toFixed(3)} nm in ${formatMinSec(r.hours)}.`;
  updateTwcMeta();
}

$('twcModeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('.seg-btn');
  if (!b) return;
  twcState.mode = b.dataset.mode;
  save('auxsar.twc', twcState);
  renderTwc();
});

$('startBtn').addEventListener('click', async () => {
  $('startBtn').disabled = true;
  $('twcStatus').textContent = 'Acquiring GPS fix…';
  try {
    twcState.fix1 = await getFix();
    twcState.fix2 = null;
    save('auxsar.twc', twcState);
    renderTwc();
  } catch (err) {
    $('twcStatus').textContent = gpsError(err);
    $('startBtn').disabled = false;
  }
});

$('stopBtn').addEventListener('click', async () => {
  $('stopBtn').disabled = true;
  $('twcStatus').textContent = 'Acquiring GPS fix…';
  try {
    twcState.fix2 = await getFix();
    save('auxsar.twc', twcState);
    renderTwc();
    finishMeasurement();
  } catch (err) {
    $('twcStatus').textContent = gpsError(err);
    $('stopBtn').disabled = false;
  }
});

$('twcResetBtn').addEventListener('click', () => {
  twcState.fix1 = null;
  twcState.fix2 = null;
  save('auxsar.twc', twcState);
  renderTwc();
});

// ---------- datum: leeway and datum ----------

function buildObjectSelect() {
  const sel = $('objectSel');
  let group = null;
  let og = null;
  for (const o of LEEWAY_OBJECTS) {
    if (o.group !== group) {
      og = document.createElement('optgroup');
      og.label = o.group;
      sel.appendChild(og);
      group = o.group;
    }
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = `${'  '.repeat(o.level)}${o.level ? '› ' : ''}${o.name}`;
    og.appendChild(opt);
  }
}

function selectedObject() {
  return LEEWAY_OBJECTS.find((o) => o.id === $('objectSel').value) || LEEWAY_OBJECTS[0];
}

function updateLeewayMeta() {
  const wind = num('windSpeed');
  const from = num('windFrom');
  if (!Number.isFinite(wind) || wind <= 0) {
    $('leewayMeta').textContent = 'Enter the wind to include leeway. Use the main (mean values) entry unless the object is known.';
    return;
  }
  const lw = leewaySpeeds(selectedObject(), wind);
  const div = divergence(lw);
  const toward = Number.isFinite(from) ? ` toward ${fmtCourse(from + 180)}°T` : '';
  $('leewayMeta').textContent =
    `Leeway ${lw.dwl.toFixed(2)} kn downwind${toward}; crosswind ${lw.cwlR.toFixed(2)} kn right / ${Math.abs(lw.cwlL).toFixed(2)} kn left ` +
    `(divergence ${Math.abs(div.right).toFixed(0)}° right, ${Math.abs(div.left).toFixed(0)}° left). USCG leeway table.`;
}

let lastDatum = null;

function computeDatumUI() {
  showError('datumError', null);
  try {
    const lkp = readPos('lkp', 'LKP');
    const lkpTime = readTime('lkpTime', 'Time of LKP');
    if (!$('datumTime').value) $('datumTime').value = toLocalInput(Date.now());
    const datumTime = readTime('datumTime', 'Datum time');
    const twc = { setT: num('twcSet') || 0, driftKn: num('twcDrift') || 0 };
    const wind = { fromT: num('windFrom') || 0, speedKn: num('windSpeed') || 0 };
    const r = computeDatum({ lkp, lkpTime, datumTime, twc, wind, object: selectedObject() });
    const v = variationAt(r.datum.lat, r.datum.lon, datumTime, settings);
    lastDatum = { ...r, variation: v, datumTime };

    $('datumPos').textContent = formatDMM(r.datum.lat, r.datum.lon);
    const drifting = r.driftDistNm >= 0.005;
    $('driftDir').textContent = drifting ? `${fmtCourse(r.driftSetT)}°T` : 'none';
    $('driftRate').textContent = `${r.driftRateKn.toFixed(2)} kn`;
    const rows = [
      ['Elapsed since LKP', formatMinSec(r.hours)],
      ['Direction of drift', drifting ? `${fmtCourse(r.driftSetT)}°T / ${fmtCourse(magnetic(r.driftSetT, v))}°M` : 'no drift — first leg 000°T'],
      ['Total drift distance', `${r.driftDistNm.toFixed(2)} nm`],
      ['TWC', `${fmtCourse(twc.setT)}°T at ${twc.driftKn.toFixed(2)} kn`],
      ['Leeway (downwind)', `${r.leeway.dwl.toFixed(2)} kn toward ${fmtCourse(r.downwind)}°T`],
      ['Left datum', formatDMM(r.left.pos.lat, r.left.pos.lon)],
      ['Right datum', formatDMM(r.right.pos.lat, r.right.pos.lon)],
      ['Left–right separation', `${r.separationNm.toFixed(2)} nm`],
      ['Variation', formatVariation(v)],
    ];
    $('datumTable').innerHTML = rows.map(([k, val]) => `<tr><th>${k}</th><td>${val}</td></tr>`).join('');
    $('datumResult').hidden = false;
  } catch (err) {
    lastDatum = null;
    $('datumResult').hidden = true;
    showError('datumError', err);
  }
}

$('datumCalcBtn').addEventListener('click', computeDatumUI);
$('datumNowBtn').addEventListener('click', () => { $('datumTime').value = toLocalInput(Date.now()); saveForm(); });

$('useDatumBtn').addEventListener('click', () => {
  if (!lastDatum) return;
  const d = lastDatum;
  setPos('sDatum', d.datum.lat, d.datum.lon);
  $('firstCourse').value = d.driftDistNm >= 0.005 ? fmtCourse(d.driftSetT) : '000';
  saveForm();
  addEntry('Datum',
    `Datum ${formatDMM(d.datum.lat, d.datum.lon)} at ${clockTime(d.datumTime)}. ` +
    `Drift ${fmtCourse(d.driftSetT)}°T ${d.driftRateKn.toFixed(2)} kn, ${d.driftDistNm.toFixed(2)} nm. Object: ${selectedObject().name}.`,
    null);
  updatePatternUI();
  showTab('search');
});

// ---------- search patterns ----------

const PATTERN_HINTS = {
  SS: 'Small area, object located within close limits, concentrated search. CSP at datum; first leg in the direction of drift (000°T if none); all turns 90° right; legs grow one S every other leg.',
  VS: 'Small area, object location well known, concentrated search. CSP at datum; first leg down drift (000°T if none); all turns 120° right; every leg = S (the radius). Steer on your marker on legs 3, 6 and 9.',
  PS: 'Large area, location approximate, uniform coverage. Legs parallel to the major axis; CSP ½ S inside the chosen corner; cross legs one S.',
  CS: 'Large area, object more likely at one end. Legs parallel to the minor axis, creeping along the major axis from the CSP end; CSP ½ S inside the corner.',
  TSR: 'Intended route known; usually the first search for an overdue craft. Out ½ S to one side of the track to the destination, then back ½ S on the other side.',
  TSN: 'Intended route known; one pass along the track from origin to destination.',
};

function updateCorners() {
  const len = num('areaLen') || 1, wid = num('areaWid') || 1, axis = num('areaAxis') || 0;
  const sel = $('cornerSel');
  const keep = sel.value || form.cornerSel || '0';
  sel.innerHTML = CORNERS.map((c, i) => `<option value="${i}">${cornerName(c, axis, len, wid)} corner</option>`).join('');
  sel.value = keep;
}

function updatePatternUI() {
  const p = $('patternSel').value;
  const isTrack = p === 'TSR' || p === 'TSN';
  const isArea = p === 'PS' || p === 'CS';
  $('patternHint').textContent = PATTERN_HINTS[p];
  $('datumCard').hidden = isTrack;
  $('datumCardTitle').textContent = isArea ? 'Search area center' : 'Datum (CSP)';
  $('trackCard').hidden = !isTrack;
  $('sideField').hidden = p !== 'TSR';
  $('spacingField').hidden = p === 'TSN';
  $('spacingGuide').hidden = p === 'TSN';
  $('spacingLabel').textContent = p === 'VS' ? 'Track spacing S = radius (nm)' : 'Track spacing S (nm)';
  $('firstLegFields').hidden = !(p === 'SS' || p === 'VS');
  $('ssLegsField').hidden = p !== 'SS';
  $('ssRotField').hidden = p !== 'SS';
  $('vsRotField').hidden = p !== 'VS';
  $('areaFields').hidden = !isArea;
  if (isArea) updateCorners();
}

function buildSpacingTable() {
  $('spacingTable').innerHTML = INITIAL_TRACK_SPACING.map((r) =>
    `<tr><td>${r.object}</td><td><button type="button" data-s="${r.good}">${r.good.toFixed(1)}</button></td>` +
    `<td><button type="button" data-s="${r.poor}">${r.poor.toFixed(1)}</button></td></tr>`).join('');
  $('spacingTable').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-s]');
    if (!b) return;
    $('spacing').value = b.dataset.s;
    saveForm();
    $('spacingGuide').open = false;
  });
}

let lastPlan = null;

function planSearch() {
  showError('planError', null);
  try {
    const p = $('patternSel').value;
    const spacing = num('spacing');
    const speed = num('speed');
    if (!(speed > 0)) throw new Error('Enter the search speed in knots.');
    let plan;
    let area = null;
    let track = null;
    if (p === 'SS' || p === 'VS') {
      const datum = readPos('sDatum', 'Datum');
      const firstCourse = Number.isFinite(num('firstCourse')) ? num('firstCourse') : 0;
      plan = p === 'SS'
        ? expandingSquare({ datum, spacing, firstCourse, legCount: num('ssLegs') || 12, secondSearch: $('ssRot').value === 'second' })
        : sector({ datum, spacing, firstCourse, rotation: $('vsRot').value });
    } else if (p === 'PS' || p === 'CS') {
      const center = readPos('sDatum', 'Area center');
      const length = num('areaLen'), width = num('areaWid'), majorAxis = num('areaAxis') || 0;
      const corner = CORNERS[parseInt($('cornerSel').value, 10) || 0];
      plan = parallelOrCreeping({ type: p, center, length, width, majorAxis, spacing, corner });
      area = { length, width, majorAxis };
    } else {
      const origin = readPos('orig', 'Origin');
      const destination = readPos('dest', 'Destination');
      plan = trackline({ origin, destination, spacing, returnLeg: p === 'TSR', side: $('sideSel').value });
      // Plot coordinates are relative to the origin; the first leg runs the length of the track.
      const v = vecFromPolar(plan.legs[0].courseT, plan.legs[0].distNm);
      track = [[0, 0], [v.e, v.n]];
    }
    const v = variationAt(plan.csp.lat, plan.csp.lon, Date.now(), settings);
    lastPlan = { ...plan, speed, spacing, variation: v, pattern: p };
    renderPlan(lastPlan, area, track);
  } catch (err) {
    lastPlan = null;
    $('planResult').hidden = true;
    showError('planError', err);
  }
}

function renderPlan(plan, area, track) {
  const v = plan.variation;
  const hours = legHours(plan.totalNm, plan.speed);
  $('planTitle').textContent = `${plan.name}${plan.code.includes('2nd') || plan.code === 'VM' ? ` — ${plan.code}` : ''}`;
  $('planCsp').textContent = formatDMM(plan.csp.lat, plan.csp.lon);
  $('planTotal').textContent = `${plan.totalNm.toFixed(1)} nm`;
  $('planTime').textContent = formatMinSec(hours);
  const sText = plan.pattern === 'TSN' ? '' : `S = ${plan.spacing} nm, `;
  $('planMeta').textContent = `${sText}${plan.speed} kn, ${plan.legs.length} legs. Variation ${formatVariation(v)}. Timing chart: one S takes ${Number.isFinite(plan.spacing) && plan.pattern !== 'TSN' ? formatMinSec(legHours(plan.spacing, plan.speed)) : '—'}.`;
  $('legTable').innerHTML = plan.legs.map((l) =>
    `<tr class="${l.kind === 'cross' ? 'cross' : ''}"><td>${l.n}${l.kind === 'return' ? '<small> ⊙</small>' : ''}</td>` +
    `<td>${fmtCourse(l.courseT)}</td><td>${fmtCourse(magnetic(l.courseT, v))}</td>` +
    `<td class="num">${l.distNm.toFixed(2)}</td><td>${formatMinSec(legHours(l.distNm, plan.speed))}</td>` +
    `<td>${formatDMM(l.to.lat, l.to.lon).replace(' ', '<br>')}</td></tr>`).join('');
  drawPlan(plan, area, track);
  $('planResult').hidden = false;
  $('planResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function drawPlan(plan, area, track) {
  const svg = $('planSvg');
  const pts = plan.points.slice();
  let areaPts = null;
  if (area) {
    areaPts = CORNERS.map(([su, sv]) => {
      const a = vecFromPolar(area.majorAxis, su * area.length / 2);
      const b = vecFromPolar(area.majorAxis + 90, sv * area.width / 2);
      return [a.e + b.e, a.n + b.n];
    });
    pts.push(...areaPts);
  }
  if (track) pts.push(...track);
  pts.push([0, 0]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 0.01);
  const size = 300, pad = 28;
  const k = (size - 2 * pad) / span;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const X = (e) => size / 2 + (e - cx) * k;
  const Y = (n) => size / 2 - (n - cy) * k;
  const path = plan.points.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');

  let out = '';
  if (areaPts) {
    out += `<polygon points="${areaPts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ')}" fill="none" stroke="#7f96b3" stroke-dasharray="4 4" stroke-width="1"/>`;
  }
  if (track) {
    out += `<line x1="${X(track[0][0])}" y1="${Y(track[0][1])}" x2="${X(track[1][0])}" y2="${Y(track[1][1])}" stroke="#7f96b3" stroke-dasharray="4 4"/>`;
    out += `<text x="${X(track[0][0]) + 5}" y="${Y(track[0][1]) - 5}" fill="#8ea4bf" font-size="10">Origin</text>`;
    out += `<text x="${X(track[1][0]) + 5}" y="${Y(track[1][1]) - 5}" fill="#8ea4bf" font-size="10">Dest</text>`;
  } else {
    out += `<g stroke="#eaf2fb" stroke-width="1.5"><line x1="${X(0) - 6}" y1="${Y(0)}" x2="${X(0) + 6}" y2="${Y(0)}"/><line x1="${X(0)}" y1="${Y(0) - 6}" x2="${X(0)}" y2="${Y(0) + 6}"/></g>`;
  }
  out += `<path d="${path}" fill="none" stroke="#ff9f1c" stroke-width="2" stroke-linejoin="round"/>`;
  const labelEvery = plan.legs.length > 24 ? Math.ceil(plan.legs.length / 24) : 1;
  plan.legs.forEach((l, i) => {
    if (i % labelEvery) return;
    const a = plan.points[i], b = plan.points[i + 1];
    if (l.distNm * k < 18) return; // too short on screen to label without overlapping
    const mx = X((a[0] + b[0]) / 2), my = Y((a[1] + b[1]) / 2);
    out += `<circle cx="${mx}" cy="${my}" r="7" fill="#12253b" stroke="#ff9f1c" stroke-width="1"/>` +
      `<text x="${mx}" y="${my + 3.2}" fill="#eaf2fb" font-size="9" text-anchor="middle">${l.n}</text>`;
  });
  const csp = plan.points[0];
  out += `<circle cx="${X(csp[0])}" cy="${Y(csp[1])}" r="5" fill="#2ec4b6"/>`;
  out += `<text x="${X(csp[0]) + 7}" y="${Y(csp[1]) + 12}" fill="#2ec4b6" font-size="10" font-weight="700">CSP</text>`;
  // North arrow and scale
  out += `<g fill="#8ea4bf" font-size="10"><path d="M282,10 L287,24 L282,21 L277,24 Z"/><text x="282" y="35" text-anchor="middle">N</text></g>`;
  const scaleNm = niceScale(span / 4);
  out += `<g stroke="#8ea4bf"><line x1="10" y1="290" x2="${10 + scaleNm * k}" y2="290"/><line x1="10" y1="286" x2="10" y2="294"/><line x1="${10 + scaleNm * k}" y1="286" x2="${10 + scaleNm * k}" y2="294"/></g>`;
  out += `<text x="12" y="283" fill="#8ea4bf" font-size="10">${scaleNm} nm</text>`;
  svg.innerHTML = out;
}

function niceScale(x) {
  const p = 10 ** Math.floor(Math.log10(x));
  const m = x / p;
  return +((m >= 5 ? 5 : m >= 2 ? 2 : 1) * p).toPrecision(2);
}

function planSummary(plan) {
  const v = plan.variation;
  const lines = [
    `${plan.name}${plan.code !== plan.pattern ? ` (${plan.code})` : ''}`,
    `CSP ${formatDMM(plan.csp.lat, plan.csp.lon)}`,
    `${plan.pattern === 'TSN' ? '' : `S ${plan.spacing} nm, `}${plan.speed} kn, ${plan.totalNm.toFixed(1)} nm, ${formatMinSec(legHours(plan.totalNm, plan.speed))}`,
    `Variation ${formatVariation(v)}`,
    'Leg  °T   °M   nm     time   turn point',
  ];
  for (const l of plan.legs) {
    lines.push(`${String(l.n).padStart(2)}   ${fmtCourse(l.courseT)}  ${fmtCourse(magnetic(l.courseT, v))}  ${l.distNm.toFixed(2).padStart(5)}  ${formatMinSec(legHours(l.distNm, plan.speed))}  ${formatDMM(l.to.lat, l.to.lon)}`);
  }
  return lines.join('\n');
}

$('patternSel').addEventListener('change', () => { updatePatternUI(); $('planResult').hidden = true; });
for (const id of ['areaLen', 'areaWid', 'areaAxis']) $(id).addEventListener('input', updateCorners);
$('planBtn').addEventListener('click', planSearch);
$('planLogBtn').addEventListener('click', () => {
  if (!lastPlan) return;
  addEntry('Search plan', planSummary(lastPlan), null);
  $('planLogBtn').textContent = 'Added ✓';
  setTimeout(() => { $('planLogBtn').textContent = 'Add to mission log'; }, 2000);
});
$('planShareBtn').addEventListener('click', async () => {
  if (!lastPlan) return;
  const msg = await shareText('AUX-SAR search plan', planSummary(lastPlan));
  if (msg) { $('planShareBtn').textContent = msg; setTimeout(() => { $('planShareBtn').textContent = 'Share'; }, 2000); }
});

// ---------- mission log ----------

let missions = loadMissions();
let currentId = null;
try { currentId = localStorage.getItem('auxsar.currentMission'); } catch (e) { /* ignore */ }
let entryType = 'Note';

function current() {
  let m = missions.find((x) => x.id === currentId);
  if (!m) {
    m = missions[missions.length - 1];
    if (!m) { m = newMission(); missions.push(m); saveMissions(missions); }
    setCurrent(m.id);
  }
  return m;
}

function setCurrent(id) {
  currentId = id;
  try { localStorage.setItem('auxsar.currentMission', id); } catch (e) { /* ignore */ }
}

function persist() {
  if (!saveMissions(missions)) $('entryStatus').textContent = 'Warning: could not save — phone storage is full or blocked.';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderMissionSelect() {
  const m = current();
  $('missionSel').innerHTML = [...missions].reverse()
    .map((x) => `<option value="${x.id}">${escapeHtml(missionTitle(x))}</option>`).join('');
  $('missionSel').value = m.id;
}

function renderHeader() {
  const m = current();
  const field = (group, [k, label], multi) =>
    `<label class="field"><span>${label}</span>${multi
      ? `<textarea rows="2" data-group="${group}" data-key="${k}">${escapeHtml(m[group][k] || '')}</textarea>`
      : `<input type="text" data-group="${group}" data-key="${k}" value="${escapeHtml(m[group][k] || '')}">`}</label>`;
  $('headerFields').innerHTML = HEADER.map((h) => field('header', h, false)).join('');
  $('briefingFields').innerHTML = BRIEFING.map((b) => field('briefing', b, true)).join('');
}

function renderEntries() {
  const m = current();
  const sorted = [...m.entries].sort((a, b) => b.time - a.time);
  $('entryList').innerHTML = sorted.map((e) => {
    const pos = entryPosition(e);
    return `<li><div class="e-head"><b>${escapeHtml(entryTime(e).slice(11))}</b> ${escapeHtml(e.type)}</div>` +
      (pos ? `<div class="e-pos">${pos}</div>` : '') +
      (e.text ? `<div class="e-text">${escapeHtml(e.text)}</div>` : '') +
      `<button type="button" class="e-del" data-del="${e.id}" aria-label="Delete entry">✕</button></li>`;
  }).join('');
  $('entryEmpty').hidden = sorted.length > 0;
}

function renderLog() {
  renderMissionSelect();
  renderHeader();
  renderEntries();
}

function addEntry(type, text, fix) {
  const m = current();
  const e = { id: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, time: Date.now(), type, text: text || '' };
  if (fix) { e.lat = fix.lat; e.lon = fix.lon; }
  m.entries.push(e);
  persist();
  renderEntries();
  return e;
}

function buildChips() {
  $('entryChips').innerHTML = ENTRY_TYPES.map((t) => `<button type="button" class="chip${t === entryType ? ' active' : ''}" data-type="${t}">${t}</button>`).join('');
}

$('entryChips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  entryType = b.dataset.type;
  buildChips();
});

$('addEntryBtn').addEventListener('click', async () => {
  const text = $('entryText').value.trim();
  const type = entryType;
  const btn = $('addEntryBtn');
  btn.disabled = true;
  let fix = null;
  if ($('entryGps').checked) {
    $('entryStatus').textContent = 'Getting GPS position…';
    try { fix = await getFix(); } catch (err) { $('entryStatus').textContent = `${gpsError(err)} Logged without position.`; }
  }
  addEntry(type, text, fix);
  $('entryText').value = '';
  if (fix || !$('entryGps').checked) $('entryStatus').textContent = `${type} logged.`;
  btn.disabled = false;
});

$('entryList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  if (!confirm('Delete this log entry?')) return;
  const m = current();
  m.entries = m.entries.filter((x) => x.id !== b.dataset.del);
  persist();
  renderEntries();
});

for (const id of ['headerFields', 'briefingFields']) {
  $(id).addEventListener('input', (e) => {
    const t = e.target;
    if (!t.dataset.group) return;
    current()[t.dataset.group][t.dataset.key] = t.value;
    persist();
    if (t.dataset.key === 'caseName') renderMissionSelect();
  });
}

$('missionSel').addEventListener('change', () => { setCurrent($('missionSel').value); renderLog(); });
$('newMissionBtn').addEventListener('click', () => {
  const m = newMission();
  missions.push(m);
  setCurrent(m.id);
  persist();
  renderLog();
  $('headerCard').open = true;
});
$('deleteMissionBtn').addEventListener('click', () => {
  const m = current();
  if (!confirm(`Delete "${missionTitle(m)}" and all its entries from this phone? Export it first if you need a copy.`)) return;
  missions = missions.filter((x) => x.id !== m.id);
  currentId = null;
  persist();
  renderLog();
});
$('shareLogBtn').addEventListener('click', async () => {
  const m = current();
  const msg = await shareText(missionTitle(m), toText(m));
  if (msg) $('entryStatus').textContent = msg;
});
$('csvLogBtn').addEventListener('click', () => {
  const m = current();
  downloadFile(fileName(m, 'csv'), toCSV(m), 'text/csv');
});
$('printLogBtn').addEventListener('click', () => {
  $('printArea').textContent = toText(current());
  window.print();
});

// ---------- settings (from Set & Drift) ----------

let pendingVarMode = settings.varMode;

function applyVarModeUI(mode) {
  pendingVarMode = mode;
  for (const btn of $('varModeSeg').querySelectorAll('.seg-btn')) btn.classList.toggle('active', btn.dataset.mode === mode);
  $('varAutoHint').hidden = mode !== 'auto';
  $('varManualField').hidden = mode !== 'manual';
}

function openSettings() {
  $('varDeg').value = settings.varDeg;
  $('varDir').value = settings.varDir;
  $('minInterval').value = settings.minInterval;
  applyVarModeUI(settings.varMode);
  $('settingsPanel').hidden = false;
}

function closeSettings() { $('settingsPanel').hidden = true; }

$('settingsBtn').addEventListener('click', openSettings);
$('settingsClose').addEventListener('click', closeSettings);
$('settingsPanel').addEventListener('click', (e) => { if (e.target === $('settingsPanel')) closeSettings(); });
$('varModeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('.seg-btn');
  if (b) applyVarModeUI(b.dataset.mode);
});
$('settingsSave').addEventListener('click', () => {
  const varDeg = Math.abs(parseFloat($('varDeg').value));
  const minInterval = Math.abs(parseFloat($('minInterval').value));
  settings = {
    varMode: pendingVarMode === 'manual' ? 'manual' : 'auto',
    varDeg: Number.isFinite(varDeg) ? varDeg : 0,
    varDir: $('varDir').value === 'E' ? 'E' : 'W',
    minInterval: Number.isFinite(minInterval) && minInterval > 0 ? minInterval : DEFAULT_SETTINGS.minInterval,
  };
  save('auxsar.settings', settings);
  updateTwcMeta();
  if (lastDatum) computeDatumUI();
  if (lastPlan) planSearch();
  closeSettings();
});

// ---------- start up ----------

buildObjectSelect();
buildSpacingTable();
buildChips();
for (const id of FORM_IDS) {
  if (form[id] != null && form[id] !== '') $(id).value = form[id];
  $(id).addEventListener('change', saveForm);
  $(id).addEventListener('input', saveForm);
}
if (!$('lkpTime').value) $('lkpTime').value = toLocalInput(Date.now());
for (const id of ['twcSet', 'twcDrift', 'lkpLat', 'lkpLon']) $(id).addEventListener('input', updateTwcMeta);
for (const id of ['windSpeed', 'windFrom', 'objectSel']) {
  $(id).addEventListener('input', updateLeewayMeta);
  $(id).addEventListener('change', updateLeewayMeta);
}
renderTwc();
updateLeewayMeta();
updatePatternUI();
renderLog();
let startTab = 'datum';
try { startTab = localStorage.getItem('auxsar.tab') || 'datum'; } catch (e) { /* ignore */ }
showTab(TAB_TITLES[startTab] ? startTab : 'datum');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is best-effort */ });
  });
}
