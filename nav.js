// Live guidance along a planned search pattern ("Commence search").
// Follows GPS fixes, and speaks (all courses magnetic):
//   - at the CSP: "CSP reached ... leg one, course XXX magnetic"
//   - before each turn: the next leg's course, then a five-second countdown
//   - at the turn: "Turn now"
// Timing runs from tick(), so the countdown stays one second per number even though
// GPS fixes only arrive about once a second. No DOM access, so tests can drive it.

import { rhumbCourseDistance, norm360, fmtCourse, toRad } from './geo.js';

export const COUNTDOWN_S = 5;
// The next-leg course is spoken this long before the turn, which leaves about four
// seconds to say it before the countdown starts.
export const ANNOUNCE_LEAD_S = 11;
const KN_PER_M_S = 1.943844;
const MIN_SPEED_KN = 0.3;

const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const COUNT_WORDS = ['', 'one', 'two', 'three', 'four', 'five'];

// "022" -> "zero two two", the way courses are read over the radio.
export function sayCourse(deg) {
  return fmtCourse(deg).split('').map((d) => DIGITS[Number(d)]).join(' ');
}

function sayDistance(nm) {
  if (nm < 0.1) return `${Math.round((nm * 2025.37) / 10) * 10} yards`;
  return `${nm.toFixed(1)} miles`;
}

// Position relative to a leg: distance run along it, distance left, and cross-track
// error (nm, + = right of the track line).
export function legProgress(leg, pos) {
  const { course, distNm } = rhumbCourseDistance(leg.from.lat, leg.from.lon, pos.lat, pos.lon);
  const a = toRad(course - leg.courseT);
  const along = distNm * Math.cos(a);
  return { along, xte: distNm * Math.sin(a), remaining: leg.distNm - along };
}

// How close counts as "at the CSP": a quarter of the track spacing, 30 to 90 m.
export function arrivalRadiusNm(spacing) {
  const s = Number.isFinite(spacing) && spacing > 0 ? spacing : 0.2;
  return Math.min(0.05, Math.max(0.016, s / 4));
}

export class SearchNavigator {
  // plan: from patterns.js plus { spacing, speed, variation: { value } }.
  // speak(text, { interrupt }) and log(type, text, fix) are supplied by the app.
  constructor(plan, { speak = () => {}, log = () => {} } = {}) {
    this.plan = plan;
    this.speak = speak;
    this.log = log;
    this.variation = plan.variation ? plan.variation.value : 0;
    this.radiusNm = arrivalRadiusNm(plan.spacing);
    this.phase = 'idle';
    this.leg = 0;
    this.fix = null;
    this.speedKn = null;
    this.track = [];
    this.resetLegTiming();
  }

  mag(courseT) { return norm360(courseT - this.variation); }

  resetLegTiming() {
    this.eta = null; // seconds to the end of the leg, as of etaTime
    this.etaTime = null;
    this.announced = false;
    this.turnAt = null; // ms timestamp of the turn once the countdown has begun
    this.lastCount = null;
  }

  // Start heading for the CSP, or resume part way through at a given leg.
  start(resumeLeg = null) {
    this.track = [];
    this.resetLegTiming();
    if (resumeLeg != null && resumeLeg > 0 && resumeLeg < this.plan.legs.length) {
      this.phase = 'leg';
      this.leg = resumeLeg;
      const l = this.plan.legs[this.leg];
      this.speak(`Resuming leg ${this.leg + 1}, course ${sayCourse(this.mag(l.courseT))} magnetic.`, { interrupt: true });
      return;
    }
    this.phase = 'toCSP';
    this.leg = 0;
    this.cspAnnounced = false;
    this.speak('Search guidance started.', { interrupt: true });
  }

  stop() {
    this.phase = 'idle';
    this.resetLegTiming();
  }

  // fix: { lat, lon, time (ms), speedKn?, headingT? }
  update(fix) {
    const prev = this.fix;
    this.fix = fix;
    if (Number.isFinite(fix.speedKn) && fix.speedKn >= 0) {
      this.speedKn = fix.speedKn;
    } else if (prev && fix.time - prev.time >= 900) {
      const d = rhumbCourseDistance(prev.lat, prev.lon, fix.lat, fix.lon).distNm;
      const v = d / ((fix.time - prev.time) / 3600000);
      this.speedKn = this.speedKn == null ? v : 0.5 * this.speedKn + 0.5 * v;
    }
    if (this.phase === 'idle' || this.phase === 'done') return;
    this.track.push({ lat: fix.lat, lon: fix.lon });
    if (this.track.length > 5000) this.track.shift();

    if (this.phase === 'toCSP') {
      const csp = this.plan.csp;
      const to = rhumbCourseDistance(fix.lat, fix.lon, csp.lat, csp.lon);
      if (to.distNm <= this.radiusNm) {
        this.reachCsp(fix);
      } else if (!this.cspAnnounced) {
        this.cspAnnounced = true;
        this.speak(`Steer ${sayCourse(this.mag(to.course))} magnetic for the CSP, ${sayDistance(to.distNm)}.`);
      }
      return;
    }

    const leg = this.plan.legs[this.leg];
    const p = legProgress(leg, fix);
    if (this.turnAt != null) return; // countdown already running
    const speed = this.speedKn != null && this.speedKn >= MIN_SPEED_KN ? this.speedKn : null;
    if (p.remaining <= 0) {
      // Already past the turn point (GPS gap or slow fixes): turn straight away.
      if (!this.announced) this.announceNext(true);
      this.turn();
      return;
    }
    this.eta = speed ? (p.remaining / speed) * 3600 : null;
    this.etaTime = fix.time;
  }

  reachCsp(fix) {
    this.phase = 'leg';
    this.leg = 0;
    this.resetLegTiming();
    const l = this.plan.legs[0];
    const c = sayCourse(this.mag(l.courseT));
    this.speak(`CSP reached. Commence search. Leg one, course ${c} magnetic.`, { interrupt: true });
    this.log('Commence search', `CSP reached. ${this.plan.name}, leg 1 course ${fmtCourse(this.mag(l.courseT))}°M.`, fix);
  }

  announceNext(interrupt = false) {
    this.announced = true;
    const next = this.plan.legs[this.leg + 1];
    if (next) {
      this.speak(`Next, leg ${this.leg + 2}, course ${sayCourse(this.mag(next.courseT))} magnetic.`, { interrupt });
    } else {
      this.speak('Final leg ends in ten seconds.', { interrupt });
    }
  }

  // Call often (every 100-250 ms). Drives the announcement, countdown and turn.
  tick(now) {
    if (this.phase !== 'leg') return;
    if (this.turnAt == null) {
      if (this.eta == null) return;
      const left = this.eta - (now - this.etaTime) / 1000;
      if (!this.announced && left <= ANNOUNCE_LEAD_S) this.announceNext();
      if (left <= COUNTDOWN_S + 0.05) this.turnAt = now + Math.max(0, left) * 1000;
      else return;
    }
    const left = (this.turnAt - now) / 1000;
    if (left <= 0.05) {
      this.turn();
      return;
    }
    const n = Math.min(COUNTDOWN_S, Math.ceil(left - 0.05));
    if (n >= 1 && n !== this.lastCount) {
      this.lastCount = n;
      this.speak(COUNT_WORDS[n], { interrupt: true });
    }
  }

  turn() {
    const last = this.leg >= this.plan.legs.length - 1;
    if (last) {
      this.phase = 'done';
      this.resetLegTiming();
      this.speak('Search pattern complete.', { interrupt: true });
      this.log('Search complete', `${this.plan.name} complete.`, this.fix);
      return;
    }
    this.speak('Turn now.', { interrupt: true });
    this.leg += 1;
    this.resetLegTiming();
  }

  // Manual leg change from the screen.
  skip(delta) {
    if (this.phase !== 'leg' && !(this.phase === 'toCSP' && delta > 0)) return;
    const target = this.phase === 'toCSP' ? 0 : Math.max(0, Math.min(this.plan.legs.length - 1, this.leg + delta));
    this.phase = 'leg';
    this.leg = target;
    this.resetLegTiming();
    const l = this.plan.legs[this.leg];
    this.speak(`Leg ${this.leg + 1}, course ${sayCourse(this.mag(l.courseT))} magnetic.`, { interrupt: true });
  }

  // Everything the screen shows. Courses are magnetic.
  status(now) {
    const s = { phase: this.phase, leg: this.leg, legs: this.plan.legs.length, speedKn: this.speedKn, fix: this.fix };
    if (this.fix && Number.isFinite(this.fix.headingT) && this.speedKn != null && this.speedKn >= MIN_SPEED_KN) {
      s.cogM = this.mag(this.fix.headingT);
    }
    if (this.phase === 'toCSP' && this.fix) {
      const to = rhumbCourseDistance(this.fix.lat, this.fix.lon, this.plan.csp.lat, this.plan.csp.lon);
      s.steerM = this.mag(to.course);
      s.distNm = to.distNm;
      s.etaS = this.speedKn >= MIN_SPEED_KN ? (to.distNm / this.speedKn) * 3600 : null;
      s.nextM = this.mag(this.plan.legs[0].courseT);
    } else if (this.phase === 'leg') {
      const leg = this.plan.legs[this.leg];
      s.steerM = this.mag(leg.courseT);
      const next = this.plan.legs[this.leg + 1];
      s.nextM = next ? this.mag(next.courseT) : null;
      if (this.fix) {
        const p = legProgress(leg, this.fix);
        s.distNm = Math.max(0, p.remaining);
        s.xteNm = p.xte;
      }
      if (this.turnAt != null) s.etaS = Math.max(0, (this.turnAt - now) / 1000);
      else if (this.eta != null) s.etaS = Math.max(0, this.eta - (now - this.etaTime) / 1000);
      s.countdown = this.turnAt != null;
    }
    return s;
  }

  // Progress to save so a reloaded app can resume.
  snapshot() { return { phase: this.phase, leg: this.leg }; }
}

export function fixFromPosition(pos) {
  const c = pos.coords;
  return {
    lat: c.latitude,
    lon: c.longitude,
    accuracy: c.accuracy,
    time: pos.timestamp || Date.now(),
    speedKn: c.speed != null && Number.isFinite(c.speed) ? c.speed * KN_PER_M_S : undefined,
    headingT: c.heading != null && Number.isFinite(c.heading) ? c.heading : undefined,
  };
}
