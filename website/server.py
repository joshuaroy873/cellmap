#!/usr/bin/env python3
"""Serve the cellular measurement API and static website."""

from __future__ import annotations

import argparse
import gzip
import json
import mimetypes
from datetime import date, datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import duckdb


ROOT = Path(__file__).resolve().parents[1]
STATIC = Path(__file__).resolve().parent / "static"
DB_PATH = ROOT / "data/_processed/cellular.duckdb"
MEASUREMENTS = ROOT / "data/_processed/measurements"
MAX_POINTS = 6_000
MAX_SERIES_POINTS = 500
MAX_CDF_POINTS = 400
NULL_FILTER_VALUE = "__null__"

CATEGORY_TYPES = {
    "radio": {"LTE": "lte_radio", "NR": "nr_radio"},
    "neighbor": {"LTE": "lte_radio_neighbor", "NR": "nr_radio_neighbor"},
    "pdsch": {"LTE": "lte_pdsch", "NR": "nr_pdsch"},
    "pusch": {"LTE": "lte_pusch", "NR": "nr_pusch"},
}

METRICS = {
    "radio": {
        "rsrp_dbm": ("RSRP / SS-RSRP", "dBm"),
        "rsrq_db": ("RSRQ / SS-RSRQ", "dB"),
        "rssi_dbm": ("RSSI", "dBm"),
        "sinr_db": ("SINR / SS-SINR", "dB"),
    },
    "neighbor": {
        "rsrp_dbm": ("RSRP / SS-RSRP", "dBm"),
        "rsrq_db": ("RSRQ / SS-RSRQ", "dB"),
        "rssi_dbm": ("RSSI", "dBm"),
        "sinr_db": ("SS-SINR", "dB"),
    },
    "pdsch": {
        "throughput_mbps": ("Net PDSCH throughput", "Mbps"),
        "mcs": ("MCS", ""),
        "avg_pdsch_layers": ("Average PDSCH layers", ""),
        "pdsch_rbs": ("PDSCH RBs", ""),
        "bler": ("PDSCH BLER", ""),
    },
    "pusch": {
        "throughput_mbps": ("Net PUSCH throughput", "Mbps"),
        "mcs": ("MCS", ""),
        "avg_pusch_layers": ("Average PUSCH layers", ""),
        "pusch_rbs": ("PUSCH RBs", ""),
    },
}

DETAIL_FIELDS = {
    "radio": [
        "dl_channel_number",
        "ul_channel_number",
        "dl_bandwidth_mhz",
        "ul_bandwidth_mhz",
        "dl_scs_khz",
        "cell_type",
    ],
    "neighbor": [
        "dl_channel_number",
        "ul_channel_number",
        "dl_scs_khz",
        "is_serving_beam",
    ],
    "pdsch": [
        "dl_channel_number",
        "dl_bandwidth_mhz",
        "dl_bandwidth_aggregated_mhz",
        "dl_scs_khz",
        "cell_type",
        "modulation",
    ],
    "pusch": [
        "ul_channel_number",
        "ul_bandwidth_mhz",
        "ul_bandwidth_aggregated_mhz",
        "ul_scs_khz",
        "cell_type",
        "modulation",
    ],
}


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
        ]
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
        placeholders = ", ".join("?" for _ in collections)
        base_where = (
            f"database_name = ? AND collection_name IN ({placeholders})"
        )
        base_params = [database, *collections]

        (technologies,) = con.execute(f"""
            SELECT list_sort(list_distinct(list(technology)
                FILTER (WHERE technology IS NOT NULL)))
            FROM {source}
            WHERE {base_where}
        """, base_params).fetchone()
        technologies = technologies or []
        technology = valid_option(query_value(query, "technology"), technologies)

        operator_where, operator_params = option_filter(
            base_where, base_params, [("technology", technology)]
        )
        (operators,) = con.execute(f"""
            SELECT list_sort(list_distinct(list(operator_name)
                FILTER (WHERE operator_name IS NOT NULL)))
            FROM {source}
            WHERE {operator_where}
        """, operator_params).fetchone()
        operators = operators or []
        operator = valid_option(query_value(query, "operator"), operators)

        band_where, band_params = option_filter(
            base_where,
            base_params,
            [("technology", technology), ("operator", operator)],
        )
        bands = con.execute(f"""
            SELECT technology, band_number, count(*)
            FROM {source}
            WHERE {band_where}
              AND band_number IS NOT NULL
            GROUP BY technology, band_number
            ORDER BY technology, band_number
        """, band_params).fetchall()
        band = valid_option(
            query_value(query, "band"),
            [f"{band_technology}:{band}" for band_technology, band, _ in bands],
        )

        pci_where, pci_params = option_filter(
            base_where,
            base_params,
            [("technology", technology), ("operator", operator), ("band", band)],
        )
        pcis = con.execute(f"""
            SELECT pci, count(*)
            FROM {source}
            WHERE {pci_where}
              AND pci IS NOT NULL
            GROUP BY pci
            ORDER BY pci
        """, pci_params).fetchall()
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
        ssb_indexes = con.execute(f"""
            SELECT ssb_index, count(*)
            FROM {source}
            WHERE {ssb_where}
            GROUP BY ssb_index
            ORDER BY ssb_index NULLS LAST
        """, ssb_params).fetchall()
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
        metric_counts = con.execute(f"""
            SELECT {", ".join(f"count({name})" for name in metric_names)}
            FROM {source}
            WHERE {metric_where}
        """, metric_params).fetchone()

    metrics = [
        {"value": name, "label": METRICS[category][name][0], "unit": METRICS[category][name][1]}
        for name, count in zip(metric_names, metric_counts)
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


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self.path = parsed.path
            return super().do_GET()

        try:
            query = parse_qs(parsed.query)
            if parsed.path == "/api/health":
                payload = {"status": "ok"}
            elif parsed.path == "/api/catalog":
                payload = catalog_payload()
            elif parsed.path == "/api/options":
                payload = options_payload(query)
            elif parsed.path == "/api/measurements":
                payload = measurement_payload(query)
            elif parsed.path == "/api/cdf":
                payload = cdf_payload(query)
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
            self.send_json({"error": "The measurement query failed"}, status=500)

    def send_json(self, payload: object, status: int = 200) -> None:
        body = json.dumps(
            payload, default=json_default, separators=(",", ":")
        ).encode()
        use_gzip = "gzip" in self.headers.get("Accept-Encoding", "") and len(body) > 1024
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

    def end_headers(self) -> None:
        if (
            not self.path.startswith("/api/")
            and self.path.endswith(("/", ".html", ".css", ".js"))
        ):
            self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        super().end_headers()

    def guess_type(self, path: str) -> str:
        return mimetypes.guess_type(path)[0] or "application/octet-stream"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

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
