"""Collection-wide bounds and bounded, server-side polygon search."""

import json
import math
import threading
from pathlib import Path

import duckdb

MAX_VERTICES = 200
MAX_POINTS = 6000
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


def partition_files(con, root: Path, dataset: Path):
    records = con.execute("""
        SELECT database_name, collection_name, parquet_path
        FROM measurement_partitions ORDER BY database_name, collection_name, measurement_type
    """).fetchall()
    result = []
    for db, collection, stored in records:
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


def polygon_search(request, root, db_path, dataset):
    ring = polygon_coordinates(request.get("polygon"))
    selected = request.get("selected")
    if selected is not None:
        if not isinstance(selected, list) or len(selected) > 10000:
            raise ValueError("Invalid collection selection")
        for pair in selected:
            if not isinstance(pair, list) or len(pair) != 2 or any(not isinstance(v, str) or len(v) > 512 for v in pair):
                raise ValueError("Selections must be [database, collection] pairs")
        selected = {tuple(pair) for pair in selected}
    if not SEARCH_SLOT.acquire(blocking=False):
        raise ValueError("Another region search is running; please try again shortly")
    try:
        if not db_path.is_file():
            raise FileNotFoundError("No measurement catalog is available")
        with duckdb.connect(str(db_path), read_only=True) as con:
            con.execute("SET threads=2")
            con.execute("SET memory_limit='1GB'")
            con.execute("LOAD spatial")
            shape = json.dumps({"type": "Polygon", "coordinates": [ring]})
            valid, area = con.execute("SELECT ST_IsValid(ST_GeomFromGeoJSON(?)), ST_Area(ST_GeomFromGeoJSON(?))", [shape, shape]).fetchone()
            if not valid or area <= 0:
                raise ValueError("Draw a non-zero-area polygon whose edges do not cross")
            west, east = min(p[0] for p in ring), max(p[0] for p in ring)
            south, north = min(p[1] for p in ring), max(p[1] for p in ring)
            files = partition_files(con, root, dataset)
            has_bounds = con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name='collection_bounds'").fetchone()[0]
            bounds = {}
            if has_bounds:
                bounds = {(db, coll): (lo_y, hi_y, lo_x, hi_x, count) for db, coll, lo_y, hi_y, lo_x, hi_x, count in con.execute("SELECT * FROM collection_bounds").fetchall()}
            candidates = []
            for db, coll, path in files:
                if selected is not None and (db, coll) not in selected:
                    continue
                box = bounds.get((db, coll))
                if box is not None:
                    lo_y, hi_y, lo_x, hi_x, count = box
                    if count == 0:
                        continue
                    if None not in (lo_y, hi_y, lo_x, hi_x) and (hi_y < south or lo_y > north or hi_x < west or lo_x > east):
                        continue
                candidates.append(path)
            if not candidates:
                return {"collections": [], "points": [], "total": 0, "limit": MAX_POINTS}
            con.execute(f"""
                CREATE TEMP TABLE region_matches AS
                SELECT database_name, collection_name, latitude, longitude
                FROM read_parquet(?, union_by_name=true, hive_partitioning=false)
                WHERE {VALID_GPS}
                  AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?
                  AND ST_Covers(ST_GeomFromGeoJSON(?), ST_Point(longitude, latitude))
            """, [candidates, south, north, west, east, shape])
            groups = con.execute("""
                SELECT database_name, collection_name, count(*) FROM region_matches
                GROUP BY database_name, collection_name ORDER BY database_name, collection_name
            """).fetchall()
            # Spread the capped preview across collections, not just the first file.
            points = con.execute("""
                SELECT database_name, collection_name, latitude, longitude FROM (
                    SELECT *, row_number() OVER (
                        PARTITION BY database_name, collection_name ORDER BY hash(latitude, longitude)
                    ) AS n FROM region_matches
                ) ORDER BY n, database_name, collection_name LIMIT ?
            """, [MAX_POINTS]).fetchall()
            return {
                "collections": [{"database": db, "collection": coll, "count": n} for db, coll, n in groups],
                "points": points, "total": sum(n for _, _, n in groups), "limit": MAX_POINTS,
            }
    finally:
        SEARCH_SLOT.release()
