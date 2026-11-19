import {
  supabaseRest,
  queryOverpass,
  readJsonBody,
  sendJson,
  haversineMeters,
  CATEGORY_META,
  classifyOsmTags,
  extractFeaturesFromOsmTags,
  formatOsmOpeningHoursFa,
  FALLBACK_PLACES,
} from '../lib/server-utils.js';

const memoryPlaces = [...FALLBACK_PLACES];
const memoryReviews = [
  { id: 1, place_key: 'fb-1', author_name: 'محمدرضا کریمی', rating: 5, comment: 'داروخانه بسیار کامل و پرسنل محترمی دارد، ساعت ۳ بامداد هم باز بود.', created_at: new Date().toISOString() },
  { id: 2, place_key: 'fb-3', author_name: 'سارا احمدی', rating: 5, comment: 'محیط آرام و عالی برای کار با لپ‌تاپ و مطالعه، قهوه دمی عالی بود.', created_at: new Date().toISOString() },
];

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });

  // POST: Add a new place, update an existing place, or add a review (Neshan / Balad / Google Maps style)
  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const action = body.action || 'create';

    if (action === 'review') {
      const placeKey = String(body.place_key || '').trim();
      const authorName = String(body.author_name || 'کاربر راهین').trim().slice(0, 60);
      const rating = Math.min(5, Math.max(1, Math.round(Number(body.rating) || 5)));
      const comment = String(body.comment || '').trim().slice(0, 800);
      const placeName = String(body.place_name || '').trim().slice(0, 120);

      if (!placeKey) {
        return sendJson(res, 400, { ok: false, error: { message: 'شناسه مکان مشخص نیست.' } });
      }

      const localReview = {
        id: Date.now(),
        place_key: placeKey,
        place_name: placeName,
        author_name: authorName || 'کاربر راهین',
        rating,
        comment,
        created_at: new Date().toISOString(),
      };
      memoryReviews.unshift(localReview);

      try {
        const inserted = await supabaseRest('rahin_place_reviews', {
          method: 'POST',
          body: { place_key: placeKey, place_name: placeName, author_name: authorName || 'کاربر راهین', rating, comment },
        });

        // Recalculate rating on rahin_places if it exists
        const allReviews = await supabaseRest(
          `rahin_place_reviews?place_key=eq.${encodeURIComponent(placeKey)}&select=rating`
        ).catch(() => []);

        if (Array.isArray(allReviews) && allReviews.length > 0) {
          const avg = Number((allReviews.reduce((s, r) => s + Number(r.rating || 5), 0) / allReviews.length).toFixed(2));
          await supabaseRest(`rahin_places?osm_id=eq.${encodeURIComponent(placeKey)}`, {
            method: 'PATCH',
            body: { rating_avg: avg, rating_count: allReviews.length, updated_at: new Date().toISOString() },
          }).catch(() => {});
        }

        return sendJson(res, 200, {
          ok: true,
          review: Array.isArray(inserted) ? inserted[0] : inserted,
          message: 'نظر و امتیاز شما با موفقیت ثبت شد.',
        });
      } catch {
        return sendJson(res, 200, {
          ok: true,
          review: localReview,
          message: 'نظر و امتیاز شما با موفقیت ثبت شد.',
        });
      }
    }

    // Create or Update place (shop / business / public place)
    const name = String(body.name || '').trim();
    const lat = Number(body.lat);
    const lon = Number(body.lon ?? body.lng);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return sendJson(res, 400, {
        ok: false,
        error: { message: 'نام مکان و موقعیت روی نقشه الزامی است.' },
      });
    }

    const osmId = String(body.osm_id || body.place_key || `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`).trim();
    const record = {
      osm_id: osmId,
      name: name.slice(0, 140),
      name_en: String(body.name_en || '').trim().slice(0, 140) || null,
      category: String(body.category || 'shop').trim(),
      subcategory: String(body.subcategory || CATEGORY_META[body.category]?.fa || 'فروشگاه و مغازه').trim(),
      address: String(body.address || '').trim().slice(0, 350) || null,
      city: String(body.city || 'تهران').trim().slice(0, 80),
      district: String(body.district || '').trim().slice(0, 100) || null,
      postal_code: String(body.postal_code || '').trim().slice(0, 20) || null,
      floor_unit: String(body.floor_unit || '').trim().slice(0, 80) || null,
      phone: String(body.phone || '').trim().slice(0, 50) || null,
      website: String(body.website || '').trim().slice(0, 250) || null,
      instagram: String(body.instagram || '').trim().slice(0, 100) || null,
      opening_hours: String(body.opening_hours || '').trim().slice(0, 200) || null,
      is_24h: Boolean(body.is_24h),
      description: String(body.description || '').trim().slice(0, 1000) || null,
      features: Array.isArray(body.features) ? body.features : [],
      lat,
      lon,
      verified: true,
      source: body.source || 'user',
      updated_at: new Date().toISOString(),
    };

    const meta = CATEGORY_META[record.category] || { fa: record.subcategory, emoji: '📍', color: '#0f9e95' };
    const memIdx = memoryPlaces.findIndex((m) => (m.osm_id || m.id) === osmId);
    if (memIdx >= 0) memoryPlaces[memIdx] = { ...memoryPlaces[memIdx], ...record, id: osmId };
    else memoryPlaces.unshift({ ...record, id: osmId, rating_avg: 5, rating_count: 1 });

    try {
      const saved = await supabaseRest('rahin_places?on_conflict=osm_id', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=representation',
        body: record,
      });
      const place = Array.isArray(saved) ? saved[0] : saved;
      return sendJson(res, 200, {
        ok: true,
        place: {
          ...place,
          place_key: place?.osm_id || osmId,
          label: place?.name || name,
          category_fa: place?.subcategory || meta.fa,
          emoji: meta.emoji,
          color: meta.color,
        },
        message: action === 'update' ? 'اطلاعات مکان با موفقیت بروزرسانی شد.' : 'مکان جدید با موفقیت در نقشه راهین ثبت شد.',
      });
    } catch {
      return sendJson(res, 200, {
        ok: true,
        place: {
          ...record,
          id: osmId,
          place_key: osmId,
          label: record.name,
          category_fa: record.subcategory || meta.fa,
          emoji: meta.emoji,
          color: meta.color,
        },
        message: action === 'update' ? 'اطلاعات مکان با موفقیت بروزرسانی شد.' : 'مکان جدید با موفقیت در نقشه راهین ثبت شد.',
      });
    }
  }

  // GET: Fetch places in viewport/radius OR single place detail
  const url = new URL(req.url, 'http://localhost');
  const placeKey = url.searchParams.get('place_key');

  if (placeKey) {
    const [placesRows, reviewsRows] = await Promise.all([
      supabaseRest(`rahin_places?osm_id=eq.${encodeURIComponent(placeKey)}&limit=1`).catch(() => []),
      supabaseRest(`rahin_place_reviews?place_key=eq.${encodeURIComponent(placeKey)}&order=created_at.desc&limit=30`).catch(() => []),
    ]);
    const p =
      (Array.isArray(placesRows) && placesRows[0]) ||
      memoryPlaces.find((m) => (m.osm_id || m.id) === placeKey) ||
      null;
    const revs =
      Array.isArray(reviewsRows) && reviewsRows.length > 0
        ? reviewsRows
        : memoryReviews.filter((r) => r.place_key === placeKey);
    return sendJson(res, 200, {
      ok: true,
      place: p,
      reviews: revs,
    });
  }

  const bboxParam = url.searchParams.get('bbox');
  const lat = Number(url.searchParams.get('lat') || 35.6892);
  const lon = Number(url.searchParams.get('lon') ?? url.searchParams.get('lng') ?? 51.389);
  const category = (url.searchParams.get('category') || '').trim();
  const radius = Math.min(3000, Math.max(250, Number(url.searchParams.get('radius')) || 1200));

  let minLon = lon - 0.015, minLat = lat - 0.012, maxLon = lon + 0.015, maxLat = lat + 0.012;
  if (bboxParam) {
    const parts = bboxParam.split(',').map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      [minLon, minLat, maxLon, maxLat] = parts;
    }
  }

  const centerPt = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };

  // 1. Query Supabase rahin_places in bbox
  const dbPromise = (async () => {
    try {
      let qStr = `rahin_places?lat=gte.${minLat.toFixed(5)}&lat=lte.${maxLat.toFixed(5)}&lon=gte.${minLon.toFixed(5)}&lon=lte.${maxLon.toFixed(5)}&limit=80`;
      if (category && category !== 'all') {
        qStr += `&category=eq.${encodeURIComponent(category)}`;
      }
      const rows = await supabaseRest(qStr);
      if (!Array.isArray(rows)) return [];
      return rows.map((p) => {
        const meta = CATEGORY_META[p.category] || { fa: p.subcategory || 'مکان', emoji: '📍', color: '#0f9e95' };
        return {
          id: p.osm_id || `db-${p.id}`,
          place_key: p.osm_id || `db-${p.id}`,
          name: p.name,
          label: p.name,
          name_en: p.name_en || '',
          category: p.category,
          subcategory: p.subcategory || meta.fa,
          category_fa: p.subcategory || meta.fa,
          emoji: meta.emoji,
          color: meta.color,
          address: [p.city, p.district, p.address].filter(Boolean).join('، '),
          city: p.city || 'تهران',
          district: p.district || '',
          postal_code: p.postal_code || '',
          floor_unit: p.floor_unit || '',
          phone: p.phone || '',
          website: p.website || '',
          instagram: p.instagram || '',
          opening_hours: p.opening_hours || '',
          is_24h: Boolean(p.is_24h),
          description: p.description || '',
          features: Array.isArray(p.features) ? p.features : [],
          rating_avg: Number(p.rating_avg || 0),
          rating_count: Number(p.rating_count || 0),
          lat: p.lat,
          lon: p.lon,
          distance_m: haversineMeters(centerPt, { lat: p.lat, lon: p.lon }),
          source: 'rahin_db',
        };
      });
    } catch {
      return [];
    }
  })();

  // 2. Query Overpass for all shops, amenities, clinics, banks, restaurants, metro, etc. near center
  const osmPromise = (async () => {
    try {
      let ql;
      if (category && category !== 'all' && CATEGORY_META[category]?.osm?.length) {
        const clauses = CATEGORY_META[category].osm
          .map(([k, v]) => `nwr["${k}"="${v}"](around:${radius},${centerPt.lat.toFixed(5)},${centerPt.lon.toFixed(5)});`)
          .join('');
        ql = `[out:json][timeout:5];(${clauses});out center 80;`;
      } else {
        const r = Math.min(1200, radius);
        ql = `[out:json][timeout:5];(
          node["shop"]["name"](around:${r},${centerPt.lat.toFixed(5)},${centerPt.lon.toFixed(5)});
          node["amenity"]["name"](around:${r},${centerPt.lat.toFixed(5)},${centerPt.lon.toFixed(5)});
          node["healthcare"]["name"](around:${r},${centerPt.lat.toFixed(5)},${centerPt.lon.toFixed(5)});
          node["tourism"]["name"](around:${r},${centerPt.lat.toFixed(5)},${centerPt.lon.toFixed(5)});
          node["railway"~"station|subway_entrance"](around:${r},${centerPt.lat.toFixed(5)},${centerPt.lon.toFixed(5)});
          way["shop"]["name"](around:${r},${centerPt.lat.toFixed(5)},${centerPt.lon.toFixed(5)});
          way["amenity"]["name"](around:${r},${centerPt.lat.toFixed(5)},${centerPt.lon.toFixed(5)});
        );out center 100;`;
      }
      const { elements } = await queryOverpass(ql, 5000);
      return elements
        .map((el) => {
          const eLat = el.lat ?? el.center?.lat;
          const eLon = el.lon ?? el.center?.lon;
          if (!Number.isFinite(eLat) || !Number.isFinite(eLon)) return null;
          const tags = el.tags || {};
          const catInfo = classifyOsmTags(tags);
          const name = tags['name:fa'] || tags.name || tags.brand || catInfo.subcategory;
          if (!name) return null;
          const placeKey = `osm-${String(el.type || 'N')[0].toUpperCase()}-${el.id}`;
          return {
            id: placeKey,
            place_key: placeKey,
            name,
            label: name,
            name_en: tags['name:en'] || tags.brand || '',
            category: catInfo.category,
            subcategory: catInfo.subcategory,
            category_fa: catInfo.fa,
            emoji: catInfo.emoji,
            color: catInfo.color,
            address: [
              tags['addr:city'],
              tags['addr:district'] || tags['addr:suburb'],
              tags['addr:street'],
              tags['addr:housenumber'] ? `پلاک ${tags['addr:housenumber']}` : '',
            ].filter(Boolean).join('، ') || catInfo.subcategory,
            city: tags['addr:city'] || 'تهران',
            district: tags['addr:district'] || tags['addr:suburb'] || '',
            postal_code: tags['addr:postcode'] || '',
            floor_unit: tags.level ? `طبقه ${tags.level}` : '',
            phone: tags.phone || tags['contact:phone'] || tags['contact:mobile'] || '',
            website: tags.website || tags['contact:website'] || '',
            instagram: tags['contact:instagram'] || '',
            opening_hours: formatOsmOpeningHoursFa(tags.opening_hours),
            is_24h: tags.opening_hours === '24/7',
            description: tags.description || tags['description:fa'] || '',
            features: extractFeaturesFromOsmTags(tags),
            rating_avg: 0,
            rating_count: 0,
            lat: eLat,
            lon: eLon,
            distance_m: haversineMeters(centerPt, { lat: eLat, lon: eLon }),
            source: 'osm',
          };
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  })();

  const [dbPlaces, osmPlaces] = await Promise.all([dbPromise, osmPromise]);

  const fallbackFormatted = memoryPlaces
    .filter((p) => {
      if (category && category !== 'all' && p.category !== category) return false;
      const inBbox = p.lat >= minLat - 0.03 && p.lat <= maxLat + 0.03 && p.lon >= minLon - 0.03 && p.lon <= maxLon + 0.03;
      return inBbox || haversineMeters(centerPt, { lat: p.lat, lon: p.lon }) <= Math.max(radius * 2, 6000);
    })
    .map((p) => {
      const meta = CATEGORY_META[p.category] || { fa: p.subcategory || 'مکان', emoji: '📍', color: '#0f9e95' };
      const key = p.osm_id || p.id;
      return {
        id: key,
        place_key: key,
        name: p.name,
        label: p.name,
        name_en: p.name_en || '',
        category: p.category,
        subcategory: p.subcategory || meta.fa,
        category_fa: p.subcategory || meta.fa,
        emoji: meta.emoji,
        color: meta.color,
        address: [p.city, p.district, p.address].filter(Boolean).join('، '),
        city: p.city || 'تهران',
        district: p.district || '',
        postal_code: p.postal_code || '',
        floor_unit: p.floor_unit || '',
        phone: p.phone || '',
        website: p.website || '',
        instagram: p.instagram || '',
        opening_hours: p.opening_hours || '',
        is_24h: Boolean(p.is_24h ?? p.is_open_24h),
        description: p.description || '',
        features: Array.isArray(p.features) ? p.features : [],
        rating_avg: Number(p.rating_avg || 0),
        rating_count: Number(p.rating_count || 0),
        lat: p.lat,
        lon: p.lon,
        distance_m: haversineMeters(centerPt, { lat: p.lat, lon: p.lon }),
        source: 'rahin_db',
      };
    });

  const seen = new Set();
  const combined = [];
  for (const p of [...dbPlaces, ...osmPlaces, ...fallbackFormatted]) {
    if (seen.has(p.place_key)) continue;
    const nearDup = combined.find(
      (c) =>
        c.name === p.name &&
        Math.abs(c.lat - p.lat) < 0.00025 &&
        Math.abs(c.lon - p.lon) < 0.00025
    );
    if (nearDup) continue;
    seen.add(p.place_key);
    combined.push(p);
  }

  combined.sort((a, b) => (a.distance_m ?? 999999) - (b.distance_m ?? 999999));

  return sendJson(res, 200, {
    ok: true,
    count: combined.length,
    places: combined.slice(0, 120),
    categories: CATEGORY_META,
    fetched_at: new Date().toISOString(),
  }, 20);
}
