#!/usr/bin/env python3
"""Print a compact summary of the processed DuckDB catalog."""

from __future__ import annotations

import argparse
from datetime import date, datetime
from pathlib import Path

import duckdb

from init_database import DB_PATH, ROOT


def fmt_date(value: object) -> str:
    if value is None:
        return "-"
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def technology_label(lte_partitions: object, nr_partitions: object) -> str:
    parts = []
    lte = int(lte_partitions or 0)
    nr = int(nr_partitions or 0)
    if lte:
        parts.append(f"LTE(#{lte})")
    if nr:
        parts.append(f"NR(#{nr})")
    return "+".join(parts) if parts else "-"


def catalog_rows(
    con: duckdb.DuckDBPyConnection, database: str | None
) -> tuple[list[tuple[object, ...]], list[tuple[object, ...]]]:
    where = "WHERE database_name = ?" if database else ""
    params = [database] if database else []

    databases = con.execute(
        f"""
        SELECT
            database_name,
            count(DISTINCT collection_name) AS collections,
            max(export_date) AS latest_export_date
        FROM measurement_partitions
        {where}
        GROUP BY database_name
        ORDER BY database_name
        """,
        params,
    ).fetchall()

    collections = con.execute(
        f"""
        SELECT
            database_name,
            collection_name,
            count(*) FILTER (WHERE measurement_type LIKE 'lte_%') AS lte_partitions,
            count(*) FILTER (WHERE measurement_type LIKE 'nr_%') AS nr_partitions,
            list_sort(list(measurement_type)) AS measurement_types
        FROM measurement_partitions
        {where}
        GROUP BY database_name, collection_name
        ORDER BY database_name, collection_name
        """,
        params,
    ).fetchall()

    return databases, collections


def print_summary(
    databases: list[tuple[object, ...]],
    collections: list[tuple[object, ...]],
    show_collections: bool,
    show_types: bool,
) -> None:
    if not databases:
        print("No processed database catalog found.")
        return

    collections_by_database: dict[str, list[tuple[object, ...]]] = {}
    for row in collections:
        collections_by_database.setdefault(str(row[0]), []).append(row)

    for database, collection_count, export_date in databases:
        name = str(database)
        print(name)
        print(
            "  "
            f"{int(collection_count):,} collections | "
            f"latest export {fmt_date(export_date)}"
        )

        if not show_collections:
            continue

        for row in collections_by_database.get(name, []):
            (
                _database,
                collection,
                lte_partitions,
                nr_partitions,
                measurement_types,
            ) = row
            print(
                f"  - {collection}: "
                f"{technology_label(lte_partitions, nr_partitions)}"
            )
            if show_types:
                print(f"    measurement types: {', '.join(measurement_types)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "path",
        nargs="?",
        type=Path,
        default=DB_PATH,
        help="DuckDB catalog path; default: data/_processed/cellular.duckdb",
    )
    parser.add_argument(
        "--database",
        help="show only one database",
    )
    parser.add_argument(
        "--no-collections",
        action="store_true",
        help="show only database-level summaries",
    )
    parser.add_argument(
        "--show-types",
        action="store_true",
        help="include measurement type names for each collection",
    )
    args = parser.parse_args()

    db_path = args.path.resolve()
    if not db_path.exists():
        raise FileNotFoundError(db_path.relative_to(ROOT))

    with duckdb.connect(str(db_path), read_only=True) as con:
        databases, collections = catalog_rows(con, args.database)
    print_summary(
        databases,
        collections,
        show_collections=not args.no_collections,
        show_types=args.show_types,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
