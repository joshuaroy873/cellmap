"""Regression tests use isolated synthetic datasets; never touch live data/services."""

import csv
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import duckdb

REPO = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(REPO / "scripts"), str(REPO / "website"), str(REPO)]
import import_csvs as importer
import server
from cellmap_schema import COMMON_COLUMNS, DERIVED_COLUMNS, MEASUREMENT_SCHEMAS
from import_csvs import initialize


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cellmap-rebuild-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / "data"
        self.active = self.data / "_processed"
        self.active.mkdir(parents=True)
        self.stage = self.data / "_rebuild-test"
        self.stage.mkdir()
        for module, values in [
            (importer, {"ROOT": self.root, "DATA": self.data, "ACTIVE": self.active}),
            (importer, {"ROOT": self.root, "DATA": self.data, "OUTPUT": self.active / "measurements", "DB_PATH": self.active / "cellular.duckdb"}),
        ]:
            patches = patch.multiple(module, **values)
            patches.start()
            self.addCleanup(patches.stop)
        with duckdb.connect(str(self.active / "cellular.duckdb")) as con:
            initialize(con)
            con.execute("INSERT INTO shared_views(id,state_json) VALUES ('old_legacy_share_123', '{\"version\":1}')")
        (self.active / "original.txt").write_text("old dataset")

    def csv(self, kind="lte_pdsch", date="20260918", rows=None, database="example"):
        path = self.data / "_csvs" / database / date / f"{kind}.csv"
        path.parent.mkdir(parents=True, exist_ok=True)
        values = {}
        for name, dtype, aliases in COMMON_COLUMNS + MEASUREMENT_SCHEMAS[kind]:
            if name not in DERIVED_COLUMNS.get(kind, {}):
                values[aliases[0]] = {
                    "measured_at": "2026-09-18 10:00:00.125",
                    "database_name": database, "collection_name": "sample",
                }.get(name, "example" if dtype == "VARCHAR" else "1")
        values.update(test_name="Capacity", direction="Downlink", test_status="Completed")
        with path.open("w", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(values))
            writer.writeheader()
            for row in [{}] if rows is None else rows:
                writer.writerow({**values, **row})
        return path

    def build(self, inputs=None):
        reports = importer.build_dataset(self.stage, inputs or [(self.csv(), "lte_pdsch")])
        summary = importer.validate_dataset(self.stage)
        return reports, summary

    def test_all_eight_types_filter_and_validate(self):
        import itertools
        cases = [dict(test_name=name, direction=direction, test_status=status)
                 for name, direction, status in itertools.product(
                     ["Capacity", "Capacity HTTP/FTP", "Ookla(R)", "Browsing", ""],
                     ["Downlink", "Uplink", "Mixed", "Unknown", ""],
                     ["Completed", "Failed", "System Release", "Unknown", ""])]
        inputs = [(self.csv(kind, rows=cases), kind) for kind in MEASUREMENT_SCHEMAS]
        reports, summary = self.build(inputs)
        self.assertEqual(summary["partitions"], 8)
        for report in reports:
            throughput = report["type"].endswith(("_pdsch", "_pusch"))
            self.assertEqual(report["raw_rows"], 125)
            self.assertEqual(report["accepted_rows"], 2 if throughput else 125)
            path = importer.partition_path("example", "sample", report["type"], self.stage / "measurements")
            self.assertTrue(path.exists())

    def test_throughput_rejects_opposite_direction(self):
        for kind in ["lte_pdsch", "nr_pdsch", "lte_pusch", "nr_pusch"]:
            wrong = "Uplink" if kind.endswith("pdsch") else "Downlink"
            path = self.csv(kind, rows=[{"direction": wrong}])
            with duckdb.connect(":memory:") as con:
                query = importer.canonical_select(con, path, kind)
                self.assertEqual(con.execute(f"SELECT count(*) FROM ({query})").fetchone()[0], 0)

    def test_latest_empty_export_does_not_revive_old_measurements(self):
        self.csv(date="20260917")
        latest = self.csv(rows=[])
        inputs, superseded = importer.discover_inputs([], rebuild=True)
        self.assertEqual(inputs, [(latest, "lte_pdsch")])
        self.assertEqual(len(superseded), 1)
        reports, summary = self.build(inputs)
        self.assertTrue(reports[0]["empty_csv"])
        self.assertEqual(summary["rows"], 0)
        self.assertTrue((self.active / "original.txt").exists())

    def test_filtered_out_is_not_reported_as_empty_csv(self):
        path = self.csv(rows=[{"test_name": "Ookla(R)", "direction": "Mixed"}])
        reports, summary = self.build([(path, "lte_pdsch")])
        self.assertFalse(reports[0]["empty_csv"])
        self.assertEqual(reports[0]["excluded_by_rules"], 1)
        self.assertEqual(summary["rows"], 0)

    def test_invalid_excluded_rows_block_build(self):
        time_column = next(aliases[0] for name, _, aliases in COMMON_COLUMNS if name == "measured_at")
        path = self.csv(rows=[{time_column: "bad time", "test_name": "Ookla(R)"}])
        with self.assertRaisesRegex(ValueError, "lack time"):
            self.build([(path, "lte_pdsch")])
        self.assertTrue((self.active / "original.txt").exists())

    def test_database_must_match_archive_directory(self):
        column = next(aliases[0] for name, _, aliases in COMMON_COLUMNS if name == "database_name")
        with self.assertRaisesRegex(ValueError, "archive directory"):
            self.build([(self.csv(rows=[{column: "another"}]), "lte_pdsch")])

    def test_unknown_csv_is_not_silently_skipped(self):
        path = self.csv()
        path.rename(path.with_name("unrecognized.csv"))
        with self.assertRaisesRegex(ValueError, "Unknown CSV"):
            importer.discover_inputs([], rebuild=True)

    def test_duplicate_same_date_alias_rejected(self):
        path = self.csv("lte_radio_neighbor")
        path.with_name("lte_radio_neig.csv").write_bytes(path.read_bytes())
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            importer.discover_inputs([], rebuild=True)

    def test_validation_catches_count_mismatch(self):
        self.build()
        with duckdb.connect(str(self.stage / "cellular.duckdb")) as con:
            con.execute("UPDATE measurement_partitions SET row_count=999")
        with self.assertRaisesRegex(ValueError, "do not match"):
            importer.validate_dataset(self.stage)

    def test_validation_catches_missing_parquet(self):
        self.build()
        next((self.stage / "measurements").rglob("*.parquet")).unlink()
        with self.assertRaisesRegex(ValueError, "Missing or unsafe"):
            importer.validate_dataset(self.stage)

    def test_validation_catches_corrupt_parquet(self):
        self.build()
        next((self.stage / "measurements").rglob("*.parquet")).write_bytes(b"broken")
        with self.assertRaises(duckdb.Error):
            importer.validate_dataset(self.stage)

    def test_successful_swap_preserves_both_share_stores(self):
        _, summary = self.build()
        with sqlite3.connect(self.active / "shared_views.sqlite3") as con:
            con.execute("CREATE TABLE shared_views(id TEXT PRIMARY KEY, state_json TEXT, created_at TEXT)")
            con.execute("INSERT INTO shared_views VALUES('existing_sqlite_share_123', '{}', '2026-09-18')")
        services = Mock()
        backup = importer.activate_dataset(self.stage, services, summary)
        self.assertTrue((backup / "original.txt").exists())
        self.assertFalse((self.active / "original.txt").exists())
        services.check.assert_called_once_with(summary)
        with duckdb.connect(str(self.active / "cellular.duckdb"), read_only=True) as con:
            self.assertEqual(con.execute("SELECT count(*) FROM shared_views").fetchone()[0], 1)
        with sqlite3.connect(self.data / "shared_views.sqlite3") as con:
            self.assertEqual(con.execute("SELECT id FROM shared_views").fetchone()[0], "existing_sqlite_share_123")
        with patch.multiple(server, ROOT=self.root, DB_PATH=self.active / "cellular.duckdb",
                            MEASUREMENTS=self.active / "measurements", SHARE_DB_PATH=self.data / "shared_views.sqlite3"):
            self.assertEqual(server.shared_view_payload("old_legacy_share_123")["state"], {"version": 1})
            self.assertEqual(server.shared_view_payload("existing_sqlite_share_123")["state"], {})
            catalog = server.catalog_payload()
            self.assertEqual(catalog["databases"][0]["name"], "example")
            payload = server.measurement_payload({
                "database": ["example"], "collection": ["sample"],
                "measurement": ["pdsch"], "metric": ["throughput_mbps"],
            })
            self.assertEqual(payload["summary"]["count"], 1)

    def test_health_failure_restores_original(self):
        _, summary = self.build()
        services = Mock()
        services.check.side_effect = [RuntimeError("health failed"), None]
        with self.assertRaisesRegex(RuntimeError, "health failed"):
            importer.activate_dataset(self.stage, services, summary)
        self.assertEqual((self.active / "original.txt").read_text(), "old dataset")
        self.assertTrue((self.stage / "cellular.duckdb").exists())
        self.assertEqual(services.start.call_count, 2)

    def test_restart_failure_restores_original(self):
        _, summary = self.build()
        services = Mock()
        services.start.side_effect = [RuntimeError("restart failed"), None]
        with self.assertRaisesRegex(RuntimeError, "restart failed"):
            importer.activate_dataset(self.stage, services, summary)
        self.assertTrue((self.active / "original.txt").exists())

    def test_second_rename_failure_restores_original(self):
        _, summary = self.build()
        rename = Path.rename
        def fail_stage(path, target):
            if path == self.stage:
                raise OSError("rename failed")
            return rename(path, target)
        with patch.object(Path, "rename", fail_stage):
            with self.assertRaisesRegex(OSError, "rename failed"):
                importer.activate_dataset(self.stage, Mock(), summary)
        self.assertTrue((self.active / "original.txt").exists())
        self.assertTrue((self.stage / "cellular.duckdb").exists())

    def test_stop_failure_leaves_folders_untouched(self):
        _, summary = self.build()
        services = Mock()
        services.stop.side_effect = RuntimeError("stop failed")
        with self.assertRaisesRegex(RuntimeError, "stop failed"):
            importer.activate_dataset(self.stage, services, summary)
        self.assertTrue((self.active / "original.txt").exists())
        self.assertTrue((self.stage / "cellular.duckdb").exists())

    def test_cli_build_only_never_manages_services(self):
        self.csv()
        with patch.object(sys, "argv", ["import_csvs.py", "--rebuild", "--check-only"]), patch.object(importer, "WebsiteServices") as services:
            self.assertEqual(importer.main(), 0)
            services.assert_not_called()
        self.assertTrue((self.active / "original.txt").exists())

    def test_cli_blocks_accidental_empty_dataset(self):
        self.csv(rows=[])
        with patch.object(sys, "argv", ["import_csvs.py", "--rebuild", "--check-only"]):
            with self.assertRaisesRegex(ValueError, "No accepted measurements"):
                importer.main()

    def test_lock_rejects_concurrent_import(self):
        with importer.import_lock():
            with self.assertRaisesRegex(RuntimeError, "already running"):
                with importer.import_lock():
                    self.fail("Acquired the lock twice")

    def test_share_migration_is_idempotent(self):
        old = self.active / "shared_views.sqlite3"
        new = self.data / "shared_views.sqlite3"
        server.initialize_share_store(old, self.data / "absent.sqlite3")
        with sqlite3.connect(old) as con:
            con.execute("INSERT INTO shared_views(id,state_json) VALUES('existing', '{}')")
        server.initialize_share_store(new, old)
        server.initialize_share_store(new, old)
        with sqlite3.connect(new) as con:
            self.assertEqual(con.execute("SELECT count(*) FROM shared_views").fetchone()[0], 1)
        self.assertTrue(old.exists())

    def test_share_conflict_does_not_overwrite_existing_link(self):
        old = self.active / "shared_views.sqlite3"
        new = self.data / "shared_views.sqlite3"
        for path, state in [(old, '{"old":1}'), (new, '{"new":1}')]:
            server.initialize_share_store(path, self.data / "absent.sqlite3")
            with sqlite3.connect(path) as con:
                con.execute("INSERT INTO shared_views(id,state_json) VALUES('same_id', ?)", [state])
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            server.initialize_share_store(new, old)
        with sqlite3.connect(new) as con:
            self.assertEqual(con.execute("SELECT state_json FROM shared_views").fetchone()[0], '{"new":1}')

    def test_interrupt_just_after_first_rename_rolls_back(self):
        _, summary = self.build()
        rename = Path.rename
        interrupted = False
        def interrupt(path, target):
            nonlocal interrupted
            result = rename(path, target)
            if path == self.active and not interrupted:
                interrupted = True
                raise KeyboardInterrupt()
            return result
        with patch.object(Path, "rename", interrupt):
            with self.assertRaises(KeyboardInterrupt):
                importer.activate_dataset(self.stage, Mock(), summary)
        self.assertTrue((self.active / "original.txt").exists())

    def test_repeated_import_does_not_duplicate_rows(self):
        path = self.csv()
        importer.build_dataset(self.active, [(path, "lte_pdsch")])
        original = importer.partition_path("example", "sample", "lte_pdsch")
        original_bytes = original.read_bytes()
        # Existing catalogs may still contain fingerprints from the old importer.
        with duckdb.connect(str(self.active / "cellular.duckdb")) as con:
            con.execute("UPDATE measurement_partitions SET content_hash='legacy-fingerprint'")
        with patch.object(importer, "write_partition", wraps=importer.write_partition) as write:
            importer.build_dataset(self.stage, [(path, "lte_pdsch")], rebuild=False)
            write.assert_called_once()
        replacement = importer.partition_path("example", "sample", "lte_pdsch", self.stage / "measurements")
        self.assertNotEqual(original.stat().st_ino, replacement.stat().st_ino)
        self.assertEqual(original.read_bytes(), original_bytes)
        self.assertEqual(importer.validate_dataset(self.stage)["rows"], 1)
        with duckdb.connect(str(self.stage / "cellular.duckdb"), read_only=True) as con:
            stored, count = con.execute("SELECT parquet_path,row_count FROM measurement_partitions").fetchone()
            self.assertTrue((self.root / stored).is_file())
            self.assertEqual(count, 1)
            self.assertEqual(con.execute("SELECT content_hash FROM measurement_partitions").fetchone()[0], "")

    def test_source_change_during_import_is_rejected(self):
        with patch.object(importer, "file_hash", side_effect=["before", "after"]):
            with self.assertRaisesRegex(ValueError, "CSV changed during the import"):
                importer.build_dataset(self.stage, [(self.csv(), "lte_pdsch")])

    def test_normal_import_preserves_unrelated_collections_and_old_files(self):
        collection_column = next(aliases[0] for name, _, aliases in COMMON_COLUMNS if name == "collection_name")
        metric_column = next(aliases[0] for name, _, aliases in MEASUREMENT_SCHEMAS["lte_pdsch"] if name == "throughput_mbps")
        old = self.csv(rows=[{}, {collection_column: "untouched"}])
        importer.build_dataset(self.active, [(old, "lte_pdsch")])
        original = importer.partition_path("example", "sample", "lte_pdsch")
        original_bytes = original.read_bytes()
        incoming = self.csv(date="20260919", rows=[{metric_column: "2000"}])
        importer.build_dataset(self.stage, [(incoming, "lte_pdsch")], rebuild=False)
        self.assertEqual(importer.validate_dataset(self.stage)["partitions"], 2)
        self.assertEqual(original.read_bytes(), original_bytes)
        changed = importer.partition_path("example", "sample", "lte_pdsch", self.stage / "measurements")
        self.assertNotEqual(changed.read_bytes(), original_bytes)
        unchanged = importer.partition_path("example", "untouched", "lte_pdsch")
        linked = importer.partition_path("example", "untouched", "lte_pdsch", self.stage / "measurements")
        self.assertEqual(unchanged.stat().st_ino, linked.stat().st_ino)

    def test_normal_empty_import_preserves_existing_measurements(self):
        old = self.csv()
        importer.build_dataset(self.active, [(old, "lte_pdsch")])
        empty = self.csv(date="20260919", rows=[])
        reports = importer.build_dataset(self.stage, [(empty, "lte_pdsch")], rebuild=False)
        self.assertEqual(importer.validate_dataset(self.stage)["rows"], 1)
        self.assertIn("preserved", reports[0]["note"])

    def test_normal_import_keeps_partitions_from_previous_filter_version(self):
        old = self.csv()
        importer.build_dataset(self.active, [(old, "lte_pdsch")])
        with duckdb.connect(str(self.active / "cellular.duckdb")) as con:
            con.execute("UPDATE measurement_partitions SET schema_version=2")
        incoming = self.csv(database="another")
        importer.build_dataset(self.stage, [(incoming, "lte_pdsch")], rebuild=False)
        self.assertEqual(importer.validate_dataset(self.stage)["partitions"], 2)

    def test_older_input_cannot_overwrite_newer_active_partition(self):
        newest = self.csv(date="20260920", rows=[{}, {}])
        importer.build_dataset(self.active, [(newest, "lte_pdsch")])
        older = self.csv(date="20260919")
        importer.build_dataset(self.stage, [(older, "lte_pdsch")], rebuild=False)
        self.assertEqual(importer.validate_dataset(self.stage)["rows"], 2)

    def test_deletion_plan_includes_external_source_audit_records(self):
        with tempfile.TemporaryDirectory(prefix="cellmap-incoming-") as folder:
            external = Path(folder) / "lte_pdsch.csv"
            external.write_bytes(self.csv().read_bytes())
            importer.build_dataset(self.active, [(external, "lte_pdsch")])
            plan = importer.database_deletion_plan("example")
            self.assertEqual(len(plan[-1]), 1)
            self.assertTrue(external.exists())

    def test_first_import_without_existing_dataset(self):
        path = self.csv()
        empty_location = self.data / "existing-fixture"
        self.active.rename(empty_location)
        importer.build_dataset(self.stage, [(path, "lte_pdsch")], rebuild=False)
        summary = importer.validate_dataset(self.stage)
        importer.activate_dataset(self.stage, Mock(), summary)
        self.assertEqual(importer.validate_dataset(self.active)["rows"], 1)

    def test_seed_rejects_catalog_path_traversal(self):
        path = self.csv()
        importer.build_dataset(self.active, [(path, "lte_pdsch")])
        with duckdb.connect(str(self.active / "cellular.duckdb")) as con:
            con.execute("UPDATE measurement_partitions SET parquet_path=replace(parquet_path, 'data/_processed/', 'data/_processed/../_processed/')")
        with self.assertRaisesRegex(ValueError, "Unsafe existing"):
            importer.seed_dataset(self.stage)

    def test_external_nested_folder_and_export_filename_alias(self):
        with tempfile.TemporaryDirectory(prefix="cellmap-incoming-") as folder:
            incoming = Path(folder) / "nested" / "LTE PDSCH [per-carrier].CSV"
            incoming.parent.mkdir()
            incoming.write_bytes(self.csv().read_bytes())
            inputs, _ = importer.discover_inputs([Path(folder)])
            self.assertEqual(inputs, [(incoming, "lte_pdsch")])
            importer.build_dataset(self.stage, inputs, rebuild=False)
            self.assertEqual(importer.validate_dataset(self.stage)["rows"], 1)
            self.assertTrue(incoming.exists())

    def test_normal_import_cli_without_extra_flags(self):
        self.csv()
        with patch.object(sys, "argv", ["import_csvs.py", str(self.data / "_csvs")]), \
             patch.object(importer, "WebsiteServices") as services:
            self.assertEqual(importer.main(), 0)
            services.return_value.stop.assert_called_once()
            services.return_value.check.assert_called_once()
        self.assertEqual(importer.validate_dataset(self.active)["rows"], 1)

    def test_no_active_service_allows_offline_import(self):
        with patch.object(importer.subprocess, "run", return_value=Mock(stdout="ActiveState=inactive\nMainPID=0\n")), \
             patch.object(Path, "iterdir", return_value=iter([])):
            services = importer.WebsiteServices(["example.service"])
            self.assertEqual(services.services, [])

    def test_persistent_service_restart_uses_systemctl(self):
        services = object.__new__(importer.WebsiteServices)
        services.services = [("example.service", ["python", "website/server.py"], False, 123)]
        with patch.object(importer.subprocess, "run", return_value=Mock(returncode=3)) as run:
            services.start()
        self.assertEqual(run.call_args.args[0], ["systemctl", "--user", "start", "example.service"])

    def test_transient_service_restart_preserves_command(self):
        services = object.__new__(importer.WebsiteServices)
        command = ["/custom/python", "website/server.py", "--host", "127.0.0.1", "--port", "8123"]
        services.services = [("example.service", command, True, 123)]
        with patch.object(importer.subprocess, "run", return_value=Mock(returncode=3)) as run:
            services.start()
        call = run.call_args.args[0]
        self.assertEqual(call[:3], ["systemd-run", "--user", "--unit=example.service"])
        self.assertEqual(call[-len(command):], command)


if __name__ == "__main__":
    unittest.main()
