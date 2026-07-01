#!/usr/bin/env python3
"""Import QualiPoc CSV snapshots into hashed Parquet partitions."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import duckdb

from init_database import DB_PATH, ROOT, initialize


DATA = ROOT / "data"
OUTPUT = DATA / "_processed/measurements"
SCHEMA_VERSION = 2

# Every field below is part of the canonical hash. Unlisted QualiPoc columns
# are intentionally ignored, so adding an unrelated export column changes
# neither the stored data nor its hash.
COMMON = [
    ("measured_at", "TIMESTAMP", ["time", "timestamp"]),
    ("database_name", "VARCHAR", ["database", "database_name"]),
    ("collection_name", "VARCHAR", ["collection", "collection_name"]),
    ("latitude", "DOUBLE", ["latitude"]),
    ("longitude", "DOUBLE", ["longitude"]),
    ("operator_name", "VARCHAR", ["operator", "operator_name"]),
    ("model", "VARCHAR", ["model"]),
]

SCHEMAS = {
    "lte_radio": [
        ("technology", "VARCHAR", []),
        ("rat", "VARCHAR", ["ran_configuration"]),
        ("band_number", "BIGINT", ["band_number", "band"]),
        ("pci", "BIGINT", ["pci_lte", "pci"]),
        ("ssb_index", "BIGINT", []),
        ("dl_channel_number", "BIGINT", ["dl_earfcn"]),
        ("ul_channel_number", "BIGINT", ["ul_earfcn"]),
        ("dl_bandwidth_mhz", "DOUBLE", ["dl_bandwidth"]),
        (
            "dl_bandwidth_aggregated_mhz",
            "DOUBLE",
            ["dl_bandwidth_aggregated"],
        ),
        ("ul_bandwidth_mhz", "DOUBLE", ["ul_bandwidth"]),
        (
            "ul_bandwidth_aggregated_mhz",
            "DOUBLE",
            ["ul_bandwidth_aggregated"],
        ),
        ("dl_scs_khz", "BIGINT", []),
        ("cell_type", "VARCHAR", ["cell_type"]),
        ("rsrp_dbm", "DOUBLE", ["rsrp"]),
        ("rsrq_db", "DOUBLE", ["rsrq"]),
        ("rssi_dbm", "DOUBLE", ["rssi_lte", "rssi"]),
        ("sinr_db", "DOUBLE", ["sinr"]),
    ],
    "lte_radio_neighbor": [
        ("technology", "VARCHAR", []),
        ("rat", "VARCHAR", ["ran_configuration"]),
        ("band_number", "BIGINT", ["band_number", "band"]),
        ("pci", "BIGINT", ["pci_lte", "pci"]),
        ("ssb_index", "BIGINT", []),
        ("dl_channel_number", "BIGINT", ["dl_earfcn"]),
        ("ul_channel_number", "BIGINT", ["ul_earfcn"]),
        ("dl_scs_khz", "BIGINT", []),
        ("is_serving_beam", "BOOLEAN", []),
        ("rsrp_dbm", "DOUBLE", ["rsrp"]),
        ("rsrq_db", "DOUBLE", ["rsrq"]),
        ("rssi_dbm", "DOUBLE", ["rssi"]),
        ("sinr_db", "DOUBLE", []),
    ],
    "lte_pdsch": [
        ("technology", "VARCHAR", []),
        ("rat", "VARCHAR", ["ran_configuration"]),
        ("band_number", "BIGINT", ["band_number", "band"]),
        ("pci", "BIGINT", ["pci_lte", "pci"]),
        ("ssb_index", "BIGINT", []),
        ("dl_channel_number", "BIGINT", ["dl_earfcn"]),
        ("dl_bandwidth_mhz", "DOUBLE", ["dl_bandwidth"]),
        (
            "dl_bandwidth_aggregated_mhz",
            "DOUBLE",
            ["dl_bandwidth_aggregated"],
        ),
        ("dl_scs_khz", "BIGINT", []),
        ("cell_type", "VARCHAR", ["cell_type"]),
        ("throughput_mbps", "DOUBLE", ["lte_net_pdsch_throughput"]),
        ("mcs", "DOUBLE", ["mcs"]),
        ("avg_pdsch_layers", "DOUBLE", ["avg_pdsch_layers"]),
        ("pdsch_rbs", "DOUBLE", ["pdsch_rbs"]),
        ("bler", "DOUBLE", ["bler"]),
        ("modulation", "VARCHAR", ["pdsch_modulation"]),
    ],
    "lte_pusch": [
        ("technology", "VARCHAR", []),
        ("rat", "VARCHAR", ["ran_configuration"]),
        ("band_number", "BIGINT", ["band_number", "band"]),
        ("pci", "BIGINT", ["pci_lte", "pci"]),
        ("ssb_index", "BIGINT", []),
        ("ul_channel_number", "BIGINT", ["ul_earfcn"]),
        ("ul_bandwidth_mhz", "DOUBLE", ["ul_bandwidth"]),
        (
            "ul_bandwidth_aggregated_mhz",
            "DOUBLE",
            ["ul_bandwidth_aggregated"],
        ),
        ("ul_scs_khz", "BIGINT", []),
        ("cell_type", "VARCHAR", ["cell_type"]),
        ("throughput_mbps", "DOUBLE", ["lte_net_pusch_throughput"]),
        ("mcs", "DOUBLE", ["mcs"]),
        ("avg_pusch_layers", "DOUBLE", ["avg_pusch_layers"]),
        ("pusch_rbs", "DOUBLE", ["pusch_rbs"]),
        ("modulation", "VARCHAR", ["pusch_modulation"]),
    ],
    "nr_radio": [
        ("technology", "VARCHAR", []),
        ("rat", "VARCHAR", ["ran_configuration"]),
        ("band_number", "BIGINT", ["band_number", "band"]),
        ("pci", "BIGINT", ["pci_5g_nr", "pci_nr", "pci"]),
        ("ssb_index", "BIGINT", ["ssb_index"]),
        ("dl_channel_number", "BIGINT", ["dl_nrarfcn", "dl_nr_arfcn"]),
        ("ul_channel_number", "BIGINT", ["ul_nrarfcn", "ul_nr_arfcn"]),
        ("dl_bandwidth_mhz", "DOUBLE", ["dl_bandwidth"]),
        (
            "dl_bandwidth_aggregated_mhz",
            "DOUBLE",
            ["dl_bandwidth_aggregated"],
        ),
        ("ul_bandwidth_mhz", "DOUBLE", ["ul_bandwidth"]),
        (
            "ul_bandwidth_aggregated_mhz",
            "DOUBLE",
            ["ul_bandwidth_aggregated"],
        ),
        ("dl_scs_khz", "BIGINT", ["dl_subcarrier_spacing"]),
        ("cell_type", "VARCHAR", ["cell_type"]),
        ("rsrp_dbm", "DOUBLE", ["ssrsrp", "ss_rsrp"]),
        ("rsrq_db", "DOUBLE", ["ssrsrq", "ss_rsrq"]),
        ("rssi_dbm", "DOUBLE", []),
        ("sinr_db", "DOUBLE", ["sssinr", "ss_sinr"]),
    ],
    "nr_radio_neighbor": [
        ("technology", "VARCHAR", []),
        ("rat", "VARCHAR", ["ran_configuration"]),
        ("band_number", "BIGINT", ["band_number", "band"]),
        ("pci", "BIGINT", ["pci_5g_nr", "pci_nr", "pci"]),
        ("ssb_index", "BIGINT", ["ssb_index"]),
        ("dl_channel_number", "BIGINT", ["dl_nrarfcn", "dl_nr_arfcn"]),
        ("ul_channel_number", "BIGINT", ["ul_nrarfcn", "ul_nr_arfcn"]),
        ("dl_scs_khz", "BIGINT", ["dl_subcarrier_spacing"]),
        ("is_serving_beam", "BOOLEAN", ["is_serving_beam"]),
        ("rsrp_dbm", "DOUBLE", ["ssrsrp", "ss_rsrp"]),
        ("rsrq_db", "DOUBLE", ["ssrsrq", "ss_rsrq"]),
        ("rssi_dbm", "DOUBLE", []),
        ("sinr_db", "DOUBLE", ["sssinr", "ss_sinr"]),
    ],
    "nr_pdsch": [
        ("technology", "VARCHAR", []),
        ("rat", "VARCHAR", ["ran_configuration"]),
        ("band_number", "BIGINT", ["band_number", "band"]),
        ("pci", "BIGINT", ["pci_5g_nr", "pci_nr", "pci"]),
        ("ssb_index", "BIGINT", ["ssb_index"]),
        ("dl_channel_number", "BIGINT", ["dl_nrarfcn", "dl_nr_arfcn"]),
        ("dl_bandwidth_mhz", "DOUBLE", ["dl_bandwidth"]),
        (
            "dl_bandwidth_aggregated_mhz",
            "DOUBLE",
            ["dl_bandwidth_aggregated"],
        ),
        ("dl_scs_khz", "BIGINT", ["pdsch_scs"]),
        ("cell_type", "VARCHAR", ["cell_type"]),
        ("throughput_mbps", "DOUBLE", ["5g_nr_net_pdsch_throughput"]),
        ("mcs", "DOUBLE", ["mcs"]),
        ("avg_pdsch_layers", "DOUBLE", ["avg_pdsch_layers"]),
        ("pdsch_rbs", "DOUBLE", ["pdsch_rbs"]),
        ("bler", "DOUBLE", ["pdsch_bler"]),
        ("modulation", "VARCHAR", ["pdsch_modulation"]),
    ],
    "nr_pusch": [
        ("technology", "VARCHAR", []),
        ("rat", "VARCHAR", ["ran_configuration"]),
        ("band_number", "BIGINT", ["band_number", "band"]),
        ("pci", "BIGINT", ["pci_5g_nr", "pci_nr", "pci"]),
        ("ssb_index", "BIGINT", ["ssb_index"]),
        ("ul_channel_number", "BIGINT", ["ul_nrarfcn", "ul_nr_arfcn"]),
        ("ul_bandwidth_mhz", "DOUBLE", ["ul_bandwidth"]),
        (
            "ul_bandwidth_aggregated_mhz",
            "DOUBLE",
            ["ul_bandwidth_aggregated"],
        ),
        ("ul_scs_khz", "BIGINT", ["pusch_scs"]),
        ("cell_type", "VARCHAR", ["cell_type"]),
        ("throughput_mbps", "DOUBLE", ["5g_nr_net_pusch_throughput"]),
        ("mcs", "DOUBLE", ["mcs"]),
        ("avg_pusch_layers", "DOUBLE", ["avg_pusch_layers"]),
        ("pusch_rbs", "DOUBLE", ["pusch_rbs"]),
        ("modulation", "VARCHAR", ["pusch_modulation"]),
    ],
}

DERIVED = {
    "lte_radio": {
        "technology": "'LTE'",
        "ssb_index": "NULL",
        "dl_scs_khz": "15",
    },
    "lte_radio_neighbor": {
        "technology": "'LTE'",
        "ssb_index": "NULL",
        "dl_scs_khz": "15",
        "is_serving_beam": "NULL",
        "sinr_db": "NULL",
    },
    "lte_pdsch": {
        "technology": "'LTE'",
        "ssb_index": "NULL",
        "dl_scs_khz": "15",
    },
    "lte_pusch": {
        "technology": "'LTE'",
        "ssb_index": "NULL",
        "ul_scs_khz": "15",
    },
    "nr_radio": {"technology": "'NR'", "rssi_dbm": "NULL"},
    "nr_radio_neighbor": {"technology": "'NR'", "rssi_dbm": "NULL"},
    "nr_pdsch": {"technology": "'NR'"},
    "nr_pusch": {"technology": "'NR'"},
}

ROW_FILTERS = {
    "lte_pdsch": [
        (["test_name"], ("Capacity", "Ookla(R)")),
        (["direction"], "Downlink"),
        (["test_status"], "Completed"),
    ],
    "nr_pdsch": [
        (["test_name"], ("Capacity", "Ookla(R)")),
        (["direction"], "Downlink"),
        (["test_status"], "Completed"),
    ],
    "lte_pusch": [
        (["test_name"], ("Capacity", "Ookla(R)")),
        (["direction"], "Uplink"),
        (["test_status"], "Completed"),
    ],
    "nr_pusch": [
        (["test_name"], ("Capacity", "Ookla(R)")),
        (["direction"], "Uplink"),
        (["test_status"], "Completed"),
    ],
}

FILE_TYPES = {
    "lte_radio": "lte_radio",
    "lte_radio_neig": "lte_radio_neighbor",
    "lte_radio_neighbor": "lte_radio_neighbor",
    "lte_pdsch": "lte_pdsch",
    "lte_pusch": "lte_pusch",
    "nr_radio": "nr_radio",
    "nr_radio_neig": "nr_radio_neighbor",
    "nr_radio_neighbor": "nr_radio_neighbor",
    "nr_pdsch": "nr_pdsch",
    "nr_pusch": "nr_pusch",
}


def is_temp_path(path: Path) -> bool:
    return "_temp" in path.parts


def sql_string(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def sql_name(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def token(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def export_time(path: Path) -> datetime:
    batch = path.parent.name
    for pattern in ("%Y%m%d-%H%M", "%Y%m%d"):
        try:
            return datetime.strptime(batch, pattern)
        except ValueError:
            pass
    raise ValueError(f"{path}: export folder must be YYYYMMDD or YYYYMMDD-HHMM")


def canonical_select(con: duckdb.DuckDBPyConnection, path: Path, kind: str) -> str:
    source = f"""
        read_csv_auto(
            {sql_string(path)},
            all_varchar = true,
            normalize_names = true,
            header = true,
            null_padding = true
        )
    """
    columns = [
        row[0] for row in con.execute(f"DESCRIBE SELECT * FROM {source}").fetchall()
    ]
    available = {}
    for column in columns:
        available.setdefault(token(column), column)

    expressions = []
    filters = []
    missing = []
    for name, data_type, aliases in COMMON + SCHEMAS[kind]:
        derived = DERIVED.get(kind, {}).get(name)
        if derived is not None:
            expressions.append(
                f"cast({derived} AS {data_type}) AS {sql_name(name)}"
            )
            continue
        source_name = next(
            (available[token(alias)] for alias in aliases if token(alias) in available),
            None,
        )
        if source_name is None:
            missing.append(f"{name} ({' / '.join(aliases)})")
            continue
        column = sql_name(source_name)
        if data_type == "VARCHAR":
            value = f"nullif(trim(cast({column} AS VARCHAR)), '')"
        else:
            value = f"try_cast({column} AS {data_type})"
            if name == "throughput_mbps":
                value = f"({value}) / 1000"
        expressions.append(f"{value} AS {sql_name(name)}")

    for aliases, expected in ROW_FILTERS.get(kind, []):
        source_name = next(
            (available[token(alias)] for alias in aliases if token(alias) in available),
            None,
        )
        if source_name is None:
            missing.append(f"input filter ({' / '.join(aliases)})")
            continue
        column = sql_name(source_name)
        value = f"lower(trim(cast({column} AS VARCHAR)))"
        if isinstance(expected, tuple):
            allowed = ", ".join(sql_string(item.lower()) for item in expected)
            filters.append(f"{value} IN ({allowed})")
        else:
            filters.append(f"{value} = lower({sql_string(expected)})")

    if missing:
        raise ValueError(
            f"{path}: missing canonical columns: {', '.join(missing)}"
        )
    where = f" WHERE {' AND '.join(filters)}" if filters else ""
    return f"SELECT {', '.join(expressions)} FROM {source}{where}"


def partition_fingerprint(
    kind: str, columns: list[str], aggregate: tuple[object, ...]
) -> str:
    payload = [SCHEMA_VERSION, kind, columns, *aggregate]
    return hashlib.sha256(
        json.dumps(payload, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def upsert_partition(
    con: duckdb.DuckDBPyConnection,
    values: tuple[object, ...],
) -> None:
    con.execute(
        """
        INSERT INTO measurement_partitions (
            database_name,
            collection_name,
            measurement_type,
            schema_version,
            export_date,
            exported_at,
            row_count,
            start_time,
            end_time,
            content_hash,
            source_file_hash,
            parquet_path,
            processed_at
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now()
        )
        ON CONFLICT (database_name, collection_name, measurement_type)
        DO UPDATE SET
            schema_version = excluded.schema_version,
            export_date = excluded.export_date,
            exported_at = excluded.exported_at,
            row_count = excluded.row_count,
            start_time = excluded.start_time,
            end_time = excluded.end_time,
            content_hash = excluded.content_hash,
            source_file_hash = excluded.source_file_hash,
            parquet_path = excluded.parquet_path,
            processed_at = now()
        """,
        values,
    )


def import_file(
    con: duckdb.DuckDBPyConnection, path: Path, kind: str, force: bool
) -> None:
    exported_at = export_time(path)
    raw_hash = file_hash(path)
    if not force and con.execute(
        """
        SELECT 1 FROM processed_files
        WHERE file_hash = ? AND measurement_type = ? AND schema_version = ?
        """,
        [raw_hash, kind, SCHEMA_VERSION],
    ).fetchone():
        print(
            f"SKIP file unchanged [{path.parent.name}]: "
            f"{path.relative_to(ROOT)}"
        )
        return

    select = canonical_select(con, path, kind)
    con.execute(f"CREATE OR REPLACE TEMP TABLE staged AS {select}")
    invalid = con.execute("""
        SELECT count(*) FROM staged
        WHERE measured_at IS NULL
           OR database_name IS NULL
           OR collection_name IS NULL
    """).fetchone()[0]
    if invalid:
        raise ValueError(f"{path}: {invalid} rows lack time, database, or collection")

    columns = [row[1] for row in con.execute("PRAGMA table_info('staged')").fetchall()]
    fields = ", ".join(f"{sql_name(name)} := {sql_name(name)}" for name in columns)
    rows = con.execute(f"""
        WITH hashed AS (
            SELECT
                *,
                to_json(struct_pack({fields})) AS row_json
            FROM staged
        )
        SELECT
            database_name,
            collection_name,
            count(*) AS row_count,
            min(measured_at) AS start_time,
            max(measured_at) AS end_time,
            sum(md5_number_lower(row_json)) AS lower_sum,
            bit_xor(md5_number_lower(row_json)) AS lower_xor,
            sum(md5_number_upper(row_json)) AS upper_sum,
            bit_xor(md5_number_upper(row_json)) AS upper_xor
        FROM hashed
        GROUP BY database_name, collection_name
        ORDER BY database_name, collection_name
    """).fetchall()

    for row in rows:
        database, collection, count, start, end, *hash_parts = row
        fingerprint = partition_fingerprint(
            kind, columns, (count, start, end, *hash_parts)
        )
        current = con.execute(
            """
            SELECT content_hash, exported_at, parquet_path, schema_version
            FROM measurement_partitions
            WHERE database_name = ?
              AND collection_name = ?
              AND measurement_type = ?
            """,
            [database, collection, kind],
        ).fetchone()

        if current and current[1] and exported_at < current[1]:
            print(
                f"SKIP older [{path.parent.name}]: "
                f"{database} / {collection} / {kind}"
            )
            continue

        target = (
            OUTPUT
            / kind
            / f"database={quote(database, safe='')}"
            / f"collection={quote(collection, safe='')}"
            / "data.parquet"
        )
        relative_target = target.relative_to(ROOT).as_posix()
        unchanged = (
            not force
            and current
            and current[0] == fingerprint
            and current[3] == SCHEMA_VERSION
        )

        if unchanged:
            print(
                f"SKIP partition unchanged [{path.parent.name}]: "
                f"{database} / {collection} / {kind}"
            )
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name("data.tmp.parquet")
            temporary.unlink(missing_ok=True)
            con.execute(f"""
                COPY (
                    SELECT * FROM staged
                    WHERE database_name = {sql_string(database)}
                      AND collection_name = {sql_string(collection)}
                    ORDER BY measured_at
                )
                TO {sql_string(temporary)}
                (FORMAT PARQUET, COMPRESSION ZSTD)
            """)
            os.replace(temporary, target)
            action = "ADD" if current is None else "REPLACE"
            print(f"{action}: {database} / {collection} / {kind} ({count:,} rows)")

        upsert_partition(
            con,
            (
                database,
                collection,
                kind,
                SCHEMA_VERSION,
                exported_at.date(),
                exported_at,
                count,
                start,
                end,
                fingerprint,
                raw_hash,
                relative_target if not unchanged else current[2],
            ),
        )

    con.execute(
        """
        INSERT OR REPLACE INTO processed_files (
            file_hash,
            measurement_type,
            schema_version,
            source_path,
            export_date,
            processed_at
        ) VALUES (
            ?, ?, ?, ?, ?, now()
        )
        """,
        [
            raw_hash,
            kind,
            SCHEMA_VERSION,
            path.relative_to(ROOT).as_posix(),
            exported_at.date(),
        ],
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "paths",
        nargs="*",
        type=Path,
        default=[DATA / "_csvs"],
        help="CSV file or export directory; defaults to data/_csvs",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="recheck files even when their raw SHA-256 hash is already cataloged",
    )
    args = parser.parse_args()

    paths = []
    for item in args.paths:
        if item.is_file():
            if is_temp_path(item.resolve()):
                print(f"SKIP temp staging file: {item.relative_to(ROOT)}")
            else:
                paths.append(item.resolve())
        elif item.exists():
            paths.extend(
                path.resolve()
                for path in item.rglob("*")
                if (
                    path.is_file()
                    and path.suffix.lower() == ".csv"
                    and not is_temp_path(path)
                )
            )
        else:
            raise FileNotFoundError(item)

    known = []
    for path in paths:
        kind = FILE_TYPES.get(path.stem.lower())
        if kind:
            known.append((export_time(path), path, kind))
        else:
            print(f"SKIP unknown filename: {path.relative_to(ROOT)}")

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    (DATA / "_processed/.tmp").mkdir(parents=True, exist_ok=True)
    with duckdb.connect(str(DB_PATH)) as con:
        initialize(con)
        con.execute(
            f"SET temp_directory = {sql_string(DATA / '_processed/.tmp')}"
        )
        for _, path, kind in sorted(known, reverse=True):
            import_file(con, path, kind, args.force)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
