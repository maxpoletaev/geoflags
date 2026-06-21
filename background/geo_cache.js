const MAX_CACHE_ENTRIES = 1000;

let domainGeoCache = {};
let cacheFlushTimer = null;

async function loadDomainCache() {
  const { domainGeoCache: saved } = await browser.storage.local.get("domainGeoCache");
  if (saved && typeof saved === "object") {
    domainGeoCache = saved;
    evictOldEntries();
  }
}

function evictOldEntries() {
  const keys = Object.keys(domainGeoCache);
  if (keys.length <= MAX_CACHE_ENTRIES) return;
  for (let i = 0; i < keys.length - MAX_CACHE_ENTRIES; i++) {
    delete domainGeoCache[keys[i]];
  }
}

function getCachedGeo(hostname) {
  return domainGeoCache[hostname] || null;
}

function setCachedGeo(hostname, geo) {
  delete domainGeoCache[hostname];
  domainGeoCache[hostname] = geo;
  evictOldEntries();
  clearTimeout(cacheFlushTimer);
  cacheFlushTimer = setTimeout(() => {
    browser.storage.local.set({ domainGeoCache });
  }, 10000);
}
