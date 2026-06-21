const tabState = {};
const mainHostname = {};

function clearTab(tabId) {
  tabState[tabId] = {};
  delete mainHostname[tabId];
}

function removeTab(tabId) {
  delete tabState[tabId];
  delete mainHostname[tabId];
}

function getMainHostname(tabId) {
  return mainHostname[tabId] || null;
}

function upsertDomain(tabId, hostname, info) {
  if (!tabState[tabId]) tabState[tabId] = {};
  if (info.isMainFrame) mainHostname[tabId] = hostname;
  const existing = tabState[tabId][hostname];
  if (existing) {
    const wasMainFrame = existing.isMainFrame;
    existing.count += 1;
    if (!existing.countryCode && info.countryCode) {
      Object.assign(existing, info);
    }
    if (wasMainFrame) existing.isMainFrame = true;
  } else {
    tabState[tabId][hostname] = { ...info, count: 1 };
  }
}

function getMainDomain(tabId) {
  const state = tabState[tabId];
  if (!state) return null;
  const host = mainHostname[tabId];
  if (host && state[host]) return { hostname: host, ...state[host] };
  return null;
}

function getSnapshot(tabId) {
  const state = tabState[tabId];
  if (!state) return [];
  return Object.entries(state)
    .map(([hostname, info]) => ({ hostname, ...info }))
    .sort((a, b) => b.count - a.count);
}
