#!/usr/bin/env python3
"""Create the DuckDB catalog used by the processing pipeline."""

from pathlib import Path

import duckdb


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data/_processed/cellular.duckdb"


def initialize(con: duckdb.DuckDBPyConnection) -> None:
    con.execute("""
        CREATE TABLE IF NOT EXISTS measurement_partitions (
            database_name VARCHAR NOT NULL,
            collection_name VARCHAR NOT NULL,
            measurement_type VARCHAR NOT NULL,
            schema_version INTEGER NOT NULL,
            export_date DATE NOT NULL,
            exported_at TIMESTAMP NOT NULL,
            row_count BIGINT NOT NULL,
            start_time TIMESTAMP,
            end_time TIMESTAMP,
            content_hash VARCHAR NOT NULL,
            source_file_hash VARCHAR NOT NULL,
            parquet_path VARCHAR NOT NULL,
            processed_at TIMESTAMPTZ DEFAULT current_timestamp,
            PRIMARY KEY (database_name, collection_name, measurement_type)
        );

        CREATE TABLE IF NOT EXISTS processed_files (
            file_hash VARCHAR NOT NULL,
            measurement_type VARCHAR NOT NULL,
            schema_version INTEGER NOT NULL,
            source_path VARCHAR NOT NULL,
            export_date DATE NOT NULL,
            processed_at TIMESTAMPTZ DEFAULT current_timestamp,
            PRIMARY KEY (file_hash, measurement_type, schema_version)
        );

        ALTER TABLE measurement_partitions
            ADD COLUMN IF NOT EXISTS schema_version INTEGER DEFAULT 1;
        ALTER TABLE measurement_partitions
            ADD COLUMN IF NOT EXISTS exported_at TIMESTAMP;
        ALTER TABLE measurement_partitions
            ADD COLUMN IF NOT EXISTS source_file_hash VARCHAR DEFAULT '';

        UPDATE measurement_partitions
        SET exported_at = cast(export_date AS TIMESTAMP)
        WHERE exported_at IS NULL;

        CREATE OR REPLACE VIEW collections AS
        SELECT
            database_name,
            collection_name,
            min(start_time) AS start_time,
            max(end_time) AS end_time,
            max(export_date) AS latest_export_date,
            bool_or(measurement_type LIKE 'lte_%') AS has_lte,
            bool_or(measurement_type LIKE 'nr_%') AS has_nr
        FROM measurement_partitions
        GROUP BY database_name, collection_name;
    """)


def main() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with duckdb.connect(str(DB_PATH)) as con:
        initialize(con)
    print(f"Initialized {DB_PATH}")


if __name__ == "__main__":
    main()
