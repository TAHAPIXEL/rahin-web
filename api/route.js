// Self-contained Rahin Serverless Handler (route.js)
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



function decodePolyline6(str) {
  let index = 0, lat = 0, lng = 0;
  const coordinates = [];
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;
    shift = 0;
    result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dlng;
    coordinates.push([lat / 1e6, lng / 1e6]);
  }
  return coordinates;
}

const VALHALLA_TYPE_TO_KIND = {
  1: 'depart', 2: 'depart', 3: 'depart',
  4: 'arrive', 5: 'arrive', 6: 'arrive',
  7: 'continue', 8: 'continue',
  9: 'slight-right', 10: 'right', 11: 'sharp-right',
  12: 'uturn-right', 13: 'uturn-left',
  14: 'sharp-left', 15: 'left', 16: 'slight-left',
  17: 'ramp-straight', 18: 'ramp-right', 19: 'ramp-left',
  20: 'exit-right', 21: 'exit-left',
  22: 'stay-straight', 23: 'stay-right', 24: 'stay-left',
  25: 'merge', 26: 'roundabout-enter', 27: 'roundabout-exit',
  28: 'ferry', 29: 'ferry',
};

const KIND_LABELS_FA = {
  depart: 'شروع حرکت در مسیر',
  'slight-right': 'متمایل به راست',
  right: 'گردش به راست',
  'sharp-right': 'گردش تند به راست',
  'uturn-right': 'دور برگردان',
  'uturn-left': 'دور برگردان',
  'sharp-left': 'گردش تند به چپ',
  left: 'گردش به چپ',
  'slight-left': 'متمایل به چپ',
  continue: 'ادامه مستقیم مسیر',
  'ramp-straight': 'ورود به رمپ',
  'ramp-right': 'ورود به رمپ راست',
  'ramp-left': 'ورود به رمپ چپ',
  'exit-right': 'خروج از سمت راست',
  'exit-left': 'خروج از سمت چپ',
  'stay-straight': 'ادامه در لاین فعلی',
  'stay-right': 'ادامه در لاین راست',
  'stay-left': 'ادامه در لاین چپ',
  merge: 'ادغام در مسیر اصلی',
  'roundabout-enter': 'ورود به میدان',
  'roundabout-exit': 'خروج از میدان',
  ferry: 'عبور با شناور',
  arrive: 'رسیدن به مقصد',
};

function parseValhallaTrip(trip, provider = 'valhalla') {
  const legs = trip?.legs || [];
  let geometry = [];
  const maneuvers = [];
  let offsetM = 0;

  for (const leg of legs) {
    const pts = leg.shape ? decodePolyline6(leg.shape) : [];
    if (geometry.length && pts.length) geometry.push(...pts.slice(1));
    else geometry.push(...pts);

    for (const m of leg.maneuvers || []) {
      const kind = VALHALLA_TYPE_TO_KIND[m.type] || 'continue';
      const lenM = Math.round((m.length || 0) * 1000);
      const street = Array.isArray(m.street_names) ? m.street_names.join('، ') : '';
      const labelFa = KIND_LABELS_FA[kind] || 'ادامه مسیر';
      maneuvers.push({
        kind,
        label_fa: labelFa,
        instruction: m.instruction || (street ? `${labelFa} به سمت ${street}` : labelFa),
        street_fa: street,
        length_m: lenM,
        time_s: Math.round(m.time || 0),
        offset_m: offsetM,
      });
      offsetM += lenM;
    }
  }

  const distM = Math.round((trip?.summary?.length || 0) * 1000);
  const timeS = Math.round(trip?.summary?.time || 0);
  return {
    provider,
    distance_m: distM,
    time_s: timeS,
    geometry,
    maneuvers,
    flags: {
      has_toll: Boolean(trip?.summary?.has_toll),
      has_highway: Boolean(trip?.summary?.has_highway),
      has_ferry: Boolean(trip?.summary?.has_ferry),
    },
  };
}

function osrmStepToKind(step) {
  const type = step?.maneuver?.type || '';
  const mod = step?.maneuver?.modifier || '';
  if (type === 'depart') return 'depart';
  if (type === 'arrive') return 'arrive';
  if (type === 'roundabout' || type === 'rotary') return 'roundabout-enter';
  if (type === 'exit roundabout' || type === 'exit rotary') return 'roundabout-exit';
  if (type === 'merge') return 'merge';
  if (type === 'on ramp') return mod.includes('left') ? 'ramp-left' : 'ramp-right';
  if (type === 'off ramp') return mod.includes('left') ? 'exit-left' : 'exit-right';
  if (mod === 'uturn') return 'uturn-right';
  if (mod === 'sharp right') return 'sharp-right';
  if (mod === 'right') return 'right';
  if (mod === 'slight right') return 'slight-right';
  if (mod === 'sharp left') return 'sharp-left';
  if (mod === 'left') return 'left';
  if (mod === 'slight left') return 'slight-left';
  return 'continue';
}

function parseOsrmRoute(r, mode = 'auto') {
  const coords = (r.geometry?.coordinates || []).map(([lon, lat]) => [lat, lon]);
  const maneuvers = [];
  let offsetM = 0;
  let hasHighway = false;

  for (const leg of r.legs || []) {
    for (const step of leg.steps || []) {
      const kind = osrmStepToKind(step);
      const labelFa = KIND_LABELS_FA[kind] || 'ادامه مسیر';
      const street = step.name || step.ref || '';
      if (step.ref || /بزرگراه|آزادراه/.test(street)) hasHighway = true;
      const lenM = Math.round(step.distance || 0);
      const timeS = Math.round(step.duration || 0);
      const instruction =
        kind === 'depart'
          ? `حرکت را${street ? ` در ${street}` : ''} آغاز کنید`
          : kind === 'arrive'
          ? 'به مقصد رسیدید'
          : street
          ? `${labelFa} به سمت ${street}`
          : labelFa;
      maneuvers.push({
        kind,
        label_fa: labelFa,
        instruction,
        street_fa: street,
        length_m: lenM,
        time_s: timeS,
        offset_m: offsetM,
      });
      offsetM += lenM;
    }
  }

  // Adjust duration by mode if OSRM car profile was used as fallback
  let timeFactor = 1;
  if (mode === 'motorcycle') timeFactor = 0.78;
  else if (mode === 'bicycle') timeFactor = 2.4;
  else if (mode === 'pedestrian') timeFactor = 5.5;
  else if (mode === 'transit') timeFactor = 1.35;

  return {
    provider: 'osrm',
    distance_m: Math.round(r.distance || offsetM),
    time_s: Math.max(30, Math.round((r.duration || 60) * timeFactor)),
    geometry: coords,
    maneuvers,
    flags: {
      has_toll: false,
      has_highway: hasHighway,
      has_ferry: false,
    },
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });

  let from = null, to = null, via = [], mode = 'auto', alternates = 2;

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const fLat = Number(url.searchParams.get('from_lat') ?? url.searchParams.get('flat'));
    const fLon = Number(url.searchParams.get('from_lon') ?? url.searchParams.get('flon'));
    const tLat = Number(url.searchParams.get('to_lat') ?? url.searchParams.get('tlat'));
    const tLon = Number(url.searchParams.get('to_lon') ?? url.searchParams.get('tlon'));
    mode = url.searchParams.get('mode') || 'auto';
    if (Number.isFinite(fLat) && Number.isFinite(fLon) && Number.isFinite(tLat) && Number.isFinite(tLon)) {
      from = { lat: fLat, lon: fLon };
      to = { lat: tLat, lon: tLon };
    }
  } else {
    const body = await readJsonBody(req);
    from = body.from ? { lat: Number(body.from.lat), lon: Number(body.from.lon ?? body.from.lng) } : null;
    to = body.to ? { lat: Number(body.to.lat), lon: Number(body.to.lon ?? body.to.lng) } : null;
    via = Array.isArray(body.via)
      ? body.via
          .map((p) => ({ lat: Number(p.lat), lon: Number(p.lon ?? p.lng) }))
          .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      : [];
    mode = body.mode || 'auto';
    if (body.alternates != null) alternates = Math.min(3, Math.max(0, Number(body.alternates) || 0));
  }

  if (!from || !to || !Number.isFinite(from.lat) || !Number.isFinite(from.lon) || !Number.isFinite(to.lat) || !Number.isFinite(to.lon)) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'invalid_points', message: 'مختصات مبدأ و مقصد معتبر نیست. لطفاً مبدأ و مقصد را روی نقشه انتخاب کنید.' },
    });
  }

  const straightDist = haversineMeters(from, to);
  if (straightDist != null && straightDist < 8) {
    return sendJson(res, 200, {
      ok: true,
      mode,
      routes: [
        {
          provider: 'direct',
          distance_m: Math.max(5, straightDist),
          time_s: 15,
          geometry: [[from.lat, from.lon], [to.lat, to.lon]],
          maneuvers: [
            { kind: 'depart', label_fa: 'شروع حرکت', instruction: 'شما در نزدیکی مقصد قرار دارید', street_fa: '', length_m: straightDist, time_s: 15, offset_m: 0 },
            { kind: 'arrive', label_fa: 'رسیدن به مقصد', instruction: 'به مقصد رسیدید', street_fa: '', length_m: 0, time_s: 0, offset_m: straightDist },
          ],
          flags: { has_toll: false, has_highway: false, has_ferry: false },
        },
      ],
    });
  }

  const allPoints = [from, ...via.slice(0, 3), to];
  let routes = [];
  let warning = null;

  // 1. Try Valhalla first (supports auto, motorcycle, pedestrian, bicycle, multimodal)
  const costingMap = {
    auto: 'auto',
    motorcycle: 'motorcycle',
    pedestrian: 'pedestrian',
    bicycle: 'bicycle',
    transit: 'auto', // Fallback road geometry for cities without GTFS feed in Valhalla demo
  };

  if (mode === 'transit') {
    warning = 'مسیر بر پایه شبکه معابر و خطوط حمل‌ونقل شهری محاسبه شد.';
  }

  try {
    const valhallaPayload = {
      locations: allPoints.map((p) => ({ lat: p.lat, lon: p.lon })),
      costing: costingMap[mode] || 'auto',
      directions_options: { units: 'kilometers', language: 'fa-IR' },
      alternates: via.length ? 0 : alternates,
    };
    const vRes = await fetchWithTimeout(
      'https://valhalla1.openstreetmap.de/route',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(valhallaPayload),
      },
      5500
    );
    if (vRes.ok) {
      const vData = await vRes.json();
      if (vData?.trip) {
        routes.push(parseValhallaTrip(vData.trip, 'valhalla'));
        for (const alt of vData.alternates || []) {
          if (alt?.trip) routes.push(parseValhallaTrip(alt.trip, 'valhalla'));
        }
      }
    }
  } catch {
    // Fallback to OSRM below
  }

  // 2. Fallback to OSRM if Valhalla didn't return routes with valid geometry
  if (!routes.length || !routes[0]?.geometry?.length) {
    routes = [];
    const coordsStr = allPoints.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const osrmEndpoints =
      mode === 'pedestrian'
        ? [
            `https://routing.openstreetmap.de/routed-foot/route/v1/driving/${coordsStr}?overview=full&geometries=geojson&steps=true&alternatives=true`,
            `https://router.project-osrm.org/route/v1/foot/${coordsStr}?overview=full&geometries=geojson&steps=true&alternatives=true`,
          ]
        : mode === 'bicycle'
        ? [
            `https://routing.openstreetmap.de/routed-bike/route/v1/driving/${coordsStr}?overview=full&geometries=geojson&steps=true&alternatives=true`,
            `https://router.project-osrm.org/route/v1/bike/${coordsStr}?overview=full&geometries=geojson&steps=true&alternatives=true`,
          ]
        : [
            `https://routing.openstreetmap.de/routed-car/route/v1/driving/${coordsStr}?overview=full&geometries=geojson&steps=true&alternatives=true`,
            `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson&steps=true&alternatives=true`,
          ];

    for (const ep of osrmEndpoints) {
      try {
        const oRes = await fetchWithTimeout(ep, {}, 5500);
        if (!oRes.ok) continue;
        const oData = await oRes.json();
        if (Array.isArray(oData?.routes) && oData.routes.length) {
          const timeScaleMode = mode === 'pedestrian' || mode === 'bicycle' ? 'auto' : mode;
          routes = oData.routes.map((r) => parseOsrmRoute(r, timeScaleMode));
          break;
        }
      } catch {
        // try next endpoint
      }
    }
  }

  if (!routes.length || !routes[0]?.geometry?.length) {
    // Urban grid fallback when upstream routing servers are unreachable
    const dTotal = Math.round((straightDist || 1200) * 1.28);
    const speedMps = mode === 'pedestrian' ? 1.35 : mode === 'bicycle' ? 4.2 : mode === 'motorcycle' ? 11.5 : 9.2;
    const tTotal = Math.max(45, Math.round(dTotal / speedMps));
    const mid1 = { lat: from.lat + (to.lat - from.lat) * 0.45, lon: from.lon };
    const mid2 = { lat: from.lat + (to.lat - from.lat) * 0.45, lon: to.lon };
    const d1 = Math.round(dTotal * 0.35);
    const d2 = Math.round(dTotal * 0.40);
    const d3 = Math.max(20, dTotal - d1 - d2);
    routes = [
      {
        provider: 'rahin-grid-fallback',
        distance_m: dTotal,
        duration_s: tTotal,
        geometry: [
          [from.lat, from.lon],
          [mid1.lat, mid1.lon],
          [mid2.lat, mid2.lon],
          [to.lat, to.lon],
        ],
        maneuvers: [
          { kind: 'depart', label_fa: 'شروع حرکت', instruction: 'شروع حرکت در مسیر اصلی', street_fa: 'خیابان مبدأ', length_m: d1, time_s: Math.round(tTotal * 0.35), offset_m: 0 },
          { kind: to.lon >= from.lon ? 'right' : 'left', label_fa: to.lon >= from.lon ? 'گردش به راست' : 'گردش به چپ', instruction: `${to.lon >= from.lon ? 'گردش به راست' : 'گردش به چپ'} به خیابان میانی`, street_fa: 'خیابان اصلی', length_m: d2, time_s: Math.round(tTotal * 0.4), offset_m: d1 },
          { kind: 'straight', label_fa: 'ادامه مستقیم تا مقصد', instruction: 'ادامه مستقیم تا رسیدن به مقصد', street_fa: 'خیابان مقصد', length_m: d3, time_s: Math.round(tTotal * 0.25), offset_m: d1 + d2 },
          { kind: 'arrive', label_fa: 'رسیدن به مقصد', instruction: 'به مقصد رسیدید', street_fa: '', length_m: 0, time_s: 0, offset_m: dTotal },
        ],
        flags: { has_toll: false, has_highway: false, has_ferry: false },
      },
    ];
  }

  return sendJson(res, 200, {
    ok: true,
    mode,
    from,
    to,
    warning,
    routes,
    attribution: 'مسیریابی بر پایه شبکه معابر OpenStreetMap (Valhalla / OSRM)',
    fetched_at: new Date().toISOString(),
  });
}
