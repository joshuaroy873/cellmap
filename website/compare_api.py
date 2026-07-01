"""Compare-tab API helpers.

The compare view sends many curve definitions in one request. This module keeps
that batch-CDF logic out of the main static-file server.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import duckdb

from cellmap_schema import CATEGORY_TYPES, METRICS, NULL_FILTER_VALUE


MAX_COMPARE_CURVES = 20
MAX_COMPARE_CDF_POINTS = 400

MEASUREMENT_LABELS = {
    "radio": "Radio",
    "neighbor": "Neighbour",
    "pdsch": "PDSCH",
    "pusch": "PUSCH",
}


def json_string(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def clean_string(value: object) -> str | None:
    if value in (None, "", "all"):
        return None
    return str(value)


def validate_choice(value: str, choices: dict[str, object], label: str) -> str:
    if value not in choices:
        raise ValueError(f"Unknown {label}: {value}")
    return value


def selected_kinds(category: str, technology: str | None) -> list[str]:
    validate_choice(category, CATEGORY_TYPES, "measurement type")
    if technology:
        technology = technology.upper()
        if technology not in ("LTE", "NR"):
            raise ValueError(f"Unknown technology: {technology}")
        return [CATEGORY_TYPES[category][technology]]
    return list(CATEGORY_TYPES[category].values())


def parquet_paths(
    con: duckdb.DuckDBPyConnection,
    root: Path,
    measurements_dir: Path,
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

    measurement_root = measurements_dir.resolve()
    paths = []
    for (stored_path,) in rows:
        path = (root / stored_path).resolve()
        if not path.is_relative_to(measurement_root) or not path.exists():
            raise FileNotFoundError(f"Cataloged Parquet file is unavailable: {stored_path}")
        paths.append(path)
    return paths


def parquet_source(paths: list[Path]) -> str:
    files = ", ".join(json_string(path) for path in paths)
    return (
        f"read_parquet([{files}], "
        "union_by_name=true, hive_partitioning=false)"
    )


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


def curve_collections(curve: dict[str, Any]) -> list[str]:
    if isinstance(curve.get("collections"), list):
        values = [clean_string(item) for item in curve["collections"]]
    else:
        values = [clean_string(curve.get("collection"))]
    collections = []
    for value in values:
        if value and value not in collections:
            collections.append(value)
    return collections


def curve_where(
    database: str,
    collections: list[str],
    curve: dict[str, Any],
    start: str | None,
    end: str | None,
) -> tuple[str, list[object]]:
    placeholders = ", ".join("?" for _ in collections)
    clauses = [
        "database_name = ?",
        f"collection_name IN ({placeholders})",
    ]
    params: list[object] = [database, *collections]

    filters = [
        ("technology", clean_string(curve.get("technology"))),
        ("operator_name", clean_string(curve.get("operator"))),
        ("pci", clean_string(curve.get("pci"))),
        ("ssb_index", clean_string(curve.get("ssb"))),
    ]
    for column, value in filters:
        if value is None:
            continue
        if column == "ssb_index" and value == NULL_FILTER_VALUE:
            clauses.append("ssb_index IS NULL")
        else:
            clauses.append(f"{column} = ?")
            params.append(value)

    band = clean_string(curve.get("band"))
    if band:
        append_band_filter(clauses, params, band)
    if start:
        clauses.append("measured_at >= try_cast(? AS TIMESTAMP)")
        params.append(start)
    if end:
        clauses.append("measured_at <= try_cast(? AS TIMESTAMP)")
        params.append(end)

    return " AND ".join(clauses), params


def empty_curve(
    curve: dict[str, Any],
    category: str,
    metric: str,
    collections: list[str],
    reason: str | None = None,
) -> dict[str, object]:
    label, unit = METRICS[category][metric]
    return {
        "id": clean_string(curve.get("id")) or "curve",
        "label": curve_label(curve, collections),
        "color": clean_string(curve.get("color")) or "#0072b2",
        "style": clean_string(curve.get("style")) or "solid",
        "measurement": category,
        "measurement_label": MEASUREMENT_LABELS[category],
        "metric": metric,
        "metric_label": label,
        "unit": unit,
        "collections": collections,
        "count": 0,
        "minimum": None,
        "maximum": None,
        "p5": None,
        "median": None,
        "p95": None,
        "points": [],
        "note": reason,
    }


def band_label(value: str | None) -> str | None:
    if not value:
        return None
    if ":" not in value:
        return value
    technology, band = value.split(":", 1)
    prefix = "b" if technology == "LTE" else "n"
    return f"{prefix}{band}"


def curve_label(curve: dict[str, Any], collections: list[str]) -> str:
    custom = clean_string(curve.get("label"))
    if custom:
        return custom

    parts = [
        ", ".join(collections),
        clean_string(curve.get("technology")),
        clean_string(curve.get("operator")),
        band_label(clean_string(curve.get("band"))),
    ]
    pci = clean_string(curve.get("pci"))
    ssb = clean_string(curve.get("ssb"))
    if pci:
        parts.append(f"PCI {pci}")
    if ssb:
        parts.append("SSB NaN" if ssb == NULL_FILTER_VALUE else f"SSB {ssb}")
    return " | ".join(part for part in parts if part) or "Curve"


def quantile_value(values: list[float | None], probability: float) -> float | None:
    if not values:
        return None
    index = round(probability * MAX_COMPARE_CDF_POINTS)
    if index >= len(values):
        index = len(values) - 1
    return values[index]


def query_curve(
    con: duckdb.DuckDBPyConnection,
    root: Path,
    measurements_dir: Path,
    database: str,
    start: str | None,
    end: str | None,
    curve: dict[str, Any],
) -> dict[str, object]:
    category = clean_string(curve.get("measurement")) or "radio"
    metric = clean_string(curve.get("metric"))
    validate_choice(category, CATEGORY_TYPES, "measurement type")
    if not metric:
        raise ValueError("Each compare curve needs a metric")
    validate_choice(metric, METRICS[category], "metric")

    collections = curve_collections(curve)
    if not collections:
        raise ValueError("Each compare curve needs a collection")

    technology = clean_string(curve.get("technology"))
    kinds = selected_kinds(category, technology)
    paths = parquet_paths(
        con, root, measurements_dir, database, collections, kinds
    )
    if not paths:
        return empty_curve(curve, category, metric, collections, "No matching partition")

    source = parquet_source(paths)
    where, params = curve_where(database, collections, curve, start, end)
    probabilities = [
        index / MAX_COMPARE_CDF_POINTS
        for index in range(MAX_COMPARE_CDF_POINTS + 1)
    ]
    probability_sql = ", ".join(f"{value:.6f}" for value in probabilities)

    count, minimum, maximum, values = con.execute(f"""
        WITH filtered AS (
            SELECT {metric} AS metric_value
            FROM {source}
            WHERE {where}
        )
        SELECT
            count(metric_value),
            min(metric_value),
            max(metric_value),
            quantile_cont(metric_value, [{probability_sql}])
        FROM filtered
        WHERE metric_value IS NOT NULL
    """, params).fetchone()

    if not count:
        return empty_curve(curve, category, metric, collections, "No matching rows")

    label, unit = METRICS[category][metric]
    values = values or []
    return {
        "id": clean_string(curve.get("id")) or "curve",
        "label": curve_label(curve, collections),
        "color": clean_string(curve.get("color")) or "#0072b2",
        "style": clean_string(curve.get("style")) or "solid",
        "measurement": category,
        "measurement_label": MEASUREMENT_LABELS[category],
        "metric": metric,
        "metric_label": label,
        "unit": unit,
        "collections": collections,
        "count": count,
        "minimum": minimum,
        "maximum": maximum,
        "p5": quantile_value(values, 0.05),
        "median": quantile_value(values, 0.5),
        "p95": quantile_value(values, 0.95),
        "points": [
            {"value": value, "probability": probability}
            for value, probability in zip(values, probabilities)
            if value is not None
        ],
    }


def group_curves(curves: list[dict[str, object]]) -> list[dict[str, object]]:
    charts: dict[tuple[object, object], dict[str, object]] = {}
    for curve in curves:
        key = (curve["measurement"], curve["metric"])
        chart = charts.setdefault(
            key,
            {
                "measurement": curve["measurement"],
                "measurement_label": curve["measurement_label"],
                "metric": curve["metric"],
                "metric_label": curve["metric_label"],
                "unit": curve["unit"],
                "title": f"{curve['measurement_label']}: {curve['metric_label']}",
                "curves": [],
            },
        )
        chart["curves"].append(curve)
    return list(charts.values())


def compare_cdf_payload(
    request: dict[str, Any],
    root: Path,
    db_path: Path,
    measurements_dir: Path,
) -> dict[str, object]:
    database = clean_string(request.get("database"))
    if not database:
        raise ValueError("database is required")
    if not db_path.exists():
        raise FileNotFoundError("Run scripts/import_csvs.py before starting the website")

    curves = request.get("curves")
    if not isinstance(curves, list) or not curves:
        raise ValueError("At least one compare curve is required")
    if len(curves) > MAX_COMPARE_CURVES:
        raise ValueError(f"Compare supports up to {MAX_COMPARE_CURVES} curves")
    if not all(isinstance(curve, dict) for curve in curves):
        raise ValueError("Compare curves must be objects")

    start = clean_string(request.get("start"))
    end = clean_string(request.get("end"))

    with duckdb.connect(str(db_path), read_only=True) as con:
        queried = [
            query_curve(con, root, measurements_dir, database, start, end, curve)
            for curve in curves
        ]

    return {
        "database": database,
        "start": start,
        "end": end,
        "curve_count": len(queried),
        "charts": group_curves(queried),
    }
