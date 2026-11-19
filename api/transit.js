import { queryOverpass, supabaseRest, sendJson, haversineMeters } from '../lib/server-utils.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });
  const url = new URL(req.url, 'http://localhost');
  const action = url.searchParams.get('action') || 'stations';
  const lat = Number(url.searchParams.get('lat') || 35.6892);
  const lon = Number(url.searchParams.get('lon') ?? url.searchParams.get('lng') ?? 51.389);

  try {
    const ql = `[out:json][timeout:4];(
      node["railway"~"station|subway_entrance"](around:2500,${lat.toFixed(4)},${lon.toFixed(4)});
      node["highway"="bus_stop"](around:1500,${lat.toFixed(4)},${lon.toFixed(4)});
      node["amenity"="bus_station"](around:2500,${lat.toFixed(4)},${lon.toFixed(4)});
    );out body 50;`;

    const [overpassData, dbTransit] = await Promise.all([
      queryOverpass(ql, 4200).catch(() => ({ elements: [] })),
      supabaseRest(`rahin_places?category=in.(metro,bus_stop)&limit=20`).catch(() => []),
    ]);

    const stations = [];
    for (const p of Array.isArray(dbTransit) ? dbTransit : []) {
      stations.push({
        id: p.osm_id || `db-${p.id}`,
        name: p.name,
        kind: p.category === 'metro' ? 'metro' : 'bus',
        lat: p.lat,
        lon: p.lon,
        distance_m: haversineMeters({ lat, lon }, { lat: p.lat, lon: p.lon }),
      });
    }
    for (const el of overpassData.elements || []) {
      if (!Number.isFinite(el.lat) || !Number.isFinite(el.lon)) continue;
      const tags = el.tags || {};
      const name = tags['name:fa'] || tags.name || (tags.railway ? 'ایستگاه مترو' : 'ایستگاه اتوبوس');
      const kind = tags.railway ? 'metro' : 'bus';
      stations.push({
        id: `osm-${el.id}`,
        name,
        kind,
        lat: el.lat,
        lon: el.lon,
        distance_m: haversineMeters({ lat, lon }, { lat: el.lat, lon: el.lon }),
      });
    }

    stations.sort((a, b) => (a.distance_m ?? 999999) - (b.distance_m ?? 999999));

    return sendJson(res, 200, {
      ok: true,
      action,
      count: stations.length,
      stations: stations.slice(0, 40),
      attribution: '© OpenStreetMap contributors',
    }, 60);
  } catch (e) {
    return sendJson(res, 200, { ok: true, action, count: 0, stations: [] });
  }
}
