// Popup logic: fetch tab state, render header, chart, and domain list.

const CHART_COLORS = [
  "#e63946", "#457b9d", "#2a9d8f", "#e9c46a", "#f4a261",
  "#a8dadc", "#6a4c93", "#52b788", "#ff6b6b", "#48cae4",
  "#b5838d", "#80b918",
];

function flagSrc(cc) {
  return cc && cc.length === 2 ? `../flags/${cc.toLowerCase()}.png` : null;
}

function flagImg(cc, cls) {
  const src = flagSrc(cc);
  return src
    ? `<img src="${src}" class="${cls}" alt="${cc}" />`
    : `<div class="${cls}-placeholder"></div>`;
}

function buildDonut(svg, slices) {
  svg.innerHTML = "";
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total === 0) return;

  const NS = "http://www.w3.org/2000/svg";
  const cx = 60, cy = 60, R = 54, r = 34;

  // Single slice: SVG arcs can't describe a full circle (start = end point).
  // Draw it as a ring using two stacked circles instead.
  if (slices.length === 1) {
    const outer = document.createElementNS(NS, "circle");
    outer.setAttribute("cx", cx); outer.setAttribute("cy", cy); outer.setAttribute("r", R);
    outer.setAttribute("fill", slices[0].color);
    const inner = document.createElementNS(NS, "circle");
    inner.setAttribute("cx", cx); inner.setAttribute("cy", cy); inner.setAttribute("r", r);
    inner.setAttribute("fill", getComputedStyle(document.body).backgroundColor || "#f5f6f8");
    [outer, inner].forEach(el => {
      el.style.cursor = "pointer";
      el.addEventListener("mouseenter", () => highlightCountry(slices[0].label, true));
      el.addEventListener("mouseleave", () => highlightCountry(slices[0].label, false));
      svg.appendChild(el);
    });
    return;
  }

  let angle = -Math.PI / 2;
  slices.forEach((slice, i) => {
    const sweep = (slice.value / total) * 2 * Math.PI;
    const endAngle = angle + sweep;
    const x1 = cx + R * Math.cos(angle),  y1 = cy + R * Math.sin(angle);
    const x2 = cx + R * Math.cos(endAngle), y2 = cy + R * Math.sin(endAngle);
    const ix1 = cx + r * Math.cos(angle),  iy1 = cy + r * Math.sin(angle);
    const ix2 = cx + r * Math.cos(endAngle), iy2 = cy + r * Math.sin(endAngle);
    const large = sweep > Math.PI ? 1 : 0;

    const path = document.createElementNS(NS, "path");
    path.setAttribute("d",
      `M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2}` +
      ` L ${ix2} ${iy2} A ${r} ${r} 0 ${large} 0 ${ix1} ${iy1} Z`
    );
    path.setAttribute("fill", slice.color);
    path.setAttribute("data-index", i);
    path.dataset.country = slice.label;
    path.style.cursor = "pointer";
    path.style.transition = "opacity 0.15s";
    path.addEventListener("mouseenter", () => highlightCountry(slice.label, true));
    path.addEventListener("mouseleave", () => highlightCountry(slice.label, false));
    svg.appendChild(path);
    angle = endAngle;
  });
}

function highlightCountry(countryName, on) {
  document.querySelectorAll(".legend-item").forEach((el) => {
    el.classList.toggle("highlighted", on && el.dataset.country === countryName);
  });
  document.querySelectorAll("#domain-tbody tr").forEach((el) => {
    el.classList.toggle("highlighted", on && el.dataset.country === countryName);
  });
  // Dim other slices
  document.querySelectorAll("#donut path").forEach((el) => {
    el.style.opacity = on && el.dataset.country !== countryName ? "0.4" : "1";
  });
}

function render({ snapshot, main, dbReady }) {
  // Header
  const headerFlag = document.getElementById("header-flag");
  const headerHostname = document.getElementById("header-hostname");
  const headerDetail = document.getElementById("header-detail");

  if (main) {
    const src = flagSrc(main.countryCode);
    headerFlag.src = src || "";
    headerFlag.style.display = src ? "" : "none";
    headerHostname.textContent = main.hostname;
    const parts = [];
    if (main.country) parts.push(main.country);
    if (main.ip) parts.push(main.ip);
    headerDetail.textContent = parts.join(" · ");
  } else {
    headerHostname.textContent = "No data";
    headerDetail.textContent = "";
  }

  // DB warning
  document.getElementById("db-warning").classList.toggle("hidden", dbReady);

  if (!snapshot || snapshot.length === 0) {
    document.getElementById("no-data").classList.remove("hidden");
    document.getElementById("chart-section").classList.add("hidden");
    document.getElementById("domain-table").classList.add("hidden");
    return;
  }

  document.getElementById("no-data").classList.add("hidden");
  document.getElementById("chart-section").classList.remove("hidden");
  document.getElementById("domain-table").classList.remove("hidden");

  // Aggregate by country for chart
  const byCountry = new Map();
  for (const row of snapshot) {
    const key = row.country || "Unknown";
    byCountry.set(key, (byCountry.get(key) || 0) + row.count);
  }
  const sorted = [...byCountry.entries()].sort((a, b) => b[1] - a[1]);
  const slices = sorted.map(([label, value], i) => ({
    label,
    value,
    color: CHART_COLORS[i % CHART_COLORS.length],
  }));
  const colorMap = Object.fromEntries(slices.map((s) => [s.label, s.color]));

  // Chart (buildDonut tags each slice element with its country via dataset).
  const svg = document.getElementById("donut");
  buildDonut(svg, slices);

  // Legend
  const legend = document.getElementById("legend");
  legend.innerHTML = "";
  slices.forEach(({ label, value, color }) => {
    const item = document.createElement("div");
    item.className = "legend-item";
    item.dataset.country = label;
    item.innerHTML = `
      <div class="legend-dot" style="background:${color}"></div>
      <span class="legend-label">${label}</span>
      <span class="legend-count">${value}</span>
    `;
    item.addEventListener("mouseenter", () => highlightCountry(label, true));
    item.addEventListener("mouseleave", () => highlightCountry(label, false));
    legend.appendChild(item);
  });

  // Domain table
  const tbody = document.getElementById("domain-tbody");
  tbody.innerHTML = "";
  for (const row of snapshot) {
    const countryLabel = row.country || "Unknown";
    const tr = document.createElement("tr");
    tr.dataset.country = countryLabel;
    const color = colorMap[countryLabel] || "#888";

    tr.innerHTML = `
      <td style="border-left: 3px solid ${color}">
        <div class="cell-domain">
          ${flagImg(row.countryCode, "domain-flag")}
          <span class="domain-name" title="${row.hostname}">${row.hostname}</span>
        </div>
      </td>
      <td class="cell-ip">${row.ip || "cached"}</td>
      <td class="cell-reqs">${row.count}</td>
    `;

    tr.addEventListener("mouseenter", () => highlightCountry(countryLabel, true));
    tr.addEventListener("mouseleave", () => highlightCountry(countryLabel, false));
    tbody.appendChild(tr);
  }
}

async function init() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const response = await browser.runtime.sendMessage({
    type: "GET_TAB_STATE",
    tabId: tab.id,
  });

  render(response || { snapshot: [], main: null, dbReady: false });
}

document.getElementById("settings-btn").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
});

init().catch(console.error);
