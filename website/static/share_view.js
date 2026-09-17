"use strict";

let activeSharedViewId = null;
let shareButtonResetTimer = null;

function sharedViewIdFromLocation() {
  return new URLSearchParams(window.location.search).get("share");
}

function removeSharedViewFromLocation() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("share")) return;
  url.searchParams.delete("share");
  history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  activeSharedViewId = null;
}

function markSharedViewChanged() {
  if (activeSharedViewId || sharedViewIdFromLocation()) {
    removeSharedViewFromLocation();
  }
}

function updateShareButton() {
  const canShare = activeTab === "map" && Boolean(
    controls.database.value && selectedCollections().length && controls.metric.value && !optionsPending
  );
  controls.share.disabled = !canShare;
  controls.share.title = activeTab === "map"
    ? "Create and copy a link to this Map view"
    : "Switch to Map to share its filters";
}

function sharedViewState() {
  return {
    database: controls.database.value,
    collections: selectedCollections(),
    start: controls.start.value || null,
    end: controls.end.value || null,
    measurement: controls.measurement.value,
    technology: controls.technology.value,
    operator: controls.operator.value,
    band: controls.band.value,
    pci: controls.pci.value,
    ssb: controls.ssb.value,
    metric: controls.metric.value,
  };
}

function shareUrl(identifier) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("share", identifier);
  return url.toString();
}

async function copyShareUrl(url) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return;
    }
  } catch {
    // Fall through to the compatibility path below.
  }

  const input = document.createElement("textarea");
  input.value = url;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Share link created, but copying it failed");
}

async function shareCurrentView() {
  if (controls.share.disabled) return;

  const originalLabel = controls.share.textContent;
  controls.share.disabled = true;
  controls.share.textContent = "Sharing…";
  setStatus("Creating share link");

  try {
    const payload = await postJSON("/api/shared-views", {
      state: sharedViewState(),
    });
    const url = shareUrl(payload.id);
    const location = new URL(url);
    activeSharedViewId = payload.id;
    history.replaceState({}, "", `${location.pathname}${location.search}`);
    await copyShareUrl(url);
    controls.share.textContent = "Copied";
    setStatus("Share link copied");
    clearTimeout(shareButtonResetTimer);
    shareButtonResetTimer = setTimeout(() => {
      controls.share.textContent = originalLabel;
    }, 1800);
  } catch (error) {
    controls.share.textContent = originalLabel;
    setStatus(error.message);
  } finally {
    updateShareButton();
  }
}

function setSharedSelectValue(select, value) {
  if (!value) return false;
  const available = [...select.options].some((option) => option.value === value);
  if (available) select.value = value;
  return available;
}

function applySharedCollections(collections) {
  const requested = new Set(collections);
  const available = new Set(collectionInputs().map((input) => input.value));
  const missing = collections.filter((collection) => !available.has(collection));
  for (const input of collectionInputs()) {
    input.checked = requested.has(input.value);
  }
  updateCollectionSummary();
  populateMeasurementTypes();
  return missing;
}

async function restoreSharedView(state) {
  if (state.version !== 1) {
    throw new Error("This share link uses an unsupported view format");
  }
  if (!catalog) {
    throw new Error("The measurement catalog is not available");
  }
  const database = catalog.databases.find((item) => item.name === state.database);
  if (!database) {
    throw new Error(`Shared database is no longer available: ${state.database}`);
  }

  controls.database.value = database.name;
  populateCollections(true);
  const missingCollections = applySharedCollections(state.collections || []);
  if (!selectedCollections().length) {
    throw new Error("No collections from this shared view are still available");
  }
  if (!setSharedSelectValue(controls.measurement, state.measurement)) {
    throw new Error("Shared measurement type is no longer available");
  }

  applyCollectionRange();
  if (state.start) controls.start.value = inputTime(state.start);
  if (state.end) controls.end.value = inputTime(state.end);
  fittedSelection = "";

  const applied = await loadOptions({ selection: state });
  if (!applied) return;
  updateCdfButton();
  await loadMeasurements();
  updateShareButton();

  if (missingCollections.length) {
    setStatus(
      `${missingCollections.length} shared collection${missingCollections.length === 1 ? "" : "s"} is no longer available`
    );
  }
}

async function loadSharedViewFromLocation() {
  const identifier = sharedViewIdFromLocation();
  if (!identifier) return null;
  const payload = await getJSON(`/api/shared-views/${encodeURIComponent(identifier)}`);
  activeSharedViewId = payload.id;
  return payload.state;
}

function initializeSharedViews() {
  controls.share.addEventListener("click", shareCurrentView);
  document.addEventListener("change", (event) => {
    if (event.target.closest(".topbar, #map-tab")) markSharedViewChanged();
  });
  $("reset-time").addEventListener("click", markSharedViewChanged);
  $("clear-filters").addEventListener("click", markSharedViewChanged);
  updateShareButton();
}
