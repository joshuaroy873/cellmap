"use strict";

async function getJSON(path, params = {}) {
  if (sessionPaused) {
    throw new Error("Session paused. Refresh page to continue.");
  }
  const url = new URL(path, window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item !== undefined && item !== null && item !== "" && item !== "all") {
        url.searchParams.append(key, item);
      }
    }
  });
  const response = await fetch(url);
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    const contentType = response.headers.get("Content-Type") || "";
    const detail = contentType.includes("text/html") || text.trimStart().startsWith("<")
      ? "The API returned an HTML page. Restart website/server.py and make sure this page is served by that Python server."
      : "The API returned an invalid JSON response.";
    throw new Error(detail);
  }
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}
