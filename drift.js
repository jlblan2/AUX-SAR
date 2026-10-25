// Datum (drifted position of the search object) from the last known position,
// total water current (TWC) and wind leeway, done the IAMSAR manual way: the object can
// slip either side of downwind, so there is a left and a right datum and the search
// datum is midway between them.

import {
  M_PER_NM, bearingTrue, distanceMeters, rhumbDestination, rhumbCourseDistance,
  vecFromPolar, polarFromVec, norm360,
} from './geo.js';

const KN_PER_CM_S = 0.0194384;

// TWC from two GPS fixes taken alongside a drifting datum marker (or drifting with
// engines off). Same calculation as Set & Drift.
export function currentFromFixes(fix1, fix2) {
  const hours = (fix2.time - fix1.time) / 3600000;
  const distNm = distanceMeters(fix1.lat, fix1.lon, fix2.lat, fix2.lon) / M_PER_NM;
  return {
    setT: bearingTrue(fix1.lat, fix1.lon, fix2.lat, fix2.lon),
    driftKn: hours > 0 ? distNm / hours : NaN,
    distNm,
    hours,
  };
}

// Leeway speeds (kn) for one search object at a 10 m wind speed (kn). dwl is downwind;
// cwlR and cwlL are the crosswind parts to the right (+) and left (−) of downwind.
export function leewaySpeeds(obj, windKn) {
  if (!obj || !(windKn > 0)) return { dwl: 0, cwlR: 0, cwlL: 0 };
  const speed = ([slope, offset]) => (slope / 100) * windKn + offset * KN_PER_CM_S;
  return {
    dwl: Math.max(0, speed(obj.dwl)),
    cwlR: speed(obj.cwlR),
    cwlL: speed(obj.cwlL),
  };
}

// Divergence angle (degrees) of the right and left leeway from straight downwind.
export function divergence(lw) {
  const ang = (c) => (lw.dwl > 0 || c !== 0 ? (Math.atan2(c, lw.dwl) * 180) / Math.PI : 0);
  return { right: ang(lw.cwlR), left: ang(lw.cwlL) };
}

// lkp: {lat, lon}; times in ms; twc: {setT, driftKn}; wind: {fromT, speedKn}; object: leeway entry.
export function computeDatum({ lkp, lkpTime, datumTime, twc, wind, object }) {
  const hours = (datumTime - lkpTime) / 3600000;
  if (!(hours >= 0)) throw new Error('Datum time must be after the LKP time.');

  const current = vecFromPolar(twc.setT || 0, twc.driftKn || 0);
  const lw = leewaySpeeds(object, wind.speedKn);
  const downwind = norm360((wind.fromT || 0) + 180);
  const leewayVec = (cross) => {
    const a = vecFromPolar(downwind, lw.dwl);
    const b = vecFromPolar(downwind + 90, cross);
    return { e: a.e + b.e, n: a.n + b.n };
  };
  const lR = leewayVec(lw.cwlR);
  const lL = leewayVec(lw.cwlL);

  const drifted = (lv) => {
    const total = polarFromVec({ e: current.e + lv.e, n: current.n + lv.n });
    const pos = rhumbDestination(lkp.lat, lkp.lon, total.course, total.length * hours);
    return { setT: total.course, rateKn: total.length, distNm: total.length * hours, pos };
  };
  const right = drifted(lR);
  const left = drifted(lL);
  const mid = drifted({ e: (lR.e + lL.e) / 2, n: (lR.n + lL.n) / 2 });
  const sep = rhumbCourseDistance(left.pos.lat, left.pos.lon, right.pos.lat, right.pos.lon);

  return {
    hours,
    leeway: lw,
    divergence: divergence(lw),
    downwind,
    right,
    left,
    datum: mid.pos,
    driftSetT: mid.setT,
    driftRateKn: mid.rateKn,
    driftDistNm: mid.distNm,
    separationNm: sep.distNm,
  };
}
