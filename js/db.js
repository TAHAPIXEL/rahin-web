// RAHIN — ذخیره‌سازی محلی (IndexedDB) برای مکان‌ها، تاریخچه، تنظیمات و کاشی‌های آفلاین
const DB_NAME = 'rahin-db';
const DB_VERSION = 1;

let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('places')) db.createObjectStore('places', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('searchHistory')) db.createObjectStore('searchHistory', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('tiles')) db.createObjectStore('tiles');
      if (!db.objectStoreNames.contains('regions')) db.createObjectStore('regions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('alertsCache')) db.createObjectStore('alertsCache');
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode = 'readonly') {
  return openDB().then((db) => db.transaction(store, mode).objectStore(store));
}

function p(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export const kv = {
  async get(key, fallback = null) {
    try {
      const s = await tx('kv');
      const v = await p(s.get(key));
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  },
  async set(key, value) {
    try {
      const s = await tx('kv', 'readwrite');
      return await p(s.put(value, key));
    } catch {
      return null;
    }
  },
  async del(key) {
    try {
      const s = await tx('kv', 'readwrite');
      return await p(s.delete(key));
    } catch {
      return null;
    }
  },
};

export const places = {
  async all() {
    try {
      const s = await tx('places');
      return await p(s.getAll());
    } catch {
      return [];
    }
  },
  async put(place) {
    const s = await tx('places', 'readwrite');
    place.updatedAt = Date.now();
    return p(s.put(place));
  },
  async del(id) {
    const s = await tx('places', 'readwrite');
    return p(s.delete(id));
  },
};

export const history = {
  async add(entry) {
    try {
      const s = await tx('history', 'readwrite');
      return await p(s.add({ ...entry, at: Date.now() }));
    } catch {
      return null;
    }
  },
  async recent(limit = 12) {
    try {
      const s = await tx('history');
      const all = await p(s.getAll());
      return all.sort((a, b) => b.at - a.at).slice(0, limit);
    } catch {
      return [];
    }
  },
  async clear() {
    const s = await tx('history', 'readwrite');
    return p(s.clear());
  },
};

export const searchHistory = {
  async add(term, result) {
    if (!term || term.length < 2) return;
    try {
      const s = await tx('searchHistory', 'readwrite');
      const all = await p(s.getAll());
      const dup = all.find((x) => x.term === term);
      if (dup) {
        const s2 = await tx('searchHistory', 'readwrite');
        s2.delete(dup.id);
      }
      const s3 = await tx('searchHistory', 'readwrite');
      await p(s3.add({ term, result, at: Date.now() }));
    } catch {
      // ignore
    }
  },
  async recent(limit = 6) {
    try {
      const s = await tx('searchHistory');
      const all = await p(s.getAll());
      return all.sort((a, b) => b.at - a.at).slice(0, limit);
    } catch {
      return [];
    }
  },
  async clear() {
    const s = await tx('searchHistory', 'readwrite');
    return p(s.clear());
  },
};

export const tiles = {
  async get(key) {
    const s = await tx('tiles');
    return p(s.get(key));
  },
  async set(key, blob) {
    const s = await tx('tiles', 'readwrite');
    return p(s.put(blob, key));
  },
  async count() {
    const s = await tx('tiles');
    return p(s.count());
  },
  async clear() {
    const s = await tx('tiles', 'readwrite');
    return p(s.clear());
  },
};

export const regions = {
  async all() {
    try {
      const s = await tx('regions');
      return await p(s.getAll());
    } catch {
      return [];
    }
  },
  async put(r) {
    const s = await tx('regions', 'readwrite');
    return p(s.put(r));
  },
  async del(id) {
    const s = await tx('regions', 'readwrite');
    return p(s.delete(id));
  },
};

export const alertsCache = {
  async get(key) {
    try {
      const s = await tx('alertsCache');
      const v = await p(s.get(key));
      if (!v) return null;
      if (Date.now() - v.at > 5 * 60 * 1000) return null;
      return v.data;
    } catch {
      return null;
    }
  },
  async set(key, data) {
    try {
      const s = await tx('alertsCache', 'readwrite');
      return await p(s.put({ data, at: Date.now() }, key));
    } catch {
      return null;
    }
  },
};
