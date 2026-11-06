"use strict";

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
    controls.metric.value && !optionsPending
  );
  updateShareButton();
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

function databaseCollections() {
  return currentDatabase()?.collections || [];
}

function collectionItemLabel(item) {
  return typeof item === "object" ? item.label : String(item);
}

function collectionItemValue(item) {
  return typeof item === "object" ? item.value : String(item);
}

function sortCollectionItems(items) {
  return [...items].sort((left, right) =>
    collectionItemLabel(left).localeCompare(
      collectionItemLabel(right),
      undefined,
      { numeric: true, sensitivity: "base" }
    )
  );
}

function mapCollectionItems() {
  return databaseCollections().map((collection) => ({
    value: collection.name,
    label: collection.name,
  }));
}

function makeCollectionPopoutButton(scope, curveId = "") {
  const button = document.createElement("button");
  button.className = "collection-popout-button";
  button.type = "button";
  button.dataset.collectionPopout = "";
  button.dataset.collectionScope = scope;
  if (curveId) button.dataset.curveId = curveId;
  button.textContent = "Pop out";
  return button;
}

function makeCollectionSearch(curveId = "", query = "") {
  const search = document.createElement("input");
  search.className = "collection-search";
  search.type = "search";
  search.placeholder = "Search";
  search.autocomplete = "off";
  search.setAttribute("aria-label", "Search collections");
  search.dataset.collectionSearch = "";
  if (curveId) search.dataset.curveId = curveId;
  search.value = query;
  return search;
}

function makeCollectionActions(selectAllLabel, scope, curveId = "", query = "") {
  const actions = document.createElement("div");
  actions.className = "collection-actions";
  actions.append(
    selectAllLabel,
    makeCollectionSearch(curveId, query),
    makeCollectionPopoutButton(scope, curveId)
  );
  return actions;
}

// Hides the names in an in-place picker that do not match its search box.
function applyCollectionSearch(options) {
  const search = options?.querySelector("[data-collection-search]");
  if (!search) return;
  const query = search.value.trim().toLowerCase();
  for (const label of options.querySelectorAll(".collection-option")) {
    if (label.classList.contains("collection-select-all")) continue;
    label.hidden = query !== "" && !label.textContent.toLowerCase().includes(query);
  }
}

// Inputs still shown after the search filter; "Select all" acts on these.
function shownCollectionInputs(inputs) {
  return inputs.filter((input) => !input.closest("label")?.hidden);
}

function collectionSearchQuery(options) {
  return options?.querySelector("[data-collection-search]")?.value || "";
}

function initializeCollectionSearch() {
  document.addEventListener("input", (event) => {
    const search = event.target.closest?.("[data-collection-search]");
    if (search) applyCollectionSearch(search.closest(".collection-options"));
  });
  document.addEventListener("keydown", (event) => {
    const search = event.target.closest?.("[data-collection-search]");
    if (!search) return;
    if (event.key === "Enter") {
      event.preventDefault();
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (search.value) {
        search.value = "";
        applyCollectionSearch(search.closest(".collection-options"));
      } else {
        const picker = search.closest("details");
        if (picker) picker.open = false;
      }
    }
  });
}

function inputTime(value) {
  return value ? value.replace(" ", "T").replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "") : "";
}

function applyRange(collections) {
  const starts = collections.map((item) => item.start).filter(Boolean);
  const ends = collections.map((item) => item.end).filter(Boolean);
  controls.start.value = inputTime(starts.sort()[0]);
  controls.end.value = inputTime(ends.sort().at(-1));
}

function applyCollectionRange() {
  applyRange(currentCollections());
}

function applyDatabaseRange() {
  applyRange(databaseCollections());
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
  const query = reset ? "" : collectionSearchQuery(controls.collectionOptions);

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
    controls.collectionOptions.append(
      makeCollectionActions(selectAllLabel, "map", "", query)
    );
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
  applyCollectionSearch(controls.collectionOptions);
  updateCollectionSummary();
  populateMeasurementTypes();
}

// The hidden <select id="database"> stays the source of truth; this picker
// mirrors its options and sets its value, so every reader of
// controls.database and the "change" listener keep working unchanged.
function databaseNames() {
  return [...controls.database.options].map((option) => option.value).filter(Boolean);
}

function renderDatabasePicker() {
  const current = controls.database.value;
  controls.databaseSummary.textContent = current || "Select database";
  controls.databaseSummary.title = current;

  const query = controls.databaseSearch.value.trim().toLowerCase();
  const shown = databaseNames().filter((name) => name.toLowerCase().includes(query));
  controls.databaseList.replaceChildren();
  if (!shown.length) {
    const empty = document.createElement("p");
    empty.className = "database-empty";
    empty.textContent = databaseNames().length
      ? "No databases match the search."
      : "No databases available.";
    controls.databaseList.append(empty);
    return;
  }
  for (const name of shown) {
    const option = document.createElement("button");
    option.className = "database-option";
    option.type = "button";
    option.dataset.value = name;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", name === current ? "true" : "false");
    option.classList.toggle("selected", name === current);
    option.textContent = name;
    controls.databaseList.append(option);
  }
}

function chooseDatabase(name) {
  controls.databasePicker.open = false;
  if (name === controls.database.value) {
    renderDatabasePicker();
    return;
  }
  controls.database.value = name;
  renderDatabasePicker();
  controls.database.dispatchEvent(new Event("change", { bubbles: true }));
}

function initializeDatabasePicker() {
  controls.databasePicker.addEventListener("toggle", () => {
    if (!controls.databasePicker.open) return;
    controls.databaseSearch.value = "";
    renderDatabasePicker();
    controls.databaseSearch.focus();
  });

  controls.databaseSearch.addEventListener("input", renderDatabasePicker);
  controls.databaseSearch.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const first = controls.databaseList.querySelector(".database-option");
      if (first) chooseDatabase(first.dataset.value);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      controls.databaseList.querySelector(".database-option")?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      controls.databasePicker.open = false;
      controls.databaseSummary.focus();
    }
  });

  controls.databaseList.addEventListener("click", (event) => {
    const option = event.target.closest(".database-option");
    if (option) chooseDatabase(option.dataset.value);
  });
  controls.databaseList.addEventListener("keydown", (event) => {
    const option = event.target.closest(".database-option");
    if (!option) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const sibling = event.key === "ArrowDown"
        ? option.nextElementSibling
        : option.previousElementSibling;
      (sibling ?? controls.databaseSearch).focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      controls.databasePicker.open = false;
      controls.databaseSummary.focus();
    }
  });

  // Keep the summary in step with programmatic changes (share links).
  controls.database.addEventListener("change", renderDatabasePicker);
  renderDatabasePicker();
}

function collectionPopoutItems(scope) {
  if (scope === "compare") return sortCollectionItems(compareCollectionItems());
  return sortCollectionItems(mapCollectionItems());
}

function collectionPopoutSelected(scope, curveId) {
  if (scope === "compare") {
    const curve = findCompareCurve(curveId);
    return curve ? compareSelectedCollections(curve) : [];
  }
  return selectedCollections();
}

function collectionPopoutColumns(items) {
  if (!items.length) return [];
  const columnCount = Math.min(5, Math.max(1, Math.ceil(items.length / 24)));
  const rowsPerColumn = Math.ceil(items.length / columnCount);
  return Array.from({ length: columnCount }, (_, index) =>
    items.slice(index * rowsPerColumn, (index + 1) * rowsPerColumn)
  );
}

function collectionPopoutQuery() {
  return collectionPopoutControls.search.value.trim().toLowerCase();
}

// Items matching the search box, in list order; all items when the box is empty.
function collectionPopoutVisibleItems(state) {
  const query = collectionPopoutQuery();
  if (!query) return state.items;
  return state.items.filter((item) =>
    collectionItemLabel(item).toLowerCase().includes(query)
  );
}

function updateCollectionPopoutCount(visibleCount) {
  const state = collectionPopoutState;
  if (!state) return;
  const filtered = collectionPopoutQuery() !== "";
  collectionPopoutControls.count.textContent = filtered
    ? `${state.selected.size} of ${state.items.length} selected · ${visibleCount} shown`
    : `${state.selected.size} of ${state.items.length} selected`;
  collectionPopoutControls.allButton.textContent = filtered ? "Select shown" : "Select all";
  collectionPopoutControls.clearButton.textContent = filtered ? "Clear shown" : "Clear";
}

function renderCollectionPopout() {
  const state = collectionPopoutState;
  if (!state) return;

  collectionPopoutControls.title.textContent =
    state.scope === "compare" ? "Select collection subset" : "Select collections";
  collectionPopoutControls.list.replaceChildren();

  const visible = collectionPopoutVisibleItems(state);
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "collection-popout-empty";
    empty.textContent = state.items.length
      ? "No collections match the search."
      : "No collections available.";
    collectionPopoutControls.list.append(empty);
  }

  for (const columnItems of collectionPopoutColumns(visible)) {
    const column = document.createElement("div");
    column.className = "collection-popout-column";

    for (const item of columnItems) {
      const value = collectionItemValue(item);
      const option = document.createElement("button");
      option.className = "collection-popout-item";
      option.type = "button";
      option.dataset.index = String(state.items.indexOf(item));
      option.dataset.value = value;
      option.setAttribute("role", "option");
      option.setAttribute(
        "aria-selected",
        state.selected.has(value) ? "true" : "false"
      );
      option.classList.toggle("selected", state.selected.has(value));
      option.textContent = collectionItemLabel(item);
      column.append(option);
    }

    collectionPopoutControls.list.append(column);
  }
  updateCollectionPopoutCount(visible.length);
}

function openCollectionPopout(scope, curveId = "") {
  const items = collectionPopoutItems(scope);
  collectionPopoutState = {
    scope,
    curveId,
    items,
    selected: new Set(collectionPopoutSelected(scope, curveId)),
    anchorIndex: null,
  };
  collectionPopoutControls.search.value = "";
  renderCollectionPopout();
  if (!collectionPopoutControls.dialog.open) {
    collectionPopoutControls.dialog.showModal();
  }
  collectionPopoutControls.search.focus();
}

function closeCollectionPopout() {
  if (collectionPopoutControls.dialog.open) {
    collectionPopoutControls.dialog.close();
  }
  collectionPopoutState = null;
}

function selectCollectionPopoutIndex(index, event) {
  const state = collectionPopoutState;
  if (!state) return;
  const item = state.items[index];
  if (!item) return;

  const additive = event.ctrlKey || event.metaKey;
  const visible = collectionPopoutVisibleItems(state);
  const anchorVisible = state.anchorIndex === null
    ? -1
    : visible.indexOf(state.items[state.anchorIndex]);
  const clickedVisible = visible.indexOf(item);
  if (event.shiftKey && anchorVisible >= 0 && clickedVisible >= 0) {
    const start = Math.min(anchorVisible, clickedVisible);
    const end = Math.max(anchorVisible, clickedVisible);
    if (!additive) state.selected.clear();
    for (let position = start; position <= end; position += 1) {
      state.selected.add(collectionItemValue(visible[position]));
    }
  } else {
    const value = collectionItemValue(item);
    if (state.selected.has(value)) state.selected.delete(value);
    else state.selected.add(value);
    state.anchorIndex = index;
  }
  renderCollectionPopout();
}

// With a search active, Select all / Clear act only on the shown collections.
function selectAllCollectionPopout() {
  const state = collectionPopoutState;
  if (!state) return;
  for (const item of collectionPopoutVisibleItems(state)) {
    state.selected.add(collectionItemValue(item));
  }
  state.anchorIndex = null;
  renderCollectionPopout();
}

function clearCollectionPopout() {
  const state = collectionPopoutState;
  if (!state) return;
  for (const item of collectionPopoutVisibleItems(state)) {
    state.selected.delete(collectionItemValue(item));
  }
  state.anchorIndex = null;
  renderCollectionPopout();
}

async function applyCollectionPopout() {
  const state = collectionPopoutState;
  if (!state) return;
  const selected = state.items
    .filter((item) => state.selected.has(collectionItemValue(item)))
    .map(collectionItemValue);

  closeCollectionPopout();
  if (state.scope === "compare") {
    await applyCompareCollectionSelection(state.curveId, selected);
  } else {
    await applyMapCollectionSelection(selected);
  }
}

function initializeCollectionPopout() {
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-collection-popout]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    openCollectionPopout(
      button.dataset.collectionScope,
      button.dataset.curveId || ""
    );
  });

  collectionPopoutControls.list.addEventListener("click", (event) => {
    const item = event.target.closest(".collection-popout-item");
    if (!item) return;
    selectCollectionPopoutIndex(Number(item.dataset.index), event);
  });

  collectionPopoutControls.list.addEventListener("keydown", (event) => {
    if (event.key !== " " && event.key !== "Enter") return;
    const item = event.target.closest(".collection-popout-item");
    if (!item) return;
    event.preventDefault();
    selectCollectionPopoutIndex(Number(item.dataset.index), event);
  });

  collectionPopoutControls.search.addEventListener("input", renderCollectionPopout);
  collectionPopoutControls.search.addEventListener("keydown", (event) => {
    // Escape clears the search first; a second Escape closes the dialog.
    if (event.key === "Escape" && collectionPopoutControls.search.value) {
      event.preventDefault();
      collectionPopoutControls.search.value = "";
      renderCollectionPopout();
    }
  });

  collectionPopoutControls.allButton.addEventListener("click", selectAllCollectionPopout);
  collectionPopoutControls.clearButton.addEventListener("click", clearCollectionPopout);
  collectionPopoutControls.cancelButton.addEventListener("click", closeCollectionPopout);
  collectionPopoutControls.closeButton.addEventListener("click", closeCollectionPopout);
  collectionPopoutControls.applyButton.addEventListener("click", () => {
    applyCollectionPopout().catch((error) => {
      setStatus(error.message);
    });
  });
  collectionPopoutControls.dialog.addEventListener("click", (event) => {
    if (event.target === collectionPopoutControls.dialog) {
      closeCollectionPopout();
    }
  });
  collectionPopoutControls.dialog.addEventListener("close", () => {
    collectionPopoutState = null;
  });
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

// Filter choices and measurements arrive in one /api/view round trip. The
// server validates the requested filter values against the available choices
// and returns the values it actually applied.
async function loadView({ resetFilters = false, selection = null } = {}) {
  if (activeTab !== "map") return false;
  if (!controls.database.value || !selectedCollections().length) return false;
  if (resetFilters) {
    for (const name of ["technology", "operator", "band", "pci", "ssb"]) {
      controls[name].value = "all";
    }
  }
  const params = measurementParams();
  if (selection) {
    for (const name of ["technology", "operator", "band", "pci", "ssb", "metric"]) {
      params[name] = selection[name] || "all";
    }
  }
  if (!selection && lastMapPayload
      && JSON.stringify(optionParams()) === lastOptionsKey
      && JSON.stringify(params) === lastMapKey) {
    showCachedMeasurements();
    return true;
  }
  const request = ++optionRequestNumber;
  requestNumber += 1;
  optionController?.abort();
  measurementController?.abort();
  optionController = new AbortController();
  optionsPending = true;
  updateCdfButton();
  setStatus("Loading measurements");
  setMapMessage("Loading measurements");
  try {
    const payload = await getJSON("/api/view", params, optionController.signal);
    if (request !== optionRequestNumber || activeTab !== "map") return false;
    options = payload.options;
    const selected = payload.selected;
    setSelect(controls.technology, options.technologies, selected.technology ?? "all", "All technologies");
    setSelect(controls.operator, options.operators, selected.operator ?? "all", "All operators");
    setSelect(controls.band, options.bands, selected.band ?? "all", "All bands");
    setSelect(controls.pci, options.pcis, selected.pci ?? "all", "All PCIs");
    setSelect(controls.ssb, options.ssb_indexes, selected.ssb ?? "all", "All SSB indexes");
    setSelect(controls.metric, options.metrics, selected.metric ?? "");
    lastOptionsKey = JSON.stringify(optionParams());
    optionsPending = false;
    if (!payload.measurements) {
      showSelectionPrompt("No metrics are available for these filters.");
      return true;
    }
    lastMapKey = JSON.stringify(measurementParams());
    payload.measurements.request = measurementParams();
    lastMapPayload = payload.measurements;
    showMeasurementPayload(payload.measurements);
    return true;
  } finally {
    if (request === optionRequestNumber) {
      optionsPending = false;
      updateCdfButton();
    }
  }
}

function resetFilterOptions() {
  lastOptionsKey = "";
  setSelect(controls.technology, [], "all", "All technologies");
  setSelect(controls.operator, [], "all", "All operators");
  setSelect(controls.band, [], "all", "All bands");
  setSelect(controls.pci, [], "all", "All PCIs");
  setSelect(controls.ssb, [], "all", "All SSB indexes");
  setSelect(controls.metric, [], null);
  updateCdfButton();
}
