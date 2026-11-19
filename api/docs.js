import { sendJson } from '../lib/server-utils.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });
  return sendJson(res, 200, {
    openapi: '3.1.0',
    info: {
      title: 'RAHIN API',
      version: '2.0.0',
      description: 'API جامع راهین برای نقشه، جستجوی پیشرفته مکان‌ها و اصناف، ثبت و ویرایش کسب‌وکارها (مشابه نشان، بلد و گوگل‌مپ)، نظرات کاربران، مسیریابی چندوجهی، حمل‌ونقل عمومی و هشدارهای مسیر.',
    },
    paths: {
      '/api/config': { get: { summary: 'پیکربندی عمومی کلاینت و اتصال دیتابیس' } },
      '/api/health': { get: { summary: 'بررسی سلامت سرویس‌های نقشه، مسیریابی، جستجو و دیتابیس Supabase' } },
      '/api/search': { get: { summary: 'جستجوی ترکیبی مکان، مغازه، آدرس و دسته‌بندی (Supabase + Photon + Nominatim + Overpass)' } },
      '/api/reverse': { get: { summary: 'ژئوکد معکوس دقیق به همراه مشخصات کامل مکان، تلفن، ساعت کاری و امکانات' } },
      '/api/places': {
        get: { summary: 'دریافت همه مغازه‌ها و مکان‌های موجود در محدوده نقشه + جزئیات کامل و نظرات' },
        post: { summary: 'ثبت مکان/کسب‌وکار جدید روی نقشه، ویرایش مشخصات مکان یا ثبت نظر و امتیاز' },
      },
      '/api/route': {
        get: { summary: 'محاسبه مسیر روی خیابان‌های نقشه' },
        post: { summary: 'محاسبه مسیر و مسیرهای جایگزین (Valhalla + OSRM)' },
      },
      '/api/alerts': {
        get: { summary: 'هشدارهای مسیر (دوربین سرعت، سرعت‌گیر، ترافیک، تصادف، پلیس، کارگاه)' },
        post: { summary: 'ثبت گزارش جدید یا تأیید گزارش کاربران در دیتابیس' },
      },
      '/api/geocode': { get: { summary: 'ژئوکدینگ ساختاریافته مبدأ و مقصد' } },
      '/api/transit': { get: { summary: 'ایستگاه‌ها و خطوط مترو و اتوبوس' } },
      '/api/traffic': { get: { summary: 'وضعیت سرویس ترافیک' } },
    },
  }, 300);
}
