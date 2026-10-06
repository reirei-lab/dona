"""Task世代のartifact保持・隔離削除。自動起動/CLIは提供しない。

呼出元が所有するprivate DB/rootだけを扱う。App Serverの停止receiptを
要求し、Herdr名の不在やterminal statusだけでは削除しない。
"""
import contextlib
import ctypes
import datetime as dt
from dataclasses import dataclass
import hashlib
import json
import math
import os
import re
import sqlite3
import stat
import time


class Protected(Exception):
    pass


class BudgetExceeded(Exception):
    pass


@dataclass(frozen=True)
class Policy:
    retention_days: int
    disk_floor_bytes: int

    def __post_init__(self):
        if type(self.retention_days) is not int or not 7 <= self.retention_days <= 3650:
            raise ValueError("retention_policy_invalid")
        if type(self.disk_floor_bytes) is not int or not 0 <= self.disk_floor_bytes <= 2**63 - 1:
            raise ValueError("disk_floor_policy_invalid")


def rename_exclusive(parent, source, target):
    # Darwin sys/stdio.h: RENAME_EXCL=0x4. Never replace an existing tombstone.
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameatx_np", None)
    if rename is None:
        raise Protected("exclusive_rename_unavailable")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(parent, os.fsencode(source), parent, os.fsencode(target), 0x4) != 0:
        code = ctypes.get_errno()
        raise OSError(code, "exclusive_rename_failed")


def timestamp(value):
    if not isinstance(value, str) or not value.endswith("Z"):
        raise Protected("timestamp_unverified")
    try:
        return dt.datetime.fromisoformat(value[:-1] + "+00:00").timestamp()
    except ValueError as error:
        raise Protected("timestamp_unverified") from error


def object_json(value):
    try:
        parsed = json.loads(value)
    except (ValueError, TypeError) as error:
        raise Protected("artifact_contract_unverified") from error
    if not isinstance(parsed, dict):
        raise Protected("artifact_contract_unverified")
    return parsed


def identity(info):
    # macOS birthtime detects inode reuse; Linux's change time is used only for
    # the initial rename check, not as a stable directory identity after unlink.
    return [info.st_dev, info.st_ino, info.st_uid, stat.S_IFMT(info.st_mode),
            getattr(info, "st_birthtime", None)]


def checked(info, directory=False):
    if info.st_uid != os.getuid() or (not stat.S_ISDIR(info.st_mode) if directory
                                    else not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode))):
        raise Protected("owner_or_type_unverified")
    if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
        raise Protected("hardlink")
    # Artifact content may be readable, but never writable by another user.
    if info.st_mode & 0o022:
        raise Protected("shared_writer")


class Budget:
    def __init__(self, entries, seconds):
        if type(entries) is not int or not 1 <= entries <= 10000 or type(seconds) not in (int, float) or not 0 < seconds <= 5:
            raise ValueError("budget_invalid")
        self.remaining = entries
        self.deadline = time.monotonic() + seconds

    def tick(self):
        if self.remaining <= 0 or time.monotonic() >= self.deadline:
            raise BudgetExceeded()
        self.remaining -= 1


@contextlib.contextmanager
def private_root(root):
    """絶対pathの全祖先をNOFOLLOWで開く。root自体はowner-private。"""
    if not os.path.isabs(root) or os.path.normpath(root) != root:
        raise Protected("root_contract_mismatch")
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for segment in root.split("/")[1:]:
            next_fd = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_fd
        info = os.fstat(descriptor)
        checked(info, True)
        if info.st_mode & 0o077:
            raise Protected("root_not_private")
        yield descriptor
    finally:
        os.close(descriptor)


@contextlib.contextmanager
def parent_handle(root_fd, relative):
    parts = relative.split("/")
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise Protected("path_contract_mismatch")
    descriptor = os.dup(root_fd)
    chain = []
    try:
        for segment in parts[:-1]:
            info = os.stat(segment, dir_fd=descriptor, follow_symlinks=False)
            checked(info, True)
            child = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            if identity(os.fstat(child)) != identity(info):
                os.close(child)
                raise Protected("ancestor_replaced")
            chain.append((descriptor, segment, identity(info)))
            descriptor = child
        def recheck():
            for ancestor, segment, expected in chain:
                info = os.stat(segment, dir_fd=ancestor, follow_symlinks=False)
                checked(info, True)
                if identity(info) != expected:
                    raise Protected("ancestor_replaced")
        yield descriptor, parts[-1], recheck
    finally:
        os.close(descriptor)
        for ancestor, _, _ in chain:
            os.close(ancestor)


def walk(parent, name, budget, delete=False, expected=None, depth=0):
    """fd相対の走査。symlink/special file/hardlinkは追わず隔離する。"""
    budget.tick()
    if depth > 64:
        raise Protected("depth_budget_exceeded")
    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    checked(info)
    if expected is not None and identity(info) != expected:
        raise Protected("artifact_replaced")
    allocated = info.st_blocks * 512
    if stat.S_ISDIR(info.st_mode):
        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            if identity(os.fstat(child)) != identity(info):
                raise Protected("artifact_replaced")
            # scandir is streaming: do not materialize an unbounded listdir.
            with os.scandir(child) as entries:
                for entry in entries:
                    allocated += walk(child, entry.name, budget, delete, depth=depth + 1)
        finally:
            os.close(child)
    budget.tick()
    current = os.stat(name, dir_fd=parent, follow_symlinks=False)
    checked(current)
    if identity(current) != identity(info):
        raise Protected("artifact_replaced")
    if delete:
        if not hasattr(current, "st_birthtime"):
            # Portable Python lacks Linux statx birthtime. dev/ino alone cannot
            # reject inode reuse after crash. Never downgrade this invariant.
            raise Protected("birthtime_unavailable")
        if stat.S_ISDIR(current.st_mode):
            os.rmdir(name, dir_fd=parent)
        else:
            os.unlink(name, dir_fd=parent)
    return allocated


class Retention:
    """単一maintenance writerのAPI。DB connection/rootは呼出元の設定値。"""
    def __init__(self, database, workspace_root, result_root, policy=None):
        if policy is not None and not isinstance(policy, Policy):
            raise ValueError("retention_policy_invalid")
        self.db = database
        self.db.row_factory = sqlite3.Row
        self.roots = {"workspace": workspace_root, "result": result_root}
        self.policy = policy

    def install(self):
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS task_artifact_retention(
              job_id TEXT NOT NULL REFERENCES task_attempts(attempt_id),
              kind TEXT NOT NULL CHECK(kind IN ('worktree','progress','result')),
              root_kind TEXT NOT NULL, relative_path TEXT NOT NULL,
              identity_json TEXT NOT NULL, change_ns TEXT NOT NULL,
              cleanup_state TEXT NOT NULL CHECK(cleanup_state IN ('purged','deleted','quarantined')),
              allocated_bytes INTEGER NOT NULL, purged_at TEXT NOT NULL,
              cleanup_error TEXT, PRIMARY KEY(job_id,kind));
            CREATE TRIGGER IF NOT EXISTS retention_terminal_status_guard
              BEFORE UPDATE OF status ON jobs
              WHEN NEW.status<>OLD.status AND EXISTS(
                SELECT 1 FROM task_artifact_retention WHERE job_id=OLD.job_id)
              BEGIN SELECT RAISE(ABORT,'artifact_reference_purged'); END;
            CREATE TRIGGER IF NOT EXISTS retention_result_guard
              BEFORE UPDATE OF result_json ON jobs
              WHEN NEW.result_json IS NOT NULL AND EXISTS(
                SELECT 1 FROM task_artifact_retention WHERE job_id=OLD.job_id AND kind='result')
              BEGIN SELECT RAISE(ABORT,'artifact_reference_purged'); END;
            CREATE TRIGGER IF NOT EXISTS retention_path_guard
              BEFORE UPDATE OF workspace_path,result_path,workspace_json ON jobs
              WHEN EXISTS(SELECT 1 FROM task_artifact_retention WHERE job_id=OLD.job_id)
                AND (NEW.workspace_path<>OLD.workspace_path OR NEW.result_path<>OLD.result_path
                     OR NEW.workspace_json<>OLD.workspace_json)
              BEGIN SELECT RAISE(ABORT,'artifact_reference_purged'); END;
            CREATE TRIGGER IF NOT EXISTS retention_checkpoint_guard
              BEFORE UPDATE OF checkpoint_json ON task_attempts
              WHEN NEW.checkpoint_json IS NOT NULL AND EXISTS(
                SELECT 1 FROM task_artifact_retention WHERE job_id=OLD.attempt_id AND kind='result')
              BEGIN SELECT RAISE(ABORT,'artifact_reference_purged'); END;
        """)

    def eligible(self, job_id, now):
        if self.policy is None:
            raise Protected("policy_unverified")
        if not isinstance(now, (int, float)) or not math.isfinite(now):
            raise Protected("timestamp_unverified")
        if not re.fullmatch(r"job_[0-9a-hjkmnp-tv-z]{26}", job_id):
            raise Protected("job_identity_invalid")
        row = self.db.execute("""SELECT j.*,a.task_id,a.stop_receipt_json,t.state AS task_state,
            t.current_attempt_id,t.wait_reason,t.steer_pending_event_id
            FROM jobs j JOIN task_attempts a ON a.attempt_id=j.job_id
            JOIN tasks t ON t.task_id=a.task_id WHERE j.job_id=?""", (job_id,)).fetchone()
        if not row:
            raise Protected("task_binding_missing")
        terminal = ("completed", "failed", "cancelled")
        if row["status"] not in terminal or row["task_state"] not in terminal:
            raise Protected("active_or_needs_review")
        if row["wait_reason"] or row["steer_pending_event_id"]:
            raise Protected("task_attention_unsettled")
        if row["steer_state"] or row["agent_name"] != job_id:
            raise Protected("worker_contract_unverified")
        if self.db.execute("""SELECT 1 FROM task_attempts a JOIN jobs j ON j.job_id=a.attempt_id
             WHERE a.task_id=? AND j.status NOT IN ('completed','failed','cancelled') LIMIT 1""",
                           (row["task_id"],)).fetchone():
            raise Protected("active_attempt")
        try:
            receipt = json.loads(row["stop_receipt_json"] or "null")
        except ValueError as error:
            raise Protected("worker_stop_unverified") from error
        if not isinstance(receipt, dict) or receipt.get("state") != "stopped" or receipt.get("reason") not in (
                "app_server_verified_empty_scope", "app_server_observed"):
            raise Protected("worker_stop_unverified")
        stopped = timestamp(receipt.get("verified_at", receipt.get("observed_at")))
        completed = timestamp(row["completed_at"])
        if max(stopped, completed) + self.policy.retention_days * 86400 > now:
            raise Protected("retention_not_expired")
        completions = self.db.execute("SELECT * FROM job_completion_results WHERE job_id=?", (job_id,)).fetchall()
        matching = False
        for completion in completions:
            destination = object_json(completion["destination_json"])
            if completion["notification_state"] == "none" and destination != {"kind": "none"}:
                raise Protected("notification_unsettled")
            if completion["notification_state"] not in ("none", "accepted"):
                raise Protected("notification_unsettled")
            if completion["notification_state"] == "accepted" and completion["notification_event_id"]:
                event = self.db.execute("SELECT status FROM events WHERE event_id=?", (completion["notification_event_id"],)).fetchone()
                if not event or event["status"] != "completed":
                    raise Protected("notification_unsettled")
            if timestamp(completion["content_delete_at"]) > now:
                raise Protected("retention_not_expired")
            if completion["job_status"] == row["status"]:
                matching = True
        # Grouped delivery is not settled by a sibling's completion receipt.
        group = self.db.execute("SELECT * FROM job_groups WHERE source_event_id=?", (row["source_event_id"],)).fetchone()
        event_id = row["completion_event_id"]
        if group and group["notification_mode"] == "grouped":
            if not group["sealed_at"] or not group["all_terminal_event_id"]:
                raise Protected("notification_unsettled")
            if self.db.execute("SELECT 1 FROM jobs WHERE source_event_id=? AND status NOT IN ('completed','failed','cancelled') LIMIT 1",
                               (row["source_event_id"],)).fetchone():
                raise Protected("active_group_member")
            event_id = group["all_terminal_event_id"]
        if event_id:
            event = self.db.execute("SELECT status FROM events WHERE event_id=?", (event_id,)).fetchone()
            if not event or event["status"] != "completed":
                raise Protected("notification_unsettled")
        elif any(object_json(item["destination_json"]) != {"kind": "none"} for item in completions):
            raise Protected("notification_unverified")
        if not matching:
            self.regular_notification(row, event_id, now)
        return row

    def regular_notification(self, row, event_id, now):
        # Ordinary Task notifications use events/job_groups, whereas schedule
        # completion uses job_completion_results. Do not invent schedule rows.
        binding = self.db.execute("SELECT * FROM job_owner_bindings WHERE job_id=? AND source_event_id=?",
                                  (row["job_id"], row["source_event_id"])).fetchone()
        if not binding:
            raise Protected("notification_unverified")
        destination = object_json(binding["destination_json"])
        if not isinstance(destination, dict) or destination.get("kind") != "slack_thread":
            raise Protected("notification_route_unsupported")
        event = self.db.execute("SELECT * FROM events WHERE event_id=?", (event_id,)).fetchone()
        if not event or event["source"] != "dona_job" or event["status"] != "completed":
            raise Protected("notification_unsettled")
        if object_json(event["reply_target_json"]) != destination:
            raise Protected("notification_binding_mismatch")
        subject = object_json(event["subject_json"])
        if subject.get("source_event_id") != row["source_event_id"]:
            raise Protected("notification_binding_mismatch")
        result = object_json(event["result_json"])
        if not isinstance(result, dict) or result.get("event_id") != event_id or result.get("status") != "completed":
            raise Protected("notification_unsettled")
        actions = result.get("actions")
        if not isinstance(actions, list) or any(not isinstance(action, dict) or action.get("ambiguous") is True for action in actions):
            raise Protected("notification_unsettled")
        def succeeded(action):
            return action.get("success") is not False and action.get("ok") is not False and "error" not in action
        def same_target(action):
            return all(action.get(key) == destination.get(key) for key in ("workspace_id", "channel_id", "thread_ts"))
        posted = any(action.get("tool") in ("dona_slack.post_message", "mcp__dona_slack__post_message") and
                     isinstance(action.get("message_ts"), str) and re.fullmatch(r"\d+\.\d+", action["message_ts"]) and
                     action.get("reply_broadcast") is not True and same_target(action) and succeeded(action) for action in actions)
        sessions = [action for action in actions if action.get("tool") in (
            "dona_slack.set_agent_session_status", "mcp__dona_slack__set_agent_session_status") and same_target(action) and succeeded(action)]
        if not posted or not sessions or sessions[-1].get("status") != "active":
            raise Protected("notification_unsettled")
        if timestamp(event["completed_at"]) + self.policy.retention_days * 86400 > now:
            raise Protected("retention_not_expired")

    def candidates(self, row):
        workspace = object_json(row["workspace_json"])
        if not isinstance(workspace, dict):
            raise Protected("workspace_contract_unverified")
        if "_dona_handoff" in workspace:
            raise Protected("shared_workspace_unverified")
        job_id = row["job_id"]
        if workspace.get("kind") != "scratch":
            # Git registered worktree disposal requires a separate Git metadata
            # transaction. Do not delete a shared repository behind Git's back.
            raise Protected("git_worktree_registration_unverified")
        work = "scratch/" + job_id
        result = job_id
        if row["workspace_path"] != os.path.join(self.roots["workspace"], work) or row["result_path"] != os.path.join(
                self.roots["result"], result, "result.json"):
            raise Protected("path_contract_mismatch")
        return [("worktree", "workspace", work), ("progress", "workspace", "scratch/.dona-progress/" + job_id),
                ("result", "result", result)]

    def inventory(self, job_id, now, entries=10000, seconds=3):
        budget = getattr(self, "_batch_budget", None) or Budget(entries, seconds)
        try:
            row = self.eligible(job_id, now)
            candidates = self.candidates(row)
        except (Protected, ValueError, TypeError) as error:
            return {"job_id": job_id, "protection_reasons": [str(error) if isinstance(error, Protected) else "artifact_contract_unverified"], "artifacts": []}
        artifacts = []
        for kind, root_kind, relative in candidates:
            observation = {"kind": kind, "allocated_bytes": None, "cleanup_state": "unsafe"}
            saved = self.db.execute("SELECT cleanup_state,allocated_bytes,cleanup_error FROM task_artifact_retention WHERE job_id=? AND kind=?", (job_id, kind)).fetchone()
            if saved:
                observation.update(dict(saved))
                # Size before purge is historical, not current measured capacity.
                observation["allocated_bytes"] = 0 if saved["cleanup_state"] == "deleted" else None
                artifacts.append(observation)
                continue
            try:
                with private_root(self.roots[root_kind]) as root:
                    with parent_handle(root, relative) as (parent, name, recheck):
                        allocated = walk(parent, name, budget)
                        recheck()
                        observation.update(allocated_bytes=allocated, cleanup_state="eligible")
            except FileNotFoundError:
                observation.update(allocated_bytes=0, cleanup_state="missing")
            except BudgetExceeded:
                observation["cleanup_state"] = "budget_exceeded"
            except (Protected, OSError) as error:
                observation["cleanup_error"] = str(error) if isinstance(error, Protected) else "filesystem_unverified"
            artifacts.append(observation)
        return {"job_id": job_id, "created_at": row["created_at"], "terminal_at": row["completed_at"],
                "protection_reasons": [], "artifacts": artifacts,
                "size_is_complete": all(item["allocated_bytes"] is not None for item in artifacts)}

    def batch(self, now, after="", limit=8, dry_run=True, entries=1000, seconds=3):
        """keyset page、共通entry/time budget、候補ごとの隔離。pathは投影しない。"""
        if not 1 <= limit <= 8 or not isinstance(dry_run, bool):
            raise ValueError("batch_arguments_invalid")
        budget = Budget(entries, seconds)
        rows = self.db.execute("SELECT attempt_id FROM task_attempts WHERE attempt_id>? ORDER BY attempt_id LIMIT ?",
                               (after, limit + 1)).fetchall()
        results = []
        cursor = after
        for row in rows[:limit]:
            job_id = row["attempt_id"]
            if budget.remaining <= 0 or time.monotonic() >= budget.deadline:
                break
            started_entries = budget.remaining
            # inventory and cleanup have their own streaming budget; subtract
            # actual work via one shared budget rather than resetting per job.
            self._batch_budget = budget
            try:
                item = self.inventory(job_id, now, entries=started_entries,
                                      seconds=max(0.001, budget.deadline - time.monotonic()))
                if not dry_run and not item["protection_reasons"]:
                    for artifact in item["artifacts"]:
                        if budget.remaining <= 0 or time.monotonic() >= budget.deadline:
                            break
                        if artifact["cleanup_state"] not in ("eligible", "purged"):
                            continue
                        try:
                            artifact["cleanup_state"] = self.cleanup(job_id, artifact["kind"], now,
                                entries=budget.remaining, seconds=max(0.001, budget.deadline - time.monotonic()))
                            artifact["allocated_bytes"] = 0 if artifact["cleanup_state"] == "deleted" else None
                        except (Protected, OSError) as error:
                            artifact.update(cleanup_state="quarantined", allocated_bytes=None,
                                cleanup_error=str(error) if isinstance(error, Protected) else "filesystem_unverified")
                results.append(item)
                cursor = job_id
            finally:
                del self._batch_budget
        with private_root(self.roots["result"]) as root:
            capacity = os.fstatvfs(root)
            available = capacity.f_bavail * capacity.f_frsize
        artifacts = [artifact for item in results for artifact in item["artifacts"]]
        return {"dry_run": dry_run, "jobs": results, "next_cursor": cursor,
                "has_more": len(rows) > len(results), "available_bytes": available,
                "disk_floor_met": self.policy is not None and available >= self.policy.disk_floor_bytes, "artifact_count": len(artifacts),
                "measured_bytes": sum(item["allocated_bytes"] or 0 for item in artifacts),
                "unmeasured_count": sum(item["allocated_bytes"] is None for item in artifacts),
                "size_is_complete": not any(item["protection_reasons"] for item in results) and
                    all(item["allocated_bytes"] is not None for item in artifacts),
                "oldest_created_at": min((item["created_at"] for item in results if "created_at" in item), default=None)}

    def cleanup(self, job_id, kind, now, entries=1000, seconds=3, hook=lambda phase: None):
        """DBのpurged commit後だけ隔離renameし、同じidentityをboundedに削除。

        floor未達時は新規purgeを止め、既存purgeのreconcileは継続する。
        hookはisolated testのfault injection用。実行時には渡さない。
        """
        if kind not in ("worktree", "progress", "result"):
            raise ValueError("cleanup_arguments_invalid")
        budget = getattr(self, "_batch_budget", None) or Budget(entries, seconds)
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.eligible(job_id, now)
            candidate = next(item for item in self.candidates(row) if item[0] == kind)
            _, root_kind, relative = candidate
            saved = self.db.execute("SELECT * FROM task_artifact_retention WHERE job_id=? AND kind=?", (job_id, kind)).fetchone()
            if saved and saved["cleanup_state"] != "purged":
                self.db.rollback()
                return saved["cleanup_state"]
            with private_root(self.roots[root_kind]) as root:
                capacity = os.fstatvfs(root)
                if not saved:
                    if capacity.f_bavail * capacity.f_frsize < self.policy.disk_floor_bytes:
                        raise Protected("disk_floor")
                    with parent_handle(root, relative) as (parent, name, recheck):
                        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                        checked(info, True)
                        if not hasattr(info, "st_birthtime"):
                            raise Protected("birthtime_unavailable")
                        allocated = walk(parent, name, budget)
                        recheck()
                        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                        if identity(current) != identity(info) or current.st_ctime_ns != info.st_ctime_ns:
                            raise Protected("artifact_replaced")
                        self.db.execute("INSERT INTO task_artifact_retention VALUES(?,?,?,?,?,?,'purged',?,?,NULL)",
                                        (job_id, kind, root_kind, relative, json.dumps(identity(info)), str(info.st_ctime_ns),
                                         allocated, dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat().replace("+00:00", "Z")))
                        if kind == "result":
                            self.db.execute("UPDATE jobs SET result_json=NULL WHERE job_id=?", (job_id,))
                            self.db.execute("UPDATE task_attempts SET checkpoint_json=NULL WHERE attempt_id=?", (job_id,))
                    self.db.commit()
                    hook("purged")
                else:
                    self.db.rollback()
            # Restart performs the exact same eligibility check under the writer
            # lock. Keep it through the bounded filesystem step so status/receipt
            # changes cannot race deletion in another SQLite connection.
            self.db.execute("BEGIN IMMEDIATE")
            self.eligible(job_id, now)
            saved = self.db.execute("SELECT * FROM task_artifact_retention WHERE job_id=? AND kind=?", (job_id, kind)).fetchone()
            with private_root(self.roots[root_kind]) as root:
                expected = json.loads(saved["identity_json"])
                tomb = ".retention-" + hashlib.sha256((job_id + ":" + kind).encode()).hexdigest()
                with parent_handle(root, relative) as (parent, name, recheck):
                    try:
                        tomb_info = os.stat(tomb, dir_fd=parent, follow_symlinks=False)
                    except FileNotFoundError:
                        try:
                            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                        except FileNotFoundError:
                            # Cannot tell completed deletion from external removal.
                            raise Protected("purged_identity_missing")
                        checked(info, True)
                        if identity(info) != expected or str(info.st_ctime_ns) != saved["change_ns"]:
                            raise Protected("artifact_replaced")
                        recheck()
                        hook("before_rename")
                        rename_exclusive(parent, name, tomb)
                        os.fsync(parent)
                        tomb_info = os.stat(tomb, dir_fd=parent, follow_symlinks=False)
                        hook("renamed")
                    checked(tomb_info, True)
                    if identity(tomb_info) != expected:
                        raise Protected("artifact_replaced")
                    if expected[-1] is None:
                        raise Protected("birthtime_unavailable")
                    recheck()
                    hook("before_delete")
                    with private_root(self.roots[root_kind]) as live_root:
                        if identity(os.fstat(live_root)) != identity(os.fstat(root)):
                            raise Protected("root_replaced")
                    recheck()
                    walk(parent, tomb, budget, delete=True, expected=expected)
                    os.fsync(parent)
            self.db.execute("UPDATE task_artifact_retention SET cleanup_state='deleted',cleanup_error=NULL WHERE job_id=? AND kind=?", (job_id, kind))
            self.db.commit()
            return "deleted"
        except BudgetExceeded:
            self.db.rollback()
            return "budget_exceeded"
        except BaseException as error:
            self.db.rollback()
            # Expected unsafe candidates are quarantined individually; injected
            # crash/response loss stays purged for identity-bound reconciliation.
            if isinstance(error, (Protected, OSError)):
                self.db.execute("UPDATE task_artifact_retention SET cleanup_state='quarantined',cleanup_error=? WHERE job_id=? AND kind=?",
                                (str(error) if isinstance(error, Protected) else "filesystem_unverified", job_id, kind))
                self.db.commit()
            raise
