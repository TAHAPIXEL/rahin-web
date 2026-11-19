import { SUPABASE_URL, SUPABASE_ANON_KEY, sendJson } from '../lib/server-utils.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });
  return sendJson(res, 200, {
    ok: true,
    app: {
      name: 'RAHIN',
      name_fa: 'راهین',
      tagline_fa: 'هر مسیر، یک قدم نزدیک‌تر',
      version: '2.0.0',
      build: '2026.11',
    },
    supabase: {
      url: SUPABASE_URL,
      anon_key: SUPABASE_ANON_KEY,
      enabled: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY),
    },
    map: {
      engine: 'maplibre-gl',
      styles: {
        light: 'https://tiles.openfreemap.org/styles/bright',
        dark: 'https://tiles.openfreemap.org/styles/dark',
        liberty: 'https://tiles.openfreemap.org/styles/liberty',
      },
      default_theme: 'auto',
      attribution: '© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors',
      offline: {
        mode: 'cache-first-on-view',
        note: 'نقشه‌های مشاهده‌شده به‌صورت خودکار برای استفاده آفلاین در حافظه دستگاه ذخیره می‌شوند.',
      },
    },
    routing: {
      engine: 'valhalla + osrm-multi-profile',
      modes: ['auto', 'motorcycle', 'pedestrian', 'bicycle', 'transit'],
      transit_note: 'مسیریابی حمل‌ونقل عمومی به همراه ایستگاه‌های مترو و اتوبوس اطراف مسیر.',
      alternates: true,
      languages: ['fa-IR', 'en-US'],
    },
    places: {
      live_poi: true,
      user_submissions: true,
      reviews: true,
      providers: ['supabase', 'overpass', 'photon', 'nominatim'],
    },
    traffic: { live_tiles: false, eta_aware: true },
    alerts: { osm: true, user_reports: true },
    limits: { search_debounce_ms: 300, route_rate_per_min: 60 },
  }, 60);
}
