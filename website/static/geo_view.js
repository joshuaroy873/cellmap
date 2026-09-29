"use strict";

// Created only on first opening the tab. All exact geometry work is server-side.
let geoMap;
let geoSquares;
let geoDrawing;
let geoShape;
let geoVertices = [];
let geoSelecting = false;
let geoRequest = 0;
let geoController;
let geoTimer;
let geoCollections = [];
const geoExcluded = new Set();
let geoGroupSignature = "";
const geoFields = ["operator", "band", "metric"];
let geoOptions;
let geoOptionsLoading = false;
let geoDirty = true;
let geoHasSearched = false;
let geoSearching = false;
// Request settings and small metadata only; never cached grid/point results.
let geoPrimary;
let geoActivePayload;
let geoHasExplored = false;
let geoExplorationPending = false;
let geoFailedSearch;
let geoInvalidPolygon = false;
const geoKey = (db, collection) => JSON.stringify([db, collection]);

function geoMessage(text) { $("geo-status").textContent = text; }

function updateGeoSearchButtons() {
  $("geo-draw").textContent = !geoHasSearched && (geoSelecting || geoVertices.length)
    ? "Restart polygon" : "Search polygon";
  $("geo-draw").disabled = geoHasSearched || geoSearching;
  $("geo-search").textContent = geoFailedSearch || geoInvalidPolygon ? "Retry search" : geoHasSearched ? "Reset search" : "Search";
  $("geo-search").disabled = geoFailedSearch || geoInvalidPolygon ? geoSearching
    : !geoHasSearched && (!geoOptions || geoSelecting || geoSearching);
  $("geo-explore-restore").disabled = !geoPrimary || !geoHasExplored || geoDirty || geoSearching;
}

async function loadGeoOptions() {
  if (geoOptions || geoOptionsLoading) return;
  geoOptionsLoading = true;
  geoMessage("Loading filter choices…");
  try {
    geoOptions = await getJSON("/api/geo/options");
    refreshGeoOptions();
    updateGeoSearchButtons();
    geoMessage("Choose filters and click Search for worldwide results, or draw a polygon.");
  } catch (error) {
    geoMessage("Could not load filter choices: " + error.message);
    const retry = document.createElement("button");
    retry.textContent = "Retry filters";
    retry.addEventListener("click", loadGeoOptions, {once: true});
    $("geo-status").append(" ", retry);
  } finally {
    geoOptionsLoading = false;
  }
}

function refreshGeoOptions() {
  if (!geoOptions) return;
  const data = geoOptions[$("geo-measurement").value];
  let rows = data.combinations;
  for (const [index, field] of [[1, "operator"], [2, "band"]]) {
    const values = [...new Set(rows.map(row => field === "band"
      ? (row[2] == null ? null : `${row[0]}:${row[2]}`) : row[index]).filter(v => v != null))];
    values.sort((a, b) => String(a).localeCompare(String(b), undefined, {numeric: true}));
    const select = $("geo-" + field);
    const selected = values.includes(select.value) ? select.value : "all";
    setSelect(select, values.map(value => ({value, label: field === "band"
      ? (value.startsWith("LTE:") ? "b" : "n") + value.split(":")[1] : value})), selected, "All");
    if (selected !== "all") rows = rows.filter(row => field === "band"
      ? `${row[0]}:${row[2]}` === selected : row[index] === selected);
  }
  const metric = $("geo-metric").value;
  setSelect($("geo-metric"), data.metrics,
    data.metrics.some(item => item.value === metric) ? metric : data.metrics[0]?.value, null);
}

function markGeoPending() {
  if (!geoInvalidPolygon) geoFailedSearch = null;
  geoHasExplored = false;
  geoExplorationPending = false;
  geoDirty = true;
  geoHasSearched = false;
  geoPrimary = null;
  geoActivePayload = null;
  $("geo-explore").hidden = true;
  geoSearching = false;
  ++geoRequest;
  geoController?.abort();
  clearTimeout(geoTimer);
  geoSquares?.clearLayers();
  $("geo-legend").hidden = true;
  $("geo-result-count").removeAttribute("aria-busy");
  if (!$("geo-results").hidden) $("geo-result-count").textContent = "Settings changed. Click Search to update results.";
  updateGeoSearchButtons();
  geoMessage(geoInvalidPolygon ? "The polygon is invalid. Click Retry search to clear it and start again; filters will be kept."
    : "Settings changed. Click Search; the existing polygon is retained.");
}

function showGeoMap() {
  loadGeoOptions();
  if (!geoMap) {
    geoMap = L.map("geo-map", { preferCanvas: true, renderer: L.canvas({ padding: 0.4 }) })
      .setView([39.5, -98.35], 4);
    initializeBasemap(geoMap, () => geoMessage("Background map unavailable. Check the CARTO key/referrer."));
    geoSquares = L.layerGroup().addTo(geoMap);
    geoDrawing = L.layerGroup().addTo(geoMap);
    geoMap.on("click", (event) => {
      if (!geoSelecting) return;
      if (geoVertices.length >= 200) {
        geoMessage("Maximum 200 vertices. Click the first point to finish.");
        return;
      }
      const latlng = event.latlng.wrap();
      geoVertices.push([latlng.lat, latlng.lng]);
      if (geoShape) geoShape.setLatLngs(geoVertices);
      else geoShape = L.polygon(geoVertices, { color: "#126782", fillOpacity: 0.2, interactive: false }).addTo(geoDrawing);
      const first = geoVertices.length === 1;
      const vertex = L.circleMarker(latlng, {
        radius: first ? 8 : 4, color: "#126782", fillColor: first ? "#fff" : "#126782",
        fillOpacity: 1, bubblingMouseEvents: false,
      }).addTo(geoDrawing);
      if (first) {
        vertex.bindTooltip("Click here to close the polygon");
        vertex.on("click", finishGeoPolygon);
      }
      geoMessage(`${geoVertices.length} vertices. Click the first point to close the polygon.`);
    });
    new ResizeObserver(() => geoMap.invalidateSize()).observe($("geo-map"));
  }
  requestAnimationFrame(() => geoMap.invalidateSize());
}

function resetGeoSearch() {
  geoFailedSearch = null;
  geoInvalidPolygon = false;
  closeGeoMenus();
  geoHasExplored = false;
  geoExplorationPending = false;
  geoPrimary = null;
  geoActivePayload = null;
  $("geo-explore").hidden = true;
  geoDirty = true;
  geoHasSearched = false;
  geoSearching = false;
  ++geoRequest;
  geoController?.abort();
  clearTimeout(geoTimer);
  geoSquares?.clearLayers();
  geoDrawing?.clearLayers();
  geoShape = null;
  geoVertices = [];
  geoCollections = [];
  geoExcluded.clear();
  geoGroupSignature = "";
  geoSelecting = false;
  geoMap?.doubleClickZoom.enable();
  updateGeoSearchButtons();
  $("geo-results").hidden = true;
  $("geo-result-groups").replaceChildren();
  $("geo-result-count").removeAttribute("aria-busy");
  $("geo-legend").hidden = true;
  tabControls.geoPolyPanel.classList.remove("has-results");
}

function finishGeoPolygon() {
  if (!geoSelecting) return;
  if (geoVertices.length < 3) {
    geoMessage("Place at least three points before closing the polygon.");
    return;
  }
  geoSelecting = false;
  geoMap.doubleClickZoom.enable();
  // Keep only a quiet outline once drawing is complete, not vertex handles/fill.
  geoDrawing.clearLayers();
  geoShape.setStyle({ fill: false, weight: 1, opacity: 0.4 }).addTo(geoDrawing);
  updateGeoSearchButtons();
  geoMessage("Polygon ready. Choose filters, then click Search.");
}

async function runGeoSearch(initial, retryAttempt = 0, savedPayload = null) {
  if (!geoOptions || geoSelecting || geoInvalidPolygon) return;
  if (initial !== true && !geoPrimary) return;
  geoDirty = false;
  geoSearching = true;
  updateGeoSearchButtons();
  const request = ++geoRequest;
  geoController?.abort();
  geoController = new AbortController();
  geoSquares.clearLayers();
  $("geo-legend").hidden = true;
  // Keep the previous summary in place; loading feedback is in the map toolbar.
  $("geo-result-count").setAttribute("aria-busy", "true");
  geoMessage(geoVertices.length ? "Searching measurements inside the polygon…" : "Searching measurements worldwide…");
  const bounds = geoMap.getBounds();
  let payload = savedPayload || {
    polygon: geoVertices.length ? geoVertices.map(([lat, lon]) => [lon, lat]) : null,
    measurement: $("geo-measurement").value,
    square_size: Number($("geo-square-size").value),
    aggregation: $("geo-aggregation").value,
    excluded: [],
    include_exploration_options: true,
    viewport: geoVertices.length ? [Math.max(-180, Math.min(180, bounds.getWest())), Math.max(-90, bounds.getSouth()),
      Math.max(-180, Math.min(180, bounds.getEast())), Math.min(90, bounds.getNorth())] : null,
  };
  if (!savedPayload) {
    if (initial === true) {
      for (const field of geoFields) {
        const value = $("geo-" + field).value;
        if (value && value !== "all") payload[field] = value;
      }
    } else if (initial === "restore") {
      payload = {...geoPrimary.payload, include_exploration_options: false};
    } else if (initial === "explore") {
      payload = {...geoPrimary.payload, include_exploration_options: false,
        collection_scope: geoPrimary.collections.map(row => [row.database, row.collection]),
        square_size: Number($("geo-explore-size").value),
        operators: geoExplorationSelection("operators"), bands: geoExplorationSelection("bands"),
        excluded: [...geoExcluded].map(key => JSON.parse(key)),
      };
      delete payload.operator;
      delete payload.band;
      delete payload.technology;
    } else {
      payload = {...geoActivePayload, include_exploration_options: false,
        excluded: [...geoExcluded].map(key => JSON.parse(key))};
    }
  }
  try {
    const result = await postJSON("/api/geo/search", payload, geoController.signal);
    if (request !== geoRequest) return;
    geoFailedSearch = null;
    geoHasSearched = true;
    geoHasExplored = Boolean(payload.collection_scope);
    geoExplorationPending = false;
    geoActivePayload = payload;
    geoExcluded.clear();
    for (const [db, coll] of payload.excluded || []) geoExcluded.add(geoKey(db, coll));
    if (initial === true) {
      geoPrimary = {payload: {...payload}, collections: result.collections,
        options: result.exploration_options || []};
      initializeGeoExploration();
    } else if (initial === "restore") {
      initializeGeoExploration();
    }
    if (payload.collection_scope) {
      const matches = new Map(result.collections.map(row => [geoKey(row.database, row.collection), row]));
      geoCollections = geoPrimary.collections.map(row => matches.get(geoKey(row.database, row.collection))
        || {...row, count: 0, squares: 0});
    } else geoCollections = result.collections;
    $("geo-explore-status").textContent = payload.collection_scope
      ? "Exploration results shown. Left-pane settings are unchanged."
      : "Primary search results shown.";
    const signature = JSON.stringify([geoCollections, [...geoExcluded].sort()]);
    if (signature !== geoGroupSignature) {
      renderGeoGroups();
      geoGroupSignature = signature;
    }
    $("geo-results").hidden = false;
    tabControls.geoPolyPanel.classList.add("has-results");
    for (const [index, [gx, gy, value, count]] of result.squares.entries()) {
      const size = result.square_size;
      const southwest = L.CRS.EPSG3857.unproject(L.point(gx * size, gy * size));
      const northeast = L.CRS.EPSG3857.unproject(L.point((gx + 1) * size, (gy + 1) * size));
      const label = document.createElement("span");
      const measurementCount = count > 9999 ? `~${(count / 1000).toFixed(1)}k` : count.toLocaleString();
      label.textContent = `${result.aggregation === "average" ? "Average" : "Maximum"}: ${Number(value).toFixed(2)} · ${measurementCount} measurements`;
      L.rectangle([southwest, northeast], {
        stroke: false, fillColor: colorFor(value, result.minimum, result.maximum), fillOpacity: 0.75,
        bubblingMouseEvents: false,
      }).bindTooltip(label).on("click", () => {
        const keys = new Set(result.square_collections[index].map(id => {
          const row = result.collections[id];
          return geoKey(row.database, row.collection);
        }));
        selectGeoCollections(keys);
      }).addTo(geoSquares);
    }
    const total = result.total.toLocaleString();
    const shown = result.squares.length.toLocaleString();
    $("geo-result-count").textContent = `${total} selected measurements\n${shown}/${result.visible_square_count.toLocaleString()} squares ${geoVertices.length ? "in the searched view" : "worldwide"}`;
    $("geo-legend").hidden = !result.squares.length;
    $("geo-legend-label").textContent = `${result.aggregation === "average" ? "Average" : "Maximum"} ${result.label || ""} (${result.unit || ""})`;
    $("geo-min").textContent = result.minimum == null ? "" : Number(result.minimum).toFixed(2);
    $("geo-max").textContent = result.maximum == null ? "" : Number(result.maximum).toFixed(2);
    const sidePixels = result.square_size * 256 * 2 ** geoMap.getZoom() / (2 * Math.PI * 6378137);
    geoMessage(!result.total ? "No matching measurements selected." : sidePixels < 1
      ? "Zoom in to see the selected-size squares; they are smaller than a screen pixel at this zoom."
      : result.sampled ? "Showing a proportional sample. Reset search to draw a smaller polygon for more detail."
      : "All matching squares in the searched area are shown. Click a square to select its matching collections.");
  } catch (error) {
    if (request !== geoRequest || error.name === "AbortError") return;
    // Aborting fetch does not stop an already-running server query. Wait for
    // that bounded query to release its slot when selections change quickly.
    if (error.message.startsWith("Another region search is running") && retryAttempt < 8) {
      geoMessage("Waiting for the previous region search to finish…");
      geoTimer = setTimeout(() => runGeoSearch(initial, retryAttempt + 1, payload), 500);
      return;
    }
    geoInvalidPolygon = error.message.includes("non-zero-area polygon")
      || error.message.includes("Polygons crossing the date line");
    geoFailedSearch = true;
    geoMessage(`${error.message}. Click Retry search to return to the initial search state; filters will be kept.`);
    $("geo-result-count").textContent = "Search failed; no squares displayed.";
  } finally {
    if (request === geoRequest) {
      geoSearching = false;
      updateGeoSearchButtons();
      $("geo-result-count").removeAttribute("aria-busy");
    }
  }
}

function geoExplorationSelection(field) {
  return [...$("geo-explore-" + field).querySelectorAll("input:checked")].map(input => input.value);
}

function closeGeoMenus(except = null) {
  for (const menu of document.querySelectorAll(".geo-explore-menu[open]")) {
    if (menu !== except) menu.open = false;
  }
}

function positionGeoMenu(menu) {
  const anchor = menu.querySelector("summary").getBoundingClientRect();
  const panel = menu.querySelector("div");
  const width = Math.min(anchor.width, window.innerWidth - 16);
  panel.style.width = `${width}px`;
  const below = window.innerHeight - anchor.bottom - 12;
  const above = anchor.top - 12;
  const upward = below < 160 && above > below;
  const maxHeight = Math.max(40, Math.min(240, upward ? above : below));
  panel.style.maxHeight = `${maxHeight}px`;
  panel.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`;
  panel.style.top = `${Math.max(8, upward ? anchor.top - Math.min(panel.scrollHeight + 2, maxHeight) - 4 : anchor.bottom + 4)}px`;
}

for (const menu of document.querySelectorAll(".geo-explore-menu")) {
  menu.addEventListener("toggle", () => {
    if (!menu.open) return;
    closeGeoMenus(menu);
    positionGeoMenu(menu);
  });
}
document.addEventListener("pointerdown", event => {
  if (!event.target.closest(".geo-explore-menu")) closeGeoMenus();
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  const menu = document.querySelector(".geo-explore-menu[open]");
  if (menu) { closeGeoMenus(); menu.querySelector("summary").focus(); }
});
document.addEventListener("scroll", event => {
  if (!event.target.matches?.(".geo-explore-menu > div")) closeGeoMenus();
}, true);
window.addEventListener("resize", () => closeGeoMenus());

function initializeGeoExploration() {
  closeGeoMenus();
  $("geo-explore").hidden = false;
  $("geo-explore-size").value = String(geoPrimary.payload.square_size);
  geoPrimary.optionExclusions = {operators: new Set(), bands: new Set()};
  refreshGeoExplorationChoices();
}

function refreshGeoExplorationChoices() {
  const rows = geoPrimary.options.filter(row => !geoExcluded.has(geoKey(row[0], row[1])));
  for (const field of ["operators", "bands"]) {
    const values = [...new Set(rows.map(row => field === "operators"
      ? row[3] ?? "__null__" : row[4] == null ? "__null__" : `${row[2]}:${row[4]}`))];
    values.sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
    const fragment = document.createDocumentFragment();
    for (const value of values) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = value;
      input.checked = !geoPrimary.optionExclusions[field].has(value);
      const text = value === "__null__" ? "Unknown" : field === "bands"
        ? (value.startsWith("LTE:") ? "b" : "n") + value.split(":")[1] : value;
      label.append(input, document.createTextNode(text));
      fragment.append(label);
    }
    $("geo-explore-" + field).replaceChildren(fragment);
  }
  updateGeoExplorationSummaries();
}

function updateGeoExplorationSummaries() {
  for (const [field, label] of [["operators", "Operators"], ["bands", "Bands"]]) {
    const selected = geoExplorationSelection(field);
    const total = $("geo-explore-" + field).querySelectorAll("input").length;
    const value = !selected.length ? "None" : selected.length === total ? "All" : `${selected.length} selected`;
    $("geo-explore-" + field + "-summary").textContent = `${label}: ${value}`;
  }
}

function scheduleGeoSelection(exploration = false) {
  updateGeoSelectAll();
  if (geoDirty || !geoPrimary) return;
  if (!exploration) refreshGeoExplorationChoices();
  if (exploration || geoHasExplored) geoExplorationPending = true;
  ++geoRequest;
  geoController?.abort();
  geoSearching = false;
  updateGeoSearchButtons();
  geoSquares?.clearLayers();
  $("geo-legend").hidden = true;
  clearTimeout(geoTimer);
  geoMessage("Updating selection…");
  if (geoExplorationPending) $("geo-explore-status").textContent = "Updating exploration…";
  if (!geoSelecting && activeTab === "geo-poly") {
    geoTimer = setTimeout(() => runGeoSearch(geoExplorationPending ? "explore" : false), 300);
  }
}

function selectGeoCollections(keys) {
  geoExcluded.clear();
  for (const row of geoCollections) {
    const key = geoKey(row.database, row.collection);
    if (keys !== null && !keys.has(key)) geoExcluded.add(key);
  }
  renderGeoGroups();
  scheduleGeoSelection();
}

function updateGeoSelectAll() {
  const selected = geoCollections.filter(row => !geoExcluded.has(geoKey(row.database, row.collection))).length;
  const checkbox = $("geo-select-all");
  checkbox.checked = geoCollections.length > 0 && selected === geoCollections.length;
  checkbox.indeterminate = selected > 0 && selected < geoCollections.length;
  checkbox.disabled = geoCollections.length === 0;
}

function renderGeoGroups() {
  updateGeoSelectAll();
  const opened = new Set([...$("geo-result-groups").querySelectorAll("details[open]")].map(item => item.dataset.database));
  const groups = new Map();
  for (const row of geoCollections) {
    if (!groups.has(row.database)) groups.set(row.database, []);
    groups.get(row.database).push(row);
  }
  const fragment = document.createDocumentFragment();
  for (const [database, collections] of groups) {
    const details = document.createElement("details"); // All collapsed initially.
    details.dataset.database = database;
    details.open = opened.has(database);
    const summary = document.createElement("summary");
    const label = document.createElement("label");
    const dbInput = document.createElement("input");
    dbInput.type = "checkbox";
    const selectedCount = collections.filter(row => !geoExcluded.has(geoKey(database, row.collection))).length;
    dbInput.checked = selectedCount === collections.length;
    dbInput.indeterminate = selectedCount > 0 && selectedCount < collections.length;
    label.append(dbInput, document.createTextNode(`${database} (${collections.length})`));
    label.addEventListener("click", event => event.stopPropagation());
    summary.append(label);
    details.append(summary);
    const inputs = [];
    for (const row of collections) {
      const item = document.createElement("label");
      item.className = "geo-collection";
      const input = document.createElement("input");
      input.type = "checkbox";
      const key = geoKey(database, row.collection);
      input.checked = !geoExcluded.has(key);
      inputs.push([input, key]);
      item.append(input, document.createTextNode(`${row.collection} (${row.squares.toLocaleString()} squares; ${row.count.toLocaleString()} measurements)`));
      input.addEventListener("change", () => {
        if (input.checked) geoExcluded.delete(key); else geoExcluded.add(key);
        const checked = inputs.filter(([box]) => box.checked).length;
        dbInput.checked = checked === inputs.length;
        dbInput.indeterminate = checked > 0 && checked < inputs.length;
        scheduleGeoSelection();
      });
      details.append(item);
    }
    dbInput.addEventListener("change", () => {
      dbInput.indeterminate = false;
      for (const [input, key] of inputs) {
        input.checked = dbInput.checked;
        if (dbInput.checked) geoExcluded.delete(key); else geoExcluded.add(key);
      }
      scheduleGeoSelection();
    });
    fragment.append(details);
  }
  $("geo-result-groups").replaceChildren(fragment);
}

$("geo-draw").addEventListener("click", () => {
  if (geoHasSearched || geoSearching) return;
  showGeoMap();
  resetGeoSearch();
  geoSelecting = true;
  geoMap.doubleClickZoom.disable();
  updateGeoSearchButtons();
  geoMessage("Click to place points, then click the first point to close the polygon.");
});

$("geo-select-all").addEventListener("change", event =>
  selectGeoCollections(event.target.checked ? null : new Set()));
$("geo-explore-restore").addEventListener("click", () => {
  clearTimeout(geoTimer);
  runGeoSearch("restore");
});
for (const id of ["geo-explore-size", "geo-explore-operators", "geo-explore-bands"]) {
  $(id).addEventListener("change", event => {
    if (!geoPrimary || geoDirty) return;
    if (id !== "geo-explore-size") {
      const field = id.replace("geo-explore-", "");
      if (event.target.checked) geoPrimary.optionExclusions[field].delete(event.target.value);
      else geoPrimary.optionExclusions[field].add(event.target.value);
    }
    updateGeoExplorationSummaries();
    scheduleGeoSelection(true);
  });
}

setSelect($("geo-measurement"), Object.entries(measurementLabels).map(([value, label]) => ({value, label})), "radio");
$("geo-search").addEventListener("click", () => {
  clearTimeout(geoTimer);
  if (geoFailedSearch || geoInvalidPolygon) {
    resetGeoSearch();
    geoMessage("Ready to search again. Filters kept. Click Search for worldwide results, or Search polygon to draw an area.");
    return;
  }
  if (geoHasSearched) {
    resetGeoSearch();
    geoMessage("Search reset. Filters kept. Click Search for worldwide results, or draw a polygon.");
    return;
  }
  runGeoSearch(true);
});
for (const field of geoFields) setSelect($("geo-" + field), [], "all", field === "metric" ? null : "All");
for (const field of ["measurement", ...geoFields, "square-size", "aggregation"]) {
  $("geo-" + field).addEventListener("change", () => {
    const chain = ["measurement", ...geoFields];
    const index = chain.indexOf(field);
    if (index >= 0) {
      for (const dependent of chain.slice(index + 1)) {
        if (dependent !== "metric" || field === "measurement") {
          $("geo-" + dependent).value = dependent === "metric" ? "" : "all";
        }
      }
    }
    refreshGeoOptions();
    markGeoPending();
  });
}
$("geo-clear-filters").addEventListener("click", () => {
  for (const field of geoFields) $("geo-" + field).value = field === "metric" ? "" : "all";
  refreshGeoOptions();
  markGeoPending();
});
