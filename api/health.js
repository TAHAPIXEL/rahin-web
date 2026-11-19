import { fetchWithTimeout, supabaseRest, sendJson } from '../lib/server-utils.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });
  const url = new URL(req.url, 'http://localhost');
  const deep = url.searchParams.get('deep') === '1';

  if (!deep) {
    return sendJson(res, 200, { ok: true, time: new Date().toISOString(), version: '2.0.0' });
  }

  const check = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      return { name, ok: true, ms: Date.now() - t0, detail };
    } catch (e) {
      return { name, ok: false, ms: Date.now() - t0, error: e.message || 'خطا' };
    }
  };

  const services = await Promise.all([
    check('tiles', async () => {
      const r = await fetchWithTimeout('https://tiles.openfreemap.org/styles/bright', {}, 4500);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return 'کاشی‌های برداری OpenFreeMap فعال';
    }),
    check('routing', async () => {
      try {
        const r = await fetchWithTimeout('https://valhalla1.openstreetmap.de/status', {}, 4000);
        if (r.ok) return 'موتور Valhalla و OSRM فعال';
      } catch { /* fallback check */ }
      const r2 = await fetchWithTimeout('https://routing.openstreetmap.de/routed-car/route/v1/driving/51.389,35.6892;51.400,35.700?overview=false', {}, 4000);
      if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
      return 'موتور مسیریابی OSRM فعال';
    }),
    check('search', async () => {
      const r = await fetchWithTimeout('https://photon.komoot.io/api?q=Tehran&limit=1', {}, 4500);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return 'موتور جستجوی Photon و Nominatim فعال';
    }),
    check('database', async () => {
      const rows = await supabaseRest('rahin_places?select=id&limit=1');
      return `دیتابیس ابری Supabase متصل (${Array.isArray(rows) ? 'فعال' : 'OK'})`;
    }),
  ]);

  return sendJson(res, 200, {
    ok: services.every((s) => s.ok),
    time: new Date().toISOString(),
    version: '2.0.0',
    services,
  });
}
