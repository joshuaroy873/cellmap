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

function makeCollectionActions(selectAllLabel, scope, curveId = "") {
  const actions = document.createElement("div");
  actions.className = "collection-actions";
  actions.append(selectAllLabel, makeCollectionPopoutButton(scope, curveId));
  return actions;
}

function inputTime(value) {
  return value ? value.slice(0, 19) : "";
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
    controls.collectionOptions.append(makeCollectionActions(selectAllLabel, "map"));
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

function updateCollectionPopoutCount() {
  const state = collectionPopoutState;
  if (!state) return;
  collectionPopoutControls.count.textContent =
    `${state.selected.size} of ${state.items.length} selected`;
}

function renderCollectionPopout() {
  const state = collectionPopoutState;
  if (!state) return;

  collectionPopoutControls.title.textContent =
    state.scope === "compare" ? "Select curve collections" : "Select collections";
  collectionPopoutControls.list.replaceChildren();

  for (const columnItems of collectionPopoutColumns(state.items)) {
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
  updateCollectionPopoutCount();
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
  renderCollectionPopout();
  if (!collectionPopoutControls.dialog.open) {
    collectionPopoutControls.dialog.showModal();
  }
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
  if (event.shiftKey && state.anchorIndex !== null) {
    const start = Math.min(state.anchorIndex, index);
    const end = Math.max(state.anchorIndex, index);
    if (!additive) state.selected.clear();
    for (let position = start; position <= end; position += 1) {
      state.selected.add(collectionItemValue(state.items[position]));
    }
  } else {
    const value = collectionItemValue(item);
    if (state.selected.has(value)) state.selected.delete(value);
    else state.selected.add(value);
    state.anchorIndex = index;
  }
  renderCollectionPopout();
}

function selectAllCollectionPopout() {
  const state = collectionPopoutState;
  if (!state) return;
  state.selected = new Set(state.items.map(collectionItemValue));
  state.anchorIndex = null;
  renderCollectionPopout();
}

function clearCollectionPopout() {
  const state = collectionPopoutState;
  if (!state) return;
  state.selected.clear();
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

function resetFilterOptions() {
  setSelect(controls.technology, [], "all", "All technologies");
  setSelect(controls.operator, [], "all", "All operators");
  setSelect(controls.band, [], "all", "All bands");
  setSelect(controls.pci, [], "all", "All PCIs");
  setSelect(controls.ssb, [], "all", "All SSB indexes");
  setSelect(controls.metric, [], null);
  updateCdfButton();
}
