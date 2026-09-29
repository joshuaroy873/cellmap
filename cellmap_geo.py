"""Collection-wide bounds and bounded, server-side polygon search."""

import json
import math
import threading
from functools import lru_cache
from pathlib import Path

import duckdb
from cellmap_schema import CATEGORY_TYPES, METRICS, NULL_FILTER_VALUE

MAX_VERTICES = 200
MAX_SQUARES = 6000
MERCATOR_LATITUDE = 85.0511287798066
SEARCH_SLOT = threading.BoundedSemaphore(1)
VALID_GPS = "latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180"
BOUNDS_TABLE = """CREATE TABLE IF NOT EXISTS collection_bounds (
    database_name VARCHAR, collection_name VARCHAR,
    min_latitude DOUBLE, max_latitude DOUBLE,
    min_longitude DOUBLE, max_longitude DOUBLE,
    located_row_count BIGINT NOT NULL,
    PRIMARY KEY (database_name, collection_name)
)
"""


def partition_files(con, root: Path, dataset: Path, kinds=None):
    records = con.execute("""
        SELECT database_name, collection_name, parquet_path, measurement_type
        FROM measurement_partitions ORDER BY database_name, collection_name, measurement_type
    """).fetchall()
    result = []
    for db, collection, stored, kind in records:
        if kinds is not None and kind not in kinds:
            continue
        relative = Path(stored).relative_to(Path("data/_processed"))
        path = dataset / relative
        if not path.resolve().is_relative_to((dataset / "measurements").resolve()) or not path.is_file():
            raise FileNotFoundError(f"Missing or unsafe measurement partition: {stored}")
        result.append((db, collection, str(path)))
    return result


def calculate_bounds(con, root, dataset):
    files = partition_files(con, root, dataset)
    if not files:
        return []
    # One row per collection across every measurement type and technology.
    return con.execute(f"""
        WITH bounds AS (
            SELECT database_name, collection_name,
                min(latitude) AS min_lat, max(latitude) AS max_lat,
                min(longitude) AS min_lon, max(longitude) AS max_lon, count(*) AS n
            FROM read_parquet(?, union_by_name=true, hive_partitioning=false)
            WHERE {VALID_GPS} GROUP BY database_name, collection_name
        )
        SELECT c.database_name, c.collection_name,
            b.min_lat, b.max_lat, b.min_lon, b.max_lon, coalesce(b.n, 0)
        FROM collections c LEFT JOIN bounds b USING(database_name, collection_name)
        ORDER BY c.database_name, c.collection_name
    """, [[path for _, _, path in files]]).fetchall()


def refresh_bounds(con, root, dataset):
    rows = calculate_bounds(con, root, dataset)
    return store_bounds(con, rows)


def store_bounds(con, rows):
    con.execute("BEGIN")
    try:
        con.execute(BOUNDS_TABLE)
        con.execute("DELETE FROM collection_bounds")
        if rows:
            con.executemany("INSERT INTO collection_bounds VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise
    return len(rows)


def polygon_coordinates(value):
    if not isinstance(value, list) or not 3 <= len(value) <= MAX_VERTICES + 1:
        raise ValueError(f"Draw a polygon with 3–{MAX_VERTICES} vertices")
    points = []
    for point in value:
        if not isinstance(point, list) or len(point) != 2:
            raise ValueError("Polygon points must be [longitude, latitude]")
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in point):
            raise ValueError("Polygon coordinates must be finite numbers")
        x, y = point
        if not -180 <= x <= 180 or not -90 <= y <= 90:
            raise ValueError("Polygon coordinates are outside longitude/latitude limits")
        points.append([float(x), float(y)])
    if points[-1] == points[0]:
        points.pop()
    if not 3 <= len(points) <= MAX_VERTICES or len({tuple(p) for p in points}) != len(points):
        raise ValueError("Use at least three distinct vertices, without repeated points")
    ring = points + [points[0]]
    if any(abs(a[0] - b[0]) > 180 for a, b in zip(ring, ring[1:])):
        raise ValueError("Polygons crossing the date line are not supported yet")
    return ring


def square_quotas(counts, limit=MAX_SQUARES):
    """Largest-remainder allocation using occupied cells, never measurement rows."""
    total = sum(counts)
    if total <= limit:
        return list(counts)
    quotas = [n * limit // total for n in counts]
    order = sorted(range(len(counts)), key=lambda i: (-(counts[i] * limit % total), i))
    for i in order[:limit - sum(quotas)]:
        quotas[i] += 1
    return quotas


def geo_options(root, db_path, dataset):
    """Cache only small filter metadata, invalidated when the catalog changes."""
    stat = db_path.stat()
    return _geo_options(root, db_path, dataset, (stat.st_ino, stat.st_mtime_ns, stat.st_size))


@lru_cache(maxsize=1)
def _geo_options(root, db_path, dataset, version):
    result = {}
    with duckdb.connect(str(db_path), read_only=True) as con:
        con.execute("SET threads=2")
        con.execute("SET memory_limit='1GB'")
        for category, kinds in CATEGORY_TYPES.items():
            paths = [path for _, _, path in partition_files(con, root, dataset, kinds.values())]
            rows = con.execute("""SELECT DISTINCT technology, operator_name, band_number
                FROM read_parquet(?, union_by_name=true, hive_partitioning=false)
                ORDER BY 1,2,3""", [paths]).fetchall() if paths else []
            result[category] = {"combinations": rows, "metrics": [
                {"value": name, "label": label, "unit": unit}
                for name, (label, unit) in METRICS[category].items()]}
    return result


def geo_filter_options(request, category):
    """Validate submitted filters without querying polygon-dependent choices."""
    options, applied, clauses, params = {}, {}, [], []
    fields = [("technology", "technology"), ("operator", "operator_name"),
              ("band", "technology || ':' || cast(band_number AS VARCHAR)")]
    for name, expression in fields:
        raw = request.get(name)
        if raw is not None and (not isinstance(raw, str) or len(raw) > 512):
            raise ValueError(f"Invalid {name} filter")
        value = raw if raw not in (None, "", "all") else None
        if value is not None:
            if name == "technology" and value not in ("LTE", "NR"):
                raise ValueError("Unknown technology")
            if name == "band" and (":" not in value or value.split(":", 1)[0] not in ("LTE", "NR") or not value.split(":", 1)[1].isdigit()):
                raise ValueError("Band must be technology-qualified, e.g. NR:78")
        applied[name] = value
        if value is not None:
            clauses.append(f"{expression} = ?")
            params.append(value)
    for name, expression in [
        ("operators", f"coalesce(operator_name, '{NULL_FILTER_VALUE}')"),
        ("bands", f"coalesce(technology || ':' || cast(band_number AS VARCHAR), '{NULL_FILTER_VALUE}')"),
    ]:
        values = request.get(name)
        if values is None:
            continue
        if not isinstance(values, list) or len(values) > 10000 or any(not isinstance(v, str) or len(v) > 512 for v in values):
            raise ValueError(f"Invalid {name} selection")
        values = list(dict.fromkeys(values))
        if name == "bands" and any(v != NULL_FILTER_VALUE and (
            ":" not in v or v.split(":", 1)[0] not in ("LTE", "NR") or not v.split(":", 1)[1].isdigit()
        ) for v in values):
            raise ValueError("Bands must be technology-qualified")
        applied[name] = values
        clauses.append(f"{expression} IN ({','.join('?' for _ in values)})" if values else "false")
        params.extend(values)
    where = " AND ".join(clauses) or "true"
    names = list(METRICS[category])
    options["metric"] = [{"value": m, "label": METRICS[category][m][0], "unit": METRICS[category][m][1]} for m in names]
    metric = request.get("metric")
    available = [item["value"] for item in options["metric"]]
    applied["metric"] = metric or (available[0] if available else None)
    return options, applied, where, params


def polygon_search(request, root, db_path, dataset):
    ring = polygon_coordinates(request["polygon"]) if request.get("polygon") is not None else None
    category = request.get("measurement", "radio")
    if not isinstance(category, str) or category not in CATEGORY_TYPES:
        raise ValueError("Unknown measurement type")
    metric = request.get("metric")
    if metric is not None and (not isinstance(metric, str) or metric not in METRICS[category]):
        raise ValueError("Unknown metric for this measurement type")
    size = request.get("square_size", 100000)
    if isinstance(size, bool) or size not in (1, 10, 100, 1000, 10000, 100000):
        raise ValueError("Square side length must be 1, 10, 100, 1000, 10000, or 100000 meters")
    aggregation = request.get("aggregation", "average")
    if aggregation not in ("average", "maximum"):
        raise ValueError("Aggregation must be average or maximum")
    viewport = request.get("viewport")
    if viewport is not None:
        if not isinstance(viewport, list) or len(viewport) != 4 or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in viewport):
            raise ValueError("Viewport must be [west, south, east, north]")
        if not (-180 <= viewport[0] <= viewport[2] <= 180 and -90 <= viewport[1] <= viewport[3] <= 90):
            raise ValueError("Invalid viewport bounds")
    selected = request.get("selected")
    if selected is not None:
        if not isinstance(selected, list) or len(selected) > 10000:
            raise ValueError("Invalid collection selection")
        for pair in selected:
            if not isinstance(pair, list) or len(pair) != 2 or any(not isinstance(v, str) or len(v) > 512 for v in pair):
                raise ValueError("Selections must be [database, collection] pairs")
        selected = {tuple(pair) for pair in selected}
    excluded = request.get("excluded", [])
    if not isinstance(excluded, list) or len(excluded) > 10000 or any(
        not isinstance(pair, list) or len(pair) != 2 or any(not isinstance(v, str) or len(v) > 512 for v in pair)
        for pair in excluded
    ):
        raise ValueError("Exclusions must be [database, collection] pairs")
    excluded = {tuple(pair) for pair in excluded}
    scope = request.get("collection_scope")
    if scope is not None:
        if not isinstance(scope, list) or len(scope) > 10000 or any(
            not isinstance(pair, list) or len(pair) != 2 or any(not isinstance(v, str) or len(v) > 512 for v in pair)
            for pair in scope
        ):
            raise ValueError("Collection scope must be [database, collection] pairs")
        scope = set(map(tuple, scope))
    include_options = request.get("include_exploration_options", False)
    if not isinstance(include_options, bool):
        raise ValueError("Invalid exploration options flag")
    if not SEARCH_SLOT.acquire(blocking=False):
        raise ValueError("Another region search is running; please try again shortly")
    try:
        if not db_path.is_file():
            raise FileNotFoundError("No measurement catalog is available")
        with duckdb.connect(str(db_path), read_only=True) as con:
            con.execute("SET threads=2")
            con.execute("SET memory_limit='1GB'")
            con.execute("LOAD spatial")
            scope_sql = "true"
            if scope is not None:
                con.execute("CREATE TEMP TABLE scope(database_name VARCHAR, collection_name VARCHAR)")
                if scope:
                    con.executemany("INSERT INTO scope VALUES (?,?)", sorted(scope))
                scope_sql = "EXISTS (SELECT 1 FROM scope s WHERE s.database_name = source.database_name AND s.collection_name = source.collection_name)"
            west, east, south, north = -180, 180, -MERCATOR_LATITUDE, MERCATOR_LATITUDE
            spatial_sql, spatial_params = "true", []
            if ring is not None:
                shape = json.dumps({"type": "Polygon", "coordinates": [ring]})
                valid, area = con.execute("SELECT ST_IsValid(ST_GeomFromGeoJSON(?)), ST_Area(ST_GeomFromGeoJSON(?))", [shape, shape]).fetchone()
                if not valid or area <= 0:
                    raise ValueError("Draw a non-zero-area polygon whose edges do not cross")
                west, east = min(p[0] for p in ring), max(p[0] for p in ring)
                south, north = min(p[1] for p in ring), max(p[1] for p in ring)
                spatial_sql = "ST_Covers(ST_GeomFromGeoJSON(?), ST_Point(longitude, latitude))"
                spatial_params = [shape]
            files = partition_files(con, root, dataset, CATEGORY_TYPES[category].values())
            has_bounds = con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name='collection_bounds'").fetchone()[0]
            bounds = {}
            if has_bounds:
                bounds = {(db, coll): (lo_y, hi_y, lo_x, hi_x, count) for db, coll, lo_y, hi_y, lo_x, hi_x, count in con.execute("SELECT * FROM collection_bounds").fetchall()}
            candidates = []
            for db, coll, path in files:
                if scope is not None and (db, coll) not in scope:
                    continue
                box = bounds.get((db, coll))
                if box is not None:
                    lo_y, hi_y, lo_x, hi_x, count = box
                    if count == 0:
                        continue
                    if None not in (lo_y, hi_y, lo_x, hi_x) and (hi_y < south or lo_y > north or hi_x < west or lo_x > east):
                        continue
                candidates.append(path)
            options, applied, where, params = geo_filter_options(request, category)
            metric = applied["metric"]
            numeric = ["latitude", "longitude", "band_number", metric]
            strings = ["database_name", "collection_name", "technology", "operator_name"]
            columns = ",".join(f'"{name}"' for name in [*strings, *numeric])
            # Primary searches also discover exploration choices outside their
            # operator/band filter, but only inside their returned collections.
            source_where, source_params = ("true", []) if include_options else (where, params)
            if candidates:
                con.execute(f"""
                    CREATE TEMP TABLE region_source AS SELECT {columns}
                    FROM read_parquet(?, union_by_name=true, hive_partitioning=false) AS source
                    WHERE {VALID_GPS} AND abs(latitude) <= {MERCATOR_LATITUDE}
                      AND {scope_sql} AND {source_where} AND isfinite("{metric}")
                      AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?
                      AND {spatial_sql}
                """, [candidates, *source_params, south, north, west, east, *spatial_params])
            else:
                con.execute("CREATE TEMP TABLE region_source (" + ",".join(f'"{n}" VARCHAR' for n in strings) + "," + ",".join(f'"{n}" DOUBLE' for n in numeric) + ")")
            result = {"collections": [], "squares": [], "square_collections": [], "total": 0, "square_count": 0,
                      "visible_square_count": 0, "limit": MAX_SQUARES, "options": options,
                      "filters": applied, "square_size": size, "aggregation": aggregation,
                      "minimum": None, "maximum": None, "sampled": False}
            if metric is None:
                return result
            result.update(metric=metric, label=METRICS[category][metric][0], unit=METRICS[category][metric][1])
            # Average is the arithmetic mean of stored metric values (including
            # dBm, without linear-power conversion). Filter before projection.
            con.execute(f"""
                CREATE TEMP TABLE collection_cells AS
                WITH projected AS (
                    SELECT database_name, collection_name, "{metric}" AS value,
                        ST_Transform(ST_Point(longitude, latitude), 'EPSG:4326',
                                     'EPSG:3857', always_xy := true) AS p
                    FROM region_source WHERE {where}
                ) SELECT database_name, collection_name,
                    floor(ST_X(p)/?)::BIGINT AS gx, floor(ST_Y(p)/?)::BIGINT AS gy,
                    count(*) AS n, sum(value) AS total_value, max(value) AS max_value
                FROM projected GROUP BY database_name, collection_name, gx, gy
            """, [*params, size, size])
            groups = con.execute("SELECT database_name, collection_name, sum(n)::BIGINT, count(*) FROM collection_cells GROUP BY 1,2 ORDER BY 1,2").fetchall()
            result["collections"] = [{"database": db, "collection": coll, "count": n, "squares": cells} for db, coll, n, cells in groups]
            if include_options:
                result["exploration_options"] = con.execute("""
                    SELECT DISTINCT r.database_name, r.collection_name,
                                    r.technology, r.operator_name, r.band_number
                    FROM region_source r
                    SEMI JOIN collection_cells c USING(database_name,collection_name)
                    ORDER BY 1,2,3,4,5
                """).fetchall()
            con.execute("CREATE TEMP TABLE selection(database_name VARCHAR, collection_name VARCHAR)")
            chosen = [(db, coll) for db, coll, _, _ in groups
                      if (selected is None or (db, coll) in selected) and (db, coll) not in excluded]
            if chosen:
                con.executemany("INSERT INTO selection VALUES (?, ?)", chosen)
            con.execute("CREATE TEMP TABLE chosen_cells AS SELECT c.* FROM collection_cells c JOIN selection s USING(database_name, collection_name)")
            aggregate = "sum(total_value)/sum(n)" if aggregation == "average" else "max(max_value)"
            con.execute(f"CREATE TEMP TABLE squares AS SELECT gx, gy, sum(n)::BIGINT AS n, {aggregate} AS value FROM chosen_cells GROUP BY gx, gy")
            total, cells, minimum, maximum = con.execute("SELECT coalesce(sum(n),0)::BIGINT, count(*), min(value), max(value) FROM squares").fetchone()
            result.update(total=total, square_count=cells, minimum=minimum, maximum=maximum)
            # Panning must not change a square's polygon-filtered aggregate.
            view_sql, view_params = "true", []
            if viewport is not None:
                def project(lon, lat):
                    lat = max(-MERCATOR_LATITUDE, min(MERCATOR_LATITUDE, lat))
                    return 6378137 * math.radians(lon), 6378137 * math.log(math.tan(math.pi/4 + math.radians(lat)/2))
                left, bottom = project(viewport[0], viewport[1])
                right, top = project(viewport[2], viewport[3])
                view_sql = "(gx+1)*? >= ? AND gx*? <= ? AND (gy+1)*? >= ? AND gy*? <= ?"
                view_params = [size, left, size, right, size, bottom, size, top]
            con.execute(f"CREATE TEMP TABLE visible_squares AS SELECT * FROM squares WHERE {view_sql}", view_params)
            visible = con.execute("SELECT count(*) FROM visible_squares").fetchone()[0]
            result["visible_square_count"] = visible
            con.execute("CREATE TEMP TABLE visible_collection_cells AS SELECT c.* FROM chosen_cells c JOIN visible_squares s USING(gx, gy)")
            coverage = con.execute("SELECT database_name, collection_name, count(*) FROM visible_collection_cells GROUP BY 1,2 ORDER BY 1,2").fetchall()
            quotas = square_quotas([n for _, _, n in coverage])
            con.execute("CREATE TEMP TABLE quotas(database_name VARCHAR, collection_name VARCHAR, quota BIGINT)")
            if coverage:
                con.executemany("INSERT INTO quotas VALUES (?, ?, ?)", [(db, coll, q) for (db, coll, _), q in zip(coverage, quotas)])
            # Sample cells per collection, deduplicate overlaps, then fill spare
            # slots. Displayed values include ALL selected rows, not sample rows.
            con.execute("""
                CREATE TEMP TABLE sampled_ids AS
                SELECT DISTINCT gx, gy FROM (
                    SELECT c.*, q.quota, row_number() OVER (
                        PARTITION BY database_name, collection_name ORDER BY hash(gx,gy), gx, gy
                    ) AS rank FROM visible_collection_cells c JOIN quotas q USING(database_name,collection_name)
                ) WHERE rank <= quota
            """)
            con.execute("""
                CREATE TEMP TABLE displayed_squares AS
                SELECT s.gx,s.gy,s.value,s.n FROM visible_squares s
                LEFT JOIN sampled_ids p USING(gx,gy)
                ORDER BY p.gx IS NULL, hash(s.gx,s.gy), s.gx,s.gy LIMIT ?
            """, [MAX_SQUARES])
            result["squares"] = con.execute("SELECT * FROM displayed_squares ORDER BY gx,gy").fetchall()
            # Small collection indices avoid repeating database/collection names
            # for each square. Include unchecked matching collections so a click
            # can select every collection represented at that location.
            con.execute("CREATE TEMP TABLE collection_ids(database_name VARCHAR, collection_name VARCHAR, id INTEGER)")
            if groups:
                con.executemany("INSERT INTO collection_ids VALUES (?,?,?)", [(db, coll, i) for i, (db, coll, _, _) in enumerate(groups)])
            memberships = con.execute("""
                SELECT c.gx,c.gy,list(i.id ORDER BY i.id)
                FROM collection_cells c JOIN displayed_squares d USING(gx,gy)
                JOIN collection_ids i USING(database_name,collection_name)
                GROUP BY c.gx,c.gy ORDER BY c.gx,c.gy
            """).fetchall()
            result["square_collections"] = [ids for _, _, ids in memberships]
            result["sampled"] = visible > MAX_SQUARES
            result["allocations"] = [{"database": db, "collection": coll, "visible_squares": n, "quota": q} for (db, coll, n), q in zip(coverage, quotas)]
            return result
    finally:
        SEARCH_SLOT.release()
