// RAHIN — موتور نقشه پیشرفته (MapLibre GL v5 + پشتیبانی کامل متن فارسی RTL + لایه زنده مغازه‌ها و مکان‌ها + مسیر و موقعیت دقیق)

const OFM = {
  light: 'https://tiles.openfreemap.org/styles/bright',
  dark: 'https://tiles.openfreemap.org/styles/dark',
  liberty: 'https://tiles.openfreemap.org/styles/liberty',
};

export class MapEngine {
  constructor(container, { onPick, onPoiClick, onMoveEnd, onReady } = {}) {
    this.container = container;
    this.onPick = onPick;
    this.onPoiClick = onPoiClick;
    this.onMoveEnd = onMoveEnd;
    this.onReady = onReady;
    this.map = null;
    this.styleKey = 'light';
    this.pickMode = false;
    this.layersOn = { traffic: false, alerts: true, pois: true };
    this._pickMarker = null;
    this._originMarker = null;
    this._destMarker = null;
    this._routeGeoJSON = { main: null, alts: [] };
    this._userMarker = null;
    this._userPos = null;
    this._alerts = [];
    this._pois = [];
    this._heading = 0;
  }

  async init({ center = [51.389, 35.6892], zoom = 13.5, styleKey = 'light', rtlPluginUrl } = {}) {
    if (!window.maplibregl) throw new Error('MapLibre GL بارگذاری نشد');
    this.styleKey = styleKey;

    // اصلاح اساسی باگ متن برعکس فارسی در MapLibre v5:
    // ۱) getRTLTextPluginStatus پیش از بارگذاری مقدار 'unavailable' برمی‌گرداند (نه falsy!)
    // ۲) به خاطر اجرای وُرکر از روی blob:، آدرس پلاگین باید حتماً مطلق (https/http) باشد
    // ۳) در MapLibre v5 آرگومان دوم lazy (boolean) است و خروجی Promise است
    const rtlStatus = window.maplibregl.getRTLTextPluginStatus?.();
    if (!rtlStatus || rtlStatus === 'unavailable') {
      const absUrl = new URL(rtlPluginUrl || '/vendor/mapbox-gl-rtl-text.js', window.location.origin).href;
      try {
        await window.maplibregl.setRTLTextPlugin(absUrl, false);
      } catch (e) {
        console.warn('Primary RTL plugin load warning:', e);
        try {
          await window.maplibregl.setRTLTextPlugin(
            'https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.2.3/mapbox-gl-rtl-text.min.js',
            false
          );
        } catch (e2) {
          console.warn('Fallback RTL plugin warning:', e2);
        }
      }
    }

    this.map = new window.maplibregl.Map({
      container: this.container,
      style: OFM[styleKey] || OFM.light,
      center,
      zoom,
      attributionControl: false,
      dragRotate: true,
      pitchWithRotate: true,
      touchZoomRotate: true,
      maxZoom: 20,
      minZoom: 3,
      antialias: true,
      fadeDuration: 120,
      locale: {
        'NavigationControl.ZoomIn': 'بزرگ‌نمایی',
        'NavigationControl.ZoomOut': 'کوچک‌نمایی',
        'ScaleControl.Meters': 'متر',
        'ScaleControl.Kilometers': 'کیلومتر',
      },
    });

    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      this.map.on('load', finish);
      setTimeout(finish, 5500);
    });

    this._enhanceMapPersianAndPois();

    this.map.addControl(
      new window.maplibregl.AttributionControl({ compact: true, customAttribution: '© راهین • OpenStreetMap' }),
      'bottom-left'
    );
    this.map.addControl(new window.maplibregl.ScaleControl({ maxWidth: 90, unit: 'metric' }), 'bottom-left');

    // کلیک روی نقشه: پشتیبانی کامل از کلیک عادی، کلیک روی مغازه‌ها/POIها و حالت انتخاب نقطه (pickMode)
    this.map.on('click', (e) => {
      const lat = e.lngLat.lat;
      const lon = e.lngLat.lng;

      if (this.pickMode) {
        this.onPick?.({ lat, lon, lng: lon, mode: 'pick' });
        return;
      }

      // ۱) بررسی کلیک روی لایه مغازه‌ها و مکان‌های راهین (rahin-pois-layer)
      if (this.map.getLayer('rahin-pois-circle') || this.map.getLayer('rahin-pois-label')) {
        const poiLayers = ['rahin-pois-circle', 'rahin-pois-label'].filter((id) => this.map.getLayer(id));
        const hitPois = this.map.queryRenderedFeatures(e.point, { layers: poiLayers });
        if (hitPois?.length) {
          const f = hitPois[0];
          const [fLon, fLat] = f.geometry?.coordinates || [lon, lat];
          let parsed = null;
          try {
            parsed = f.properties?.raw ? JSON.parse(f.properties.raw) : f.properties;
          } catch {
            parsed = f.properties;
          }
          if (this.onPoiClick && parsed) {
            this.onPoiClick({ ...parsed, lat: Number(fLat), lon: Number(fLon) });
            return;
          }
        }
      }

      // ۲) بررسی کلیک روی لایه هشدارها
      if (this.map.getLayer('alerts-layer')) {
        const hitAlerts = this.map.queryRenderedFeatures(e.point, { layers: ['alerts-layer'] });
        if (hitAlerts?.length) {
          this.onAlertClick?.(hitAlerts[0].properties);
          return;
        }
      }

      // ۳) بررسی کلیک روی مسیر جایگزین
      if (this.map.getLayer('route-alt-line')) {
        const hitAlt = this.map.queryRenderedFeatures(e.point, { layers: ['route-alt-line', 'route-alt-casing'].filter((id) => this.map.getLayer(id)) });
        if (hitAlt?.length && this.onAltRouteClick) {
          const altIdx = Number(hitAlt[0].properties?.altIndex ?? 0);
          this.onAltRouteClick(altIdx);
          return;
        }
      }

      // ۴) بررسی کلیک روی POIهای وکتور خود نقشه پایه (مغازه‌ها، بیمارستان‌ها، مدارس، بانک‌ها و...)
      let basePoi = null;
      try {
        const features = this.map.queryRenderedFeatures(e.point);
        const poiFeat = features.find(
          (f) =>
            f.sourceLayer === 'poi' ||
            (f.properties && (f.properties['name:fa'] || f.properties.name) && (f.properties.class || f.properties.subclass))
        );
        if (poiFeat) {
          const p = poiFeat.properties || {};
          const pCoords =
            poiFeat.geometry?.type === 'Point' && Array.isArray(poiFeat.geometry.coordinates)
              ? { lon: poiFeat.geometry.coordinates[0], lat: poiFeat.geometry.coordinates[1] }
              : { lon, lat };
          basePoi = {
            name: p['name:fa'] || p['name:nonlatin'] || p.name || p['name:en'] || '',
            name_en: p['name:en'] || p['name:latin'] || '',
            category: p.subclass || p.class || '',
            lat: pCoords.lat,
            lon: pCoords.lon,
          };
        }
      } catch {
        // ignore queryRenderedFeatures errors
      }

      this.onPick?.({
        lat: basePoi?.lat ?? lat,
        lon: basePoi?.lon ?? lon,
        lng: basePoi?.lon ?? lon,
        basePoi,
      });
    });

    this.map.on('moveend', () => {
      this.onMoveEnd?.({
        center: this.map.getCenter(),
        zoom: this.map.getZoom(),
        bearing: this.map.getBearing(),
        pitch: this.map.getPitch(),
      });
    });

    this.map.on('rotate', () => {
      this.onCompass?.(this.map.getBearing());
    });

    this.onReady?.();
  }

  /** اولویت‌بندی نام فارسی در تمام لایه‌های متنی نقشه و نمایش بهتر POIها */
  _enhanceMapPersianAndPois() {
    if (!this.map) return;
    try {
      const style = this.map.getStyle();
      if (!style?.layers) return;
      for (const layer of style.layers) {
        if (layer.type === 'symbol' && layer.layout && layer.layout['text-field']) {
          // اولویت دادن به نام فارسی برای تمام خیابان‌ها، محله‌ها، شهرها و مغازه‌ها
          try {
            this.map.setLayoutProperty(layer.id, 'text-field', [
              'coalesce',
              ['get', 'name:fa'],
              ['get', 'name:nonlatin'],
              ['get', 'name'],
              ['get', 'name:en'],
              ['get', 'name:latin'],
            ]);
          } catch {
            // برخی لایه‌ها مثل شماره‌گذاری بزرگراه ساختار متفاوتی دارند
          }
          // نمایش مغازه‌ها و POIهای نقشه از زوم پایین‌تر
          if (layer.id.includes('poi') && layer.minzoom && layer.minzoom > 13) {
            try {
              this.map.setLayerZoomRange(layer.id, 13, layer.maxzoom || 24);
            } catch { /* ignore */ }
          }
        }
      }
    } catch (e) {
      console.debug('Style enhancement skipped:', e);
    }
  }

  async setStyle(styleKey) {
    if (!this.map || styleKey === this.styleKey) return;
    this.styleKey = styleKey;
    const center = this.map.getCenter();
    const zoom = this.map.getZoom();
    const bearing = this.map.getBearing();
    const pitch = this.map.getPitch();
    this.map.setStyle(OFM[styleKey] || OFM.light);
    await new Promise((r) => {
      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; r(); } };
      this.map.once('style.load', done);
      setTimeout(done, 2500);
    });
    this.map.jumpTo({ center, zoom, bearing, pitch });
    this._enhanceMapPersianAndPois();
    this._restoreAllOverlays();
  }

  _restoreAllOverlays() {
    if (this._userPos) {
      this._updateAccuracyCircle(this._userPos.lat, this._userPos.lon, this._userPos.accuracy);
    }
    if (this._routeGeoJSON.main) this._renderRouteLayers();
    if (this.layersOn.traffic) this.enableTraffic(true);
    if (this.layersOn.alerts && this._alerts?.length) this.showAlerts(this._alerts);
    if (this.layersOn.pois && this._pois?.length) this.showPois(this._pois);
  }

  setPickMode(on) {
    this.pickMode = Boolean(on);
    if (this.map) {
      this.map.getCanvas().style.cursor = on ? 'crosshair' : '';
    }
  }

  showPickMarker(lat, lon, { pan = true } = {}) {
    const nLat = Number(lat);
    const nLon = Number(lon);
    if (!this.map || !Number.isFinite(nLat) || !Number.isFinite(nLon)) return;
    const el = document.createElement('div');
    el.className = 'pin-marker';
    el.innerHTML = `
      <div class="pin-marker-inner">
        <svg viewBox="0 0 36 46" fill="none" xmlns="http://www.w3.org/2000/svg">
          <ellipse cx="18" cy="43" rx="7" ry="2.5" fill="rgba(0,0,0,0.28)"/>
          <path d="M18 2C9.716 2 3 8.716 3 17c0 11.25 13.1 23.4 14.1 24.3a1.4 1.4 0 0 0 1.8 0C19.9 40.4 33 28.25 33 17c0-8.284-6.716-15-15-15Z" fill="#e11d48" stroke="#ffffff" stroke-width="2.5"/>
          <circle cx="18" cy="17" r="6" fill="#ffffff"/>
        </svg>
      </div>
    `;
    if (this._pickMarker) this._pickMarker.remove();
    this._pickMarker = new window.maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([nLon, nLat])
      .addTo(this.map);
    if (pan) {
      this.map.easeTo({ center: [nLon, nLat], offset: [0, -70], duration: 500 });
    }
  }

  clearPickMarker() {
    if (this._pickMarker) {
      this._pickMarker.remove();
      this._pickMarker = null;
    }
  }

  /* ------------------------- user location ------------------------- */

  updateUserLocation(lat, lon, { heading = null, accuracy = null, follow = false, zoom = null } = {}) {
    const nLat = Number(lat);
    const nLon = Number(lon);
    if (!this.map || !Number.isFinite(nLat) || !Number.isFinite(nLon)) return;
    this._userPos = { lat: nLat, lon: nLon, heading, accuracy };

    if (!this._userMarker) {
      const el = document.createElement('div');
      el.className = 'user-dot';
      el.innerHTML = `
        <div class="user-dot-wrap">
          <div class="user-dot-beam"></div>
          <div class="user-dot-halo"></div>
          <div class="user-dot-core"></div>
        </div>
      `;
      this._userMarker = new window.maplibregl.Marker({
        element: el,
        anchor: 'center',
        pitchAlignment: 'map',
        rotationAlignment: 'map',
      })
        .setLngLat([nLon, nLat])
        .addTo(this.map);
    } else {
      this._userMarker.setLngLat([nLon, nLat]);
    }

    const el = this._userMarker.getElement();
    if (heading != null && Number.isFinite(heading)) {
      el.classList.add('has-heading');
      this._heading = heading;
      const beam = el.querySelector('.user-dot-beam');
      if (beam) beam.style.transform = `translate(-50%, -50%) rotate(${heading}deg)`;
    } else {
      el.classList.remove('has-heading');
    }

    this._updateAccuracyCircle(nLat, nLon, accuracy);

    if (follow) {
      this.map.easeTo({
        center: [nLon, nLat],
        ...(zoom ? { zoom } : {}),
        duration: 600,
      });
    }
  }

  _updateAccuracyCircle(lat, lon, accuracy) {
    if (!this.map || !this.map.isStyleLoaded()) return;
    // محدود کردن شعاع نمایشی هاله دقت به حداکثر ۱۲۰ متر تا دایره غول‌پیکر روی نقشه ایجاد نشود
    const radiusM = accuracy && Number.isFinite(accuracy) ? Math.min(Math.max(accuracy, 12), 120) : 25;
    const poly = createGeoJSONCircle([lon, lat], radiusM, 48);
    if (!this.map.getSource('user-accuracy')) {
      this.map.addSource('user-accuracy', { type: 'geojson', data: poly });
      this.map.addLayer({
        id: 'user-accuracy-fill',
        type: 'fill',
        source: 'user-accuracy',
        paint: { 'fill-color': '#1a73e8', 'fill-opacity': 0.12 },
      });
      this.map.addLayer({
        id: 'user-accuracy-stroke',
        type: 'line',
        source: 'user-accuracy',
        paint: { 'line-color': '#1a73e8', 'line-width': 1.2, 'line-opacity': 0.35 },
      });
    } else {
      this.map.getSource('user-accuracy').setData(poly);
    }
  }

  clearUserLocation() {
    if (this._userMarker) {
      this._userMarker.remove();
      this._userMarker = null;
    }
    this._userPos = null;
    if (this.map?.getLayer('user-accuracy-fill')) this.map.removeLayer('user-accuracy-fill');
    if (this.map?.getLayer('user-accuracy-stroke')) this.map.removeLayer('user-accuracy-stroke');
    if (this.map?.getSource('user-accuracy')) this.map.removeSource('user-accuracy');
  }

  setCompassCallback(cb) {
    this.onCompass = cb;
  }

  flyTo(lat, lon, { zoom = 15.5, offsetY = -50, duration = 750 } = {}) {
    const nLat = Number(lat);
    const nLon = Number(lon);
    if (!this.map || !Number.isFinite(nLat) || !Number.isFinite(nLon)) return;
    this.map.flyTo({ center: [nLon, nLat], zoom, offset: [0, offsetY], duration });
  }

  /* ------------------------- routes ------------------------- */

  showRoute(route, alternatives = []) {
    if (!this.map || !route?.geometry?.length) return;
    this._routeGeoJSON.main = route;
    this._routeGeoJSON.alts = alternatives || [];
    this._renderRouteLayers();
    this._renderRouteEndpointMarkers(route);
    this.fitRoute(route);
  }

  _renderRouteEndpointMarkers(route) {
    if (!this.map || !route?.geometry?.length) return;
    const start = route.geometry[0];
    const end = route.geometry[route.geometry.length - 1];

    if (this._originMarker) this._originMarker.remove();
    if (this._destMarker) this._destMarker.remove();

    const originEl = document.createElement('div');
    originEl.className = 'route-endpoint-marker origin-pin';
    originEl.innerHTML = `<div class="ep-badge ep-origin"><span>مبدأ</span></div>`;
    this._originMarker = new window.maplibregl.Marker({ element: originEl, anchor: 'center' })
      .setLngLat([start[1], start[0]])
      .addTo(this.map);

    const destEl = document.createElement('div');
    destEl.className = 'route-endpoint-marker dest-pin';
    destEl.innerHTML = `
      <div class="ep-dest-wrap">
        <span class="ep-dest-label">مقصد</span>
        <svg viewBox="0 0 32 40" width="30" height="38">
          <path d="M16 2C8.8 2 3 7.8 3 15c0 9.6 11.4 20.4 12.2 21.1a1.2 1.2 0 0 0 1.6 0C17.6 35.4 29 24.6 29 15c0-7.2-5.8-13-13-13Z" fill="#0f9e95" stroke="#fff" stroke-width="2.5"/>
          <circle cx="16" cy="15" r="5.5" fill="#fff"/>
        </svg>
      </div>
    `;
    this._destMarker = new window.maplibregl.Marker({ element: destEl, anchor: 'bottom' })
      .setLngLat([end[1], end[0]])
      .addTo(this.map);
  }

  clearRoutes() {
    this._routeGeoJSON = { main: null, alts: [] };
    if (this._originMarker) {
      this._originMarker.remove();
      this._originMarker = null;
    }
    if (this._destMarker) {
      this._destMarker.remove();
      this._destMarker = null;
    }
    if (!this.map) return;
    for (const id of ['route-main-arrows', 'route-main-line', 'route-main-casing', 'route-alt-line', 'route-alt-casing']) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
    }
    for (const src of ['route-main', 'route-alt']) {
      if (this.map.getSource(src)) this.map.removeSource(src);
    }
  }

  _renderRouteLayers() {
    if (!this.map) return;
    const { main, alts } = this._routeGeoJSON;

    // ۱) ابتدا مسیرهای جایگزین رسم می‌شوند تا زیر مسیر اصلی قرار بگیرند
    const altFeatures = (alts || [])
      .filter((r) => r?.geometry?.length)
      .map((r, idx) => routeFeature(r, { altIndex: idx + 1 }));
    const altData = { type: 'FeatureCollection', features: altFeatures };

    if (!this.map.getSource('route-alt')) {
      this.map.addSource('route-alt', { type: 'geojson', data: altData });
    } else {
      this.map.getSource('route-alt').setData(altData);
    }

    if (!this.map.getLayer('route-alt-casing')) {
      this.map.addLayer({
        id: 'route-alt-casing',
        type: 'line',
        source: 'route-alt',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#334155', 'line-width': 9, 'line-opacity': 0.5 },
      });
    }
    if (!this.map.getLayer('route-alt-line')) {
      this.map.addLayer({
        id: 'route-alt-line',
        type: 'line',
        source: 'route-alt',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#94a3b8', 'line-width': 5.5, 'line-opacity': 0.85 },
      });
    }

    // ۲) مسیر اصلی: ابتدا حاشیه تیره (casing) و سپس خط درخشان مسیر روی آن!
    if (main?.geometry?.length) {
      const mainData = routeFeature(main, { part: 'rest' });
      if (!this.map.getSource('route-main')) {
        this.map.addSource('route-main', { type: 'geojson', data: mainData });
      } else {
        this.map.getSource('route-main').setData(mainData);
      }

      if (!this.map.getLayer('route-main-casing')) {
        this.map.addLayer({
          id: 'route-main-casing',
          type: 'line',
          source: 'route-main',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#042f36', 'line-width': 11, 'line-opacity': 0.85 },
        });
      }
      if (!this.map.getLayer('route-main-line')) {
        // بدون beforeId تا دقیقاً روی route-main-casing قرار بگیرد!
        this.map.addLayer({
          id: 'route-main-line',
          type: 'line',
          source: 'route-main',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#0ea5e9', 'line-width': 6.5, 'line-opacity': 0.98 },
        });
      }
      if (!this.map.getLayer('route-main-arrows')) {
        this.map.addLayer({
          id: 'route-main-arrows',
          type: 'symbol',
          source: 'route-main',
          layout: {
            'symbol-placement': 'line',
            'symbol-spacing': 90,
            'text-field': '◀',
            'text-size': 12,
            'text-keep-upright': false,
            'text-rotation-alignment': 'map',
            'text-Rotate': 180,
          },
          paint: {
            'text-color': '#ffffff',
            'text-halo-color': '#0369a1',
            'text-halo-width': 1.2,
          },
        });
      }
    }
  }

  fitRoute(route, { paddingBottom = 280 } = {}) {
    if (!this.map || !route?.geometry?.length) return;
    const [lat0, lon0] = route.geometry[0];
    const bounds = new window.maplibregl.LngLatBounds([lon0, lat0], [lon0, lat0]);
    for (const [lat, lon] of route.geometry) {
      if (Number.isFinite(lat) && Number.isFinite(lon)) bounds.extend([lon, lat]);
    }
    const isDesktop = window.innerWidth >= 720;
    this.map.fitBounds(bounds, {
      padding: isDesktop
        ? { top: 90, bottom: 90, left: 460, right: 70 }
        : { top: 100, bottom: paddingBottom, left: 40, right: 40 },
      duration: 650,
      maxZoom: 16.5,
    });
  }

  /* ------------------------- live POIs & shops ------------------------- */

  showPois(places = []) {
    this._pois = places;
    if (!this.map || !this.map.isStyleLoaded()) return;

    const features = (places || [])
      .filter((p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)))
      .map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [Number(p.lon), Number(p.lat)] },
        properties: {
          id: p.place_key || p.id,
          name: p.name || p.label || 'مکان',
          emoji: p.emoji || '📍',
          color: p.color || '#0f9e95',
          category_fa: p.category_fa || p.subcategory || '',
          label_full: `${p.emoji || '📍'} ${p.name || p.label}`,
          raw: JSON.stringify(p),
        },
      }));

    const data = { type: 'FeatureCollection', features };

    if (!this.map.getSource('rahin-pois')) {
      this.map.addSource('rahin-pois', { type: 'geojson', data });
      this.map.addLayer({
        id: 'rahin-pois-circle',
        type: 'circle',
        source: 'rahin-pois',
        minzoom: 11,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 5, 14, 8, 17, 11],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-opacity': 0.92,
        },
      });
      this.map.addLayer({
        id: 'rahin-pois-label',
        type: 'symbol',
        source: 'rahin-pois',
        minzoom: 12.2,
        layout: {
          'text-field': ['get', 'label_full'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 12, 11, 16, 13],
          'text-offset': [0, 1.15],
          'text-anchor': 'top',
          'text-max-width': 12,
          'text-optional': false,
        },
        paint: {
          'text-color': this.styleKey === 'dark' ? '#f1f5f9' : '#0f172a',
          'text-halo-color': this.styleKey === 'dark' ? '#0f172a' : '#ffffff',
          'text-halo-width': 2,
        },
      });
      this.map.on('mouseenter', 'rahin-pois-circle', () => {
        this.map.getCanvas().style.cursor = 'pointer';
      });
      this.map.on('mouseleave', 'rahin-pois-circle', () => {
        this.map.getCanvas().style.cursor = this.pickMode ? 'crosshair' : '';
      });
    } else {
      this.map.getSource('rahin-pois').setData(data);
    }
  }

  clearPois() {
    this._pois = [];
    if (this.map?.getSource('rahin-pois')) {
      this.map.getSource('rahin-pois').setData({ type: 'FeatureCollection', features: [] });
    }
  }

  /* ------------------------- traffic & alerts ------------------------- */

  async enableTraffic(on) {
    this.layersOn.traffic = on;
    if (!this.map) return;
    if (!on) {
      if (this.map.getLayer('traffic-raster')) this.map.removeLayer('traffic-raster');
      if (this.map.getSource('traffic')) this.map.removeSource('traffic');
      return;
    }
  }

  async showAlerts(alerts = []) {
    this._alerts = alerts;
    if (!this.map || !this.map.isStyleLoaded()) return;
    const features = (alerts || [])
      .filter((a) => Number.isFinite(Number(a.lat)) && Number.isFinite(Number(a.lon)))
      .map((a) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [Number(a.lon), Number(a.lat)] },
        properties: { ...a, icon: alertEmoji(a.type) },
      }));
    const data = { type: 'FeatureCollection', features };
    if (!this.map.getSource('alerts')) {
      this.map.addSource('alerts', { type: 'geojson', data });
      this.map.addLayer({
        id: 'alerts-layer',
        type: 'symbol',
        source: 'alerts',
        layout: {
          'text-field': ['get', 'icon'],
          'text-size': 18,
          'text-allow-overlap': true,
        },
        paint: { 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
      });
    } else {
      this.map.getSource('alerts').setData(data);
    }
  }

  clearAlerts() {
    this._alerts = [];
    if (this.map?.getSource('alerts')) {
      this.map.getSource('alerts').setData({ type: 'FeatureCollection', features: [] });
    }
  }

  /* ------------------------- offline helpers ------------------------- */

  estimateTiles(bbox, minZoom, maxZoom) {
    const lon2tile = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
    const lat2tile = (lat, z) =>
      Math.floor(
        ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) *
          2 ** z
      );
    let total = 0;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    for (let z = minZoom; z <= maxZoom; z++) {
      const x0 = lon2tile(minLon, z), x1 = lon2tile(maxLon, z);
      const y0 = lat2tile(maxLat, z), y1 = lat2tile(minLat, z);
      total += Math.max(0, (x1 - x0 + 1) * (y1 - y0 + 1));
    }
    return total;
  }

  tilesFor(bbox, minZoom, maxZoom) {
    const lon2tile = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
    const lat2tile = (lat, z) =>
      Math.floor(
        ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) *
          2 ** z
      );
    const out = [];
    const [minLon, minLat, maxLon, maxLat] = bbox;
    for (let z = minZoom; z <= maxZoom; z++) {
      const x0 = lon2tile(minLon, z), x1 = lon2tile(maxLon, z);
      const y0 = lat2tile(maxLat, z), y1 = lat2tile(minLat, z);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ z, x, y });
    }
    return out;
  }

  setBearing(bearing) {
    if (this.map) this.map.easeTo({ bearing, duration: 300 });
  }
  setPitch(pitch) {
    if (this.map) this.map.easeTo({ pitch, duration: 300 });
  }
  getCenter() {
    return this.map?.getCenter();
  }
  getZoom() {
    return this.map?.getZoom() ?? 13;
  }
  getBearing() {
    return this.map?.getBearing() ?? 0;
  }
  jumpTo(lat, lon, zoom) {
    if (this.map) this.map.jumpTo({ center: [lon, lat], zoom });
  }

  moveCameraForNavigation(lat, lon, bearing, { zoom = 16.2, pitch = 52 } = {}) {
    if (!this.map) return;
    this.map.easeTo({
      center: [lon, lat],
      bearing: bearing ?? 0,
      pitch,
      zoom,
      duration: 750,
      padding: { top: 0, bottom: 120, left: 0, right: 0 },
    });
  }
}

function routeFeature(route, props = {}) {
  return {
    type: 'Feature',
    properties: props,
    geometry: {
      type: 'LineString',
      coordinates: (route.geometry || []).map(([lat, lon]) => [lon, lat]),
    },
  };
}

function createGeoJSONCircle(center, radiusInMeters, points = 48) {
  const [lon, lat] = center;
  const km = radiusInMeters / 1000;
  const ret = [];
  const distanceX = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  const distanceY = km / 110.574;
  for (let i = 0; i < points; i++) {
    const theta = (i / points) * (2 * Math.PI);
    const x = distanceX * Math.cos(theta);
    const y = distanceY * Math.sin(theta);
    ret.push([lon + x, lat + y]);
  }
  ret.push(ret[0]);
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ret] },
      },
    ],
  };
}

export function alertEmoji(type) {
  return (
    {
      speed_camera: '📷',
      speed_bump: '🐢',
      roadwork: '🚧',
      closure: '⛔',
      traffic_light: '🚦',
      hazard: '⚠️',
      accident: '💥',
      congestion: '🚗',
      traffic: '🚗',
      police: '👮',
      flood: '🌊',
      other: '⚠️',
    }[type] || '⚠️'
  );
}

export const ALERT_LABELS_FA = {
  speed_camera: 'دوربین کنترل سرعت',
  speed_bump: 'سرعت‌گیر',
  roadwork: 'کارگاه جاده‌ای',
  closure: 'انسداد مسیر',
  traffic_light: 'چراغ راهنمایی',
  accident: 'تصادف',
  traffic: 'ترافیک سنگین',
  police: 'پلیس راهور',
  hazard: 'خطر جاده‌ای',
  other: 'هشدار مسیر',
};

export const OFM_STYLES = OFM;
