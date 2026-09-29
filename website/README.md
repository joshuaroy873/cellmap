# Website

## Purpose

The website serves a lightweight cellular measurement explorer from the local
DuckDB catalog and Parquet partitions in `data/_processed`.

There is no frontend build step.

This guide describes source at `b79c7e6` as reviewed on 2026-09-28. The owner
reported pushing the implementation; the tracked tree was clean before this
documentation update. Running processes may not have loaded that revision.

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

These commands start foreground processes. Do not start a duplicate if the
website is already service-managed. Safe importer activation requires a Linux
systemd user manager and refuses unmanaged website processes.

Configured setup on `ghoshlab2` (runtime status not rechecked for this doc update):

- Public system unit `cellmap.service`: `127.0.0.1:8000`, exposed through
  Cloudflare at `https://cellmap.joshuaroy873.com`.
- Preview user unit `cellmap-local.service`: `100.85.31.36:8001`, accessible over
  Tailscale at `http://ghoshlab2.taila7dab6.ts.net:8001/`. Use the full hostname
  for CARTO referrer restrictions, not the short hostname or IP.

Ask the owner before every restart; no automatic restart after edits. Backend
changes require a restart; static changes require a page refresh. Both services
share this repo/data, so the preview is not isolated. See [service.md](../service.md).
The old transient user units are obsolete, but the importer still defaults to
them and only manages user services. Its activation integration must be adapted
before use with this deployment; `--service cellmap.service` alone is insufficient.

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
website/static/geo_view.js polygon drawing, filters, region results, and square preview
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
POST /api/geo/search
GET /api/geo/options
POST /api/shared-views
GET /api/shared-views/<id>
```

The API accepts predefined measurement types, metrics, and filters only.
JSON responses use gzip when supported by the browser.
Static JavaScript/CSS URLs are content-versioned with ETag/cache handling.
Queries and aggregation run on the server; the browser renders bounded results.

Payload limits:

```text
map points          6,000 max
Geo-poly squares    6,000 max (counts include all matches)
time-series buckets about 500
CDF points          401 quantile points
Compare curves      20 max per request
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
Geo-poly tab: polygon drawing, filters, database/collection results, aggregated squares
```

Geo-poly initializes its map only when opened. Click Search polygon, place
vertices, and click the first point to close. A polygon is optional: without one,
Search covers all stored locations worldwide, not just the viewport (within
Web Mercator's latitude limits). The polygon button reads Restart polygon while
drawing and after closing, until a search succeeds. After success it reads
Search polygon and is disabled; Search becomes Reset search. Reset clears
the polygon, results, and collection selection, retains filters/grid size, and
re-enables drawing and Search. There is no separate Clear polygon button.
Failed searches use one Retry search toolbar button, not an extra inline button.
Retry search clears the failed search, polygon, and results, returning to idle
Search polygon / Search controls. It preserves left-pane filters and grid size,
does not start drawing, and does not automatically resubmit a query.
Editing any left-pane value reactivates Search without clearing the polygon;
the next Search creates a new primary search and selects all its result collections.
Choose filters before or after drawing, then click Search to submit them together. Shading is visible
during drawing; results show only a thin, faint outline. The right pane uses
plain HTML checkboxes and collapsed database disclosure lists, with indented
collections. All matches are selected initially. Selection changes refresh
the preview. The left pane filters measurement type, operator, band,
and metric; Technology/PCI/SSB dropdowns are not offered here. All technologies
are included unless a technology-qualified band is selected. Top-bar controls are hidden.
Filter choices load independently of the polygon from dataset-wide metadata.
The server reuses this small metadata list until the catalog changes; the page
loads it once per session (refresh the page after importing data). Dropdown
changes are local and do not run measurement queries; click Search to apply.
Choices are not guarantees of matches inside your polygon. Metrics come from
the schema and may have no values for a particular selection.

Filters and the polygon are applied before aggregation. Manually select square
**side lengths** of 1 m, 10 m, 100 m, 1 km, 10 km, or 100 km (default), in Web Mercator
projected meters (not ground-distance meters). Click Search to apply changes.
Zooming, panning, and reopening the tab do not query measurements or change
grid size. Choose Average or Maximum.
The left-pane note reads only `Web Mercator projected meters.`
Average is the arithmetic mean of stored
values, including dBm, weighted by measurement count when collections overlap.
Only finite values of the selected metric contribute. A shared square combines
all selected collections; edge squares can extend beyond the drawn polygon,
but their contributing measurements cannot.

Square hover text is compact: `Average: -95.23 · 1,234 measurements` (or
`Maximum`). Values use two decimals, without metric name/unit/grid size in the
tooltip. Counts above 9,999 use approximate thousands with one decimal, such as
`~12.3k measurements`; smaller counts remain exact. The legend identifies the
metric/unit, and clicking the square still selects matching collections.

At most 6,000 squares are displayed: from the current viewport with a polygon,
or worldwide without a polygon. When needed, each
collection receives a quota proportional to its filtered occupied-square count
in that preview area; cells are selected by a deterministic coordinate hash. For
disjoint coverage of 4,000 and 8,000 cells, quotas are 2,000 and 4,000. Overlaps
are displayed once and spare slots are filled from remaining cells, so exact
per-collection displayed proportions are not guaranteed for overlapping data.
This is a sample, not a guarantee of uniform geographic coverage. The viewport
is captured when a search runs; moving the map leaves those squares unchanged.
To refine a sample, reset and draw a smaller polygon for a new search.
Counts include all area/filter
matches, not just the preview. Result collection checkboxes still trigger a
debounced search when there are no pending filter edits.

The result summary uses two lines:

```text
1,140,565 selected measurements
250/250 squares in the searched view
```

The first line counts every finite-metric measurement matching the active
primary or exploration filters, checked collections, and original area. It is
not limited by the viewport or 6,000-square sample. The second line is displayed
squares / eligible squares in the captured preview area; worldwide searches
say `worldwide` instead. Changing only grid size does not change the first count.
Exploration updates both counts for its selections; returning to primary
requeries the primary counts. The fixed-height summary prevents list shifting.

The right pane has one Select all checkbox below the measurement summary and
above the collection list. Uncheck it to deselect all; a mixed state indicates
partial selection. Clicking a square selects all
collections with filter-matching measurements in it and deselects other listed
collections, then recomputes. This includes currently unchecked collections at
that location; the selection applies to entire collections, not just that cell.
Square values always combine every matching measurement from selected
collections/databases: Average is sum/count, Maximum is the largest value.
Sampling selects which squares to display, never which measurements to aggregate.

At the bottom of the right pane, **Explore results** offers a classic single-value
grid-size select and floating checkbox menus for operators and bands. Grid size's
label and narrower select share one line. Menu summaries show a single selected
value, All, None, or the selection count. Menus close on outside click or Escape and
open above the control when space below is limited. The choices include
all operators/bands with finite values for the primary metric in the primary
result collections that are currently checked, within the original area, not just those allowed by the primary
operator/band filters. Values are unique across those collections and refresh
immediately when collection checkboxes change, using per-collection choice
metadata (no extra lookup query). With no collections selected, the menus are
empty. Unchecked operator/band choices are remembered when their collections
are deselected and reselected. After a primary search (and after returning to
primary results), the exploration grid/operator/band selections match the primary
request. A primary All filter checks all available values; a specific filter
checks only that value, while other available choices remain visible. Operators are ORed
together, bands are ORed together, and the two groups are ANDed; selecting none
in either group gives no matches. Unknown values are explicitly selectable.
Changes apply automatically after a 300 ms debounce, grouping rapid edits into
one query. There is no Apply button. Outdated responses are ignored.
The area, captured preview viewport, measurement type, metric, and aggregation
stay fixed. Collection checkboxes continue to apply; zero-match collections stay
listed so they can be selected again. Left-pane controls are not changed.
Return to primary results reruns the original request with its original grid,
operator/band settings, and all original primary selections. This button is
disabled until an exploration query succeeds, while a query is running, and
again after returning to primary results. Only request
settings and choice metadata are retained, not grid results; changed underlying
data can therefore change the result when replayed. Left-pane edits invalidate
the previous exploration and create a new primary search when Search is clicked.

Every search recomputes on the server without caching point/grid results or
reusing Map results. The Map tab itself is unchanged.

Points on polygon edges are included; missing/out-of-range GPS is excluded.
Latitudes outside Web Mercator's approximately ±85.05113° range are excluded.
Self-crossing/zero-area polygons and date-line-crossing edges are rejected.
Polygons support up to 200 vertices. There is one concurrent search per process.

`cellmap_geo.py` is a shared backend module, not a command or service. It stores
one bounding box per database/collection (all technologies/types combined),
skips nonoverlapping collections, then runs the exact polygon test on the server.
It uses DuckDB's official spatial extension, installed once for the server user:

```bash
.venv/bin/python -c "import duckdb; duckdb.connect().execute('INSTALL spatial')"
```

The existing catalog was backfilled with 248 collection bounds without changing
measurements. Future imports refresh them automatically. Missing bounds fall
back to scanning the collection, never silently excluding it. See the
[import guide](../scripts/README.md#collection-bounds).

On the Map tab, the collection dropdown supports multiple collections and Select all.
Band values are technology-qualified, such as `b48` and `n48`.
Band, PCI, and SSB options show matching row counts.

The time-series query is skipped until one operator is selected.

The CDF modal is drawn in browser canvas from `/api/cdf`.
It shows P5, median, and P95 in the header and chart callouts.

The Share button saves the current Map database, selected collections, time
range, and filters as a small record in `data/shared_views.sqlite3`. It copies a short `?share=`
link that restores the same Map view for someone using the same server and
catalog. A shared link does not include measurement data.

On startup, existing SQLite links in `data/_processed/shared_views.sqlite3`
are copied to the stable location without deleting the original store. Legacy
DuckDB links remain readable. The [import workflow](../scripts/README.md#safe-imports-and-rebuilds)
preserves both kinds of links, but a link cannot display collections omitted
from the replacement dataset.

The Compare tab uses the top-bar database, collection scope, and time range.
Each curve selects one or more collections from that scope, with its own
measurement/metric, color, line style, and radio filters. Running Compare sends
the configured curves to `POST /api/compare/cdf` in one batch request and groups
the returned charts by measurement/metric. Relevant selection changes invalidate
previous results; run Compare again to refresh them.

Rows without coordinates cannot appear on the map, but remain eligible for
summary statistics, time-series, and CDF queries when other filters match.

## Notes

`scripts/import_csvs.py /path/to/csv-folder` implements separate build/validation
followed by stop/swap/restart for supported user services. Its current service
integration does not match this deployment; see the warning above and service.md.
Use `--check-only` to validate without changing the active dataset.
Normal imports preserve unrelated partitions; `--rebuild` replaces the entire
dataset using supplied CSVs. The safe-import workflow and stable SQLite location
have not been verified through a live rebuild/swap for this work. Startup handles
legacy share migration; do not infer a process's loaded version from source files.

The importer can also remove a complete local database. Stop the server first,
preview the removal with:

```bash
.venv/bin/python scripts/import_csvs.py --delete-database DATABASE
```

The preview lists every catalog collection. Then add `--yes` only when ready to
permanently remove that database's archive, generated partitions, and catalog
metadata. The [scripts guide](../scripts/README.md#delete-a-database) describes
the full scope.
