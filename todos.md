# Remaining work

Reviewed against committed source `b79c7e6` on 2026-09-28, after the owner's push.
These notes do not authorize
schema changes, reimports, or server restarts.

## Planned, not implemented

- Full CSV replacement: owner will supply the dump and decide retained columns.
  The single importer already supports `--rebuild`.
- Geo-poly follow-ups: export/sharing and date-line support. Filtered
  cross-database polygon search is implemented; owner will manually test the UI.
- Collection tags: indoor/outdoor/mixed/unknown; mobility
  static/walking/biking/driving/mixed/unknown.
- Consider retaining `Data Technology` (Wi-Fi versus cellular); it is not in
  the canonical schema.

## Observations to revisit

- Importer activation still targets obsolete transient user services, not the
  public system unit plus local user unit. Update this integration before a live
  import/swap; `--check-only` remains available. See service.md.

- Missing GPS (previous example: `NH_5777`): rows cannot be mapped but remain
  eligible for summaries/charts. Decide whether to show a missing-location count.
  GPS quality is not comprehensively audited.
- Earlier technology-dropdown report needs reproduction. Current `/api/options`
  discovers technologies across LTE/NR partitions for selected collections and
  category, without filtering that list to the selected technology. Technologies
  absent from stored data will not appear.
- Timestamps remain timezone-naive; decide timezone semantics before changing
  import/display behavior.

## Implemented and committed; live rollout not verified

- Consolidated importer: build, validate, stop, swap, restart/check, rollback,
  and retained backups. No real reimport or live swap performed for this work.
- Shared SQLite links outside the swapped dataset, with legacy migration.
- One synthetic regression-test file retained for AI maintenance, extended with
  collection-bound and polygon-search coverage.
- Geo-poly searches exact polygons, lists matching databases/collections, and
  shows up to 6,000 aggregated Web Mercator squares with proportional collection
  sampling and explicit viewport refinement via Search. Manual side lengths are
  1/10/100/1000/10000/100000 projected meters (default 100000); zoom/pan do not query data;
  Average/Maximum follows filters, with no point/grid result caching.
  Polygon is optional for worldwide searches. Square clicks select matching
  collections; the right pane has a Select all checkbox below the summary.
  Explore results supports grid size and multi-operator/multi-band selections
  across checked primary result collections using auto-applying checkbox menus
  for operators/bands and a classic single-value grid-size select
  (300 ms debounce), plus a fresh return-to-primary query. Return is disabled
  until a secondary query has completed and after primary results are restored.
  Initial/restored exploration selections match primary filters. Grid label and
  selector are on one line; tooltip shows only aggregate/value and count, with
  approximate k-format above 9,999 measurements.
  Left-pane edits reactivate Search while preserving the polygon.
  Retry search clears failed polygon/results to idle controls, preserving left
  settings. Summary has two lines: all matching selected measurements, then
  displayed/eligible squares. Exploration counts reflect exploration filters.
  One combined box per collection is stored in DuckDB;
  248 existing collections were backfilled without changing measurements.
- Removed unchanged-Parquet fingerprinting; matching accepted snapshots are
  rewritten, while source-change detection and Parquet validation remain.

The previous Ookla PDSCH/PUSCH item is not an outstanding filter bug under the
owner's current rules. Only completed Capacity and Capacity HTTP/FTP are accepted:
Downlink for PDSCH, Uplink for PUSCH. Ookla is intentionally excluded. Code
changes do not retroactively refilter stored measurements.

See the [import guide](scripts/README.md) and [website guide](website/README.md)
for commands and current behavior.
