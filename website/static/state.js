"use strict";

const $ = (id) => document.getElementById(id);

// Start/End are a native date picker plus a 24-hour HH:MM text field: native
// time pickers follow the operating-system locale and may show a 12-hour
// clock with seconds. Each field behaves like one input whose value is
// "YYYY-MM-DDTHH:MM" (or "" when no date is set).
function timeField(dateId, clockId, emptyClock) {
  const date = $(dateId);
  const clock = $(clockId);
  const normalizeClock = () => {
    const text = clock.value.trim();
    if (!text) {
      clock.value = "";
      clock.dataset.last = "";
      return true;
    }
    const match = /^(\d{1,2})(?::?(\d{2}))?$/.exec(text);
    const hours = match ? Number(match[1]) : NaN;
    const minutes = match ? Number(match[2] ?? "0") : NaN;
    if (!match || hours > 23 || minutes > 59) {
      clock.value = clock.dataset.last || "";
      setStatus("Enter the time as HH:MM (24-hour)");
      return false;
    }
    clock.value = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    clock.dataset.last = clock.value;
    return true;
  };
  return {
    get value() {
      if (!date.value) return "";
      return `${date.value}T${clock.value || emptyClock}`;
    },
    set value(text) {
      const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(text || "");
      date.value = match ? match[1] : "";
      clock.value = match ? match[2] : "";
      clock.dataset.last = clock.value;
    },
    addEventListener(type, listener) {
      date.addEventListener(type, listener);
      clock.addEventListener(type, (event) => {
        if (normalizeClock()) listener(event);
      });
    },
  };
}

const controls = {
  database: $("database"),
  databasePicker: document.querySelector(".database-picker"),
  databaseSummary: $("database-summary"),
  databaseSearch: $("database-search"),
  databaseList: $("database-list"),
  collectionField: document.querySelector(".collection-field"),
  collectionPicker: document.querySelector(".collection-picker"),
  collectionOptions: $("collection-options"),
  collectionSummary: $("collection-summary"),
  start: timeField("start-date", "start-clock", "00:00"),
  end: timeField("end-date", "end-clock", "23:59"),
  share: $("share-view"),
  measurement: $("measurement"),
  technology: $("technology"),
  operator: $("operator"),
  band: $("band"),
  pci: $("pci"),
  ssb: $("ssb"),
  metric: $("metric"),
  cdfButton: $("show-cdf"),
};

const tabControls = {
  mapButton: $("tab-map"),
  compareButton: $("tab-compare"),
  mapPanel: $("map-tab"),
  comparePanel: $("compare-tab"),
  geoPolyButton: $("tab-geo-poly"),
  geoPolyPanel: $("geo-poly-tab"),
  debugButton: $("tab-debug"),
  debugPanel: $("debug-tab"),
};

const compareControls = {
  addButton: $("compare-add"),
  selectAllButton: $("compare-select-all"),
  copyButton: $("compare-copy"),
  deleteButton: $("compare-delete"),
  runButton: $("compare-run"),
  entries: $("compare-entries"),
  charts: $("compare-charts"),
  message: $("compare-message"),
  summary: $("compare-summary"),
};

const collectionPopoutControls = {
  dialog: $("collection-popout"),
  title: $("collection-popout-title"),
  count: $("collection-popout-count"),
  search: $("collection-popout-search"),
  list: $("collection-popout-list"),
  closeButton: $("collection-popout-close"),
  clearButton: $("collection-popout-clear"),
  allButton: $("collection-popout-all"),
  cancelButton: $("collection-popout-cancel"),
  applyButton: $("collection-popout-apply"),
};

const measurementLabels = {
  radio: "Radio",
  neighbor: "Neighbour",
  pdsch: "PDSCH",
  pusch: "PUSCH",
};

let catalog = null;
let options = null;
let markerLayer;
let fittedSelection = "";
let requestNumber = 0;
let mapRefreshNumber = 0;
let measurementController = null;
let optionRequestNumber = 0;
let optionController = null;
let optionsPending = false;
let lastOptionsKey = "";
let lastMapKey = "";
let lastMapPayload = null;
let cdfRequestNumber = 0;
let cdfPayload = null;
let activeTab = "map";
let compareCurves = [];
let compareCurveNumber = 0;
let compareRequestNumber = 0;
let comparePayload = null;
let compareController = null;
let compareRunPending = false;
let collapsedCompareCurveIds = new Set();
let selectedCompareCurveIds = new Set();
let collectionPopoutState = null;

function setStatus(message) {
  $("status").textContent = message;
}

function setMapMessage(message) {
  const element = $("map-message");
  element.textContent = message;
  element.hidden = !message;
}
