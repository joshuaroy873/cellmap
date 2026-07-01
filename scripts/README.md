# Scripts

These scripts stage QualiPoc CSV exports, convert them into canonical Parquet
partitions, and maintain the DuckDB catalog used by the website.

## Staging Workflow

Put new CSVs in:

```text
data/_temp/
```

Then run:

```bash
python scripts/stage_temp_exports.py --date YYYYMMDD
```

The staging script:

- reads `Database` from each CSV;
- moves each CSV to `data/_csvs/<database>/<date>/`;
- runs `scripts/import_csvs.py`.

Supported date formats:

```text
YYYYMMDD
YYYYMMDD-HHMM
```

Useful option:

```bash
python scripts/stage_temp_exports.py --date YYYYMMDD --force
```

`--force` replaces differing CSVs already staged for that date and forces the
following import to rewrite matching partitions.

## Recognized CSV Names

```text
lte_radio.csv
lte_radio_neig.csv
lte_radio_neighbor.csv
lte_pdsch.csv
lte_pusch.csv
nr_radio.csv
nr_radio_neig.csv
nr_radio_neighbor.csv
nr_pdsch.csv
nr_pusch.csv
```

`scripts/stage_temp_exports.py` also accepts these QualiPoc auto-export names
in `data/_temp/` and renames them while staging:

```text
LTE Radio [connected].csv   -> lte_radio.csv
LTE Radio Neig.csv          -> lte_radio_neig.csv
LTE PDSCH [per-carrier].csv -> lte_pdsch.csv
LTE PUSCH [per-carrier].csv -> lte_pusch.csv
NR Radio [connected].csv    -> nr_radio.csv
NR Radio Beam.csv           -> nr_radio_neig.csv
NR PDSCH [per-carrier].csv  -> nr_pdsch.csv
NR PUSCH [per-carrier].csv  -> nr_pusch.csv
```

## Import Commands

Import all archived CSVs:

```bash
python scripts/import_csvs.py
```

Import one export folder:

```bash
python scripts/import_csvs.py data/_csvs/<database>/<date>
```

Force reprocessing and rewrite matching partitions:

```bash
python scripts/import_csvs.py --force
python scripts/import_csvs.py --force data/_csvs/<database>/<date>
```

Initialize the catalog without importing:

```bash
python scripts/init_database.py
```

Summarize the processed DuckDB catalog:

```bash
python scripts/summarize_database.py
python scripts/summarize_database.py --no-collections
python scripts/summarize_database.py --show-types
```

Close writable DuckDB connections before importing.

## Partition Model

Schema version: `2`

Partition key:

```text
database_name, collection_name, measurement_type
```

Measurement types:

```text
lte_radio
lte_radio_neighbor
lte_pdsch
lte_pusch
nr_radio
nr_radio_neighbor
nr_pdsch
nr_pusch
```

Each collection export is treated as a complete snapshot per measurement type.
A newer matching partition replaces the old partition. Missing partitions in a
newer export are retained. Rows are not deduplicated by timestamp.

## Canonical Columns

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

PDSCH rows are imported only when:

```text
Test Name = Capacity or Ookla(R)
Direction = Downlink
Test Status = Completed
```

PUSCH rows are imported only when:

```text
Test Name = Capacity or Ookla(R)
Direction = Uplink
Test Status = Completed
```

The filter columns above are required input columns but are not stored.

## Hashing

The importer stores:

- raw CSV SHA-256 hashes, used to skip identical files;
- canonical partition hashes, used to detect changed partitions.

Only canonical columns affect partition hashes. Extra QualiPoc columns are
ignored.

## DuckDB Tables

```text
measurement_partitions
processed_files
collections
```

`measurement_partitions` stores partition metadata and Parquet paths.
`processed_files` stores raw-file hashes.
`collections` stores collection-level time ranges and export metadata.
