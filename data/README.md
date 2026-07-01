# Data

This folder is for local measurement data and processed outputs. Keep raw CSVs,
DuckDB files, and Parquet files here; do not commit them to GitHub.

```text
data/_temp/                         temporary CSV drop folder
data/_csvs/<database>/<date>/*.csv   raw QualiPoc CSV archive
data/_processed/cellular.duckdb      DuckDB catalog
data/_processed/measurements/        partitioned Parquet output
```

Supported export date folder formats:

```text
YYYYMMDD
YYYYMMDD-HHMM
```

Only this README is intended to be tracked in Git.
