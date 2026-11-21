"""Mocked safety tests for the setup.py update workflow (no Docker/database required)."""
from __future__ import annotations

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("dreamedia_setup", ROOT / "setup.py")
setup = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(setup)


class UpdateWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.events: list[tuple] = []
        self.dump = Path("/tmp/dreamedia-update-test.dump")
        self.env = {"DREAMEDIA_PG_PASSWORD": "test-only"}

    def fake_run(self, command, **kwargs):
        self.events.append(("command", tuple(command)))
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    def test_dirty_worktree_is_rejected_before_any_git_pull(self) -> None:
        status = subprocess.CompletedProcess(
            ["git", "status"], 0, stdout=" M setup.py\n", stderr=""
        )
        with patch.object(setup, "run", return_value=status) as mocked_run:
            with self.assertRaises(SystemExit):
                setup.require_clean_git_worktree()
        mocked_run.assert_called_once_with(
            ["git", "status", "--porcelain", "--untracked-files=all"],
            cwd=setup.ROOT, check=False,
        )

    def test_pull_is_fast_forward_only(self) -> None:
        completed = subprocess.CompletedProcess(
            ["git", "pull"], 0, stdout="Already up to date.\n", stderr=""
        )
        with patch.object(setup, "run", return_value=completed) as mocked_run:
            setup.pull_git_changes()
        mocked_run.assert_called_once_with(
            ["git", "pull", "--ff-only"], cwd=setup.ROOT, check=False
        )

    def test_backup_pull_restart_and_restore_order_preserves_volume(self) -> None:
        self.events = []
        with (
            patch.object(setup, "require_clean_git_worktree", side_effect=lambda: self.events.append(("clean",))),
            patch.object(setup, "running_compose_services", side_effect=lambda _env: (self.events.append(("services",)) or {"db", "backend", "frontend"})),
            patch.object(setup, "run", side_effect=self.fake_run),
            patch.object(setup, "backup", side_effect=lambda *_args: (self.events.append(("backup",)) or self.dump)),
            patch.object(setup, "pull_git_changes", side_effect=lambda: self.events.append(("pull",))),
            patch.object(setup, "build_extensions", side_effect=lambda: self.events.append(("build",))),
            patch.object(setup, "db_running", return_value=True),
            patch.object(setup, "restore_database_backup", side_effect=lambda *_args: self.events.append(("restore",))),
        ):
            result = setup.update_database(Path("/tmp/backups"), 5, self.env)

        self.assertEqual(result, self.dump)
        labels = [event[0] for event in self.events]
        self.assertLess(labels.index("clean"), labels.index("backup"))
        self.assertLess(labels.index("backup"), labels.index("pull"))
        self.assertLess(labels.index("pull"), labels.index("build"))
        self.assertLess(labels.index("build"), labels.index("restore"))
        down = next(event[1] for event in self.events if len(event) > 1 and event[0] == "command" and event[1][:3] == ("docker", "compose", "down"))
        self.assertNotIn("-v", down, "update must preserve the pgdata volume")
        self.assertLess(labels.index("pull"), next(i for i, event in enumerate(self.events) if event[0] == "command" and event[1][:3] == ("docker", "compose", "down")))
        self.assertLess(next(i for i, event in enumerate(self.events) if event[0] == "command" and event[1][:4] == ("docker", "compose", "up", "-d")), labels.index("restore"))

    def test_backup_failure_does_not_pull_or_restart_database(self) -> None:
        self.events = []
        with (
            patch.object(setup, "require_clean_git_worktree"),
            patch.object(setup, "running_compose_services", return_value={"backend"}),
            patch.object(setup, "run", side_effect=self.fake_run),
            patch.object(setup, "backup", side_effect=SystemExit("backup failed")),
            patch.object(setup, "pull_git_changes", side_effect=lambda: self.events.append(("pull",))),
        ):
            with self.assertRaises(SystemExit):
                setup.update_database(Path("/tmp/backups"), 5, self.env)

        labels = [event[0] for event in self.events]
        self.assertNotIn("pull", labels)
        self.assertFalse(any(event[0] == "command" and event[1][:3] == ("docker", "compose", "down") for event in self.events))
        self.assertTrue(any(event[0] == "command" and event[1][:4] == ("docker", "compose", "start", "backend") for event in self.events))

    def test_git_pull_failure_leaves_database_untouched_and_restarts_services(self) -> None:
        self.events = []
        with (
            patch.object(setup, "require_clean_git_worktree"),
            patch.object(setup, "running_compose_services", return_value={"backend"}),
            patch.object(setup, "run", side_effect=self.fake_run),
            patch.object(setup, "backup", return_value=self.dump),
            patch.object(setup, "pull_git_changes", side_effect=SystemExit("pull failed")),
        ):
            with self.assertRaises(SystemExit):
                setup.update_database(Path("/tmp/backups"), 5, self.env)

        self.assertFalse(any(event[0] == "command" and event[1][:3] == ("docker", "compose", "down") for event in self.events))
        self.assertTrue(any(event[0] == "command" and event[1][:4] == ("docker", "compose", "start", "backend") for event in self.events))

    def test_restore_failure_keeps_the_verified_dump_and_reports_it(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dump = Path(tmp) / "verified.dump"
            dump.write_bytes(b"test pg_dump archive")
            observed = {}

            def fail_restore(command, **kwargs):
                observed["command"] = command
                observed["stdin"] = kwargs["stdin"].read()
                return subprocess.CompletedProcess(command, 1, stdout=b"", stderr=b"restore error")

            with patch.object(setup.subprocess, "run", side_effect=fail_restore):
                with self.assertRaises(SystemExit) as raised:
                    setup.restore_database_backup(dump, self.env)

            self.assertIn(str(dump), str(raised.exception))
            self.assertTrue(dump.is_file())
            self.assertEqual(observed["stdin"], b"test pg_dump archive")
            command = observed["command"]
            self.assertIn("--clean", command)
            self.assertIn("--if-exists", command)
            self.assertIn("--exit-on-error", command)
            self.assertIn("-T", command)


if __name__ == "__main__":
    unittest.main()
