"""Real-Git coverage for the generated root attributes exception; run on server scratch."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parents[1] / "brain-rewrite"
sys.path.insert(0, str(TOOLS))
import brainrw as B


class Stage8RootAttributes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.old = self.base / "old"
        self.clone = self.base / "clone"
        self.run = self.base / "run"
        self.run.mkdir()
        self.env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null",
                        GIT_AUTHOR_NAME="fixture", GIT_AUTHOR_EMAIL="fixture@example.test",
                        GIT_COMMITTER_NAME="fixture", GIT_COMMITTER_EMAIL="fixture@example.test")
        self.git(self.base, "init", "-q", "-b", "master", str(self.old))
        (self.old / "note.md").write_text("retained text\n")
        (self.old / "nested").mkdir()
        (self.old / "nested/.gitattributes").write_text("*.md text\n")
        (self.run / "delete-paths.txt").write_text("")
        (self.run / "final-map.tsv").write_bytes(B.FM_HEADER)

    def git(self, repo, *args):
        return subprocess.check_output(["git", "-C", str(repo), *args], env=self.env,
                                       stderr=subprocess.PIPE)

    def prepare(self, existing=True):
        if existing:
            (self.old / ".gitattributes").write_text("*.txt text\n")
        self.git(self.old, "add", "-A")
        self.git(self.old, "commit", "-qm", "source")
        self.git(self.base, "clone", "-q", "--no-local", str(self.old), str(self.clone))
        (self.clone / ".gitattributes").write_text("*.png filter=lfs diff=lfs merge=lfs -text\n")
        self.git(self.clone, "add", ".gitattributes")
        self.git(self.clone, "commit", "-qm", "generated attributes")
        p = self.git(self.clone, "rev-parse", "HEAD").decode().strip()
        (self.run / "pointer-commit.json").write_text(json.dumps({"p": p}))

    def compare(self, ok, fragment=None):
        report = self.base / "report.json"
        p = subprocess.run([sys.executable, str(TOOLS / "stage8_compare.py"),
                            "--old-worktree", str(self.old), "--clone", str(self.clone),
                            "--run", str(self.run), "--report", str(report)],
                           env=self.env, capture_output=True, text=True)
        data = json.loads(report.read_text())
        self.assertEqual(p.returncode, 0 if ok else 1, data)
        self.assertEqual(data["ok"], ok)
        if fragment:
            self.assertTrue(any(fragment in e for e in data["errors"]), data)

    def test_existing_root_attributes_are_generated(self):
        self.prepare()
        self.compare(True)

    def test_absent_root_attributes_are_generated(self):
        self.prepare(existing=False)
        self.compare(True)

    def test_real_text_change_is_still_rejected(self):
        self.prepare()
        (self.old / "note.md").write_text("changed\n")
        self.compare(False, "text files differ")

    def test_nested_attributes_are_not_exempt(self):
        self.prepare()
        (self.old / "nested/.gitattributes").write_text("*.md -text\n")
        self.compare(False, "text files differ")

    def test_other_old_only_file_is_still_rejected(self):
        self.prepare()
        (self.old / "new.md").write_text("must be preserved\n")
        self.compare(False, "text path sets differ")

    def test_checkout_attributes_tampering_is_still_rejected(self):
        self.prepare()
        (self.clone / ".gitattributes").write_text("tampered\n")
        self.compare(False, "clone:")


if __name__ == "__main__":
    unittest.main()
