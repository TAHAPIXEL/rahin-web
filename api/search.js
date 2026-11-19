// Self-contained Rahin Serverless Handler (search.js)
// RAHIN — ابزارهای مشترک سرور برای ارتباط با Supabase، Photon، Nominatim، Overpass، Valhalla و OSRM

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://musmyiwumgeffafxsmdd.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im11c215aXd1bWdlZmZhZnhzbWRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ5MTM1MTUsImV4cCI6MjExMDQ4OTUxNX0.13RY1IEC2ehPnD3CeUoKBR9KXayYqpN5rQWM3ZphDXo';
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im11c215aXd1bWdlZmZhZnhzbWRkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5NDkxMzUxNSwiZXhwIjoyMTEwNDg5NTE1fQ.jYOeeetsXv4Ai5KJAos8Nqt3vcJlBFLTzBe0pzarn-g';

const USER_AGENT = 'RahinMapNavigator/2.0 (https://rahin-web.vercel.app; support@rahin.app)';

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

function setCors(res, cacheSeconds = 0) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (cacheSeconds > 0) {
    res.setHeader('Cache-Control', `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 3}`);
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }
}

function sendJson(res, status, data, cacheSeconds = 0) {
  setCors(res, cacheSeconds);
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'fa,en;q=0.8',
      ...(options.headers || {}),
    };
    const res = await fetch(url, { ...options, headers, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function supabaseRest(path, { method = 'GET', body = null, prefer = 'return=representation', useService = true } = {}) {
  const key = useService ? SUPABASE_SERVICE_KEY : SUPABASE_ANON_KEY;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
  };
  if (body != null) {
    headers['Content-Type'] = 'application/json';
    headers['Prefer'] = prefer;
  }
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetchWithTimeout(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  }, 6000);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Supabase HTTP ${res.status}: ${errText}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function queryOverpass(ql, timeoutMs = 5500) {
  const body = `data=${encodeURIComponent(ql)}`;
  let lastErr = null;
  for (const endpoint of OVERPASS_MIRRORS) {
    try {
      const res = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body,
      }, timeoutMs);
      if (!res.ok) {
        lastErr = new Error(`Overpass ${endpoint} HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      if (json && Array.isArray(json.elements)) {
        return { elements: json.elements, endpoint };
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Overpass unavailable');
}

function haversineMeters(a, b) {
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(a.lon) || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) {
    return null;
  }
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

const CATEGORY_META = {
  restaurant: { fa: 'رستوران و غذاخوری', emoji: '🍽️', color: '#e65100', osm: [['amenity', 'restaurant'], ['amenity', 'fast_food'], ['amenity', 'food_court']] },
  fast_food: { fa: 'فست‌فود و ساندویچ', emoji: '🍔', color: '#ef6c00', osm: [['amenity', 'fast_food']] },
  cafe: { fa: 'کافه و کافی‌شاپ', emoji: '☕', color: '#6d4c41', osm: [['amenity', 'cafe'], ['amenity', 'ice_cream'], ['shop', 'coffee'], ['shop', 'pastry']] },
  bakery: { fa: 'نانوایی و قنادی', emoji: '🥖', color: '#d97706', osm: [['shop', 'bakery'], ['shop', 'pastry'], ['shop', 'confectionery']] },
  supermarket: { fa: 'سوپرمارکت و هایپرمارکت', emoji: '🛒', color: '#16a34a', osm: [['shop', 'supermarket'], ['shop', 'convenience'], ['shop', 'grocery'], ['shop', 'greengrocer'], ['shop', 'butcher']] },
  shop: { fa: 'فروشگاه و مغازه', emoji: '🏪', color: '#0284c7', osm: [['shop', 'supermarket'], ['shop', 'convenience'], ['shop', 'clothes'], ['shop', 'electronics'], ['shop', 'mobile_phone'], ['shop', 'hardware'], ['shop', ' cosmetics'], ['shop', 'Shoes'], ['shop', 'books']] },
  mall: { fa: 'مرکز خرید و پاساژ', emoji: '🛍️', color: '#9333ea', osm: [['shop', 'mall'], ['shop', 'department_store'], ['amenity', 'marketplace']] },
  hospital: { fa: 'بیمارستان و درمانگاه', emoji: '🏥', color: '#dc2626', osm: [['amenity', 'hospital'], ['amenity', 'clinic'], ['amenity', 'doctors'], ['amenity', 'dentist'], ['healthcare', 'hospital'], ['healthcare', 'clinic']] },
  pharmacy: { fa: 'داروخانه', emoji: '💊', color: '#e11d48', osm: [['amenity', 'pharmacy'], ['healthcare', 'pharmacy']] },
  fuel: { fa: 'پمپ بنزین و جایگاه سوخت', emoji: '⛽', color: '#ea580c', osm: [['amenity', 'fuel'], ['amenity', 'charging_station']] },
  bank: { fa: 'بانک و مؤسسه مالی', emoji: '🏦', color: '#2563eb', osm: [['amenity', 'bank'], ['amenity', 'bureau_de_change']] },
  atm: { fa: 'خودپرداز (ATM)', emoji: '💳', color: '#1d4ed8', osm: [['amenity', 'atm']] },
  hotel: { fa: 'هتل و اقامتگاه', emoji: '🏨', color: '#7c3aed', osm: [['tourism', 'hotel'], ['tourism', 'guest_house'], ['tourism', 'hostel'], ['tourism', 'motel']] },
  school: { fa: 'مدرسه و آموزشگاه', emoji: '🏫', color: '#0d9488', osm: [['amenity', 'school'], ['amenity', 'kindergarten'], ['amenity', 'language_school']] },
  university: { fa: 'دانشگاه و مرکز علمی', emoji: '🎓', color: '#0f766e', osm: [['amenity', 'university'], ['amenity', 'college'], ['amenity', 'library']] },
  park: { fa: 'پارک و فضای سبز', emoji: '🌳', color: '#15803d', osm: [['leisure', 'park'], ['leisure', 'garden'], ['leisure', 'playground']] },
  metro: { fa: 'ایستگاه مترو', emoji: '🚇', color: '#0369a1', osm: [['railway', 'station'], ['railway', 'subway_entrance'], ['station', 'subway']] },
  bus_stop: { fa: 'ایستگاه اتوبوس و BRT', emoji: '🚌', color: '#0284c7', osm: [['highway', 'bus_stop'], ['amenity', 'bus_station'], ['public_transport', 'platform']] },
  repair: { fa: 'تعمیرگاه و خدمات خودرو', emoji: '🔧', color: '#475569', osm: [['shop', 'car_repair'], ['amenity', 'car_wash'], ['shop', 'tyres'], ['shop', 'car_parts']] },
  parking: { fa: 'پارکینگ', emoji: '🅿️', color: '#1e40af', osm: [['amenity', 'parking']] },
  mosque: { fa: 'مسجد و مکان مذهبی', emoji: '🕌', color: '#059669', osm: [['amenity', 'place_of_worship']] },
  attraction: { fa: 'جاذبه گردشگری و موزه', emoji: '🏛️', color: '#b45309', osm: [['tourism', 'attraction'], ['tourism', 'museum'], ['historic', 'monument']] },
  services: { fa: 'مراکز خدماتی و اداری', emoji: '🏢', color: '#4f46e5', osm: [['amenity', 'post_office'], ['amenity', 'police'], ['amenity', 'townhall'], ['office', 'government'], ['amenity', 'courthouse']] },
  sport: { fa: 'باشگاه و مجموعه ورزشی', emoji: '🏋️', color: '#0891b2', osm: [['leisure', 'fitness_centre'], ['leisure', 'sports_centre'], ['leisure', 'stadium'], ['leisure', 'swimming_pool']] },
  beauty: { fa: 'آرایشگاه و سالن زیبایی', emoji: '💇', color: '#db2777', osm: [['shop', 'hairdresser'], ['shop', 'beauty']] },
};

function classifyOsmTags(tags = {}) {
  const amenity = tags.amenity || tags.osm_value || '';
  const shop = tags.shop || '';
  const tourism = tags.tourism || '';
  const railway = tags.railway || '';
  const highway = tags.highway || '';
  const leisure = tags.leisure || '';
  const healthcare = tags.healthcare || '';
  const office = tags.office || '';

  if (amenity === 'restaurant' || amenity === 'food_court') return { category: 'restaurant', subcategory: 'رستوران', ...CATEGORY_META.restaurant };
  if (amenity === 'fast_food') return { category: 'fast_food', subcategory: 'فست‌فود', ...CATEGORY_META.fast_food };
  if (amenity === 'cafe' || amenity === 'ice_cream' || shop === 'coffee') return { category: 'cafe', subcategory: 'کافه', ...CATEGORY_META.cafe };
  if (shop === 'bakery' || shop === 'pastry' || shop === 'confectionery') return { category: 'bakery', subcategory: shop === 'bakery' ? 'نانوایی' : 'قنادی و شیرینی', ...CATEGORY_META.bakery };
  if (['supermarket', 'convenience', 'grocery', 'greengrocer', 'butcher', 'seafood', 'dairy'].includes(shop)) {
    const subMap = { supermarket: 'سوپرمارکت / هایپرمارکت', convenience: 'سوپرمارکت محلی', greengrocer: 'میوه و تره‌بار', butcher: 'قصابی و پروتئینی', dairy: 'لبنیات' };
    return { category: 'supermarket', subcategory: subMap[shop] || 'سوپرمارکت', ...CATEGORY_META.supermarket };
  }
  if (shop === 'mall' || shop === 'department_store' || amenity === 'marketplace') return { category: 'mall', subcategory: 'مجتمع تجاری و بازار', ...CATEGORY_META.mall };
  if (amenity === 'pharmacy' || healthcare === 'pharmacy') return { category: 'pharmacy', subcategory: 'داروخانه', ...CATEGORY_META.pharmacy };
  if (['hospital', 'clinic', 'doctors', 'dentist'].includes(amenity) || ['hospital', 'clinic', 'doctor', 'dentist', 'laboratory'].includes(healthcare)) {
    const subMap = { hospital: 'بیمارستان', clinic: 'کلینیک و درمانگاه', doctors: 'مطب پزشک', dentist: 'دندانپزشکی', laboratory: 'آزمایشگاه تشخیص طبی' };
    return { category: 'hospital', subcategory: subMap[amenity] || subMap[healthcare] || 'مرکز درمانی', ...CATEGORY_META.hospital };
  }
  if (amenity === 'fuel' || amenity === 'charging_station') return { category: 'fuel', subcategory: 'پمپ بنزین و سوخت', ...CATEGORY_META.fuel };
  if (amenity === 'bank' || amenity === 'bureau_de_change') return { category: 'bank', subcategory: amenity === 'bank' ? 'شعبه بانک' : 'صرافی', ...CATEGORY_META.bank };
  if (amenity === 'atm') return { category: 'atm', subcategory: 'خودپرداز بانکی', ...CATEGORY_META.atm };
  if (['hotel', 'guest_house', 'hostel', 'motel', 'apartment'].includes(tourism)) return { category: 'hotel', subcategory: 'هتل و اقامتگاه', ...CATEGORY_META.hotel };
  if (['school', 'kindergarten', 'language_school', 'music_school'].includes(amenity)) return { category: 'school', subcategory: 'مدرسه و آموزشگاه', ...CATEGORY_META.school };
  if (['university', 'college', 'library'].includes(amenity)) return { category: 'university', subcategory: amenity === 'library' ? 'کتابخانه' : 'دانشگاه', ...CATEGORY_META.university };
  if (['park', 'garden', 'playground'].includes(leisure)) return { category: 'park', subcategory: 'بوستان و فضای سبز', ...CATEGORY_META.park };
  if (railway === 'station' || railway === 'subway_entrance' || tags.station === 'subway') return { category: 'metro', subcategory: 'ایستگاه مترو', ...CATEGORY_META.metro };
  if (highway === 'bus_stop' || amenity === 'bus_station' || tags.public_transport === 'platform') return { category: 'bus_stop', subcategory: 'ایستگاه اتوبوس', ...CATEGORY_META.bus_stop };
  if (['car_repair', 'tyres', 'car_parts', 'car'].includes(shop) || amenity === 'car_wash') return { category: 'repair', subcategory: amenity === 'car_wash' ? 'کارواش' : 'تعمیرگاه و خدمات خودرو', ...CATEGORY_META.repair };
  if (amenity === 'parking') return { category: 'parking', subcategory: 'پارکینگ عمومی', ...CATEGORY_META.parking };
  if (amenity === 'place_of_worship') return { category: 'mosque', subcategory: 'مسجد و نیایشگاه', ...CATEGORY_META.mosque };
  if (['attraction', 'museum', 'viewpoint', 'gallery'].includes(tourism) || tags.historic) return { category: 'attraction', subcategory: 'جاذبه گردشگری و تاریخی', ...CATEGORY_META.attraction };
  if (['fitness_centre', 'sports_centre', 'stadium', 'swimming_pool'].includes(leisure)) return { category: 'sport', subcategory: 'باشگاه و مجموعه ورزشی', ...CATEGORY_META.sport };
  if (['hairdresser', 'beauty'].includes(shop)) return { category: 'beauty', subcategory: 'آرایشگاه و زیبایی', ...CATEGORY_META.beauty };
  if (shop) {
    const shopSubMap = {
      clothes: 'فروشگاه پوشاک', shoes: 'کیف و کفش', electronics: 'لوازم الکترونیکی و خانگی',
      mobile_phone: 'موبایل و کالای دیجیتال', computer: 'کامپیوتر و لپ‌تاپ', hardware: 'ابزارآلات و یراق',
      furniture: 'مبلمان و دکوراسیون', carpet: 'فرش و گلیم', jewelry: 'طلا و جواهر',
      florist: 'گل‌فروشی', books: 'کتاب‌فروشی و لوازم‌التحریر', stationery: 'لوازم‌التحریر',
      cosmetics: 'آرایشی و بهداشتی', optician: 'عینک‌سازی', pet: 'پت‌شاپ', toys: 'اسباب‌بازی',
      sports: 'لوازم ورزشی', bicycle: 'فروشگاه دوچرخه', tailor: 'خیاطی', laundry: 'خشکشویی',
    };
    return { category: 'shop', subcategory: shopSubMap[shop] || 'فروشگاه و مغازه', ...CATEGORY_META.shop };
  }
  if (office || ['post_office', 'police', 'townhall', 'courthouse', 'embassy', 'community_centre', 'fire_station'].includes(amenity)) {
    const srvMap = { post_office: 'دفتر پستی', police: 'کلانتری و پلیس', townhall: 'شهرداری', courthouse: 'دادگستری و مجتمع قضایی', fire_station: 'آتش‌نشانی' };
    return { category: 'services', subcategory: srvMap[amenity] || 'دفتر و مرکز خدماتی', ...CATEGORY_META.services };
  }
  return { category: 'shop', subcategory: 'مکان شهری', fa: 'مکان و کسب‌وکار', emoji: '📍', color: '#0f9e95' };
}

function extractFeaturesFromOsmTags(tags = {}) {
  const feats = new Set();
  if (tags['payment:cards'] === 'yes' || tags['payment:debit_cards'] === 'yes' || tags['payment:credit_cards'] === 'yes') feats.add('card_pos');
  if (tags.wheelchair === 'yes') feats.add('wheelchair');
  if (tags.internet_access === 'wlan' || tags.internet_access === 'yes' || tags.wifi === 'yes') feats.add('wifi');
  if (tags.delivery === 'yes') feats.add('delivery');
  if (tags.takeaway === 'yes') feats.add('takeaway');
  if (tags.outdoor_seating === 'yes' || tags.indoor_seating === 'yes') feats.add('dine_in');
  if (tags.opening_hours === '24/7') feats.add('24h');
  if (tags.toilets === 'yes' || tags['toilets:wheelchair'] === 'yes') feats.add('wc');
  if (tags.parking && tags.parking !== 'no') feats.add('parking');
  return [...feats];
}

function formatOsmOpeningHoursFa(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (s === '24/7') return 'شبانه‌روزی (۲۴ ساعته در تمام ایام هفته)';
  return s
    .replace(/Mo/g, 'دوشنبه')
    .replace(/Tu/g, 'سه‌شنبه')
    .replace(/We/g, 'چهارشنبه')
    .replace(/Th/g, 'پنجشنبه')
    .replace(/Fr/g, 'جمعه')
    .replace(/Sa/g, 'شنبه')
    .replace(/Su/g, 'یکشنبه')
    .replace(/PH/g, 'تعطیلات رسمی')
    .replace(/off/gi, 'تعطیل');
}

const FALLBACK_PLACES = [
  { id: 'fb-1', name: 'داروخانه شبانه‌روزی دکتر رازی (میدان انقلاب)', name_en: 'Dr. Razi 24h Pharmacy', category: 'pharmacy', subcategory: 'داروخانه شبانه‌روزی', lat: 35.7009, lon: 51.3915, address: 'تهران، میدان انقلاب، ابتدای خیابان کارگر شمالی، پلاک ۱۲', city: 'تهران', district: 'منطقه ۶', phone: '021-66423100', website: 'https://razipharmacy.ir', instagram: '@razipharmacy_tehran', opening_hours: 'شبانه‌روزی (۲۴ ساعته در تمام ایام هفته)', is_open_24h: true, floor_unit: 'طبقه همکف', postal_code: '1417653111', description: 'ارائه داروهای تخصصی، ترکیبی، مکمل‌های دارویی و محصولات بهداشتی با طرف قرارداد کلیه بیمه‌ها', features: ['24h', 'card_pos', 'wheelchair', 'delivery'], rating_avg: 4.8, rating_count: 142, verified: true },
  { id: 'fb-2', name: 'هایپرمارکت و فروشگاه شهروند ولیعصر', name_en: 'Shahrvand Hypermarket Valiasr', category: 'supermarket', subcategory: 'هایپرمارکت و فروشگاه زنجیره‌ای', lat: 35.7118, lon: 51.4071, address: 'تهران، میدان ولیعصر، نبش بلوار کشاورز، مجتمع تجاری ایرانیان', city: 'تهران', district: 'منطقه ۶', phone: '021-88901234', website: 'https://shahrvand.ir', instagram: '@shahrvand_stores', opening_hours: 'همه‌روزه ۰۸:۰۰ تا ۲۳:۰۰', is_open_24h: false, floor_unit: 'طبقه منفی ۱', postal_code: '1415893114', description: 'عرضه مواد غذایی، پروتئینی، میوه و تره‌بار تازه، لوازم خانگی و شوینده با تخفیف ویژه روزانه', features: ['card_pos', 'parking', 'wheelchair', 'delivery', 'wc'], rating_avg: 4.6, rating_count: 238, verified: true },
  { id: 'fb-3', name: 'کافه کتاب و رستوران روبه‌رو', name_en: 'Rooberoo Book Cafe', category: 'cafe', subcategory: 'کافه کتاب و فضای کار اشتراکی', lat: 35.7014, lon: 51.4048, address: 'تهران، چهارراه ولیعصر، ضلع شمال شرقی، بن‌بست کیانپور، پلاک ۷', city: 'تهران', district: 'منطقه ۱۱', phone: '021-66489910', website: 'https://rooberoomansion.com', instagram: '@rooberoo_mansion', opening_hours: 'شنبه تا جمعه ۰۹:۰۰ تا ۲۲:۳۰', is_open_24h: false, floor_unit: 'طبقه دوم و تراس', postal_code: '1591634112', description: 'قهوه تخصصی، دمنوش‌های گیاهی، کیک‌های خانگی، کتابفروشی و اینترنت پرسرعت مناسب مطالعه و جلسات کاری', features: ['wifi', 'card_pos', 'dine_in', 'takeaway', 'wc'], rating_avg: 4.7, rating_count: 315, verified: true },
  { id: 'fb-4', name: 'رستوران سنتی و کبابی البرز', name_en: 'Alborz Traditional Restaurant', category: 'restaurant', subcategory: 'چلوکبابی و غذای ایرانی', lat: 35.7248, lon: 51.4285, address: 'تهران، خیابان سهروردی شمالی، نبش کوچه نیکوقدم، پلاک ۴۵', city: 'تهران', district: 'منطقه ۷', phone: '021-88764501', website: 'https://alborzrestaurant.ir', instagram: '@alborz_kebab', opening_hours: 'همه‌روزه ۱۱:۳۰ تا ۲۳:۳۰', is_open_24h: false, floor_unit: 'طبقه همکف و اول', postal_code: '1576914811', description: 'بیش از نیم قرن سابقه در طبخ برگ، شیشلیک، جوجه کباب و چلوگوشت اصیل ایرانی با پارکینگ اختصاصی', features: ['card_pos', 'parking', 'dine_in', 'delivery', 'takeaway', 'wc'], rating_avg: 4.5, rating_count: 512, verified: true },
  { id: 'fb-5', name: 'نانوایی سنگک سنتی بهار', name_en: 'Bahar Traditional Sangak Bakery', category: 'bakery', subcategory: 'نانوایی سنگک ریگی', lat: 35.7072, lon: 51.4292, address: 'تهران، خیابان طالقانی، تقاطع خیابان بهار جنوبی، پلاک ۸۸', city: 'تهران', district: 'منطقه ۷', phone: '021-77503219', website: '', instagram: '', opening_hours: 'همه‌روزه ۰۶:۰۰ تا ۱۲:۳۰ و ۱۶:۰۰ تا ۲۰:۳۰', is_open_24h: false, floor_unit: 'همکف', postal_code: '1561834912', description: 'پخت نان سنگک سنتی با آرد کامل سبوس‌دار و کنجد تازه روی ریگ داغ', features: ['card_pos', 'takeaway'], rating_avg: 4.9, rating_count: 89, verified: true },
  { id: 'fb-6', name: 'جایگاه سوخت و پمپ بنزین وصال (شماره ۱۴۵)', name_en: 'Vesal Gas Station #145', category: 'fuel', subcategory: 'پمپ بنزین سوپر و معمولی', lat: 35.7052, lon: 51.3982, address: 'تهران، بلوار کشاورز، تقاطع خیابان وصال شیرازی', city: 'تهران', district: 'منطقه ۶', phone: '021-66468111', website: '', instagram: '', opening_hours: 'شبانه‌روزی (۲۴ ساعته)', is_open_24h: true, floor_unit: 'محوطه اصلی', postal_code: '1416783910', description: 'عرضه بنزین معمولی و سوپر، تنظیم باد دیجیتال و خدمات تعویض روغن فوری', features: ['24h', 'card_pos', 'wc'], rating_avg: 4.3, rating_count: 176, verified: true },
  { id: 'fb-7', name: 'بیمارستان تخصصی و فوق‌تخصصی دی', name_en: 'Day General Hospital', category: 'hospital', subcategory: 'بیمارستان و اورژانس شبانه‌روزی', lat: 35.7478, lon: 51.4126, address: 'تهران، خیابان ولیعصر، نبش خیابان شهید عباسپور (توانیر)، پلاک ۴', city: 'تهران', district: 'منطقه ۳', phone: '021-88797111', website: 'https://dayhospital.ir', instagram: '@dayhospital_official', opening_hours: 'شبانه‌روزی (۲۴ ساعته)', is_open_24h: true, floor_unit: '۸ طبقه درمانی', postal_code: '1434875351', description: 'مجهز به اورژانس ۲۴ ساعته، کلینیک قلب و عروق، تصویربرداری MRI و سی‌تی‌اسکن، آزمایشگاه و داروخانه', features: ['24h', 'card_pos', 'parking', 'wheelchair', 'wc'], rating_avg: 4.4, rating_count: 420, verified: true },
  { id: 'fb-8', name: 'پاساژ و مجتمع کامپیوتر پایتخت', name_en: 'Paytakht Computer Mall', category: 'mall', subcategory: 'مرکز خرید لپ‌تاپ، موبایل و دیجیتال', lat: 35.7604, lon: 51.4135, address: 'تهران، خیابان ولیعصر، ابتدای بلوار میرداماد، جنب پل میرداماد', city: 'تهران', district: 'منطقه ۳', phone: '021-88785000', website: 'https://paytakhtcomplex.ir', instagram: '@paytakht_mall', opening_hours: 'شنبه تا پنجشنبه ۰۹:۳۰ تا ۲۱:۰۰', is_open_24h: false, floor_unit: '۶ طبقه تجاری', postal_code: '1969734111', description: 'بورس تخصصی فروش و تعمیرات لپ‌تاپ، قطعات کامپیوتر، موبایل، تجهیزات شبکه و کنسول بازی با گارانتی معتبر', features: ['card_pos', 'parking', 'wheelchair', 'wifi', 'wc'], rating_avg: 4.6, rating_count: 680, verified: true },
  { id: 'fb-9', name: 'تعمیرگاه تخصصی خودرو و تنظیم موتور تکنوکار', name_en: 'TechnoCar Auto Service', category: 'repair', subcategory: 'مکانیکی، جلوبندی و برق خودرو', lat: 35.6985, lon: 51.3512, address: 'تهران، خیابان آزادی، بعد از یادگار امام، نبش کوچه صادقی، پلاک ۱۱۰', city: 'تهران', district: 'منطقه ۲', phone: '021-66029412', website: '', instagram: '@technocar_service', opening_hours: 'شنبه تا پنجشنبه ۰۸:۰۰ تا ۲۰:۰۰', is_open_24h: false, floor_unit: 'گاراژ همکف', postal_code: '1345681234', description: 'دیاگ تخصصی، تعمیر گیربکس اتوماتیک، شارژ کولر، تعویض لنت و سرویس دوره‌ای انواع خودروهای ایرانی و خارجی', features: ['card_pos', 'parking'], rating_avg: 4.7, rating_count: 94, verified: true },
  { id: 'fb-10', name: 'بانک سامان — شعبه مرکزی میدان ونک', name_en: 'Saman Bank Vanak Branch', category: 'bank', subcategory: 'بانک و خدمات ارزی / ریالی', lat: 35.7568, lon: 51.4102, address: 'تهران، میدان ونک، ابتدای خیابان ولیعصر شمالی، پلاک ۲۵۱۲', city: 'تهران', district: 'منطقه ۳', phone: '021-88879050', website: 'https://sb24.ir', instagram: '@samanbank_ir', opening_hours: 'شنبه تا چهارشنبه ۰۷:۳۰ تا ۱۴:۳۰ • پنجشنبه ۰۷:۳۰ تا ۱۲:۳۰', is_open_24h: false, floor_unit: 'طبقه همکف و اول', postal_code: '1969913111', description: 'ارائه کلیه خدمات بانکی، گشایش اعتبار، صندوق امانات و باجه خودپرداز و خوددریافت ۲۴ ساعته', features: ['card_pos', 'wheelchair', '24h'], rating_avg: 4.5, rating_count: 118, verified: true },
  { id: 'fb-11', name: 'ایستگاه مترو تئاتر شهر (تقاطع خط ۳ و ۴)', name_en: 'Teatr-e Shahr Metro Station', category: 'metro', subcategory: 'ایستگاه تقاطعی مترو', lat: 35.7003, lon: 51.4055, address: 'تهران، چهارراه ولیعصر، جنب پارک دانشجو و تئاتر شهر', city: 'تهران', district: 'منطقه ۱۱', phone: '021-66701000', website: 'https://metro.tehran.ir', instagram: '@tehranmetro_official', opening_hours: 'همه‌روزه ۰۵:۳۰ تا ۲۲:۳۰', is_open_24h: false, floor_unit: 'زیرزمین تراز -۱ و -۲', postal_code: '1133745112', description: 'ایستگاه تقاطعی خطوط ۳ و ۴ مترو تهران مجهز به آسانسور، پله‌برقی، باجه شارژ بلیت و غرفه‌های خدماتی', features: ['card_pos', 'wheelchair', 'wc'], rating_avg: 4.6, rating_count: 540, verified: true },
  { id: 'fb-12', name: 'فست‌فود و پیتزا تنوری شیلا (شعبه مطهری)', name_en: 'Shila Fast Food Motahari', category: 'fast_food', subcategory: 'پیتزا، برگر ذغالی و سوخاری', lat: 35.7245, lon: 51.4162, address: 'تهران، خیابان مطهری، تقاطع میرزای شیرازی، پلاک ۱۸۲', city: 'تهران', district: 'منطقه ۶', phone: '021-88712300', website: 'https://shilafood.ir', instagram: '@shilafood', opening_hours: 'همه‌روزه ۱۱:۰۰ تا ۲۴:۰۰', is_open_24h: false, floor_unit: 'طبقه همکف و بالکن', postal_code: '1586743211', description: 'پیتزاهای ایتالیایی و آمریکایی، برگرهای دست‌ساز، سیب‌زمینی ویژه و ارسال سریع در محدوده مرکز تهران', features: ['card_pos', 'dine_in', 'delivery', 'takeaway', 'wifi', 'wc'], rating_avg: 4.5, rating_count: 295, verified: true },
  { id: 'fb-13', name: 'میدان آزادی و مجموعه فرهنگی برج آزادی', name_en: 'Azadi Tower & Cultural Complex', category: 'attraction', subcategory: 'نماد شهری و موزه تاریخی', lat: 35.6997, lon: 51.3380, address: 'تهران، میدان آزادی', city: 'تهران', district: 'منطقه ۹', phone: '021-66023951', website: 'https://azadi-tower.com', instagram: '@azaditower_official', opening_hours: 'همه‌روزه ۰۹:۰۰ تا ۱۹:۰۰', is_open_24h: false, floor_unit: 'مجموعه کامل و موزه زیرین', postal_code: '1391911111', description: 'نماد تاریخی شهر تهران شامل موزه کهن، تالار آیینه، نگارخانه، کتابخانه و سکوی دیدبانی فراز برج', features: ['card_pos', 'parking', 'wheelchair', 'wc'], rating_avg: 4.9, rating_count: 1420, verified: true },
  { id: 'fb-14', name: 'فروشگاه پوشاک و کیف و کفش چرم مشهد (ولیعصر)', name_en: 'Mashhad Leather Valiasr Store', category: 'shop', subcategory: 'فروشگاه پوشاک و محصولات چرمی', lat: 35.7321, lon: 51.4112, address: 'تهران، خیابان ولیعصر، بالاتر از میدان بهشتی، پلاک ۱۹۴۰', city: 'تهران', district: 'منطقه ۶', phone: '021-88719840', website: 'https://mashhadleather.com', instagram: '@mashhadleather', opening_hours: 'همه‌روزه ۰۹:۳۰ تا ۲۱:۳۰', is_open_24h: false, floor_unit: 'طبقه همکف', postal_code: '1511734112', description: 'عرضه انواع کیف، کفش، کاپشن و اکسسوری چرم طبیعی مردانه و زنانه با ضمانت رسمی یک‌ساله', features: ['card_pos'], rating_avg: 4.7, rating_count: 164, verified: true },
  { id: 'fb-15', name: 'پارکینگ طبقاتی هوشمند نیایش (چهارراه ولیعصر)', name_en: 'Niayesh Smart Multi-Storey Parking', category: 'parking', subcategory: 'پارکینگ طبقاتی شبانه‌روزی', lat: 35.7022, lon: 51.4076, address: 'تهران، خیابان انقلاب، نرسیده به چهارراه ولیعصر، خیابان مظفر شمالی', city: 'تهران', district: 'منطقه ۶', phone: '021-66491200', website: '', instagram: '', opening_hours: 'شبانه‌روزی (۲۴ ساعته)', is_open_24h: true, floor_unit: '۷ طبقه با ظرفیت ۶۰۰ خودرو', postal_code: '1416932110', description: 'مجهز به سیستم هوشمند نمایش ظرفیت خالی، پلاک‌خوان خودکار، آسانسور و کارواش نانو', features: ['24h', 'card_pos', 'parking', 'wheelchair', 'wc'], rating_avg: 4.4, rating_count: 210, verified: true }
];

const FALLBACK_ALERTS = [
  { id: 'al-1', type: 'camera', label: 'دوربین کنترل سرعت و طرح ترافیک', lat: 35.7012, lon: 51.4058, maxspeed: 50, description: 'دوربین نظارتی چهارراه ولیعصر — سرعت مجاز ۵۰ کیلومتر بر ساعت' },
  { id: 'al-2', type: 'police', label: 'پلیس راهور', lat: 35.6999, lon: 51.3392, maxspeed: 60, description: 'ایستگاه پلیس راهور ضلع شرقی میدان آزادی' },
  { id: 'al-3', type: 'traffic', label: 'ترافیک نیمه‌سنگین', lat: 35.7121, lon: 51.4070, description: 'بار ترافیکی در محدوده میدان ولیعصر به سمت شمال' },
  { id: 'al-4', type: 'bump', label: 'سرعت‌گیر', lat: 35.7070, lon: 51.4288, description: 'سرعت‌گیر آسفالتی مقابل مدرسه در خیابان طالقانی' },
  { id: 'al-5', type: 'camera', label: 'دوربین ثبت تخلف سرعت', lat: 35.7565, lon: 51.4105, maxspeed: 60, description: 'دوربین کنترل سرعت میدان ونک' }
];



module.exports = async function handler(req, res) {
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
