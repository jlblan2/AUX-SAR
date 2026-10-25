// Single-unit search patterns, following the USCG Coxswain SAR Guide (2006) and the
// CG search pattern training slides:
//   SS  Expanding square   CSP at datum, first leg down drift (000°T with no drift),
//                          90° right turns, legs grow one S every other leg,
//                          second search rotated 45° right.
//   VS  Sector             CSP at datum, first leg down drift (000°T), 120° right turns,
//                          every leg one S (S = radius), 9 legs; second search rotated
//                          30° right, second SRU (VM) rotated 90° left.
//   PS  Parallel           Legs parallel to the major axis, CSP ½S inside a corner,
//                          cross legs one S.
//   CS  Creeping line      Legs parallel to the minor axis, creeping along the major axis.
//   TSR/TSN Trackline      Return: out ½S to one side of the intended track, cross one S,
//                          back ½S on the other side. Non-return: along the track once.
//
// Every pattern returns { code, name, csp, legs, totalNm, points } where each leg is
// { n, courseT, distNm, from, to, kind } and points are [east, north] in nm from datum
// (for drawing).

import { norm360, rhumbDestination, rhumbCourseDistance, vecFromPolar } from './geo.js';

export const PATTERNS = {
  SS: 'Expanding Square (SS)',
  VS: 'Sector (VS)',
  PS: 'Parallel (PS)',
  CS: 'Creeping Line (CS)',
  TSR: 'Trackline, Return (TSR)',
  TSN: 'Trackline, Non-return (TSN)',
};

// Initial track spacing (nm) for the first SRU on scene, Coxswain SAR Guide p. 7.
// Good = winds < 15 kn and seas < 3 ft; poor = winds ≥ 15 kn or seas ≥ 3 ft.
export const INITIAL_TRACK_SPACING = [
  { object: 'PIW', good: 0.1, poor: 0.1 },
  { object: 'Vessels < 15 ft', good: 0.5, poor: 0.2 },
  { object: 'Vessels ≥ 15 ft', good: 1.0, poor: 0.5 },
];

// Build legs from a start point and a list of [course, distance, kind] steps.
function walk(start, startLocal, steps) {
  const legs = [];
  const points = [startLocal.slice()];
  let pos = start;
  let local = startLocal.slice();
  steps.forEach(([courseT, distNm, kind], i) => {
    const c = norm360(courseT);
    const to = rhumbDestination(pos.lat, pos.lon, c, distNm);
    const v = vecFromPolar(c, distNm);
    local = [local[0] + v.e, local[1] + v.n];
    legs.push({ n: i + 1, courseT: c, distNm, from: pos, to, kind });
    points.push(local.slice());
    pos = to;
  });
  const totalNm = legs.reduce((sum, l) => sum + l.distNm, 0);
  return { csp: start, legs, totalNm, points };
}

function requirePositive(value, label) {
  if (!(Number.isFinite(value) && value > 0)) throw new Error(`${label} must be greater than zero.`);
}

export function expandingSquare({ datum, spacing, firstCourse = 0, legCount = 12, secondSearch = false }) {
  requirePositive(spacing, 'Track spacing');
  const n = Math.max(1, Math.min(60, Math.round(legCount)));
  const c0 = firstCourse + (secondSearch ? 45 : 0);
  const steps = [];
  for (let i = 1; i <= n; i++) {
    steps.push([c0 + 90 * (i - 1), Math.ceil(i / 2) * spacing, 'search']);
  }
  return { code: secondSearch ? 'SS (2nd)' : 'SS', name: PATTERNS.SS, ...walk(datum, [0, 0], steps) };
}

// Relative courses of the nine sector legs: three equilateral triangles, each returning
// through datum ("on the 3rd, 6th and 9th legs steer on your marker").
const SECTOR_TURNS = [0, 120, 240, 240, 0, 120, 120, 240, 0];

// rotation: 'first' | 'second' (same SRU, +30°) | 'vm' (second SRU, -90°)
export function sector({ datum, spacing, firstCourse = 0, rotation = 'first' }) {
  requirePositive(spacing, 'Track spacing (radius)');
  const offset = rotation === 'second' ? 30 : rotation === 'vm' ? -90 : 0;
  const code = rotation === 'second' ? 'VS (2nd)' : rotation === 'vm' ? 'VM' : 'VS';
  const steps = SECTOR_TURNS.map((t, i) => [firstCourse + offset + t, spacing, (i + 1) % 3 === 0 ? 'return' : 'search']);
  return { code, name: PATTERNS.VS, ...walk(datum, [0, 0], steps) };
}

// Corners of a search area as signs along (major axis, right of major axis).
export const CORNERS = [[1, -1], [1, 1], [-1, 1], [-1, -1]];

const POINTS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// Compass name of a corner (e.g. "NE") given the area's major axis orientation.
export function cornerName(corner, majorAxis, length, width) {
  const v = vecFromPolar(majorAxis, corner[0] * length / 2);
  const w = vecFromPolar(majorAxis + 90, corner[1] * width / 2);
  const brg = norm360((Math.atan2(v.e + w.e, v.n + w.n) * 180) / Math.PI);
  return POINTS_8[Math.round(brg / 45) % 8];
}

// center: area center (usually datum). majorAxis: true direction of the long side.
// corner: one of CORNERS, the corner nearest the CSP.
export function parallelOrCreeping({ type, center, length, width, majorAxis = 0, spacing, corner = CORNERS[0] }) {
  requirePositive(spacing, 'Track spacing');
  requirePositive(length, 'Length');
  requirePositive(width, 'Width');
  const [su, sv] = corner;
  const creeping = type === 'CS';
  // Search legs run along "along"; the pattern steps over one S at a time along "across".
  const alongAxis = creeping ? majorAxis + 90 : majorAxis;
  const acrossAxis = creeping ? majorAxis : majorAxis + 90;
  const alongSize = creeping ? width : length;
  const acrossSize = creeping ? length : width;
  const alongSign = creeping ? sv : su;
  const acrossSign = creeping ? su : sv;

  const legLen = alongSize - spacing;
  if (legLen <= 0) throw new Error(`The ${creeping ? 'width' : 'length'} must be more than one track spacing.`);
  const tracks = Math.max(1, Math.round(acrossSize / spacing));

  // CSP is ½S in from both sides at the chosen corner.
  const a = vecFromPolar(alongAxis, alongSign * (alongSize / 2 - spacing / 2));
  const b = vecFromPolar(acrossAxis, acrossSign * (acrossSize / 2 - spacing / 2));
  const cspLocal = [a.e + b.e, a.n + b.n];
  const cspCourse = norm360((Math.atan2(cspLocal[0], cspLocal[1]) * 180) / Math.PI);
  const csp = rhumbDestination(center.lat, center.lon, cspCourse, Math.hypot(cspLocal[0], cspLocal[1]));

  const legCourse = norm360(alongAxis + (alongSign > 0 ? 180 : 0)); // run away from the CSP side
  const stepCourse = norm360(acrossAxis + (acrossSign > 0 ? 180 : 0)); // step toward the far side
  const steps = [];
  for (let k = 0; k < tracks; k++) {
    steps.push([k % 2 === 0 ? legCourse : legCourse + 180, legLen, 'search']);
    if (k < tracks - 1) steps.push([stepCourse, spacing, 'cross']);
  }
  return { code: type, name: PATTERNS[type], ...walk(csp, cspLocal, steps) };
}

// Trackline search between origin and destination. side: 'right' or 'left' of the
// intended track for the outbound leg (TSR only).
export function trackline({ origin, destination, spacing, returnLeg = true, side = 'right' }) {
  const { course, distNm } = rhumbCourseDistance(origin.lat, origin.lon, destination.lat, destination.lon);
  requirePositive(distNm, 'Distance from origin to destination');
  if (!returnLeg) {
    return { code: 'TSN', name: PATTERNS.TSN, ...walk(origin, [0, 0], [[course, distNm, 'search']]) };
  }
  requirePositive(spacing, 'Track spacing');
  const out = side === 'left' ? -90 : 90;
  const csp = rhumbDestination(origin.lat, origin.lon, course + out, spacing / 2);
  const off = vecFromPolar(course + out, spacing / 2);
  const steps = [
    [course, distNm, 'search'],
    [course + out + 180, spacing, 'cross'],
    [course + 180, distNm, 'search'],
  ];
  return { code: 'TSR', name: PATTERNS.TSR, ...walk(csp, [off.e, off.n], steps) };
}

// Time to run a distance at a speed, in hours.
export function legHours(distNm, speedKn) {
  return speedKn > 0 ? distNm / speedKn : NaN;
}
