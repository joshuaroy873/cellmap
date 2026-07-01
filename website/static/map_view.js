"use strict";

const map = L.map("map", {
  renderer: L.canvas({ padding: 0.4 }),
  preferCanvas: true,
  zoomControl: true,
}).setView([39.5, -98.35], 4);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png", {
  subdomains: "abcd",
  maxZoom: 20,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
}).addTo(map);

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

function renderMap(payload) {
  markerLayer.clearLayers();
  $("map-legend").hidden = !payload.points.length;
  $("legend-unit").textContent = payload.unit;
  renderLegendAxis(payload.summary.minimum, payload.summary.maximum);

  if (!payload.points.length) {
    setMapMessage("No mapped measurements match these filters.");
    return;
  }

  setMapMessage("");
  const bounds = [];
  for (const point of payload.points) {
    const color = colorFor(
      point.metric_value,
      payload.summary.minimum,
      payload.summary.maximum
    );
    const marker = L.circleMarker([point.latitude, point.longitude], {
      renderer: map.options.renderer,
      radius: 4,
      weight: 0,
      fillColor: color,
      fillOpacity: 0.82,
    });
    marker.on("click", () => renderPoint(point, payload));
    marker.addTo(markerLayer);
    bounds.push([point.latitude, point.longitude]);
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

function renderPoint(point, payload) {
  const preferred = [
    ["metric", `${payload.label}: ${metricValue(point.metric_value, payload.unit)}`],
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

  const list = $("point-details");
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
}

function clearDetails() {
  $("point-details").innerHTML =
    '<div class="empty-detail panel-prompt">Select a point on the map</div>';
}
