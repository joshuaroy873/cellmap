"use strict";

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

async function loadMeasurements() {
  if (activeTab !== "map") return;
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
    initializeCompare();
    showSelectionPrompt("Select database and collection");
    setStatus("Select database and collection");
  } catch (error) {
    setStatus("Initialization failed");
    setMapMessage(error.message);
  }
}

function setActiveTab(tab) {
  activeTab = tab;
  document.body.dataset.tab = tab;
  tabControls.mapPanel.hidden = tab !== "map";
  tabControls.comparePanel.hidden = tab !== "compare";
  tabControls.mapButton.classList.toggle("active", tab === "map");
  tabControls.compareButton.classList.toggle("active", tab === "compare");
  closeCdf();

  if (tab === "map") {
    setTimeout(() => map.invalidateSize(), 0);
    if (!controls.database.value || !selectedCollections().length) {
      const message = controls.database.value
        ? "Select collection"
        : "Select database and collection";
      showSelectionPrompt(message);
      setStatus(message);
    } else {
      refreshOptionsAndData(false);
    }
  } else {
    if (!controls.start.value && !controls.end.value) {
      applyDatabaseRange();
    }
    onCompareDatabaseChanged();
    setStatus(controls.database.value ? "Configure compare curves" : "Select database");
  }
}

tabControls.mapButton.addEventListener("click", () => setActiveTab("map"));
tabControls.compareButton.addEventListener("click", () => setActiveTab("compare"));

controls.database.addEventListener("change", async () => {
  populateCollections(true);
  if (activeTab === "compare") applyDatabaseRange();
  else applyCollectionRange();
  resetFilterOptions();
  fittedSelection = "";
  onCompareDatabaseChanged();
  if (!controls.database.value) {
    showSelectionPrompt("Select database and collection");
    setStatus(activeTab === "compare" ? "Select database" : "Select database and collection");
    return;
  }
  if (activeTab === "compare") {
    setStatus("Configure compare curves");
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
  controls[name].addEventListener("change", () => {
    if (activeTab === "map") loadMeasurements();
  });
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
  if (activeTab === "compare") {
    applyDatabaseRange();
  } else {
    applyCollectionRange();
    loadMeasurements();
  }
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
  if (activeTab === "map") map.invalidateSize();
  if ($("cdf-modal").open && cdfPayload) drawCdf(cdfPayload);
  if (activeTab === "compare") redrawCompareCharts();
});

for (const eventName of ["click", "keydown", "pointermove", "touchstart"]) {
  document.addEventListener(eventName, resetIdleTimer, { passive: true });
}

document.body.dataset.tab = activeTab;
resetIdleTimer();
initialize();
