#!/usr/bin/env python3
"""Move CSVs from data/_temp into an export folder, then import them."""

from __future__ import annotations

import argparse
import csv
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from import_csvs import FILE_TYPES, ROOT, file_hash, token


DATA = ROOT / "data"
TEMP = DATA / "_temp"
DATE_PATTERN = re.compile(r"^\d{8}(-\d{4})?$")
CSV_NAME_ALIASES = {
    "ltepdschpercarrier": "lte_pdsch",
    "ltepuschpercarrier": "lte_pusch",
    "lteradioneig": "lte_radio_neig",
    "lteradioconnected": "lte_radio",
    "nrpdschpercarrier": "nr_pdsch",
    "nrpuschpercarrier": "nr_pusch",
    "nrradiobeam": "nr_radio_neig",
    "nrradioconnected": "nr_radio",
}


def valid_export_date(value: str) -> str:
    if not DATE_PATTERN.match(value):
        raise argparse.ArgumentTypeError("use YYYYMMDD or YYYYMMDD-HHMM")
    for pattern in ("%Y%m%d", "%Y%m%d-%H%M"):
        try:
            datetime.strptime(value, pattern)
            return value
        except ValueError:
            pass
    raise argparse.ArgumentTypeError("invalid export date")


def database_name(path: Path) -> str:
    with path.open("r", encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        if not reader.fieldnames:
            raise ValueError(f"{path}: missing CSV header")
        database_column = next(
            (name for name in reader.fieldnames if token(name) == "database"),
            None,
        )
        if database_column is None:
            raise ValueError(f"{path}: missing Database column")
        for row in reader:
            database = (row.get(database_column) or "").strip()
            if database:
                return database
    raise ValueError(f"{path}: no database value found")


def canonical_stem(path: Path) -> str:
    stem = path.stem.lower()
    if stem in FILE_TYPES:
        return stem
    alias = CSV_NAME_ALIASES.get(token(path.stem))
    if alias is not None:
        return alias
    raise ValueError(f"{path}: unknown CSV filename")


def stage_file(path: Path, export_date: str, force: bool) -> Path:
    stem = canonical_stem(path)
    kind = FILE_TYPES[stem]

    database = database_name(path)
    target = DATA / "_csvs" / database / export_date / f"{stem}.csv"
    target.parent.mkdir(parents=True, exist_ok=True)

    if target.exists():
        if file_hash(path) == file_hash(target):
            path.unlink()
            print(
                f"SKIP identical [{export_date}]: {target.relative_to(ROOT)}"
            )
            return target
        if not force:
            raise FileExistsError(
                f"{target.relative_to(ROOT)} exists with different contents; "
                "rerun with --force to replace it"
            )

    path.replace(target)
    suffix = "" if path.name == target.name else f" (renamed from {path.name})"
    print(f"STAGE {kind}: {target.relative_to(ROOT)}{suffix}")
    return target


def run_import(paths: list[Path], force: bool) -> None:
    command = [sys.executable, str(ROOT / "scripts/import_csvs.py")]
    if force:
        command.append("--force")
    command.extend(str(folder) for folder in sorted({path.parent for path in paths}))
    subprocess.run(command, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--date",
        type=valid_export_date,
        default=datetime.now().strftime("%Y%m%d"),
        help="export folder date, YYYYMMDD or YYYYMMDD-HHMM; default: today",
    )
    parser.add_argument(
        "--temp-dir",
        type=Path,
        default=TEMP,
        help="staging folder; default: data/_temp",
    )
    parser.add_argument(
        "--no-import",
        action="store_true",
        help="stage files only; do not run scripts/import_csvs.py",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="replace existing CSVs and force the subsequent import",
    )
    args = parser.parse_args()

    temp_dir = args.temp_dir.resolve()
    temp_dir.mkdir(parents=True, exist_ok=True)
    csvs = sorted(path for path in temp_dir.glob("*.csv") if path.is_file())
    if not csvs:
        print(f"No CSVs found in {temp_dir.relative_to(ROOT)}")
        return 0

    staged = [stage_file(path, args.date, args.force) for path in csvs]
    if not args.no_import:
        run_import(staged, args.force)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
