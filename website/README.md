# Website

A Python HTTP server (`website/server.py`) that answers JSON queries from
DuckDB over the Parquet partitions in `data/_processed` and serves the static
frontend in `website/static`. No frontend build step; Leaflet 1.9.4 is vendored.

## Run

```bash
.venv/bin/python website/server.py                      # 127.0.0.1:8000
.venv/bin/python website/server.py --host 0.0.0.0 --port 8000
```

On `ghoshlab2` the site is service-managed; see [service.md](../service.md).
Do not start a second copy next to the services.

## Configuration

`CARTO_BASEMAP_KEY` supplies the basemap tiles. The server reads it from the
environment, else from `.env` at the repository root (`KEY=value`, quotes and
`#` comments allowed, no shell expansion). The key is embedded in the served
page and also available from `/api/config`; without it the map still works
with a "background unavailable" notice. The key is visible to browsers, so
restrict it in CARTO to the deployment hostnames.

## Files

```text
server.py          HTTP API, static files, shared links
compare_api.py     Compare-tab batch CDF
static/index.html  page structure (one <main> per tab)
static/styles.css  layout
static/state.js    DOM handles, shared state, the Start/End time fields
static/api.js      fetch helpers
static/filters.js  collection picker, filter cascade, /api/view loading
static/map_view.js Map tab: markers, legend, point details, basemap
static/charts.js   summary, time series, CDF modal, colour scale
static/compare_view.js, compare_charts.js   Compare tab
static/geo_view.js Geo-poly tab
static/share_view.js  Share button and ?share= restore
static/app.js      initialisation, tabs, event wiring
```

Each tab keeps its own state in its own file and reuses only the helpers in
`state.js`, `api.js` and `charts.js`. Adding or removing a tab touches
`index.html`, its own view file, one endpoint, and the tab switch in `app.js`.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | liveness |
| `GET /api/config` | basemap key (fallback; the page carries it) |
| `GET /api/catalog` | databases, collections, time ranges, available measurement types |
| `GET /api/options` | filter choices with row counts for a database/collection selection |
| `GET /api/view` | `options` plus `measurements` in one round trip; filter values are validated server-side and the applied ones returned as `selected` |
| `GET /api/measurements` | summary statistics, sampled map points, optional time series |
| `GET /api/point` | every stored field of one mapped point, by `position` |
| `GET /api/cdf` | 401-point CDF for the current filters |
| `POST /api/compare/cdf` | up to 20 curves in one request |
| `POST /api/geo/search` | Geo-poly polygon or worldwide grid search |
| `GET /api/geo/options` | dataset-wide operator/band combinations (cached per catalog version) |
| `POST /api/shared-views`, `GET /api/shared-views/<id>` | create and read share links |
| `GET /api/debug/channel`, `GET /api/debug/channel/point` | temporary debug tab: one DL channel number across all databases |

Query parameters are `database`, repeated `collection`, `measurement`,
`technology`, `operator`, `band` (`LTE:2`, `NR:78`), `pci`, `ssb`
(`__null__` selects rows without an SSB index), `metric`, `start`, `end`.
Values are validated against the schema; unknown values are errors, not
silent no-ops. Errors are `{"error": "..."}` with 400, 404, 503 or 500.

Limits: 6,000 map points, 6,000 Geo-poly squares, 200 polygon vertices,
about 500 time-series buckets, 20 compare curves, 1 MB request bodies.

### Time filters

`start` and `end` accept `YYYY-MM-DD HH:MM[:SS[.ffffff]]` with `T` or a
space. An unparseable value is a 400. An `end` without seconds covers its whole
minute, so `end=2025-05-05T10:06` includes `10:06:59.999999`. This matches the
UI, which edits times to the minute.

### Request handling

- Every connection uses `QUERY_CONFIG` from `cellmap_schema.py` (16 threads,
  8 GB). DuckDB shares one engine per process, so a `SET` on any connection
  would apply to all; never add per-connection settings.
- At most 8 data requests run at once; others wait up to 20 s, then get 503.
  Geo-poly additionally runs one search at a time.
- HTTP/1.1 keep-alive with a 30 s idle timeout. JSON is gzipped; static
  JS/CSS URLs are content-hashed and cached immutably; the page is `no-cache`
  with an ETag.
- Geo options and the versioned page are warmed in a background thread at
  startup.
- Responses refuse NaN/Infinity; queries only consider finite metric values.

## Map tab

Top bar: database, collections (multi-select with Select all), Start and End
(a date picker plus a 24-hour `HH:MM` box; an empty box means `00:00` or
`23:59`). Left pane: measurement type, technology, operator, band, PCI, SSB
index, metric. Each change makes one `/api/view` request; the server
re-validates the cascade, so a value that no longer exists falls back to All.

The map draws up to 6,000 points sampled evenly in time order and fetches a
point's full record on click. Colours span the 1st to 99th percentile of the
whole result so one outlier cannot flatten the palette; the legend marks a
clipped end with `≤` or `≥`. Summary statistics (count, median, P5, P95, min,
max) cover every matching row, including rows without GPS that cannot be
drawn. The time series appears once an operator is selected. Show CDF opens a
modal drawn from `/api/cdf`.

Share saves the Map selection (not data) in `data/shared_views.sqlite3` and
copies a `?share=<id>` link that restores it on the same server. Legacy links
in the DuckDB catalog and in `data/_processed/shared_views.sqlite3` remain
readable.

## Compare tab

Uses the top-bar database, collection scope and time range. Each curve picks a
collection subset, measurement/metric, radio filters, colour and line style.
Run compare sends all curves in one request and groups charts by metric.
Changing any input invalidates the previous result until rerun.

## Geo-poly tab

Cross-database search aggregated into Web Mercator squares (side 1 m to
100 km in projected metres, not ground metres). Draw a polygon by clicking
vertices and closing on the first one, or search worldwide without one.
Filters (measurement type, operator, band, metric, Average/Maximum) and the
polygon are staged until Search. Points on the polygon edge count; invalid,
self-crossing or date-line-crossing polygons are rejected.

Average is the arithmetic mean of stored values (dBm included) over all
selected collections, weighted by count; Maximum is the largest value.
Collections whose stored bounds miss the polygon are skipped without reading
them. The right pane lists matching databases and collections with counts;
unchecking one recomputes. Clicking a square selects exactly the collections
present in it. Explore results broadens operators/bands within the primary
result collections and area with a 300 ms debounce; Return to primary reruns
the original request.

When more than 6,000 squares are eligible in the captured view, each
collection gets a proportional quota and squares are chosen by a deterministic
hash. Sampling only decides which squares are shown; every square's value uses
all of its measurements. The summary shows total matching measurements and
shown/eligible squares. Pan and zoom never query; Reset search clears results
and the polygon but keeps filters.

## Debug tab (temporary)

Opening the page with `?debug=1` adds a **DL channel** tab: measurement type
(radio or neighbour), technology (LTE or NR), a downlink channel number
(EARFCN or NR-ARFCN, the stored `dl_channel_number`), and a metric. Search
scans every database and lists matching collections with row, value and GPS
counts; the map, legend, summary and point details work as on the Map tab.
Everything for it lives in `debug_view.js`, the `debug-*` block in
`index.html`, a few `debug` lines in `app.js` and `state.js`, and the
"Debug tab" section of `server.py`; delete those to remove it.

The spatial extension is installed once for the server user:

```bash
.venv/bin/python -c "import duckdb; duckdb.connect().execute('INSTALL spatial')"
```
