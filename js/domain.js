// RAHIN — ابزارهای قالب‌بندی فارسی، هندسه مکانی و دسته‌بندی‌های جامع (مشابه نشان و بلد)

export const VERSION = '2.0.0';

export const isNativeApp =
  typeof window !== 'undefined' &&
  !!window.RAHINNative &&
  typeof window.RAHINNative.env === 'function';

export function nativeCall(method, payload = {}) {
  if (!isNativeApp || typeof window.RAHINNative[method] !== 'function') return null;
  try {
    const raw = window.RAHINNative[method](JSON.stringify(payload));
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn('nativeCall failed', method, e);
    return null;
  }
}

const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

export function faNum(n) {
  return String(n ?? '').replace(/\d/g, (d) => FA_DIGITS[Number(d)]);
}

export function fmtDistance(meters, units = 'metric') {
  if (meters == null || !Number.isFinite(meters)) return '—';
  if (units === 'imperial') {
    const mi = meters / 1609.344;
    return mi < 0.19
      ? `${faNum(Math.round((meters / 0.9144) / 5) * 5)} یارد`
      : `${faNum(mi.toFixed(mi < 10 ? 1 : 0))} مایل`;
  }
  if (meters < 950) return `${faNum(Math.max(5, Math.round(meters / 5) * 5))} متر`;
  const km = meters / 1000;
  return `${faNum(km.toFixed(km < 10 ? 1 : 0))} کیلومتر`;
}

export function fmtDistanceShort(meters, units = 'metric') {
  if (meters == null || !Number.isFinite(meters)) return '';
  if (units === 'imperial') {
    const mi = meters / 1609.344;
    return `${faNum(mi.toFixed(mi < 10 ? 1 : 0))} mi`;
  }
  if (meters < 1000) return `${faNum(Math.max(5, Math.round(meters / 5) * 5))} متر`;
  return `${faNum((meters / 1000).toFixed(meters < 10000 ? 1 : 0))} کیلومتر`;
}

export function fmtDuration(seconds, lang = 'fa') {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const min = Math.max(1, Math.round(seconds / 60));
  if (lang === 'en') {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  if (min < 60) return `${faNum(min)} دقیقه`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${faNum(h)} ساعت و ${faNum(m)} دقیقه` : `${faNum(h)} ساعت`;
}

export function fmtClock(ts = Date.now()) {
  const d = new Date(ts);
  return `${faNum(String(d.getHours()).padStart(2, '0'))}:${faNum(String(d.getMinutes()).padStart(2, '0'))}`;
}

export function fmtArrival(secondsFromNow) {
  return `رسیدن ${fmtClock(Date.now() + (secondsFromNow || 0) * 1000)}`;
}

export function timeAgo(ts) {
  if (!ts) return '';
  const timeMs = typeof ts === 'number' ? ts : new Date(ts).getTime();
  if (!Number.isFinite(timeMs)) return '';
  const diff = Math.max(0, Date.now() - timeMs);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'همین حالا';
  if (min < 60) return `${faNum(min)} دقیقه پیش`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${faNum(h)} ساعت پیش`;
  const d = Math.floor(h / 24);
  return `${faNum(d)} روز پیش`;
}

export function fmtBytes(bytes) {
  if (!bytes) return '۰ مگابایت';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${faNum(Math.max(1, Math.round(bytes / 1024)))} کیلوبایت`;
  return `${faNum(mb.toFixed(mb < 10 ? 1 : 0))} مگابایت`;
}

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const R = 6371008.8;
export const rad = (d) => (d * Math.PI) / 180;
export const deg = (r) => (r * 180) / Math.PI;

export function haversine(a, b) {
  if (!a || !b) return Infinity;
  const aLat = Number(a.lat);
  const aLon = Number(a.lon ?? a.lng);
  const bLat = Number(b.lat);
  const bLon = Number(b.lon ?? b.lng);
  if (!Number.isFinite(aLat) || !Number.isFinite(aLon) || !Number.isFinite(bLat) || !Number.isFinite(bLon)) {
    return Infinity;
  }
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearing(a, b) {
  const aLat = Number(a.lat), aLon = Number(a.lon ?? a.lng);
  const bLat = Number(b.lat), bLon = Number(b.lon ?? b.lng);
  const y = Math.sin(rad(bLon - aLon)) * Math.cos(rad(bLat));
  const x =
    Math.cos(rad(aLat)) * Math.sin(rad(bLat)) -
    Math.sin(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(rad(bLon - aLon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function angleDelta(a, b) {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

export function distanceToRoute(pt, path) {
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const a = { lat: path[i - 1][0], lon: path[i - 1][1] };
    const b = { lat: path[i][0], lon: path[i][1] };
    best = Math.min(best, pointToSegment(pt, a, b));
  }
  return best;
}

export function pointToSegment(p, a, b) {
  const x = rad(p.lon - a.lon) * Math.cos(rad((p.lat + a.lat) / 2)) * R;
  const y = rad(p.lat - a.lat) * R;
  const dx = rad(b.lon - a.lon) * Math.cos(rad((b.lat + a.lat) / 2)) * R;
  const dy = rad(b.lat - a.lat) * R;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? (x * dx + y * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - t * dx, y - t * dy);
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function spokenDistance(meters) {
  const rounded = Math.max(10, Math.round(meters / 10) * 10);
  if (rounded < 1000) return `${faNum(rounded)} متر`;
  return `${faNum((rounded / 1000).toFixed(rounded < 10000 ? 1 : 0))} کیلومتر`;
}

export const PLACE_FEATURES_CATALOG = {
  card_pos: { label: 'کارت‌خوان (POS)', icon: '💳' },
  parking: { label: 'جای پارک / پارکینگ', icon: '🅿️' },
  delivery: { label: 'ارسال با پیک', icon: '🛵' },
  takeaway: { label: 'بیرون‌بر', icon: '🥡' },
  dine_in: { label: 'فضای نشستن / سالن', icon: '🍽️' },
  '24h': { label: 'شبانه‌روزی (۲۴ ساعته)', icon: '🕒' },
  wifi: { label: 'اینترنت وای‌فای', icon: '📶' },
  wheelchair: { label: 'مناسب ویلچر', icon: '♿' },
  wc: { label: 'سرویس بهداشتی', icon: '🚻' },
};

export const PLACE_CATEGORIES_LIST = [
  { slug: 'supermarket', emoji: '🛒', label: 'سوپرمارکت و خواربار' },
  { slug: 'bakery', emoji: '🥖', label: 'نانوایی و قنادی' },
  { slug: 'restaurant', emoji: '🍽️', label: 'رستوران و غذاخوری' },
  { slug: 'fast_food', emoji: '🍔', label: 'فست‌فود و ساندویچ' },
  { slug: 'cafe', emoji: '☕', label: 'کافه و کافی‌شاپ' },
  { slug: 'pharmacy', emoji: '💊', label: 'داروخانه' },
  { slug: 'hospital', emoji: '🏥', label: 'بیمارستان، کلینیک و مطب' },
  { slug: 'shop', emoji: '🏪', label: 'فروشگاه و مغازه' },
  { slug: 'mall', emoji: '🛍️', label: 'مرکز خرید و پاساژ' },
  { slug: 'fuel', emoji: '⛽', label: 'پمپ بنزین و جایگاه سوخت' },
  { slug: 'bank', emoji: '🏦', label: 'بانک و مؤسسه مالی' },
  { slug: 'atm', emoji: '💳', label: 'خودپرداز (ATM)' },
  { slug: 'repair', emoji: '🔧', label: 'تعمیرگاه و خدمات خودرو' },
  { slug: 'parking', emoji: '🅿️', label: 'پارکینگ' },
  { slug: 'metro', emoji: '🚇', label: 'ایستگاه مترو' },
  { slug: 'bus_stop', emoji: '🚌', label: 'ایستگاه اتوبوس' },
  { slug: 'school', emoji: '🏫', label: 'مدرسه و آموزشگاه' },
  { slug: 'university', emoji: '🎓', label: 'دانشگاه و کتابخانه' },
  { slug: 'mosque', emoji: '🕌', label: 'مسجد و مکان مذهبی' },
  { slug: 'park', emoji: '🌳', label: 'پارک و فضای سبز' },
  { slug: 'hotel', emoji: '🏨', label: 'هتل و اقامتگاه' },
  { slug: 'sport', emoji: '🏋️', label: 'باشگاه و مجموعه ورزشی' },
  { slug: 'beauty', emoji: '💇', label: 'آرایشگاه و سالن زیبایی' },
  { slug: 'services', emoji: '🏢', label: 'مرکز اداری، پستی و خدماتی' },
  { slug: 'attraction', emoji: '🏛️', label: 'جاذبه گردشگری و تاریخی' },
];
