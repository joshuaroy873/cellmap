"use strict";

const compareLineStyles = {
  solid: [],
  dashed: [8, 5],
  dotted: [2, 4],
  dashdot: [8, 4, 2, 4],
};

function makeCurvePreview(curve, className = "curve-preview") {
  const preview = document.createElement("span");
  preview.className = className;
  preview.dataset.style = curve.style || "solid";
  preview.style.setProperty("--curve-color", curve.color || "#0072b2");
  return preview;
}

function compareStatText(curve) {
  if (!curve.count) return curve.note || "No samples";
  return `${number(curve.count, 0)} samples | ` +
    `Median ${metricValue(curve.median, curve.unit)} ` +
    `(P5 ${metricValue(curve.p5, curve.unit)} | ` +
    `P95 ${metricValue(curve.p95, curve.unit)})`;
}

function compareAxisNumber(value, metric) {
  if (metric === "throughput_mbps") return number(value, 0);
  return compactAxisNumber(value);
}

function compareExtent(chart) {
  const values = chart.curves.flatMap((curve) =>
    (curve.points || []).map((point) => point.value)
  );
  if (!values.length) return null;
  let minimum = Math.floor(Math.min(...values) / 10) * 10;
  let maximum = Math.ceil(Math.max(...values) / 10) * 10;
  if (minimum === maximum) maximum = minimum + 10;
  return { minimum, maximum };
}

function drawCompareChart(canvas, chart) {
  const context = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const extent = compareExtent(chart);
  if (!extent || width < 140 || height < 140) return;

  const margin = { top: 24, right: 30, bottom: 76, left: 90 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const span = extent.maximum - extent.minimum || 1;
  const x = (value) =>
    margin.left + ((value - extent.minimum) / span) * plotWidth;
  const y = (probability) =>
    margin.top + (1 - probability) * plotHeight;

  context.strokeStyle = "#e3e8ed";
  context.fillStyle = "#657180";
  context.lineWidth = 1;
  context.font = "600 16px system-ui";

  for (let index = 0; index <= 5; index += 1) {
    const probability = index / 5;
    const py = y(probability);
    context.beginPath();
    context.moveTo(margin.left, py);
    context.lineTo(width - margin.right, py);
    context.stroke();
    context.textAlign = "right";
    context.fillText(`${Math.round(probability * 100)}%`, margin.left - 10, py + 5);
  }

  for (let index = 0; index <= 4; index += 1) {
    const value = extent.minimum + (span * index) / 4;
    const px = x(value);
    context.beginPath();
    context.moveTo(px, margin.top);
    context.lineTo(px, height - margin.bottom);
    context.stroke();
    context.textAlign = "center";
    context.fillText(
      compareAxisNumber(value, chart.metric),
      px,
      height - margin.bottom + 24
    );
  }

  for (const curve of chart.curves) {
    const points = curve.points || [];
    if (!points.length) continue;
    context.save();
    context.beginPath();
    points.forEach((point, index) => {
      const px = x(point.value);
      const py = y(point.probability);
      if (index === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    });
    context.strokeStyle = curve.color || "#0072b2";
    context.lineWidth = 2.2;
    context.setLineDash(compareLineStyles[curve.style] || []);
    context.stroke();
    context.restore();
  }

  const xLabel = chart.unit
    ? `${chart.metric_label} (${chart.unit})`
    : chart.metric_label;
  context.font = "600 20px system-ui";
  context.fillStyle = "#18212b";
  context.textAlign = "center";
  context.fillText(xLabel, margin.left + plotWidth / 2, height - 18);

  context.save();
  context.translate(22, margin.top + plotHeight / 2);
  context.rotate(-Math.PI / 2);
  context.fillText("Cumulative probability", 0, 0);
  context.restore();
}

function makeCompareLegend(chart) {
  const legend = document.createElement("div");
  legend.className = "compare-legend";
  for (const curve of chart.curves) {
    const item = document.createElement("div");
    item.className = "compare-legend-item";

    const swatch = makeCurvePreview(curve, "curve-preview compare-legend-preview");

    const text = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = curve.label;
    const stats = document.createElement("span");
    stats.textContent = compareStatText(curve);
    text.append(title, stats);

    item.append(swatch, text);
    legend.append(item);
  }
  return legend;
}

function drawCompareCharts(payload) {
  comparePayload = payload;
  compareControls.charts.replaceChildren();
  compareControls.summary.textContent = `${payload.curve_count} curves`;

  const charts = payload.charts || [];
  if (!charts.length) {
    compareControls.message.hidden = false;
    compareControls.message.textContent = "No compare results to show.";
    return;
  }

  compareControls.message.hidden = true;
  const canvases = [];
  for (const chart of charts) {
    const card = document.createElement("article");
    card.className = "compare-chart-card";

    const body = document.createElement("div");
    body.className = "compare-chart-body";
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-label", `${chart.title} CDF`);
    body.append(canvas);

    card.append(body, makeCompareLegend(chart));
    compareControls.charts.append(card);
    canvases.push([canvas, chart]);
  }

  requestAnimationFrame(() => {
    for (const [canvas, chart] of canvases) {
      drawCompareChart(canvas, chart);
    }
  });
}

function redrawCompareCharts() {
  if (comparePayload) drawCompareCharts(comparePayload);
}
