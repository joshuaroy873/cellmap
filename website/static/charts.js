"use strict";

function resetSummary() {
  for (const id of [
    "stat-count",
    "stat-median",
    "stat-p5",
    "stat-p95",
    "stat-minimum",
    "stat-maximum",
  ]) {
    $(id).textContent = "-";
  }
}

function number(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return Number(value).toLocaleString(undefined, {
    maximumFractionDigits: digits,
  });
}

function compactAxisNumber(value) {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) {
    return `${number(value / 1_000_000, 1)}M`;
  }
  if (absolute >= 1_000) {
    return `${Math.round(value / 1_000).toLocaleString()}k`;
  }
  return number(value, 1);
}

function legendAxisNumber(value) {
  if (controls.metric.value === "throughput_mbps") {
    return number(value, 0);
  }
  return compactAxisNumber(value);
}

function clamp(value, minimum, maximum) {
  if (maximum < minimum) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function metricValue(value, unit) {
  const formatted = number(value, 2);
  return formatted === "-" || !unit ? formatted : `${formatted} ${unit}`;
}

function cdfMarkerValue(value, unit) {
  const formatted = !unit && Math.abs(value) >= 1_000
    ? compactAxisNumber(value)
    : number(value, 2);
  return formatted === "-" || !unit ? formatted : `${formatted} ${unit}`;
}

function percentileValue(points, probability) {
  let previous = points[0];
  for (const point of points) {
    if (point.probability >= probability) {
      if (point.probability === previous.probability) return point.value;
      const local =
        (probability - previous.probability) /
        (point.probability - previous.probability);
      return previous.value + (point.value - previous.value) * local;
    }
    previous = point;
  }
  return points.at(-1).value;
}

function cdfMarkers(payload) {
  const points = payload.points || [];
  if (!points.length) return [];
  return [
    { label: "P5", probability: 0.05, value: percentileValue(points, 0.05) },
    {
      label: "Median",
      probability: 0.5,
      value: percentileValue(points, 0.5),
    },
    { label: "P95", probability: 0.95, value: percentileValue(points, 0.95) },
  ];
}

function cdfSummaryText(payload) {
  const count = `${number(payload.count, 0)} samples`;
  const markers = cdfMarkers(payload);
  if (!markers.length) return count;
  const labels = markers.map(
    (marker) => `${marker.label}: ${cdfMarkerValue(marker.value, payload.unit)}`
  );
  return [count, ...labels].join(" | ");
}

function renderLegendAxis(minimum, maximum) {
  const axis = $("legend-axis");
  axis.replaceChildren();
  if (minimum === null || minimum === undefined ||
      maximum === null || maximum === undefined) {
    return;
  }
  const span = maximum - minimum;
  for (let index = 0; index < 5; index += 1) {
    const tick = document.createElement("span");
    tick.style.left = `${index * 25}%`;
    tick.textContent = legendAxisNumber(minimum + (span * index) / 4);
    axis.append(tick);
  }
}

function renderSummary(payload) {
  const summary = payload.summary;
  $("stat-count").textContent = number(summary.count, 0);
  $("stat-median").textContent = metricValue(summary.median, payload.unit);
  $("stat-p5").textContent = metricValue(summary.p5, payload.unit);
  $("stat-p95").textContent = metricValue(summary.p95, payload.unit);
  $("stat-minimum").textContent = metricValue(summary.minimum, payload.unit);
  $("stat-maximum").textContent = metricValue(summary.maximum, payload.unit);
  $("chart-title").textContent = payload.label;
  $("series-count").textContent = payload.series.length
    ? `${payload.series.length} time buckets`
    : "";
}

function setTimeSeriesAvailable(available) {
  $("time-series-message").hidden = available;
  $("chart").style.visibility = available ? "visible" : "hidden";
  if (!available) {
    $("series-count").textContent = "";
  }
}

function drawChart(payload) {
  const canvas = $("chart");
  const context = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const data = payload.series;
  if (!data.length || width < 80 || height < 80) return;

  const margin = { top: 12, right: 15, bottom: 25, left: 48 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const minimum = Math.min(...data.map((item) => item.minimum));
  const maximum = Math.max(...data.map((item) => item.maximum));
  const span = maximum - minimum || 1;
  const x = (index) =>
    margin.left + (index / Math.max(1, data.length - 1)) * plotWidth;
  const y = (value) =>
    margin.top + (1 - (value - minimum) / span) * plotHeight;

  context.strokeStyle = "#e3e8ed";
  context.lineWidth = 1;
  context.fillStyle = "#657180";
  context.font = "11px system-ui";
  context.textAlign = "right";
  for (let line = 0; line <= 4; line += 1) {
    const value = minimum + (span * line) / 4;
    const py = y(value);
    context.beginPath();
    context.moveTo(margin.left, py);
    context.lineTo(width - margin.right, py);
    context.stroke();
    context.fillText(number(value, 1), margin.left - 7, py + 4);
  }

  context.beginPath();
  data.forEach((item, index) => {
    const px = x(index);
    const py = y(item.maximum);
    if (index === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  });
  for (let index = data.length - 1; index >= 0; index -= 1) {
    context.lineTo(x(index), y(data[index].minimum));
  }
  context.closePath();
  context.fillStyle = "rgba(18, 103, 130, 0.12)";
  context.fill();

  context.beginPath();
  data.forEach((item, index) => {
    const px = x(index);
    const py = y(item.average);
    if (index === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  });
  context.strokeStyle = "#126782";
  context.lineWidth = 2;
  context.stroke();

  context.fillStyle = "#657180";
  context.textAlign = "center";
  const timeIndexes = [0, Math.floor((data.length - 1) / 2), data.length - 1];
  for (const index of timeIndexes) {
    const time = new Date(data[index].time);
    context.fillText(
      time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      x(index),
      height - 6
    );
  }
}

function drawRoundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - radius,
    y + height
  );
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function drawCdf(payload) {
  const canvas = $("cdf-chart");
  const context = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const points = payload.points;
  if (!points.length || width < 120 || height < 120) return;

  const margin = { top: 18, right: 24, bottom: 50, left: 64 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const minimum = Math.floor(points[0].value / 10) * 10;
  let maximum = Math.ceil(points.at(-1).value / 10) * 10;
  if (maximum === minimum) maximum += 10;
  const span = maximum - minimum || 1;
  const x = (value) =>
    margin.left + ((value - minimum) / span) * plotWidth;
  const y = (probability) =>
    margin.top + (1 - probability) * plotHeight;

  context.strokeStyle = "#e3e8ed";
  context.fillStyle = "#657180";
  context.lineWidth = 1;
  context.font = "11px system-ui";

  for (let index = 0; index <= 5; index += 1) {
    const probability = index / 5;
    const py = y(probability);
    context.beginPath();
    context.moveTo(margin.left, py);
    context.lineTo(width - margin.right, py);
    context.stroke();
    context.textAlign = "right";
    context.fillText(`${Math.round(probability * 100)}%`, margin.left - 8, py + 4);
  }

  for (let index = 0; index <= 4; index += 1) {
    const value = minimum + (span * index) / 4;
    const px = x(value);
    context.beginPath();
    context.moveTo(px, margin.top);
    context.lineTo(px, height - margin.bottom);
    context.stroke();
    context.textAlign = "center";
    context.fillText(number(value, 1), px, height - margin.bottom + 18);
  }

  context.beginPath();
  points.forEach((point, index) => {
    const px = x(point.value);
    const py = y(point.probability);
    if (index === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  });
  context.strokeStyle = "#126782";
  context.lineWidth = 2.2;
  context.stroke();

  const markers = cdfMarkers(payload);
  for (const marker of markers) {
    const px = x(marker.value);
    const py = y(marker.probability);
    const text = `${marker.label}: ${cdfMarkerValue(marker.value, payload.unit)}`;
    const paddingX = 7;
    const boxHeight = 22;

    context.font = "12px system-ui";
    const boxWidth = context.measureText(text).width + paddingX * 2;
    let boxX = px + 10;
    if (boxX + boxWidth > width - margin.right) {
      boxX = px - boxWidth - 10;
    }
    boxX = clamp(boxX, margin.left, width - margin.right - boxWidth);

    const preferredYOffset = marker.probability >= 0.9
      ? 8
      : marker.probability <= 0.1
        ? -30
        : -11;
    const boxY = clamp(
      py + preferredYOffset,
      margin.top + 2,
      height - margin.bottom - boxHeight - 2
    );

    context.save();
    context.strokeStyle = "rgba(18, 103, 130, 0.28)";
    context.lineWidth = 1;
    context.setLineDash([3, 3]);
    context.beginPath();
    context.moveTo(px, height - margin.bottom);
    context.lineTo(px, py);
    context.stroke();
    context.restore();

    const boxEdgeX = boxX > px ? boxX : boxX + boxWidth;
    context.strokeStyle = "rgba(18, 103, 130, 0.45)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(px, py);
    context.lineTo(boxEdgeX, boxY + boxHeight / 2);
    context.stroke();

    context.fillStyle = "rgba(255, 255, 255, 0.96)";
    context.strokeStyle = "#126782";
    drawRoundedRect(context, boxX, boxY, boxWidth, boxHeight, 6);
    context.fill();
    context.stroke();

    context.fillStyle = "#18212b";
    context.textAlign = "left";
    context.fillText(text, boxX + paddingX, boxY + 15);

    context.beginPath();
    context.arc(px, py, 4, 0, Math.PI * 2);
    context.fillStyle = "#ffffff";
    context.fill();
    context.strokeStyle = "#126782";
    context.lineWidth = 2;
    context.stroke();
  }

  const xLabel = payload.unit
    ? `${payload.label} (${payload.unit})`
    : payload.label;
  context.font = "11px system-ui";
  context.fillStyle = "#18212b";
  context.textAlign = "center";
  context.fillText(xLabel, margin.left + plotWidth / 2, height - 8);

  context.save();
  context.translate(15, margin.top + plotHeight / 2);
  context.rotate(-Math.PI / 2);
  context.fillText("Cumulative probability", 0, 0);
  context.restore();
}

function closeCdf() {
  cdfRequestNumber += 1;
  cdfPayload = null;
  if ($("cdf-modal").open) $("cdf-modal").close();
}

async function openCdf() {
  if (controls.cdfButton.disabled) return;
  const request = ++cdfRequestNumber;
  const modal = $("cdf-modal");
  $("cdf-title").textContent = "CDF";
  $("cdf-count").textContent = "";
  $("cdf-message").textContent = "Loading CDF";
  $("cdf-message").hidden = false;
  $("cdf-chart").style.visibility = "hidden";
  modal.showModal();

  try {
    const payload = await getJSON("/api/cdf", measurementParams());
    if (request !== cdfRequestNumber) return;
    cdfPayload = payload;
    $("cdf-title").textContent = `${payload.label} CDF`;
    $("cdf-count").textContent = cdfSummaryText(payload);
    $("cdf-message").hidden = Boolean(payload.points.length);
    $("cdf-message").textContent = payload.points.length
      ? ""
      : "No measurements match these filters";
    $("cdf-chart").style.visibility = payload.points.length
      ? "visible"
      : "hidden";
    drawCdf(payload);
  } catch (error) {
    if (request !== cdfRequestNumber) return;
    $("cdf-message").textContent = error.message;
    $("cdf-message").hidden = false;
  }
}
