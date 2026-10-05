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

from driver import (Driver, NoGo, StepFailed, expand_cmd, generated_ignore_misses, junk_filter_args, ref_violations,
                    refuse_start, retired_config, rsync_changes)


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
            "server": {"snapshot": str(self.root / "snapshot"), "sourceBranch": "main"},
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
        # the recorded directory-time line is noise too since junk names stay out of the copy
        # (a lock file made and removed inside a folder moves only its time); the rest is drift
        dirtime = [l for l in lines if l.startswith(".d..t")]
        self.assertEqual(dirtime, [".d..t.... ./"])
        self.assertEqual(noise, {"count": 2, "samples": [lines[0], lines[-1]],
                                 "dirTimes": {"count": 1, "samples": dirtime}})
        self.assertEqual(changes, [l for l in lines[1:-1] if l not in dirtime])
        self.assertEqual(len(changes), 4)
        for item in ("*deleting   link", "cL+++++++++ link", ".L...po.... link", ".L...p....x link", "unknown",
                     ".d...p..... notes/", ".d..tp..... notes/", ".d..t.o.... notes/", "cd+++++++++ new/", ".f..t...... a.md"):
            self.assertEqual(rsync_changes(item)[0], [item])
        # a directory whose only change is its time: a lock file made and removed in it
        changes, noise = rsync_changes(".d..t...... notes/\n.d..t... vault/\n>f+++++++++ notes/new.md\n")
        self.assertEqual(changes, [">f+++++++++ notes/new.md"])
        self.assertEqual(noise, {"count": 0, "samples": [], "dirTimes": {"count": 2, "samples": [".d..t...... notes/", ".d..t... vault/"]}})

    def test_step4_records_noise_but_rejects_real_changes(self):
        self.d.values()["HEAD_final"] = self.git("rev-parse", "HEAD").stdout.strip()
        self.d.copy_snapshot = lambda: None
        self.d.freeze_pathspec = lambda: ["."]
        self.d.server = lambda *a, **k: (0, {"serverHead": self.d.values()["HEAD_final"]},
                                         {"refs": ["refs/heads/main commit", "HEAD refs/heads/main"]})
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
            # at least ten copies, and on until the writer has made ten commits (a loaded machine
            # commits slower than it copies)
            copies = 0
            while copies < 10 or (len(commits) < 10 and copies < 200 and not errors):
                self.d.copy_snapshot()
                self.connected()
                copies += 1
                time.sleep(0.2)
        finally:
            stop.set()
            t.join()
        self.assertFalse(errors)
        self.assertGreaterEqual(len(commits), 10)

    def test_copy_leaves_git_locks_and_temporary_objects_out(self):
        git = self.repo / ".git"
        (git / "index.lock").write_text("")
        (git / "refs/heads/main.lock").write_text("")
        (git / "objects/ab").mkdir()
        (git / "objects/ab/tmp_obj_Xy12").write_text("partial")
        (git / "objects/pack").mkdir(exist_ok=True)
        (git / "objects/pack/tmp_pack_Zz9").write_text("partial")
        self.d.copy_snapshot()
        dst = Path(self.cfg["server"]["snapshot"])
        left = sorted(str(p.relative_to(dst)) for p in dst.rglob("*") if p.name.endswith(".lock") or p.name.startswith("tmp_"))
        self.assertEqual(left, [])
        for p in (git / "index.lock", git / "refs/heads/main.lock"):
            p.unlink()
        self.connected()

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
        # the detached gc of the old command: wait for its pack (not for a gc.pid that may not be
        # written yet), then for it to end before the directory is removed
        deadline = time.monotonic() + 60
        while not list((old / ".git/objects/pack").glob("*.pack")) and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertTrue(list((old / ".git/objects/pack").glob("*.pack")))
        while (old / ".git/gc.pid").exists() and time.monotonic() < deadline:
            time.sleep(0.1)

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

    # --- secondary mode, D5, must-ignore, junk filters, launchd lead (counterexamples) -----------

    def secondary(self, **project):
        """The test repo as a secondary vault: tree at the root, declared id, the commit gate."""
        (self.repo / "vault.config.json").write_text('{"id": "old-store", "profile": "kuma-vault"}\n')
        (self.repo / "reject.json").write_text('{"reject": ["intake/**/source/"]}\n')
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "declare")
        self.cfg.update(mode="secondary", project=dict({"id": "old-proj", "waitMinutes": 0.02, "pollSeconds": 0.2}, **project))
        self.cfg["prereq"] = {}
        self.cfg.pop("c14d")
        self.cfg["mac"]["vault"] = [str(HERE.parent.parent / "bin" / "vault")]
        self.cfg["server"].update(tree="", rejectRel="reject.json", store="new-store")
        self.d = self.driver()

    def install_gate(self):
        hook = self.repo / ".git/hooks/pre-commit"
        hook.write_text("#!/bin/sh\n# kuma-vault-sync-hook — regenerate via: vault hook install --root <tree>\nexit 0\n")
        hook.chmod(0o755)

    def server_pre_secondary(self, *args, **kw):
        return 0, {"storeAbsent": "true", "configValid": "true", "backupConfigured": "true", "workMounts": "0",
                   "leftovers": "0", "workDirForeign": "false", "toolsMatch": "true", "filterRepo": "true",
                   "engineLists": "true"}, {}

    def test_ref_violations(self):
        ok = ["refs/heads/main commit", "HEAD refs/heads/main"]
        self.assertEqual(ref_violations(ok, "main"), [])
        self.assertEqual(ref_violations(ok + ["refs/agent/checkpoints/1 tree"], "main"), ["refs/agent/checkpoints/1 (tree)"])
        self.assertEqual(ref_violations(["refs/heads/master commit", "HEAD refs/heads/master"], "main"),
                         ["refs/heads/master (commit)", "HEAD is refs/heads/master, not refs/heads/main",
                          "refs/heads/main missing or not a commit"])
        self.assertIn("HEAD is detached, not refs/heads/main", ref_violations(["refs/heads/main commit", "HEAD detached"], "main"))
        self.assertTrue(ref_violations(ok + ["refs/heads/docs/x commit", "refs/stash commit"], "main"))

    def test_tree_ref_is_a_pre_nogo_and_a_step4_drift(self):
        self.version_stub()
        self.d.step_pre()
        tree = self.git("rev-parse", "HEAD^{tree}").stdout.strip()
        self.git("update-ref", "refs/agent/checkpoints/1", tree)
        with self.assertRaisesRegex(NoGo, r"ref: refs/agent/checkpoints/1 \(tree\)"):
            self.d.step_pre()
        # a ref that appears after pre: step 4 reads it on the server copy
        self.d.values()["HEAD_final"] = self.git("rev-parse", "HEAD").stdout.strip()
        self.d.copy_snapshot = lambda: None
        self.d.freeze_pathspec = lambda: ["."]
        self.d.gate = lambda s: (0, {})
        self.d.wait_3b = lambda: None
        run = self.d.run
        self.d.run = lambda argv, **kw: (0, "") if "--itemize-changes" in argv else run(argv, **kw)
        self.d.server = lambda *a, **k: (0, {"serverHead": self.d.values()["HEAD_final"]},
                                         {"refs": ["refs/heads/main commit", "refs/agent/checkpoints/1 tree", "HEAD refs/heads/main"]})
        with self.assertRaisesRegex(StepFailed, "refs on the server copy"):
            self.d.step_4()

    def test_hand_written_ignore_line_is_not_enough(self):
        """A safety net that is only a hand-written root .gitignore line does not count."""
        probe = "intake/r1/a/source/app.py"
        hand = "intake/**/source/\n"
        self.assertEqual(generated_ignore_misses(hand, [probe]), [probe])
        block = ("# >>> kuma-vault generated: binaries.reject — intermediates live outside the vault (vault binaries apply) >>>\n"
                 "intake/**/source/\n# <<< kuma-vault generated: binaries.reject <<<\n")
        self.assertEqual(generated_ignore_misses(hand + block, [probe, "intake/r1/a/notes.md"]), ["intake/r1/a/notes.md"])

    def test_engine_generated_gitignore_keeps_cloned_source_out(self):
        """`vault binaries apply` writes the reject list into the generated block (the hand-written
        line stays too); after it, git does not stage a file in that place and the probe passes."""
        top = self.root / "gen"
        command("git", "init", "-q", "-b", "main", str(top))
        (top / "vault.config.json").write_text('{"id": "x", "profile": "kuma-vault"}\n')
        (top / ".gitignore").write_text("# safety net\nintake/**/source/\n")
        (top / "reject.json").write_text('{"reject": ["intake/**/source/"]}\n')
        command(str(HERE.parent.parent / "bin" / "vault"), "binaries", "apply", "--from", str(top / "reject.json"), "--root", str(top))
        text = (top / ".gitignore").read_text()
        self.assertIn("# safety net\nintake/**/source/\n", text)
        self.assertEqual(generated_ignore_misses(text, ["intake/r1/a/source/app.py"]), [])
        # the hand-written line removed: the generated block alone keeps the code out
        (top / ".gitignore").write_text(text.replace("# safety net\nintake/**/source/\n", ""))
        leak = top / "intake/r1/a/source/app.py"
        leak.parent.mkdir(parents=True)
        leak.write_text("print('cloned')\n")
        command("git", "-C", str(top), "add", "-A")
        staged = command("git", "-C", str(top), "diff", "--cached", "--name-only").stdout.split()
        self.assertNotIn("intake/r1/a/source/app.py", staged)
        self.assertIn(".gitignore", staged)

    def test_secondary_pre_needs_gate_declaration_and_generated_ignore(self):
        self.secondary()
        self.cfg["server"]["mustIgnore"] = ["intake/r1/a/source/app.py"]
        self.d = self.driver()
        self.d.server = self.server_pre_secondary
        (self.repo / ".gitignore").write_text("intake/**/source/\n")       # hand-written only
        (self.repo / "reject.json").write_text('{"reject": ["scratch/"]}\n')
        with self.assertRaises(NoGo) as caught:
            self.d.step_pre()
        why = " | ".join(caught.exception.reasons)
        self.assertIn("no vault commit gate", why)
        self.assertIn("mustIgnore place not in the generated reject block: intake/r1/a/source/app.py", why)
        self.install_gate()
        (self.repo / "reject.json").write_text('{"reject": ["scratch/", "intake/**/source/"]}\n')
        self.d.step_pre()                                                     # c14d absent: secondary has none
        self.assertEqual(self.d.values()["freezeStore"], "old-store")
        self.assertEqual(self.d.values()["mustIgnorePre"], {"probes": 1, "missing": []})

    def test_secondary_freeze_names_the_old_store(self):
        self.secondary()
        self.d.values()["freezeStore"] = "old-store"
        self.d.step_1()
        self.assertEqual(json.loads(Path(self.cfg["mac"]["freezeFile"]).read_text())["store"], "old-store")

    def status_table(self, rows):
        f = self.root / "status.tsv"
        f.write_text("PROJECT\tMEMBER\tSTATUS\tPREVIEW\n" + "".join("%s\t%s\t%s\t-\n" % r for r in rows) + "\nParked: none\n")
        return [sys.executable, "-c", "print(open(%r).read(), end='')" % str(f)]

    def test_secondary_step2_freezes_one_project_never_the_runtime(self):
        log = self.root / "events"
        rec = lambda w: [sys.executable, "-c", "open(%r, 'a').write(%r)" % (str(log), w + "\n")]
        self.secondary(freezeCommands=[rec("disconnect"), rec("pause")], undoCommands=[rec("reconnect")])
        self.cfg["core"] = {"stopCmd": " ".join(rec("STOP-CORE")) , "startCmd": rec("START-CORE")}
        self.cfg["project"]["statusCmd"] = self.status_table([("other", "a", "working"), ("old-proj", "b", "idle")])
        self.d = self.driver()
        self.d.step_2()
        self.assertEqual(log.read_text(), "disconnect\npause\n")
        self.assertTrue(self.d.values()["projectFrozen"])
        # a re-run does not repeat the freeze commands; a working member of the project fails the step
        self.cfg["project"]["statusCmd"] = self.status_table([("old-proj", "b", "working (sniffing)")])
        self.d.cfg = self.cfg
        self.d.project = self.cfg["project"]
        self.d.values().pop("projectFrozen")
        with self.assertRaisesRegex(StepFailed, r"old-proj: 1 working session\(s\) \['b'\]"):
            self.d.step_2()
        self.assertEqual(log.read_text(), "disconnect\npause\n")
        self.d.state["steps"] = {"2": {"status": "failed"}}
        self.assertEqual(self.d.rollback("2", "no-go"), "no-go")
        self.assertEqual(log.read_text(), "disconnect\npause\nreconnect\n")       # never STOP-CORE / START-CORE

    def test_configured_commands_get_home_expanded(self):
        self.cfg["mac"]["daemonInstall"] = [["vault", "sync", "install", "--repo", "~/.kuma/vaults/x"]]
        self.cfg["mac"]["backupRetarget"] = ["echo ~"]
        self.d = self.driver()
        seen = []
        self.d.run = lambda argv, **kw: (seen.append(argv), (0, ""))[1]
        self.d.core_start = lambda: None
        self.d.step_11()
        self.assertEqual(seen[0][-1], os.path.expanduser("~/.kuma/vaults/x"))
        self.assertEqual(seen[1], "echo ~")
        self.assertEqual(expand_cmd(["~/a", 3]), [os.path.expanduser("~/a"), 3])

    def test_alarms_are_judged_after_the_freeze_release(self):
        fz = Path(self.cfg["mac"]["freezeFile"])
        fz.write_text('{"id": "test"}')
        self.cfg["smoke"] = {"alarmsWaitSeconds": 3, "alarmsPollSeconds": 0.1}
        self.d = self.driver()
        calls = []

        def vault(*args, **kw):
            calls.append(args[:2])
            if args[:2] == ("sync", "status"):
                frozen = fz.exists()
                return 0, json.dumps({"alerts": {}, "problems": ["autosave blocked by the freeze"] if frozen else []})
            return 0, ""
        self.d.vault = vault
        self.d.server = lambda block, *a, **k: (calls.append(("server", block)), (0, {}, {}))[1]
        self.d.step_13()
        self.assertFalse(fz.exists())
        self.assertTrue(self.d.values()["alarms"]["ok"])
        self.assertEqual(calls[-1], ("server", "s13-cleanup"))
        # an alarm that stays on halts before the old server copy is deleted
        calls.clear()
        self.d.vault = lambda *a, **k: (0, json.dumps({"alerts": {"uncollected": {"active": True}}, "problems": []})) \
            if a[:2] == ("sync", "status") else (0, "")
        with self.assertRaisesRegex(StepFailed, "alarms after the freeze release"):
            self.d.step_13()
        self.assertNotIn(("server", "s13-cleanup"), calls)

    def test_smoke_commit_waits_out_a_held_index_lock(self):
        """The daemon's autosave holds the index lock for a moment; the smoke commit must not fail on it."""
        (self.repo / "log.md").write_text("line\n")
        lock = self.repo / ".git/index.lock"
        lock.write_text("")
        t = threading.Timer(0.7, lock.unlink)
        t.start()
        try:
            self.assertGreaterEqual(self.d.git_index(str(self.repo), "add", "--", "log.md", pause=0.2), 1)
        finally:
            t.join()
        self.assertEqual(self.git("diff", "--cached", "--name-only").stdout.split(), ["log.md"])
        started = time.monotonic()
        with self.assertRaisesRegex(StepFailed, "exit 128: git add -- no-such-file"):   # not a lock: no retry
            self.d.git_index(str(self.repo), "add", "--", "no-such-file")
        self.assertLess(time.monotonic() - started, 2)
        lock.write_text("")                                                              # a lock nobody releases
        with self.assertRaisesRegex(StepFailed, "exit 128: git add"):
            self.d.git_index(str(self.repo), "add", "--", "log.md", tries=3, pause=0.05)
        lock.unlink()

    def test_smoke_waits_for_the_daemon_before_it_nudges(self):
        answers = iter(['{"daemon": {"running": false}}', "not json", '{"daemon": {"running": true, "pid": 4242}}'])
        self.d.vault = lambda *a, **k: (0, next(answers))
        with patch("driver.time.sleep", lambda s: None):
            self.assertEqual(self.d.wait_daemon(str(self.repo), 30), (True, {"pid": 4242}))
        self.d.vault = lambda *a, **k: (2, '{"daemon": {"running": false}}')
        self.assertEqual(self.d.wait_daemon(str(self.repo), 0), (False, {"pid": None}))

    def test_smoke_reads_the_log_page_back_and_never_searches(self):
        """Step 12 reads its log page back with vault get (the real engine); vault search is gone."""
        self.cfg["mac"]["vault"] = [str(HERE.parent.parent / "bin" / "vault")]
        self.cfg["smoke"] = {"planFile": None, "logFile": "vault/_smoke/log.md", "commits": 0,
                             "blobPath": None, "bigPath": None, "rejectPath": None}
        self.d = self.driver()
        log = Path(self.cfg["mac"]["newClone"]) / "vault/_smoke/log.md"
        log.parent.mkdir(parents=True)
        log.write_text("c8 smoke commit 1 a\nc8 smoke commit 2 b\n\n")
        calls, real = [], self.d.vault

        def vault(*args, **kw):
            calls.append(args)
            return real(*args, **kw)
        self.d.vault = vault
        self.d.wait_daemon = lambda nc, wait: (True, {"pid": 4242})
        self.d.step_12()
        smoke = self.d.values()["smoke"]
        self.assertEqual(smoke["read"], {"ok": True, "rc": 0, "path": "_smoke/log.md"})
        self.assertNotIn("search", smoke)
        self.assertEqual(calls, [("--vault-dir", str(log.parent.parent), "get", "_smoke/log.md")])
        # the page is not there: the smoke fails on the read, still without a search
        log.unlink()
        calls.clear()
        with self.assertRaisesRegex(StepFailed, r"smoke failed: read$"):
            self.d.step_12()
        self.assertEqual(calls, [])
        # a log page outside the tree is a failed read, not a read of some other file
        self.cfg["smoke"]["logFile"] = "_smoke/log.md"
        self.d = self.driver()
        self.d.wait_daemon = lambda nc, wait: (True, {"pid": 4242})
        with self.assertRaisesRegex(StepFailed, r"smoke failed: read$"):
            self.d.step_12()
        self.assertIn("outside the tree", self.d.values()["smoke"]["read"]["error"])

    def test_config_for_the_search_engine_is_a_nogo_before_the_freeze(self):
        """searchQuery and store --search would fail after the freeze (steps 10 and 12): pre refuses them."""
        for name in ("config.example.json", "config.secondary.example.json"):
            self.assertEqual(retired_config(json.loads((HERE / name).read_text())), [], name)
        self.secondary()
        self.install_gate()
        self.cfg["smoke"] = {"logFile": "_smoke/log.md", "searchQuery": None}
        self.cfg["mac"]["storeCommands"] = [["store", "set", "new-store", "--mode", "remote", "--search", "remote"]]
        self.d = self.driver()
        self.d.server = self.server_pre_secondary
        with self.assertRaises(NoGo) as caught:
            self.d.step_pre()
        self.assertEqual([r for r in caught.exception.reasons if "search" in r], [
            "smoke.searchQuery: vault search was removed (step 12 reads the log page back instead); delete the key",
            "mac.storeCommands: vault store no longer takes --search; drop it from store set new-store"])
        self.assertFalse(Path(self.cfg["mac"]["freezeFile"]).exists())
        del self.cfg["smoke"]["searchQuery"]
        self.cfg["mac"]["storeCommands"][0][-2:] = []
        self.d = self.driver()
        self.d.server = self.server_pre_secondary
        self.d.step_pre()

    def test_launchd_refuses_a_gone_or_too_close_start(self):
        import datetime as dt
        now = dt.datetime(2026, 10, 4, 18, 44, 30)
        for at in (dt.datetime(2026, 10, 4, 18, 44), dt.datetime(2026, 10, 4, 18, 45)):
            with self.assertRaises(SystemExit):
                refuse_start(at, now)
        refuse_start(dt.datetime(2026, 10, 4, 18, 46), now)

    def test_junk_names_stay_out_tracked_ones_are_copied(self):
        patterns = ['.fts/', '*.commit-lock', '*.tmp', '*.tmp.*', '__pycache__/', '*.pyc', '.DS_Store']
        sys.path.insert(0, str(HERE.parent / "brain-rewrite"))
        import brainrw
        regexes = [brainrw.gitignore_regex(p) for p in patterns]
        (self.repo / "a/.fts").mkdir(parents=True)
        (self.repo / "a/.fts/tracked.json").write_text("t")
        (self.repo / "we[ir]d*.tmp").write_text("t")
        (self.repo / "note.md").write_text("n")
        self.git("--literal-pathspecs", "add", "-f", "a/.fts/tracked.json", "we[ir]d*.tmp", "note.md")
        self.git("commit", "-q", "-m", "tracked junk")
        tracked = [p for p in self.git("ls-files", "-z").stdout.split("\0") if p]
        args = junk_filter_args(patterns, regexes, tracked)
        stop = threading.Event()

        def churn():                                  # lock and temporary files that come and go
            n = 0
            while not stop.is_set():
                for name in ("a/.fts/tmp-%d" % n, "x.commit-lock", "w%d.tmp" % n, "b/.DS_Store"):
                    p = self.repo / name
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_bytes(os.urandom(4096))
                    p.unlink()
                n += 1
        t = threading.Thread(target=churn)
        t.start()
        dst = self.root / "copy"
        try:
            for _ in range(10):
                command("rsync", "-a", "--delete", *args, str(self.repo) + "/", str(dst) + "/")
        finally:
            stop.set()
            t.join()
        (self.repo / "a/.fts/untracked.db").write_text("u")
        (self.repo / "keep.commit-lock").write_text("u")
        command("rsync", "-a", "--delete", *args, str(self.repo) + "/", str(dst) + "/")
        self.assertTrue((dst / "a/.fts/tracked.json").exists())
        self.assertTrue((dst / "we[ir]d*.tmp").exists())
        self.assertTrue((dst / "note.md").exists())
        self.assertFalse((dst / "a/.fts/untracked.db").exists())
        self.assertFalse((dst / "keep.commit-lock").exists())
        self.assertEqual(command("git", "-C", str(dst), "status", "--porcelain").stdout, "")


if __name__ == "__main__":
    unittest.main()
