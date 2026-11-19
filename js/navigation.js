// RAHIN — موتور مسیریابی زنده روی نقشه
import {
  haversine,
  bearing,
  clamp,
  spokenDistance,
  fmtDistance,
  fmtDuration,
  fmtArrival,
} from './domain.js';
import { voice, turnIcon } from './voice.js';

export class NavigationEngine {
  constructor({ mapEngine, onUpdate, onArrive, onReroute, onExit, units = 'metric' } = {}) {
    this.map = mapEngine;
    this.onUpdate = onUpdate;
    this.onArrive = onArrive;
    this.onReroute = onReroute;
    this.onExit = onExit;
    this.units = units;

    this.route = null;
    this.mode = 'auto';
    this.active = false;
    this.cum = [];
    this.progressDist = 0;
    this.maneuverIndex = 0;
    this.announced = {};
    this.offRouteCount = 0;
    this.lastPosition = null;
    this.lastRerouteAt = 0;
    this.speedKmh = 0;
    this._lastGpsAt = 0;
  }

  start(route, { mode = 'auto' } = {}) {
    if (!route?.geometry?.length) return false;
    this.route = route;
    this.mode = mode;
    this.active = true;
    this.cum = cumulative(route.geometry);
    this.progressDist = 0;
    this.maneuverIndex = 0;
    this.announced = {};
    this.offRouteCount = 0;
    this.lastRerouteAt = 0;
    voice.announceManeuver(pickFirstRouteManeuver(route), null);
    return true;
  }

  stop() {
    this.active = false;
    this.route = null;
    voice.stop();
  }

  totalRemaining() {
    if (!this.route) return 0;
    return Math.max(0, this.route.distance_m - this.progressDist);
  }

  update(pos) {
    if (!this.active || !this.route || !pos) return;
    const { lat, lon, heading = null, accuracy = null, speed = null } = pos;
    this.lastPosition = { lat, lon };
    this._lastGpsAt = Date.now();
    if (speed != null && Number.isFinite(speed) && speed >= 0) this.speedKmh = speed * 3.6;

    const snap = closestPointOnPath({ lat, lon }, this.route.geometry, this.cum);
    const offRoute = snap.distance;

    if (offRoute > 65 && (accuracy == null || accuracy < 75)) {
      this.offRouteCount++;
      if (this.offRouteCount >= 3 && Date.now() - this.lastRerouteAt > 18000) {
        this.lastRerouteAt = Date.now();
        this.offRouteCount = 0;
        voice.announceReroute();
        this.onReroute?.({ at: { lat, lon } });
        return;
      }
    } else {
      this.offRouteCount = 0;
    }

    if (offRoute < 90) {
      const snapDist = snap.distanceAlong;
      if (snapDist > this.progressDist - 25) this.progressDist = Math.max(this.progressDist, snapDist);
    }

    const maneuvers = this.route.maneuvers || [];
    let mi = this.maneuverIndex;
    while (mi < maneuvers.length - 1 && maneuvers[mi + 1].offset_m <= this.progressDist + 5) mi++;
    this.maneuverIndex = mi;

    const next = maneuvers[mi + 1] || maneuvers[mi] || null;
    const distToNext = next ? Math.max(0, (next.offset_m || 0) - this.progressDist) : 0;

    if (next) {
      const key = `${mi + 1}`;
      const done = this.announced[key] || new Set();
      for (const threshold of voice.announcePlan(distToNext)) {
        if (distToNext <= threshold && !done.has(threshold)) {
          done.add(threshold);
          this.announced[key] = done;
          voice.announceManeuver(next, distToNext);
          break;
        }
      }
    }

    const endPoint = this.route.geometry[this.route.geometry.length - 1];
    const distToEnd = haversine({ lat, lon }, { lat: endPoint[0], lon: endPoint[1] });
    if (distToEnd < 30 || this.progressDist >= this.route.distance_m - 15) {
      voice.announceArrive();
      this.active = false;
      this.onArrive?.();
      return;
    }

    this.onUpdate?.({
      maneuver: next,
      distToNextTurn: distToNext,
      progress: clamp(this.progressDist / Math.max(1, this.route.distance_m), 0, 1),
      remainingM: this.totalRemaining(),
      remainingS: this.remainingTime(),
      offRoute,
      speedKmh: this.speedKmh,
      gpsAccuracy: accuracy,
      heading,
    });

    const hdg =
      heading != null && Number.isFinite(heading)
        ? heading
        : bearing(
            {
              lat: this.route.geometry[Math.max(0, snap.index)][0],
              lon: this.route.geometry[Math.max(0, snap.index)][1],
            },
            {
              lat: this.route.geometry[Math.min(this.route.geometry.length - 1, snap.index + 3)][0],
              lon: this.route.geometry[Math.min(this.route.geometry.length - 1, snap.index + 3)][1],
            }
          );
    this.map?.moveCameraForNavigation(lat, lon, hdg);
  }

  remainingTime() {
    if (!this.route) return 0;
    const frac = clamp(this.progressDist / Math.max(1, this.route.distance_m), 0, 1);
    return Math.max(0, this.route.time_s * (1 - frac));
  }

  toHudModel() {
    if (!this.route) return null;
    const maneuvers = this.route.maneuvers || [];
    const next = maneuvers[this.maneuverIndex + 1] || maneuvers[0] || null;
    return {
      remainingM: this.totalRemaining(),
      remainingS: this.remainingTime(),
      progress: clamp(this.progressDist / Math.max(1, this.route.distance_m), 0, 1),
      maneuver: next,
      distToNextTurn: next?.length_m || this.route.distance_m,
      speedKmh: this.speedKmh,
    };
  }
}

export function pickFirstRouteManeuver(route) {
  const ms = route?.maneuvers || [];
  return ms.find((m) => m.kind !== 'depart' && m.kind !== 'arrive') || ms[0] || null;
}

export function cumulative(geometry) {
  const cum = [0];
  for (let i = 1; i < geometry.length; i++) {
    cum.push(
      cum[i - 1] +
        haversine(
          { lat: geometry[i - 1][0], lon: geometry[i - 1][1] },
          { lat: geometry[i][0], lon: geometry[i][1] }
        )
    );
  }
  return cum;
}

export function closestPointOnPath(p, path, cum = null) {
  if (!cum) cum = cumulative(path);
  let best = { distance: Infinity, index: 0, distanceAlong: 0 };
  const windowSize = 60;
  let start = 0;
  let end = path.length - 1;
  if (path.length > 400) {
    let coarseBest = { d: Infinity, i: 0 };
    for (let i = 0; i < path.length; i += 20) {
      const d = haversine(p, { lat: path[i][0], lon: path[i][1] });
      if (d < coarseBest.d) coarseBest = { d, i };
    }
    start = Math.max(0, coarseBest.i - windowSize);
    end = Math.min(path.length - 1, coarseBest.i + windowSize);
  }
  for (let i = start; i < end; i++) {
    const a = { lat: path[i][0], lon: path[i][1] };
    const b = { lat: path[i + 1][0], lon: path[i + 1][1] };
    const segLen = cum[i + 1] - cum[i];
    const t = segLen ? clamp(projectParam(p, a, b), 0, 1) : 0;
    const proj = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
    const d = haversine(p, proj);
    if (d < best.distance) best = { distance: d, index: i, distanceAlong: cum[i] + segLen * t };
  }
  return best;
}

function projectParam(p, a, b) {
  const x = (p.lon - a.lon) * Math.cos((((p.lat + a.lat) / 2) * Math.PI) / 180);
  const y = p.lat - a.lat;
  const dx = (b.lon - a.lon) * Math.cos((((b.lat + a.lat) / 2) * Math.PI) / 180);
  const dy = b.lat - a.lat;
  const len2 = dx * dx + dy * dy;
  return len2 ? (x * dx + y * dy) / len2 : 0;
}

export function describeRoute(route, units = 'metric') {
  return {
    distanceText: fmtDistance(route.distance_m, units),
    timeText: fmtDuration(route.time_s),
    arrivalText: fmtArrival(route.time_s),
  };
}

export { turnIcon, spokenDistance };
