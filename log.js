// Mission log kept on this phone (localStorage). Exported as text (share/email),
// CSV, or printed.

import { formatDMM } from './geo.js';

const KEY = 'auxsar.missions';

// Briefing items a coxswain gets before launching (Coxswain SAR Guide, "Briefing").
export const BRIEFING = [
  ['distress', 'Nature of distress'],
  ['lkp', 'Last known position'],
  ['object', 'Description of search object'],
  ['pob', 'Number of people on board'],
  ['tasking', 'Specific tasking from SMC'],
  ['weather', 'On scene and forecast weather'],
];

export const HEADER = [
  ['caseName', 'Case name / number'],
  ['sru', 'SRU / facility'],
  ['coxswain', 'Coxswain'],
  ['crew', 'Crew'],
  ['smc', 'SMC / OSC'],
  ['freq', 'Working frequency'],
];

export const ENTRY_TYPES = [
  'Underway', 'On scene', 'Commence search', 'Leg complete', 'Sighting',
  'SITREP', 'Weather', 'DMB deployed', 'Object located', 'Search complete',
  'Moored', 'Note',
];

export function loadMissions() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

export function saveMissions(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    return false;
  }
}

export function newMission() {
  const now = Date.now();
  return {
    id: `m${now.toString(36)}`,
    created: now,
    header: Object.fromEntries(HEADER.map(([k]) => [k, ''])),
    briefing: Object.fromEntries(BRIEFING.map(([k]) => [k, ''])),
    entries: [],
  };
}

export function missionTitle(m) {
  const d = new Date(m.created);
  const date = d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  return m.header.caseName ? `${m.header.caseName} — ${date}` : `Mission ${date} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

function stamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function entryPosition(e) {
  return Number.isFinite(e.lat) && Number.isFinite(e.lon) ? formatDMM(e.lat, e.lon) : '';
}

export function entryTime(e) { return stamp(e.time); }

export function toText(m) {
  const lines = [`AUX-SAR MISSION LOG`, missionTitle(m), `Started ${stamp(m.created)}`, ''];
  for (const [k, label] of HEADER) if (m.header[k]) lines.push(`${label}: ${m.header[k]}`);
  const brief = BRIEFING.filter(([k]) => m.briefing[k]);
  if (brief.length) {
    lines.push('', 'BRIEFING');
    for (const [k, label] of brief) lines.push(`${label}: ${m.briefing[k]}`);
  }
  lines.push('', 'LOG');
  const sorted = [...m.entries].sort((a, b) => a.time - b.time);
  for (const e of sorted) {
    const pos = entryPosition(e);
    lines.push(`${stamp(e.time)}  ${e.type}${pos ? `  ${pos}` : ''}`);
    if (e.text) lines.push(`    ${e.text.replace(/\n/g, '\n    ')}`);
  }
  return lines.join('\n');
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(m) {
  const rows = [['Time', 'Type', 'Latitude', 'Longitude', 'Position', 'Details']];
  const sorted = [...m.entries].sort((a, b) => a.time - b.time);
  for (const e of sorted) {
    rows.push([
      stamp(e.time), e.type,
      Number.isFinite(e.lat) ? e.lat.toFixed(5) : '',
      Number.isFinite(e.lon) ? e.lon.toFixed(5) : '',
      entryPosition(e), e.text || '',
    ]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function fileName(m, ext) {
  const base = (m.header.caseName || 'mission').replace(/[^\w-]+/g, '_').slice(0, 40);
  const d = new Date(m.created);
  const pad = (n) => String(n).padStart(2, '0');
  return `AUX-SAR_${base}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.${ext}`;
}
