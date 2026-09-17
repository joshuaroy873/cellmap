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

const MAX_COMPARE_CURVES = 20;

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

function invalidateCompareResults() {
  const hadResults = comparePayload || compareRunPending;
  compareRequestNumber += 1;
  compareController?.abort();
  compareRunPending = false;
  comparePayload = null;
  clearCompareCharts();
  compareControls.summary.textContent = "";
  if (hadResults) {
    showCompareMessage("Settings changed. Run compare to update.");
    if (activeTab === "compare") setStatus("Configure compare curves");
  }
  updateCompareActionButtons();
}

function cancelCompareOptions(curve) {
  curve.optionRequest += 1;
  curve.optionController?.abort();
  curve.optionsPending = false;
  curve.optionsKey = "";
}

function compareVisualDefaults(curveNumber) {
  const visualIndex = curveNumber - 1;
  const color = comparePalette[visualIndex % comparePalette.length].value;
  const styleIndex = Math.floor(visualIndex / comparePalette.length);
  const style = compareStyles[styleIndex % compareStyles.length].value;
  return { color, style };
}

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
  const visual = compareVisualDefaults(compareCurveNumber);
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
    color: visual.color,
    style: visual.style,
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
  const collections = compareSelectedCollections(curve);

  if (!controls.database.value || !collections.length) {
    cancelCompareOptions(curve);
    curve.options = null;
    keepCompareMetric(curve, compareMetricCatalog(curve.measurement));
    updateCompareActionButtons();
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
  const key = JSON.stringify(params);
  if (curve.options && curve.optionsKey === key) {
    curve.optionRequest += 1;
    curve.optionController?.abort();
    curve.optionsPending = false;
    updateCompareActionButtons();
    return;
  }
  const request = ++curve.optionRequest;
  curve.optionController?.abort();
  curve.optionController = new AbortController();
  curve.optionsPending = true;
  updateCompareActionButtons();
  try {
    const payload = await getJSON("/api/options", params, curve.optionController.signal);
    if (curve.optionRequest !== request || findCompareCurve(curve.id) !== curve) return;
    curve.options = payload;
    keepCompareSelection(curve, "technology", payload.technologies);
    keepCompareSelection(curve, "operator", payload.operators);
    keepCompareSelection(curve, "band", payload.bands);
    keepCompareSelection(curve, "pci", payload.pcis);
    keepCompareSelection(curve, "ssb", payload.ssb_indexes);
    keepCompareMetric(curve, payload.metrics);
    for (const field of ["technology", "operator", "band", "pci", "ssb"]) {
      params[field] = curve[field];
    }
    curve.optionsKey = JSON.stringify(params);
  } catch (error) {
    if (curve.optionRequest === request && error.name !== "AbortError") throw error;
  } finally {
    if (curve.optionRequest === request) {
      curve.optionsPending = false;
      updateCompareActionButtons();
    }
  }
}

async function refreshAllCompareOptions() {
  await Promise.all(compareCurves.map((curve) => refreshCompareCurveOptions(curve)));
  renderCompareEntries();
}

function syncCompareCurveUiState() {
  const ids = new Set(compareCurves.map((curve) => curve.id));
  selectedCompareCurveIds = new Set(
    [...selectedCompareCurveIds].filter((id) => ids.has(id))
  );
  collapsedCompareCurveIds = new Set(
    [...collapsedCompareCurveIds].filter((id) => ids.has(id))
  );
}

function allCompareCurvesSelected() {
  return compareCurves.length > 0
    && compareCurves.every((curve) => selectedCompareCurveIds.has(curve.id));
}

function updateCompareActionButtons() {
  compareControls.runButton.disabled = compareRunPending
    || compareCurves.some((curve) => curve.optionsPending);
  const hasSelection = selectedCompareCurveIds.size > 0;
  const hasCurves = compareCurves.length > 0;
  const allSelected = allCompareCurvesSelected();
  const canAdd = compareCurves.length < MAX_COMPARE_CURVES;
  compareControls.selectAllButton.disabled = !hasCurves;
  compareControls.selectAllButton.textContent = allSelected
    ? "Clear selection"
    : "Select all";
  compareControls.copyButton.disabled = !hasSelection || !canAdd;
  compareControls.deleteButton.disabled = !hasSelection;
  compareControls.addButton.disabled = !canAdd;
}

function cloneCompareCurve(source) {
  const id = `curve_${++compareCurveNumber}`;
  const visual = compareVisualDefaults(compareCurveNumber);
  return {
    ...source,
    id,
    collections: [...compareSelectedCollections(source)],
    color: visual.color,
    style: visual.style,
    options: source.options ? JSON.parse(JSON.stringify(source.options)) : null,
    optionRequest: 0,
    optionController: null,
    optionsPending: false,
    optionsKey: source.optionsPending ? "" : source.optionsKey,
  };
}

function compareCardSignature(curve) {
  return JSON.stringify([
    curve.collections, curve.measurement, curve.metric,
    curve.technology, curve.operator, curve.band, curve.pci, curve.ssb,
    curve.color, curve.style, selectedCollections(),
  ]);
}

function renderCompareEntries() {
  syncCompareCurveUiState();
  const existing = new Map([...compareControls.entries.children]
    .map((card) => [card.dataset.curveId, card]));
  for (const [id, card] of existing) {
    if (!findCompareCurve(id)) card.remove();
  }
  for (const [index, curve] of compareCurves.entries()) {
    const collapsed = collapsedCompareCurveIds.has(curve.id);
    const isSelected = selectedCompareCurveIds.has(curve.id);
    const signature = compareCardSignature(curve);
    const previous = existing.get(curve.id);
    if (previous && previous.renderSignature === signature
        && previous.renderOptions === curve.options
        && (collapsed || previous.querySelector(".curve-fields"))) {
      previous.classList.toggle("collapsed", collapsed);
      previous.classList.toggle("selected", isSelected);
      previous.querySelector(".curve-select").checked = isSelected;
      previous.querySelector("strong").textContent = `Curve ${index + 1}`;
      const toggle = previous.querySelector(".curve-collapse");
      toggle.classList.toggle("expanded", !collapsed);
      toggle.title = collapsed ? "Expand curve" : "Collapse curve";
      toggle.setAttribute("aria-label", toggle.title);
      continue;
    }
    const card = document.createElement("article");
    card.className = "curve-card";
    card.dataset.curveId = curve.id;
    card.renderSignature = signature;
    card.renderOptions = curve.options;
    card.classList.toggle("collapsed", collapsed);
    card.classList.toggle("selected", isSelected);

    const header = document.createElement("div");
    header.className = "curve-card-header";
    const selected = document.createElement("input");
    selected.className = "curve-select";
    selected.type = "checkbox";
    selected.dataset.curveId = curve.id;
    selected.dataset.curveSelect = "";
    selected.checked = isSelected;
    const toggle = document.createElement("button");
    toggle.className = "curve-collapse";
    toggle.type = "button";
    toggle.dataset.curveId = curve.id;
    toggle.dataset.curveToggle = "";
    toggle.classList.toggle("expanded", !collapsed);
    toggle.textContent = ">";
    toggle.title = collapsed ? "Expand curve" : "Collapse curve";
    toggle.setAttribute("aria-label", toggle.title);
    const title = document.createElement("strong");
    title.textContent = `Curve ${index + 1}`;
    const labelField = compareTextInput(
      curve.id, "label", "Label", curve.label, "Auto label"
    );
    labelField.className = "curve-label-field";
    header.append(
      toggle,
      selected,
      title,
      makeCurvePreview(curve, "curve-preview"),
      labelField
    );

    card.append(header);
    if (previous) previous.replaceWith(card);
    else compareControls.entries.append(card);
    // Build hidden filter controls only when the curve is expanded.
    if (collapsed) continue;

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
    card.append(fields);
  }
  updateCompareActionButtons();
}

function addCompareCurve(selectNew = true) {
  if (compareCurves.length >= MAX_COMPARE_CURVES) return;
  invalidateCompareResults();
  const curve = compareCurveDefaults();
  compareCurves.push(curve);
  if (selectNew) {
    selectedCompareCurveIds = new Set([curve.id]);
  }
  renderCompareEntries();
  refreshCompareCurveOptions(curve)
    .then(renderCompareEntries)
    .catch((error) => {
      compareControls.message.hidden = false;
      compareControls.message.textContent = error.message;
    });
}

function deleteCompareCurve(id) {
  deleteCompareCurves([id]);
}

function copyCompareCurve(id) {
  copyCompareCurves([id]);
}

function deleteCompareCurves(ids) {
  const idsToDelete = new Set(ids);
  if (!idsToDelete.size) return;
  invalidateCompareResults();
  for (const curve of compareCurves) {
    if (idsToDelete.has(curve.id)) cancelCompareOptions(curve);
  }

  compareCurves = compareCurves.filter(
    (curve) => !idsToDelete.has(curve.id)
  );
  for (const id of idsToDelete) {
    selectedCompareCurveIds.delete(id);
    collapsedCompareCurveIds.delete(id);
    delete compareCollectionScroll[id];
  }

  if (!compareCurves.length) {
    addCompareCurve();
  } else {
    renderCompareEntries();
  }
}

function copyCompareCurves(ids) {
  const idsToCopy = new Set(ids);
  if (!idsToCopy.size || compareCurves.length >= MAX_COMPARE_CURVES) return;

  const copies = [];
  for (const curve of compareCurves) {
    if (!idsToCopy.has(curve.id)) continue;
    if (compareCurves.length + copies.length >= MAX_COMPARE_CURVES) break;
    copies.push(cloneCompareCurve(curve));
  }
  if (!copies.length) return;

  invalidateCompareResults();
  compareCurves.push(...copies);
  selectedCompareCurveIds = new Set(copies.map((curve) => curve.id));
  renderCompareEntries();
  refreshVisibleCompareOptions();
}

function deleteSelectedCompareCurves() {
  deleteCompareCurves(selectedCompareCurveIds);
}

function copySelectedCompareCurves() {
  copyCompareCurves(selectedCompareCurveIds);
}

function selectAllCompareCurves() {
  if (allCompareCurvesSelected()) {
    selectedCompareCurveIds.clear();
  } else {
    selectedCompareCurveIds = new Set(compareCurves.map((curve) => curve.id));
  }
  renderCompareEntries();
}

function toggleCompareCurveCollapsed(id) {
  if (collapsedCompareCurveIds.has(id)) {
    collapsedCompareCurveIds.delete(id);
  } else {
    collapsedCompareCurveIds.add(id);
  }
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
  invalidateCompareResults();
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
  const curveSelect = event.target.closest("input[data-curve-select]");
  if (curveSelect) {
    if (event.type !== "change") return;
    if (curveSelect.checked) {
      selectedCompareCurveIds.add(curveSelect.dataset.curveId);
    } else {
      selectedCompareCurveIds.delete(curveSelect.dataset.curveId);
    }
    renderCompareEntries();
    return;
  }

  const collectionInput = event.target.closest(
    "input[data-compare-collection], input[data-compare-select-all]"
  );
  if (collectionInput) {
    if (event.type !== "change") return;
    await updateCompareCollections(collectionInput);
    return;
  }

  const target = event.target.closest("[data-curve-id][data-field]");
  if (!target) return;
  if (event.type === "input" && target.tagName !== "INPUT") return;
  if (event.type === "change" && target.tagName === "INPUT") return;

  const curve = findCompareCurve(target.dataset.curveId);
  if (!curve) return;
  invalidateCompareResults();

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
  if (compareCurves.some((curve) => curve.optionsPending)) return;
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
  compareController?.abort();
  compareController = new AbortController();
  compareRunPending = true;
  comparePayload = null;
  updateCompareActionButtons();
  compareControls.message.hidden = false;
  compareControls.message.textContent = "Loading compare CDFs";
  compareControls.summary.textContent = "";
  clearCompareCharts();
  setStatus("Running compare");

  try {
    const payload = await postJSON("/api/compare/cdf", {
      database: controls.database.value,
      start: controls.start.value,
      end: controls.end.value,
      curves,
    }, compareController.signal);
    if (request !== compareRequestNumber) return;
    drawCompareCharts(payload);
    if (activeTab === "compare") setStatus("");
  } catch (error) {
    if (request !== compareRequestNumber || error.name === "AbortError") return;
    compareControls.message.hidden = false;
    compareControls.message.textContent = error.message;
    if (activeTab === "compare") setStatus("Compare failed");
  } finally {
    if (request === compareRequestNumber) {
      compareRunPending = false;
      updateCompareActionButtons();
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
  invalidateCompareResults();
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
  if (pruned) invalidateCompareResults();
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
  invalidateCompareResults();
  selectedCompareCurveIds.clear();
  collapsedCompareCurveIds.clear();
  for (const curve of compareCurves) {
    cancelCompareOptions(curve);
    curve.collections = [];
    curve.options = null;
    resetCompareCurveFields(curve, "collection");
  }
  compareControls.summary.textContent = "";
  showCompareMessage(comparePromptText());
  renderCompareEntries();
  refreshVisibleCompareOptions();
}

function initializeCompare() {
  if (!compareCurves.length) addCompareCurve(false);
  compareControls.entries.addEventListener("input", updateCompareCurve);
  compareControls.entries.addEventListener("change", updateCompareCurve);
  compareControls.entries.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]");
    if (action?.dataset.action === "delete") {
      deleteCompareCurve(action.dataset.curveId);
      return;
    }
    if (action?.dataset.action === "copy") {
      copyCompareCurve(action.dataset.curveId);
      return;
    }

    const toggle = event.target.closest("button[data-curve-toggle]");
    if (toggle) toggleCompareCurveCollapsed(toggle.dataset.curveId);
  });
  compareControls.selectAllButton.addEventListener("click", selectAllCompareCurves);
  compareControls.copyButton.addEventListener("click", copySelectedCompareCurves);
  compareControls.deleteButton.addEventListener("click", deleteSelectedCompareCurves);
  compareControls.addButton.addEventListener("click", () => addCompareCurve());
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
