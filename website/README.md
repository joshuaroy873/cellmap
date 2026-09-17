# Website

## Purpose

The website serves a lightweight cellular measurement explorer from the local
DuckDB catalog and Parquet partitions in `data/_processed`.

There is no frontend build step.

## Run

From the repository root:

```bash
source .venv/bin/activate
python website/server.py
```

Open:

```text
http://127.0.0.1:8000
```

Listen on the local network:

```bash
python website/server.py --host 0.0.0.0 --port 8000
```

## Basemap key

Create `.env` at the repository root with:

```dotenv
CARTO_BASEMAP_KEY=your-key-here
```

The server reads this file automatically when the browser requests `/api/config`.
An environment variable named `CARTO_BASEMAP_KEY` takes priority over the file.
Single or double quotes, comment lines, and trailing comments are supported;
shell commands and variable expansion are not evaluated. No extra dependency
or manual sourcing is required. Refresh after updating `.env`; restart the server
if you change its environment variables.

`.env` and `.env.*` are ignored by Git. Keep `.env` outside `website/static`.
The config endpoint returns only
the basemap key, not the rest of the environment or the file. The key is visible
in browser requests, so restrict it to your deployment host in CARTO.

For `https://cellmap.joshuaroy873.com`, allow the Referer host
`cellmap.joshuaroy873.com`. Shared `?share=...` URLs use the same host. Requests
from local development need their own allowed host or a separate development
key. The server's `strict-origin-when-cross-origin` referrer policy sends only
the origin to CARTO, without the shared-view query string.

Tiles use the [authenticated CARTO Positron endpoint](https://carto.com/blog/positron-dark-matter-new-look/).
If no key is configured or the config request fails, measurements can still load
and the map shows a background-unavailable notice; details appear in the browser
console. If authenticated tiles still show the old watermark, force-refresh.

## Files

```text
website/server.py          HTTP API and static file server
website/static/index.html  page structure
website/static/styles.css  layout and styling
website/static/state.js    shared UI state and DOM handles
website/static/api.js      JSON request helper
website/static/filters.js  collection and filter controls
website/static/map_view.js Leaflet map and selected-point details
website/static/charts.js   summary, time-series, and CDF drawing
website/static/compare_view.js   Compare-tab curve builder
website/static/compare_charts.js Compare-tab grouped CDF charts
website/static/share_view.js     shared Map-view links
website/static/app.js      page initialization and event wiring
website/compare_api.py     batch CDF API for the Compare tab
```

Leaflet 1.9.4 is vendored in `website/static/vendor/leaflet`.
Map tiles use CARTO Positron.
The current map page is isolated in `map_view.js`; future tabs can add their
own view files without changing the API helper or filter code.

## API

```text
GET /api/health
GET /api/config
GET /api/catalog
GET /api/options
GET /api/measurements
GET /api/cdf
POST /api/compare/cdf
POST /api/shared-views
GET /api/shared-views/<id>
```

The API accepts predefined measurement types, metrics, and filters only.
JSON responses use gzip when supported by the browser.

Payload limits:

```text
map points          6,000 max
time-series buckets about 500
CDF points          401 quantile points
```

## UI

Top controls:

```text
database, collection, start time, end time
```

Filter controls:

```text
measurement type, technology, operator, band, PCI, SSB index, metric
```

Main panels:

```text
Map tab: colored measurement map, time-series chart, summary statistics,
selected-point details, CDF modal
Compare tab: per-curve filters and grouped CDF charts
```

The collection dropdown supports multiple collections and Select all.
Band values are technology-qualified, such as `b48` and `n48`.
Band, PCI, and SSB options show matching row counts.

The time-series query is skipped until one operator is selected.

The CDF modal is drawn in browser canvas from `/api/cdf`.
It shows P5, median, and P95 in the header and chart callouts.

The Share button saves the current Map database, selected collections, time
range, and filters as a small record in DuckDB. It copies a short `?share=`
link that restores the same Map view for someone using the same server and
catalog. A shared link does not include measurement data.

The Compare tab does not use the top collection selector. Each compare curve
has its own collection, measurement/metric, color, line style, and radio
filters. Running Compare sends all curves to `POST /api/compare/cdf` in one
batch request and groups the returned CDF charts by measurement/metric.

After 10 minutes without browser activity, the page shows a transparent
session-paused overlay. Refreshing starts a new browser session.

## Notes

Close the website server before running `scripts/import_csvs.py` if DuckDB
reports a write lock.

The importer can also remove a complete local database. Stop the server first,
preview the removal with:

```bash
python scripts/import_csvs.py --delete-database <database>
```

The preview lists every catalog collection. Then add `--yes` only when ready to
permanently remove that database's archive, generated partitions, and catalog
metadata. The [scripts guide](../scripts/README.md#delete-a-database) describes
the full scope.
