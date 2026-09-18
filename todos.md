# Remaining work

Reviewed against local source on 2026-09-18. These notes do not authorize
schema changes, reimports, or server restarts.

## Planned, not implemented

- Full CSV replacement: owner will supply the dump and decide retained columns.
  The single importer already supports `--rebuild`.
- Geo-polygon search tab across all databases.
- Collection tags: indoor/outdoor/mixed/unknown; mobility
  static/walking/biking/driving/mixed/unknown.
- Consider retaining `Data Technology` (Wi-Fi versus cellular); it is not in
  the canonical schema.

## Observations to revisit

- Missing GPS (previous example: `NH_5777`): rows cannot be mapped but remain
  eligible for summaries/charts. Decide whether to show a missing-location count.
  GPS quality is not comprehensively audited.
- Earlier technology-dropdown report needs reproduction. Current `/api/options`
  discovers technologies across LTE/NR partitions for selected collections and
  category, without filtering that list to the selected technology. Technologies
  absent from stored data will not appear.
- Timestamps remain timezone-naive; decide timezone semantics before changing
  import/display behavior.

## Implemented locally; live rollout not verified

- Consolidated importer: build, validate, stop, swap, restart/check, rollback,
  and retained backups. No real reimport or live swap performed for this work.
- Shared SQLite links outside the swapped dataset, with legacy migration.
- One synthetic regression-test file retained for AI maintenance; 35 tests pass.

The previous Ookla PDSCH/PUSCH item is not an outstanding filter bug under the
owner's current rules. Only completed Capacity and Capacity HTTP/FTP are accepted:
Downlink for PDSCH, Uplink for PUSCH. Ookla is intentionally excluded. Code
changes do not retroactively refilter stored measurements.

See the [import guide](scripts/README.md) and [website guide](website/README.md)
for commands and current behavior.
