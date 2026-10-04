"""Run on Linux scratch: python3 -m unittest discover -s scripts/cutover-driver -v."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from driver import Driver, NoGo, StepFailed, rsync_changes


HERE = Path(__file__).resolve().parent


def command(*args, **kw):
    return subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          check=kw.pop("check", True), **kw)


def seed_loose(repo):
    """100 reachable blobs, including two in Git's sampled 17/ fanout: gc.auto=20 triggers."""
    data, n = [], 0
    while len(data) < 2:
        b = ("sample-%d\n" % n).encode()
        if hashlib.sha1(b"blob " + str(len(b)).encode() + b"\0" + b).hexdigest().startswith("17"):
            data.append(b)
        n += 1
    data.extend(("ordinary-%d\n" % n).encode() for n in range(98))
    for n, b in enumerate(data):
        (repo / ("sample-%d.txt" % n)).write_bytes(b)
    command("git", "-C", str(repo), "add", ".")
    command("git", "-C", str(repo), "write-tree")


class DriverTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="driver-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.repo = self.root / "source"
        command("git", "init", "-q", "-b", "main", str(self.repo))
        for k, v in (("user.name", "Test"), ("user.email", "test@example.invalid"),
                     ("gc.auto", "0"), ("maintenance.auto", "false")):
            self.git("config", k, v)
        self.git("commit", "-q", "--allow-empty", "-m", "start")
        summary = self.root / "summary.json"
        summary.write_text('{"ok":true}')
        manifest = self.root / "tools.sha256"
        tool = HERE.parent / "brain-rewrite" / "brainrw.py"
        manifest.write_text(hashlib.sha256(tool.read_bytes()).hexdigest() + "  brainrw.py\n")
        self.cfg = {
            "workDir": str(self.root / "work"),
            "mac": {"repo": str(self.repo), "engine": str(HERE.parent.parent),
                    "toolsSha256": str(manifest), "newClone": str(self.root / "clone"),
                    "freezeFile": str(self.root / "freeze"), "kumaStudio": str(self.repo)},
            "server": {"snapshot": str(self.root / "snapshot")},
            "prereq": {"c4cLandedSha": self.git("rev-parse", "HEAD").stdout.strip()},
            "c14d": {"summary": str(summary), "jq": ".ok"},
        }
        self.d = self.driver()

    def git(self, *args, **kw):
        return command("git", "-C", str(self.repo), *args, **kw)

    def driver(self):
        p = self.root / "config.json"
        p.write_text(json.dumps(self.cfg))
        d = Driver(str(p))
        d.state = {"values": {"freezeId": "test"}, "steps": {}}
        d.log = lambda msg: None
        return d

    def server_pre(self, *args, **kw):
        return 0, {"vaultsEntries": "0", "configClean": "true", "workMounts": "0", "leftovers": "0",
                   "workDirForeign": "false", "toolsMatch": "true", "filterRepo": "true", "engineLists": "true"}, {}

    def version_stub(self, core="CORE source: CURRENT", delay=0, exit_code=0):
        sha = self.cfg["prereq"]["c4cLandedSha"]
        self.cfg["prereq"].update(
            launcherVersionCmd=[sys.executable, "-c", "import json; print(json.dumps(%r))" %
                                {"installed": {"commit": sha}, "running": {"commit": sha}}],
            coreVersionCmd=[sys.executable, "-c", "import time; time.sleep(%s); print(%r); exit(%d)" %
                            (delay, core, exit_code)])
        self.d = self.driver()
        self.d.server = self.server_pre

    def test_refused_push_allows_concurrent_main_advance_but_detects_an_accepted_commit(self):
        bare = self.root / "remote.git"
        command("git", "clone", "--bare", str(self.repo), str(bare))
        self.git("remote", "add", "origin", str(bare))
        self.git("commit", "-q", "--allow-empty", "-m", "normal writer")
        normal = self.git("rev-parse", "HEAD").stdout.strip()
        hook = bare / "hooks/pre-receive"
        hook.write_text('#!/bin/sh\nwhile read old new ref; do\n'
                        ' if git cat-file -e "$new:reject.me" 2>/dev/null; then\n'
                        '  echo "fixture policy rejection" >&2; exit 1\n fi\ndone\n')
        hook.chmod(0o755)
        Path(self.d.step_log).touch()
        run = self.d.run

        def with_other_push(argv, **kw):
            if "push" in argv and "--no-verify" in argv:
                self.git("push", "-q", "origin", "HEAD:main")
            return run(argv, **kw)

        with patch.object(self.d, "run", side_effect=with_other_push):
            ok, detail = self.d.push_refused(str(self.repo), "reject.me", b"invalid\n", "fixture policy rejection")
        self.assertTrue(ok, detail)
        self.assertEqual(command("git", "--git-dir", str(bare), "rev-parse", "main").stdout.strip(), normal)
        self.assertTrue(detail["rejectedCommitAbsent"])
        self.assertEqual(self.git("for-each-ref", "refs/kuma-vault-smoke").stdout, "")

        # A transport error after the server accepted the commit must not look like rejection.
        hook.unlink()
        def accepted_but_failed(argv, **kw):
            result = run(argv, **kw)
            if "push" in argv and "--no-verify" in argv:
                self.assertEqual(result[0], 0)
                with open(self.d.step_log, "a") as log:
                    log.write("fixture policy rejection\n")
                return 1, ""
            return result

        with patch.object(self.d, "run", side_effect=accepted_but_failed):
            ok, detail = self.d.push_refused(str(self.repo), "reject.me", b"invalid\n", "fixture policy rejection")
        self.assertFalse(ok, detail)
        self.assertFalse(detail["rejectedCommitAbsent"])

    def test_permission_only_symlink_noise(self):
        lines = (HERE / "rehearsal" / "rsync-itemize-fixtures.txt").read_text().splitlines()
        lines = [l for l in lines if l and not l.startswith("#")]
        changes, noise = rsync_changes("\n".join(lines))
        self.assertEqual(noise, {"count": 2, "samples": [lines[0], lines[-1]]})
        self.assertEqual(changes, lines[1:-1])
        for item in ("*deleting   link", "cL+++++++++ link", ".L...po.... link", ".L...p....x link", "unknown"):
            self.assertEqual(rsync_changes(item)[0], [item])

    def test_step4_records_noise_but_rejects_real_changes(self):
        self.d.values()["HEAD_final"] = self.git("rev-parse", "HEAD").stdout.strip()
        self.d.copy_snapshot = lambda: None
        self.d.freeze_pathspec = lambda: ["."]
        self.d.server = lambda *a, **k: (0, {"serverHead": self.d.values()["HEAD_final"]}, {})
        self.d.gate = lambda s: (0, {})
        self.d.wait_3b = lambda: None
        run = self.d.run
        items = ".L...p... alias -> file\n"
        self.d.run = lambda argv, **kw: (0, items) if "--itemize-changes" in argv else run(argv, **kw)
        self.d.step_4()
        self.assertEqual(json.loads(Path(self.d.state_path).read_text())["values"]["platformNoise"]["count"], 1)
        items += ".f...p... file\n"
        with self.assertRaisesRegex(StepFailed, "1 changes"):
            self.d.step_4()

    def connected(self):
        dst = self.cfg["server"]["snapshot"]
        command("git", "--no-optional-locks", "-C", dst, "rev-parse", "--verify", "HEAD^{commit}")
        command("git", "--no-optional-locks", "-C", dst, "fsck", "--connectivity-only")

    def test_old_order_disconnects_new_order_connects(self):
        dst = Path(self.cfg["server"]["snapshot"])
        (dst / ".git" / "objects").mkdir(parents=True)
        command("rsync", "-a", str(self.repo / ".git/objects") + "/", str(dst / ".git/objects") + "/")
        self.git("commit", "-q", "--allow-empty", "-m", "after-objects")
        command("rsync", "-a", "--exclude=/.git/objects/", str(self.repo) + "/", str(dst) + "/")
        self.assertNotEqual(command("git", "-C", str(dst), "rev-parse", "--verify", "HEAD^{commit}", check=False).returncode, 0)
        run = self.d.run
        def between(argv, **kw):
            result = run(argv, **kw)
            if "--exclude=/.git/objects/" in argv:
                self.git("commit", "-q", "--allow-empty", "-m", "after-refs")
            return result
        self.d.run = between
        self.d.copy_snapshot()
        self.connected()

    def test_ten_copies_while_writer_commits(self):
        stop, errors, commits = threading.Event(), [], []
        def writer():
            try:
                while not stop.is_set():
                    self.git("commit", "-q", "--allow-empty", "-m", "concurrent")
                    commits.append(True)
                    stop.wait(0.2)
            except Exception as e:
                errors.append(e)
        t = threading.Thread(target=writer)
        t.start()
        try:
            for _ in range(10):
                self.d.copy_snapshot()
                self.connected()
                time.sleep(0.2)
        finally:
            stop.set()
            t.join()
        self.assertFalse(errors)
        self.assertGreaterEqual(len(commits), 10)

    def test_map_checks_connectivity_before_any_map_work(self):
        self.d.copy_snapshot()
        dst = Path(self.cfg["server"]["snapshot"])
        tree = command("git", "-C", str(dst), "rev-parse", "HEAD^{tree}").stdout.strip()
        (dst / ".git/objects" / tree[:2] / tree[2:]).unlink()
        marker = self.root / "mapped"
        env = dict(os.environ, O=str(dst), PY=str(self.root / "absent-tools"))
        script = 'set -e\n' + (HERE / "server/s0-map.sh").read_text() + '\ntouch "$MARKER"\n'
        r = command("bash", "-c", script, env=dict(env, MARKER=str(marker)), check=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertRegex(r.stdout + r.stderr, "broken link|missing tree")
        self.assertNotIn("absent-tools", r.stderr)
        self.assertFalse(marker.exists())

    def test_live_gc_blocks_both_steps_before_rsync(self):
        lock = self.repo / ".git/gc.pid"
        lock.write_text("%d %s" % (os.getpid(), socket.gethostname()))
        self.d.gate = lambda s: (0, {"method": "full"})
        with patch.object(self.d, "run", side_effect=AssertionError("must not rsync")):
            for step in (self.d.step_0, self.d.step_4):
                with self.assertRaisesRegex(StepFailed, "live gc.pid"):
                    step()
        lock.write_text("not-a-lock")
        with self.assertRaisesRegex(StepFailed, "invalid lock"):
            self.d.copy_snapshot()
        lock.write_text("1 foreign.example.invalid")
        with self.assertRaisesRegex(StepFailed, "liveness on host"):
            self.d.copy_snapshot()

    def test_pre_requires_disabled_effective_maintenance(self):
        self.version_stub()
        self.d.step_pre()
        for key, value in (("gc.auto", "6700"), ("maintenance.auto", "true")):
            self.git("config", key, value)
            with self.assertRaisesRegex(NoGo, "effective " + key):
                self.d.step_pre()
            self.git("config", key, "0" if key == "gc.auto" else "false")
            self.git("config", "--unset", key)
            with self.assertRaisesRegex(NoGo, "effective " + key):
                self.d.step_pre()
            self.git("config", key, "0" if key == "gc.auto" else "false")

    def test_freeze_commit_does_not_start_gc(self):
        seed_loose(self.repo)
        self.git("config", "gc.auto", "20")
        self.git("config", "maintenance.auto", "true")
        hook = self.repo / ".git/hooks/pre-auto-gc"
        hook.write_text('#!/bin/sh\ntouch "$(git rev-parse --git-dir)/gc-observed"\n')
        hook.chmod(0o755)
        old = self.root / "old"
        shutil.copytree(self.repo, old)
        before = set((self.repo / ".git/objects").glob("??/*"))
        self.d.freeze_pathspec = lambda: ["."]
        self.d.step_3()
        after = set((self.repo / ".git/objects").glob("??/*"))
        self.assertTrue(before.issubset(after))
        self.assertEqual(len(after - before), 1)  # only the new commit, no repack/deletion
        self.assertFalse((self.repo / ".git/gc.pid").exists())
        self.assertFalse((self.repo / ".git/gc-observed").exists())
        command("git", "-C", str(old), "commit", "-q", "-m", "old-command")
        self.assertTrue((old / ".git/gc-observed").exists())
        deadline = time.monotonic() + 20
        while (old / ".git/gc.pid").exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertTrue(list((old / ".git/objects/pack").glob("*.pack")))

    def test_stale_core_is_immediate_nogo(self):
        self.version_stub("CORE source: STALE")
        started = time.monotonic()
        with self.assertRaisesRegex(NoGo, "core-version is not CURRENT"):
            self.d.step_pre()
        self.assertLess(time.monotonic() - started, 5)

    def test_timeouts_are_distinct_and_not_retried(self):
        self.version_stub(delay=1)
        self.cfg["prereq"]["launcherVersionCmd"] = [sys.executable, "-c", "import time; time.sleep(1)"]
        self.d = self.driver()
        self.d.server = self.server_pre
        with patch("driver.VERSION_TIMEOUT_SECONDS", 0.02):
            with self.assertRaises(NoGo) as caught:
                self.d.step_pre()
        self.assertEqual(len(caught.exception.reasons), 2)
        self.assertTrue(all("timeout" in r for r in caught.exception.reasons))

    def test_nonzero_current_is_not_accepted(self):
        self.version_stub(exit_code=2)
        with self.assertRaisesRegex(NoGo, "not CURRENT"):
            self.d.step_pre()


if __name__ == "__main__":
    unittest.main()
