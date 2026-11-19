import { fetchWithTimeout, sendJson, haversineMeters } from '../lib/server-utils.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });
  const url = new URL(req.url, 'http://localhost');
  const q = (url.searchParams.get('q') || '').trim();
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon') ?? url.searchParams.get('lng'));

  if (!q && Number.isFinite(lat) && Number.isFinite(lon)) {
    try {
      const r = await fetchWithTimeout(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1&accept-language=fa,en`,
        {},
        4500
      );
      if (r.ok) {
        const d = await r.json();
        return sendJson(res, 200, {
          ok: true,
          mode: 'reverse',
          result: {
            id: `pt-${lat}-${lon}`,
            label: d.name || d.address?.road || d.address?.neighbourhood || 'مکان انتخابی',
            address: d.display_name || '',
            lat,
            lon,
          },
        });
      }
    } catch { /* fallback */ }
    return sendJson(res, 200, {
      ok: true,
      mode: 'reverse',
      result: { id: `pt-${lat}-${lon}`, label: 'مکان انتخابی', address: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon },
    });
  }

  if (q.length < 2) {
    return sendJson(res, 400, { ok: false, error: { message: 'عبارت جستجو کوتاه است.' } });
  }

  const refPt = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : { lat: 35.6892, lon: 51.389 };
  try {
    const r = await fetchWithTimeout(
      `https://photon.komoot.io/api?q=${encodeURIComponent(q)}&lat=${refPt.lat}&lon=${refPt.lon}&limit=10`,
      {},
      4500
    );
    const data = r.ok ? await r.json() : { features: [] };
    const results = (data.features || []).map((f) => {
      const p = f.properties || {};
      const [fLon, fLat] = f.geometry?.coordinates || [0, 0];
      return {
        id: p.osm_type && p.osm_id ? `osm-${p.osm_type}-${p.osm_id}` : `pt-${fLat}-${fLon}`,
        label: p.name || p.street || p.city || 'مکان',
        address: [p.street, p.district, p.city, p.state, p.country].filter(Boolean).join('، '),
        lat: fLat,
        lon: fLon,
        type: p.osm_value || p.type || 'place',
        extent: p.extent || null,
        distance_m: haversineMeters(refPt, { lat: fLat, lon: fLon }),
      };
    });
    return sendJson(res, 200, {
      ok: true,
      mode: 'search',
      query: q,
      results,
      attribution: '© OpenStreetMap contributors',
    }, 30);
  } catch (e) {
    return sendJson(res, 200, { ok: true, mode: 'search', query: q, results: [] });
  }
}
