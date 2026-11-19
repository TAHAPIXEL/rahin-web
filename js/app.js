// RAHIN v2.0 — منطق اصلی وب‌اپلیکیشن نقشه، کاوش مغازه‌ها و مکان‌ها، ثبت/ویرایش کسب‌وکار و مسیریابی هوشمند
import { kv, places, history, tiles as tileStore, regions as regionStore, alertsCache } from './db.js';
import { MapEngine, alertEmoji, ALERT_LABELS_FA } from './map.js';
import { NavigationEngine, cumulative } from './navigation.js';
import { voice, turnIcon } from './voice.js';
import {
  VERSION,
  faNum,
  esc,
  fmtDistance,
  fmtDuration,
  fmtArrival,
  fmtClock,
  fmtBytes,
  timeAgo,
  debounce,
  haversine,
  isNativeApp,
  PLACE_FEATURES_CATALOG,
  PLACE_CATEGORIES_LIST,
} from './domain.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const on = (sel, evt, fn) => {
  const el = $(sel);
  if (el) el.addEventListener(evt, fn);
};

const app = {
  cfg: null,
  map: null,
  supabase: null,
  session: null,
  gps: {
    watcher: null,
    last: null,
    follow: false,
    heading: null,
    accuracy: null,
    permission: null,
    manual: false,
  },
  nav: null,
  routeMode: 'auto',
  recentRoutes: [],
  origin: null, // {lat, lon, label}
  dest: null,
  pickMode: null, // 'dest' | 'origin' | 'report' | 'add-place' | 'my-location'
  reportLoc: null,
  editingPlace: null, // null for new place, or place object when editing
  addPlaceLoc: null,
  lastPlace: null,
  lastRoute: null,
  selectedRoute: null,
  altRoutes: [],
  livePois: [],
  activeCategoryFilter: null,
  offlineRegions: [],
  alertTimer: null,
  poiTimer: null,
  settings: {
    theme: 'auto',
    lang: 'fa',
    units: 'metric',
    voice: true,
    voiceLead: 'normal',
    mode: 'auto',
    autoReroute: true,
    alertsSpeed: true,
    alertsBump: true,
    alertsUser: true,
    saveHistory: true,
    showPois: true,
  },
  home: null,
  work: null,
};

const API = async (path, opts = {}) => {
  const res = await fetch(path, {
    ...opts,
    headers: {
      Accept: 'application/json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const err = new Error(payload?.error?.message || `خطای ارتباط با سرور (${res.status})`);
    err.code = payload?.error?.code;
    err.status = res.status;
    throw err;
  }
  return payload;
};

/* =========================================================
   0. راه‌اندازی اولیه (Boot)
   ========================================================= */
async function boot() {
  setLoading(15, 'در حال خواندن پیکربندی…');
  try {
    app.cfg = await API('/api/config');
  } catch {
    app.cfg = null;
  }
  await loadSettings();
  initSupabase();
  setLoading(35, 'در حال بارگذاری نقشه و فونت فارسی…');
  initMap();
  bindUI();
  renderQuickCategories();
  renderAddPlaceFormOptions();
  renderHealth();
  loadSavedCounts();
  loadHistory();
  loadRecentRoutes();
  loadOfflineRegions();
  checkGpsPermission();
  if (isNativeApp) requestNativePermissions();
}

function setLoading(pct, text) {
  const bar = $('#lsBar');
  const st = $('#lsStatus');
  if (bar) bar.style.width = `${pct}%`;
  if (st && text) st.textContent = text;
}

function hideLoading() {
  const ls = $('#loadingScreen');
  if (!ls) return;
  setLoading(100, 'آماده است');
  setTimeout(() => ls.classList.add('is-done'), 200);
}

/* =========================================================
   1. تنظیمات و ذخیره‌سازی
   ========================================================= */
async function loadSettings() {
  const s = await kv.get('settings', null);
  if (s) app.settings = { ...app.settings, ...s };
  app.home = await kv.get('home', null);
  app.work = await kv.get('work', null);
  const savedLoc = await kv.get('lastUserLocation', null);
  if (savedLoc && Number.isFinite(savedLoc.lat) && Number.isFinite(savedLoc.lon)) {
    app.gps.last = savedLoc;
  }
  applyTheme(app.settings.theme);
  voice.configure({ enabled: app.settings.voice, lead: app.settings.voiceLead });
  paintSettingsInputs();
  app.routeMode = app.settings.mode || 'auto';
  if ($('#homeSub')) $('#homeSub').textContent = app.home?.label || 'تنظیم نشده';
  if ($('#workSub')) $('#workSub').textContent = app.work?.label || 'تنظیم نشده';
}

async function saveSettings(patch) {
  app.settings = { ...app.settings, ...patch };
  await kv.set('settings', app.settings);
  voice.configure({ enabled: app.settings.voice, lead: app.settings.voiceLead });
  paintSettingsInputs();
}

function paintSettingsInputs() {
  const s = app.settings;
  $$('#setTheme button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === s.theme));
  $$('#setLang button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === s.lang));
  $$('#setUnits button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === s.units));
  $$('#setVoiceLead button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === s.voiceLead));
  $$('#setMode button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === s.mode));
  if ($('#setVoice')) $('#setVoice').checked = !!s.voice;
  if ($('#setAutoReroute')) $('#setAutoReroute').checked = !!s.autoReroute;
  if ($('#setAlertsSpeed')) $('#setAlertsSpeed').checked = !!s.alertsSpeed;
  if ($('#setAlertsBump')) $('#setAlertsBump').checked = !!s.alertsBump;
  if ($('#setAlertsUser')) $('#setAlertsUser').checked = !!s.alertsUser;
  if ($('#setSaveHistory')) $('#setSaveHistory').checked = !!s.saveHistory;
  if ($('#appVersion')) $('#appVersion').textContent = VERSION;
}

function applyTheme(theme) {
  const auto = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const t = theme === 'auto' ? auto : theme;
  document.documentElement.dataset.theme = t;
  app.map?.map && app.map.setStyle(t === 'dark' ? 'dark' : 'light').catch(() => {});
}

/* =========================================================
   2. Supabase — اتصال دیتابیس ابری
   ========================================================= */
function initSupabase() {
  const c = app.cfg?.supabase;
  if (!c?.enabled || !window.supabase) return;
  try {
    app.supabase = window.supabase.createClient(c.url, c.anon_key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    app.supabase.auth.getSession().then(({ data }) => {
      app.session = data?.session || null;
      updateProfileBadge();
    });
    app.supabase.auth.onAuthStateChange((_e, s) => {
      app.session = s;
      updateProfileBadge();
    });
  } catch (e) {
    console.warn('Supabase client init warning:', e);
  }
}

function updateProfileBadge() {
  const btn = $('#btnProfile');
  if (!btn) return;
  btn.classList.toggle('is-logged-in', Boolean(app.session));
}

/* =========================================================
   3. نقشه، انتخاب نقطه، و بارگذاری زنده مغازه‌ها/مکان‌ها
   ========================================================= */
function initMap() {
  const styleKey = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const initialCenter = app.home
    ? [app.home.lon, app.home.lat]
    : app.gps.last
    ? [app.gps.last.lon, app.gps.last.lat]
    : [51.389, 35.6892];

  app.map = new MapEngine($('#map'), {
    onPick: onMapPicked,
    onPoiClick: onPoiMarkerClicked,
    onMoveEnd: () => {
      refreshOfflineEstimate();
      scheduleViewportPoisRefresh();
    },
    onReady: () => {
      setLoading(85, 'در حال بارگذاری مکان‌ها و هشدارها…');
      hideLoading();
      // اگر قبلاً موقعیت کاربر ذخیره شده، نشانگر آبی استاندارد را نمایش بده
      if (app.gps.last) {
        app.map.updateUserLocation(app.gps.last.lat, app.gps.last.lon, {
          accuracy: app.gps.last.accuracy || 25,
          follow: false,
        });
        updateGpsBadgeText(app.gps.last);
      }
      startGpsWatcher();
      refreshViewportPois();
      refreshAlerts();
      app.alertTimer = setInterval(refreshAlerts, 2 * 60 * 1000);
    },
  });

  app.map.onAlertClick = (props) => showAlertDetail(props);
  app.map.onAltRouteClick = (altIdx) => {
    if (app.altRoutes && app.altRoutes[altIdx]) {
      selectRouteByIndex(altIdx);
    }
  };
  app.map.setCompassCallback((bearing) => {
    const needle = $('#compassNeedle');
    if (needle) needle.style.transform = `rotate(${-bearing}deg)`;
  });

  app.map
    .init({
      center: initialCenter,
      zoom: app.home ? 14.2 : 12.8,
      styleKey,
      rtlPluginUrl: '/vendor/mapbox-gl-rtl-text.js',
    })
    .catch((e) => {
      console.error(e);
      hideLoading();
      toast('بارگذاری نقشه با کندی مواجه شد؛ اتصال اینترنت را بررسی کنید', true);
    });
}

const scheduleViewportPoisRefresh = debounce(() => {
  if (app.settings.showPois !== false) {
    refreshViewportPois();
  }
}, 550);

async function refreshViewportPois(categoryOverride = undefined) {
  const map = app.map?.map;
  if (!map) return;
  const cat = categoryOverride !== undefined ? categoryOverride : app.activeCategoryFilter;
  const b = map.getBounds?.();
  const c = map.getCenter();
  const bbox = b
    ? `${b.getWest().toFixed(4)},${b.getSouth().toFixed(4)},${b.getEast().toFixed(4)},${b.getNorth().toFixed(4)}`
    : `${(c.lng - 0.02).toFixed(4)},${(c.lat - 0.015).toFixed(4)},${(c.lng + 0.02).toFixed(4)},${(c.lat + 0.015).toFixed(4)}`;

  try {
    const qCat = cat ? `&category=${encodeURIComponent(cat)}` : '';
    const r = await API(`/api/places?bbox=${bbox}&lat=${c.lat.toFixed(5)}&lon=${c.lng.toFixed(5)}${qCat}`);
    app.livePois = r.places || [];
    if (app.settings.showPois !== false) {
      app.map?.showPois(app.livePois);
    }
    renderNearbyPoisHomeList(app.livePois);
  } catch (e) {
    console.debug('POI refresh warning:', e.message);
  }
}

function renderNearbyPoisHomeList(list) {
  const box = $('#nearbyPoisList');
  const countEl = $('#nearbyPoisCount');
  if (!box) return;
  if (countEl) countEl.textContent = list.length ? `${faNum(list.length)} مکان فعال` : '';
  if (!list.length) {
    box.innerHTML = `<li class="empty">در این محدوده مکانی یافت نشد؛ نقشه را جابه‌جا کنید یا مکان جدیدی ثبت کنید.</li>`;
    return;
  }
  box.innerHTML = list
    .slice(0, 12)
    .map((p) => {
      const dist = p.distance_m != null ? fmtDistance(p.distance_m) : '';
      const ratingHtml =
        p.rating_avg > 0 ? `<span class="poi-star">★ ${faNum(Number(p.rating_avg).toFixed(1))}</span>` : '';
      const hoursBadge = p.is_24h
        ? `<span class="poi-badge-open">شبانه‌روزی</span>`
        : p.opening_hours
        ? `<span class="poi-badge-hours">${esc(p.opening_hours.slice(0, 28))}</span>`
        : '';
      return `
        <li>
          <button class="list-item poi-home-item" data-poi="${esc(JSON.stringify(p))}">
            <div class="li-icon" style="background:${esc(p.color || '#0f9e95')}18; color:${esc(p.color || '#0f9e95')}">${p.emoji || '🏪'}</div>
            <div class="li-body">
              <div class="li-title-row">
                <span class="li-title">${esc(p.name)}</span>
                ${ratingHtml}
              </div>
              <span class="li-sub">${esc(p.subcategory || p.category_fa || '')}${p.address ? ` • ${esc(p.address)}` : ''}</span>
              ${hoursBadge ? `<div class="li-badges">${hoursBadge}</div>` : ''}
            </div>
            <div class="li-side">${esc(dist)}</div>
          </button>
        </li>
      `;
    })
    .join('');

  $$('#nearbyPoisList .poi-home-item').forEach((btn) =>
    btn.addEventListener('click', () => {
      try {
        const place = JSON.parse(btn.dataset.poi);
        onPoiMarkerClicked(place);
      } catch {
        // ignore
      }
    })
  );
}

function startPickOnMap(mode, titleText, subText = 'روی نقطه موردنظر در نقشه ضربه بزنید یا نقشه را جابه‌جا کرده و تأیید کنید') {
  app.pickMode = mode;
  app.map?.setPickMode(true);
  const pb = $('#pickBar');
  if (pb) {
    $('#pickBarTitle').textContent = titleText;
    $('#pickBarSub').textContent = subText;
    pb.classList.remove('hidden');
  }
  $('#sheet').dataset.state = 'peek';
}

function cancelPickMode() {
  app.pickMode = null;
  app.map?.setPickMode(false);
  $('#pickBar')?.classList.add('hidden');
}

function onPoiMarkerClicked(poi) {
  if (!poi || !Number.isFinite(Number(poi.lat)) || !Number.isFinite(Number(poi.lon))) return;
  const lat = Number(poi.lat);
  const lon = Number(poi.lon);
  if (app.pickMode) {
    onMapPicked({ lat, lon, basePoi: poi });
    return;
  }
  app.map?.showPickMarker(lat, lon);
  loadPlaceCard({ ...poi, lat, lon }, { mode: 'poi' });
}

function onMapPicked(evt) {
  const lat = Number(evt.lat);
  const lon = Number(evt.lon ?? evt.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  const activePickMode = app.pickMode;
  if (activePickMode) {
    cancelPickMode();
  }

  if (activePickMode === 'my-location') {
    setManualUserLocation(lat, lon);
    return;
  }

  if (activePickMode === 'report') {
    app.reportLoc = { lat, lon };
    $('#reportLocText').textContent = `مکان انتخابی: ${faNum(lat.toFixed(5))}, ${faNum(lon.toFixed(5))}`;
    app.map?.showPickMarker(lat, lon);
    openView('report');
    $('#sheet').dataset.state = 'mid';
    return;
  }

  if (activePickMode === 'add-place') {
    app.addPlaceLoc = { lat, lon };
    app.map?.showPickMarker(lat, lon);
    $('#addPlaceCoordsText').textContent = `${faNum(lat.toFixed(5))}, ${faNum(lon.toFixed(5))}`;
    reverseLookup({ lat, lon }).then((p) => {
      if ($('#apAddress') && !$('#apAddress').value.trim()) {
        $('#apAddress').value = p.address || '';
      }
      if ($('#apCity') && p.city) $('#apCity').value = p.city;
      if ($('#apDistrict') && p.district) $('#apDistrict').value = p.district;
    });
    openView('addplace');
    $('#sheet').dataset.state = 'full';
    return;
  }

  if (activePickMode === 'origin' || activePickMode === 'dest') {
    app.map?.showPickMarker(lat, lon);
    reverseLookup({ lat, lon, ...(evt.basePoi || {}) }).then((place) => {
      if (activePickMode === 'origin') setOrigin(place);
      else setDest(place);
      openView('route');
      $('#sheet').dataset.state = 'mid';
    });
    return;
  }

  // کلیک عادی روی هر نقطه یا مغازه روی نقشه
  app.map?.showPickMarker(lat, lon);
  loadPlaceCard({ lat, lon, ...(evt.basePoi || {}) }, { mode: 'map' });
}

async function reverseLookup(p) {
  const lat = Number(p.lat);
  const lon = Number(p.lon ?? p.lng);
  try {
    const r = await API(`/api/reverse?lat=${lat}&lon=${lon}`);
    return {
      ...p,
      ...r,
      lat: Number(r.lat ?? lat),
      lon: Number(r.lon ?? lon),
      label: p.name || r.label || r.name || 'مکان انتخابی',
      name: p.name || r.name || r.label || 'مکان انتخابی',
      address: r.address || p.address || '',
      id: r.place_key || p.place_key || p.id || `pt-${lat.toFixed(5)}-${lon.toFixed(5)}`,
      place_key: r.place_key || p.place_key || p.id || `pt-${lat.toFixed(5)}-${lon.toFixed(5)}`,
    };
  } catch {
    return {
      ...p,
      lat,
      lon,
      label: p.name || p.label || 'مکان انتخابی روی نقشه',
      name: p.name || p.label || 'مکان انتخابی روی نقشه',
      address: p.address || `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
      id: p.place_key || p.id || `pt-${lat.toFixed(5)}-${lon.toFixed(5)}`,
      place_key: p.place_key || p.id || `pt-${lat.toFixed(5)}-${lon.toFixed(5)}`,
    };
  }
}

/* =========================================================
   3.5 کارت کامل مشخصات مکان (مشابه نشان، بلد و گوگل مپ)
   ========================================================= */
async function loadPlaceCard(p, { mode = 'map' } = {}) {
  const lat = Number(p.lat);
  const lon = Number(p.lon ?? p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  openView('place');
  $('#sheet').dataset.state = 'mid';

  // نمایش اولیه فوری در صورت وجود اطلاعات از مارکر یا جستجو
  const initialName = p.name || p.label || 'در حال دریافت مشخصات مکان…';
  $('#placeName').textContent = initialName;
  $('#placeNameEn').textContent = p.name_en || '';
  $('#placeNameEn').classList.toggle('hidden', !p.name_en);
  $('#placeAddress').textContent = p.address || 'در حال دریافت آدرس دقیق…';
  $('#placeIcon').textContent = p.emoji || emojiForPlace(p);
  $('#placeCategoryBadge').textContent = p.subcategory || p.category_fa || 'مکان روی نقشه';

  app.lastPlace = {
    ...p,
    lat,
    lon,
    label: p.name || p.label || 'مکان انتخابی',
    name: p.name || p.label || 'مکان انتخابی',
  };

  paintPlaceSpecifications(app.lastPlace);

  // دریافت اطلاعات تکمیلی از سرور (Reverse + نظرات دیتابیس)
  const enriched = await reverseLookup(p);
  // حفظ اطلاعات غنی اولیه اگر از پایگاه داده/مارکر آمده باشد
  const merged = {
    ...enriched,
    ...Object.fromEntries(Object.entries(p).filter(([_, v]) => v !== undefined && v !== null && v !== '')),
    lat: Number(p.lat ?? enriched.lat),
    lon: Number(p.lon ?? p.lng ?? enriched.lon),
    name: p.name || enriched.name || enriched.label || 'مکان انتخابی',
    label: p.name || p.label || enriched.label || 'مکان انتخابی',
    address: p.address || enriched.address || '',
    phone: p.phone || enriched.phone || '',
    website: p.website || enriched.website || '',
    instagram: p.instagram || enriched.instagram || '',
    opening_hours: p.opening_hours || enriched.opening_hours || '',
    is_24h: Boolean(p.is_24h || enriched.is_24h),
    postal_code: p.postal_code || enriched.postal_code || '',
    floor_unit: p.floor_unit || enriched.floor_unit || '',
    description: p.description || enriched.description || '',
    features: [...new Set([...(p.features || []), ...(enriched.features || [])])],
    rating_avg: Number(p.rating_avg || enriched.rating_avg || 0),
    rating_count: Number(p.rating_count || enriched.rating_count || 0),
    reviews: enriched.reviews || p.reviews || [],
  };

  app.lastPlace = merged;
  paintPlaceSpecifications(merged);
}

function paintPlaceSpecifications(place) {
  $('#placeName').textContent = place.name || place.label || 'مکان انتخابی';
  if ($('#placeNameEn')) {
    $('#placeNameEn').textContent = place.name_en || '';
    $('#placeNameEn').classList.toggle('hidden', !place.name_en);
  }
  $('#placeIcon').textContent = place.emoji || emojiForPlace(place);
  $('#placeCategoryBadge').textContent = place.subcategory || place.category_fa || 'مکان شهری';
  $('#placeAddress').textContent = place.address || 'آدرس ثبت نشده است';

  const dist = app.gps.last ? `فاصله از شما: ${fmtDistance(haversine(app.gps.last, place))}` : '';
  const coordsStr = `${faNum(Number(place.lat).toFixed(5))}, ${faNum(Number(place.lon).toFixed(5))}`;
  $('#placeMeta').textContent = [dist, `مختصات: ${coordsStr}`].filter(Boolean).join(' • ');

  // امتیاز و وضعیت ساعت کاری
  const ratingBadge = $('#placeRatingBadge');
  if (ratingBadge) {
    if (place.rating_avg > 0) {
      ratingBadge.textContent = `★ ${faNum(Number(place.rating_avg).toFixed(1))} (${faNum(place.rating_count || 1)} نظر)`;
      ratingBadge.classList.remove('hidden');
    } else {
      ratingBadge.textContent = '★ ثبت اولین امتیاز';
      ratingBadge.classList.remove('hidden');
    }
  }

  const openBadge = $('#placeOpenBadge');
  if (openBadge) {
    if (place.is_24h) {
      openBadge.textContent = '🟢 شبانه‌روزی (۲۴ ساعته باز)';
      openBadge.className = 'place-status-badge is-open';
    } else if (place.opening_hours) {
      openBadge.textContent = `🕒 ${place.opening_hours}`;
      openBadge.className = 'place-status-badge is-hours';
    } else {
      openBadge.textContent = '🕒 ساعت کاری ثبت نشده';
      openBadge.className = 'place-status-badge is-muted';
    }
  }

  // دکمه تماس تلفنی سریع
  const callBtn = $('#btnPlaceCall');
  if (callBtn) {
    if (place.phone) {
      callBtn.classList.remove('is-disabled');
      callBtn.title = `تماس با ${place.phone}`;
    } else {
      callBtn.classList.add('is-disabled');
      callBtn.title = 'شماره تماس ثبت نشده (برای افزودن کلیک کنید)';
    }
  }

  // رندر جدول کامل مشخصات (مشابه نشان و بلد)
  const detailsEl = $('#placeDetailsList');
  if (detailsEl) {
    const rows = [];
    rows.push(`
      <div class="spec-row">
        <span class="spec-ico">📍</span>
        <div class="spec-body">
          <span class="spec-label">آدرس دقیق</span>
          <span class="spec-val">${esc(place.address || 'ثبت نشده')}</span>
        </div>
      </div>
    `);

    if (place.floor_unit || place.postal_code) {
      rows.push(`
        <div class="spec-row">
          <span class="spec-ico">🏢</span>
          <div class="spec-body">
            <span class="spec-label">پلاک / طبقه / کد پستی</span>
            <span class="spec-val">${esc([place.floor_unit, place.postal_code ? `کدپستی: ${faNum(place.postal_code)}` : ''].filter(Boolean).join(' • '))}</span>
          </div>
        </div>
      `);
    }

    rows.push(`
      <div class="spec-row">
        <span class="spec-ico">📞</span>
        <div class="spec-body">
          <span class="spec-label">شماره تماس</span>
          ${
            place.phone
              ? `<a href="tel:${esc(place.phone)}" class="spec-link" dir="ltr">${esc(faNum(place.phone))}</a>`
              : `<button class="link-btn" data-edit-place="phone">+ افزودن شماره تلفن این مکان</button>`
          }
        </div>
      </div>
    `);

    rows.push(`
      <div class="spec-row">
        <span class="spec-ico">🕒</span>
        <div class="spec-body">
          <span class="spec-label">ساعات کاری</span>
          ${
            place.is_24h
              ? `<span class="spec-val ok-text">شبانه‌روزی (۲۴ ساعته در تمام ایام هفته)</span>`
              : place.opening_hours
              ? `<span class="spec-val">${esc(place.opening_hours)}</span>`
              : `<button class="link-btn" data-edit-place="hours">+ ثبت ساعت کاری</button>`
          }
        </div>
      </div>
    `);

    if (place.website || place.instagram) {
      const links = [];
      if (place.website) {
        const href = place.website.startsWith('http') ? place.website : `https://${place.website}`;
        links.push(`<a href="${esc(href)}" target="_blank" rel="noopener" class="spec-link">🌐 وب‌سایت رسمی</a>`);
      }
      if (place.instagram) {
        const handle = place.instagram.replace(/^@/, '');
        links.push(
          `<a href="https://instagram.com/${esc(handle)}" target="_blank" rel="noopener" class="spec-link" dir="ltr">📸 @${esc(handle)}</a>`
        );
      }
      rows.push(`
        <div class="spec-row">
          <span class="spec-ico">🔗</span>
          <div class="spec-body">
            <span class="spec-label">وب‌سایت و شبکه‌های اجتماعی</span>
            <div class="spec-links-row">${links.join(' • ')}</div>
          </div>
        </div>
      `);
    }

    if (place.description) {
      rows.push(`
        <div class="spec-row">
          <span class="spec-ico">📝</span>
          <div class="spec-body">
            <span class="spec-label">معرفی و توضیحات مکان</span>
            <span class="spec-val">${esc(place.description)}</span>
          </div>
        </div>
      `);
    }

    detailsEl.innerHTML = rows.join('');
    $$('#placeDetailsList [data-edit-place]').forEach((b) =>
      b.addEventListener('click', () => openEditPlaceView(place))
    );
  }

  // رندر امکانات مکان (کارت‌خوان، پارکینگ، پیک و...)
  const featsEl = $('#placeFeaturesChips');
  if (featsEl) {
    const feats = Array.isArray(place.features) ? place.features : [];
    if (feats.length) {
      featsEl.innerHTML = feats
        .map((fKey) => {
          const meta = PLACE_FEATURES_CATALOG[fKey] || { label: fKey, icon: '✓' };
          return `<span class="feat-badge">${meta.icon} ${esc(meta.label)}</span>`;
        })
        .join('');
    } else {
      featsEl.innerHTML = `<button class="link-btn" id="btnAddFeaturesInline">+ ثبت امکانات این مکان (کارت‌خوان، جای پارک، پیک و...)</button>`;
      $('#btnAddFeaturesInline')?.addEventListener('click', () => openEditPlaceView(place));
    }
  }

  // رندر نظرات کاربران
  renderPlaceReviews(place);

  // رندر هشدارهای نزدیک
  const alerts = filterNearAlerts(place, 450);
  if ($('#placeAlertCount')) $('#placeAlertCount').textContent = alerts.length ? `${faNum(alerts.length)} مورد` : '';
  if ($('#placeAlerts')) {
    $('#placeAlerts').innerHTML = alerts.length
      ? alerts
          .map(
            (a) => `
          <li class="list-item">
            <div class="li-icon">${alertEmoji(a.type)}</div>
            <div class="li-body">
              <span class="li-title">${esc(a.title || ALERT_LABELS_FA[a.type] || 'هشدار')}</span>
              <span class="li-sub">${faNum(Math.round(haversine(place, a)))} متر دورتر${a.description ? ` • ${esc(a.description)}` : ''}</span>
            </div>
          </li>`
          )
          .join('')
      : `<li class="list-item"><div class="li-icon">✓</div><div class="li-body"><span class="li-title">مسیر اطراف ایمن است</span><span class="li-sub">هشدار ترافیکی یا انسدادی در ۴۵۰ متری ثبت نشده است</span></div></li>`;
  }
}

function renderPlaceReviews(place) {
  const listEl = $('#placeReviewsList');
  if (!listEl) return;
  const reviews = Array.isArray(place.reviews) ? place.reviews : [];
  if (!reviews.length) {
    listEl.innerHTML = `<li class="empty small">هنوز نظری برای این مکان ثبت نشده است؛ اولین نفر باشید!</li>`;
    return;
  }
  listEl.innerHTML = reviews
    .map(
      (r) => `
      <li class="review-item">
        <div class="review-head">
          <strong>${esc(r.author_name || 'کاربر راهین')}</strong>
          <span class="review-stars">${'★'.repeat(Math.min(5, Math.max(1, Number(r.rating || 5))))}${'☆'.repeat(5 - Math.min(5, Math.max(1, Number(r.rating || 5))))}</span>
          <span class="muted small">${esc(timeAgo(r.created_at))}</span>
        </div>
        ${r.comment ? `<p class="review-body">${esc(r.comment)}</p>` : ''}
      </li>
    `
    )
    .join('');
}

async function submitPlaceReview() {
  const place = app.lastPlace;
  if (!place) return;
  const rating = Number($('#reviewRatingInput')?.value || 5);
  const author = ($('#reviewAuthorInput')?.value || '').trim() || 'کاربر راهین';
  const comment = ($('#reviewCommentInput')?.value || '').trim();
  if (!comment) {
    toast('لطفاً متن نظر یا تجربه خود از این مکان را بنویسید', true);
    return;
  }
  const btn = $('#btnSubmitReview');
  if (btn) btn.disabled = true;
  try {
    const placeKey = place.place_key || place.id || `pt-${place.lat.toFixed(5)}-${place.lon.toFixed(5)}`;
    const r = await API('/api/places', {
      method: 'POST',
      body: JSON.stringify({
        action: 'review',
        place_key: placeKey,
        place_name: place.name || place.label,
        author_name: author,
        rating,
        comment,
      }),
    });
    toast(r.message || 'نظر شما ثبت شد ✓');
    if ($('#reviewCommentInput')) $('#reviewCommentInput').value = '';
    const newReviews = [r.review, ...(place.reviews || [])].filter(Boolean);
    place.reviews = newReviews;
    place.rating_count = newReviews.length;
    place.rating_avg = Number(
      (newReviews.reduce((s, x) => s + Number(x.rating || 5), 0) / newReviews.length).toFixed(1)
    );
    paintPlaceSpecifications(place);
  } catch (e) {
    toast(e.message || 'خطا در ثبت نظر', true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* =========================================================
   3.6 ثبت مکان جدید و ویرایش مکان (مشابه نشان، بلد و گوگل مپ)
   ========================================================= */
function renderAddPlaceFormOptions() {
  const catSelect = $('#apCategory');
  if (catSelect) {
    catSelect.innerHTML = PLACE_CATEGORIES_LIST.map(
      (c) => `<option value="${esc(c.slug)}">${c.emoji} ${esc(c.label)}</option>`
    ).join('');
  }
  const featsBox = $('#apFeaturesGrid');
  if (featsBox) {
    featsBox.innerHTML = Object.entries(PLACE_FEATURES_CATALOG)
      .map(
        ([k, v]) => `
        <label class="feat-check">
          <input type="checkbox" value="${esc(k)}" />
          <span>${v.icon} ${esc(v.label)}</span>
        </label>
      `
      )
      .join('');
  }
}

function openAddPlaceView(initialCoords = null) {
  app.editingPlace = null;
  const center = initialCoords || (app.lastPlace ? { lat: app.lastPlace.lat, lon: app.lastPlace.lon } : null) || app.gps.last || {
    lat: app.map?.getCenter()?.lat ?? 35.6892,
    lon: app.map?.getCenter()?.lng ?? 51.389,
  };
  app.addPlaceLoc = { lat: Number(center.lat), lon: Number(center.lon) };

  $('#addPlaceViewTitle').textContent = '➕ ثبت مکان یا کسب‌وکار جدید روی نقشه';
  $('#addPlaceSubNote').textContent =
    'مغازه، شرکت، داروخانه، نانوایی، مدرسه یا هر مکان عمومی را با مشخصات کامل ثبت کنید تا بلافاصله برای همه کاربران روی نقشه نمایش داده شود.';
  $('#addPlaceCoordsText').textContent = `${faNum(app.addPlaceLoc.lat.toFixed(5))}, ${faNum(app.addPlaceLoc.lon.toFixed(5))}`;

  $('#apName').value = '';
  $('#apNameEn').value = '';
  $('#apCategory').value = 'shop';
  $('#apSubcategory').value = '';
  $('#apCity').value = 'تهران';
  $('#apDistrict').value = '';
  $('#apAddress').value = '';
  $('#apFloorUnit').value = '';
  $('#apPostalCode').value = '';
  $('#apPhone').value = '';
  $('#apHours').value = '';
  $('#apIs24h').checked = false;
  $('#apWebsite').value = '';
  $('#apInstagram').value = '';
  $('#apDescription').value = '';
  $$('#apFeaturesGrid input[type="checkbox"]').forEach((cb) => {
    cb.checked = false;
  });

  app.map?.showPickMarker(app.addPlaceLoc.lat, app.addPlaceLoc.lon, { pan: false });
  reverseLookup(app.addPlaceLoc).then((r) => {
    if (!$('#apAddress').value) $('#apAddress').value = r.address || '';
    if (r.city) $('#apCity').value = r.city;
    if (r.district) $('#apDistrict').value = r.district;
  });

  openView('addplace');
  $('#sheet').dataset.state = 'full';
}

function openEditPlaceView(place) {
  if (!place) return;
  app.editingPlace = place;
  app.addPlaceLoc = { lat: Number(place.lat), lon: Number(place.lon) };

  $('#addPlaceViewTitle').textContent = `✏️ ویرایش و تکمیل مشخصات «${place.name || place.label}»`;
  $('#addPlaceSubNote').textContent =
    'اطلاعات تکمیلی مانند شماره تلفن، ساعت کاری، پلاک/واحد و امکانات این مکان را وارد یا ویرایش کنید.';
  $('#addPlaceCoordsText').textContent = `${faNum(app.addPlaceLoc.lat.toFixed(5))}, ${faNum(app.addPlaceLoc.lon.toFixed(5))}`;

  $('#apName').value = place.name || place.label || '';
  $('#apNameEn').value = place.name_en || '';
  $('#apCategory').value = PLACE_CATEGORIES_LIST.some((c) => c.slug === place.category) ? place.category : 'shop';
  $('#apSubcategory').value = place.subcategory || place.category_fa || '';
  $('#apCity').value = place.city || 'تهران';
  $('#apDistrict').value = place.district || '';
  $('#apAddress').value = place.address || '';
  $('#apFloorUnit').value = place.floor_unit || '';
  $('#apPostalCode').value = place.postal_code || '';
  $('#apPhone').value = place.phone || '';
  $('#apHours').value = place.opening_hours || '';
  $('#apIs24h').checked = Boolean(place.is_24h);
  $('#apWebsite').value = place.website || '';
  $('#apInstagram').value = place.instagram || '';
  $('#apDescription').value = place.description || '';

  const currentFeats = new Set(Array.isArray(place.features) ? place.features : []);
  $$('#apFeaturesGrid input[type="checkbox"]').forEach((cb) => {
    cb.checked = currentFeats.has(cb.value);
  });

  openView('addplace');
  $('#sheet').dataset.state = 'full';
}

async function submitAddOrEditPlace() {
  const name = $('#apName')?.value.trim();
  if (!name) {
    toast('لطفاً نام مکان یا مغازه را وارد کنید', true);
    $('#apName')?.focus();
    return;
  }
  const loc = app.addPlaceLoc || app.lastPlace || {
    lat: app.map?.getCenter()?.lat ?? 35.6892,
    lon: app.map?.getCenter()?.lng ?? 51.389,
  };
  const features = $$('#apFeaturesGrid input[type="checkbox"]:checked').map((cb) => cb.value);
  const is24h = Boolean($('#apIs24h')?.checked);
  if (is24h && !features.includes('24h')) features.push('24h');

  const category = $('#apCategory')?.value || 'shop';
  const catMeta = PLACE_CATEGORIES_LIST.find((c) => c.slug === category);
  const subcategory = ($('#apSubcategory')?.value || '').trim() || catMeta?.label || 'فروشگاه و مغازه';

  const payload = {
    action: app.editingPlace ? 'update' : 'create',
    osm_id: app.editingPlace?.place_key || app.editingPlace?.id || undefined,
    name,
    name_en: $('#apNameEn')?.value.trim() || '',
    category,
    subcategory,
    city: $('#apCity')?.value.trim() || 'تهران',
    district: $('#apDistrict')?.value.trim() || '',
    address: $('#apAddress')?.value.trim() || '',
    floor_unit: $('#apFloorUnit')?.value.trim() || '',
    postal_code: $('#apPostalCode')?.value.trim() || '',
    phone: $('#apPhone')?.value.trim() || '',
    opening_hours: is24h ? 'شبانه‌روزی (۲۴ ساعته در تمام ایام هفته)' : $('#apHours')?.value.trim() || '',
    is_24h: is24h,
    website: $('#apWebsite')?.value.trim() || '',
    instagram: $('#apInstagram')?.value.trim() || '',
    description: $('#apDescription')?.value.trim() || '',
    features,
    lat: Number(loc.lat),
    lon: Number(loc.lon),
  };

  const btn = $('#btnSubmitAddPlace');
  if (btn) btn.disabled = true;
  try {
    const res = await API('/api/places', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    toast(res.message || 'مکان با موفقیت در نقشه راهین ثبت شد ✓');
    const savedPlace = res.place || { ...payload, label: name };
    await refreshViewportPois();
    app.map?.showPickMarker(savedPlace.lat, savedPlace.lon);
    app.map?.flyTo(savedPlace.lat, savedPlace.lon, { zoom: Math.max(app.map.getZoom(), 15.5) });
    await loadPlaceCard(savedPlace, { mode: 'poi' });
  } catch (e) {
    toast(e.message || 'خطا در ذخیره مکان', true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* =========================================================
   4. هشدارهای جاده‌ای و ترافیکی
   ========================================================= */
let currentAlerts = [];
async function refreshAlerts() {
  const map = app.map?.map;
  if (!map) return;
  const c = map.getCenter();
  const b = map.getBounds?.();
  const bbox = b
    ? `${b.getWest().toFixed(2)},${b.getSouth().toFixed(2)},${b.getEast().toFixed(2)},${b.getNorth().toFixed(2)}`
    : `${(c.lng - 0.05).toFixed(2)},${(c.lat - 0.04).toFixed(2)},${(c.lng + 0.05).toFixed(2)},${(c.lat + 0.04).toFixed(2)}`;

  try {
    const r = await API(`/api/alerts?bbox=${bbox}`);
    currentAlerts = r.alerts || [];
    await alertsCache.set(bbox, { alerts: currentAlerts });
    applyAlertFilters();
  } catch {
    const cached = await alertsCache.get(bbox);
    if (cached?.alerts) {
      currentAlerts = cached.alerts;
      applyAlertFilters();
    }
  }
}

function applyAlertFilters() {
  const s = app.settings;
  const list = currentAlerts.filter((a) => {
    if (a.type === 'speed_camera' && !s.alertsSpeed) return false;
    if (a.type === 'speed_bump' && !s.alertsBump) return false;
    if (a.source === 'users' && !s.alertsUser) return false;
    return true;
  });
  app.map?.showAlerts(list);
  app.alerts = list;
}

function filterNearAlerts(p, radius) {
  return (app.alerts || currentAlerts).filter((a) => haversine(p, a) <= radius);
}

function showAlertDetail(a) {
  toast(
    `${alertEmoji(a.type)} ${a.title || ALERT_LABELS_FA[a.type] || 'هشدار مسیر'}${
      a.description ? ` — ${a.description}` : ''
    }`
  );
}

/* =========================================================
   5. مکان‌یابی دقیق کاربر (GPS + Fallback دو مرحله‌ای + تنظیم دستی)
   ========================================================= */
function checkGpsPermission() {
  if (!navigator.permissions?.query) return;
  navigator.permissions
    .query({ name: 'geolocation' })
    .then((p) => {
      app.gps.permission = p.state;
    })
    .catch(() => {});
}

function requestNativePermissions() {
  try {
    window.RAHINNative.requestLocation();
  } catch {
    // ignore
  }
}

function startGpsWatcher(highAccuracy = true) {
  if (!navigator.geolocation) {
    showFallbackLocationIfNeeded();
    return;
  }
  stopGpsWatcher();
  app.gps.watcher = navigator.geolocation.watchPosition(
    onGps,
    (err) => onGpsError(err, highAccuracy),
    {
      enableHighAccuracy: highAccuracy,
      timeout: highAccuracy ? 7000 : 12000,
      maximumAge: highAccuracy ? 4000 : 60000,
    }
  );
}

function stopGpsWatcher() {
  if (app.gps.watcher != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(app.gps.watcher);
  }
  app.gps.watcher = null;
}

function updateGpsBadgeText(pos) {
  const badge = $('#badgeGps');
  if (!badge) return;
  badge.hidden = false;
  if (pos?.manual) {
    badge.textContent = '📍 موقعیت من (تنظیم‌شده روی نقشه)';
  } else if (pos?.accuracy) {
    badge.textContent = `📍 موقعیت فعال (±${faNum(Math.round(pos.accuracy))} متر)`;
  } else {
    badge.textContent = '📍 موقعیت من فعال';
  }
}

let gpsLostTimer = null;
function onGps(p) {
  const pos = {
    lat: p.coords.latitude,
    lon: p.coords.longitude,
    accuracy: p.coords.accuracy || 20,
    heading:
      p.coords.heading != null && Number.isFinite(p.coords.heading) && !Number.isNaN(p.coords.heading)
        ? p.coords.heading
        : null,
    speed: p.coords.speed,
    at: p.timestamp || Date.now(),
    manual: false,
  };
  app.gps.last = pos;
  app.gps.accuracy = pos.accuracy;
  app.gps.heading = pos.heading;
  kv.set('lastUserLocation', pos);
  updateGpsBadgeText(pos);

  app.map?.updateUserLocation(pos.lat, pos.lon, {
    heading: pos.heading,
    accuracy: pos.accuracy,
    follow: app.gps.follow && !app.nav?.active && !app.pickMode,
  });

  if (gpsLostTimer) clearTimeout(gpsLostTimer);
  gpsLostTimer = setTimeout(() => {
    const b = $('#badgeGps');
    if (b && !app.gps.last?.manual) b.textContent = '📍 موقعیت آماده';
  }, 15000);

  if (app.nav?.active) app.nav.update(pos);
}

function onGpsError(e, wasHighAccuracy = true) {
  // اگر حالت دقت بالا زمانش تمام شد یا در دسکتاپ در دسترس نبود، بلافاصله حالت شبکه (enableHighAccuracy: false) را امتحان کن
  if (wasHighAccuracy) {
    startGpsWatcher(false);
    return;
  }
  showFallbackLocationIfNeeded();
}

function showFallbackLocationIfNeeded() {
  const badge = $('#badgeGps');
  if (badge) {
    badge.hidden = false;
    badge.textContent = app.gps.last ? '📍 موقعیت من آماده' : '📍 تعیین موقعیت من';
  }
  // اگر هنوز هیچ موقعیتی نداریم، موقعیت پیش‌فرض/خانه را به عنوان موقعیت اولیه نمایش بده تا نشانگر آبی همیشه روی نقشه حاضر و قابل استفاده باشد
  if (!app.gps.last) {
    const fallback = app.home || { lat: 35.6997, lon: 51.3910, accuracy: 30, manual: true };
    app.gps.last = fallback;
    app.map?.updateUserLocation(fallback.lat, fallback.lon, { accuracy: 30, follow: false });
  }
}

function setManualUserLocation(lat, lon) {
  const pos = { lat: Number(lat), lon: Number(lon), accuracy: 15, heading: null, at: Date.now(), manual: true };
  app.gps.last = pos;
  app.gps.manual = true;
  kv.set('lastUserLocation', pos);
  updateGpsBadgeText(pos);
  app.map?.updateUserLocation(pos.lat, pos.lon, { accuracy: 15, follow: true, zoom: Math.max(app.map.getZoom(), 15) });
  toast('موقعیت فعلی شما با دقت بالا روی این نقطه تثبیت شد ✓');
}

function goToMyLocation() {
  if (app.gps.last) {
    app.gps.follow = true;
    $('#btnLocate')?.classList.add('is-following');
    app.map?.updateUserLocation(app.gps.last.lat, app.gps.last.lon, {
      heading: app.gps.heading,
      accuracy: app.gps.accuracy || 20,
      follow: true,
      zoom: Math.max(app.map.getZoom(), 15),
    });
    startGpsWatcher(true);
    return;
  }
  toast('در حال دریافت موقعیت شما…');
  startGpsWatcher(true);
}

/* =========================================================
   6. جستجوی پیشرفته (مغازه‌ها، آدرس‌ها و دسته‌بندی‌ها)
   ========================================================= */
async function doSearch(term, { category = null } = {}) {
  if ((!term || term.length < 2) && !category) return;
  const center = app.map?.getCenter();
  const p = center ? { lat: center.lat, lon: center.lng } : app.gps.last || { lat: 35.6892, lon: 51.389 };
  openView('search');
  $('#sheet').dataset.state = 'mid';
  $('#searchResults').innerHTML = `<li class="route-loading"><span class="spinner"></span><span>در حال جستجوی مکان‌ها و مغازه‌ها…</span></li>`;
  $('#searchEmpty').classList.add('hidden');
  try {
    const qParam = encodeURIComponent(term || '');
    const catParam = category ? `&category=${encodeURIComponent(category)}` : '';
    const r = await API(`/api/search?q=${qParam}&lat=${p.lat}&lon=${p.lon}&limit=24${catParam}`);
    renderSearchResults(r);
    if (r.results?.length) {
      app.map?.showPois(r.results);
    }
  } catch (e) {
    $('#searchResults').innerHTML = `<li class="empty">⚠️ جستجو ناموفق بود: ${esc(e.message)}</li>`;
  }
}

function renderSearchResults(r) {
  const el = $('#searchResults');
  const items = r.results || [];
  if (!items.length) {
    el.innerHTML = '';
    $('#searchEmpty').classList.remove('hidden');
    return;
  }
  $('#searchEmpty').classList.add('hidden');
  const catHeader = r.category
    ? `<li class="search-cat-banner"><span>${r.category.emoji || '🏪'} نتایج دسته‌بندی: <strong>${esc(r.category.fa)}</strong> (${faNum(items.length)} مورد)</span></li>`
    : '';

  el.innerHTML =
    catHeader +
    items
      .map((p) => {
        const dist = p.distance_m != null ? fmtDistance(p.distance_m) : '';
        const star = p.rating_avg > 0 ? `<span class="poi-star">★ ${faNum(Number(p.rating_avg).toFixed(1))}</span>` : '';
        return `
          <li>
            <button class="list-item" data-place="${esc(JSON.stringify(p))}">
              <div class="li-icon" style="background:${esc(p.color || '#0f9e95')}18; color:${esc(p.color || '#0f9e95')}">${p.emoji || emojiForPlace(p)}</div>
              <div class="li-body">
                <div class="li-title-row">
                  <span class="li-title">${esc(p.name || p.label)}</span>
                  ${star}
                </div>
                <span class="li-sub">${esc(p.subcategory || p.category_fa || '')}${p.address ? ` • ${esc(p.address)}` : ''}</span>
              </div>
              <div class="li-side">${esc(dist)}</div>
            </button>
          </li>
        `;
      })
      .join('');

  $$('#searchResults .list-item').forEach((btn) =>
    btn.addEventListener('click', () => {
      const place = JSON.parse(btn.dataset.place);
      if (app.pickMode === 'origin') {
        cancelPickMode();
        setOrigin(place);
        openView('route');
      } else if (app.pickMode === 'dest') {
        cancelPickMode();
        setDest(place);
        openView('route');
      } else {
        app.map?.showPickMarker(place.lat, place.lon);
        app.map?.flyTo(place.lat, place.lon, { zoom: Math.max(app.map.getZoom(), 15.5) });
        loadPlaceCard(place, { mode: 'search' });
      }
      $('#sheet').dataset.state = 'mid';
      $('#searchInput')?.blur();
    })
  );
}

function emojiForPlace(p) {
  if (p?.emoji) return p.emoji;
  const v = p?.category || '';
  return (
    {
      restaurant: '🍽️',
      fast_food: '🍔',
      cafe: '☕',
      bakery: '🥖',
      supermarket: '🛒',
      shop: '🏪',
      mall: '🛍️',
      hospital: '🏥',
      clinic: '🏥',
      pharmacy: '💊',
      fuel: '⛽',
      hotel: '🏨',
      bank: '🏦',
      atm: '💳',
      school: '🏫',
      university: '🎓',
      park: '🌳',
      bus_stop: '🚌',
      metro: '🚇',
      station: '🚇',
      repair: '🔧',
      parking: '🅿️',
      mosque: '🕌',
      attraction: '🏛️',
      sport: '🏋️',
      beauty: '💇',
      services: '🏢',
    }[v] || '📍'
  );
}

/* =========================================================
   7. مسیریابی دقیق روی راه‌های نقشه
   ========================================================= */
function setOrigin(place) {
  if (!place) return;
  app.origin = {
    ...place,
    lat: Number(place.lat),
    lon: Number(place.lon ?? place.lng),
    label: place.name || place.label || 'مبدأ انتخابی',
  };
  $('#originValue').textContent = app.origin.label;
  if (app.dest) maybeComputeRoute();
}

function setDest(place) {
  if (!place) return;
  app.dest = {
    ...place,
    lat: Number(place.lat),
    lon: Number(place.lon ?? place.lng),
    label: place.name || place.label || 'مقصد انتخابی',
  };
  $('#destValue').textContent = app.dest.label;
  maybeComputeRoute();
}

function getEffectiveOrigin() {
  if (app.origin && Number.isFinite(app.origin.lat) && Number.isFinite(app.origin.lon)) {
    return app.origin;
  }
  if (app.gps.last && Number.isFinite(app.gps.last.lat) && Number.isFinite(app.gps.last.lon)) {
    return {
      lat: app.gps.last.lat,
      lon: app.gps.last.lon,
      label: app.gps.last.manual ? 'موقعیت من (روی نقشه)' : 'موقعیت فعلی من',
    };
  }
  if (app.home && Number.isFinite(app.home.lat) && Number.isFinite(app.home.lon)) {
    return { lat: app.home.lat, lon: app.home.lon, label: `خانه (${app.home.label})` };
  }
  const c = app.map?.getCenter();
  if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
    return { lat: c.lat, lon: c.lng, label: 'مرکز فعلی نقشه' };
  }
  return { lat: 35.6997, lon: 51.3910, label: 'میدان انقلاب تهران (پیش‌فرض)' };
}

async function maybeComputeRoute() {
  if (!app.dest) return;
  const from = getEffectiveOrigin();
  $('#originValue').textContent = from.label || 'موقعیت من';
  await computeRoute(from, app.dest);
}

async function computeRoute(from, to) {
  openView('route');
  $('#sheet').dataset.state = 'mid';
  $('#routeLoading').classList.remove('hidden');
  $('#routeError').classList.add('hidden');
  $('#routeCards').innerHTML = '';
  $('#routeStepsBox')?.classList.add('hidden');

  const body = {
    from: { lat: Number(from.lat), lon: Number(from.lon ?? from.lng) },
    to: { lat: Number(to.lat), lon: Number(to.lon ?? to.lng) },
    mode: app.routeMode,
    alternates: 2,
  };

  try {
    const r = await API('/api/route', { method: 'POST', body: JSON.stringify(body) });
    $('#routeLoading').classList.add('hidden');
    if (!r.routes?.length) throw new Error('مسیری یافت نشد');
    app.altRoutes = r.routes;
    app.lastRoute = r.routes[0];
    app.selectedRoute = r.routes[0];
    renderRouteCards(r.routes);
    app.map?.clearPickMarker();
    app.map?.showRoute(r.routes[0], r.routes.slice(1));
    if (r.warning) toast(r.warning);
  } catch (e) {
    $('#routeLoading').classList.add('hidden');
    const err = $('#routeError');
    err.classList.remove('hidden');
    err.innerHTML = `⛔ ${esc(e.message)}<br><span class="small muted">مبدأ یا مقصد دیگری روی خیابان‌های نقشه انتخاب کنید یا شیوه سفر را تغییر دهید.</span>`;
  }
}

function selectRouteByIndex(idx) {
  const routes = app.altRoutes || [];
  if (!routes[idx]) return;
  $$('#routeCards .route-card').forEach((b, i) => b.classList.toggle('is-on', i === idx));
  const primary = routes[idx];
  app.selectedRoute = primary;
  app.lastRoute = primary;
  app.map?.showRoute(
    primary,
    routes.filter((_, j) => j !== idx)
  );
  renderSteps(primary);
}

function renderRouteCards(routes) {
  $('#routeCards').innerHTML = routes
    .map((r, i) => {
      const badges = [];
      if (i === 0) badges.push('سریع‌ترین مسیر');
      else badges.push(`مسیر جایگزین ${faNum(i)}`);
      if (r.flags?.has_highway) badges.push('بزرگراه');
      if (r.flags?.has_toll) badges.push('عوارضی');
      return `
        <div class="route-card ${i === 0 ? 'is-on' : ''}" data-i="${i}">
          <div class="rc-main" data-select-route="${i}">
            <div class="rc-title">${['⚡', '🛣️', '🧭'][i] || '🧭'} ${fmtDuration(r.time_s)} <span class="rc-dist">(${fmtDistance(r.distance_m)})</span></div>
            <div class="rc-sub">${fmtArrival(r.time_s)} • بر پایه شبکه معابر</div>
            <div class="rc-badges">${badges.map((b) => `<span class="rc-badge">${esc(b)}</span>`).join('')}</div>
          </div>
          <button class="rc-go" data-start-nav="${i}" title="شروع مسیریابی سخنگو">
            <span>شروع</span>
            <small>➜</small>
          </button>
        </div>
      `;
    })
    .join('');

  $$('#routeCards [data-select-route]').forEach((el) =>
    el.addEventListener('click', () => {
      selectRouteByIndex(Number(el.dataset.selectRoute));
    })
  );
  $$('#routeCards [data-start-nav]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectRouteByIndex(Number(btn.dataset.startNav));
      startNavigation();
    })
  );

  renderSteps(routes[0]);
  $('#optAlternatives')?.classList.toggle('is-on', routes.length > 1);
}

function renderSteps(route) {
  const box = $('#routeStepsBox');
  const list = route.maneuvers || [];
  $('#stepsCount').textContent = `${faNum(list.length)} گام`;
  $('#routeSteps').innerHTML = list
    .map(
      (m) => `
      <li>
        <span class="step-ico">${turnIcon(m.kind)}</span>
        <div class="step-txt">
          <div><strong>${esc(m.label_fa || 'ادامه مسیر')}</strong>${m.street_fa ? ` — ${esc(m.street_fa)}` : ''}</div>
          <div class="step-sub">${fmtDistance(m.length_m)} • ${fmtDuration(m.time_s)}${m.instruction ? ` • ${esc(m.instruction)}` : ''}</div>
        </div>
      </li>
    `
    )
    .join('');
  box.classList.remove('hidden');
}

function startNavigation() {
  const route = app.selectedRoute || app.lastRoute || app.altRoutes?.[0];
  if (!route) {
    toast('ابتدا مقصد را انتخاب کنید', true);
    return;
  }
  const startPt = app.gps.last || getEffectiveOrigin();
  if (!app.gps.last && startPt) {
    app.gps.last = { lat: startPt.lat, lon: startPt.lon, accuracy: 20, manual: true };
    app.map?.updateUserLocation(startPt.lat, startPt.lon, { accuracy: 20, follow: false });
  }
  app.nav = new NavigationEngine({
    mapEngine: app.map,
    units: app.settings.units,
    onUpdate: onNavUpdate,
    onArrive: onNavArrive,
    onReroute: onNavReroute,
    onExit: onNavExit,
  });
  app.nav.start(route, { mode: app.routeMode });
  $('#navHud').classList.remove('hidden');
  $('#sheet').dataset.state = 'peek';
  app.gps.follow = false;
  const first = app.nav.toHudModel();
  if (first) paintHud(first);
  if (app.gps.last) app.nav.update(app.gps.last);

  if (navigator.wakeLock) {
    navigator.wakeLock
      .request('screen')
      .then((w) => {
        app._wakeLock = w;
      })
      .catch(() => {});
  }
  if (app.settings.saveHistory) {
    history.add({
      dest: app.dest?.label || 'مقصد',
      originLabel: getEffectiveOrigin().label,
      destPlace: app.dest,
      originPlace: app.origin,
      mode: app.routeMode,
      distance: route.distance_m,
      duration: route.time_s,
    });
    loadHistory();
    loadRecentRoutes();
  }
}

function onNavUpdate(m) {
  paintHud(m);
  updateProgressOnMap(m);
}

function paintHud(m) {
  if (!m) return;
  const man = m.maneuver;
  $('#navTurnDist').textContent = man ? fmtDistance(m.distToNextTurn) : fmtDistance(m.remainingM);
  $('#navTurnLabel').textContent = man ? man.label_fa || 'ادامه مسیر' : 'در مسیر مستقیم';
  $('#navTurnStreet').textContent = man?.street_fa || man?.instruction || '';
  $('#navEta').textContent = fmtDuration(m.remainingS);
  $('#navEtaSub').textContent =
    m.speedKmh > 3 ? `سرعت ${faNum(Math.round(m.speedKmh))} کیلومتر بر ساعت` : 'مسیریابی زنده فعال';
  $('#navRemaining').textContent = `مسافت باقی‌مانده: ${fmtDistance(m.remainingM)}`;
  $('#navArrival').textContent = fmtArrival(m.remainingS);
  $('#navProgressFill').style.width = `${(m.progress * 100).toFixed(1)}%`;
  $('#navTurnIcon').innerHTML = `${turnIcon(man?.kind)}`;
}

function updateProgressOnMap(m) {
  const src = app.map?.map?.getSource('route-main');
  if (!src || !app.nav?.route) return;
  const route = app.nav.route;
  const idx = Math.min(route.geometry.length - 1, Math.round((route.geometry.length - 1) * m.progress));
  const passed = route.geometry.slice(0, idx + 1).map(([lat, lon]) => [lon, lat]);
  const rest = route.geometry.slice(idx).map(([lat, lon]) => [lon, lat]);
  src.setData({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { part: 'rest' }, geometry: { type: 'LineString', coordinates: rest } },
      { type: 'Feature', properties: { part: 'passed' }, geometry: { type: 'LineString', coordinates: passed } },
    ],
  });
  const map = app.map?.map;
  if (map?.getLayer('route-main-line')) {
    map.setPaintProperty('route-main-line', 'line-color', [
      'case',
      ['==', ['get', 'part'], 'passed'],
      '#94a3b8',
      '#0ea5e9',
    ]);
  }
}

function onNavArrive() {
  voice.announceArrive();
  toast('به مقصد رسیدید 🎉');
  endNavigation(false);
}

async function onNavReroute({ at }) {
  if (!app.settings.autoReroute || !app.dest) return;
  try {
    const r = await API('/api/route', {
      method: 'POST',
      body: JSON.stringify({
        from: at,
        to: { lat: app.dest.lat, lon: app.dest.lon },
        mode: app.routeMode,
        alternates: 0,
      }),
    });
    if (r.routes?.length && app.nav) {
      app.nav.route = r.routes[0];
      app.nav.cum = cumulative(r.routes[0].geometry);
      app.nav.progressDist = 0;
      app.nav.maneuverIndex = 0;
      app.nav.announced = {};
      app.map?.showRoute(r.routes[0], []);
      toast('مسیر جدید بر اساس موقعیت فعلی محاسبه شد');
    }
  } catch {
    toast('در حال بازمحاسبه مسیر…', true);
  }
}

function onNavExit() {
  endNavigation(true);
}

function endNavigation(keepMap) {
  app.nav?.stop();
  app.nav = null;
  $('#navHud').classList.add('hidden');
  $('#sheet').dataset.state = 'mid';
  app._wakeLock?.release?.().catch(() => {});
  if (!keepMap) {
    app.map?.clearRoutes();
    app.dest = null;
    app.origin = null;
    $('#destValue').textContent = 'انتخاب مقصد';
    $('#originValue').textContent = 'موقعیت من';
    openView('home');
  }
}

/* =========================================================
   8. ثبت گزارش‌های مسیر (مستقیم در دیتابیس Supabase)
   ========================================================= */
const REPORT_TYPES = [
  { type: 'accident', emoji: '💥', label: 'تصادف' },
  { type: 'traffic', emoji: '🚗', label: 'ترافیک سنگین' },
  { type: 'police', emoji: '👮', label: 'پلیس راهور' },
  { type: 'closure', emoji: '⛔', label: 'انسداد مسیر' },
  { type: 'roadwork', emoji: '🚧', label: 'کارگاه جاده' },
  { type: 'speed_camera', emoji: '📷', label: 'دوربین سرعت' },
  { type: 'speed_bump', emoji: '🐢', label: 'سرعت‌گیر' },
  { type: 'hazard', emoji: '⚠️', label: 'خطر جاده‌ای' },
];
let selectedReportType = REPORT_TYPES[0].type;

function renderReportTypes() {
  $('#reportTypes').innerHTML = REPORT_TYPES.map(
    (t) => `
    <button class="report-type ${t.type === selectedReportType ? 'is-on' : ''}" data-type="${t.type}">
      <span class="emoji">${t.emoji}</span>
      <span>${t.label}</span>
    </button>`
  ).join('');
  $$('#reportTypes .report-type').forEach((b) =>
    b.addEventListener('click', () => {
      selectedReportType = b.dataset.type;
      $$('#reportTypes .report-type').forEach((x) => x.classList.toggle('is-on', x === b));
    })
  );
}

async function submitReport() {
  const desc = $('#reportDesc').value.trim();
  const c = app.map?.getCenter();
  const place = app.reportLoc || app.lastPlace || app.gps.last || (c ? { lat: c.lat, lon: c.lng } : null);
  if (!place) {
    toast('لطفاً مکان گزارش را روی نقشه انتخاب کنید', true);
    return;
  }
  const title = REPORT_TYPES.find((t) => t.type === selectedReportType)?.label || 'هشدار مسیر';
  try {
    const res = await API('/api/alerts', {
      method: 'POST',
      body: JSON.stringify({
        type: selectedReportType,
        title,
        description: desc || null,
        lat: place.lat,
        lon: place.lon,
      }),
    });
    toast(res.message || 'گزارش شما در نقشه ثبت شد ✓');
    $('#reportDesc').value = '';
    app.reportLoc = null;
    $('#reportLocText').textContent = 'مکان: موقعیت فعلی روی نقشه';
    await refreshAlerts();
    openView('home');
  } catch (e) {
    toast(`خطا در ثبت گزارش: ${e.message}`, true);
  }
}

/* =========================================================
   9. مکان‌های ذخیره‌شده و تاریخچه
   ========================================================= */
async function toggleSavePlace(place) {
  if (!place) return;
  const saved = await places.all();
  const existing = saved.find((p) => Math.abs(p.lat - place.lat) < 0.0002 && Math.abs(p.lon - place.lon) < 0.0002);
  if (existing) {
    await places.del(existing.id);
    toast('از مکان‌های ذخیره‌شده حذف شد');
  } else {
    await places.put({
      id: `p-${Date.now()}`,
      lat: place.lat,
      lon: place.lon,
      label: place.name || place.label,
      name: place.name || place.label,
      address: place.address,
      category: place.category,
      emoji: place.emoji,
    });
    toast('در مکان‌های منتخب ذخیره شد ✓');
  }
  loadSavedCounts();
}

async function setHome(place) {
  app.home = { ...place, label: place.name || place.label };
  await kv.set('home', app.home);
  $('#homeSub').textContent = app.home.label;
  toast('به‌عنوان مکان «خانه» ذخیره شد ✓');
}

async function setWork(place) {
  app.work = { ...place, label: place.name || place.label };
  await kv.set('work', app.work);
  $('#workSub').textContent = app.work.label;
  toast('به‌عنوان «محل کار» ذخیره شد ✓');
}

async function loadSavedCounts() {
  const all = await places.all();
  if ($('#savedSub')) $('#savedSub').textContent = `${faNum(all.length)} مکان`;
}

async function loadHistory() {
  const list = await history.recent(6);
  const el = $('#historyList');
  if (!el) return;
  el.innerHTML = list.length
    ? list
        .map(
          (h) => `
      <li>
        <button class="list-item" data-hist="${esc(JSON.stringify(h))}">
          <div class="li-icon">🧭</div>
          <div class="li-body">
            <span class="li-title">${esc(h.dest)}</span>
            <span class="li-sub">${fmtDistance(h.distance)} • ${fmtDuration(h.duration)} • ${timeAgo(h.at)}</span>
          </div>
          <div class="li-side">${esc(h.originLabel || '')}</div>
        </button>
      </li>`
        )
        .join('')
    : `<li class="empty">🕘 هنوز مسیری در تاریخچه ثبت نشده است</li>`;

  $$('#historyList [data-hist]').forEach((b) =>
    b.addEventListener('click', () => {
      try {
        const h = JSON.parse(b.dataset.hist);
        if (h.originPlace) app.origin = h.originPlace;
        if (h.destPlace) {
          setDest(h.destPlace);
          openView('route');
        }
      } catch {
        // ignore
      }
    })
  );
}

async function loadRecentRoutes() {
  app.recentRoutes = await history.recent(8);
}

/* =========================================================
   10. نقشه آفلاین
   ========================================================= */
function refreshOfflineEstimate() {
  const map = app.map?.map;
  if (!map) return;
  const b = map.getBounds?.();
  if (!b) return;
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  if ($('#offlineBbox')) $('#offlineBbox').textContent = `${bbox.map((v) => v.toFixed(3)).join(', ')}`;
  const zmax = parseInt($('#offlineZoom')?.value || '13', 10);
  const count = app.map.estimateTiles(bbox, 9, zmax);
  if ($('#offlineEstimate')) {
    $('#offlineEstimate').textContent = `حجم تقریبی: ${fmtBytes(count * 85 * 1024)} (${faNum(count)} کاشی)`;
  }
}

async function downloadOfflineArea() {
  const map = app.map?.map;
  if (!map) return;
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const zmax = parseInt($('#offlineZoom').value, 10);
  const list = app.map.tilesFor(bbox, 9, zmax);
  if (list.length > 3000) {
    toast('محدوده بزرگ است؛ زوم کمتر یا محدوده کوچک‌تری انتخاب کنید', true);
    return;
  }
  const region = {
    id: `r-${Date.now()}`,
    bbox,
    zmax,
    createdAt: Date.now(),
    name: `محدوده ذخیره‌شده ${fmtClock()}`,
    count: list.length,
  };
  await regionStore.put(region);
  const progress = $('#offlineProgress');
  progress.classList.remove('hidden');
  let ok = 0;
  let i = 0;
  const queue = [...list];
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      i++;
      try {
        const url = `https://tiles.openfreemap.org/planet/${t.z}/${t.x}/${t.y}.pbf`;
        const res = await fetch(url, { mode: 'cors' });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          await tileStore.set(`${t.z}/${t.x}/${t.y}`, buf);
          ok++;
        }
      } catch {
        // ignore
      }
      const pct = Math.round((i / list.length) * 100);
      $('#offlineProgressFill').style.width = `${pct}%`;
      $('#offlineProgressText').textContent = `${faNum(pct)}% — ${faNum(ok)} کاشی`;
    }
  };
  await Promise.all([1, 2, 3, 4].map(worker));
  progress.classList.add('hidden');
  toast(`دانلود آفلاین محدوده کامل شد (${faNum(ok)} کاشی) ✓`);
  loadOfflineRegions();
}

async function loadOfflineRegions() {
  const list = await regionStore.all();
  app.offlineRegions = list;
  const el = $('#offlineList');
  if (!el) return;
  el.innerHTML = list.length
    ? list
        .map(
          (r) => `
      <li class="list-item">
        <div class="li-icon">🗺️</div>
        <div class="li-body">
          <span class="li-title">${esc(r.name)}</span>
          <span class="li-sub">زوم ${faNum(9)} تا ${faNum(r.zmax)} • ${faNum(r.count)} کاشی • ${timeAgo(r.createdAt)}</span>
        </div>
        <button class="icon-btn" data-del-region="${esc(r.id)}" title="حذف">🗑️</button>
      </li>`
        )
        .join('')
    : `<li class="empty">هنوز محدوده‌ای دانلود نشده است</li>`;
}

/* =========================================================
   11. مدیریت نماها و رویدادهای رابط کاربری (UI)
   ========================================================= */
const VIEWS = ['home', 'search', 'place', 'route', 'report', 'saved', 'offline', 'settings', 'addplace'];
const viewEl = (name) => $(`#view${name.charAt(0).toUpperCase()}${name.slice(1)}`);

function openView(name) {
  VIEWS.forEach((v) => {
    const el = viewEl(v);
    if (el) el.classList.toggle('hidden', v !== name);
  });
  const sheet = $('#sheet');
  if (sheet) {
    if (name === 'addplace') sheet.dataset.state = 'full';
    else if (name === 'home') sheet.dataset.state = 'mid';
    else sheet.dataset.state = 'mid';
  }
  if ($('#sheetScroll')) $('#sheetScroll').scrollTop = 0;
  syncControlsForSheet(name);
  if (name === 'saved') renderSavedList();
  if (name === 'offline') {
    refreshOfflineEstimate();
    loadOfflineRegions();
  }
  if (name === 'report') renderReportTypes();
}

function syncControlsForSheet(name) {
  const bar = $('#mapControls');
  if (!bar) return;
  const show = ['home', 'search', 'place', 'route'].includes(name);
  bar.classList.toggle('hidden', !show);
}

function bindUI() {
  const searchInput = $('#searchInput');
  const debounced = debounce(() => {
    const t = searchInput.value.trim();
    if (t.length >= 2) doSearch(t);
  }, 320);

  searchInput?.addEventListener('input', () => {
    const active = searchInput.value.length > 0;
    document.getElementById('app')?.classList.toggle('search-active', active);
    $('#btnClearSearch')?.classList.toggle('hidden', !active);
    debounced();
  });
  searchInput?.addEventListener('focus', () => {
    const sheet = $('#sheet');
    if (sheet && sheet.dataset.state === 'peek') sheet.dataset.state = 'mid';
  });
  searchInput?.addEventListener('blur', () => {
    if (!searchInput.value) document.getElementById('app')?.classList.remove('search-active');
  });
  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      doSearch(searchInput.value.trim());
      searchInput.blur();
    }
  });
  on('#btnClearSearch', 'click', () => {
    searchInput.value = '';
    $('#btnClearSearch').classList.add('hidden');
    document.getElementById('app')?.classList.remove('search-active');
    app.activeCategoryFilter = null;
    $$('#quickCats .cat-chip').forEach((x) => x.classList.remove('is-on'));
    refreshViewportPois(null);
    openView('home');
  });

  // دکمه‌های شناور روی نقشه
  on('#btnLocate', 'click', goToMyLocation);
  on('#badgeGps', 'click', () => {
    startPickOnMap('my-location', 'تنظیم دقیق موقعیت فعلی من', 'روی محل دقیق حضور خود در نقشه ضربه بزنید');
  });
  on('#btnCompass', 'click', () => {
    app.map?.setBearing(0);
    app.map?.setPitch(0);
  });
  on('#btn3D', 'click', (e) => {
    const onState = e.currentTarget.getAttribute('aria-pressed') === 'true';
    e.currentTarget.setAttribute('aria-pressed', String(!onState));
    app.map?.setPitch(onState ? 0 : 55);
  });
  on('#btnLayers', 'click', openLayersModal);
  on('#btnAddPlaceFab', 'click', () => openAddPlaceView());
  on('#btnTheme', 'click', async () => {
    const cur =
      app.settings.theme === 'auto'
        ? document.documentElement.dataset.theme === 'dark'
          ? 'dark'
          : 'light'
        : app.settings.theme;
    const next = cur === 'dark' ? 'light' : 'dark';
    await saveSettings({ theme: next });
    applyTheme(next);
  });
  on('#btnProfile', 'click', openProfileModal);
  on('#btnBrandMenu', 'click', () => {
    openView('home');
    $('#sheet').dataset.state = 'mid';
  });
  on('#sheetHandle', 'click', () => {
    const s = $('#sheet').dataset.state;
    $('#sheet').dataset.state = s === 'peek' ? 'mid' : s === 'mid' ? 'full' : 'peek';
  });

  // نوار انتخاب نقطه روی نقشه (pickBar)
  on('#btnPickCancel', 'click', cancelPickMode);
  on('#btnPickConfirmCenter', 'click', () => {
    const c = app.map?.getCenter();
    if (c) onMapPicked({ lat: c.lat, lon: c.lng });
  });

  // هدایت صوتی و توقف مسیریابی
  on('#btnVoice', 'click', (e) => {
    const onState = e.currentTarget.getAttribute('aria-pressed') === 'true';
    e.currentTarget.setAttribute('aria-pressed', String(!onState));
    voice.configure({ enabled: !onState });
    toast(!onState ? 'راهنمای صوتی روشن شد' : 'راهنمای صوتی خاموش شد');
  });
  on('#btnStopNav', 'click', () => endNavigation(false));
  on('#btnStartNavMain', 'click', startNavigation);

  // کارت‌های صفحه اصلی
  on('#cardHome', 'click', () => {
    if (app.home) {
      setDest(app.home);
      openView('route');
    } else {
      toast('ابتدا مکان خانه را روی نقشه انتخاب و ذخیره کنید');
    }
  });
  on('#cardWork', 'click', () => {
    if (app.work) {
      setDest(app.work);
      openView('route');
    } else {
      toast('ابتدا محل کار را روی نقشه انتخاب و ذخیره کنید');
    }
  });
  on('#cardSaved', 'click', () => openView('saved'));
  on('#cardAddPlaceHome', 'click', () => openAddPlaceView());
  on('#cardExplorePois', 'click', () => {
    refreshViewportPois();
    toast('مغازه‌ها و مکان‌های این محدوده بروزرسانی شد ✓');
  });
  on('#cardReportHome', 'click', () => openView('report'));
  on('#cardOfflineHome', 'click', () => openView('offline'));
  on('#cardSettingsHome', 'click', () => openView('settings'));

  on('#btnRefreshPois', 'click', () => {
    app.activeCategoryFilter = null;
    $$('#quickCats .cat-chip').forEach((x) => x.classList.remove('is-on'));
    refreshViewportPois(null);
    toast('همه مغازه‌ها و مکان‌های این محدوده بارگذاری شد');
  });

  on('#btnClearHistory', 'click', async () => {
    await history.clear();
    loadHistory();
    toast('تاریخچه مسیرها پاک شد');
  });
  on('#btnHealth', 'click', renderHealth);

  // انتخاب مبدأ و مقصد در نمای مسیریابی
  on('#fieldOrigin', 'click', () => {
    startPickOnMap('origin', 'انتخاب مبدأ روی نقشه', 'روی نقطه شروع مسیر در نقشه ضربه بزنید یا دکمه تأیید مرکز نقشه را بزنید');
  });
  on('#fieldDest', 'click', () => {
    startPickOnMap('dest', 'انتخاب مقصد روی نقشه', 'روی مقصد موردنظر در نقشه ضربه بزنید یا دکمه تأیید مرکز نقشه را بزنید');
  });
  on('#btnUseMyLocOrigin', 'click', (e) => {
    e.stopPropagation();
    if (app.gps.last) {
      app.origin = null;
      $('#originValue').textContent = 'موقعیت فعلی من';
      if (app.dest) maybeComputeRoute();
    } else {
      goToMyLocation();
    }
  });
  on('#btnSwap', 'click', () => {
    const o = app.origin || getEffectiveOrigin();
    const d = app.dest;
    if (!d) return;
    app.origin = d;
    app.dest = o;
    $('#originValue').textContent = app.origin?.label || 'مبدأ';
    $('#destValue').textContent = app.dest?.label || 'مقصد';
    if (app.dest) maybeComputeRoute();
  });

  // شیوه سفر (خودرو، موتور، پیاده، دوچرخه، حمل‌ونقل)
  renderRouteModes();
  $$('#routeModes .mode-btn').forEach((b) =>
    b.addEventListener('click', () => {
      app.routeMode = b.dataset.mode;
      $$('#routeModes .mode-btn').forEach((x) => x.classList.toggle('is-on', x === b));
      saveSettings({ mode: b.dataset.mode });
      if (app.dest) maybeComputeRoute();
    })
  );

  // فرم ثبت / ویرایش مکان
  on('#btnPickAddPlaceLoc', 'click', () => {
    startPickOnMap('add-place', 'انتخاب موقعیت دقیق مغازه / مکان', 'نقشه را روی مغازه یا ساختمان موردنظر ببرید و ضربه بزنید');
  });
  on('#btnSubmitAddPlace', 'click', submitAddOrEditPlace);
  on('#btnCancelAddPlace', 'click', () => {
    if (app.lastPlace) openView('place');
    else openView('home');
  });
  $$('[data-hours-preset]').forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.hoursPreset;
      if (v === '24/7') {
        $('#apIs24h').checked = true;
        $('#apHours').value = 'شبانه‌روزی (۲۴ ساعته)';
      } else {
        $('#apIs24h').checked = false;
        $('#apHours').value = v;
      }
    })
  );

  // فرم ثبت نظر برای مکان
  on('#btnSubmitReview', 'click', submitPlaceReview);

  // گزارش مسیر
  on('#btnSubmitReport', 'click', submitReport);
  on('#btnPickReportLoc', 'click', () => {
    startPickOnMap('report', 'انتخاب محل گزارش روی نقشه');
  });

  // آفلاین
  on('#btnDownloadArea', 'click', downloadOfflineArea);
  on('#offlineZoom', 'change', refreshOfflineEstimate);
  on('#btnRefreshUsage', 'click', loadOfflineRegions);
  on('#offlineList', 'click', async (e) => {
    const id = e.target.closest('[data-del-region]')?.dataset.delRegion;
    if (id) {
      await regionStore.del(id);
      loadOfflineRegions();
      toast('محدوده حذف شد');
    }
  });

  // تنظیمات
  $$('#setTheme button').forEach((b) =>
    b.addEventListener('click', async () => {
      await saveSettings({ theme: b.dataset.v });
      applyTheme(b.dataset.v);
    })
  );
  $$('#setLang button').forEach((b) =>
    b.addEventListener('click', async () => {
      await saveSettings({ lang: b.dataset.v });
    })
  );
  $$('#setUnits button').forEach((b) =>
    b.addEventListener('click', async () => {
      await saveSettings({ units: b.dataset.v });
    })
  );
  $$('#setVoiceLead button').forEach((b) =>
    b.addEventListener('click', async () => {
      await saveSettings({ voiceLead: b.dataset.v });
    })
  );
  $$('#setMode button').forEach((b) =>
    b.addEventListener('click', async () => {
      await saveSettings({ mode: b.dataset.v });
      app.routeMode = b.dataset.v;
    })
  );
  on('#setVoice', 'change', async (e) => saveSettings({ voice: e.target.checked }));
  on('#setAutoReroute', 'change', async (e) => saveSettings({ autoReroute: e.target.checked }));
  on('#setAlertsSpeed', 'change', async (e) => {
    await saveSettings({ alertsSpeed: e.target.checked });
    applyAlertFilters();
  });
  on('#setAlertsBump', 'change', async (e) => {
    await saveSettings({ alertsBump: e.target.checked });
    applyAlertFilters();
  });
  on('#setAlertsUser', 'change', async (e) => {
    await saveSettings({ alertsUser: e.target.checked });
    applyAlertFilters();
  });
  on('#setSaveHistory', 'change', async (e) => saveSettings({ saveHistory: e.target.checked }));
  on('#btnTestVoice', 'click', () =>
    voice.speak('تا سیصد متر دیگر به راست بپیچید و وارد خیابان ولیعصر شوید', { priority: 2 })
  );
  on('#btnClearTileCache', 'click', async () => {
    await tileStore.clear();
    toast('حافظه پنهان کاشی‌های نقشه پاک شد');
  });
  on('#btnSupport', 'click', (e) => {
    e.preventDefault();
    openSupportModal();
  });

  // دکمه‌های بازگشت به خانه در نماهای داخلی
  $$('[data-back-home]').forEach((b) =>
    b.addEventListener('click', () => {
      openView('home');
    })
  );

  // دکمه‌های عملیات کارت مکان (Place Actions)
  $$('.action-btn').forEach((b) =>
    b.addEventListener('click', () => onPlaceAction(b.dataset.placeAction))
  );

  window.addEventListener('online', () => {
    if ($('#badgeOffline')) $('#badgeOffline').hidden = true;
  });
  window.addEventListener('offline', () => {
    if ($('#badgeOffline')) $('#badgeOffline').hidden = false;
  });
}

function renderRouteModes() {
  const modes = [
    ['auto', '🚗', 'خودرو'],
    ['motorcycle', '🏍️', 'موتور'],
    ['pedestrian', '🚶', 'پیاده'],
    ['bicycle', '🚲', 'دوچرخه'],
    ['transit', '🚌', 'حمل‌ونقل'],
  ];
  $('#routeModes').innerHTML = modes
    .map(
      ([m, e, l]) => `
      <button class="mode-btn ${m === app.routeMode ? 'is-on' : ''}" data-mode="${m}">
        <span class="emoji">${e}</span>
        <span>${l}</span>
      </button>`
    )
    .join('');
}

async function openProfileModal() {
  if (!app.supabase) {
    modal(`
      <h2 class="view-title">حساب کاربری راهین</h2>
      <p class="muted">مکان‌های جدید و نظرات شما به‌صورت مستقیم در دیتابیس ابری راهین ذخیره می‌شوند.</p>
      <div style="margin-top:14px"><button class="btn btn-primary btn-block" data-close>بستن</button></div>
    `);
    return;
  }
  if (!app.session) {
    openAuthModal();
    return;
  }
  modal(`
    <h2 class="view-title">حساب کاربری شما</h2>
    <p>${esc(app.session.user.email || 'کاربر راهین')}</p>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-ghost" data-close>بستن</button>
      <button class="btn btn-danger" id="modalLogout">خروج از حساب</button>
    </div>
  `);
  $('#modalLogout')?.addEventListener('click', async () => {
    await app.supabase.auth.signOut();
    closeModal();
    toast('از حساب خارج شدید');
  });
}

function openAuthModal() {
  modal(`
    <h2 class="view-title">ورود / ثبت‌نام در راهین</h2>
    <p class="muted small">ثبت مکان جدید و نظرات بدون نیاز به ورود هم فعال است. برای همگام‌سازی شخصی وارد شوید.</p>
    <div style="display:flex;flex-direction:column;gap:8px;margin:12px 0">
      <input id="authEmail" type="email" class="input" placeholder="ایمیل" dir="ltr" />
      <input id="authPass" type="password" class="input" placeholder="رمز عبور (حداقل ۶ کاراکتر)" dir="ltr" />
      <p id="authMsg" class="alert-box is-error hidden"></p>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary" id="btnLogin" style="flex:1">ورود</button>
      <button class="btn btn-ghost" id="btnSignup" style="flex:1">ثبت‌نام</button>
      <button class="btn btn-ghost" data-close>بستن</button>
    </div>
  `);
  const doAuth = async (mode) => {
    const email = $('#authEmail').value.trim();
    const pass = $('#authPass').value;
    const msg = $('#authMsg');
    msg.classList.add('hidden');
    if (!email || !pass) {
      msg.textContent = 'ایمیل و رمز عبور را وارد کنید';
      msg.classList.remove('hidden');
      return;
    }
    const { error } =
      mode === 'login'
        ? await app.supabase.auth.signInWithPassword({ email, password: pass })
        : await app.supabase.auth.signUp({ email, password: pass });
    if (error) {
      msg.textContent = error.message;
      msg.classList.remove('hidden');
    } else {
      closeModal();
      toast(mode === 'login' ? 'خوش آمدید ✓' : 'ثبت‌نام با موفقیت انجام شد ✓');
    }
  };
  $('#btnLogin')?.addEventListener('click', () => doAuth('login'));
  $('#btnSignup')?.addEventListener('click', () => doAuth('signup'));
}

async function openLayersModal() {
  const showPois = app.settings.showPois !== false;
  const showAlerts = app.map?.layersOn?.alerts !== false;
  modal(`
    <h2 class="view-title">لایه‌ها و ابزارهای نقشه</h2>
    <div class="settings-group">
      <div class="setting-row">
        <span>🏪 نمایش همه مغازه‌ها و مکان‌ها روی نقشه</span>
        <label class="switch"><input type="checkbox" id="lyPois" ${showPois ? 'checked' : ''} /><span></span></label>
      </div>
      <div class="setting-row">
        <span>⚠️ هشدارهای مسیر (دوربین سرعت، ترافیک، پلیس)</span>
        <label class="switch"><input type="checkbox" id="lyAlerts" ${showAlerts ? 'checked' : ''} /><span></span></label>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">
      <button class="btn btn-primary btn-block" id="btnModalAddPlace">➕ ثبت مکان / مغازه جدید روی نقشه</button>
      <button class="btn btn-ghost btn-block" id="btnModalSetMyLoc">📍 تنظیم دستی موقعیت فعلی من روی نقشه</button>
      <button class="btn btn-ghost btn-block" data-close>بستن</button>
    </div>
  `);
  $('#lyPois')?.addEventListener('change', async (e) => {
    const onState = e.target.checked;
    await saveSettings({ showPois: onState });
    if (onState) refreshViewportPois();
    else app.map?.clearPois();
  });
  $('#lyAlerts')?.addEventListener('change', (e) => {
    if (e.target.checked) {
      app.map.layersOn.alerts = true;
      app.map.showAlerts(app.alerts || []);
    } else {
      app.map.layersOn.alerts = false;
      app.map?.clearAlerts();
    }
  });
  $('#btnModalAddPlace')?.addEventListener('click', () => {
    closeModal();
    openAddPlaceView();
  });
  $('#btnModalSetMyLoc')?.addEventListener('click', () => {
    closeModal();
    startPickOnMap('my-location', 'تنظیم دقیق موقعیت فعلی من', 'روی محل دقیق حضور خود در نقشه ضربه بزنید');
  });
}

function modal(html) {
  const m = $('#modal');
  $('#modalCard').innerHTML = html;
  m.classList.remove('hidden');
  $$('[data-close]', m).forEach((b) => b.addEventListener('click', closeModal));
  m.addEventListener(
    'click',
    (e) => {
      if (e.target === m) closeModal();
    },
    { once: true }
  );
}

function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modalCard').innerHTML = '';
}

function toast(text, isError = false) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = text;
  t.classList.toggle('is-error', isError);
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 3600);
}

async function onPlaceAction(action) {
  const place = app.lastPlace;
  if (!place) {
    toast('ابتدا مکانی را روی نقشه انتخاب کنید');
    return;
  }
  switch (action) {
    case 'route':
      setDest(place);
      openView('route');
      break;
    case 'origin':
      setOrigin(place);
      openView('route');
      break;
    case 'call':
      if (place.phone) {
        window.location.href = `tel:${place.phone}`;
      } else {
        openEditPlaceView(place);
        toast('شماره تماس این مکان را وارد و ذخیره کنید');
      }
      break;
    case 'edit':
      openEditPlaceView(place);
      break;
    case 'save':
      modal(`
        <h2 class="view-title">ذخیره «${esc(place.name || place.label)}»</h2>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">
          <button class="btn btn-primary btn-block" data-a="fav">⭐ افزودن به مکان‌های ذخیره‌شده</button>
          <button class="btn btn-ghost btn-block" data-a="home">🏠 تنظیم به‌عنوان خانه</button>
          <button class="btn btn-ghost btn-block" data-a="work">💼 تنظیم به‌عنوان محل کار</button>
          <button class="btn btn-ghost btn-block" data-close>انصراف</button>
        </div>
      `);
      $$('#modalCard [data-a]').forEach((b) =>
        b.addEventListener('click', async () => {
          if (b.dataset.a === 'fav') await toggleSavePlace(place);
          if (b.dataset.a === 'home') await setHome(place);
          if (b.dataset.a === 'work') await setWork(place);
          closeModal();
        })
      );
      break;
    case 'share': {
      const url = `${location.origin}/?lat=${Number(place.lat).toFixed(5)}&lon=${Number(place.lon).toFixed(5)}&name=${encodeURIComponent(
        place.name || place.label
      )}`;
      if (navigator.share) {
        navigator.share({ title: place.name || place.label, url }).catch(() => {});
      } else {
        navigator.clipboard?.writeText(url);
        toast('لینک مستقیم مکان کپی شد ✓');
      }
      break;
    }
    case 'report':
      app.reportLoc = place;
      $('#reportLocText').textContent = `مکان: ${place.name || place.label}`;
      openView('report');
      break;
  }
}

async function renderSavedList() {
  const all = await places.all();
  $('#savedList').innerHTML = all.length
    ? all
        .map(
          (p) => `
      <li class="list-item">
        <div class="li-icon">${p.emoji || '⭐'}</div>
        <div class="li-body">
          <span class="li-title">${esc(p.name || p.label)}</span>
          <span class="li-sub">${esc(p.address || '')}</span>
        </div>
        <div class="li-actions">
          <button class="btn btn-primary" style="height:34px;padding:0 12px" data-go="${esc(JSON.stringify(p))}">مسیریابی</button>
          <button class="icon-btn" data-del="${esc(p.id)}">🗑️</button>
        </div>
      </li>`
        )
        .join('')
    : '';
  $('#savedEmpty').classList.toggle('hidden', all.length > 0);
  $$('#savedList [data-go]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = JSON.parse(b.dataset.go);
      setDest(p);
      openView('route');
    })
  );
  $$('#savedList [data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      await places.del(b.dataset.del);
      renderSavedList();
      loadSavedCounts();
    })
  );
}

function openSupportModal() {
  modal(`
    <h2 class="view-title">درباره راهین</h2>
    <p class="muted">نسخه ${VERSION} • سامانه جامع نقشه، جستجوی تمام اصناف و مغازه‌ها و مسیریاب هوشمند فارسی</p>
    <p class="small muted" style="margin-top:8px">مجهز به موتور برداری MapLibre GL، مسیریاب چندحالته Valhalla/OSRM، جستجوی زنده Overpass/Photon/Nominatim و پایگاه داده ابری Supabase.</p>
    <div style="margin-top:14px"><button class="btn btn-primary btn-block" data-close>بستن</button></div>
  `);
}

/* =========================================================
   12. سلامت سرویس‌ها
   ========================================================= */
async function renderHealth() {
  const el = $('#healthList');
  if (!el) return;
  el.innerHTML = `<li class="empty small">در حال بررسی وضعیت سرویس‌ها…</li>`;
  try {
    const h = await API('/api/health?deep=1');
    el.innerHTML = (h.services || [])
      .map(
        (s) => `
      <li class="list-item">
        <div class="li-body">
          <span class="li-title"><span class="${s.ok ? 'dot-ok' : 'dot-bad'}"></span>${esc(healthName(s.name))}</span>
          <span class="li-sub">${s.ok ? `${esc(s.detail || 'سالم')} (${faNum(s.ms)} میلی‌ثانیه)` : `خطا: ${esc(s.error || '')}`}</span>
        </div>
      </li>`
      )
      .join('');
  } catch {
    el.innerHTML = `<li class="list-item"><span class="dot-bad"></span>سرور در حالت آفلاین است</li>`;
  }
}

function healthName(n) {
  return (
    {
      tiles: 'کاشی‌های برداری نقشه (OpenFreeMap)',
      routing: 'موتور مسیریابی (Valhalla + OSRM)',
      search: 'موتور جستجو و اصناف (Photon + Overpass)',
      database: 'پایگاه داده ابری مکان‌ها (Supabase)',
    }[n] || n
  );
}

/* =========================================================
   13. دسته‌بندی سریع اصناف و مکان‌ها
   ========================================================= */
function renderQuickCategories() {
  const el = $('#quickCats');
  if (!el) return;
  el.innerHTML = PLACE_CATEGORIES_LIST.map(
    (c) => `
    <button class="cat-chip" data-cat="${esc(c.slug)}">
      <span class="emoji">${c.emoji}</span>
      <span>${esc(c.label)}</span>
    </button>`
  ).join('');

  $$('#quickCats .cat-chip').forEach((b) =>
    b.addEventListener('click', () => {
      const slug = b.dataset.cat;
      const alreadyOn = b.classList.contains('is-on');
      $$('#quickCats .cat-chip').forEach((x) => x.classList.remove('is-on'));
      if (alreadyOn) {
        app.activeCategoryFilter = null;
        refreshViewportPois(null);
        return;
      }
      b.classList.add('is-on');
      app.activeCategoryFilter = slug;
      const cat = PLACE_CATEGORIES_LIST.find((c) => c.slug === slug);
      refreshViewportPois(slug);
      doSearch(cat?.label || slug, { category: slug });
      $('#sheet').dataset.state = 'mid';
    })
  );
}

/* =========================================================
   14. شروع برنامه و پشتیبانی از لینک اشتراک‌گذاری
   ========================================================= */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => reg.update().catch(() => {}))
      .catch(() => {});
  });
}

document.addEventListener('DOMContentLoaded', boot);

const params = new URLSearchParams(location.search);
if (params.get('lat') && params.get('lon')) {
  window.addEventListener('load', () => {
    setTimeout(async () => {
      const lat = Number(params.get('lat'));
      const lon = Number(params.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      app.map?.showPickMarker(lat, lon);
      app.map?.flyTo(lat, lon, { zoom: 16 });
      const place = { lat, lon, name: params.get('name') || 'مکان اشتراک‌گذاری‌شده', label: params.get('name') || 'مکان اشتراک‌گذاری‌شده' };
      loadPlaceCard(place, { mode: 'share' });
    }, 1200);
  });
} else if (params.get('action') === 'add-place') {
  window.addEventListener('load', () => {
    setTimeout(() => openAddPlaceView(), 1200);
  });
}
