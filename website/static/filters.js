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

function resetFilterOptions() {
  setSelect(controls.technology, [], "all", "All technologies");
  setSelect(controls.operator, [], "all", "All operators");
  setSelect(controls.band, [], "all", "All bands");
  setSelect(controls.pci, [], "all", "All PCIs");
  setSelect(controls.ssb, [], "all", "All SSB indexes");
  setSelect(controls.metric, [], null);
  updateCdfButton();
}
