import {
  fetchWithTimeout,
  supabaseRest,
  sendJson,
  haversineMeters,
  classifyOsmTags,
  extractFeaturesFromOsmTags,
  formatOsmOpeningHoursFa,
} from '../lib/server-utils.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });
  const url = new URL(req.url, 'http://localhost');
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon') ?? url.searchParams.get('lng'));

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'invalid_coords', message: 'مختصات عرض و طول جغرافیایی معتبر نیست.' },
    });
  }

  const delta = 0.0012; // ~120m search box in DB
  const [dbPlaces, nominatimData, photonData] = await Promise.all([
    supabaseRest(
      `rahin_places?lat=gte.${(lat - delta).toFixed(6)}&lat=lte.${(lat + delta).toFixed(6)}&lon=gte.${(lon - delta).toFixed(6)}&lon=lte.${(lon + delta).toFixed(6)}&limit=10`
    ).catch(() => []),
    fetchWithTimeout(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1&extratags=1&namedetails=1&accept-language=fa,en`,
      {},
      4500
    ).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetchWithTimeout(
      `https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&lang=default`,
      {},
      4000
    ).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);

  // 1. Check if user clicked right on or very close to a saved/curated place in Supabase (within 45m)
  let matchedDb = null;
  if (Array.isArray(dbPlaces) && dbPlaces.length) {
    const withDist = dbPlaces
      .map((p) => ({ ...p, dist: haversineMeters({ lat, lon }, { lat: p.lat, lon: p.lon }) }))
      .filter((p) => p.dist != null && p.dist <= 55)
      .sort((a, b) => a.dist - b.dist);
    if (withDist.length) matchedDb = withDist[0];
  }

  // 2. Parse Nominatim + Photon
  const addr = nominatimData?.address || {};
  const extra = nominatimData?.extratags || {};
  const names = nominatimData?.namedetails || {};
  const pf = photonData?.features?.[0]?.properties || {};

  const catInfo = classifyOsmTags({
    amenity: nominatimData?.category === 'amenity' ? nominatimData?.type : pf.osm_value,
    shop: nominatimData?.category === 'shop' ? nominatimData?.type : (pf.osm_key === 'shop' ? pf.osm_value : ''),
    tourism: nominatimData?.category === 'tourism' ? nominatimData?.type : '',
    railway: nominatimData?.category === 'railway' ? nominatimData?.type : '',
    highway: nominatimData?.category === 'highway' ? nominatimData?.type : '',
    leisure: nominatimData?.category === 'leisure' ? nominatimData?.type : '',
    healthcare: extra.healthcare || '',
    office: nominatimData?.category === 'office' ? nominatimData?.type : '',
    osm_key: pf.osm_key || nominatimData?.category || '',
    osm_value: pf.osm_value || nominatimData?.type || '',
  });

  const road = addr.road || addr.pedestrian || addr.Boulevard || pf.street || '';
  const neighbourhood = addr.neighbourhood || addr.suburb || addr.quarter || pf.district || '';
  const district = addr.city_district || addr.suburb || pf.district || '';
  const city = addr.city || addr.town || addr.village || addr.county || pf.city || 'تهران';
  const houseNumber = addr.house_number || pf.housenumber || extra['addr:housenumber'] || '';
  const postcode = addr.postcode || pf.postcode || extra['addr:postcode'] || '';

  const primaryName =
    matchedDb?.name ||
    names['name:fa'] ||
    nominatimData?.name ||
    pf.name ||
    addr.amenity ||
    addr.shop ||
    addr.building ||
    (road ? `${road}${houseNumber ? `، پلاک ${houseNumber}` : ''}` : '') ||
    neighbourhood ||
    city ||
    'مکان انتخابی روی نقشه';

  const nameEn =
    matchedDb?.name_en ||
    names['name:en'] ||
    extra['name:en'] ||
    extra.brand ||
    '';

  const addressParts = [
    city,
    district && district !== city ? district : '',
    neighbourhood && neighbourhood !== district ? neighbourhood : '',
    road && road !== primaryName ? road : '',
    houseNumber ? `پلاک ${houseNumber}` : '',
  ].filter(Boolean);

  const fullAddress =
    matchedDb?.address ||
    (addressParts.length ? addressParts.join('، ') : (nominatimData?.display_name || ''));

  const osmFeatures = extractFeaturesFromOsmTags(extra);
  const dbFeatures = Array.isArray(matchedDb?.features) ? matchedDb.features : [];
  const mergedFeatures = [...new Set([...dbFeatures, ...osmFeatures])];

  const phone =
    matchedDb?.phone ||
    extra.phone ||
    extra['contact:phone'] ||
    extra['contact:mobile'] ||
    '';

  const website =
    matchedDb?.website ||
    extra.website ||
    extra['contact:website'] ||
    '';

  const instagram =
    matchedDb?.instagram ||
    extra['contact:instagram'] ||
    extra.instagram ||
    '';

  const rawHours = matchedDb?.opening_hours || extra.opening_hours || '';
  const openingHours = formatOsmOpeningHoursFa(rawHours);
  const is24h = Boolean(matchedDb?.is_24h || extra.opening_hours === '24/7' || mergedFeatures.includes('24h'));

  const placeKey =
    matchedDb?.osm_id ||
    (matchedDb?.id ? `db-${matchedDb.id}` : null) ||
    (nominatimData?.osm_type && nominatimData?.osm_id
      ? `osm-${nominatimData.osm_type[0].toUpperCase()}-${nominatimData.osm_id}`
      : `pt-${lat.toFixed(5)}-${lon.toFixed(5)}`);

  // Fetch reviews if any
  const reviews = await supabaseRest(
    `rahin_place_reviews?place_key=eq.${encodeURIComponent(placeKey)}&order=created_at.desc&limit=15`
  ).catch(() => []);

  let ratingAvg = Number(matchedDb?.rating_avg || 0);
  let ratingCount = Number(matchedDb?.rating_count || 0);
  if (Array.isArray(reviews) && reviews.length > 0 && !ratingCount) {
    ratingCount = reviews.length;
    ratingAvg = Number((reviews.reduce((s, r) => s + Number(r.rating || 5), 0) / ratingCount).toFixed(1));
  }

  return sendJson(res, 200, {
    ok: true,
    found: Boolean(matchedDb || nominatimData || pf.name),
    id: matchedDb?.id || placeKey,
    place_key: placeKey,
    lat: matchedDb ? matchedDb.lat : lat,
    lon: matchedDb ? matchedDb.lon : lon,
    label: primaryName,
    name: primaryName,
    name_en: nameEn,
    category: matchedDb?.category || catInfo.category,
    subcategory: matchedDb?.subcategory || catInfo.subcategory,
    category_fa: matchedDb?.subcategory || catInfo.fa,
    emoji: catInfo.emoji,
    color: catInfo.color,
    address: fullAddress || `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    city,
    district: matchedDb?.district || district || neighbourhood,
    road,
    house_number: houseNumber,
    postal_code: matchedDb?.postal_code || postcode,
    floor_unit: matchedDb?.floor_unit || (extra.level ? `طبقه ${extra.level}` : ''),
    phone,
    website,
    instagram,
    opening_hours: openingHours,
    is_24h: is24h,
    description: matchedDb?.description || extra.description || extra['description:fa'] || '',
    brand: extra.brand || extra['brand:fa'] || '',
    operator: extra.operator || '',
    cuisine: extra.cuisine || '',
    features: mergedFeatures,
    rating_avg: ratingAvg,
    rating_count: ratingCount,
    reviews: Array.isArray(reviews) ? reviews : [],
    osm: {
      type: nominatimData?.osm_type || pf.osm_type || null,
      id: nominatimData?.osm_id || pf.osm_id || null,
      key: pf.osm_key || nominatimData?.category || null,
      value: pf.osm_value || nominatimData?.type || null,
    },
    source: matchedDb ? 'supabase+osm' : 'osm',
    attribution: '© OpenStreetMap contributors (ODbL) • دیتابیس مکان‌های راهین',
  }, 30);
}
