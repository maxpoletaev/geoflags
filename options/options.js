const urlEl = document.getElementById("url");
const fetchBtn = document.getElementById("fetch-btn");
const fetchResult = document.getElementById("fetch-result");
const dbStatus = document.getElementById("db-status");
const dbMissing = document.getElementById("db-missing");
const dbLastUpdated = document.getElementById("db-last-updated");
const dbRecordCount = document.getElementById("db-record-count");
const testIp = document.getElementById("test-ip");
const lookupBtn = document.getElementById("lookup-btn");
const lookupResult = document.getElementById("lookup-result");

async function loadSettings() {
  const s = await getSettings();
  urlEl.value = s.url;
}

async function loadDBStatus() {
  const resp = await browser.runtime.sendMessage({ type: "GET_DB_STATUS" });
  if (resp.dbReady) {
    dbStatus.classList.remove("hidden");
    dbMissing.classList.add("hidden");
    dbLastUpdated.textContent = resp.dbLastFetch
      ? new Date(resp.dbLastFetch).toLocaleString()
      : "unknown";
    dbRecordCount.textContent = resp.nodeCount
      ? resp.nodeCount.toLocaleString()
      : "-";
  } else {
    dbStatus.classList.add("hidden");
    dbMissing.classList.remove("hidden");
  }
}

fetchBtn.addEventListener("click", async () => {
  await saveSettings({ url: urlEl.value.trim() });

  fetchBtn.disabled = true;
  fetchBtn.textContent = "Updating…";
  fetchResult.className = "hidden";

  const result = await browser.runtime.sendMessage({ type: "FETCH_DB" });

  fetchBtn.disabled = false;
  fetchBtn.textContent = "Update";
  fetchResult.classList.remove("hidden");

  if (result.ok) {
    fetchResult.className = "msg ok";
    fetchResult.textContent = `Done. ${result.nodeCount.toLocaleString()} records loaded.`;
    await loadDBStatus();
  } else {
    fetchResult.className = "msg error";
    fetchResult.textContent = `Error: ${result.error}`;
  }
});

lookupBtn.addEventListener("click", async () => {
  const ip = testIp.value.trim();
  if (!ip) return;

  lookupBtn.disabled = true;
  lookupResult.className = "hidden";

  const resp = await browser.runtime.sendMessage({ type: "LOOKUP_IP", ip });

  lookupBtn.disabled = false;

  if (resp && resp.error) {
    lookupResult.className = "msg error";
    lookupResult.textContent = `Error: ${resp.error}`;
  } else if (!resp?.result) {
    lookupResult.className = "msg warn";
    lookupResult.textContent = "Not found";
  } else {
    lookupResult.className = "msg ok";
    lookupResult.textContent = JSON.stringify(resp.result, null, 2);
  }

  lookupResult.classList.remove("hidden");
});

testIp.addEventListener("keydown", (e) => {
  if (e.key === "Enter") lookupBtn.click();
});

loadSettings();
loadDBStatus();
