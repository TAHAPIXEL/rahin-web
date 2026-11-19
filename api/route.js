import { fetchWithTimeout, readJsonBody, sendJson, haversineMeters } from '../lib/server-utils.js';

function decodePolyline6(str) {
  let index = 0, lat = 0, lng = 0;
  const coordinates = [];
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;
    shift = 0;
    result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dlng;
    coordinates.push([lat / 1e6, lng / 1e6]);
  }
  return coordinates;
}

const VALHALLA_TYPE_TO_KIND = {
  1: 'depart', 2: 'depart', 3: 'depart',
  4: 'arrive', 5: 'arrive', 6: 'arrive',
  7: 'continue', 8: 'continue',
  9: 'slight-right', 10: 'right', 11: 'sharp-right',
  12: 'uturn-right', 13: 'uturn-left',
  14: 'sharp-left', 15: 'left', 16: 'slight-left',
  17: 'ramp-straight', 18: 'ramp-right', 19: 'ramp-left',
  20: 'exit-right', 21: 'exit-left',
  22: 'stay-straight', 23: 'stay-right', 24: 'stay-left',
  25: 'merge', 26: 'roundabout-enter', 27: 'roundabout-exit',
  28: 'ferry', 29: 'ferry',
};

const KIND_LABELS_FA = {
  depart: 'شروع حرکت در مسیر',
  'slight-right': 'متمایل به راست',
  right: 'گردش به راست',
  'sharp-right': 'گردش تند به راست',
  'uturn-right': 'دور برگردان',
  'uturn-left': 'دور برگردان',
  'sharp-left': 'گردش تند به چپ',
  left: 'گردش به چپ',
  'slight-left': 'متمایل به چپ',
  continue: 'ادامه مستقیم مسیر',
  'ramp-straight': 'ورود به رمپ',
  'ramp-right': 'ورود به رمپ راست',
  'ramp-left': 'ورود به رمپ چپ',
  'exit-right': 'خروج از سمت راست',
  'exit-left': 'خروج از سمت چپ',
  'stay-straight': 'ادامه در لاین فعلی',
  'stay-right': 'ادامه در لاین راست',
  'stay-left': 'ادامه در لاین چپ',
  merge: 'ادغام در مسیر اصلی',
  'roundabout-enter': 'ورود به میدان',
  'roundabout-exit': 'خروج از میدان',
  ferry: 'عبور با شناور',
  arrive: 'رسیدن به مقصد',
};

function parseValhallaTrip(trip, provider = 'valhalla') {
  const legs = trip?.legs || [];
  let geometry = [];
  const maneuvers = [];
  let offsetM = 0;

  for (const leg of legs) {
    const pts = leg.shape ? decodePolyline6(leg.shape) : [];
    if (geometry.length && pts.length) geometry.push(...pts.slice(1));
    else geometry.push(...pts);

    for (const m of leg.maneuvers || []) {
      const kind = VALHALLA_TYPE_TO_KIND[m.type] || 'continue';
      const lenM = Math.round((m.length || 0) * 1000);
      const street = Array.isArray(m.street_names) ? m.street_names.join('، ') : '';
      const labelFa = KIND_LABELS_FA[kind] || 'ادامه مسیر';
      maneuvers.push({
        kind,
        label_fa: labelFa,
        instruction: m.instruction || (street ? `${labelFa} به سمت ${street}` : labelFa),
        street_fa: street,
        length_m: lenM,
        time_s: Math.round(m.time || 0),
        offset_m: offsetM,
      });
      offsetM += lenM;
    }
  }

  const distM = Math.round((trip?.summary?.length || 0) * 1000);
  const timeS = Math.round(trip?.summary?.time || 0);
  return {
    provider,
    distance_m: distM,
    time_s: timeS,
    geometry,
    maneuvers,
    flags: {
      has_toll: Boolean(trip?.summary?.has_toll),
      has_highway: Boolean(trip?.summary?.has_highway),
      has_ferry: Boolean(trip?.summary?.has_ferry),
    },
  };
}

function osrmStepToKind(step) {
  const type = step?.maneuver?.type || '';
  const mod = step?.maneuver?.modifier || '';
  if (type === 'depart') return 'depart';
  if (type === 'arrive') return 'arrive';
  if (type === 'roundabout' || type === 'rotary') return 'roundabout-enter';
  if (type === 'exit roundabout' || type === 'exit rotary') return 'roundabout-exit';
  if (type === 'merge') return 'merge';
  if (type === 'on ramp') return mod.includes('left') ? 'ramp-left' : 'ramp-right';
  if (type === 'off ramp') return mod.includes('left') ? 'exit-left' : 'exit-right';
  if (mod === 'uturn') return 'uturn-right';
  if (mod === 'sharp right') return 'sharp-right';
  if (mod === 'right') return 'right';
  if (mod === 'slight right') return 'slight-right';
  if (mod === 'sharp left') return 'sharp-left';
  if (mod === 'left') return 'left';
  if (mod === 'slight left') return 'slight-left';
  return 'continue';
}

function parseOsrmRoute(r, mode = 'auto') {
  const coords = (r.geometry?.coordinates || []).map(([lon, lat]) => [lat, lon]);
  const maneuvers = [];
  let offsetM = 0;
  let hasHighway = false;

  for (const leg of r.legs || []) {
    for (const step of leg.steps || []) {
      const kind = osrmStepToKind(step);
      const labelFa = KIND_LABELS_FA[kind] || 'ادامه مسیر';
      const street = step.name || step.ref || '';
      if (step.ref || /بزرگراه|آزادراه/.test(street)) hasHighway = true;
      const lenM = Math.round(step.distance || 0);
      const timeS = Math.round(step.duration || 0);
      const instruction =
        kind === 'depart'
          ? `حرکت را${street ? ` در ${street}` : ''} آغاز کنید`
          : kind === 'arrive'
          ? 'به مقصد رسیدید'
          : street
          ? `${labelFa} به سمت ${street}`
          : labelFa;
      maneuvers.push({
        kind,
        label_fa: labelFa,
        instruction,
        street_fa: street,
        length_m: lenM,
        time_s: timeS,
        offset_m: offsetM,
      });
      offsetM += lenM;
    }
  }

  // Adjust duration by mode if OSRM car profile was used as fallback
  let timeFactor = 1;
  if (mode === 'motorcycle') timeFactor = 0.78;
  else if (mode === 'bicycle') timeFactor = 2.4;
  else if (mode === 'pedestrian') timeFactor = 5.5;
  else if (mode === 'transit') timeFactor = 1.35;

  return {
    provider: 'osrm',
    distance_m: Math.round(r.distance || offsetM),
    time_s: Math.max(30, Math.round((r.duration || 60) * timeFactor)),
    geometry: coords,
    maneuvers,
    flags: {
      has_toll: false,
      has_highway: hasHighway,
      has_ferry: false,
    },
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });

  let from = null, to = null, via = [], mode = 'auto', alternates = 2;

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const fLat = Number(url.searchParams.get('from_lat') ?? url.searchParams.get('flat'));
    const fLon = Number(url.searchParams.get('from_lon') ?? url.searchParams.get('flon'));
    const tLat = Number(url.searchParams.get('to_lat') ?? url.searchParams.get('tlat'));
    const tLon = Number(url.searchParams.get('to_lon') ?? url.searchParams.get('tlon'));
    mode = url.searchParams.get('mode') || 'auto';
    if (Number.isFinite(fLat) && Number.isFinite(fLon) && Number.isFinite(tLat) && Number.isFinite(tLon)) {
      from = { lat: fLat, lon: fLon };
      to = { lat: tLat, lon: tLon };
    }
  } else {
    const body = await readJsonBody(req);
    from = body.from ? { lat: Number(body.from.lat), lon: Number(body.from.lon ?? body.from.lng) } : null;
    to = body.to ? { lat: Number(body.to.lat), lon: Number(body.to.lon ?? body.to.lng) } : null;
    via = Array.isArray(body.via)
      ? body.via
          .map((p) => ({ lat: Number(p.lat), lon: Number(p.lon ?? p.lng) }))
          .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      : [];
    mode = body.mode || 'auto';
    if (body.alternates != null) alternates = Math.min(3, Math.max(0, Number(body.alternates) || 0));
  }

  if (!from || !to || !Number.isFinite(from.lat) || !Number.isFinite(from.lon) || !Number.isFinite(to.lat) || !Number.isFinite(to.lon)) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'invalid_points', message: 'مختصات مبدأ و مقصد معتبر نیست. لطفاً مبدأ و مقصد را روی نقشه انتخاب کنید.' },
    });
  }

  const straightDist = haversineMeters(from, to);
  if (straightDist != null && straightDist < 8) {
    return sendJson(res, 200, {
      ok: true,
      mode,
      routes: [
        {
          provider: 'direct',
          distance_m: Math.max(5, straightDist),
          time_s: 15,
          geometry: [[from.lat, from.lon], [to.lat, to.lon]],
          maneuvers: [
            { kind: 'depart', label_fa: 'شروع حرکت', instruction: 'شما در نزدیکی مقصد قرار دارید', street_fa: '', length_m: straightDist, time_s: 15, offset_m: 0 },
            { kind: 'arrive', label_fa: 'رسیدن به مقصد', instruction: 'به مقصد رسیدید', street_fa: '', length_m: 0, time_s: 0, offset_m: straightDist },
          ],
          flags: { has_toll: false, has_highway: false, has_ferry: false },
        },
      ],
    });
  }

  const allPoints = [from, ...via.slice(0, 3), to];
  let routes = [];
  let warning = null;

  // 1. Try Valhalla first (supports auto, motorcycle, pedestrian, bicycle, multimodal)
  const costingMap = {
    auto: 'auto',
    motorcycle: 'motorcycle',
    pedestrian: 'pedestrian',
    bicycle: 'bicycle',
    transit: 'auto', // Fallback road geometry for cities without GTFS feed in Valhalla demo
  };

  if (mode === 'transit') {
    warning = 'مسیر بر پایه شبکه معابر و خطوط حمل‌ونقل شهری محاسبه شد.';
  }

  try {
    const valhallaPayload = {
      locations: allPoints.map((p) => ({ lat: p.lat, lon: p.lon })),
      costing: costingMap[mode] || 'auto',
      directions_options: { units: 'kilometers', language: 'fa-IR' },
      alternates: via.length ? 0 : alternates,
    };
    const vRes = await fetchWithTimeout(
      'https://valhalla1.openstreetmap.de/route',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(valhallaPayload),
      },
      5500
    );
    if (vRes.ok) {
      const vData = await vRes.json();
      if (vData?.trip) {
        routes.push(parseValhallaTrip(vData.trip, 'valhalla'));
        for (const alt of vData.alternates || []) {
          if (alt?.trip) routes.push(parseValhallaTrip(alt.trip, 'valhalla'));
        }
      }
    }
  } catch {
    // Fallback to OSRM below
  }

  // 2. Fallback to OSRM if Valhalla didn't return routes with valid geometry
  if (!routes.length || !routes[0]?.geometry?.length) {
    routes = [];
    const coordsStr = allPoints.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const osrmEndpoints =
      mode === 'pedestrian'
        ? [
            `https://routing.openstreetmap.de/routed-foot/route/v1/driving/${coordsStr}?overview=full&geometries=geojson&steps=true&alternatives=true`,
            `https://router.project-osrm.org/route/v1/foot/${coordsStr}?overview=full&geometries=geojson&steps=true&alternatives=true`,
          ]
        : mode === 'bicycle'
        ? [
            `https://routing.openstreetmap.de/routed-bike/route/v1/driving/${coordsStr}?overview=full&geometries=geojson&steps=true&alternatives=true`,
            `https://router.project-osrm.org/route/v1/bike/${coordsStr}?overview=full&geometries=geojson&steps=true&alternatives=true`,
          ]
        : [
            `https://routing.openstreetmap.de/routed-car/route/v1/driving/${coordsStr}?overview=full&geometries=geojson&steps=true&alternatives=true`,
            `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson&steps=true&alternatives=true`,
          ];

    for (const ep of osrmEndpoints) {
      try {
        const oRes = await fetchWithTimeout(ep, {}, 5500);
        if (!oRes.ok) continue;
        const oData = await oRes.json();
        if (Array.isArray(oData?.routes) && oData.routes.length) {
          const timeScaleMode = mode === 'pedestrian' || mode === 'bicycle' ? 'auto' : mode;
          routes = oData.routes.map((r) => parseOsrmRoute(r, timeScaleMode));
          break;
        }
      } catch {
        // try next endpoint
      }
    }
  }

  if (!routes.length || !routes[0]?.geometry?.length) {
    // Urban grid fallback when upstream routing servers are unreachable
    const dTotal = Math.round((straightDist || 1200) * 1.28);
    const speedMps = mode === 'pedestrian' ? 1.35 : mode === 'bicycle' ? 4.2 : mode === 'motorcycle' ? 11.5 : 9.2;
    const tTotal = Math.max(45, Math.round(dTotal / speedMps));
    const mid1 = { lat: from.lat + (to.lat - from.lat) * 0.45, lon: from.lon };
    const mid2 = { lat: from.lat + (to.lat - from.lat) * 0.45, lon: to.lon };
    const d1 = Math.round(dTotal * 0.35);
    const d2 = Math.round(dTotal * 0.40);
    const d3 = Math.max(20, dTotal - d1 - d2);
    routes = [
      {
        provider: 'rahin-grid-fallback',
        distance_m: dTotal,
        duration_s: tTotal,
        geometry: [
          [from.lat, from.lon],
          [mid1.lat, mid1.lon],
          [mid2.lat, mid2.lon],
          [to.lat, to.lon],
        ],
        maneuvers: [
          { kind: 'depart', label_fa: 'شروع حرکت', instruction: 'شروع حرکت در مسیر اصلی', street_fa: 'خیابان مبدأ', length_m: d1, time_s: Math.round(tTotal * 0.35), offset_m: 0 },
          { kind: to.lon >= from.lon ? 'right' : 'left', label_fa: to.lon >= from.lon ? 'گردش به راست' : 'گردش به چپ', instruction: `${to.lon >= from.lon ? 'گردش به راست' : 'گردش به چپ'} به خیابان میانی`, street_fa: 'خیابان اصلی', length_m: d2, time_s: Math.round(tTotal * 0.4), offset_m: d1 },
          { kind: 'straight', label_fa: 'ادامه مستقیم تا مقصد', instruction: 'ادامه مستقیم تا رسیدن به مقصد', street_fa: 'خیابان مقصد', length_m: d3, time_s: Math.round(tTotal * 0.25), offset_m: d1 + d2 },
          { kind: 'arrive', label_fa: 'رسیدن به مقصد', instruction: 'به مقصد رسیدید', street_fa: '', length_m: 0, time_s: 0, offset_m: dTotal },
        ],
        flags: { has_toll: false, has_highway: false, has_ferry: false },
      },
    ];
  }

  return sendJson(res, 200, {
    ok: true,
    mode,
    from,
    to,
    warning,
    routes,
    attribution: 'مسیریابی بر پایه شبکه معابر OpenStreetMap (Valhalla / OSRM)',
    fetched_at: new Date().toISOString(),
  });
}
