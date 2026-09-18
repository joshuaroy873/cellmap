#!/usr/bin/env python3
"""Serve the cellular measurement API and static website."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import mimetypes
import os
import re
import secrets
import shlex
import sqlite3
import sys
from contextlib import closing
from datetime import date, datetime
from functools import lru_cache
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import duckdb


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from cellmap_schema import (  # noqa: E402
    CATEGORY_TYPES,
    DETAIL_FIELDS,
    METRICS,
    NULL_FILTER_VALUE,
)
from compare_api import compare_cdf_payload  # noqa: E402
STATIC = Path(__file__).resolve().parent / "static"
DB_PATH = ROOT / "data/_processed/cellular.duckdb"
SHARE_DB_PATH = ROOT / "data/shared_views.sqlite3"
MEASUREMENTS = ROOT / "data/_processed/measurements"
MAX_POINTS = 6_000
MAX_SERIES_POINTS = 500
MAX_CDF_POINTS = 400
SHARED_VIEW_ID = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
MAX_SHARED_VIEW_COLLECTIONS = 1_000
MAX_SHARED_VIEW_VALUE_LENGTH = 512


def carto_basemap_key() -> str:
    """Read only the browser basemap key; an environment variable takes priority."""
    name = "CARTO_BASEMAP_KEY"
    if name in os.environ:
        return os.environ[name].strip()

    try:
        lines = (ROOT / ".env").read_text(encoding="utf-8-sig").splitlines()
    except FileNotFoundError:
        return ""

    key = ""
    for line in lines:
        variable, separator, value = line.strip().removeprefix("export ").partition("=")
        if not separator or variable.strip() != name:
            continue
        try:
            parts = shlex.split(value, comments=True)
        except ValueError:
            raise ValueError("Invalid CARTO_BASEMAP_KEY quoting in .env") from None
        if len(parts) > 1:
            raise ValueError("CARTO_BASEMAP_KEY in .env must be a single value")
        key = parts[0].strip() if parts else ""
    return key


def shared_string(value: object, label: str, required: bool = False) -> str | None:
    if value is None:
        if required:
            raise ValueError(f"Shared view needs {label}")
        return None
    if not isinstance(value, str):
        raise ValueError(f"Shared view {label} must be text")
    normalized = value.strip()
    if not normalized:
        if required:
            raise ValueError(f"Shared view needs {label}")
        return None
    if len(normalized) > MAX_SHARED_VIEW_VALUE_LENGTH:
        raise ValueError(f"Shared view {label} is too long")
    return normalized


def shared_time(value: object, label: str) -> str | None:
    normalized = shared_string(value, label)
    if normalized is None:
        return None
    try:
        datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ValueError(f"Shared view {label} is not a valid date and time") from error
    return normalized


def shared_filter(
    state: dict[str, object], name: str, default: str = "all"
) -> str:
    return shared_string(state.get(name, default), name) or default


def normalize_shared_view_state(request: dict[str, object]) -> dict[str, object]:
    state = request.get("state")
    if not isinstance(state, dict):
        raise ValueError("Shared view state is required")

    database = shared_string(state.get("database"), "database", required=True)
    source_collections = state.get("collections")
    if not isinstance(source_collections, list) or not source_collections:
        raise ValueError("Shared view needs at least one collection")
    if len(source_collections) > MAX_SHARED_VIEW_COLLECTIONS:
        raise ValueError(
            f"Shared view supports up to {MAX_SHARED_VIEW_COLLECTIONS:,} collections"
        )
    collections = []
    for value in source_collections:
        collection = shared_string(value, "collection", required=True)
        if collection not in collections:
            collections.append(collection)

    measurement = shared_string(
        state.get("measurement"), "measurement", required=True
    )
    validate_choice(measurement, CATEGORY_TYPES, "measurement type")
    metric = shared_string(state.get("metric"), "metric", required=True)
    validate_choice(metric, METRICS[measurement], "metric")

    technology = shared_filter(state, "technology")
    if technology not in ("all", "LTE", "NR"):
        raise ValueError(f"Unknown technology: {technology}")

    start = shared_time(state.get("start"), "start time")
    end = shared_time(state.get("end"), "end time")
    if start and end and datetime.fromisoformat(start) > datetime.fromisoformat(end):
        raise ValueError("Shared view start time must be before end time")

    return {
        "version": 1,
        "database": database,
        "collections": collections,
        "start": start,
        "end": end,
        "measurement": measurement,
        "technology": technology,
        "operator": shared_filter(state, "operator"),
        "band": shared_filter(state, "band"),
        "pci": shared_filter(state, "pci"),
        "ssb": shared_filter(state, "ssb"),
        "metric": metric,
    }


def create_shared_view_payload(request: dict[str, object]) -> dict[str, object]:
    state = normalize_shared_view_state(request)
    if not DB_PATH.exists():
        raise FileNotFoundError("Run scripts/import_csvs.py before sharing a view")

    encoded_state = json.dumps(state, separators=(",", ":"))
    with closing(sqlite3.connect(SHARE_DB_PATH, timeout=10)) as con:
        for _ in range(5):
            identifier = secrets.token_urlsafe(16)
            try:
                con.execute(
                    "INSERT INTO shared_views (id, state_json) VALUES (?, ?)",
                    [identifier, encoded_state],
                )
            except sqlite3.IntegrityError:
                continue
            con.commit()
            return {"id": identifier, "state": state}
    raise RuntimeError("Could not create a unique shared-view link")


def initialize_share_store(
    store_path: Path | None = None, legacy_path: Path | None = None,
) -> None:
    store_path = SHARE_DB_PATH if store_path is None else store_path
    legacy_path = ROOT / "data/_processed/shared_views.sqlite3" if legacy_path is None else legacy_path
    store_path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(store_path, timeout=10)) as con:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("""
            CREATE TABLE IF NOT EXISTS shared_views (
                id TEXT PRIMARY KEY,
                state_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        # Copy, never delete, the previous store. The new location survives swaps.
        if legacy_path.exists() and legacy_path.resolve() != store_path.resolve():
            with closing(sqlite3.connect(legacy_path.resolve().as_uri() + "?mode=ro", uri=True)) as old:
                rows = old.execute("SELECT id, state_json, created_at FROM shared_views").fetchall()
            for identifier, state, created in rows:
                existing = con.execute("SELECT state_json FROM shared_views WHERE id = ?", [identifier]).fetchone()
                if existing and existing[0] != state:
                    raise ValueError("Conflicting shared-view IDs; original stores were preserved")
                con.execute(
                    "INSERT OR IGNORE INTO shared_views(id, state_json, created_at) VALUES (?, ?, ?)",
                    [identifier, state, created],
                )
        con.commit()


def shared_view_payload(identifier: str) -> dict[str, object]:
    if not SHARED_VIEW_ID.fullmatch(identifier):
        raise ValueError("Invalid shared-view link")
    row = None
    if SHARE_DB_PATH.exists():
        with closing(sqlite3.connect(SHARE_DB_PATH, timeout=10)) as con:
            row = con.execute(
                "SELECT state_json FROM shared_views WHERE id = ?", [identifier]
            ).fetchone()
    if row is None:
        row = legacy_shared_view(identifier)
    if row is None:
        raise LookupError("Shared view was not found")
    (state_json,) = row
    try:
        state = json.loads(state_json)
    except json.JSONDecodeError as error:
        raise ValueError("Shared view contains invalid saved state") from error
    if not isinstance(state, dict):
        raise ValueError("Shared view contains invalid saved state")
    return {"id": identifier, "state": state}


def legacy_shared_view(identifier: str) -> tuple | None:
    """Keep existing links readable without opening the measurement catalog for writes."""
    with open_catalog() as con:
        table = con.execute("""
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = 'main' AND table_name = 'shared_views'
        """).fetchone()
        if table is None:
            return None
        return con.execute(
            """
            SELECT state_json
            FROM shared_views
            WHERE id = ?
            """,
            [identifier],
        ).fetchone()


def json_default(value: object) -> object:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    raise TypeError(f"Cannot serialize {type(value).__name__}")


def sql_string(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def query_value(query: dict[str, list[str]], name: str) -> str | None:
    value = query.get(name, [None])[0]
    return value if value not in (None, "", "all") else None


def query_values(query: dict[str, list[str]], name: str) -> list[str]:
    values = []
    for value in query.get(name, []):
        if value not in (None, "", "all") and value not in values:
            values.append(value)
    return values


def validate_choice(value: str, choices: dict[str, object], label: str) -> str:
    if value not in choices:
        raise ValueError(f"Unknown {label}: {value}")
    return value


def open_catalog() -> duckdb.DuckDBPyConnection:
    if not DB_PATH.exists():
        raise FileNotFoundError("Run scripts/import_csvs.py before starting the website")
    return duckdb.connect(str(DB_PATH), read_only=True)


def catalog_payload() -> dict[str, object]:
    with open_catalog() as con:
        collections = con.execute("""
            SELECT database_name, collection_name, start_time, end_time
            FROM collections
            ORDER BY database_name, collection_name
        """).fetchall()
        partitions = con.execute("""
            SELECT database_name, collection_name, measurement_type
            FROM measurement_partitions
            ORDER BY database_name, collection_name, measurement_type
        """).fetchall()

    types_by_collection: dict[tuple[str, str], set[str]] = {}
    for database, collection, measurement_type in partitions:
        types_by_collection.setdefault((database, collection), set()).add(
            measurement_type
        )

    databases: dict[str, list[dict[str, object]]] = {}
    for database, collection, start, end in collections:
        available = types_by_collection.get((database, collection), set())
        categories = []
        technologies = set()
        for category, kinds in CATEGORY_TYPES.items():
            present = [technology for technology, kind in kinds.items() if kind in available]
            if present:
                categories.append(category)
                technologies.update(present)
        databases.setdefault(database, []).append(
            {
                "name": collection,
                "start": start,
                "end": end,
                "categories": categories,
                "technologies": sorted(technologies),
            }
        )

    return {
        "databases": [
            {"name": name, "collections": collections}
            for name, collections in databases.items()
        ],
        "measurements": [
            {
                "value": category,
                "metrics": [
                    {"value": name, "label": label, "unit": unit}
                    for name, (label, unit) in metrics.items()
                ],
            }
            for category, metrics in METRICS.items()
        ],
    }


def selected_kinds(category: str, technology: str | None) -> list[str]:
    validate_choice(category, CATEGORY_TYPES, "measurement type")
    if technology:
        normalized = technology.upper()
        if normalized not in ("LTE", "NR"):
            raise ValueError(f"Unknown technology: {technology}")
        return [CATEGORY_TYPES[category][normalized]]
    return list(CATEGORY_TYPES[category].values())


def parquet_paths(
    con: duckdb.DuckDBPyConnection,
    database: str,
    collections: list[str],
    kinds: list[str],
) -> list[Path]:
    collection_placeholders = ", ".join("?" for _ in collections)
    kind_placeholders = ", ".join("?" for _ in kinds)
    rows = con.execute(
        f"""
        SELECT parquet_path
        FROM measurement_partitions
        WHERE database_name = ?
          AND collection_name IN ({collection_placeholders})
          AND measurement_type IN ({kind_placeholders})
        ORDER BY collection_name, measurement_type
        """,
        [database, *collections, *kinds],
    ).fetchall()

    paths = []
    for (stored_path,) in rows:
        path = (ROOT / stored_path).resolve()
        if not path.is_relative_to(MEASUREMENTS.resolve()) or not path.exists():
            raise FileNotFoundError(f"Cataloged Parquet file is unavailable: {stored_path}")
        paths.append(path)
    return paths


def parquet_source(paths: list[Path]) -> str:
    if not paths:
        raise ValueError("No data is available for this selection")
    files = ", ".join(sql_string(path) for path in paths)
    return (
        f"read_parquet([{files}], "
        "union_by_name=true, hive_partitioning=false)"
    )


def collection_filter(database: str, collections: list[str]) -> tuple[str, list[object]]:
    placeholders = ", ".join("?" for _ in collections)
    return (
        f"database_name = ? AND collection_name IN ({placeholders})",
        [database, *collections],
    )


def distinct_values(
    con: duckdb.DuckDBPyConnection,
    source: str,
    column: str,
    where: str,
    params: list[object],
) -> list[object]:
    (values,) = con.execute(f"""
        SELECT list_sort(list_distinct(list({column})
            FILTER (WHERE {column} IS NOT NULL)))
        FROM {source}
        WHERE {where}
    """, params).fetchone()
    return values or []


def counted_values(
    con: duckdb.DuckDBPyConnection,
    source: str,
    column: str,
    where: str,
    params: list[object],
    include_null: bool = False,
) -> list[tuple[object, int]]:
    null_filter = "" if include_null else f"AND {column} IS NOT NULL"
    return con.execute(f"""
        SELECT {column}, count(*)
        FROM {source}
        WHERE {where}
          {null_filter}
        GROUP BY {column}
        ORDER BY {column} NULLS LAST
    """, params).fetchall()


def counted_bands(
    con: duckdb.DuckDBPyConnection,
    source: str,
    where: str,
    params: list[object],
) -> list[tuple[str, int, int]]:
    return con.execute(f"""
        SELECT technology, band_number, count(*)
        FROM {source}
        WHERE {where}
          AND band_number IS NOT NULL
        GROUP BY technology, band_number
        ORDER BY technology, band_number
    """, params).fetchall()


def metric_counts(
    con: duckdb.DuckDBPyConnection,
    source: str,
    metric_names: list[str],
    where: str,
    params: list[object],
) -> tuple[object, ...]:
    return con.execute(f"""
        SELECT {", ".join(f"count({name})" for name in metric_names)}
        FROM {source}
        WHERE {where}
    """, params).fetchone()


def options_payload(query: dict[str, list[str]]) -> dict[str, object]:
    database = query_value(query, "database")
    collections = query_values(query, "collection")
    category = query_value(query, "measurement") or "radio"
    if not database or not collections:
        raise ValueError("database and at least one collection are required")

    kinds = selected_kinds(category, None)
    metric_names = list(METRICS[category])

    with open_catalog() as con:
        source = parquet_source(parquet_paths(con, database, collections, kinds))
        base_where, base_params = collection_filter(database, collections)

        technologies = distinct_values(
            con, source, "technology", base_where, base_params
        )
        technology = valid_option(query_value(query, "technology"), technologies)

        operator_where, operator_params = option_filter(
            base_where, base_params, [("technology", technology)]
        )
        operators = distinct_values(
            con, source, "operator_name", operator_where, operator_params
        )
        operator = valid_option(query_value(query, "operator"), operators)

        band_where, band_params = option_filter(
            base_where,
            base_params,
            [("technology", technology), ("operator", operator)],
        )
        bands = counted_bands(con, source, band_where, band_params)
        band = valid_option(
            query_value(query, "band"),
            [f"{band_technology}:{band}" for band_technology, band, _ in bands],
        )

        pci_where, pci_params = option_filter(
            base_where,
            base_params,
            [("technology", technology), ("operator", operator), ("band", band)],
        )
        pcis = counted_values(con, source, "pci", pci_where, pci_params)
        pci = valid_option(query_value(query, "pci"), [pci for pci, _ in pcis])

        ssb_where, ssb_params = option_filter(
            base_where,
            base_params,
            [
                ("technology", technology),
                ("operator", operator),
                ("band", band),
                ("pci", pci),
            ],
        )
        ssb_indexes = counted_values(
            con, source, "ssb_index", ssb_where, ssb_params, include_null=True
        )
        ssb = valid_option(query_value(query, "ssb"), [ssb for ssb, _ in ssb_indexes])

        metric_where, metric_params = option_filter(
            base_where,
            base_params,
            [
                ("technology", technology),
                ("operator", operator),
                ("band", band),
                ("pci", pci),
                ("ssb", ssb),
            ],
        )
        counts = metric_counts(con, source, metric_names, metric_where, metric_params)

    metrics = [
        {"value": name, "label": METRICS[category][name][0], "unit": METRICS[category][name][1]}
        for name, count in zip(metric_names, counts)
        if count
    ]
    return {
        "technologies": technologies or [],
        "operators": operators or [],
        "bands": [
            {
                "value": f"{band_technology}:{band}",
                "label": f"{'b' if band_technology == 'LTE' else 'n'}{band} (#{count:,})",
            }
            for band_technology, band, count in bands
        ],
        "pcis": [
            {"value": pci, "label": f"{pci} (#{count:,})"}
            for pci, count in pcis
        ],
        "ssb_indexes": [
            {
                "value": NULL_FILTER_VALUE if ssb is None else ssb,
                "label": f"{'NaN' if ssb is None else ssb} (#{count:,})",
            }
            for ssb, count in ssb_indexes
        ],
        "metrics": metrics,
    }


def valid_option(value: str | None, options: list[object]) -> str | None:
    if value is None:
        return None
    normalized = {
        NULL_FILTER_VALUE if option is None else str(option)
        for option in options
    }
    return value if value in normalized else None


def option_filter(
    base_where: str,
    base_params: list[object],
    filters: list[tuple[str, str | None]],
) -> tuple[str, list[object]]:
    clauses = [base_where]
    params = list(base_params)
    columns = {
        "technology": "technology",
        "operator": "operator_name",
        "pci": "pci",
        "ssb": "ssb_index",
    }
    for name, value in filters:
        if value is None:
            continue
        if name == "band":
            append_band_filter(clauses, params, value)
        elif name == "ssb" and value == NULL_FILTER_VALUE:
            clauses.append(f"{columns[name]} IS NULL")
        else:
            clauses.append(f"{columns[name]} = ?")
            params.append(value)
    return " AND ".join(clauses), params


def append_band_filter(
    clauses: list[str], params: list[object], band: str
) -> None:
    if ":" in band:
        band_technology, band_number = band.split(":", 1)
        if band_technology not in ("LTE", "NR") or not band_number.isdigit():
            raise ValueError(f"Unknown band: {band}")
        clauses.extend(["technology = ?", "band_number = ?"])
        params.extend([band_technology, band_number])
    else:
        clauses.append("band_number = ?")
        params.append(band)


def filtered_query(
    source: str,
    query: dict[str, list[str]],
    metric: str,
) -> tuple[str, list[object]]:
    collections = query_values(query, "collection")
    placeholders = ", ".join("?" for _ in collections)
    clauses = [
        "database_name = ?",
        f"collection_name IN ({placeholders})",
    ]
    params: list[object] = [
        query_value(query, "database"),
        *collections,
    ]
    filters = [
        ("technology", query_value(query, "technology")),
        ("operator_name", query_value(query, "operator")),
        ("pci", query_value(query, "pci")),
        ("ssb_index", query_value(query, "ssb")),
    ]
    for column, value in filters:
        if value is not None:
            if column == "ssb_index" and value == NULL_FILTER_VALUE:
                clauses.append(f"{column} IS NULL")
            else:
                clauses.append(f"{column} = ?")
                params.append(value)

    band = query_value(query, "band")
    if band is not None:
        append_band_filter(clauses, params, band)

    start = query_value(query, "start")
    end = query_value(query, "end")
    if start:
        clauses.append("measured_at >= try_cast(? AS TIMESTAMP)")
        params.append(start)
    if end:
        clauses.append("measured_at <= try_cast(? AS TIMESTAMP)")
        params.append(end)

    sql = f"""
        SELECT *, {metric} AS metric_value
        FROM {source}
        WHERE {" AND ".join(clauses)}
    """
    return sql, params


def nice_bucket_seconds(duration_seconds: float) -> int:
    target = max(1, duration_seconds / MAX_SERIES_POINTS)
    choices = [
        1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800,
        3600, 7200, 14400, 21600, 43200, 86400,
    ]
    return next((value for value in choices if value >= target), choices[-1])


def measurement_payload(query: dict[str, list[str]]) -> dict[str, object]:
    database = query_value(query, "database")
    collections = query_values(query, "collection")
    category = query_value(query, "measurement") or "radio"
    technology = query_value(query, "technology")
    metric = query_value(query, "metric")
    if not database or not collections or not metric:
        raise ValueError(
            "database, at least one collection, and metric are required"
        )

    validate_choice(category, CATEGORY_TYPES, "measurement type")
    validate_choice(metric, METRICS[category], "metric")
    kinds = selected_kinds(category, technology)

    with open_catalog() as con:
        source = parquet_source(parquet_paths(con, database, collections, kinds))
        filtered, params = filtered_query(source, query, metric)
        summary = con.execute(f"""
            WITH filtered AS ({filtered})
            SELECT
                count(metric_value),
                min(metric_value),
                max(metric_value),
                median(metric_value),
                quantile_cont(metric_value, 0.05),
                quantile_cont(metric_value, 0.95),
                min(measured_at),
                max(measured_at)
            FROM filtered
            WHERE metric_value IS NOT NULL
        """, params).fetchone()

        count, minimum, maximum, median, p5, p95, start, end = summary
        if not count:
            return {
                "metric": metric,
                "label": METRICS[category][metric][0],
                "unit": METRICS[category][metric][1],
                "summary": {"count": 0},
                "points": [],
                "series": [],
            }

        details = DETAIL_FIELDS[category]
        points = con.execute(f"""
            WITH filtered AS (
                SELECT
                    collection_name, measured_at, latitude, longitude,
                    technology, rat,
                    operator_name, model, band_number, pci, ssb_index,
                    metric_value,
                    {", ".join(details)}
                FROM ({filtered})
                WHERE metric_value IS NOT NULL
                  AND latitude IS NOT NULL
                  AND longitude IS NOT NULL
            ),
            ranked AS (
                SELECT
                    *,
                    row_number() OVER (ORDER BY measured_at) AS row_number,
                    count(*) OVER () AS total_rows
                FROM filtered
            )
            SELECT * EXCLUDE (row_number, total_rows)
            FROM ranked
            WHERE (row_number - 1) %
                greatest(1, ceil(total_rows / {MAX_POINTS}.0)::BIGINT) = 0
            ORDER BY measured_at
            LIMIT {MAX_POINTS}
        """, params).fetchall()
        point_columns = [
            "collection_name",
            "measured_at",
            "latitude",
            "longitude",
            "technology",
            "rat",
            "operator_name",
            "model",
            "band_number",
            "pci",
            "ssb_index",
            "metric_value",
            *details,
        ]

        series = []
        if query_value(query, "operator"):
            duration = max(0.0, (end - start).total_seconds())
            bucket = nice_bucket_seconds(duration)
            series = con.execute(f"""
                WITH filtered AS ({filtered})
                SELECT
                    cast(to_timestamp(
                        floor(epoch(measured_at) / ?) * ?
                    ) AS TIMESTAMP) AS bucket,
                    avg(metric_value) AS average,
                    min(metric_value) AS minimum,
                    max(metric_value) AS maximum,
                    count(metric_value) AS samples
                FROM filtered
                WHERE metric_value IS NOT NULL
                GROUP BY bucket
                ORDER BY bucket
            """, [*params, bucket, bucket]).fetchall()

    return {
        "metric": metric,
        "label": METRICS[category][metric][0],
        "unit": METRICS[category][metric][1],
        "summary": {
            "count": count,
            "minimum": minimum,
            "maximum": maximum,
            "median": median,
            "p5": p5,
            "p95": p95,
            "start": start,
            "end": end,
        },
        "points": [dict(zip(point_columns, row)) for row in points],
        "series": [
            {
                "time": bucket_time,
                "average": avg,
                "minimum": low,
                "maximum": high,
                "samples": samples,
            }
            for bucket_time, avg, low, high, samples in series
        ],
    }


def cdf_payload(query: dict[str, list[str]]) -> dict[str, object]:
    database = query_value(query, "database")
    collections = query_values(query, "collection")
    category = query_value(query, "measurement") or "radio"
    technology = query_value(query, "technology")
    metric = query_value(query, "metric")
    if not database or not collections or not metric:
        raise ValueError(
            "database, at least one collection, and metric are required"
        )

    validate_choice(category, CATEGORY_TYPES, "measurement type")
    validate_choice(metric, METRICS[category], "metric")
    kinds = selected_kinds(category, technology)
    probabilities = [index / MAX_CDF_POINTS for index in range(MAX_CDF_POINTS + 1)]
    probability_sql = ", ".join(f"{value:.6f}" for value in probabilities)

    with open_catalog() as con:
        source = parquet_source(parquet_paths(con, database, collections, kinds))
        filtered, params = filtered_query(source, query, metric)
        count, values = con.execute(f"""
            WITH filtered AS ({filtered})
            SELECT
                count(metric_value),
                quantile_cont(metric_value, [{probability_sql}])
            FROM filtered
            WHERE metric_value IS NOT NULL
        """, params).fetchone()

    return {
        "metric": metric,
        "label": METRICS[category][metric][0],
        "unit": METRICS[category][metric][1],
        "count": count,
        "points": [
            {"value": value, "probability": probability}
            for value, probability in zip(values or [], probabilities)
        ],
    }


@lru_cache(maxsize=64)
def cached_asset(path: str, modified: int, size: int) -> tuple[bytes, bytes, str]:
    body = Path(path).read_bytes()
    return body, gzip.compress(body, compresslevel=5), hashlib.sha256(body).hexdigest()[:16]


def asset_content(path: Path) -> tuple[bytes, bytes, str]:
    stat = path.stat()
    return cached_asset(str(path), stat.st_mtime_ns, stat.st_size)


def versioned_html() -> bytes:
    html = asset_content(STATIC / "index.html")[0].decode("utf-8")

    def version(match: re.Match) -> str:
        url = match.group(2)
        digest = asset_content(STATIC / url.lstrip("/"))[2]
        return f'{match.group(1)}{url}?v={digest}"'

    return re.sub(r'((?:src|href)=")(/[^"?]+\.(?:js|css))(?:\?[^"\s]*)?"', version, html).encode()


def accepts_gzip(value: str) -> bool:
    for item in value.split(","):
        encoding, *parameters = item.strip().lower().split(";")
        if encoding != "gzip":
            continue
        try:
            return all(float(p.strip()[2:]) > 0 for p in parameters if p.strip().startswith("q="))
        except ValueError:
            return False
    return False


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            return super().do_GET()

        try:
            query = parse_qs(parsed.query)
            if parsed.path == "/api/health":
                payload = {"status": "ok"}
            elif parsed.path == "/api/config":
                payload = {"cartoBasemapKey": carto_basemap_key()}
            elif parsed.path == "/api/catalog":
                payload = catalog_payload()
            elif parsed.path == "/api/options":
                payload = options_payload(query)
            elif parsed.path == "/api/measurements":
                payload = measurement_payload(query)
            elif parsed.path == "/api/cdf":
                payload = cdf_payload(query)
            elif parsed.path.startswith("/api/shared-views/"):
                identifier = parsed.path.removeprefix("/api/shared-views/")
                if not identifier or "/" in identifier:
                    self.send_json({"error": "Unknown API endpoint"}, status=404)
                    return
                payload = shared_view_payload(identifier)
            else:
                self.send_json({"error": "Unknown API endpoint"}, status=404)
                return
            self.send_json(payload)
        except ValueError as error:
            self.send_json({"error": str(error)}, status=400)
        except FileNotFoundError as error:
            self.send_json({"error": str(error)}, status=503)
        except LookupError as error:
            self.send_json({"error": str(error)}, status=404)
        except Exception as error:
            self.log_error("%s", error)
            self.send_json({"error": "The measurement query failed"}, status=500)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/compare/cdf":
                payload = compare_cdf_payload(
                    self.read_json_body(), ROOT, DB_PATH, MEASUREMENTS
                )
            elif parsed.path == "/api/shared-views":
                payload = create_shared_view_payload(self.read_json_body())
            else:
                self.send_json({"error": "Unknown API endpoint"}, status=404)
                return
            self.send_json(payload)
        except ValueError as error:
            self.send_json({"error": str(error)}, status=400)
        except FileNotFoundError as error:
            self.send_json({"error": str(error)}, status=503)
        except Exception as error:
            self.log_error("%s", error)
            self.send_json({"error": "The request failed"}, status=500)

    def read_json_body(self) -> dict[str, object]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            raise ValueError("JSON request body is required")
        if length > 1_000_000:
            raise ValueError("JSON request body is too large")
        body = self.rfile.read(length)
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as error:
            raise ValueError("Invalid JSON request body") from error
        if not isinstance(payload, dict):
            raise ValueError("JSON request body must be an object")
        return payload

    def send_json(self, payload: object, status: int = 200) -> None:
        body = json.dumps(
            payload, default=json_default, separators=(",", ":")
        ).encode()
        use_gzip = accepts_gzip(self.headers.get("Accept-Encoding", "")) and len(body) > 1024
        if use_gzip:
            body = gzip.compress(body, compresslevel=5)

        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Vary", "Accept-Encoding")
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        self.wfile.write(body)

    def send_head(self):
        parsed = urlparse(self.path)
        path = Path(self.translate_path(parsed.path))
        is_index = parsed.path in ("/", "/index.html")
        if not is_index and (path.suffix not in (".js", ".css") or not path.is_file()):
            return super().send_head()
        if is_index:
            body = versioned_html()
            compressed = gzip.compress(body, compresslevel=5)
            digest = hashlib.sha256(body).hexdigest()[:16]
            cache_control = "no-cache"
            content_type = "text/html; charset=utf-8"
        else:
            body, compressed, digest = asset_content(path)
            version = parse_qs(parsed.query).get("v", [None])[0]
            cache_control = "public, max-age=31536000, immutable" if version == digest else "no-cache"
            content_type = self.guess_type(str(path))
        use_gzip = accepts_gzip(self.headers.get("Accept-Encoding", ""))
        etag = f'"{digest}-{"gzip" if use_gzip else "identity"}"'
        not_modified = etag in [value.strip() for value in self.headers.get("If-None-Match", "").split(",")]
        self.send_response(304 if not_modified else 200)
        self.send_header("Cache-Control", cache_control)
        self.send_header("ETag", etag)
        self.send_header("Vary", "Accept-Encoding")
        if not_modified:
            self.end_headers()
            return None
        body = compressed if use_gzip else body
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()
        return io.BytesIO(body)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()

    def guess_type(self, path: str) -> str:
        return mimetypes.guess_type(path)[0] or "application/octet-stream"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    initialize_share_store()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Cellular map: http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
