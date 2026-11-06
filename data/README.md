# Data

Local measurement data and processed outputs. Only this README is tracked.

```text
data/_csvs/<database>/<YYYYMMDD[-HHMM]>/*.csv   dated QualiPoc CSV archive (optional)
data/_temp/                                     scratch drop folder
data/_processed/cellular.duckdb                 catalog: partitions, bounds, file hashes
data/_processed/measurements/<type>/database=…/collection=…/data.parquet
data/_processed/import-report.json              report of the activated import
data/shared_views.sqlite3                       share links; survives dataset swaps
data/.import.lock                               serialises import/delete commands
data/_rebuild-<id>/                             replacement being built, or a failed build
data/_backup-<id>/                              previous dataset kept after a swap
```

## Importing

```bash
.venv/bin/python scripts/import_csvs.py /path/to/csv-folder            # add or refresh snapshots
.venv/bin/python scripts/import_csvs.py /path/to/full-dump --rebuild    # replace everything
.venv/bin/python scripts/import_csvs.py /path/to/csv-folder --check-only
```

Inputs may live anywhere and are never moved or deleted. A matching
database/collection/type input replaces that partition as a whole; an empty
input never deletes data. The export time comes from the dated parent folder,
else the file's modification time, else `--date`. Details, safety and
rollback: [scripts/README.md](../scripts/README.md). Service integration
caveat: [service.md](../service.md#importer-integration-warning).

Failed and check-only builds and old backups are kept for inspection, not
cleaned up automatically. Unchanged Parquet files are hard-linked between
datasets.

## Removing a database

```bash
.venv/bin/python scripts/import_csvs.py --delete-database NAME         # preview
.venv/bin/python scripts/import_csvs.py --delete-database NAME --yes   # delete
```

Stop the website first. This removes the database's CSV archive, Parquet
partitions and catalog records, and nothing else. It is not a swap: there is
no rollback.

## Spatial metadata

`collection_bounds` holds one bounding box and located-row count per
database/collection across all types. Imports maintain it;
`--refresh-bounds` recomputes it from existing Parquet without reimporting.
Geo-poly uses it to skip collections that cannot intersect a polygon; a
missing box means scan, never exclude. Grid results are computed per query
and never stored.
