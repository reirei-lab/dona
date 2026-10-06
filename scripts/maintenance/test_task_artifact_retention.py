"""private SQLite/temp rootのみを使うfault test。production接続はしない。"""
import datetime as dt
import hashlib
import json
import os
import pathlib
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from task_artifact_retention import Retention, Protected, Policy

JOB = "job_01m48pn0e7hkz6jy1xz6rmfeat"
OLD = "2026-09-01T00:00:00Z"
NOW = dt.datetime(2026, 10, 6, tzinfo=dt.timezone.utc).timestamp()
HAS_BIRTH = hasattr(os.stat(__file__), "st_birthtime")


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name).resolve()
        self.workspace = self.root / "workspaces"
        self.results = self.root / "results"
        self.workspace.mkdir(mode=0o700)
        self.results.mkdir(mode=0o700)
        self.database = self.root / "private.db"
        self.db = sqlite3.connect(self.database)
        self.db.executescript("""
          CREATE TABLE jobs(job_id TEXT PRIMARY KEY,source_event_id TEXT,status TEXT,
            completed_at TEXT,created_at TEXT,workspace_json TEXT,workspace_path TEXT,
            result_path TEXT,agent_name TEXT,steer_state TEXT,result_json TEXT,completion_event_id TEXT,source TEXT DEFAULT 'slack');
          CREATE TABLE tasks(task_id TEXT PRIMARY KEY,state TEXT,current_attempt_id TEXT,
            wait_reason TEXT,steer_pending_event_id TEXT);
          CREATE TABLE task_attempts(attempt_id TEXT PRIMARY KEY,task_id TEXT,stop_receipt_json TEXT,checkpoint_json TEXT);
          CREATE TABLE job_completion_results(job_id TEXT,job_status TEXT,destination_json TEXT,
            notification_state TEXT,content_delete_at TEXT,notification_event_id TEXT);
          CREATE TABLE job_groups(source_event_id TEXT,notification_mode TEXT,sealed_at TEXT,all_terminal_event_id TEXT);
          CREATE TABLE events(event_id TEXT PRIMARY KEY,status TEXT,completed_at TEXT DEFAULT '2026-09-01T00:00:00Z');
          CREATE TABLE job_owner_bindings(job_id TEXT PRIMARY KEY,source_event_id TEXT,owner_json TEXT,destination_json TEXT);
        """)
        self.engine = Retention(self.db, str(self.workspace), str(self.results), Policy(7, 0))
        self.engine.install()
        self.add_job(JOB)

    def tearDown(self):
        self.db.close()
        self.temporary.cleanup()

    def add_job(self, job):
        task = "task-" + job
        work = self.workspace / "scratch" / job
        progress = self.workspace / "scratch" / ".dona-progress" / job
        result = self.results / job
        for item in (work, progress, result):
            item.mkdir(parents=True, mode=0o700)
            (item / "data.json").write_text("kept evidence")
        report = "report-" + job
        self.db.execute("INSERT INTO jobs(job_id,source_event_id,status,completed_at,created_at,workspace_json,workspace_path,result_path,agent_name,steer_state,result_json,completion_event_id) VALUES(?,?,'completed',?,?,?, ?,?,?,NULL,?,?)",
                        (job, "event-" + job, OLD, OLD, json.dumps({"kind": "scratch"}), str(work),
                         str(result / "result.json"), job, '{"summary":"saved"}', report))
        self.db.execute("INSERT INTO tasks VALUES(?,'completed',?,NULL,NULL)", (task, job))
        self.db.execute("INSERT INTO task_attempts VALUES(?,?,?,?)", (job, task,
            json.dumps({"state": "stopped", "reason": "app_server_verified_empty_scope", "observed_at": OLD}), "{}"))
        owner = json.dumps({"kind": "slack_thread", "workspace_id": "fixture", "channel_id": "fixture", "thread_ts": "1.000001"})
        self.db.execute("INSERT INTO job_owner_bindings VALUES(?,?,?,?)", (job, "event-" + job, owner, owner))
        self.db.execute("INSERT INTO events(event_id,status) VALUES(?,'completed')", (report,))
        self.db.execute("INSERT INTO job_completion_results VALUES(?,'completed',?,'accepted',?,?)",
                        (job, owner, OLD, report))
        self.db.commit()
        return work

    def tomb(self, kind="worktree", job=JOB):
        parent = self.results if kind == "result" else self.workspace / "scratch"
        return parent / (".retention-" + hashlib.sha256((job + ":" + kind).encode()).hexdigest())

    def test_dry_run_measures_without_purge(self):
        inventory = self.engine.batch(NOW)
        self.assertTrue(inventory["size_is_complete"])
        self.assertEqual(inventory["artifact_count"], 3)
        self.assertGreater(inventory["measured_bytes"], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM task_artifact_retention").fetchone()[0], 0)
        self.assertTrue((self.workspace / "scratch" / JOB / "data.json").exists())

    def test_active_needs_review_notification_expiry_and_stop_are_protected(self):
        cases = [("UPDATE jobs SET status='needs_review'", "active_or_needs_review"),
                 ("UPDATE tasks SET state='active'", "active_or_needs_review"),
                 ("UPDATE task_attempts SET stop_receipt_json=NULL", "worker_stop_unverified"),
                 ("UPDATE job_completion_results SET notification_state='pending'", "notification_unsettled"),
                 ("UPDATE job_completion_results SET content_delete_at='2027-01-01T00:00:00Z'", "retention_not_expired"),
                 ("UPDATE jobs SET created_at='2026-10-05T00:00:00Z'", "retention_not_expired"),
                 ("UPDATE events SET completed_at='2026-10-05T00:00:00Z'", "retention_not_expired"),
                 ("UPDATE tasks SET wait_reason='human_input'", "task_attention_unsettled")]
        cases.append(("DELETE FROM job_owner_bindings", "owner_binding_unverified"))
        for sql, expected in cases:
            with self.subTest(sql=sql):
                self.db.execute("SAVEPOINT fixture")
                self.db.execute(sql)
                self.assertEqual(self.engine.inventory(JOB, NOW)["protection_reasons"], [expected])
                self.db.execute("ROLLBACK TO fixture")
                self.db.execute("RELEASE fixture")

    def test_unreported_group_and_accepted_unfinished_event(self):
        self.db.execute("INSERT INTO job_groups VALUES(?,'grouped',?,NULL)", ("event-" + JOB, OLD))
        self.db.commit()
        self.assertEqual(self.engine.inventory(JOB, NOW)["protection_reasons"], ["notification_unsettled"])
        self.db.execute("INSERT INTO events(event_id,status) VALUES('report','needs_review')")
        self.db.execute("UPDATE job_groups SET all_terminal_event_id='report'")
        self.db.commit()
        self.assertEqual(self.engine.inventory(JOB, NOW)["protection_reasons"], ["notification_unsettled"])
        self.db.execute("UPDATE events SET status='completed'")
        self.db.commit()
        self.assertTrue(self.engine.inventory(JOB, NOW)["size_is_complete"])

    def test_symlink_hardlink_and_path_traversal(self):
        work = self.workspace / "scratch" / JOB
        outside = self.root / "outside"
        outside.write_text("must survive")
        for link in ("symlink", "hardlink"):
            with self.subTest(link=link):
                target = work / "link"
                if link == "symlink":
                    target.symlink_to(outside)
                else:
                    os.link(outside, target)
                item = self.engine.inventory(JOB, NOW)["artifacts"][0]
                self.assertIsNone(item["allocated_bytes"])
                target.unlink()
                self.assertEqual(outside.read_text(), "must survive")
        self.db.execute("UPDATE jobs SET workspace_path=?", (str(work / ".." / JOB),))
        self.db.commit()
        self.assertEqual(self.engine.inventory(JOB, NOW)["protection_reasons"], ["path_contract_mismatch"])

    def test_shared_root_git_and_handoff_not_deleted(self):
        os.chmod(self.workspace, 0o755)
        self.assertFalse(self.engine.inventory(JOB, NOW)["size_is_complete"])
        os.chmod(self.workspace, 0o700)
        for workspace, expected in [({"kind": "github", "repository": "reirei-lab/dona"}, "git_worktree_registration_unverified"),
                                     ({"kind": "scratch", "_dona_handoff": {}}, "shared_workspace_unverified")]:
            self.db.execute("UPDATE jobs SET workspace_json=?", (json.dumps(workspace),))
            self.db.commit()
            self.assertEqual(self.engine.inventory(JOB, NOW)["protection_reasons"], [expected])

    def test_missing_and_bounded_page_and_scan(self):
        (self.results / JOB / "data.json").unlink()
        (self.results / JOB).rmdir()
        self.assertEqual(self.engine.inventory(JOB, NOW)["artifacts"][2]["cleanup_state"], "missing")
        page = self.engine.batch(NOW, entries=1)
        self.assertFalse(page["size_is_complete"])
        self.assertEqual(page["jobs"][0]["artifacts"][0]["cleanup_state"], "budget_exceeded")
        self.assertEqual(page["next_cursor"], "")
        self.assertTrue(page["has_more"])
        resumed = self.engine.batch(NOW, after=page["next_cursor"])
        self.assertEqual(resumed["jobs"][0]["job_id"], JOB)
        other = "job_01m48pn0e7hkz6jy1xz6rmfeav"
        self.add_job(other)
        page = self.engine.batch(NOW, limit=1)
        self.assertTrue(page["has_more"])
        next_page = self.engine.batch(NOW, after=page["next_cursor"], limit=1)
        self.assertEqual(next_page["jobs"][0]["job_id"], other)
        self.assertFalse(next_page["has_more"])

    def test_invalid_candidate_does_not_block_other_job(self):
        other = "job_01m48pn0e7hkz6jy1xz6rmfeav"
        self.add_job(other)
        self.db.execute("UPDATE jobs SET workspace_json='invalid' WHERE job_id=?", (JOB,))
        self.db.commit()
        page = self.engine.batch(NOW)
        self.assertEqual(len(page["jobs"]), 2)
        self.assertEqual(page["jobs"][0]["protection_reasons"], ["artifact_contract_unverified"])
        self.assertTrue(page["jobs"][1]["size_is_complete"])

    def test_shared_predecessor_and_successor_are_both_protected(self):
        successor = "job_01m48pn0e7hkz6jy1xz6rmfeav"
        self.add_job(successor)
        original = str(self.workspace / "scratch" / JOB)
        self.db.execute("UPDATE jobs SET workspace_path=?,workspace_json=? WHERE job_id=?",
                        (original, json.dumps({"kind": "scratch", "_dona_handoff": {"workspace_job_id": JOB}}), successor))
        self.db.commit()
        for job in (JOB, successor):
            self.assertEqual(self.engine.inventory(job, NOW)["protection_reasons"], ["shared_workspace_unverified"])
        self.assertTrue((self.workspace / "scratch" / JOB / "data.json").exists())

    @unittest.skipUnless(HAS_BIRTH, "macOS birthtime必須")
    def test_new_reference_after_purge_commit_is_rechecked_under_lock(self):
        other = "job_01m48pn0e7hkz6jy1xz6rmfeav"
        self.add_job(other)
        work = self.workspace / "scratch" / JOB
        def reference(phase):
            if phase == "purged":
                writer = sqlite3.connect(self.database)
                try:
                    writer.execute("UPDATE jobs SET workspace_path=? WHERE job_id=?", (str(work), other))
                    writer.commit()
                finally:
                    writer.close()
        with self.assertRaisesRegex(Protected, "shared_workspace_unverified"):
            self.engine.cleanup(JOB, "worktree", NOW, hook=reference)
        self.assertEqual((work / "data.json").read_text(), "kept evidence")
        self.assertFalse(self.tomb().exists())

    def test_birthtime_capability_is_not_downgraded(self):
        if HAS_BIRTH:
            return
        with self.assertRaisesRegex(Protected, "birthtime_unavailable"):
            self.engine.cleanup(JOB, "worktree", NOW)
        self.assertFalse(self.tomb().exists())

    def test_unknown_policy_is_protected(self):
        engine = Retention(self.db, str(self.workspace), str(self.results))
        self.assertEqual(engine.inventory(JOB, NOW)["protection_reasons"], ["policy_unverified"])
        with self.assertRaisesRegex(Protected, "policy_unverified"):
            engine.cleanup(JOB, "worktree", NOW)
        for days, floor in [(0, 0), (7, -1), (7, True), (7, float("nan"))]:
            with self.assertRaises(ValueError):
                Policy(days, floor)

    def test_overlapping_roots_are_rejected(self):
        for result in (self.workspace, self.workspace / "scratch", self.root):
            with self.assertRaisesRegex(Protected, "artifact_roots_overlap"):
                Retention(self.db, str(self.workspace), str(result), Policy(7, 0))

    def test_both_root_capacities_and_unavailable_observation(self):
        self.engine.policy = Policy(7, 200)
        workspace_inode = self.workspace.stat().st_ino
        def capacity(fd):
            return SimpleNamespace(f_bavail=100 if os.fstat(fd).st_ino == workspace_inode else 1000, f_frsize=1)
        with patch("task_artifact_retention.os.fstatvfs", side_effect=capacity):
            item = self.engine.batch(NOW)
        self.assertEqual(item["available_bytes"], 100)
        self.assertFalse(item["disk_floor_met"])
        self.assertTrue(item["root_capacities"]["result"]["disk_floor_met"])
        with patch("task_artifact_retention.os.fstatvfs", side_effect=OSError("unavailable")):
            item = self.engine.batch(NOW)
        self.assertIsNone(item["available_bytes"])
        self.assertFalse(item["disk_floor_met"])

    def test_mount_device_mismatch_is_protected_before_descent(self):
        work = self.workspace / "scratch" / JOB
        mount = work / "mounted"
        mount.mkdir(mode=0o700)
        (mount / "keep").write_text("other volume fixture")
        original = os.stat
        def sample(name, *args, **kwargs):
            info = original(name, *args, **kwargs)
            if name == "mounted":
                values = {key: getattr(info, key) for key in ("st_dev", "st_ino", "st_uid", "st_mode", "st_nlink", "st_blocks")}
                values["st_dev"] += 1
                return SimpleNamespace(**values)
            return info
        with patch("task_artifact_retention.os.stat", side_effect=sample):
            item = self.engine.inventory(JOB, NOW)["artifacts"][0]
        self.assertEqual(item["cleanup_error"], "mount_boundary")
        self.assertEqual((mount / "keep").read_text(), "other volume fixture")
        def ancestor(name, *args, **kwargs):
            info = sample(name, *args, **kwargs)
            if name == "scratch":
                values = {key: getattr(info, key) for key in ("st_dev", "st_ino", "st_uid", "st_mode", "st_nlink", "st_blocks")}
                values["st_dev"] += 1
                return SimpleNamespace(**values)
            return info
        with patch("task_artifact_retention.os.stat", side_effect=ancestor):
            item = self.engine.inventory(JOB, NOW)["artifacts"][0]
        self.assertEqual(item["cleanup_error"], "mount_boundary")

    @unittest.skipUnless(HAS_BIRTH, "macOS birthtime必須")
    def test_disk_observation_failure_cannot_purge(self):
        with patch("task_artifact_retention.os.fstatvfs", side_effect=OSError("disk observation unavailable")):
            with self.assertRaises(OSError):
                self.engine.cleanup(JOB, "worktree", NOW)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM task_artifact_retention").fetchone()[0], 0)

    @unittest.skipUnless(HAS_BIRTH, "削除はbirthtimeを確認できるmacOSで検証する")
    def test_purged_precedes_rename_and_rejects_late_result_after_restart(self):
        def crash(phase):
            if phase == "purged":
                observer = sqlite3.connect(self.database)
                try:
                    self.assertEqual(observer.execute("SELECT cleanup_state FROM task_artifact_retention").fetchone()[0], "purged")
                    self.assertIsNone(observer.execute("SELECT result_json FROM jobs").fetchone()[0])
                finally:
                    observer.close()
                raise RuntimeError("process crash")
        with self.assertRaisesRegex(RuntimeError, "process crash"):
            self.engine.cleanup(JOB, "result", NOW, hook=crash)
        self.db.close()
        self.db = sqlite3.connect(self.database)
        self.engine = Retention(self.db, str(self.workspace), str(self.results), Policy(7, 0))
        self.engine.install()
        for sql in ("UPDATE jobs SET result_json='late'", "UPDATE jobs SET status='needs_review'",
                    "UPDATE task_attempts SET checkpoint_json='late'", "UPDATE jobs SET result_path='replacement'"):
            with self.assertRaisesRegex(sqlite3.IntegrityError, "artifact_reference_purged"):
                self.db.execute(sql)
            self.db.rollback()
        self.assertEqual(self.engine.cleanup(JOB, "result", NOW), "deleted")
        self.assertEqual(self.engine.cleanup(JOB, "result", NOW), "deleted")

    @unittest.skipUnless(HAS_BIRTH, "macOS birthtime必須")
    def test_same_name_replacement_and_rename_crash(self):
        def crash(phase):
            if phase == "renamed":
                raise RuntimeError("lost response")
        with self.assertRaisesRegex(RuntimeError, "lost response"):
            self.engine.cleanup(JOB, "worktree", NOW, hook=crash)
        replacement = self.workspace / "scratch" / JOB
        replacement.mkdir(mode=0o700)
        (replacement / "keep").write_text("replacement")
        self.assertEqual(self.engine.cleanup(JOB, "worktree", NOW), "deleted")
        self.assertEqual((replacement / "keep").read_text(), "replacement")

    @unittest.skipUnless(HAS_BIRTH, "macOS birthtime必須")
    def test_replacement_before_rename_or_delete_is_quarantined(self):
        work = self.workspace / "scratch" / JOB
        def replace(phase):
            if phase == "before_rename":
                work.rename(work.with_name("saved-original"))
                work.mkdir(mode=0o700)
                (work / "keep").write_text("replacement")
        with self.assertRaisesRegex(Protected, "artifact_replaced"):
            self.engine.cleanup(JOB, "worktree", NOW, hook=replace)
        self.assertEqual((self.tomb() / "keep").read_text(), "replacement")
        self.assertEqual(self.engine.cleanup(JOB, "worktree", NOW), "quarantined")

    @unittest.skipUnless(HAS_BIRTH, "macOS birthtime必須")
    def test_tomb_replacement_before_delete_and_exclusive_collision_survive(self):
        def replace(phase):
            if phase == "before_delete":
                self.tomb().rename(self.tomb().with_name("original-tomb"))
                self.tomb().mkdir(mode=0o700)
                (self.tomb() / "keep").write_text("keep")
        with self.assertRaisesRegex(Protected, "artifact_replaced"):
            self.engine.cleanup(JOB, "worktree", NOW, hook=replace)
        self.assertEqual((self.tomb() / "keep").read_text(), "keep")

    @unittest.skipUnless(HAS_BIRTH, "macOS birthtime必須")
    def test_no_overwrite_tomb_collision(self):
        def collide(phase):
            if phase == "before_rename":
                self.tomb().mkdir(mode=0o700)
        with self.assertRaises(OSError):
            self.engine.cleanup(JOB, "worktree", NOW, hook=collide)
        self.assertTrue((self.workspace / "scratch" / JOB / "data.json").exists())
        self.assertTrue(self.tomb().is_dir())

    @unittest.skipUnless(HAS_BIRTH, "macOS birthtime必須")
    def test_root_replacement_after_rename_cannot_delete(self):
        def replace(phase):
            if phase == "before_delete":
                self.workspace.rename(self.workspace.with_name("original-root"))
                self.workspace.mkdir(mode=0o700)
        with self.assertRaisesRegex(Protected, "root_replaced"):
            self.engine.cleanup(JOB, "worktree", NOW, hook=replace)
        old = self.workspace.with_name("original-root") / "scratch" / self.tomb().name
        self.assertEqual((old / "data.json").read_text(), "kept evidence")

    @unittest.skipUnless(HAS_BIRTH, "macOS birthtime必須")
    def test_restart_root_and_ancestor_generation_are_bound(self):
        def crash(phase):
            if phase == "renamed":
                raise RuntimeError("crash")
        with self.assertRaises(RuntimeError):
            self.engine.cleanup(JOB, "worktree", NOW, hook=crash)
        original_root = self.workspace.with_name("saved-root")
        self.workspace.rename(original_root)
        self.workspace.mkdir(mode=0o700)
        (self.workspace / "scratch").mkdir(mode=0o700)
        (original_root / "scratch" / self.tomb().name).rename(self.tomb())
        with self.assertRaisesRegex(Protected, "root_replaced"):
            self.engine.cleanup(JOB, "worktree", NOW)
        self.assertEqual((self.tomb() / "data.json").read_text(), "kept evidence")

    @unittest.skipUnless(HAS_BIRTH, "macOS birthtime必須")
    def test_restart_replaced_ancestor_cannot_rebind_same_artifact(self):
        def crash(phase):
            if phase == "renamed":
                raise RuntimeError("crash")
        with self.assertRaises(RuntimeError):
            self.engine.cleanup(JOB, "worktree", NOW, hook=crash)
        parent = self.workspace / "scratch"
        old = self.workspace / "old-scratch"
        parent.rename(old)
        parent.mkdir(mode=0o700)
        (old / self.tomb().name).rename(self.tomb())
        with self.assertRaisesRegex(Protected, "ancestor_replaced"):
            self.engine.cleanup(JOB, "worktree", NOW)
        self.assertEqual((self.tomb() / "data.json").read_text(), "kept evidence")

    @unittest.skipUnless(HAS_BIRTH, "macOS birthtime必須")
    def test_disk_floor_and_bounded_restart(self):
        self.engine.policy = Policy(7, 2**63 - 1)
        with self.assertRaisesRegex(Protected, "disk_floor"):
            self.engine.cleanup(JOB, "worktree", NOW)
        self.engine.policy = Policy(7, 0)
        self.assertFalse(self.tomb().exists())
        def crash(phase):
            if phase == "renamed":
                raise RuntimeError("crash")
        with self.assertRaises(RuntimeError):
            self.engine.cleanup(JOB, "worktree", NOW, hook=crash)
        self.assertEqual(self.engine.cleanup(JOB, "worktree", NOW, entries=1), "budget_exceeded")
        self.assertEqual(self.engine.cleanup(JOB, "worktree", NOW), "deleted")

    @unittest.skipUnless(HAS_BIRTH, "macOS birthtime必須")
    def test_last_job_partial_cleanup_is_revisited_by_batch(self):
        def crash(phase):
            if phase == "renamed":
                raise RuntimeError("crash")
        with self.assertRaises(RuntimeError):
            self.engine.cleanup(JOB, "worktree", NOW, hook=crash)
        first = self.engine.batch(NOW, dry_run=False, entries=1)
        self.assertEqual(first["next_cursor"], "")
        self.assertTrue(first["has_more"])
        resumed = self.engine.batch(NOW, after=first["next_cursor"], dry_run=False)
        self.assertEqual(resumed["next_cursor"], JOB)
        self.assertFalse(resumed["has_more"])
        self.assertTrue(all(item["cleanup_state"] == "deleted" for item in resumed["jobs"][0]["artifacts"]))


if __name__ == "__main__":
    unittest.main()
