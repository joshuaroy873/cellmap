"use strict";

const comparePalette = [
  { value: "#0072b2", label: "Blue" },
  { value: "#e69f00", label: "Orange" },
  { value: "#009e73", label: "Green" },
  { value: "#d55e00", label: "Red-orange" },
  { value: "#cc79a7", label: "Purple" },
  { value: "#56b4e9", label: "Sky blue" },
  { value: "#f0e442", label: "Yellow" },
  { value: "#000000", label: "Black" },
];

const compareStyles = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
  { value: "dashdot", label: "Dash-dot" },
];

const compareResetAfter = {
  collection: ["technology", "operator", "band", "pci", "ssb", "metric"],
  measurement: ["technology", "operator", "band", "pci", "ssb", "metric"],
  technology: ["operator", "band", "pci", "ssb", "metric"],
  operator: ["band", "pci", "ssb", "metric"],
  band: ["pci", "ssb", "metric"],
  pci: ["ssb", "metric"],
  ssb: ["metric"],
};

let compareOpenCollectionCurve = null;
const compareCollectionScroll = {};

function compareMeasurementItems() {
  return Object.entries(measurementLabels).map(([value, label]) => ({
    value,
    label,
  }));
}

function compareMetricCatalog(measurement) {
  return catalog?.measurements?.find((item) => item.value === measurement)
    ?.metrics || [];
}

function comparePlotItems() {
  return (catalog?.measurements || []).flatMap((measurement) =>
    measurement.metrics.map((metric) => ({
      value: `${measurement.value}:${metric.value}`,
      label: `${measurementLabels[measurement.value]}: ${metric.label}`,
    }))
  );
}

function comparePlotValue(curve) {
  return curve.measurement && curve.metric
    ? `${curve.measurement}:${curve.metric}`
    : "";
}

function compareCollectionItems() {
  return selectedCollections().map((collection) => ({
    value: collection,
    label: collection,
  }));
}

function compareSelectedCollections(curve) {
  if (Array.isArray(curve.collections)) return curve.collections;
  return curve.collection ? [curve.collection] : [];
}

function compareCollectionSummary(curve) {
  const collections = compareSelectedCollections(curve);
  const availableCount = compareCollectionItems().length;
  if (!availableCount) return "Select collection";
  if (!collections.length) return "Select collection";
  if (availableCount > 0 && collections.length === availableCount) {
    return "All selected collections";
  }
  if (collections.length === 1) return collections[0];
  return `${collections.length} of ${availableCount} collections`;
}

function compareItemValue(item) {
  return String(typeof item === "object" ? item.value : item);
}

function compareItemLabel(item) {
  return typeof item === "object" ? item.label : String(item);
}

function compareHasValue(items, value) {
  if (value === "all") return true;
  return items.some((item) => compareItemValue(item) === String(value));
}

function compareSelect(id, field, labelText, items, value, placeholder = null) {
  const label = document.createElement("label");
  label.textContent = labelText;

  const select = document.createElement("select");
  select.dataset.curveId = id;
  select.dataset.field = field;
  if (placeholder !== null) {
    const placeholderValue = placeholder.startsWith("All ") ? "all" : "";
    select.add(new Option(placeholder, placeholderValue));
  }
  for (const item of items) {
    select.add(new Option(compareItemLabel(item), compareItemValue(item)));
  }
  select.value = [...select.options].some((option) => option.value === String(value))
    ? value
    : select.options[0]?.value || "";
  label.append(select);
  return label;
}

function compareTextInput(id, field, labelText, value, placeholder = "") {
  const label = document.createElement("label");
  label.textContent = labelText;

  const input = document.createElement("input");
  input.dataset.curveId = id;
  input.dataset.field = field;
  input.placeholder = placeholder;
  input.value = value || "";
  label.append(input);
  return label;
}

function compareFilterItems(curve, name, fallback = []) {
  return curve.options?.[name] || fallback;
}

function compareCollectionOptionsElement(curveId) {
  const pickers = document.querySelectorAll(".compare-collection-picker");
  for (const picker of pickers) {
    if (picker.dataset.curveId === curveId) {
      return picker.querySelector(".collection-options");
    }
  }
  return null;
}

function rememberCompareCollectionScroll(curveId) {
  const options = compareCollectionOptionsElement(curveId);
  if (options) compareCollectionScroll[curveId] = options.scrollTop;
}

function restoreCompareCollectionScroll(curveId) {
  requestAnimationFrame(() => {
    const options = compareCollectionOptionsElement(curveId);
    if (options) options.scrollTop = compareCollectionScroll[curveId] || 0;
  });
}

function makeCompareCollectionPicker(curve) {
  const field = document.createElement("div");
  field.className = "collection-field compare-collection-field";

  const title = document.createElement("span");
  title.textContent = "Collection (subset)";

  const picker = document.createElement("details");
  picker.className = "collection-picker compare-collection-picker";
  picker.dataset.curveId = curve.id;
  picker.open = curve.id === compareOpenCollectionCurve;

  const summary = document.createElement("summary");
  summary.textContent = compareCollectionSummary(curve);
  summary.title = compareSelectedCollections(curve).join("\n");

  const options = document.createElement("div");
  options.className = "collection-options";

  const collections = compareCollectionItems();
  const selected = new Set(compareSelectedCollections(curve));
  if (collections.length) {
    const allLabel = document.createElement("label");
    allLabel.className = "collection-option collection-select-all";
    const allInput = document.createElement("input");
    allInput.type = "checkbox";
    allInput.dataset.curveId = curve.id;
    allInput.dataset.compareSelectAll = "";
    allInput.checked = selected.size > 0 && selected.size === collections.length;
    allInput.indeterminate = selected.size > 0 && selected.size < collections.length;
    const allText = document.createElement("span");
    allText.textContent = "Select all";
    allLabel.append(allInput, allText);
    options.append(makeCollectionActions(allLabel, "compare", curve.id));
  }

  for (const collection of collections) {
    const label = document.createElement("label");
    label.className = "collection-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = collection.value;
    checkbox.checked = selected.has(collection.value);
    checkbox.dataset.curveId = curve.id;
    checkbox.dataset.compareCollection = "";
    const text = document.createElement("span");
    text.textContent = collection.label;
    label.append(checkbox, text);
    options.append(label);
  }

  picker.append(summary, options);
  field.append(title, picker);
  return field;
}

function compareCurveDefaults() {
  const id = `curve_${++compareCurveNumber}`;
  const metrics = compareMetricCatalog("radio");
  return {
    id,
    label: "",
    collections: selectedCollections(),
    measurement: "radio",
    metric: metrics[0]?.value || "",
    technology: "all",
    operator: "all",
    band: "all",
    pci: "all",
    ssb: "all",
    color: comparePalette[(compareCurveNumber - 1) % comparePalette.length].value,
    style: "solid",
    options: null,
    optionRequest: 0,
  };
}

function resetCompareCurveFields(curve, changedField) {
  for (const field of compareResetAfter[changedField] || []) {
    curve[field] = field === "metric" ? "" : "all";
  }
}

function keepCompareSelection(curve, field, items, fallback = "all") {
  if (!compareHasValue(items, curve[field])) {
    curve[field] = fallback;
  }
}

function keepCompareMetric(curve, items) {
  if (!items.length) {
    curve.metric = "";
    return;
  }
  if (!compareHasValue(items, curve.metric)) {
    curve.metric = compareItemValue(items[0]);
  }
}

async function refreshCompareCurveOptions(curve) {
  const request = curve.optionRequest + 1;
  curve.optionRequest = request;
  const collections = compareSelectedCollections(curve);

  if (!controls.database.value || !collections.length) {
    curve.options = null;
    keepCompareMetric(curve, compareMetricCatalog(curve.measurement));
    return;
  }

  const params = {
    database: controls.database.value,
    collection: collections,
    measurement: curve.measurement,
    technology: curve.technology,
    operator: curve.operator,
    band: curve.band,
    pci: curve.pci,
    ssb: curve.ssb,
  };
  const payload = await getJSON("/api/options", params);
  if (curve.optionRequest !== request) return;

  curve.options = payload;
  keepCompareSelection(curve, "technology", payload.technologies);
  keepCompareSelection(curve, "operator", payload.operators);
  keepCompareSelection(curve, "band", payload.bands);
  keepCompareSelection(curve, "pci", payload.pcis);
  keepCompareSelection(curve, "ssb", payload.ssb_indexes);
  keepCompareMetric(curve, payload.metrics);
}

async function refreshAllCompareOptions() {
  await Promise.all(compareCurves.map((curve) => refreshCompareCurveOptions(curve)));
  renderCompareEntries();
}

function renderCompareEntries() {
  compareControls.entries.replaceChildren();
  for (const [index, curve] of compareCurves.entries()) {
    const card = document.createElement("article");
    card.className = "curve-card";

    const header = document.createElement("div");
    header.className = "curve-card-header";
    const title = document.createElement("strong");
    title.textContent = `Curve ${index + 1}`;
    const labelField = compareTextInput(
      curve.id, "label", "Label", curve.label, "Auto label"
    );
    labelField.className = "curve-label-field";
    header.append(title, makeCurvePreview(curve, "curve-preview"), labelField);

    const fields = document.createElement("div");
    fields.className = "curve-fields";
    const row1 = document.createElement("div");
    row1.className = "curve-row";
    row1.append(
      makeCompareCollectionPicker(curve),
      compareSelect(
        curve.id,
        "plot",
        "Metric",
        comparePlotItems(),
        comparePlotValue(curve),
        "Select metric"
      )
    );

    const row2 = document.createElement("div");
    row2.className = "curve-row";
    row2.append(
      compareSelect(curve.id, "technology", "Technology", compareFilterItems(
        curve, "technologies"
      ), curve.technology, "All technologies"),
      compareSelect(curve.id, "operator", "Operator", compareFilterItems(
        curve, "operators"
      ), curve.operator, "All operators")
    );

    const row3 = document.createElement("div");
    row3.className = "curve-row curve-row-three";
    row3.append(
      compareSelect(curve.id, "band", "Band", compareFilterItems(
        curve, "bands"
      ), curve.band, "All bands"),
      compareSelect(curve.id, "pci", "PCI", compareFilterItems(
        curve, "pcis"
      ), curve.pci, "All PCIs"),
      compareSelect(curve.id, "ssb", "SSB index", compareFilterItems(
        curve, "ssb_indexes"
      ), curve.ssb, "All SSB indexes")
    );

    const row4 = document.createElement("div");
    row4.className = "curve-row curve-row-actions";
    row4.append(
      compareSelect(curve.id, "color", "Color", comparePalette, curve.color),
      compareSelect(curve.id, "style", "Style", compareStyles, curve.style)
    );

    const copy = document.createElement("button");
    copy.className = "curve-copy";
    copy.type = "button";
    copy.dataset.curveId = curve.id;
    copy.dataset.action = "copy";
    copy.textContent = "Copy";

    const remove = document.createElement("button");
    remove.className = "curve-delete";
    remove.type = "button";
    remove.dataset.curveId = curve.id;
    remove.dataset.action = "delete";
    remove.textContent = "Delete";
    row4.append(copy, remove);

    fields.append(row1, row2, row3, row4);
    card.append(header, fields);
    compareControls.entries.append(card);
  }
}

function addCompareCurve() {
  if (compareCurves.length >= 20) return;
  const curve = compareCurveDefaults();
  compareCurves.push(curve);
  renderCompareEntries();
  refreshCompareCurveOptions(curve)
    .then(renderCompareEntries)
    .catch((error) => {
      compareControls.message.hidden = false;
      compareControls.message.textContent = error.message;
    });
}

function deleteCompareCurve(id) {
  compareCurves = compareCurves.filter((curve) => curve.id !== id);
  if (!compareCurves.length) addCompareCurve();
  else renderCompareEntries();
}

function copyCompareCurve(id) {
  if (compareCurves.length >= 20) return;
  const source = findCompareCurve(id);
  if (!source) return;

  const copy = {
    ...source,
    id: `curve_${++compareCurveNumber}`,
    collections: [...compareSelectedCollections(source)],
    color: comparePalette[(compareCurveNumber - 1) % comparePalette.length].value,
    options: source.options ? JSON.parse(JSON.stringify(source.options)) : null,
    optionRequest: 0,
  };
  compareCurves.push(copy);
  renderCompareEntries();
}

function findCompareCurve(id) {
  return compareCurves.find((curve) => curve.id === id);
}

function comparePromptText() {
  if (!controls.database.value) return "Select a database first.";
  if (!selectedCollections().length) {
    return "Select top-bar collections first.";
  }
  return "Add curves, then run compare.";
}

function showCompareMessage(message) {
  compareControls.message.hidden = false;
  compareControls.message.textContent = message;
}

function pruneCompareCollectionsToScope() {
  const available = new Set(compareCollectionItems().map((item) => item.value));
  let changed = false;

  for (const curve of compareCurves) {
    const current = compareSelectedCollections(curve);
    const collections = current.filter((collection) => available.has(collection));
    if (collections.length !== current.length) {
      curve.collections = collections;
      curve.options = null;
      changed = true;
    }
  }
  return changed;
}

async function applyCompareCollectionSelection(curveId, collections) {
  const curve = findCompareCurve(curveId);
  if (!curve) return;
  const entriesScrollTop = compareControls.entries.scrollTop;
  rememberCompareCollectionScroll(curve.id);

  curve.collections = [...collections];
  compareOpenCollectionCurve = curve.id;
  curve.options = null;

  try {
    await refreshCompareCurveOptions(curve);
  } catch (error) {
    compareControls.message.hidden = false;
    compareControls.message.textContent = error.message;
  }
  renderCompareEntries();
  compareControls.entries.scrollTop = entriesScrollTop;
  restoreCompareCollectionScroll(curve.id);
}

async function updateCompareCollections(input) {
  const curve = findCompareCurve(input.dataset.curveId);
  if (!curve) return;

  const selector = `input[data-compare-collection][data-curve-id="${curve.id}"]`;
  const collectionInputs = [...compareControls.entries.querySelectorAll(selector)];
  if ("compareSelectAll" in input.dataset) {
    for (const checkbox of collectionInputs) {
      checkbox.checked = input.checked;
    }
  }

  const collections = collectionInputs
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.value);
  await applyCompareCollectionSelection(curve.id, collections);
}

async function updateCompareCurve(event) {
  const collectionInput = event.target.closest(
    "input[data-compare-collection], input[data-compare-select-all]"
  );
  if (collectionInput) {
    await updateCompareCollections(collectionInput);
    return;
  }

  const target = event.target.closest("[data-curve-id][data-field]");
  if (!target) return;
  if (event.type === "input" && target.tagName !== "INPUT") return;
  if (event.type === "change" && target.tagName === "INPUT") return;

  const curve = findCompareCurve(target.dataset.curveId);
  if (!curve) return;

  const field = target.dataset.field;
  if (field === "plot") {
    const [measurement, metric] = target.value.split(":", 2);
    curve.measurement = measurement || "";
    curve.metric = metric || "";
    curve.options = null;
    if (!curve.measurement || !curve.metric) {
      renderCompareEntries();
      return;
    }
  } else {
    curve[field] = target.value;
  }
  if (field === "label") return;
  if (field === "measurement") {
    curve.options = null;
    keepCompareMetric(curve, compareMetricCatalog(curve.measurement));
  }

  if (["collection", "plot", "measurement", "technology", "operator", "band", "pci", "ssb"].includes(field)) {
    try {
      await refreshCompareCurveOptions(curve);
    } catch (error) {
      compareControls.message.hidden = false;
      compareControls.message.textContent = error.message;
    }
  }
  renderCompareEntries();
}

function compareRequestCurves() {
  return compareCurves
    .filter((curve) =>
      compareSelectedCollections(curve).length && curve.measurement && curve.metric
    )
    .map((curve) => ({
      id: curve.id,
      label: curve.label,
      collections: compareSelectedCollections(curve),
      measurement: curve.measurement,
      metric: curve.metric,
      technology: curve.technology,
      operator: curve.operator,
      band: curve.band,
      pci: curve.pci,
      ssb: curve.ssb,
      color: curve.color,
      style: curve.style,
    }));
}

async function runCompare() {
  if (!controls.database.value) {
    compareControls.message.hidden = false;
    compareControls.message.textContent = "Select a database first.";
    return;
  }

  const curves = compareRequestCurves();
  if (!curves.length) {
    compareControls.message.hidden = false;
    compareControls.message.textContent =
      "Complete at least one curve with collection and metric.";
    return;
  }

  const request = ++compareRequestNumber;
  compareControls.runButton.disabled = true;
  compareControls.message.hidden = false;
  compareControls.message.textContent = "Loading compare CDFs";
  compareControls.summary.textContent = "";
  compareControls.charts.replaceChildren();
  setStatus("Running compare");

  try {
    const payload = await postJSON("/api/compare/cdf", {
      database: controls.database.value,
      start: controls.start.value,
      end: controls.end.value,
      curves,
    });
    if (request !== compareRequestNumber) return;
    drawCompareCharts(payload);
    setStatus("");
  } catch (error) {
    if (request !== compareRequestNumber) return;
    compareControls.message.hidden = false;
    compareControls.message.textContent = error.message;
    setStatus("Compare failed");
  } finally {
    if (request === compareRequestNumber) {
      compareControls.runButton.disabled = false;
    }
  }
}

function refreshVisibleCompareOptions() {
  if (controls.database.value && activeTab === "compare") {
    refreshAllCompareOptions().catch((error) => {
      showCompareMessage(error.message);
    });
  }
}

function onCompareCollectionScopeChanged() {
  const pruned = pruneCompareCollectionsToScope();
  renderCompareEntries();
  refreshVisibleCompareOptions();

  if (!selectedCollections().length) {
    showCompareMessage(comparePromptText());
  } else if (pruned) {
    showCompareMessage("Collection scope changed. Run compare to update.");
  } else if (!comparePayload) {
    showCompareMessage(comparePromptText());
  }
}

function onCompareTabShown() {
  const pruned = pruneCompareCollectionsToScope();
  renderCompareEntries();
  refreshVisibleCompareOptions();

  if (!selectedCollections().length) {
    showCompareMessage(comparePromptText());
  } else if (pruned) {
    showCompareMessage("Collection scope changed. Run compare to update.");
  } else if (!comparePayload) {
    showCompareMessage(comparePromptText());
  }
}

function onCompareDatabaseChanged() {
  for (const curve of compareCurves) {
    curve.collections = [];
    curve.options = null;
    resetCompareCurveFields(curve, "collection");
  }
  comparePayload = null;
  compareControls.charts.replaceChildren();
  compareControls.summary.textContent = "";
  showCompareMessage(comparePromptText());
  renderCompareEntries();
  refreshVisibleCompareOptions();
}

function initializeCompare() {
  if (!compareCurves.length) addCompareCurve();
  compareControls.entries.addEventListener("input", updateCompareCurve);
  compareControls.entries.addEventListener("change", updateCompareCurve);
  compareControls.entries.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action='delete']");
    if (button) {
      deleteCompareCurve(button.dataset.curveId);
      return;
    }
    const copy = event.target.closest("[data-action='copy']");
    if (copy) {
      copyCompareCurve(copy.dataset.curveId);
    }
  });
  compareControls.addButton.addEventListener("click", addCompareCurve);
  compareControls.runButton.addEventListener("click", runCompare);
  document.addEventListener("click", (event) => {
    const clickedPicker = event.target.closest?.(".compare-collection-picker");
    if (clickedPicker) {
      compareOpenCollectionCurve = clickedPicker.dataset.curveId;
      return;
    }
    compareOpenCollectionCurve = null;
    for (const picker of document.querySelectorAll(".compare-collection-picker")) {
      picker.open = false;
    }
  });
}
