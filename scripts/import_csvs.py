#!/usr/bin/env python3
"""Scan a CSV folder and safely import measurements; --rebuild replaces the dataset."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
import sys
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, urlencode
from urllib.request import ProxyHandler, build_opener

import duckdb

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from cellmap_schema import (  # noqa: E402
    COMMON_COLUMNS,
    DERIVED_COLUMNS,
    FILE_TYPES,
    MEASUREMENT_SCHEMAS,
    ROW_FILTERS,
    SCHEMA_VERSION,
)
ROOT = REPO_ROOT
DB_PATH = ROOT / "data/_processed/cellular.duckdb"


DATA = ROOT / "data"
ACTIVE = DATA / "_processed"
OUTPUT = ACTIVE / "measurements"
DEFAULT_SERVICES = ["cellmap-server-8000.service", "cellmap-repo-preview-8001.service"]
CSV_NAME_ALIASES = {
    "ltepdschpercarrier": "lte_pdsch", "ltepuschpercarrier": "lte_pusch",
    "lteradioneig": "lte_radio_neighbor", "lteradioconnected": "lte_radio",
    "nrpdschpercarrier": "nr_pdsch", "nrpuschpercarrier": "nr_pusch",
    "nrradiobeam": "nr_radio_neighbor", "nrradioconnected": "nr_radio",
}


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

        CREATE TABLE IF NOT EXISTS shared_views (
            id VARCHAR PRIMARY KEY,
            state_json VARCHAR NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
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


@contextmanager
def import_lock():
    """Serialize command-line imports/rebuilds without locking out website readers."""
    DATA.mkdir(parents=True, exist_ok=True)
    with (DATA / ".import.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another import or rebuild is already running") from None
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def sql_string(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def sql_name(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def token(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def display_path(path: Path) -> str:
    return str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)


def source_time(path: Path, date: datetime | None = None) -> datetime:
    if date is not None:
        return date
    try:
        return export_time(path)
    except ValueError:
        return datetime.fromtimestamp(path.stat().st_mtime)


def parse_date(value: str) -> datetime:
    for pattern in ("%Y%m%d", "%Y%m%d-%H%M"):
        try:
            return datetime.strptime(value, pattern)
        except ValueError:
            pass
    raise argparse.ArgumentTypeError("Use YYYYMMDD or YYYYMMDD-HHMM")


def archived_database(path: Path) -> str | None:
    archive = (DATA / "_csvs").resolve()
    if path.is_relative_to(archive):
        relative = path.relative_to(archive)
        if len(relative.parts) == 3:
            export_time(path)  # Archive directory dates must be valid.
            return relative.parts[0]
    return None


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def database_directory(root: Path, database: str) -> Path:
    """Return a safe direct child directory for a database identifier."""
    if (
        not database
        or database in (".", "..")
        or "/" in database
        or "\\" in database
    ):
        raise ValueError("database must be a single, non-empty directory name")
    resolved_root = root.resolve()
    target = (resolved_root / database).resolve()
    if target.parent != resolved_root:
        raise ValueError("database must be a direct child directory name")
    return target


def archived_database_directory(database: str) -> Path:
    return database_directory(DATA / "_csvs", database)


def processed_database_directories(database: str) -> list[Path]:
    segment = f"database={quote(database, safe='')}"
    return [
        database_directory(OUTPUT / kind, segment)
        for kind in sorted(set(FILE_TYPES.values()))
    ]


def processed_file_keys(
    con: duckdb.DuckDBPyConnection, source_prefix: str, database: str,
) -> list[tuple[object, object, object]]:
    keys = {
        (file_hash, measurement_type, schema_version)
        for file_hash, measurement_type, schema_version, source_path in con.execute(
            """
            SELECT file_hash, measurement_type, schema_version, source_path
            FROM processed_files
            """
        ).fetchall()
        if str(source_path).startswith(source_prefix)
    }
    keys.update(con.execute("""
        SELECT DISTINCT f.file_hash, f.measurement_type, f.schema_version
        FROM processed_files f
        JOIN measurement_partitions p
          ON f.file_hash = p.source_file_hash AND f.measurement_type = p.measurement_type
        WHERE p.database_name = ?
    """, [database]).fetchall())
    return sorted(keys)


def database_deletion_plan(
    database: str,
) -> tuple[
    Path,
    list[Path],
    list[str],
    int,
    int,
    list[tuple[object, object, object]],
]:
    """Describe the local files and catalog records owned by one database."""
    archive = archived_database_directory(database)
    processed = processed_database_directories(database)
    collections: list[str] = []
    partition_count = 0
    row_count = 0
    file_keys: list[tuple[object, object, object]] = []

    if not DB_PATH.exists():
        return archive, processed, collections, partition_count, row_count, file_keys

    source_prefix = f"{archive.relative_to(ROOT).as_posix()}/"
    with duckdb.connect(str(DB_PATH), read_only=True) as con:
        partition_count, row_count = con.execute(
            """
            SELECT count(*), coalesce(sum(row_count), 0)
            FROM measurement_partitions
            WHERE database_name = ?
            """,
            [database],
        ).fetchone()
        collections = [
            str(collection)
            for (collection,) in con.execute(
                """
                SELECT DISTINCT collection_name
                FROM measurement_partitions
                WHERE database_name = ?
                ORDER BY collection_name
                """,
                [database],
            ).fetchall()
        ]
        file_keys = processed_file_keys(con, source_prefix, database)

    return (
        archive,
        processed,
        collections,
        int(partition_count),
        int(row_count),
        file_keys,
    )


def print_database_deletion_plan(
    database: str,
    archive: Path,
    processed: list[Path],
    collections: list[str],
    partition_count: int,
    row_count: int,
    file_keys: list[tuple[object, object, object]],
) -> None:
    print(f"Database deletion preview: {database}")
    print(
        f"  raw archive: {archive.relative_to(ROOT)} "
        f"({'delete' if archive.exists() else 'not found'})"
    )
    for path in processed:
        if path.exists():
            print(f"  processed partitions: {path.relative_to(ROOT)} (delete)")
    if collections:
        print(f"  collections ({len(collections):,}):")
        for collection in collections:
            print(f"    - {collection}")
    else:
        print("  collections: none cataloged")
    print(f"  catalog partitions: {partition_count:,} ({row_count:,} rows)")
    print(f"  processed-file records: {len(file_keys):,}")


def delete_database(database: str) -> None:
    """Delete one database's archived data, generated partitions, and metadata."""
    (
        archive,
        processed,
        _collections,
        partition_count,
        row_count,
        file_keys,
    ) = database_deletion_plan(database)
    if DB_PATH.exists():
        source_prefix = f"{archive.relative_to(ROOT).as_posix()}/"
        with duckdb.connect(str(DB_PATH)) as con:
            initialize(con)
            con.execute("BEGIN")
            try:
                file_keys = processed_file_keys(con, source_prefix, database)
                con.execute(
                    "DELETE FROM measurement_partitions WHERE database_name = ?",
                    [database],
                )
                for file_hash, measurement_type, schema_version in file_keys:
                    con.execute(
                        """
                        DELETE FROM processed_files
                        WHERE file_hash = ?
                          AND measurement_type = ?
                          AND schema_version = ?
                        """,
                        [file_hash, measurement_type, schema_version],
                    )
                con.execute("COMMIT")
            except Exception:
                con.execute("ROLLBACK")
                raise

    for path in [archive, *processed]:
        if path.exists():
            shutil.rmtree(path)
            print(f"DELETE directory: {path.relative_to(ROOT)}")

    print(
        f"Deleted database {database}: {partition_count:,} catalog partitions "
        f"({row_count:,} rows) and {len(file_keys):,} processed-file records."
    )


def export_time(path: Path) -> datetime:
    batch = path.parent.name
    for pattern in ("%Y%m%d-%H%M", "%Y%m%d"):
        try:
            return datetime.strptime(batch, pattern)
        except ValueError:
            pass
    raise ValueError(f"{path}: export folder must be YYYYMMDD or YYYYMMDD-HHMM")


def canonical_select(
    con: duckdb.DuckDBPyConnection, path: Path, kind: str,
    *, apply_filters: bool = True,
) -> str:
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
    for name, data_type, aliases in COMMON_COLUMNS + MEASUREMENT_SCHEMAS[kind]:
        derived = DERIVED_COLUMNS.get(kind, {}).get(name)
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
    where = f" WHERE {' AND '.join(filters)}" if filters and apply_filters else ""
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




def load_staged_csv(con: duckdb.DuckDBPyConnection, path: Path, kind: str) -> None:
    select = canonical_select(con, path, kind)
    con.execute(f"CREATE OR REPLACE TEMP TABLE staged AS {select}")


def validate_staged_rows(con: duckdb.DuckDBPyConnection, path: Path) -> None:
    invalid = con.execute("""
        SELECT count(*) FROM staged
        WHERE measured_at IS NULL
           OR database_name IS NULL
           OR collection_name IS NULL
    """).fetchone()[0]
    if invalid:
        raise ValueError(f"{path}: {invalid} rows lack time, database, or collection")


def staged_columns(con: duckdb.DuckDBPyConnection) -> list[str]:
    return [row[1] for row in con.execute("PRAGMA table_info('staged')").fetchall()]


def partition_summaries(
    con: duckdb.DuckDBPyConnection, columns: list[str]
) -> list[tuple[object, ...]]:
    fields = ", ".join(f"{sql_name(name)} := {sql_name(name)}" for name in columns)
    return con.execute(f"""
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


def current_partition(
    con: duckdb.DuckDBPyConnection,
    database: str,
    collection: str,
    kind: str,
) -> tuple[object, ...] | None:
    return con.execute(
        """
        SELECT content_hash, exported_at, parquet_path, schema_version
        FROM measurement_partitions
        WHERE database_name = ?
          AND collection_name = ?
          AND measurement_type = ?
        """,
        [database, collection, kind],
    ).fetchone()


def partition_path(
    database: str, collection: str, kind: str, output: Path | None = None,
) -> Path:
    return (
        (OUTPUT if output is None else output)
        / kind
        / f"database={quote(database, safe='')}"
        / f"collection={quote(collection, safe='')}"
        / "data.parquet"
    )


def write_partition(
    con: duckdb.DuckDBPyConnection,
    database: str,
    collection: str,
    target: Path,
) -> None:
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


def record_processed_file(
    con: duckdb.DuckDBPyConnection,
    path: Path,
    kind: str,
    raw_hash: str,
    exported_at: datetime,
) -> None:
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
            display_path(path),
            exported_at.date(),
        ],
    )


def process_partition(
    con: duckdb.DuckDBPyConnection,
    path: Path,
    kind: str,
    force: bool,
    raw_hash: str,
    exported_at: datetime,
    columns: list[str],
    summary: tuple[object, ...],
    *, output: Path | None = None,
) -> None:
    database, collection, count, start, end, *hash_parts = summary
    fingerprint = partition_fingerprint(
        kind, columns, (count, start, end, *hash_parts)
    )
    current = current_partition(con, database, collection, kind)

    if current and current[1] and exported_at < current[1]:
        print(
            f"SKIP older [{path.parent.name}]: "
            f"{database} / {collection} / {kind}"
        )
        return

    target = partition_path(database, collection, kind, output)
    # A staged rebuild stores final, fixed paths, not its temporary directory.
    relative_target = partition_path(database, collection, kind).relative_to(ROOT).as_posix()
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
        write_partition(con, database, collection, target)
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



def discover_inputs(
    paths: list[Path], *, rebuild: bool = False, date: datetime | None = None,
) -> tuple[list[tuple[Path, str]], list[str]]:
    """Scan recursively; full archive rebuilds choose the newest export per type."""
    candidates = set()
    for item in paths or [DATA / "_csvs"]:
        item = item.resolve()
        if not item.exists():
            raise FileNotFoundError(item)
        candidates.update([item] if item.is_file() else (
            p.resolve() for p in item.rglob("*") if p.is_file() and p.suffix.lower() == ".csv"
        ))
    selected = []
    latest = {}
    superseded = []
    for path in sorted(candidates):
        kind = FILE_TYPES.get(path.stem.lower()) or CSV_NAME_ALIASES.get(token(path.stem))
        if path.suffix.lower() != ".csv" or kind is None:
            raise ValueError(f"Unknown CSV filename (not silently skipped): {path}")
        database = archived_database(path)
        if not rebuild or database is None:
            selected.append((path, kind))
            continue
        exported = source_time(path, date)
        key = (database, kind)
        previous = latest.get(key)
        if previous and previous[0] == exported:
            raise ValueError(f"Ambiguous same-date exports for {key}: {previous[1]} and {path}")
        if previous and previous[0] > exported:
            superseded.append(display_path(path))
        else:
            if previous:
                superseded.append(display_path(previous[1]))
            latest[key] = (exported, path)
    selected.extend((value[1], key[1]) for key, value in sorted(latest.items()))
    if not selected:
        raise ValueError("No recognized CSVs supplied; nothing was imported")
    return sorted(selected, key=lambda item: (source_time(item[0], date), str(item[0])), reverse=True), superseded


def seed_dataset(stage: Path) -> None:
    """Copy catalog metadata and hard-link immutable files; never edit live files."""
    if not DB_PATH.exists():
        return
    with duckdb.connect(str(stage / "cellular.duckdb")) as con:
        initialize(con)
        con.execute(f"ATTACH {sql_string(DB_PATH)} AS previous (READ_ONLY)")
        for table in ("measurement_partitions", "processed_files", "shared_views"):
            exists = con.execute(
                "SELECT 1 FROM information_schema.tables WHERE table_catalog='previous' AND table_name=?", [table]
            ).fetchone()
            if exists:
                con.execute(f"INSERT INTO {table} BY NAME SELECT * FROM previous.main.{table}")
        stored_paths = con.execute("SELECT parquet_path FROM measurement_partitions").fetchall()
        for (stored,) in stored_paths:
            relative = Path(stored).relative_to(ACTIVE.relative_to(ROOT))
            if not relative.parts or relative.parts[0] != "measurements" or ".." in relative.parts:
                raise ValueError(f"Unsafe existing partition path: {stored}")
            source = ROOT / stored
            if source.is_symlink() or not source.resolve().is_relative_to(OUTPUT.resolve()) or not source.is_file():
                raise ValueError(f"Missing or unsafe existing partition: {stored}")
            target = stage / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            os.link(source, target)
        con.execute("DETACH previous")


def build_dataset(
    stage: Path, inputs: list[tuple[Path, str]], *, rebuild: bool = True,
    force: bool = False, date: datetime | None = None,
) -> list[dict]:
    reports = []
    seen = {}
    if not rebuild:
        seed_dataset(stage)
    with duckdb.connect(str(stage / "cellular.duckdb")) as con:
        initialize(con)
        con.execute("SET threads=2")
        con.execute("SET memory_limit='1GB'")
        for path, kind in sorted(inputs, key=lambda item: (source_time(item[0], date), str(item[0])), reverse=True):
            raw_hash = file_hash(path)
            exported = source_time(path, date)
            unfiltered = canonical_select(con, path, kind, apply_filters=False)
            con.execute(f"CREATE OR REPLACE TEMP TABLE staged AS {unfiltered}")
            # Validate even excluded rows: a malformed export must not look empty.
            validate_staged_rows(con, path)
            raw_count = con.execute("SELECT count(*) FROM staged").fetchone()[0]
            groups = con.execute("SELECT DISTINCT database_name, collection_name FROM staged").fetchall()
            database = archived_database(path)
            if database is not None and {row[0] for row in groups} - {database}:
                raise ValueError(f"CSV Database values do not match its archive directory: {path}")
            if rebuild and not raw_count and database is None and sum(k == kind for _, k in inputs) > 1:
                raise ValueError(
                    f"Empty CSV has no database/collection scope: {path}. "
                    "Exclude older exports from the supplied folder, or use the dated archive layout."
                )
            eligible = []
            for db, collection in groups:
                key = (db, collection, kind)
                previous = seen.get(key)
                if previous is not None:
                    if previous == (exported, raw_hash):
                        continue
                    if previous[0] == exported:
                        raise ValueError(f"Ambiguous same-date snapshots for {key}; supply distinct export dates")
                    continue
                seen[key] = (exported, raw_hash)
                eligible.append((db, collection))
            load_staged_csv(con, path, kind)
            validate_staged_rows(con, path)
            accepted = con.execute("SELECT count(*) FROM staged").fetchone()[0]
            con.execute("CREATE OR REPLACE TEMP TABLE import_scope(database_name VARCHAR, collection_name VARCHAR)")
            if eligible:
                con.executemany("INSERT INTO import_scope VALUES (?, ?)", eligible)
            con.execute("""
                DELETE FROM staged WHERE NOT EXISTS (
                    SELECT 1 FROM import_scope s WHERE s.database_name=staged.database_name
                    AND s.collection_name=staged.collection_name
                )
            """)
            eligible_rows = con.execute("SELECT count(*) FROM staged").fetchone()[0]
            columns = staged_columns(con)
            for summary in partition_summaries(con, columns):
                process_partition(
                    con, path, kind, force, raw_hash, exported, columns, summary,
                    output=stage / "measurements",
                )
            if file_hash(path) != raw_hash:
                raise ValueError(f"CSV changed during the import: {path}")
            record_processed_file(con, path, kind, raw_hash, exported)
            report = {
                "source": display_path(path), "type": kind,
                "raw_rows": raw_count, "accepted_rows": accepted,
                "excluded_by_rules": raw_count - accepted,
                "superseded_rows": accepted - eligible_rows,
                "empty_csv": raw_count == 0,
            }
            if not accepted and not rebuild:
                report["note"] = "No accepted rows; existing measurements were preserved"
            reports.append(report)
            print(json.dumps(report), flush=True)
    return reports


def validate_dataset(stage: Path) -> dict:
    """Read every partition, not only its metadata, before allowing activation."""
    with duckdb.connect(str(stage / "cellular.duckdb"), read_only=True) as con:
        con.execute("SET threads=2")
        con.execute("SET memory_limit='1GB'")
        rows = con.execute("""
            SELECT database_name, collection_name, measurement_type, parquet_path,
                   row_count, start_time, end_time, schema_version
            FROM measurement_partitions
        """).fetchall()
        referenced = set()
        total = 0
        for database, collection, kind, stored, count, start, end, version in rows:
            expected = partition_path(database, collection, kind).relative_to(ROOT)
            if Path(stored) != expected or not 1 <= version <= SCHEMA_VERSION:
                raise ValueError(f"Unexpected catalog path/schema: {stored}")
            path = stage / Path(stored).relative_to(ACTIVE.relative_to(ROOT))
            if not path.resolve().is_relative_to((stage / "measurements").resolve()) or not path.is_file():
                raise ValueError(f"Missing or unsafe Parquet partition: {stored}")
            columns = con.execute("DESCRIBE SELECT * FROM read_parquet(?, hive_partitioning=false)", [str(path)]).fetchall()
            expected_columns = [(name, dtype) for name, dtype, _ in COMMON_COLUMNS + MEASUREMENT_SCHEMAS[kind]]
            if [(row[0], row[1]) for row in columns] != expected_columns:
                raise ValueError(f"Parquet columns do not match the schema: {stored}")
            actual = con.execute("""
                SELECT count(*), min(measured_at), max(measured_at),
                       count(*) FILTER (WHERE measured_at IS NULL
                           OR database_name IS DISTINCT FROM ?
                           OR collection_name IS DISTINCT FROM ?)
                FROM read_parquet(?, hive_partitioning=false)
            """, [database, collection, str(path)]).fetchone()
            if actual != (count, start, end, 0) or count <= 0:
                raise ValueError(f"Parquet contents do not match the catalog: {stored}")
            # Force decoding of every column, including values not used above.
            con.execute("SELECT sum(hash(p)) FROM read_parquet(?, hive_partitioning=false) p", [str(path)]).fetchone()
            referenced.add(path.resolve())
            total += count
        files = {p.resolve() for p in (stage / "measurements").rglob("*.parquet")}
        if files != referenced:
            raise ValueError("Uncataloged Parquet files found in staged dataset")
        collections = con.execute("SELECT database_name, collection_name FROM collections ORDER BY 1, 2").fetchall()
    return {"partitions": len(rows), "rows": total, "collections": collections}


def preserve_shares(active: Path, stage: Path) -> None:
    # Preserve legacy DuckDB links in the new catalog, without changing originals.
    if (active / "cellular.duckdb").exists():
        with duckdb.connect(str(active / "cellular.duckdb"), read_only=True) as old:
            exists = old.execute("SELECT 1 FROM information_schema.tables WHERE table_name='shared_views'").fetchone()
            rows = old.execute("SELECT id, state_json, cast(created_at AS VARCHAR) FROM shared_views").fetchall() if exists else []
        with duckdb.connect(str(stage / "cellular.duckdb")) as new:
            if rows:
                new.executemany("INSERT INTO shared_views VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING", rows)
    # The SQLite store lives outside the swapped directory. Copy legacy storage
    # only after servers have stopped, so in-flight share creation is preserved.
    sys.path.insert(0, str(ROOT / "website"))
    from server import initialize_share_store
    initialize_share_store(DATA / "shared_views.sqlite3", active / "shared_views.sqlite3")


class WebsiteServices:
    """Stop/restart only the repo's explicitly named user services."""

    def __init__(self, names: list[str]):
        self.services = []
        for name in dict.fromkeys(names):
            if name.startswith("-") or not name.endswith(".service"):
                raise ValueError(f"Expected a user service name: {name}")
            output = subprocess.run(
                ["systemctl", "--user", "show", name, "-p", "ActiveState", "-p", "MainPID", "-p", "FragmentPath"],
                check=True, capture_output=True, text=True,
            ).stdout
            properties = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
            if properties.get("ActiveState") != "active":
                continue
            pid = int(properties["MainPID"])
            cwd = Path(f"/proc/{pid}/cwd").resolve()
            command = Path(f"/proc/{pid}/cmdline").read_bytes().decode().strip("\0").split("\0")
            if cwd != ROOT or len(command) < 2 or not any((cwd / arg).resolve() == ROOT / "website/server.py" for arg in command[1:] if not arg.startswith("-")):
                raise ValueError(f"Refusing to manage a service not running this repository's website: {name}")
            # Transient systemd-run units disappear on stop; retain their command.
            transient = "/transient/" in properties.get("FragmentPath", "")
            self.services.append((name, command, transient, pid))
        managed = {record[3] for record in self.services}
        for proc in Path("/proc").iterdir():
            if not proc.name.isdigit() or int(proc.name) in managed:
                continue
            try:
                cwd = (proc / "cwd").resolve()
                command = (proc / "cmdline").read_bytes().decode().split("\0")
                if cwd == ROOT and any((cwd / arg).resolve() == ROOT / "website/server.py" for arg in command[1:] if arg and not arg.startswith("-")):
                    raise ValueError(f"Unmanaged website process {proc.name}; stop it or include its --service before activation")
            except (FileNotFoundError, PermissionError, ProcessLookupError):
                continue

    def stop(self) -> None:
        if self.services:
            subprocess.run(["systemctl", "--user", "stop", *[r[0] for r in self.services]], check=True)

    def start(self) -> None:
        for name, command, transient, _ in self.services:
            # A partially completed stop may have left a service running.
            status = subprocess.run(["systemctl", "--user", "is-active", "--quiet", name])
            if status.returncode == 0:
                continue
            if transient:
                # A failed transient unit can remain registered after stop.
                subprocess.run(["systemctl", "--user", "reset-failed", name], capture_output=True)
                subprocess.run([
                    "systemd-run", "--user", "--unit=" + name,
                    "--working-directory=" + str(ROOT), *command,
                ], check=True)
            else:
                subprocess.run(["systemctl", "--user", "start", name], check=True)

    def check(self, expected: dict | None = None) -> None:
        opener = build_opener(ProxyHandler({}))
        for name, command, _, _ in self.services:
            def arg(flag, default):
                return command[command.index(flag) + 1] if flag in command else default
            host = arg("--host", "127.0.0.1")
            host = "127.0.0.1" if host == "0.0.0.0" else host
            base = f"http://{host}:{arg('--port', '8000')}"
            def get(path):
                with opener.open(base + path, timeout=30) as response:
                    return json.load(response)
            for attempt in range(20):
                try:
                    if get("/api/health").get("status") != "ok":
                        raise ValueError("Health check failed")
                    break
                except OSError:
                    if attempt == 19:
                        raise
                    time.sleep(0.25)
            catalog = get("/api/catalog")
            actual = sorted((d["name"], c["name"]) for d in catalog["databases"] for c in d["collections"])
            if expected is not None and actual != sorted(map(tuple, expected["collections"])):
                raise ValueError(f"Website catalog does not match replacement: {name}")
            if actual:
                database = catalog["databases"][0]
                collection = database["collections"][0]
                query = {"database": database["name"], "collection": collection["name"], "measurement": collection["categories"][0]}
                options = get("/api/options?" + urlencode(query))
                if options["metrics"]:
                    query["metric"] = options["metrics"][0]["value"]
                    payload = get("/api/measurements?" + urlencode(query))
                    if "summary" not in payload or "points" not in payload:
                        raise ValueError(f"Measurement query failed: {name}")


def activate_dataset(stage: Path, services, expected: dict) -> Path:
    """Two explicit renames while stopped; restore the old directory on failure."""
    if stage.parent != DATA or not stage.name.startswith("_rebuild-") or stage.is_symlink():
        raise ValueError("Only a staged rebuild in this repository can be activated")
    if ACTIVE.exists() and (not ACTIVE.is_dir() or ACTIVE.is_symlink()):
        raise ValueError("Expected a real data/_processed directory")
    backup = DATA / ("_backup-" + stage.name.removeprefix("_rebuild-"))
    if backup.exists():
        raise FileExistsError(backup)
    print(f"Rollback backup: {backup}\nReplacement: {stage}", flush=True)
    try:
        services.stop()
        preserve_shares(ACTIVE, stage)
        if ACTIVE.exists():
            ACTIVE.rename(backup)
        stage.rename(ACTIVE)
        services.start()
        services.check(expected)
    except BaseException as error:
        try:
            # Inspect actual paths: an interrupt can arrive just after rename.
            if backup.exists():
                services.stop()
                if ACTIVE.exists():
                    if stage.exists():
                        raise RuntimeError("Both active and staged directories exist; refusing to overwrite either")
                    ACTIVE.rename(stage)
                backup.rename(ACTIVE)
            elif not stage.exists() and ACTIVE.exists():
                services.stop()
                ACTIVE.rename(stage)
            services.start()
            services.check()
        except BaseException as rollback_error:
            raise RuntimeError(
                f"Automatic rollback could not finish. Files retained at {backup}, {stage}, and {ACTIVE}; "
                f"keep the website stopped and restore the backup. Rollback error: {rollback_error}"
            ) from error
        raise
    print(f"Dataset active at {ACTIVE}." + (f" Previous dataset retained at {backup}" if backup.exists() else ""), flush=True)
    return backup


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", type=Path, help="CSV files/folders to scan recursively; defaults to data/_csvs")
    parser.add_argument("--rebuild", action="store_true", help="Replace the entire dataset using only these inputs; otherwise preserve unrelated collections")
    parser.add_argument("--check-only", action="store_true", help="Build and validate without changing the active dataset or stopping the website")
    parser.add_argument("--date", type=parse_date, help="Export date YYYYMMDD[-HHMM]; otherwise use dated parent folders or file modification times")
    parser.add_argument("--force", action="store_true", help="Rewrite matching partitions even if their contents are unchanged")
    parser.add_argument("--allow-empty", action="store_true", help="Allow a full rebuild containing zero accepted measurements")
    parser.add_argument("--service", action="append", help="Website systemd user service; repeat for every instance when using non-default names")
    parser.add_argument("--delete-database", metavar="NAME", help="Preview deletion of one database (separate from importing)")
    parser.add_argument("--yes", action="store_true", help="Confirm --delete-database")
    args = parser.parse_args()
    if args.delete_database:
        if args.paths or args.rebuild or args.check_only or args.date or args.force or args.allow_empty or args.service:
            parser.error("--delete-database cannot be combined with import options")
        with import_lock():
            plan = database_deletion_plan(args.delete_database)
            print_database_deletion_plan(args.delete_database, *plan)
            if args.yes:
                delete_database(args.delete_database)
            else:
                print("No files were deleted. Re-run with --yes to confirm.")
        return 0
    if args.yes:
        parser.error("--yes is only for --delete-database")
    if args.allow_empty and not args.rebuild:
        parser.error("--allow-empty is only for --rebuild")
    with import_lock():
        inputs, superseded = discover_inputs(args.paths, rebuild=args.rebuild, date=args.date)
        if not args.check_only:
            WebsiteServices(args.service or DEFAULT_SERVICES)  # Preflight before building.
        stage = Path(tempfile.mkdtemp(prefix="_rebuild-", dir=DATA))
        print(f"Building in {stage}; live dataset is unchanged.", flush=True)
        try:
            files = build_dataset(stage, inputs, rebuild=args.rebuild, force=args.force, date=args.date)
            summary = validate_dataset(stage)
            report = {"mode": "rebuild" if args.rebuild else "import", "files": files,
                      "superseded_exports": superseded, "validated": summary}
            (stage / "import-report.json").write_text(json.dumps(report, indent=2) + "\n")
            print(f"Validated {summary['partitions']} partitions / {summary['rows']:,} measurements.")
            if args.rebuild and not summary["rows"] and not args.allow_empty:
                raise ValueError("No accepted measurements. Review the report; use --allow-empty only if intentional.")
            if args.check_only:
                print("Check-only: website and current data were not changed.")
            elif not args.rebuild and not any(file["accepted_rows"] for file in files):
                print("No accepted rows; existing dataset left unchanged.")
            else:
                services = WebsiteServices(args.service or DEFAULT_SERVICES)
                activate_dataset(stage, services, summary)
        except BaseException:
            print(f"Import did not finish; diagnostic files retained at {stage}", file=sys.stderr)
            raise
    return 0


if __name__ == "__main__":
    def terminate(_signum, _frame):
        raise KeyboardInterrupt("Import terminated")
    signal.signal(signal.SIGTERM, terminate)
    raise SystemExit(main())
