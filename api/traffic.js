import { sendJson } from '../lib/server-utils.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });
  const tileUrl = process.env.TRAFFIC_TILE_URL || '';
  return sendJson(res, 200, {
    ok: true,
    available: Boolean(tileUrl),
    provider: tileUrl ? 'custom' : null,
    reason: tileUrl
      ? 'ترافیک زنده فعال است'
      : 'گزارش‌های ترافیکی زنده کاربران و سرعت‌های معابر OpenStreetMap روی نقشه و در محاسبه زمان مسیر لحاظ می‌شوند.',
    eta_note: 'زمان‌های سفر بر اساس سرعت معابر و گزارش‌های ترافیکی ثبت‌شده در دیتابیس راهین محاسبه می‌شوند.',
    engine: {
      routing: 'https://valhalla1.openstreetmap.de + OSRM',
      traffic_aware_eta: true,
    },
  }, 120);
}
