browser.runtime.onInstalled.addListener(() => {
  Promise.all([initDB(), loadDomainCache()]);
});

browser.runtime.onStartup.addListener(() => {
  Promise.all([initDB(), loadDomainCache()]);
});

browser.webRequest.onResponseStarted.addListener(
  (details) => {
    const { tabId, url, ip, type } = details;
    if (tabId < 0) return;
    if (!url.startsWith("http://") && !url.startsWith("https://")) return;
    if (ip && isPrivateIP(ip)) return;

    let hostname;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return;
    }

    const isMainFrame = type === "main_frame";
    const geoInfo = ip ? (lookup(ip) || {}) : {};

    // Persist geo when we have a real IP so future null-IP requests can use it.
    if (ip && geoInfo.countryCode) {
      setCachedGeo(hostname, { ip, countryCode: geoInfo.countryCode, country: geoInfo.country });
    }

    // Fall back to cache when IP is missing.
    const cached = !ip ? getCachedGeo(hostname) : null;

    upsertDomain(tabId, hostname, {
      ip: ip || cached?.ip || null,
      countryCode: geoInfo.countryCode || cached?.countryCode || null,
      country: geoInfo.country || cached?.country || null,
      fromCache: !ip && !!cached,
      asn: null,
      org: null,
      isMainFrame,
    });

    // Update toolbar if this is the main domain
    if (isMainFrame || getMainHostname(tabId) === hostname) {
      updateToolbarIcon(tabId);
    }
  },
  { urls: ["http://*/*", "https://*/*"] }
);

browser.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  clearTab(details.tabId);
  tabIconKey.delete(details.tabId);
  // Seed the main-frame hostname immediately so the header and toolbar always
  // have a domain to display, even when the response comes from cache (no IP).
  try {
    const hostname = new URL(details.url).hostname;
    if (hostname) {
      const cached = getCachedGeo(hostname);
      upsertDomain(details.tabId, hostname, {
        ip: cached?.ip || null,
        countryCode: cached?.countryCode || null,
        country: cached?.country || null,
        fromCache: !!cached,
        isMainFrame: true,
      });
    }
  } catch {}
  updateToolbarIcon(details.tabId);
});

browser.tabs.onRemoved.addListener((tabId) => {
  removeTab(tabId);
  tabIconKey.delete(tabId);
});

browser.tabs.onActivated.addListener(({ tabId }) => {
  updateToolbarIcon(tabId);
});

function updateToolbarIcon(tabId) {
  const main = getMainDomain(tabId);
  if (main && main.countryCode) {
    browser.browserAction.setTitle({
      tabId,
      title: `${main.ip || ""} · ${main.country || main.countryCode}`,
    });
    setFlagIcon(tabId, main.countryCode.toLowerCase());
  } else {
    browser.browserAction.setTitle({ tabId, title: "Geo Flags — resolving…" });
    setFlagIcon(tabId, null);
  }
}

function renderIconCanvas(size, drawFn) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  drawFn(ctx, size);
  return ctx.getImageData(0, 0, size, size);
}

const iconImageCache = new Map(); // cc | "?" -> { 32, 64 } imageData
const tabIconKey = new Map(); // tabId -> last icon key applied

async function buildIconImageData(cc) {
  if (cc) {
    const url = browser.runtime.getURL(`flags/${cc}.png`);
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const draw = (ctx, size) => {
      const scale = Math.min(size / bitmap.width, size / bitmap.height);
      const w = bitmap.width * scale;
      const h = bitmap.height * scale;
      ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
    };
    return { 
      32: renderIconCanvas(32, draw), 
      64: renderIconCanvas(64, draw)
    };
  }
  const draw = (ctx, size) => {
    ctx.font = `bold ${Math.round(size * 0.75)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#888";
    ctx.fillText("?", size / 2, size / 2);
  };
  return { 
    32: renderIconCanvas(32, draw), 
    64: renderIconCanvas(64, draw)
  };
}

async function setFlagIcon(tabId, cc) {
  const key = cc || "?";
  if (tabIconKey.get(tabId) === key) return;
  tabIconKey.set(tabId, key);
  try {
    let imageData = iconImageCache.get(key);
    if (!imageData) {
      imageData = await buildIconImageData(cc);
      iconImageCache.set(key, imageData);
    }
    if (tabIconKey.get(tabId) !== key) return;
    browser.browserAction.setIcon({ tabId, imageData });
  } catch (e) {
    tabIconKey.delete(tabId); // allow a later retry
  }
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_TAB_STATE") {
    const { tabId } = msg;
    const snapshot = getSnapshot(tabId);
    const main = getMainDomain(tabId);
    sendResponse({ snapshot, main, dbReady: isDBReady() });
    return true;
  }

  if (msg.type === "FETCH_DB") {
    fetchAndBuildDB().then((result) => sendResponse(result));
    return true;
  }

  if (msg.type === "LOOKUP_IP") {
    if (!isDBReady()) {
      sendResponse({ error: "Database not loaded" });
    } else {
      try {
        sendResponse({ result: lookup(msg.ip) });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    }
    return true;
  }

  if (msg.type === "GET_DB_STATUS") {
    browser.storage.local.get("dbLastFetch").then(({ dbLastFetch }) => {
      let testLookup = null;
      const reader = getReader();
      if (reader) {
        try {
          testLookup = reader.lookup("8.8.8.8");
        } catch (e) {
          testLookup = { error: e.message };
        }
      }
      sendResponse({
        dbReady: isDBReady(),
        dbLastFetch: dbLastFetch || null,
        nodeCount: reader?.nodeCount ?? null,
        dbSize: reader?.buf?.byteLength ?? null,
        ipVersion: reader?.ipVersion ?? null,
        recordSize: reader?.recordSize ?? null,
        ipv4StartNode: reader?._ipv4StartNode ?? null,
        testLookup,
      });
    });
    return true;
  }
});
