"use strict";

const $ = (id) => document.getElementById(id);

const controls = {
  database: $("database"),
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

const measurementLabels = {
  radio: "Radio",
  neighbor: "Neighbour",
  pdsch: "PDSCH",
  pusch: "PUSCH",
};

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

let catalog = null;
let options = null;
let markerLayer;
let fittedSelection = "";
let requestNumber = 0;
let cdfRequestNumber = 0;
let cdfPayload = null;
let idleTimer = null;
let sessionPaused = false;

function setStatus(message) {
  $("status").textContent = message;
}

function setMapMessage(message) {
  const element = $("map-message");
  element.textContent = message;
  element.hidden = !message;
}
