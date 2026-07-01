"use strict";

const $ = (id) => document.getElementById(id);

const controls = {
  database: $("database"),
  collectionField: document.querySelector(".collection-field"),
  collectionPicker: document.querySelector(".collection-picker"),
  collectionOptions: $("collection-options"),
  collectionSummary: $("collection-summary"),
  start: $("start-time"),
  end: $("end-time"),
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
};

const compareControls = {
  addButton: $("compare-add"),
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
let cdfRequestNumber = 0;
let cdfPayload = null;
let activeTab = "map";
let compareCurves = [];
let compareCurveNumber = 0;
let compareRequestNumber = 0;
let comparePayload = null;
let collectionPopoutState = null;

function setStatus(message) {
  $("status").textContent = message;
}

function setMapMessage(message) {
  const element = $("map-message");
  element.textContent = message;
  element.hidden = !message;
}
