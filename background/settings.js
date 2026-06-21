const DEFAULT_SETTINGS = {
  url: "https://media.githubusercontent.com/media/iplocate/ip-address-databases/main/ip-to-country/ip-to-country.mmdb",
};

async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function saveSettings(patch) {
  const merged = { ...(await getSettings()), ...patch };
  await browser.storage.local.set({ settings: merged });
  return merged;
}
