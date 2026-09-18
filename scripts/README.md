# CSV Import

There is one data-management command: `scripts/import_csvs.py`.
It scans a folder recursively, recognizes supported CSV names, validates and
filters the rows, and imports them into the website's dataset.

The consolidated safe-import workflow is implemented locally but has not yet
been used to reimport or swap the live dataset. Separate staging, initialization,
summary, and rebuild scripts are no longer needed.

## Everyday commands

Import a folder, preserving unrelated databases and collections:

```bash
.venv/bin/python scripts/import_csvs.py /path/to/csv-folder
```

Replace the entire dataset using only the supplied inputs:

```bash
.venv/bin/python scripts/import_csvs.py /path/to/complete-csv-dump --rebuild
```

Check either operation without changing live data or stopping the website:

```bash
.venv/bin/python scripts/import_csvs.py /path/to/csv-folder --check-only
.venv/bin/python scripts/import_csvs.py /path/to/complete-csv-dump --rebuild --check-only
```

Paths can be files or folders, inside or outside this repository. Subfolders and
uppercase `.CSV` extensions are supported. Original CSVs are never moved,
renamed, or deleted by an import. With no path, the script scans `data/_csvs`.

The export date comes from a `YYYYMMDD` or `YYYYMMDD-HHMM` parent folder,
otherwise from the file's modification time. Use `--date YYYYMMDD-HHMM` when
you know the export date and the folder/modification times are unsuitable.
Older snapshots cannot overwrite newer matching partitions. Different snapshots
for the same collection/type at the same export time are rejected as ambiguous.

## Recognized filenames

```text
lte_radio.csv
lte_radio_neig.csv / lte_radio_neighbor.csv
lte_pdsch.csv
lte_pusch.csv
nr_radio.csv
nr_radio_neig.csv / nr_radio_neighbor.csv
nr_pdsch.csv
nr_pusch.csv
```

QualiPoc names also work directly, without a separate staging step:

```text
LTE Radio [connected].csv
LTE Radio Neig.csv
LTE PDSCH [per-carrier].csv
LTE PUSCH [per-carrier].csv
NR Radio [connected].csv
NR Radio Beam.csv
NR PDSCH [per-carrier].csv
NR PUSCH [per-carrier].csv
```

Unrecognized CSV filenames stop the import with an error rather than silently
omitting potentially important measurements.

## Import versus rebuild

The partition key is `database_name, collection_name, measurement_type`.

- **Normal import:** matching partitions are complete snapshots, not rows to
  append. Unrelated partitions remain unchanged. Reimporting a CSV does not
  duplicate its measurements. Empty or fully excluded snapshots are reported
  and leave existing measurements untouched.
- **Rebuild:** starts from empty and replaces the complete dataset. Omitted
  databases/collections are not retained. For the existing
  `data/_csvs/<database>/<date>/<type>.csv` archive layout, only the newest
  supplied file per database/type is used, including empty files. Otherwise,
  newer supplied collection/type snapshots take precedence over older ones.
- A header-only file outside the dated archive layout cannot identify its
  database or collections. A rebuild rejects it if another file of the same
  measurement type makes its scope ambiguous. Supply only the intended current
  exports, or use the dated archive layout.
- A full rebuild with zero accepted measurements requires `--allow-empty`.
  Normal imports never interpret an empty input as an instruction to delete data.

## Safe imports and rebuilds

Both modes use **build → validate → briefly stop → swap → restart/check**:

1. Prepare a dataset in `data/_rebuild-<id>/`. Normal imports copy the existing
   catalog and hard-link its Parquet files; rebuilds start empty. Changed
   partitions are written to new files, so live measurements are never modified.
2. Report raw/accepted/rule-excluded rows and empty files. Missing required
   columns or invalid required values block activation, even in excluded rows.
3. Read all Parquet partitions and verify schema, counts, time bounds and
   collection identity against the catalog. Reject missing or extra files.
4. Stop the configured website services. Preserve old SQLite links in
   `data/shared_views.sqlite3` outside the swapped folder, and copy legacy
   DuckDB links into the replacement catalog.
5. Rename the active `data/_processed` to `data/_backup-<id>`, put the staged
   dataset at the original path, restart, and check the API. Activation failures
   restore the previous folder and restart/check it. No dataset is automatically
   deleted.

An `import-report.json` in the prepared dataset records source files and row
counts. Failed or check-only builds are retained for inspection. Builds and
validation use two DuckDB threads and a 1 GB memory limit. A shared import lock
prevents overlapping imports/deletions. Source files changing during processing
also block activation.

Activation controls the Linux server's systemd user units, defaulting to
`cellmap-server-8000.service` and `cellmap-repo-preview-8001.service`. For other
names, repeat `--service NAME.service`. Only initially active instances are
restarted; if none are running, import happens offline. Unmanaged website
processes must be stopped or placed under a named service first. Persistent
units are restarted; transient units are recreated with their command and
working directory. No browser automation is involved.

Ctrl+C and SIGTERM during activation trigger rollback. Power loss, SIGKILL, or
a failure during rollback can require manual recovery. Exact backup paths are
printed before stopping anything. Keep all instances stopped, move a failed
active dataset aside without deleting it, restore the backup to
`data/_processed`, and restart. Keep `data/shared_views.sqlite3` untouched.
Do not guess which backup is current.

## Delete a database

Preview only:

```bash
.venv/bin/python scripts/import_csvs.py --delete-database DATABASE
```

Confirm permanent deletion (stop the website first):

```bash
.venv/bin/python scripts/import_csvs.py --delete-database DATABASE --yes
```

This separate operation removes that database's archived CSV directory, processed
partitions and matching catalog records. It does not delete externally supplied
CSVs, shared links, other databases, or retained dataset backups. Unlike imports,
confirmed deletion is not a dataset-swap operation.

## Tests and shared definitions

`cellmap_schema.py` holds the definitions shared with the website; it is not a
separate command. Schema/filter version: `3`.

One regression-test file covers imports, filters, validation, shared links and
rollback using synthetic data, without touching live measurements or services:

```bash
.venv/bin/python -m unittest discover -s tests -v
```

The single test file is retained for AI-assisted maintenance after code changes,
not as a required step for every CSV import. All 36 tests passed on 2026-09-18.
Service operations are mocked; these are not live deployment or browser tests.

## Canonical Columns

The canonical schema is defined in `cellmap_schema.py` and shared by the
importer and website server.

These columns are present in every processed measurement type:

```text
measured_at TIMESTAMP
database_name VARCHAR
collection_name VARCHAR
latitude DOUBLE
longitude DOUBLE
operator_name VARCHAR
model VARCHAR
```

### Radio

```text
technology VARCHAR
rat VARCHAR
band_number BIGINT
pci BIGINT
ssb_index BIGINT
dl_channel_number BIGINT
ul_channel_number BIGINT
dl_bandwidth_mhz DOUBLE
dl_bandwidth_aggregated_mhz DOUBLE
ul_bandwidth_mhz DOUBLE
ul_bandwidth_aggregated_mhz DOUBLE
dl_scs_khz BIGINT
cell_type VARCHAR
rsrp_dbm DOUBLE
rsrq_db DOUBLE
rssi_dbm DOUBLE
sinr_db DOUBLE
```

LTE radio stores `ssb_index` as `NULL` and `dl_scs_khz` as 15. NR radio
stores `rssi_dbm` as `NULL`.

### Radio Neighbor

```text
technology VARCHAR
rat VARCHAR
band_number BIGINT
pci BIGINT
ssb_index BIGINT
dl_channel_number BIGINT
ul_channel_number BIGINT
dl_scs_khz BIGINT
is_serving_beam BOOLEAN
rsrp_dbm DOUBLE
rsrq_db DOUBLE
rssi_dbm DOUBLE
sinr_db DOUBLE
```

LTE neighbor stores `ssb_index`, `is_serving_beam`, and `sinr_db` as `NULL`;
NR neighbor stores `rssi_dbm` as `NULL`.

### PDSCH

```text
technology VARCHAR
rat VARCHAR
band_number BIGINT
pci BIGINT
ssb_index BIGINT
dl_channel_number BIGINT
dl_bandwidth_mhz DOUBLE
dl_bandwidth_aggregated_mhz DOUBLE
dl_scs_khz BIGINT
cell_type VARCHAR
throughput_mbps DOUBLE
mcs DOUBLE
avg_pdsch_layers DOUBLE
pdsch_rbs DOUBLE
bler DOUBLE
modulation VARCHAR
```

LTE PDSCH stores `ssb_index` as `NULL` and `dl_scs_khz` as 15. Throughput is
converted from Kbps to Mbps.

### PUSCH

```text
technology VARCHAR
rat VARCHAR
band_number BIGINT
pci BIGINT
ssb_index BIGINT
ul_channel_number BIGINT
ul_bandwidth_mhz DOUBLE
ul_bandwidth_aggregated_mhz DOUBLE
ul_scs_khz BIGINT
cell_type VARCHAR
throughput_mbps DOUBLE
mcs DOUBLE
avg_pusch_layers DOUBLE
pusch_rbs DOUBLE
modulation VARCHAR
```

LTE PUSCH stores `ssb_index` as `NULL` and `ul_scs_khz` as 15. Throughput is
converted from Kbps to Mbps.

## Normalization

The importer:

- matches supported QualiPoc header aliases;
- trims string values;
- stores empty strings and failed numeric casts as `NULL`;
- requires valid `Time`, `Database`, and `Collection`;
- derives `technology` from the source filename;
- copies QualiPoc `RAN Configuration` into `rat`;
- stores LTE SCS as 15 kHz;
- stores LTE `ssb_index` as `NULL`;
- converts QualiPoc throughput from Kbps to Mbps.

Radio and Neighbour rows are not filtered by Test Name, Direction, or Test Status.
The common validation requirements above still apply.

PDSCH and PUSCH rows (both LTE and NR) are imported only when:

```text
Test Name = Capacity or Capacity HTTP/FTP
Direction = Downlink for PDSCH; Uplink for PUSCH
Test Status = Completed
```

The filter columns above are required input columns but are not stored.
PDSCH excludes Uplink tests; PUSCH excludes Downlink tests. Ookla and all other
test names are excluded from PDSCH/PUSCH imports. Existing processed data
is unchanged until an import is run. Supplied files use schema version 3;
unrelated older partitions remain in a normal import if their physical schema
validates. Use a full rebuild to apply current rules throughout the dataset.

## Hashing

The importer retains raw CSV SHA-256 hashes for source provenance, detecting
files changed during processing, and recognizing identical same-date inputs.
Parquet validation also hashes decoded rows to ensure every column is read.

There is no normalized-data fingerprint or unchanged-Parquet shortcut.
Accepted matching snapshots are rewritten even when their measurements are
identical; older inputs are still skipped and unrelated partitions are retained.
`--force` was removed because rewriting is now the default. Reimports replace
partitions rather than appending duplicate rows.

The legacy catalog `content_hash` column is retained for compatibility with
existing catalogs but is unused; rewritten partitions store an empty string.

## DuckDB Tables

```text
measurement_partitions
processed_files
collections
```

`measurement_partitions` stores partition metadata and Parquet paths.
`processed_files` stores raw-file hashes.
`collections` stores collection-level time ranges and export metadata.
