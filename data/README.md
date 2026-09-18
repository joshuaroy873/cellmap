# Data

This folder is for local measurement data and processed outputs. Keep raw CSVs,
DuckDB files, and Parquet files here; do not commit them to GitHub.

```text
data/_temp/                          optional CSV drop folder
data/_csvs/<database>/<date>/*.csv   optional dated QualiPoc CSV archive
data/_processed/cellular.duckdb      DuckDB catalog
data/_processed/measurements/        partitioned Parquet output
data/_processed/import-report.json  latest activated import/rebuild report
data/shared_views.sqlite3            shared links, outside dataset swaps
data/.import.lock                   lock for import/delete commands
data/_rebuild-<id>/                  replacement being built (or failed build)
data/_backup-<id>/                   previous dataset retained after a swap
```

From the repo root, use `.venv/bin/python scripts/import_csvs.py /path/to/csv-folder` to scan and
import CSVs. Inputs may also be outside this repository; they are not moved or
deleted. Add `--rebuild` only when replacing the entire dataset, or `--check-only`
to validate without activating. See the [import guide](../scripts/README.md).

Supported export date folder formats:

```text
YYYYMMDD
YYYYMMDD-HHMM
```

## Remove a Database

Stop the website before confirmed deletion. Replace `DATABASE` below with the
name, quoted if it contains spaces.

Preview removal of one complete local database before deleting it:

```bash
.venv/bin/python scripts/import_csvs.py --delete-database DATABASE
```

To confirm the permanent deletion:

```bash
.venv/bin/python scripts/import_csvs.py --delete-database DATABASE --yes
```

This removes that database's raw CSV archive, generated Parquet partitions, and
matching DuckDB metadata. It preserves `data/_temp/`, `cellular.duckdb`, and all
other databases. The preview lists every catalog collection first. See the
[scripts guide](../scripts/README.md#delete-a-database) for the full scope and
safeguards.

Only this README is intended to be tracked in Git.

## Import safety and rollout

Without a dated parent folder, export time comes from file modification time;
`--date` overrides it. Matching collection/type inputs replace snapshots, not
individual rows. Empty normal inputs do not clear existing measurements.

Stages contain `import-report.json` after successful validation. Check-only and
failed stages, plus old backups, are retained for inspection, not automatically
cleaned up. Review exact paths before removal. Unchanged Parquet files are
hard-linked during normal imports.

The stable SQLite location is implemented in source. Older processes may still
use `data/_processed/shared_views.sqlite3`; startup/activation migrates links
without deleting the original. No live rebuild or migration was performed for
the importer-safety work.

Confirmed database deletion does not use swap/rollback safety. External input
CSVs, shared links, and retained backups are not deleted.
