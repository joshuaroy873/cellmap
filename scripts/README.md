# CSV import

`scripts/import_csvs.py` is the one data-management command. It scans a folder,
recognises supported QualiPoc CSV names, normalises and filters rows, writes
Parquet partitions, and activates the result with validation and rollback.

## Commands

```bash
.venv/bin/python scripts/import_csvs.py /path/to/csv-folder                 # add or refresh snapshots
.venv/bin/python scripts/import_csvs.py /path/to/full-dump --rebuild         # replace the whole dataset
.venv/bin/python scripts/import_csvs.py /path/to/csv-folder --check-only     # build and validate only
.venv/bin/python scripts/import_csvs.py --refresh-bounds                     # recompute spatial metadata
.venv/bin/python scripts/import_csvs.py --delete-database NAME [--yes]       # preview, then delete
```

Paths may be files or folders anywhere; subfolders and `.CSV` are fine; sources
are never moved or deleted. With no path the script scans `data/_csvs`. The
export time is the `YYYYMMDD` or `YYYYMMDD-HHMM` parent folder, else the file's
modification time; `--date` overrides both. Older exports never overwrite newer
partitions, and two different snapshots with the same key and time are
rejected as ambiguous.

Service caveat: activation only manages systemd **user** units and defaults to
obsolete names, so it cannot restart the public system unit. Use
`--check-only`, then swap and restart by hand, until that is adapted. See
[service.md](../service.md#importer-integration-warning).

## Recognised files

```text
lte_radio.csv        LTE Radio [connected].csv
lte_radio_neig.csv   LTE Radio Neig.csv           (also lte_radio_neighbor.csv)
lte_pdsch.csv        LTE PDSCH [per-carrier].csv
lte_pusch.csv        LTE PUSCH [per-carrier].csv
nr_radio.csv         NR Radio [connected].csv
nr_radio_neig.csv    NR Radio Beam.csv            (also nr_radio_neighbor.csv)
nr_pdsch.csv         NR PDSCH [per-carrier].csv
nr_pusch.csv         NR PUSCH [per-carrier].csv
```

An unrecognised CSV name stops the import rather than silently skipping data.

## Import versus rebuild

The partition key is `database_name, collection_name, measurement_type`.

- **Import** treats each matching input as the complete new snapshot of that
  partition. Unrelated partitions are untouched, reimporting does not duplicate
  rows, and an empty or fully filtered input leaves existing data in place.
- **Rebuild** starts empty and keeps only what the inputs contain. In the dated
  archive layout only the newest file per database/type is used; otherwise the
  newest snapshot per key wins. A rebuild with zero accepted rows needs
  `--allow-empty`. A header-only file outside the dated layout cannot name its
  collections and is rejected if it makes a type's scope ambiguous.

## Safe imports and rebuilds

Both modes run build, validate, stop, swap, restart, check:

1. Build the dataset in `data/_rebuild-<id>/`. Imports copy the catalog and
   hard-link unchanged Parquet; changed partitions are new files, so the live
   dataset is never modified in place.
2. Report raw, accepted and rule-excluded rows per file. Missing required
   columns or invalid required values block activation.
3. Re-read every Parquet file and check schema, counts, time bounds,
   collection identity and spatial bounds against the catalog.
4. Stop the managed services. Share links live in `data/shared_views.sqlite3`
   outside the swapped folder; legacy links are copied into the new catalog.
5. Rename `data/_processed` to `data/_backup-<id>`, move the build into place,
   restart and check `/api/health`. Any failure restores the backup. Nothing is
   deleted automatically.

Builds use two DuckDB threads and 1 GB. A lock in `data/.import.lock` prevents
overlapping imports and deletions; a source file changing mid-run blocks
activation. Ctrl+C or SIGTERM during activation rolls back. After a power loss
or SIGKILL, keep the services stopped, move the broken `_processed` aside, put
the newest `_backup-<id>` back, and restart.

## Deleting a database

`--delete-database NAME` previews; `--yes` performs it. Stop the website
first. It removes that database's CSV archive, Parquet partitions and catalog
records, including bounds, and nothing else. It is not a swap and has no
rollback.

## Schema

Defined once in `cellmap_schema.py` and shared with the website. Schema and
filter version 3.

Common to every type:

```text
measured_at TIMESTAMP (device clock, timezone-naive)
database_name, collection_name, operator_name, model VARCHAR
latitude, longitude DOUBLE
```

Per type, after the common columns:

```text
radio           technology, rat, band_number, pci, ssb_index, dl/ul_channel_number,
                dl/ul_bandwidth_mhz, dl/ul_bandwidth_aggregated_mhz, dl_scs_khz,
                cell_type, rsrp_dbm, rsrq_db, rssi_dbm, sinr_db
radio_neighbor  technology, rat, band_number, pci, ssb_index, dl/ul_channel_number,
                dl_scs_khz, is_serving_beam, rsrp_dbm, rsrq_db, rssi_dbm, sinr_db
pdsch           technology, rat, band_number, pci, ssb_index, dl_channel_number,
                dl_bandwidth_mhz, dl_bandwidth_aggregated_mhz, dl_scs_khz, cell_type,
                throughput_mbps, mcs, avg_pdsch_layers, pdsch_rbs, bler, modulation
pusch           technology, rat, band_number, pci, ssb_index, ul_channel_number,
                ul_bandwidth_mhz, ul_bandwidth_aggregated_mhz, ul_scs_khz, cell_type,
                throughput_mbps, mcs, avg_pusch_layers, pusch_rbs, modulation
```

LTE rows store `ssb_index` as NULL and SCS as 15 kHz; LTE neighbours also
store `is_serving_beam` and `sinr_db` as NULL. NR rows store `rssi_dbm` as
NULL. Throughput is converted from kbps to Mbps.

## Normalisation and filters

Header aliases are matched case-insensitively; strings are trimmed, with empty
strings and failed numeric casts stored as NULL; `Time`, `Database` and
`Collection` are required; `technology` comes from the file type and `rat`
from QualiPoc `RAN Configuration`.

Radio and neighbour rows are not filtered. PDSCH and PUSCH rows are kept only
when `Test Name` is `Capacity` or `Capacity HTTP/FTP`, `Test Status` is
`Completed`, and `Direction` is `Downlink` (PDSCH) or `Uplink` (PUSCH). The
filter columns are not stored. Rule changes do not refilter stored data; use a
rebuild.

## Catalog

`cellular.duckdb` holds `measurement_partitions` (one row per partition with
its Parquet path, counts, time range and source hash), `processed_files`
(raw-file SHA-256 for provenance and change detection), the `collections`
view, and `collection_bounds` (one lat/lon box and located-row count per
database/collection across all types; used by Geo-poly to skip collections,
with a missing box meaning scan). `--refresh-bounds` rewrites only that
table and needs no other readers holding the catalog open.

## Tests

```bash
.venv/bin/python -m unittest discover -s tests
```

One synthetic suite (54 tests) covers import rules, validation, swap and
rollback, share-link migration, bounds, polygon search, square aggregation,
quotas and exploration. Services are mocked; nothing touches live data.
