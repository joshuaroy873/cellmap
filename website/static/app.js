"use strict";

const $ = (id) => document.getElementById(id);
const controls = {
  database: $("database"),
  collectionPicker: document.querySelector(".collection-picker"),
  collectionOptions: $("collection-options"),
  collectionSummary: $("collection-summary"),
  start: $("start-time"),
  end: $("end-time"),
  measurement: $("measurement"),
  technology: $("technology"),
  operator: $("operator"),
  band: $("band"),
  pci: $("pci"),
  ssb: $("ssb"),
  metric: $("metric"),
  cdfButton: $("show-cdf"),
};

const measurementLabels = {
  radio: "Radio",
  neighbor: "Neighbour",
  pdsch: "PDSCH",
  pusch: "PUSCH",
};

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

let catalog = null;
let options = null;
let markerLayer;
let fittedSelection = "";
let requestNumber = 0;
let cdfRequestNumber = 0;
let cdfPayload = null;
let idleTimer = null;
let sessionPaused = false;

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

function setStatus(message) {
  $("status").textContent = message;
}

function setMapMessage(message) {
  const element = $("map-message");
  element.textContent = message;
  element.hidden = !message;
}

function resetSummary() {
  for (const id of [
    "stat-count",
    "stat-median",
    "stat-p5",
    "stat-p95",
    "stat-minimum",
    "stat-maximum",
  ]) {
    $(id).textContent = "-";
  }
}

function resetFilterOptions() {
  setSelect(controls.technology, [], "all", "All technologies");
  setSelect(controls.operator, [], "all", "All operators");
  setSelect(controls.band, [], "all", "All bands");
  setSelect(controls.pci, [], "all", "All PCIs");
  setSelect(controls.ssb, [], "all", "All SSB indexes");
  setSelect(controls.metric, [], null);
  updateCdfButton();
}

function showSelectionPrompt(message) {
  requestNumber += 1;
  markerLayer.clearLayers();
  $("map-legend").hidden = true;
  setMapMessage(message);
  resetSummary();
  setTimeSeriesAvailable(false);
  clearDetails();
  closeCdf();
}

function pauseSession() {
  sessionPaused = true;
  closeCdf();
  requestNumber += 1;
  cdfRequestNumber += 1;
  $("idle-overlay").hidden = false;
  setStatus("Session paused");
}

function resetIdleTimer() {
  if (sessionPaused) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(pauseSession, IDLE_TIMEOUT_MS);
}

async function getJSON(path, params = {}) {
  if (sessionPaused) {
    throw new Error("Session paused. Refresh page to continue.");
  }
  const url = new URL(path, window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item !== undefined && item !== null && item !== "" && item !== "all") {
        url.searchParams.append(key, item);
      }
    }
  });
  const response = await fetch(url);
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    const contentType = response.headers.get("Content-Type") || "";
    const detail = contentType.includes("text/html") || text.trimStart().startsWith("<")
      ? "The API returned an HTML page. Restart website/server.py and make sure this page is served by that Python server."
      : "The API returned an invalid JSON response.";
    throw new Error(detail);
  }
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function setSelect(select, items, selected, allLabel = null, labeler = String) {
  const previous = selected ?? select.value;
  select.replaceChildren();
  if (allLabel !== null) {
    select.add(new Option(allLabel, "all"));
  }
  for (const item of items) {
    const value = typeof item === "object" ? item.value : item;
    const label = typeof item === "object" ? item.label : labeler(item);
    select.add(new Option(label, value));
  }
  const available = [...select.options].some((option) => option.value === String(previous));
  select.value = available ? previous : select.options[0]?.value || "";
}

function updateCdfButton() {
  controls.cdfButton.disabled = !(
    controls.database.value &&
    selectedCollections().length &&
    controls.metric.value
  );
}

function currentDatabase() {
  return catalog?.databases.find((item) => item.name === controls.database.value);
}

function collectionInputs() {
  return [...controls.collectionOptions.querySelectorAll("input[data-collection]")];
}

function selectedCollections() {
  return collectionInputs()
    .filter((input) => input.checked)
    .map((input) => input.value);
}

function currentCollections() {
  const selected = new Set(selectedCollections());
  return currentDatabase()?.collections.filter(
    (item) => selected.has(item.name)
  ) || [];
}

function inputTime(value) {
  return value ? value.slice(0, 19) : "";
}

function applyCollectionRange() {
  const collections = currentCollections();
  const starts = collections.map((item) => item.start).filter(Boolean);
  const ends = collections.map((item) => item.end).filter(Boolean);
  controls.start.value = inputTime(starts.sort()[0]);
  controls.end.value = inputTime(ends.sort().at(-1));
}

function populateMeasurementTypes() {
  const categories = new Set(
    currentCollections().flatMap((item) => item.categories || [])
  );
  setSelect(
    controls.measurement,
    Object.keys(measurementLabels)
      .filter((value) => categories.has(value))
      .map((value) => ({ value, label: measurementLabels[value] })),
    controls.measurement.value
  );
}

function updateCollectionSummary() {
  const inputs = collectionInputs();
  const selected = selectedCollections();
  const selectAll = $("collection-select-all");
  if (selectAll) {
    selectAll.checked = inputs.length > 0 && selected.length === inputs.length;
    selectAll.indeterminate =
      selected.length > 0 && selected.length < inputs.length;
  }
  controls.collectionSummary.textContent = selected.length === 0
    ? "Select collection"
    : selected.length === 1
      ? selected[0]
      : `${selected.length} collections`;
  controls.collectionSummary.title = selected.join("\n");
}

function populateCollections(reset = false) {
  const database = currentDatabase();
  const collections = database?.collections || [];
  const previous = new Set(reset ? [] : selectedCollections());

  controls.collectionOptions.replaceChildren();
  if (collections.length) {
    const selectAllLabel = document.createElement("label");
    selectAllLabel.className = "collection-option collection-select-all";
    const selectAll = document.createElement("input");
    selectAll.id = "collection-select-all";
    selectAll.type = "checkbox";
    const selectAllText = document.createElement("span");
    selectAllText.textContent = "Select all";
    selectAllLabel.append(selectAll, selectAllText);
    controls.collectionOptions.append(selectAllLabel);
  }
  for (const collection of collections) {
    const label = document.createElement("label");
    label.className = "collection-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = collection.name;
    checkbox.dataset.collection = "";
    checkbox.checked = previous.has(collection.name);
    const text = document.createElement("span");
    text.textContent = collection.name;
    label.append(checkbox, text);
    controls.collectionOptions.append(label);
  }
  updateCollectionSummary();
  populateMeasurementTypes();
}

function optionParams() {
  return {
    database: controls.database.value,
    collection: selectedCollections(),
    measurement: controls.measurement.value,
    technology: controls.technology.value,
    operator: controls.operator.value,
    band: controls.band.value,
    pci: controls.pci.value,
    ssb: controls.ssb.value,
  };
}

function measurementParams() {
  return {
    ...optionParams(),
    start: controls.start.value,
    end: controls.end.value,
    metric: controls.metric.value,
  };
}

async function loadOptions({ resetFilters = false } = {}) {
  if (!controls.database.value || !selectedCollections().length) return;
  if (resetFilters) {
    controls.technology.value = "all";
    controls.operator.value = "all";
    controls.band.value = "all";
    controls.pci.value = "all";
    controls.ssb.value = "all";
  }
  options = await getJSON("/api/options", optionParams());

  setSelect(
    controls.technology,
    options.technologies,
    resetFilters ? "all" : controls.technology.value,
    "All technologies"
  );
  setSelect(
    controls.operator,
    options.operators,
    resetFilters ? "all" : controls.operator.value,
    "All operators"
  );
  setTimeSeriesAvailable(controls.operator.value !== "all");
  setSelect(
    controls.band,
    options.bands,
    resetFilters ? "all" : controls.band.value,
    "All bands"
  );
  setSelect(
    controls.pci,
    options.pcis,
    resetFilters ? "all" : controls.pci.value,
    "All PCIs"
  );
  setSelect(
    controls.ssb,
    options.ssb_indexes,
    resetFilters ? "all" : controls.ssb.value,
    "All SSB indexes"
  );
  setSelect(
    controls.metric,
    options.metrics,
    resetFilters ? null : controls.metric.value
  );
  updateCdfButton();
}

function number(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return Number(value).toLocaleString(undefined, {
    maximumFractionDigits: digits,
  });
}

function compactAxisNumber(value) {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) {
    return `${number(value / 1_000_000, 1)}M`;
  }
  if (absolute >= 1_000) {
    return `${Math.round(value / 1_000).toLocaleString()}k`;
  }
  return number(value, 1);
}

function legendAxisNumber(value) {
  if (controls.metric.value === "throughput_mbps") {
    return number(value, 0);
  }
  return compactAxisNumber(value);
}

function clamp(value, minimum, maximum) {
  if (maximum < minimum) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function metricValue(value, unit) {
  const formatted = number(value, 2);
  return formatted === "-" || !unit ? formatted : `${formatted} ${unit}`;
}

function cdfMarkerValue(value, unit) {
  const formatted = !unit && Math.abs(value) >= 1_000
    ? compactAxisNumber(value)
    : number(value, 2);
  return formatted === "-" || !unit ? formatted : `${formatted} ${unit}`;
}

function percentileValue(points, probability) {
  let previous = points[0];
  for (const point of points) {
    if (point.probability >= probability) {
      if (point.probability === previous.probability) return point.value;
      const local =
        (probability - previous.probability) /
        (point.probability - previous.probability);
      return previous.value + (point.value - previous.value) * local;
    }
    previous = point;
  }
  return points.at(-1).value;
}

function cdfMarkers(payload) {
  const points = payload.points || [];
  if (!points.length) return [];
  return [
    { label: "P5", probability: 0.05, value: percentileValue(points, 0.05) },
    {
      label: "Median",
      probability: 0.5,
      value: percentileValue(points, 0.5),
    },
    { label: "P95", probability: 0.95, value: percentileValue(points, 0.95) },
  ];
}

function cdfSummaryText(payload) {
  const count = `${number(payload.count, 0)} samples`;
  const markers = cdfMarkers(payload);
  if (!markers.length) return count;
  const labels = markers.map(
    (marker) => `${marker.label}: ${cdfMarkerValue(marker.value, payload.unit)}`
  );
  return [count, ...labels].join(" | ");
}

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

function renderLegendAxis(minimum, maximum) {
  const axis = $("legend-axis");
  axis.replaceChildren();
  if (minimum === null || minimum === undefined ||
      maximum === null || maximum === undefined) {
    return;
  }
  const span = maximum - minimum;
  for (let index = 0; index < 5; index += 1) {
    const tick = document.createElement("span");
    tick.style.left = `${index * 25}%`;
    tick.textContent = legendAxisNumber(minimum + (span * index) / 4);
    axis.append(tick);
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

function renderSummary(payload) {
  const summary = payload.summary;
  $("stat-count").textContent = number(summary.count, 0);
  $("stat-median").textContent = metricValue(summary.median, payload.unit);
  $("stat-p5").textContent = metricValue(summary.p5, payload.unit);
  $("stat-p95").textContent = metricValue(summary.p95, payload.unit);
  $("stat-minimum").textContent = metricValue(summary.minimum, payload.unit);
  $("stat-maximum").textContent = metricValue(summary.maximum, payload.unit);
  $("chart-title").textContent = payload.label;
  $("series-count").textContent = payload.series.length
    ? `${payload.series.length} time buckets`
    : "";
}

function setTimeSeriesAvailable(available) {
  $("time-series-message").hidden = available;
  $("chart").style.visibility = available ? "visible" : "hidden";
  if (!available) {
    $("series-count").textContent = "";
  }
}

function drawChart(payload) {
  const canvas = $("chart");
  const context = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const data = payload.series;
  if (!data.length || width < 80 || height < 80) return;

  const margin = { top: 12, right: 15, bottom: 25, left: 48 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const minimum = Math.min(...data.map((item) => item.minimum));
  const maximum = Math.max(...data.map((item) => item.maximum));
  const span = maximum - minimum || 1;
  const x = (index) =>
    margin.left + (index / Math.max(1, data.length - 1)) * plotWidth;
  const y = (value) =>
    margin.top + (1 - (value - minimum) / span) * plotHeight;

  context.strokeStyle = "#e3e8ed";
  context.lineWidth = 1;
  context.fillStyle = "#657180";
  context.font = "11px system-ui";
  context.textAlign = "right";
  for (let line = 0; line <= 4; line += 1) {
    const value = minimum + (span * line) / 4;
    const py = y(value);
    context.beginPath();
    context.moveTo(margin.left, py);
    context.lineTo(width - margin.right, py);
    context.stroke();
    context.fillText(number(value, 1), margin.left - 7, py + 4);
  }

  context.beginPath();
  data.forEach((item, index) => {
    const px = x(index);
    const py = y(item.maximum);
    if (index === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  });
  for (let index = data.length - 1; index >= 0; index -= 1) {
    context.lineTo(x(index), y(data[index].minimum));
  }
  context.closePath();
  context.fillStyle = "rgba(18, 103, 130, 0.12)";
  context.fill();

  context.beginPath();
  data.forEach((item, index) => {
    const px = x(index);
    const py = y(item.average);
    if (index === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  });
  context.strokeStyle = "#126782";
  context.lineWidth = 2;
  context.stroke();

  context.fillStyle = "#657180";
  context.textAlign = "center";
  const timeIndexes = [0, Math.floor((data.length - 1) / 2), data.length - 1];
  for (const index of timeIndexes) {
    const time = new Date(data[index].time);
    context.fillText(
      time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      x(index),
      height - 6
    );
  }
}

function drawRoundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - radius,
    y + height
  );
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function drawCdf(payload) {
  const canvas = $("cdf-chart");
  const context = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const points = payload.points;
  if (!points.length || width < 120 || height < 120) return;

  const margin = { top: 18, right: 24, bottom: 50, left: 64 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const minimum = Math.floor(points[0].value / 10) * 10;
  let maximum = Math.ceil(points.at(-1).value / 10) * 10;
  if (maximum === minimum) maximum += 10;
  const span = maximum - minimum || 1;
  const x = (value) =>
    margin.left + ((value - minimum) / span) * plotWidth;
  const y = (probability) =>
    margin.top + (1 - probability) * plotHeight;

  context.strokeStyle = "#e3e8ed";
  context.fillStyle = "#657180";
  context.lineWidth = 1;
  context.font = "11px system-ui";

  for (let index = 0; index <= 5; index += 1) {
    const probability = index / 5;
    const py = y(probability);
    context.beginPath();
    context.moveTo(margin.left, py);
    context.lineTo(width - margin.right, py);
    context.stroke();
    context.textAlign = "right";
    context.fillText(`${Math.round(probability * 100)}%`, margin.left - 8, py + 4);
  }

  for (let index = 0; index <= 4; index += 1) {
    const value = minimum + (span * index) / 4;
    const px = x(value);
    context.beginPath();
    context.moveTo(px, margin.top);
    context.lineTo(px, height - margin.bottom);
    context.stroke();
    context.textAlign = "center";
    context.fillText(number(value, 1), px, height - margin.bottom + 18);
  }

  context.beginPath();
  points.forEach((point, index) => {
    const px = x(point.value);
    const py = y(point.probability);
    if (index === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  });
  context.strokeStyle = "#126782";
  context.lineWidth = 2.2;
  context.stroke();

  const markers = cdfMarkers(payload);
  for (const marker of markers) {
    const px = x(marker.value);
    const py = y(marker.probability);
    const text = `${marker.label}: ${cdfMarkerValue(marker.value, payload.unit)}`;
    const paddingX = 7;
    const boxHeight = 22;

    context.font = "12px system-ui";
    const boxWidth = context.measureText(text).width + paddingX * 2;
    let boxX = px + 10;
    if (boxX + boxWidth > width - margin.right) {
      boxX = px - boxWidth - 10;
    }
    boxX = clamp(boxX, margin.left, width - margin.right - boxWidth);

    const preferredYOffset = marker.probability >= 0.9
      ? 8
      : marker.probability <= 0.1
        ? -30
        : -11;
    const boxY = clamp(
      py + preferredYOffset,
      margin.top + 2,
      height - margin.bottom - boxHeight - 2
    );

    context.save();
    context.strokeStyle = "rgba(18, 103, 130, 0.28)";
    context.lineWidth = 1;
    context.setLineDash([3, 3]);
    context.beginPath();
    context.moveTo(px, height - margin.bottom);
    context.lineTo(px, py);
    context.stroke();
    context.restore();

    const boxEdgeX = boxX > px ? boxX : boxX + boxWidth;
    context.strokeStyle = "rgba(18, 103, 130, 0.45)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(px, py);
    context.lineTo(boxEdgeX, boxY + boxHeight / 2);
    context.stroke();

    context.fillStyle = "rgba(255, 255, 255, 0.96)";
    context.strokeStyle = "#126782";
    drawRoundedRect(context, boxX, boxY, boxWidth, boxHeight, 6);
    context.fill();
    context.stroke();

    context.fillStyle = "#18212b";
    context.textAlign = "left";
    context.fillText(text, boxX + paddingX, boxY + 15);

    context.beginPath();
    context.arc(px, py, 4, 0, Math.PI * 2);
    context.fillStyle = "#ffffff";
    context.fill();
    context.strokeStyle = "#126782";
    context.lineWidth = 2;
    context.stroke();
  }

  const xLabel = payload.unit
    ? `${payload.label} (${payload.unit})`
    : payload.label;
  context.font = "11px system-ui";
  context.fillStyle = "#18212b";
  context.textAlign = "center";
  context.fillText(xLabel, margin.left + plotWidth / 2, height - 8);

  context.save();
  context.translate(15, margin.top + plotHeight / 2);
  context.rotate(-Math.PI / 2);
  context.fillText("Cumulative probability", 0, 0);
  context.restore();
}

function closeCdf() {
  cdfRequestNumber += 1;
  cdfPayload = null;
  if ($("cdf-modal").open) $("cdf-modal").close();
}

async function openCdf() {
  if (controls.cdfButton.disabled) return;
  const request = ++cdfRequestNumber;
  const modal = $("cdf-modal");
  $("cdf-title").textContent = "CDF";
  $("cdf-count").textContent = "";
  $("cdf-message").textContent = "Loading CDF";
  $("cdf-message").hidden = false;
  $("cdf-chart").style.visibility = "hidden";
  modal.showModal();

  try {
    const payload = await getJSON("/api/cdf", measurementParams());
    if (request !== cdfRequestNumber) return;
    cdfPayload = payload;
    $("cdf-title").textContent = `${payload.label} CDF`;
    $("cdf-count").textContent = cdfSummaryText(payload);
    $("cdf-message").hidden = Boolean(payload.points.length);
    $("cdf-message").textContent = payload.points.length
      ? ""
      : "No measurements match these filters";
    $("cdf-chart").style.visibility = payload.points.length
      ? "visible"
      : "hidden";
    drawCdf(payload);
  } catch (error) {
    if (request !== cdfRequestNumber) return;
    $("cdf-message").textContent = error.message;
    $("cdf-message").hidden = false;
  }
}

function clearDetails() {
  $("point-details").innerHTML =
    '<div class="empty-detail panel-prompt">Select a point on the map</div>';
}

async function loadMeasurements() {
  if (!controls.metric.value) return;
  const currentRequest = ++requestNumber;
  const showTimeSeries = controls.operator.value !== "all";
  setTimeSeriesAvailable(showTimeSeries);
  setStatus("Querying measurements");
  setMapMessage("Loading measurements");
  try {
    const payload = await getJSON("/api/measurements", measurementParams());
    if (currentRequest !== requestNumber) return;
    renderMap(payload);
    renderSummary(payload);
    if (showTimeSeries) drawChart(payload);
    clearDetails();
    setStatus("");
  } catch (error) {
    if (currentRequest !== requestNumber) return;
    setStatus("Query failed");
    setMapMessage(error.message);
  }
}

async function refreshOptionsAndData(resetFilters = false) {
  try {
    setStatus("Loading filter values");
    await loadOptions({ resetFilters });
    await loadMeasurements();
  } catch (error) {
    setStatus("Loading failed");
    setMapMessage(error.message);
  }
}

async function initialize() {
  try {
    catalog = await getJSON("/api/catalog");
    controls.database.replaceChildren(new Option("Select database", ""));
    for (const database of catalog.databases) {
      controls.database.add(new Option(database.name, database.name));
    }
    populateCollections(true);
    applyCollectionRange();
    resetFilterOptions();
    showSelectionPrompt("Select database and collection");
    setStatus("Select database and collection");
  } catch (error) {
    setStatus("Initialization failed");
    setMapMessage(error.message);
  }
}

controls.database.addEventListener("change", async () => {
  populateCollections(true);
  applyCollectionRange();
  resetFilterOptions();
  fittedSelection = "";
  if (!controls.database.value) {
    showSelectionPrompt("Select database and collection");
    setStatus("Select database and collection");
    return;
  }
  showSelectionPrompt("Select collection");
  setStatus("Select collection");
});

controls.collectionOptions.addEventListener("change", async (event) => {
  if (!event.target.matches('input[type="checkbox"]')) return;
  if (event.target.id === "collection-select-all") {
    for (const input of collectionInputs()) {
      input.checked = event.target.checked;
    }
  }
  updateCollectionSummary();
  populateMeasurementTypes();
  applyCollectionRange();
  fittedSelection = "";
  if (!selectedCollections().length) {
    resetFilterOptions();
    showSelectionPrompt("Select collection");
    setStatus("Select collection");
    return;
  }
  await refreshOptionsAndData(true);
});

document.addEventListener("click", (event) => {
  if (controls.collectionPicker && !controls.collectionPicker.contains(event.target)) {
    controls.collectionPicker.open = false;
  }
});

controls.measurement.addEventListener("change", async () => {
  fittedSelection = "";
  await refreshOptionsAndData(false);
});

controls.technology.addEventListener("change", async () => {
  await refreshOptionsAndData(false);
});

controls.operator.addEventListener("change", async () => {
  await refreshOptionsAndData(false);
});

controls.band.addEventListener("change", async () => {
  await refreshOptionsAndData(false);
});

controls.pci.addEventListener("change", async () => {
  await refreshOptionsAndData(false);
});

controls.ssb.addEventListener("change", async () => {
  await refreshOptionsAndData(false);
});

controls.metric.addEventListener("change", () => {
  updateCdfButton();
  loadMeasurements();
});

for (const name of ["start", "end"]) {
  controls[name].addEventListener("change", loadMeasurements);
}

$("show-cdf").addEventListener("click", openCdf);
$("cdf-close").addEventListener("click", closeCdf);
$("cdf-modal").addEventListener("click", (event) => {
  if (event.target === $("cdf-modal")) closeCdf();
});
$("cdf-modal").addEventListener("close", () => {
  cdfRequestNumber += 1;
  cdfPayload = null;
});

$("reset-time").addEventListener("click", () => {
  applyCollectionRange();
  loadMeasurements();
});

$("clear-filters").addEventListener("click", () => {
  controls.technology.value = "all";
  controls.operator.value = "all";
  controls.band.value = "all";
  controls.pci.value = "all";
  controls.ssb.value = "all";
  applyCollectionRange();
  if (!controls.database.value || !selectedCollections().length) {
    const message = controls.database.value
      ? "Select collection"
      : "Select database and collection";
    showSelectionPrompt(message);
    setStatus(message);
    return;
  }
  refreshOptionsAndData(true);
});

window.addEventListener("resize", () => {
  map.invalidateSize();
  if ($("cdf-modal").open && cdfPayload) drawCdf(cdfPayload);
});

for (const eventName of ["click", "keydown", "pointermove", "touchstart"]) {
  document.addEventListener(eventName, resetIdleTimer, { passive: true });
}

resetIdleTimer();
initialize();
