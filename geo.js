// Position and course math. Great-circle formulas come from Set & Drift;
// search legs are steered as constant compass courses, so pattern waypoints use rhumb lines.

export const EARTH_RADIUS_M = 6371000;
export const M_PER_NM = 1852;
const R_NM = EARTH_RADIUS_M / M_PER_NM;

export function toRad(d) { return (d * Math.PI) / 180; }
export function toDeg(r) { return (r * 180) / Math.PI; }
export function norm360(d) { return ((d % 360) + 360) % 360; }

// Initial great-circle bearing from point 1 to point 2, degrees true, 0-360.
export function bearingTrue(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1), phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return norm360(toDeg(Math.atan2(y, x)));
}

// Great-circle distance in meters (haversine).
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1), phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Point reached by steering a constant true course for distNm from (lat, lon).
export function rhumbDestination(lat, lon, courseT, distNm) {
  const d = distNm / R_NM;
  const theta = toRad(courseT);
  const phi1 = toRad(lat);
  const dPhi = d * Math.cos(theta);
  let phi2 = phi1 + dPhi;
  if (Math.abs(phi2) > Math.PI / 2) phi2 = phi2 > 0 ? Math.PI - phi2 : -Math.PI - phi2;
  const dPsi = Math.log(Math.tan(phi2 / 2 + Math.PI / 4) / Math.tan(phi1 / 2 + Math.PI / 4));
  const q = Math.abs(dPsi) > 1e-12 ? dPhi / dPsi : Math.cos(phi1);
  const dLambda = (d * Math.sin(theta)) / q;
  const lon2 = ((toDeg(toRad(lon) + dLambda) + 540) % 360) - 180;
  return { lat: toDeg(phi2), lon: lon2 };
}

// Constant course and distance (nm) from point 1 to point 2.
export function rhumbCourseDistance(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1), phi2 = toRad(lat2);
  const dPhi = phi2 - phi1;
  let dLambda = toRad(lon2 - lon1);
  if (Math.abs(dLambda) > Math.PI) dLambda = dLambda > 0 ? -(2 * Math.PI - dLambda) : 2 * Math.PI + dLambda;
  const dPsi = Math.log(Math.tan(phi2 / 2 + Math.PI / 4) / Math.tan(phi1 / 2 + Math.PI / 4));
  const q = Math.abs(dPsi) > 1e-12 ? dPhi / dPsi : Math.cos(phi1);
  const course = norm360(toDeg(Math.atan2(dLambda, dPsi)));
  const distNm = Math.sqrt(dPhi * dPhi + q * q * dLambda * dLambda) * R_NM;
  return { course, distNm };
}

// Add a vector (course °T, length) to a running east/north sum.
export function vecFromPolar(courseT, length) {
  return { e: length * Math.sin(toRad(courseT)), n: length * Math.cos(toRad(courseT)) };
}

export function polarFromVec(v) {
  return { course: norm360(toDeg(Math.atan2(v.e, v.n))), length: Math.hypot(v.e, v.n) };
}

export function formatDMM(lat, lon) {
  function part(value, posLetter, negLetter, degWidth) {
    const letter = value >= 0 ? posLetter : negLetter;
    const abs = Math.abs(value);
    let deg = Math.floor(abs);
    let min = (abs - deg) * 60;
    if (min >= 59.9995) { deg += 1; min = 0; }
    return `${String(deg).padStart(degWidth, '0')}°${min.toFixed(3).padStart(6, '0')}'${letter}`;
  }
  return `${part(lat, 'N', 'S', 2)} ${part(lon, 'E', 'W', 3)}`;
}

// Parse a latitude or longitude typed as decimal degrees, "DD MM.mmm", or "DD MM SS",
// with an optional hemisphere letter. Returns NaN when it can't be read.
export function parseCoord(text, isLat) {
  if (text == null) return NaN;
  let s = String(text).trim().toUpperCase().replace(/[°'"′″,]/g, ' ');
  let sign = 1;
  const hemi = s.match(/[NSEW]/);
  if (hemi) {
    if (hemi[0] === 'S' || hemi[0] === 'W') sign = -1;
    if ((hemi[0] === 'N' || hemi[0] === 'S') !== isLat) return NaN;
    s = s.replace(/[NSEW]/g, ' ');
  }
  s = s.trim();
  if (s.startsWith('-')) { sign = -sign; s = s.slice(1); }
  const parts = s.split(/\s+/).filter(Boolean).map(Number);
  if (!parts.length || parts.some((p) => !Number.isFinite(p) || p < 0)) return NaN;
  const [d, m = 0, sec = 0] = parts;
  if (parts.length > 1 && (m >= 60 || sec >= 60)) return NaN;
  const value = sign * (d + m / 60 + sec / 3600);
  return Math.abs(value) <= (isLat ? 90 : 180) ? value : NaN;
}

// Minutes as m:ss, matching the timing chart in the Coxswain SAR Guide.
export function formatMinSec(hours) {
  const total = Math.round(hours * 3600);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtCourse(deg) {
  return String(Math.round(norm360(deg)) % 360).padStart(3, '0');
}

// Magnetic variation, East positive (Magnetic = True - Variation). Uses WMM2025 from
// Set & Drift unless the user set a manual value.
export function variationAt(lat, lon, timeMs, settings) {
  const manual = () => ({
    value: settings.varDir === 'E' ? settings.varDeg : -settings.varDeg,
    source: 'manual',
  });
  if (settings.varMode === 'manual') return manual();
  try {
    // wmm.js is a classic script; its top-level const is a global binding, not a window property.
    // eslint-disable-next-line no-undef
    const value = WMM.declination(lat, lon, 0, WMM.toDecimalYear(timeMs));
    if (!Number.isFinite(value)) return manual();
    return { value, source: 'WMM2025' };
  } catch (e) {
    return manual();
  }
}

export function formatVariation(v) {
  return `${Math.abs(v.value).toFixed(1)}° ${v.value >= 0 ? 'E' : 'W'} (${v.source})`;
}

export function getFix() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Location is not available on this device/browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        time: pos.timestamp || Date.now(),
      }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  });
}
