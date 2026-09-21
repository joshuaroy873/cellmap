"use strict";

// Created only on first opening the tab. All exact geometry work is server-side.
let geoMap;
let geoPoints;
let geoDrawing;
let geoShape;
let geoVertices = [];
let geoSelecting = false;
let geoRequest = 0;
let geoController;
let geoTimer;
let geoCollections = [];
const geoSelected = new Set();
const geoKey = (db, collection) => JSON.stringify([db, collection]);

function geoMessage(text) { $("geo-status").textContent = text; }

function showGeoMap() {
  if (!geoMap) {
    geoMap = L.map("geo-map", { preferCanvas: true, renderer: L.canvas({ padding: 0.4 }) })
      .setView([39.5, -98.35], 4);
    initializeBasemap(geoMap, () => geoMessage("Background map unavailable. Check the CARTO key/referrer."));
    geoPoints = L.layerGroup().addTo(geoMap);
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
      geoMessage(`${geoVertices.length} vertices. Click the first point to close and search.`);
    });
    new ResizeObserver(() => geoMap.invalidateSize()).observe($("geo-map"));
  }
  requestAnimationFrame(() => geoMap.invalidateSize());
}

function resetGeoSearch() {
  ++geoRequest;
  geoController?.abort();
  clearTimeout(geoTimer);
  geoPoints?.clearLayers();
  geoDrawing?.clearLayers();
  geoShape = null;
  geoVertices = [];
  geoCollections = [];
  geoSelected.clear();
  geoSelecting = false;
  geoMap?.doubleClickZoom.enable();
  $("geo-draw").textContent = "Select polygon";
  $("geo-results").hidden = true;
  $("geo-result-groups").replaceChildren();
  $("geo-result-count").removeAttribute("aria-busy");
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
  $("geo-draw").textContent = "New polygon";
  runGeoSearch(true);
}

async function runGeoSearch(initial, retryAttempt = 0) {
  const request = ++geoRequest;
  geoController?.abort();
  geoController = new AbortController();
  geoPoints.clearLayers();
  // Keep the previous summary in place; loading feedback is in the map toolbar.
  $("geo-result-count").setAttribute("aria-busy", "true");
  geoMessage("Searching measurements inside the polygon…");
  const payload = { polygon: geoVertices.map(([lat, lon]) => [lon, lat]) };
  if (!initial) payload.selected = [...geoSelected].map(key => JSON.parse(key));
  try {
    const result = await postJSON("/api/geo/search", payload, geoController.signal);
    if (request !== geoRequest) return;
    if (initial) {
      geoCollections = result.collections;
      geoSelected.clear();
      for (const row of geoCollections) geoSelected.add(geoKey(row.database, row.collection));
      renderGeoGroups();
      $("geo-results").hidden = false;
      tabControls.geoPolyPanel.classList.add("has-results");
    }
    for (const [db, collection, lat, lon] of result.points) {
      const label = document.createElement("span");
      label.textContent = `${db} / ${collection}`;
      L.circleMarker([lat, lon], {
        radius: 3, stroke: false, fillColor: "#126782", fillOpacity: 0.65,
      }).bindTooltip(label).addTo(geoPoints);
    }
    const total = result.total.toLocaleString();
    const shown = result.points.length.toLocaleString();
    $("geo-result-count").textContent = result.total > result.points.length
      ? `${total} matching measurements selected. Map preview: ${shown} sampled points. Counts include all matches.`
      : `${total} matching measurements selected. Map shows all ${shown} points.`;
    geoMessage(result.total ? "Change database or collection selections to update the map." : "No matching measurements selected.");
  } catch (error) {
    if (request !== geoRequest || error.name === "AbortError") return;
    // Aborting fetch does not stop an already-running server query. Wait for
    // that bounded query to release its slot when selections change quickly.
    if (error.message.startsWith("Another region search is running") && retryAttempt < 8) {
      geoMessage("Waiting for the previous region search to finish…");
      geoTimer = setTimeout(() => runGeoSearch(initial, retryAttempt + 1), 500);
      return;
    }
    geoMessage(error.message);
    $("geo-result-count").textContent = "Search failed; no points displayed.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry search";
    retry.addEventListener("click", () => runGeoSearch(initial), { once: true });
    $("geo-status").append(" ", retry);
  } finally {
    if (request === geoRequest) $("geo-result-count").removeAttribute("aria-busy");
  }
}

function scheduleGeoSelection() {
  ++geoRequest;
  geoController?.abort();
  geoPoints.clearLayers();
  clearTimeout(geoTimer);
  geoMessage("Updating selection…");
  geoTimer = setTimeout(() => runGeoSearch(false), 250);
}

function renderGeoGroups() {
  const groups = new Map();
  for (const row of geoCollections) {
    if (!groups.has(row.database)) groups.set(row.database, []);
    groups.get(row.database).push(row);
  }
  const fragment = document.createDocumentFragment();
  for (const [database, collections] of groups) {
    const details = document.createElement("details"); // All collapsed initially.
    const summary = document.createElement("summary");
    const label = document.createElement("label");
    const dbInput = document.createElement("input");
    dbInput.type = "checkbox";
    dbInput.checked = true;
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
      input.checked = true;
      const key = geoKey(database, row.collection);
      inputs.push([input, key]);
      item.append(input, document.createTextNode(`${row.collection} (${row.count.toLocaleString()})`));
      input.addEventListener("change", () => {
        if (input.checked) geoSelected.add(key); else geoSelected.delete(key);
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
        if (dbInput.checked) geoSelected.add(key); else geoSelected.delete(key);
      }
      scheduleGeoSelection();
    });
    fragment.append(details);
  }
  $("geo-result-groups").replaceChildren(fragment);
}

$("geo-draw").addEventListener("click", () => {
  showGeoMap();
  resetGeoSearch();
  geoSelecting = true;
  geoMap.doubleClickZoom.disable();
  $("geo-draw").textContent = "Restart polygon";
  geoMessage("Click to place points, then click the first point to close and search.");
});
$("geo-clear").addEventListener("click", () => {
  resetGeoSearch();
  geoMessage("Select polygon, then click the map to place vertices.");
});
