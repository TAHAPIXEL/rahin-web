import { supabaseRest, queryOverpass, readJsonBody, sendJson, FALLBACK_ALERTS } from '../lib/server-utils.js';

const memoryReports = [...FALLBACK_ALERTS];

const REPORT_LABELS_FA = {
  speed_camera: 'دوربین کنترل سرعت',
  speed_bump: 'سرعت‌گیر',
  roadwork: 'کارگاه و تعمیرات جاده',
  closure: 'انسداد مسیر',
  traffic_light: 'چراغ راهنمایی',
  accident: 'تصادف',
  traffic: 'ترافیک سنگین',
  police: 'پلیس راهور',
  hazard: 'خطر جاده‌ای',
  other: 'هشدار مسیر',
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });

  // POST: Submit new road alert or upvote existing alert in Supabase
  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    if (body.action === 'upvote' && body.id) {
      try {
        const existing = await supabaseRest(`rahin_reports?id=eq.${encodeURIComponent(body.id)}&select=id,upvotes`);
        const cur = Array.isArray(existing) && existing[0] ? Number(existing[0].upvotes || 1) : 1;
        const updated = await supabaseRest(`rahin_reports?id=eq.${encodeURIComponent(body.id)}`, {
          method: 'PATCH',
          body: { upvotes: cur + 1 },
        });
        return sendJson(res, 200, { ok: true, report: Array.isArray(updated) ? updated[0] : updated });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: { message: e.message } });
      }
    }

    const type = String(body.type || 'hazard').trim();
    const lat = Number(body.lat);
    const lon = Number(body.lon ?? body.lng);
    const desc = String(body.description || '').trim().slice(0, 400);
    const title = String(body.title || REPORT_LABELS_FA[type] || 'هشدار مسیر').trim().slice(0, 120);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return sendJson(res, 400, { ok: false, error: { message: 'مختصات گزارش معتبر نیست.' } });
    }

    const localReport = {
      id: `usr-${Date.now()}`,
      type,
      title,
      label: title,
      description: desc || '',
      lat,
      lon,
      upvotes: 1,
      source: 'users',
      status: 'active',
      created_at: new Date().toISOString(),
    };
    memoryReports.unshift(localReport);

    try {
      const inserted = await supabaseRest('rahin_reports', {
        method: 'POST',
        body: {
          type,
          title,
          description: desc || null,
          lat,
          lon,
          upvotes: 1,
          source: 'users',
          status: 'active',
        },
      });
      return sendJson(res, 200, {
        ok: true,
        report: Array.isArray(inserted) ? inserted[0] : inserted,
        message: 'گزارش شما ثبت شد و روی نقشه نمایش داده می‌شود.',
      });
    } catch {
      return sendJson(res, 200, {
        ok: true,
        report: localReport,
        message: 'گزارش شما ثبت شد و روی نقشه نمایش داده می‌شود.',
      });
    }
  }

  // GET: Fetch alerts in bbox
  const url = new URL(req.url, 'http://localhost');
  const bboxStr = url.searchParams.get('bbox') || '51.25,35.60,51.52,35.82';
  const parts = bboxStr.split(',').map(Number);
  const [minLon, minLat, maxLon, maxLat] =
    parts.length === 4 && parts.every(Number.isFinite)
      ? parts
      : [51.25, 35.60, 51.52, 35.82];

  // 1. Fetch active user reports from Supabase
  const dbPromise = (async () => {
    try {
      const rows = await supabaseRest(
        `rahin_reports?status=eq.active&lat=gte.${minLat.toFixed(4)}&lat=lte.${maxLat.toFixed(4)}&lon=gte.${minLon.toFixed(4)}&lon=lte.${maxLon.toFixed(4)}&order=created_at.desc&limit=80`
      );
      if (!Array.isArray(rows)) return [];
      return rows.map((r) => ({
        id: `usr-${r.id}`,
        db_id: r.id,
        type: r.type,
        title: r.title || REPORT_LABELS_FA[r.type] || 'هشدار',
        description: r.description || '',
        lat: r.lat,
        lon: r.lon,
        upvotes: r.upvotes || 1,
        source: 'users',
        created_at: r.created_at,
      }));
    } catch {
      return [];
    }
  })();

  // 2. Fetch OSM alerts via multi-mirror Overpass (keep bbox compact so Overpass responds in < 2s)
  const osmPromise = (async () => {
    try {
      const cLat = (minLat + maxLat) / 2;
      const cLon = (minLon + maxLon) / 2;
      const sLat = Math.max(minLat, cLat - 0.08);
      const nLat = Math.min(maxLat, cLat + 0.08);
      const wLon = Math.max(minLon, cLon - 0.10);
      const eLon = Math.min(maxLon, cLon + 0.10);
      const b = `${sLat.toFixed(4)},${wLon.toFixed(4)},${nLat.toFixed(4)},${eLon.toFixed(4)}`;
      const ql = `[out:json][timeout:4];(
        node["highway"="speed_camera"](${b});
        node["traffic_calming"~"bump|hump|table|cushion"](${b});
        node["barrier"="block"](${b});
      );out body 80;`;
      const { elements } = await queryOverpass(ql, 4200);
      return elements
        .map((el) => {
          if (!Number.isFinite(el.lat) || !Number.isFinite(el.lon)) return null;
          const tags = el.tags || {};
          let type = 'other';
          if (tags.highway === 'speed_camera') type = 'speed_camera';
          else if (tags.traffic_calming) type = 'speed_bump';
          else if (tags.barrier) type = 'closure';
          return {
            id: `osm-${el.id}`,
            type,
            title: REPORT_LABELS_FA[type] || 'هشدار مسیر',
            description: tags.maxspeed ? `سرعت مجاز: ${tags.maxspeed} کیلومتر بر ساعت` : '',
            lat: el.lat,
            lon: el.lon,
            source: 'osm',
            details: { maxspeed: tags.maxspeed || null },
          };
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  })();

  const [userAlerts, osmAlerts] = await Promise.all([dbPromise, osmPromise]);
  let alerts = [...userAlerts, ...osmAlerts];
  if (alerts.length === 0) {
    alerts = memoryReports
      .filter((a) => a.lat >= minLat && a.lat <= maxLat && a.lon >= minLon && a.lon <= maxLon)
      .map((a) => ({
        id: a.id,
        type: a.type,
        title: a.title || a.label || 'هشدار مسیر',
        description: a.description || '',
        lat: a.lat,
        lon: a.lon,
        upvotes: a.upvotes || 1,
        source: a.source || 'users',
      }));
  }

  return sendJson(res, 200, {
    ok: true,
    degraded: false,
    alerts,
    counts: { osm: osmAlerts.length, users: userAlerts.length },
    attribution: 'هشدارهای مسیر: OpenStreetMap + گزارش‌های زنده کاربران راهین',
    fetched_at: new Date().toISOString(),
  }, 15);
}
