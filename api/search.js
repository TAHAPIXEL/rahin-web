import {
  fetchWithTimeout,
  supabaseRest,
  queryOverpass,
  sendJson,
  haversineMeters,
  CATEGORY_META,
  classifyOsmTags,
  extractFeaturesFromOsmTags,
  formatOsmOpeningHoursFa,
  FALLBACK_PLACES,
} from '../lib/server-utils.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });
  const url = new URL(req.url, 'http://localhost');
  const q = (url.searchParams.get('q') || '').trim();
  const category = (url.searchParams.get('category') || '').trim();
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon') ?? url.searchParams.get('lng'));
  const limit = Math.min(40, Math.max(1, Number(url.searchParams.get('limit')) || 20));

  if (q.length < 2 && !category) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'short_query', message: 'عبارت جستجو باید حداقل ۲ حرف باشد.' },
    });
  }

  const hasRef = Number.isFinite(lat) && Number.isFinite(lon);
  const refPoint = hasRef ? { lat, lon } : { lat: 35.6892, lon: 51.389 };

  // 1. Search Supabase rahin_places
  const dbPromise = (async () => {
    try {
      let filter = 'select=*&limit=30';
      if (category && category !== 'all') {
        filter += `&category=eq.${encodeURIComponent(category)}`;
      } else if (q) {
        const clean = q.replace(/[%*,()]/g, ' ').trim();
        filter += `&or=(name.ilike.*${encodeURIComponent(clean)}*,name_en.ilike.*${encodeURIComponent(clean)}*,subcategory.ilike.*${encodeURIComponent(clean)}*,address.ilike.*${encodeURIComponent(clean)}*,description.ilike.*${encodeURIComponent(clean)}*)`;
      }
      const rows = await supabaseRest(`rahin_places?${filter}`);
      if (!Array.isArray(rows)) return [];
      return rows.map((p) => {
        const meta = CATEGORY_META[p.category] || { fa: p.subcategory || 'مکان', emoji: '📍', color: '#0f9e95' };
        return {
          id: p.osm_id || `db-${p.id}`,
          db_id: p.id,
          place_key: p.osm_id || `db-${p.id}`,
          name: p.name,
          label: p.name,
          name_en: p.name_en || '',
          address: [p.city, p.district, p.address].filter(Boolean).join('، '),
          city: p.city || 'تهران',
          district: p.district || '',
          category: p.category || 'shop',
          subcategory: p.subcategory || meta.fa,
          category_fa: p.subcategory || meta.fa,
          emoji: meta.emoji,
          color: meta.color,
          lat: p.lat,
          lon: p.lon,
          phone: p.phone || '',
          website: p.website || '',
          instagram: p.instagram || '',
          opening_hours: p.opening_hours || '',
          is_24h: Boolean(p.is_24h),
          postal_code: p.postal_code || '',
          floor_unit: p.floor_unit || '',
          description: p.description || '',
          features: Array.isArray(p.features) ? p.features : [],
          rating_avg: Number(p.rating_avg || 0),
          rating_count: Number(p.rating_count || 0),
          distance_m: haversineMeters(refPoint, { lat: p.lat, lon: p.lon }),
          source: 'rahin_db',
        };
      });
    } catch {
      return [];
    }
  })();

  // 2. Search Photon
  const photonPromise = (async () => {
    try {
      const searchQ = q || CATEGORY_META[category]?.fa || category;
      const bias = `&lat=${refPoint.lat}&lon=${refPoint.lon}`;
      const r = await fetchWithTimeout(
        `https://photon.komoot.io/api?q=${encodeURIComponent(searchQ)}&limit=${limit}${bias}`,
        {},
        4500
      );
      if (!r.ok) return [];
      const data = await r.json();
      return (data.features || []).map((f) => {
        const p = f.properties || {};
        const [fLon, fLat] = f.geometry?.coordinates || [0, 0];
        const catInfo = classifyOsmTags({
          amenity: p.osm_key === 'amenity' ? p.osm_value : '',
          shop: p.osm_key === 'shop' ? p.osm_value : '',
          tourism: p.osm_key === 'tourism' ? p.osm_value : '',
          railway: p.osm_key === 'railway' ? p.osm_value : '',
          highway: p.osm_key === 'highway' ? p.osm_value : '',
          leisure: p.osm_key === 'leisure' ? p.osm_value : '',
          osm_key: p.osm_key,
          osm_value: p.osm_value,
        });
        const addr = [p.street, p.district, p.city, p.state].filter(Boolean).join('، ');
        const placeKey = p.osm_type && p.osm_id ? `osm-${p.osm_type}-${p.osm_id}` : `pt-${fLat}-${fLon}`;
        return {
          id: placeKey,
          place_key: placeKey,
          name: p.name || p.street || p.city || 'مکان',
          label: p.name || p.street || p.city || 'مکان',
          address: addr,
          city: p.city || p.state || '',
          district: p.district || '',
          category: category || catInfo.category,
          subcategory: catInfo.subcategory,
          category_fa: catInfo.fa,
          emoji: catInfo.emoji,
          color: catInfo.color,
          lat: fLat,
          lon: fLon,
          postal_code: p.postcode || '',
          distance_m: haversineMeters(refPoint, { lat: fLat, lon: fLon }),
          props: p,
          source: 'photon',
        };
      });
    } catch {
      return [];
    }
  })();

  // 3. Search Nominatim with extratags=1 for rich details (phone, opening_hours, etc.)
  const nominatimPromise = (async () => {
    try {
      const searchQ = q || CATEGORY_META[category]?.fa || category;
      const viewbox = `${(refPoint.lon - 0.35).toFixed(3)},${(refPoint.lat + 0.30).toFixed(3)},${(refPoint.lon + 0.35).toFixed(3)},${(refPoint.lat - 0.30).toFixed(3)}`;
      const r = await fetchWithTimeout(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(searchQ)}&limit=12&addressdetails=1&extratags=1&namedetails=1&viewbox=${viewbox}&accept-language=fa,en`,
        {},
        4500
      );
      if (!r.ok) return [];
      const list = await r.json();
      if (!Array.isArray(list)) return [];
      return list.map((item) => {
        const fLat = Number(item.lat);
        const fLon = Number(item.lon);
        const extra = item.extratags || {};
        const names = item.namedetails || {};
        const addr = item.address || {};
        const catInfo = classifyOsmTags({
          amenity: item.category === 'amenity' ? item.type : '',
          shop: item.category === 'shop' ? item.type : '',
          tourism: item.category === 'tourism' ? item.type : '',
          railway: item.category === 'railway' ? item.type : '',
          highway: item.category === 'highway' ? item.type : '',
          leisure: item.category === 'leisure' ? item.type : '',
          healthcare: extra.healthcare || '',
          osm_key: item.category,
          osm_value: item.type,
        });
        const placeName = names['name:fa'] || item.name || item.display_name?.split('،')[0]?.split(',')[0] || 'مکان';
        const addrStr = [
          addr.city || addr.town || addr.county,
          addr.suburb || addr.neighbourhood,
          addr.road,
          addr.house_number ? `پلاک ${addr.house_number}` : '',
        ].filter(Boolean).join('، ') || item.display_name || '';
        const placeKey = item.osm_type && item.osm_id ? `osm-${item.osm_type[0].toUpperCase()}-${item.osm_id}` : `pt-${fLat}-${fLon}`;
        return {
          id: placeKey,
          place_key: placeKey,
          name: placeName,
          label: placeName,
          name_en: names['name:en'] || extra.brand || '',
          address: addrStr,
          city: addr.city || addr.town || '',
          district: addr.suburb || addr.neighbourhood || '',
          category: category || catInfo.category,
          subcategory: catInfo.subcategory,
          category_fa: catInfo.fa,
          emoji: catInfo.emoji,
          color: catInfo.color,
          lat: fLat,
          lon: fLon,
          phone: extra.phone || extra['contact:phone'] || '',
          website: extra.website || extra['contact:website'] || '',
          instagram: extra['contact:instagram'] || '',
          opening_hours: formatOsmOpeningHoursFa(extra.opening_hours),
          is_24h: extra.opening_hours === '24/7',
          postal_code: addr.postcode || extra['addr:postcode'] || '',
          features: extractFeaturesFromOsmTags(extra),
          distance_m: haversineMeters(refPoint, { lat: fLat, lon: fLon }),
          source: 'nominatim',
        };
      });
    } catch {
      return [];
    }
  })();

  // 4. If category is requested, also query Overpass around refPoint for exact category POIs!
  const overpassPromise = (async () => {
    if (!category || !CATEGORY_META[category]) return [];
    try {
      const pairs = CATEGORY_META[category].osm || [];
      if (!pairs.length) return [];
      const radius = 3500;
      const clauses = pairs
        .map(([k, v]) => `nwr["${k}"="${v}"](around:${radius},${refPoint.lat.toFixed(5)},${refPoint.lon.toFixed(5)});`)
        .join('');
      const ql = `[out:json][timeout:5];(${clauses});out center 25;`;
      const { elements } = await queryOverpass(ql, 4800);
      return elements
        .map((el) => {
          const eLat = el.lat ?? el.center?.lat;
          const eLon = el.lon ?? el.center?.lon;
          if (!Number.isFinite(eLat) || !Number.isFinite(eLon)) return null;
          const tags = el.tags || {};
          const catInfo = classifyOsmTags(tags);
          const name = tags['name:fa'] || tags.name || tags.brand || catInfo.subcategory || CATEGORY_META[category].fa;
          const placeKey = `osm-${String(el.type || 'N')[0].toUpperCase()}-${el.id}`;
          return {
            id: placeKey,
            place_key: placeKey,
            name,
            label: name,
            name_en: tags['name:en'] || tags.brand || '',
            address: [tags['addr:city'], tags['addr:district'] || tags['addr:suburb'], tags['addr:street'], tags['addr:housenumber'] ? `پلاک ${tags['addr:housenumber']}` : ''].filter(Boolean).join('، ') || catInfo.fa,
            category: catInfo.category,
            subcategory: catInfo.subcategory,
            category_fa: catInfo.fa,
            emoji: catInfo.emoji,
            color: catInfo.color,
            lat: eLat,
            lon: eLon,
            phone: tags.phone || tags['contact:phone'] || '',
            website: tags.website || tags['contact:website'] || '',
            instagram: tags['contact:instagram'] || '',
            opening_hours: formatOsmOpeningHoursFa(tags.opening_hours),
            is_24h: tags.opening_hours === '24/7',
            features: extractFeaturesFromOsmTags(tags),
            distance_m: haversineMeters(refPoint, { lat: eLat, lon: eLon }),
            source: 'overpass',
          };
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  })();

  const [dbRes, overpassRes, nominatimRes, photonRes] = await Promise.all([
    dbPromise,
    overpassPromise,
    nominatimPromise,
    photonPromise,
  ]);

  const fallbackMatches = FALLBACK_PLACES.filter((p) => {
    if (category && category !== 'all') return p.category === category;
    if (!q) return true;
    const qlc = q.toLowerCase();
    return (
      (p.name && p.name.toLowerCase().includes(qlc)) ||
      (p.name_en && p.name_en.toLowerCase().includes(qlc)) ||
      (p.subcategory && p.subcategory.toLowerCase().includes(qlc)) ||
      (p.address && p.address.toLowerCase().includes(qlc)) ||
      (p.description && p.description.toLowerCase().includes(qlc))
    );
  }).map((p) => {
    const meta = CATEGORY_META[p.category] || { fa: p.subcategory || 'مکان', emoji: '📍', color: '#0f9e95' };
    return {
      ...p,
      place_key: p.id,
      label: p.name,
      category_fa: p.subcategory || meta.fa,
      emoji: meta.emoji,
      color: meta.color,
      distance_m: haversineMeters(refPoint, { lat: p.lat, lon: p.lon }),
      source: 'rahin_db',
    };
  });

  // Deduplicate by proximity + name or place_key
  const seenKeys = new Set();
  const merged = [];
  for (const item of [...dbRes, ...overpassRes, ...nominatimRes, ...photonRes, ...fallbackMatches]) {
    if (!item || !Number.isFinite(item.lat) || !Number.isFinite(item.lon)) continue;
    const key = item.place_key || `${item.lat.toFixed(4)}-${item.lon.toFixed(4)}`;
    if (seenKeys.has(key)) continue;
    // Check if very close (< 30m) with same name
    const dup = merged.find(
      (m) =>
        m.name === item.name &&
        Math.abs(m.lat - item.lat) < 0.0003 &&
        Math.abs(m.lon - item.lon) < 0.0003
    );
    if (dup) {
      if (!dup.phone && item.phone) dup.phone = item.phone;
      if (!dup.opening_hours && item.opening_hours) dup.opening_hours = item.opening_hours;
      if (!dup.website && item.website) dup.website = item.website;
      if (!dup.features?.length && item.features?.length) dup.features = item.features;
      continue;
    }
    seenKeys.add(key);
    merged.push(item);
  }

  // Sort: prioritize database matches & closer distances when category is active
  merged.sort((a, b) => {
    if (a.source === 'rahin_db' && b.source !== 'rahin_db') return -1;
    if (b.source === 'rahin_db' && a.source !== 'rahin_db') return 1;
    if (category && a.distance_m != null && b.distance_m != null) {
      return a.distance_m - b.distance_m;
    }
    return 0;
  });

  const finalResults = merged.slice(0, limit);
  const catMeta = category && CATEGORY_META[category] ? { slug: category, fa: CATEGORY_META[category].fa, emoji: CATEGORY_META[category].emoji } : null;

  return sendJson(res, 200, {
    ok: true,
    query: q,
    category: catMeta,
    count: finalResults.length,
    results: finalResults,
    source: 'supabase+overpass+nominatim+photon',
    attribution: 'جستجوی جامع راهین (Supabase + OpenStreetMap / Overpass / Photon / Nominatim)',
    fetched_at: new Date().toISOString(),
  }, 20);
}
