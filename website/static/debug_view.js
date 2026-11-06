"use strict";

// Debug tab (temporary): every measurement on one downlink channel number
// (LTE EARFCN or NR-ARFCN) across all databases. Shown only when the page is
// opened with ?debug=1. To remove: delete this file, the debug-* block in
// index.html, the "debug" lines in app.js/state.js, and the "Debug tab"
// section in server.py.

let debugMap;
let debugMarkers;
let debugRequest = 0;
let debugController;
let debugPayload;
let debugPointRequest = 0;
let debugPointController;

const debugControls = {
  measurement: $("debug-measurement"),
  technology: $("debug-technology"),
  channel: $("debug-channel"),
  channelLabel: $("debug-channel-label"),
  metric: $("debug-metric"),
  search: $("debug-search"),
};

function debugMessage(text) {
  const element = $("debug-message");
  element.textContent = text;
  element.hidden = !text;
}

function debugMetricItems(counts) {
  const metrics = catalog?.measurements
    .find((item) => item.value === debugControls.measurement.value)?.metrics || [];
  return metrics.map((metric) => ({
    value: metric.value,
    label: counts ? `${metric.label} (#${(counts[metric.value] ?? 0).toLocaleString()})` : metric.label,
  }));
}

function refreshDebugControls(counts = null) {
  debugControls.channelLabel.textContent =
    debugControls.technology.value === "NR" ? "DL NR-ARFCN" : "DL EARFCN";
  setSelect(debugControls.metric, debugMetricItems(counts), debugControls.metric.value);
}

function showDebugTab() {
  if (!debugMap) {
    debugMap = L.map("debug-map", { preferCanvas: true, renderer: L.canvas({ padding: 0.4 }) })
      .setView([39.5, -98.35], 4);
    initializeBasemap(debugMap, () => debugMessage("Background map unavailable"));
    debugMarkers = L.layerGroup().addTo(debugMap);
    new ResizeObserver(() => debugMap.invalidateSize()).observe($("debug-map"));
  }
  refreshDebugControls(debugPayload?.metric_counts ?? null);
  requestAnimationFrame(() => debugMap.invalidateSize());
}

function debugParams() {
  return {
    measurement: debugControls.measurement.value,
    technology: debugControls.technology.value,
    channel: debugControls.channel.value.trim(),
    metric: debugControls.metric.value,
  };
}

function clearDebugDetails() {
  debugPointRequest += 1;
  debugPointController?.abort();
  $("debug-point-details").innerHTML =
    '<div class="empty-detail panel-prompt">Select a point on the map</div>';
}

async function runDebugSearch() {
  const params = debugParams();
  if (!/^\d+$/.test(params.channel)) {
    setStatus("Enter the downlink channel number as digits");
    debugControls.channel.focus();
    return;
  }
  const request = ++debugRequest;
  debugController?.abort();
  debugController = new AbortController();
  debugControls.search.disabled = true;
  setStatus("Searching all databases");
  debugMessage("Searching all databases…");
  try {
    const payload = await getJSON("/api/debug/channel", params, debugController.signal);
    if (request !== debugRequest) return;
    payload.request = params; // Point-detail lookups must use the same scope.
    debugPayload = payload;
    renderDebugResult(payload);
    setStatus("");
  } catch (error) {
    if (request !== debugRequest || error.name === "AbortError") return;
    setStatus("Search failed");
    debugMessage(error.message);
  } finally {
    if (request === debugRequest) debugControls.search.disabled = false;
  }
}

function renderDebugResult(payload) {
  refreshDebugControls(payload.metric_counts);
  clearDebugDetails();
  debugMarkers.clearLayers();

  const summary = payload.summary;
  const stat = (id, text) => { $(`debug-stat-${id}`).textContent = text; };
  stat("count", number(summary.count, 0));
  for (const key of ["median", "p5", "p95", "minimum", "maximum"]) {
    stat(key, summary.count ? metricValue(summary[key], payload.unit) : "-");
  }

  const list = $("debug-collections");
  list.replaceChildren();
  list.classList.toggle("panel-prompt", !payload.collections.length);
  $("debug-collection-count").textContent = payload.rows
    ? `${number(payload.rows, 0)} rows in ${payload.collections.length} collection${payload.collections.length === 1 ? "" : "s"}`
    : "";
  if (!payload.collections.length) {
    list.textContent = "No matches";
  }
  for (const row of payload.collections) {
    const line = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = `${row.database} / ${row.collection}`;
    line.append(name, document.createTextNode(`: ${number(row.rows, 0)} rows`));
    line.title = line.textContent;
    list.append(line);
  }

  const points = mapPoints(payload);
  const where = `${payload.technology} ${payload.measurement === "radio" ? "radio" : "neighbour"} on DL channel ${payload.channel}`;
  $("debug-legend").hidden = !points.count;
  if (!points.count) {
    debugMessage(!payload.rows
      ? `No ${where} in any database.`
      : !summary.count
        ? `${number(payload.rows, 0)} rows match ${where}, but none has a ${payload.label} value.`
        : `${number(summary.count, 0)} ${payload.label} values match ${where}, but none has GPS.`);
    return;
  }
  debugMessage("");
  $("debug-legend-unit").textContent = payload.unit;
  const scale = colorScale(summary);
  renderLegendAxis(scale, $("debug-legend-axis"));
  const bounds = [];
  for (let index = 0; index < points.count; index += 1) {
    const latitude = points.latitude[index];
    const longitude = points.longitude[index];
    L.circleMarker([latitude, longitude], {
      renderer: debugMap.options.renderer,
      radius: 4,
      weight: 0,
      fillColor: colorFor(points.value[index], scale.minimum, scale.maximum),
      fillOpacity: 0.82,
    }).on("click", () => showDebugPointDetails(payload, points, index)).addTo(debugMarkers);
    bounds.push([latitude, longitude]);
  }
  debugMap.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });
}

async function showDebugPointDetails(payload, points, index) {
  const request = ++debugPointRequest;
  debugPointController?.abort();
  const list = $("debug-point-details");
  const known = {
    metric_value: points.value[index],
    latitude: points.latitude[index],
    longitude: points.longitude[index],
  };
  renderPoint(known, payload, "Loading details", list);
  debugPointController = new AbortController();
  try {
    const point = await getJSON(
      "/api/debug/channel/point",
      { ...payload.request, position: points.position[index] },
      debugPointController.signal
    );
    if (request !== debugPointRequest) return;
    renderPoint(point, payload, null, list);
  } catch (error) {
    if (request !== debugPointRequest || error.name === "AbortError") return;
    renderPoint(known, payload, error.message, list);
  }
}

debugControls.search.addEventListener("click", runDebugSearch);
debugControls.channel.addEventListener("keydown", (event) => {
  if (event.key === "Enter") runDebugSearch();
});
for (const name of ["measurement", "technology", "metric"]) {
  debugControls[name].addEventListener("change", () => {
    if (name !== "metric") refreshDebugControls();
    if (debugControls.channel.value.trim()) runDebugSearch();
  });
}
