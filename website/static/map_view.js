"use strict";

const map = L.map("map", {
  renderer: L.canvas({ padding: 0.4 }),
  preferCanvas: true,
  zoomControl: true,
}).setView([39.5, -98.35], 4);

async function initializeBasemap(target = map, onError = () => { $("basemap-message").hidden = false; }) {
  try {
    // The served page carries the key; the API call is only a fallback.
    const cartoBasemapKey = document.querySelector('meta[name="carto-basemap-key"]')?.content
      || (await getJSON("/api/config")).cartoBasemapKey;
    if (!cartoBasemapKey) {
      throw new Error("Set CARTO_BASEMAP_KEY in the repository root .env file.");
    }
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png" +
        `?key=${encodeURIComponent(cartoBasemapKey)}`,
      {
        subdomains: "abcd",
        maxZoom: 20,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      }
    ).addTo(target);
  } catch (error) {
    console.error("Basemap initialization failed:", error.message);
    onError();
  }
}

initializeBasemap();

markerLayer = L.layerGroup().addTo(map);

function colorFor(value, minimum, maximum) {
  const span = maximum - minimum || 1;
  const ratio = Math.max(0, Math.min(1, (value - minimum) / span));
  const colors = [
    [49, 54, 149],
    [44, 123, 182],
    [0, 166, 202],
    [253, 174, 97],
    [215, 25, 28],
  ];
  const scaled = ratio * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const local = scaled - index;
  const rgb = colors[index].map((channel, i) =>
    Math.round(channel + (colors[index + 1][i] - channel) * local)
  );
  return `rgb(${rgb.join(",")})`;
}

// Points arrive as columns (position, latitude, longitude, value). A server
// started before this change embeds every field per point; accept both so a
// page refresh never breaks while the service awaits its restart.
function mapPoints(payload) {
  const points = payload.points;
  if (Array.isArray(points)) {
    return {
      count: points.length,
      latitude: points.map((point) => point.latitude),
      longitude: points.map((point) => point.longitude),
      value: points.map((point) => point.metric_value),
      position: null,
      embedded: points,
    };
  }
  return { count: points.latitude.length, ...points, embedded: null };
}

let pointRequestNumber = 0;
let pointController = null;

async function showPointDetails(payload, points, index) {
  const request = ++pointRequestNumber;
  pointController?.abort();
  if (points.embedded) {
    renderPoint(points.embedded[index], payload);
    return;
  }
  const known = {
    metric_value: points.value[index],
    latitude: points.latitude[index],
    longitude: points.longitude[index],
  };
  renderPoint(known, payload, "Loading details");
  pointController = new AbortController();
  try {
    const point = await getJSON(
      "/api/point",
      { ...(payload.request || measurementParams()), position: points.position[index] },
      pointController.signal
    );
    if (request !== pointRequestNumber) return;
    renderPoint(point, payload);
  } catch (error) {
    if (request !== pointRequestNumber || error.name === "AbortError") return;
    renderPoint(known, payload, error.message);
  }
}

function renderMap(payload) {
  markerLayer.clearLayers();
  const points = mapPoints(payload);
  $("map-legend").hidden = !points.count;
  $("legend-unit").textContent = payload.unit;
  const scale = colorScale(payload.summary);
  renderLegendAxis(scale);

  if (!points.count) {
    setMapMessage("No mapped measurements match these filters.");
    return;
  }

  setMapMessage("");
  const bounds = [];
  for (let index = 0; index < points.count; index += 1) {
    const latitude = points.latitude[index];
    const longitude = points.longitude[index];
    const marker = L.circleMarker([latitude, longitude], {
      renderer: map.options.renderer,
      radius: 4,
      weight: 0,
      fillColor: colorFor(points.value[index], scale.minimum, scale.maximum),
      fillOpacity: 0.82,
    });
    marker.on("click", () => showPointDetails(payload, points, index));
    marker.addTo(markerLayer);
    bounds.push([latitude, longitude]);
  }

  const selection = [
    controls.database.value,
    ...selectedCollections(),
    controls.measurement.value,
  ].join("/");
  if (bounds.length && fittedSelection !== selection) {
    map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });
    fittedSelection = selection;
  }
}

function displayName(key) {
  return key
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace("Pci", "PCI")
    .replace("Ssb", "SSB")
    .replace("Scs", "SCS")
    .replace("Rbs", "RBs");
}

function renderPoint(point, payload, note = null, list = $("point-details")) {
  const preferred = [
    ["metric", `${payload.label}: ${metricValue(point.metric_value, payload.unit)}`],
    ["database_name", point.database_name],
    ["collection_name", point.collection_name],
    ["measured_at", point.measured_at],
    ["technology", point.technology],
    ["rat", point.rat],
    ["operator_name", point.operator_name],
    ["band_number", point.band_number],
    ["pci", point.pci],
    ["ssb_index", point.ssb_index],
    ["model", point.model],
    ["latitude", point.latitude],
    ["longitude", point.longitude],
  ];
  const used = new Set(preferred.map(([key]) => key));
  const fields = [
    ...preferred,
    ...Object.entries(point).filter(
      ([key, value]) =>
        !used.has(key) &&
        key !== "metric_value" &&
        value !== null &&
        value !== undefined
    ),
  ];

  list.replaceChildren();
  for (const [key, value] of fields) {
    if (value === null || value === undefined) continue;
    const wrapper = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = displayName(key);
    detail.textContent = value;
    detail.title = value;
    wrapper.append(term, detail);
    list.append(wrapper);
  }
  if (note) {
    const prompt = document.createElement("div");
    prompt.className = "empty-detail panel-prompt";
    prompt.textContent = note;
    list.append(prompt);
  }
}

function clearDetails() {
  pointRequestNumber += 1;
  pointController?.abort();
  $("point-details").innerHTML =
    '<div class="empty-detail panel-prompt">Select a point on the map</div>';
}
