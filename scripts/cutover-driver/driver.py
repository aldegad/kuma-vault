#!/usr/bin/env python3
"""Cutover driver: runs the vault cutover (design 5.6 steps 0-13b, rollback 5.7) without an
orchestrator. Step 2 stops the agent runtime (and with it every agent session), so the steps
after it cannot be run by an agent; this program runs them, outside that runtime, from a work
directory outside the vault and the engine checkout (steps 9-10 move the vault paths).

  driver.py run      --config <c8.json> [--stop-after <step>]
  driver.py status   --config <c8.json>
  driver.py stage    --config <c8.json>          copy driver + config into workDir, print the run line
  driver.py launchd  render|install|uninstall --config <c8.json> --at <YYYY-MM-DDTHH:MM> [--window-minutes N]
  driver.py launch   --config <c8.json> --label <label> --at <...> --window-minutes N   (launchd entry)

Every step is written to state.json (status running, time) before it runs and gets its exit
code after; a re-run skips the steps that are done and re-runs an interrupted one from a clean
slate. Failure of steps 3-10 runs the undo of every step that ran, newest first (5.7 "after 3 -
before 10"); 0-2 only drop the freeze file and start the runtime again (5.7 first row). After 10
the driver does not roll back: it starts the runtime, keeps the freeze file and stops ("halted").

Python 3.9 standard library only (the system python3 of macOS).
"""

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
STEPS = ["pre", "0", "1", "2", "3", "3b", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "13b"]
SERVER_STEPS = {"5", "6", "7", "8"}             # steps whose server work 5.7 row 2 undoes
EXIT = {None: 0, "success": 0, "no-go": 3, "rolled-back": 4, "halted": 5, "rollback-incomplete": 6}
# first words of the `kuma status` STATUS column that are not a session at work
NOT_WORKING = {"idle", "completed", "needs-you", "error", "offline"}
NEW_ATTEMPT_AFTER = {"no-go", "rolled-back", "missed-window"}
FREEZE_MESSAGE = "vault-migrate: freeze snapshot (text only)"
VERSION_TIMEOUT_SECONDS = 300


def rsync_changes(items):
    """Only a permission-only symlink item is platform noise (short or GNU format)."""
    changed, noise = [], []
    for line in items.splitlines():
        if line.strip():
            (noise if re.match(r"^\.L\.\.\.p\.+ ", line) else changed).append(line)
    return changed, {"count": len(noise), "samples": noise[:5]}


class StepFailed(Exception):
    pass


class NoGo(Exception):
    def __init__(self, reasons):
        super().__init__("; ".join(reasons))
        self.reasons = reasons


def now_iso():
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def expand(p):
    return os.path.expanduser(p) if isinstance(p, str) else p


def write_json_atomic(path, data):
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def b64file(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class Driver:
    def __init__(self, config_path):
        self.config_path = os.path.abspath(config_path)
        self.cfg = read_json(self.config_path)
        if self.cfg is None:
            raise SystemExit("config not found: %s" % config_path)
        c = self.cfg
        self.work = expand(c["workDir"])
        self.mac = c["mac"]
        self.srv = c["server"]
        self.core = c.get("core", {})
        os.makedirs(os.path.join(self.work, "logs"), exist_ok=True)
        os.makedirs(os.path.join(self.work, "reports"), exist_ok=True)
        self.state_path = os.path.join(self.work, "state.json")
        self.state = read_json(self.state_path)
        self.log_path = os.path.join(self.work, "logs", "driver.log")
        self.step_log = self.log_path
        self.env = dict(os.environ)
        self.env.update({k: expand(v) for k, v in c.get("env", {}).items()})
        self.env.update({k: expand(v) for k, v in self.mac.get("env", {}).items()})

    # --- state and logs -------------------------------------------------------------------

    def save(self):
        write_json_atomic(self.state_path, self.state)

    def log(self, msg):
        line = "%s %s" % (now_iso(), msg)
        for p in {self.log_path, self.step_log}:
            with open(p, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        print(line, flush=True)

    def values(self):
        return self.state.setdefault("values", {})

    def step_state(self, name):
        return self.state["steps"].setdefault(name, {})

    # --- running commands -----------------------------------------------------------------

    def run(self, argv, check=True, env=None, cwd=None, input_text=None, timeout=None, quiet=False):
        """Run argv (list, or str for sh -c); log the command and its output; return (rc, stdout)."""
        e = dict(self.env)
        if env:
            e.update(env)
        shell = isinstance(argv, str)
        shown = argv if shell else " ".join(shlex.quote(a) for a in argv)
        if not quiet:
            self.log("$ %s" % shown[:600])
        with open(self.step_log, "a", encoding="utf-8") as lf:
            p = subprocess.Popen(argv if not shell else ["/bin/sh", "-c", argv], env=e, cwd=cwd,
                                 stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=lf, start_new_session=False)
            try:
                out, _ = p.communicate(input_text.encode() if input_text is not None else None, timeout=timeout)
            except subprocess.TimeoutExpired:
                p.kill()
                out, _ = p.communicate()
                rc = 124
            else:
                rc = p.returncode
            text = out.decode("utf-8", "replace")
            if text and not quiet:
                lf.write(text if len(text) < 20000 else text[:20000] + "\n…(cut)\n")
        if check and rc != 0:
            raise StepFailed("exit %d: %s" % (rc, shown[:300]))
        return rc, text

    def git(self, repo, *args, **kw):
        return self.run([self.mac.get("git", "git"), "-C", repo] + list(args), **kw)

    def vault(self, *args, **kw):
        return self.run([expand(a) for a in self.mac["vault"]] + list(args), **kw)

    # --- server blocks --------------------------------------------------------------------

    def server_env(self, extra=None):
        s = self.srv
        bk = s.get("backup", {})
        env = {
            "T": s["work"], "O": s["snapshot"], "ENGINE_LINK": s.get("engineLink", "/opt/kuma-vault/current"),
            "VAULTS": s.get("vaultsDir", "/data/vaults"), "STORE": s["store"], "OWNER": s["owner"],
            "ALLOWED_REMOTE": s["allowedRemote"], "TREE": s.get("tree", "vault"), "MAPREL": s["commitMapRel"],
            "REJECTREL": s["rejectRel"], "XRREL": s["extraDeletePathsRel"],
            "SERVER_CONFIG": s.get("serverConfig", "/etc/kuma-vault/server.json"),
            "SERVE_USER": s.get("serveUser", "kuma-vault"), "ADMIN_USER": s.get("adminUser", "ubuntu"),
            "NODE_BIN": s.get("nodeBin", "/opt/node/current/bin"),
            "HEALTH_URL": s.get("healthUrl", "http://127.0.0.1:7741/v1/health"),
            "FILTER_REPO_SRC": s["filterRepo"], "WORK_ROOT": s.get("workRoot", "/data/work"),
            "RECEIPTS": s["receipts"], "IGNORE_TOKEN_IDS": json.dumps(s.get("ignoreTokenIds", [])),
            "CLEAN_ABSENT": " ".join(s.get("cleanAbsent", [])),
            "C8_ATTEMPT": str(self.state.get("attempt", 0)) if self.state else "0",
            "BACKUP_REPOSITORY": bk.get("repository", ""), "BACKUP_HOST": bk.get("host") or "",
            "BACKUP_CRED_DIR": bk.get("credentialsDir", "/etc/kuma-vault/credentials"),
            "BACKUP_CRED_FILES": " ".join(bk.get("credentialFiles", [])),
            "BACKUP_INIT_LOCAL": "1" if bk.get("initLocalRepository") else "0",
        }
        env.update(extra or {})
        return env

    def server(self, block, extra=None, check=True):
        """Run server/<block>.sh on the server. Returns (rc, outputs dict, sections dict)."""
        env = self.server_env(extra)
        env["C8_BLOCK"] = block
        standin = self.srv.get("standin")
        self.log("server block %s" % block)
        if standin:
            rc, out = self.run(["bash", expand(standin), block], env=env, check=False)
        else:
            with open(os.path.join(HERE, "server", "common.sh"), encoding="utf-8") as f:
                common = f.read()
            with open(os.path.join(HERE, "server", block + ".sh"), encoding="utf-8") as f:
                body = f.read()
            exports = "".join("export %s=%s\n" % (k, shlex.quote(v)) for k, v in env.items())
            # The block runs in its own session (setsid) so that a driver killed mid-block leaves
            # a process group the next run can find and stop before it starts again.
            script = (
                "set -euo pipefail\n" + exports +
                'G=/tmp/c8-guard-$(basename "$T"); mkdir -p "$G"\n'
                'if [ -f "$G/pgid" ]; then pg=$(cat "$G/pgid")\n'
                '  if kill -0 -- "-$pg" 2>/dev/null; then echo "c8: stopping the previous block (group $pg)" >&2\n'
                '    kill -TERM -- "-$pg" 2>/dev/null || true; sleep 5; kill -KILL -- "-$pg" 2>/dev/null || true; fi\n'
                '  rm -f "$G/pgid"; fi\n'
                "cat > \"$G/block.sh\" <<'C8_BLOCK_EOF'\n" + exports +
                'echo $$ > "/tmp/c8-guard-$(basename "$T")/pgid"\n' + common + "\n" + body + "\nC8_BLOCK_EOF\n"
                'rc=0; setsid -w bash "$G/block.sh" < /dev/null || rc=$?\n'
                'rm -f "$G/pgid"; exit "$rc"\n')
            ssh = self.srv.get("ssh")
            argv = (["ssh", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=6",
                     ssh, "bash", "-s"] if ssh else ["bash", "-s"])
            rc, out = self.run(argv, input_text=script, check=False)
        outputs, sections, cur = {}, {}, None
        for line in out.splitlines():
            if line.startswith("C8OUT ") and "=" in line:
                k, v = line[6:].split("=", 1)
                outputs[k] = v
            elif line.startswith("C8BEGIN "):
                cur = line[8:].strip()
                sections[cur] = []
            elif line.startswith("C8END "):
                cur = None
            elif cur:
                sections[cur].append(line)
        if outputs:
            self.log("server %s -> %s" % (block, json.dumps(outputs, ensure_ascii=False)))
        if check and rc != 0:
            raise StepFailed("server block %s exit %d" % (block, rc))
        return rc, outputs, sections

    # --- runtime (agent sessions) ---------------------------------------------------------

    def core_alive(self):
        cmd = self.core.get("aliveCmd")
        if not cmd:
            return False
        rc, _ = self.run(cmd, check=False, timeout=60, quiet=True)
        return rc == 0

    def working_sessions(self):
        """The `kuma status` table read for step 2: (readable, rows that count as working, unknown).

        The STATUS column is a state word with decorations after it: ` (<source>)` when the verdict
        is not from a hook, ` [reap:…]` when a reap is scheduled (renderStatus in the runtime CLI).
        The first word decides. A first word outside the known set (including `unknown:<word>`,
        which the CLI prints for a server verdict it does not know) counts as working and is listed
        in `unknown`: step 2 stops the runtime after the wait either way, so counting it only makes
        the wait longer and puts the session in sessionsCutAtStop, where a person sees it. A table
        that does not start with the header is not readable, and an unreadable table never ends
        the wait early."""
        rc, out = self.run(self.core.get("statusCmd", ["kuma", "status"]), check=False, timeout=120, quiet=True)
        lines = out.splitlines()
        if rc != 0 or not lines or lines[0].split("\t")[:3] != ["PROJECT", "MEMBER", "STATUS"]:
            return False, [], []
        rows, unknown = [], []
        for line in lines[1:]:
            if not line.strip():
                break                                   # the table ends at the first blank line
            cols = line.split("\t")
            status = cols[2].strip() if len(cols) >= 3 else ""
            word = status.split()[0] if status else ""
            if word in NOT_WORKING:
                continue
            row = {"project": cols[0], "member": cols[1] if len(cols) > 1 else "", "status": status}
            if word != "working":
                unknown.append(row)
            rows.append(row)
        return True, rows, unknown

    def core_state(self):
        """`kuma control status` core line: "up", "stopped" (down, no pid, no listener) or the line itself."""
        rc, out = self.run(self.core.get("controlStatusCmd", ["kuma", "control", "status"]), check=False, timeout=120,
                           quiet=True)
        m = re.search(r"(?m)^core: (.*)$", out)
        line = m.group(1).strip() if m else "(exit %d, no core line)" % rc
        if re.match(r"up\b", line):
            return "up", line
        if re.match(r"down \(stopped\)", line):
            return "stopped", line
        return "other", line

    def core_start(self):
        cmd = self.core.get("startCmd")
        if cmd:
            self.run(cmd, timeout=900)
            self.values()["coreStarted"] = now_iso()
            self.save()

    # --- paths ----------------------------------------------------------------------------

    def tools(self):
        return os.path.join(expand(self.mac["engine"]), "scripts", "brain-rewrite")

    def freeze_pathspec(self):
        _, out = self.run(["python3", "-c", "import sys; sys.path.insert(0, %r); import brainrw; "
                           "print('\\n'.join(brainrw.freeze_pathspec()))" % self.tools()], quiet=True,
                          env={"PYTHONDONTWRITEBYTECODE": "1"})
        return [s for s in out.splitlines() if s]

    def rsync_dest(self):
        ssh = self.srv.get("ssh")
        o = self.srv["snapshot"].rstrip("/") + "/"
        return "%s:%s" % (ssh, o) if ssh else o

    def rsync_base(self):
        return ["nice", self.mac.get("rsync", "rsync"), "-a", "--delete"]

    def maintenance_reasons(self, repo):
        """Read effective config, including Git's defaults; never change the source config."""
        why, values = [], {}
        for key, kind, default, want in (("gc.auto", "int", "6700", "0"),
                                         ("maintenance.auto", "bool", "true", "false")):
            rc, out = self.git(repo, "config", "--" + kind, "--get", key, check=False)
            value = default if rc == 1 else out.strip()
            values[key] = value
            if rc not in (0, 1):
                why.append("cannot read effective %s (exit %d)" % (key, rc))
            elif value != want:
                why.append("effective %s = %s (require %s)" % (key, value, want))
        self.values()["sourceMaintenance"] = values
        return why

    def check_gc_pid(self):
        path = os.path.join(expand(self.mac["repo"]), ".git", "gc.pid")
        try:
            with open(path, encoding="utf-8") as f:
                fields = f.read().split()
        except FileNotFoundError:
            return
        if len(fields) != 2 or not fields[0].isdigit() or int(fields[0]) <= 0:
            raise StepFailed("cannot establish gc.pid liveness: invalid lock in %s" % path)
        pid, host = int(fields[0]), fields[1]
        if host != socket.gethostname():
            raise StepFailed("cannot establish gc.pid liveness on host %s" % host)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        except PermissionError:
            pass  # a process we cannot signal is still alive
        raise StepFailed("live gc.pid %d on %s; refusing rsync" % (pid, host))

    def copy_snapshot(self):
        # With automatic maintenance disabled, objects only accumulate. Copy refs first,
        # then enumerate objects, so every copied ref's objects are included even with writers.
        src, dst = expand(self.mac["repo"]).rstrip("/") + "/", self.rsync_dest()
        self.check_gc_pid()
        self.run(self.rsync_base() + ["--exclude=/.git/objects/", src, dst], timeout=6 * 3600)
        self.check_gc_pid()
        self.run(self.rsync_base() + [src + ".git/objects/", dst + ".git/objects/"], timeout=6 * 3600)

    # --- the steps ------------------------------------------------------------------------

    def step_pre(self):
        """Prerequisites 2-5 and 7 + the intermediates gate (c14d), judged by machine. Nothing changes on a no-go
        (the server work directory this attempt created is removed again)."""
        v, why = self.values(), []
        m, pre = self.mac, self.cfg.get("prereq", {})
        # a configuration with a value still to fill in never starts a night
        with open(self.config_path, encoding="utf-8") as f:
            todo = sorted(set(re.findall(r"TODO[^\"]*", f.read())))
        if todo:
            why.append("config has unfilled values: %s" % todo[:5])
        repo = expand(m["repo"])
        # the driver must not run from a place steps 9-10 move
        for p in [repo, expand(m["newClone"])] + [expand(l["path"]) for l in m.get("links", [])]:
            rp = os.path.realpath(p)
            if os.path.realpath(HERE).startswith(rp.rstrip("/") + "/") or self.work.startswith(rp.rstrip("/") + "/"):
                why.append("driver or workDir inside %s" % p)
        if os.path.exists(expand(m["freezeFile"])):
            why.append("freeze file already exists: %s" % m["freezeFile"])
        if os.path.lexists(expand(m["newClone"])):
            why.append("new clone path already exists: %s" % m["newClone"])
        if os.path.lexists(repo + ".pre-cutover"):
            why.append("%s.pre-cutover already exists" % m["repo"])
        if not os.path.isdir(os.path.join(repo, ".git")):
            why.append("old repo is not a git work tree: %s" % m["repo"])
        else:
            why.extend(self.maintenance_reasons(repo))
        for l in m.get("links", []):
            if not os.path.islink(expand(l["path"])):
                why.append("not a symlink: %s" % l["path"])
        # 3: tools on the client (the engine checkout gate scripts come from)
        rc, _ = self.run(["shasum", "-a", "256", "-c", "--quiet", expand(m["toolsSha256"])], cwd=self.tools(), check=False)
        if rc != 0:
            why.append("client tools differ from %s" % m["toolsSha256"])
        # 5: the client backup routine change is on kuma-studio main
        studio = expand(m.get("kumaStudio", ""))
        if pre.get("studioBackupCommit"):
            rc, _ = self.git(studio, "merge-base", "--is-ancestor", pre["studioBackupCommit"], pre.get("studioMainRef", "main"), check=False)
            if rc != 0:
                why.append("kuma-studio %s does not contain %s" % (pre.get("studioMainRef", "main"), pre["studioBackupCommit"]))
        # 7: the installed app carries the landed runtime commit and is what runs
        c4c = pre.get("c4cLandedSha")
        if not c4c:
            why.append("prereq.c4cLandedSha not set")
        else:
            rc, out = self.run(pre.get("launcherVersionCmd", ["kuma", "control", "launcher-version", "--json"]), check=False, timeout=VERSION_TIMEOUT_SECONDS)
            if rc == 124:
                why.append("launcher-version timeout after %d seconds" % VERSION_TIMEOUT_SECONDS)
            elif rc != 0:
                why.append("launcher-version failed (exit %d)" % rc)
            try:
                lv = json.loads(out)
                inst, running = lv["installed"]["commit"], lv["running"]["commit"]
            except (ValueError, KeyError, TypeError):
                inst = running = None
                if rc == 0:
                    why.append("launcher-version gave no installed/running commit")
            if inst and rc == 0:
                v["installedAppCommit"], v["runningAppCommit"] = inst, running
                rc2, _ = self.git(studio, "merge-base", "--is-ancestor", c4c, inst, check=False)
                if rc2 != 0:
                    why.append("installed app %s does not contain %s (exit %d)" % (inst[:12], c4c, rc2))
                if running != inst:
                    why.append("running app %s != installed %s" % ((running or "?")[:12], inst[:12]))
            rc, out = self.run(pre.get("coreVersionCmd", ["kuma", "control", "core-version"]), check=False, timeout=VERSION_TIMEOUT_SECONDS)
            if rc == 124:
                why.append("core-version timeout after %d seconds" % VERSION_TIMEOUT_SECONDS)
            elif rc != 0 or not re.search(pre.get("coreVersionPattern", r"(?m)^CORE source: CURRENT\b"), out):
                why.append("core-version is not CURRENT")
        # what later steps need from this machine at this hour (e.g. a keychain read under launchd)
        for cmd in pre.get("checks", []):
            rc, _ = self.run(cmd, check=False, timeout=pre.get("checkTimeoutSeconds", 60), quiet=True)
            if rc != 0:
                why.append("check failed (exit %d): %s" % (rc, (cmd if isinstance(cmd, str) else " ".join(cmd))[:120]))
        # 3 and 4, server half (creates the work directory with the tool copy)
        _, o, _ = self.server("pre-server", {"TOOLS_SHA256_B64": b64file(expand(m["toolsSha256"]))}, check=False)
        v["serverPre"] = o
        self.save()
        expect = {"vaultsEntries": "0", "configClean": "true", "workMounts": "0", "leftovers": "0",
                  "workDirForeign": "false", "toolsMatch": "true", "filterRepo": "true", "engineLists": "true"}
        for k, want in expect.items():
            if o.get(k) != want:
                why.append("server %s = %s (want %s)" % (k, o.get(k), want))
        inst_sha = o.get("installedSha")
        if inst_sha:
            rc, _ = self.git(expand(m["engine"]), "merge-base", "--is-ancestor", inst_sha, pre.get("engineMasterRef", "master"), check=False)
            if rc != 0:
                why.append("server engine %s is not on %s" % (inst_sha, pre.get("engineMasterRef", "master")))
        if why:
            raise NoGo(why)
        # intermediates gate (c14d): the procedure (if configured), then the green test on its summary
        c14 = self.cfg.get("c14d", {})
        for cmd in c14.get("commands", []):
            self.run(cmd, timeout=c14.get("timeoutSeconds", 7200))
        summ = expand(c14.get("summary", ""))
        test = c14.get("jq", ".restore_total == [0,0] and (.gates | .G1_keep_missing == 0 and .G2_delete_on_mac_unguarded == 0 "
                       "and .G3_keep_x_reject == 0 and .G4_head_tracked_x_reject == 0 and .G5_clipless_raw_missing == 0 "
                       "and .G6_gone_not_in_step4_count == 0 and .G6_step4_still_on_mac == 0)")
        if not summ or not os.path.exists(summ):
            raise NoGo(["intermediates gate summary missing: %s" % c14.get("summary")])
        age_h = (time.time() - os.path.getmtime(summ)) / 3600
        if age_h > c14.get("maxAgeHours", 6):
            raise NoGo(["intermediates gate summary is %.1f h old" % age_h])
        rc, _ = self.run(["jq", "-e", test, summ], check=False)
        if rc != 0:
            raise NoGo(["intermediates gate not green (%s)" % summ])

    def gate(self, stage):
        out = os.path.join(self.work, "reports", "decision-%s.json" % stage)
        rc, _ = self.run(["python3", os.path.join(self.tools(), "cutover_gate.py"), "--config", expand(self.cfg["gate"]),
                          "--stage", stage, "--out", out], check=False, timeout=3600, env={"PYTHONDONTWRITEBYTECODE": "1"})
        d = read_json(out, {})
        self.values()["decision%s" % stage] = d
        self.save()
        return rc, d

    def step_0(self):
        rc, d = self.gate("0")
        if rc != 0:
            bad = [c["name"] for c in d.get("checks", []) if not c.get("go")]
            raise NoGo(["cutover-gate stage 0 exit %d %s %s" % (rc, bad, d.get("error", ""))])
        if d.get("method") != "full":
            raise NoGo(["rehearsal method %s: this driver runs the full rewrite only" % d.get("method")])
        self.copy_snapshot()
        self.server("s0-map")

    def step_1(self):
        fz = expand(self.mac["freezeFile"])
        v = self.values()
        cur = read_json(fz)
        if cur and cur.get("id") == v.get("freezeId"):
            return
        if cur:
            raise StepFailed("a foreign freeze file exists: %s" % fz)
        os.makedirs(os.path.dirname(fz), exist_ok=True)
        write_json_atomic(fz, {"id": v["freezeId"], "since": now_iso(), "reason": self.cfg.get("freezeReason", "vault cutover"),
                               "plan": self.cfg.get("plan", "")})

    def step_2(self):
        """Wait up to waitMinutes for no working session, then stop the runtime anyway
        (its restart brings the sessions back: capture + resume). The cut sessions are reported.
        A runtime already stopped (a re-run after the stop, or stopped by someone) has no session
        to wait for: no wait, and the stop command runs once more (it is idempotent and finishes a
        stop a killed run left half done)."""
        v = self.values()
        state, line = self.core_state()
        self.log("core: %s" % line)
        if state == "stopped":
            v["coreAlreadyStopped"] = {"at": now_iso(), "line": line}
            # a re-run keeps the list the first run took before its stop; with none, the list is unknown
            v.setdefault("sessionsCutAtStop", None)
            self.save()
        else:
            deadline = time.time() + 60 * self.core.get("waitMinutes", 30)
            seen, unknown = None, []                    # the last readable list of working sessions
            while True:
                ok, rows, unknown = self.working_sessions()
                if ok:
                    seen = rows
                self.log("working sessions: %s%s" % (len(rows) if ok else "status table not readable",
                                                    " (unknown status: %s)" % [r["status"] for r in unknown] if unknown else ""))
                if ok and not rows:
                    break
                if time.time() >= deadline:
                    break
                time.sleep(self.core.get("pollSeconds", 30))
            v["sessionsCutAtStop"] = seen               # None: the table was never readable
            if unknown:
                v["statusUnknown"] = unknown
            self.save()
        self.run(self.core["stopCmd"], timeout=900)
        v["coreStopped"] = now_iso()
        self.save()

    def step_3(self):
        repo, v = expand(self.mac["repo"]), self.values()
        _, head = self.git(repo, "rev-parse", "HEAD")
        head = head.strip()
        if v.get("HEAD_final") and head == v["HEAD_final"]:
            return
        if "HEAD_pre" not in v:
            v["HEAD_pre"] = head
            self.save()
        elif head != v["HEAD_pre"]:
            # interrupted after the commit: accept it only if it is ours on top of HEAD_pre
            _, msg = self.git(repo, "log", "-1", "--format=%P%n%s", "HEAD")
            parent, subject = (msg.splitlines() + ["", ""])[:2]
            if parent.strip() == v["HEAD_pre"] and subject.strip() == FREEZE_MESSAGE:
                v["HEAD_final"] = head
                self.save()
                return
            raise StepFailed("HEAD moved from %s to %s during the freeze" % (v["HEAD_pre"], head))
        for cmd in self.mac.get("beforeFreeze", []):     # derived text in step (the commit gate's drift check)
            self.run([expand(x) for x in cmd] if isinstance(cmd, list) else cmd, timeout=3600)
        no_auto = ["-c", "gc.auto=0", "-c", "maintenance.auto=false"]
        self.git(repo, *no_auto, "add", "-A", "--", *self.freeze_pathspec(), timeout=3600)
        self.git(repo, *no_auto, "commit", "-q", "--allow-empty", "-m", FREEZE_MESSAGE, env={"KUMA_VAULT_FREEZE_ID": v["freezeId"]},
                 timeout=3600)
        _, head = self.git(repo, "rev-parse", "HEAD")
        v["HEAD_final"] = head.strip()
        self.save()

    def step_3b(self):
        """R2 pre-cutover snapshot, in the background next to step 4; step 4 waits for it."""
        b = self.cfg.get("backup3b", {})
        v = self.values()
        d = os.path.join(self.work, "3b")
        os.makedirs(d, exist_ok=True)
        rcf = os.path.join(d, "rc")
        pid = v.get("3bPid")
        if pid and (os.path.exists(rcf) or _alive(pid)):
            return                                      # already started (or done)
        for f in ("rc", "out"):
            try:
                os.unlink(os.path.join(d, f))
            except FileNotFoundError:
                pass
        cmd = b["command"]
        wrapped = "( %s ) > %s 2>&1; echo $? > %s" % (cmd, shlex.quote(os.path.join(d, "out")), shlex.quote(rcf))
        p = subprocess.Popen(["/bin/sh", "-c", wrapped], env=self.env, start_new_session=True,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        v["3bPid"] = p.pid
        self.save()

    def wait_3b(self):
        b = self.cfg.get("backup3b", {})
        d = os.path.join(self.work, "3b")
        rcf = os.path.join(d, "rc")
        deadline = time.time() + b.get("timeoutSeconds", 4 * 3600)
        v = self.values()
        while not os.path.exists(rcf):
            if not _alive(v.get("3bPid")):
                time.sleep(2)
                if not os.path.exists(rcf):
                    raise StepFailed("3b backup process vanished without a result")
            if time.time() > deadline:
                raise StepFailed("3b backup timed out")
            time.sleep(5)
        with open(rcf) as f:
            rc = int(f.read().strip() or "1")
        with open(os.path.join(d, "out"), encoding="utf-8", errors="replace") as f:
            out = f.read()
        v["3b"] = {"rc": rc, "tail": out[-2000:]}
        m = re.search(b.get("snapshotPattern", r"snapshot ([0-9a-f]{8,64}) saved"), out)
        v["3b"]["snapshot"] = m.group(1) if m else None
        self.save()
        if rc != 0:
            raise StepFailed("3b backup exit %d" % rc)
        for cmd in b.get("checks", []):            # e.g. tag pre-cutover, forget keeps the tag
            self.run(cmd, env={"C8_SNAPSHOT": v["3b"]["snapshot"] or ""}, timeout=3600)

    def step_4(self):
        repo, v = expand(self.mac["repo"]), self.values()
        src = repo.rstrip("/") + "/"
        self.copy_snapshot()
        drift = []
        _, head = self.git(repo, "rev-parse", "HEAD")
        if head.strip() != v["HEAD_final"]:                                   # (a)
            drift.append("HEAD %s != HEAD_final %s" % (head.strip(), v["HEAD_final"]))
        _, items = self.run(self.rsync_base()[1:] + ["-n", "--itemize-changes", src, self.rsync_dest()], timeout=6 * 3600)
        changed, v["platformNoise"] = rsync_changes(items)
        self.save()
        if changed:                                                            # (b)
            drift.append("rsync dry run lists %d changes: %s" % (len(changed), changed[:5]))
        _, st = self.git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", *self.freeze_pathspec(),
                         timeout=3600)
        text = [t for t in st.split("\0") if t]
        if text:                                                               # (d) text written after 3
            drift.append("%d text paths changed after the freeze commit: %s" % (len(text), text[:5]))
        _, o, _ = self.server("s4-inventory")                                  # (c)
        v["serverInventory4"] = o
        if o.get("serverHead") != v["HEAD_final"]:
            drift.append("server HEAD %s != HEAD_final" % o.get("serverHead"))
        if drift:
            v["drift"] = drift
            self.save()
            raise StepFailed("drift: " + " | ".join(drift))
        rc, d = self.gate("4")
        if rc != 0:
            raise StepFailed("G-server-4 exit %d" % rc)
        self.wait_3b()

    def step_5(self):
        _, o, _ = self.server("s5-rewrite")
        self.values()["pointerCommit"] = o.get("pointerCommit")
        self.save()
        if not re.fullmatch(r"[0-9a-f]{40}", o.get("pointerCommit", "")):
            raise StepFailed("no pointer commit")

    def repos_txt(self):
        pj = read_json(expand(self.mac["projectsJson"]), {})
        own = os.path.realpath(os.path.join(expand(self.mac["repo"]), ".git"))
        seen = []
        items = pj.items() if isinstance(pj, dict) else []
        for _, val in items:
            path = val if isinstance(val, str) else (val.get("repo") if isinstance(val, dict) else None)
            if not path:
                continue
            path = expand(path)
            rc, gd = self.git(path, "rev-parse", "--absolute-git-dir", check=False, quiet=True)
            if rc != 0 or not gd.strip():
                continue
            rp = os.path.realpath(gd.strip())          # other_repo_prefixes.py takes git dirs
            if rp == own or rp in seen:
                continue
            seen.append(rp)
        return seen

    def step_6(self):
        v = self.values()
        _, o, sec = self.server("s6a-config", {"P6BASE": v["pointerCommit"]})
        cand = sec.get("refmap-candidates", [])
        d = os.path.join(self.work, "6")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "refmap-candidates.txt"), "w") as f:
            f.write("".join(c + "\n" for c in cand))
        repos = self.repos_txt()
        with open(os.path.join(d, "repos.txt"), "w") as f:
            f.write("".join(r + "\n" for r in repos))
        v["refmap"] = {"candidates": len(cand), "repos": len(repos)}
        self.run(["python3", os.path.join(self.tools(), "other_repo_prefixes.py"), "--tokens", os.path.join(d, "refmap-candidates.txt"),
                  "--repos", os.path.join(d, "repos.txt"), "--out", os.path.join(d, "other-prefixes.tsv")], timeout=3600,
                 env={"PYTHONDONTWRITEBYTECODE": "1"})
        _, o, _ = self.server("s6c-refmap", {"OTHER_PREFIXES_B64": b64file(os.path.join(d, "other-prefixes.tsv"))})
        v["cutoverTip"] = o.get("cutoverTip")
        self.save()

    def step_7(self):
        self.values()["serverStore"] = "placing"
        self.save()
        self.server("s7-place")
        self.values()["serverStore"] = "registered"
        self.save()

    def step_8(self):
        v, m = self.values(), self.mac
        _, o, _ = self.server("s8-compare")
        v["stage8"] = o
        nc = expand(m["newClone"])
        if os.path.lexists(nc):
            if v.get("newCloneCreated"):
                shutil.rmtree(nc)
            else:
                raise StepFailed("%s exists and is not ours" % nc)
        v["newCloneCreated"] = True
        self.save()
        os.makedirs(os.path.dirname(nc), exist_ok=True)
        args = ["clone", m["cloneUrl"], nc]
        if m.get("cloneTokenFile"):
            args += ["--token-file", expand(m["cloneTokenFile"])]
        self.vault(*args, timeout=6 * 3600)
        _, head = self.git(nc, "rev-parse", "HEAD")
        _, st = self.git(nc, "status", "--porcelain")
        _, lfs = self.git(nc, "lfs", "ls-files")
        n = len([l for l in lfs.splitlines() if l.strip()])
        v["macClone"] = {"head": head.strip(), "status": st.strip()[:500], "lfsFiles": n}
        self.save()
        bad = []
        if head.strip() != o.get("serverMain"):
            bad.append("mac HEAD %s != server main %s" % (head.strip(), o.get("serverMain")))
        if st.strip():
            bad.append("mac clone is not clean")
        if str(n) != o.get("lfsCount"):
            bad.append("mac LFS files %d != server %s" % (n, o.get("lfsCount")))
        if bad:
            raise StepFailed("; ".join(bad))

    def step_9(self):
        repo = expand(self.mac["repo"])
        old = repo + ".pre-cutover"
        if os.path.isdir(old) and not os.path.lexists(repo):
            return
        os.rename(repo, old)
        self.values()["renamed"] = True
        self.save()

    def step_10(self):
        v, m = self.values(), self.mac
        if "linksBefore" not in v:
            v["linksBefore"] = {l["path"]: os.readlink(expand(l["path"])) for l in m.get("links", [])}
            sf = expand(m["storesFile"])
            v["storesFileBefore"] = open(sf, encoding="utf-8").read() if os.path.exists(sf) else None
            self.save()
        else:                                  # re-run: back to the state before the first try
            self.undo_10()
        for l in m.get("links", []):
            swap_symlink(expand(l["path"]), expand(l["target"]))
        for args in m.get("storeCommands", []):
            self.vault(*[expand(a) for a in args])

    def step_11(self):
        m = self.mac
        for cmd in m.get("daemonInstall", []):
            self.run(cmd, timeout=600)
        for cmd in m.get("backupRetarget", []):
            self.run(cmd, timeout=600)
        self.core_start()

    def step_12(self):
        """The machine part of the smoke test (orchestrator part: Studio memo image + recording)."""
        sm, v = self.cfg.get("smoke", {}), self.values()
        nc = expand(self.mac["newClone"])
        res = v.setdefault("smoke", {})
        fz = {"KUMA_VAULT_FREEZE_ID": v["freezeId"]}
        blocking = []

        def record(name, ok, **detail):
            res[name] = dict(ok=bool(ok), **detail)
            self.save()
            if not ok:
                self.log("smoke %s FAILED %s" % (name, detail))

        def remote_main():
            _, out = self.git(nc, "ls-remote", "origin", "refs/heads/main", quiet=True)
            return out.split()[0] if out.split() else None

        def commit_line(rel, line, msg):
            p = os.path.join(nc, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "a", encoding="utf-8") as f:
                f.write(line + "\n")
            self.git(nc, "add", "--", rel)
            self.git(nc, "commit", "-q", "-m", msg, env=fz)

        def skipped(name, key):
            # a check the configuration switches off on purpose (null): recorded as skipped
            if key in sm and sm[key] is None:
                record(name, True, skipped="%s is null in the configuration" % key)
                return True
            return False

        # plan read / check / write
        try:
            plan = os.path.join(nc, sm["planFile"])
            text = open(plan, encoding="utf-8").read()
            fm = re.match(r"---\n(.*?)\n---\n", text, re.S)
            ok = bool(fm and re.search(r"(?m)^status:", fm.group(1)))
            commit_line(sm["planFile"], "- c8 driver smoke %s: plan read/check/write" % now_iso(), "c8 smoke: plan write")
            record("plan", ok)
        except (OSError, StepFailed, KeyError) as e:
            record("plan", False, error=str(e))
        # commit -> server accepts, 10 times
        lat = []
        try:
            for i in range(sm.get("commits", 10)):
                commit_line(sm["logFile"], "c8 smoke commit %d %s" % (i + 1, now_iso()), "c8 smoke: commit %d" % (i + 1))
                _, h = self.git(nc, "rev-parse", "HEAD", quiet=True)
                t0 = time.time()
                # nudge the daemon, do not wait for its tick: latency = commit until the server has it
                nudge = subprocess.Popen([expand(x) for x in self.mac["vault"]] + ["sync", "now", "--repo", nc],
                                         env=self.env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL)
                try:
                    while remote_main() != h.strip():
                        if time.time() - t0 > sm.get("syncTimeout", 120):
                            raise StepFailed("server did not take commit %d" % (i + 1))
                        time.sleep(0.5)
                finally:
                    if nudge.poll() is None:
                        nudge.terminate()
                    nudge.wait()
                lat.append(round(time.time() - t0, 2))
            record("commits", True, latencies=lat)
        except (StepFailed, KeyError) as e:
            record("commits", False, latencies=lat, error=str(e))
        # remote search
        rc, out = self.vault("search", sm.get("searchQuery", "vault"), check=False, cwd=os.path.join(nc, self.srv.get("tree", "vault")))
        record("search", rc == 0 and bool(out.strip()), rc=rc, lines=len(out.splitlines()))
        # one large file
        if not skipped("blobGet", "blobPath"):
            try:
                bp = sm["blobPath"]
                _, ptr = self.git(nc, "show", "HEAD:" + bp, quiet=True)
                oid = re.search(r"oid sha256:([0-9a-f]{64})", ptr).group(1)
                self.vault("blob", "get", bp, cwd=nc, timeout=3600)
                got = sha256_file(os.path.join(nc, bp))
                record("blobGet", got == oid, path=bp, oid=oid, got=got)
            except (StepFailed, KeyError, AttributeError, OSError, TypeError) as e:
                record("blobGet", False, error=str(e))
        # two refusals of the server (pushed straight, client hooks skipped)
        for name, key, data, pattern in (
                ("rejectBig", "bigPath", None, sm.get("bigPattern", r"규칙 4|rule 4")),
                ("rejectPlace", "rejectPath", PNG_1PX, sm.get("rejectPattern", r"규칙 7|rule 7"))):
            if skipped(name, key):
                continue
            path = sm.get(key)
            try:
                ok, detail = self.push_refused(nc, path, data, pattern)
                record(name, ok, **detail)
            except (StepFailed, OSError, TypeError) as e:
                record(name, False, error=str(e))
        # status alarms
        rc, out = self.vault("sync", "status", "--json", "--repo", nc, check=False)
        try:
            js = json.loads(out)
        except ValueError:
            js = {}
        alerts = js.get("alerts") or {}
        active = [k for k, a in alerts.items() if isinstance(a, dict) and a.get("active")]
        record("alarms", rc == 0 and not active and not js.get("problems"), rc=rc, active=active,
               alerts=sorted(alerts), problems=js.get("problems"))
        for name in ("plan", "commits", "search", "blobGet", "rejectBig", "rejectPlace", "alarms"):
            if not res.get(name, {}).get("ok"):
                blocking.append(name)
        # launchd restart receipt: recorded, never a rollback (design 5.6 12)
        if sm.get("launchdRestart"):
            res["launchdRestart"] = self.launchd_restart_receipt(nc)
            self.save()
        if blocking:
            raise StepFailed("smoke failed: %s" % ", ".join(blocking))

    def push_refused(self, nc, path, data, pattern):
        idx = os.path.join(self.work, "12-index")
        env = {"GIT_INDEX_FILE": idx}
        tmp = os.path.join(self.work, "12-blob")
        with open(tmp, "wb") as f:
            if data is None:
                for _ in range(33):
                    f.write(os.urandom(1 << 20))
            else:
                f.write(data)
        _, blob = self.git(nc, "hash-object", "-w", tmp, quiet=True)
        os.unlink(tmp)
        self.git(nc, "read-tree", "HEAD", env=env, quiet=True)
        self.git(nc, "update-index", "--add", "--cacheinfo", "100644,%s,%s" % (blob.strip(), path), env=env, quiet=True)
        _, tree = self.git(nc, "write-tree", env=env, quiet=True)
        os.unlink(idx)
        _, c = self.git(nc, "commit-tree", tree.strip(), "-p", "HEAD", "-m", "c8 smoke: must be refused", quiet=True)
        log_start = os.path.getsize(self.step_log)
        rc, _ = self.run([self.mac.get("git", "git"), "-C", nc, "push", "--no-verify", "origin", "%s:refs/heads/main" % c.strip()],
                         check=False, timeout=600)
        with open(self.step_log, encoding="utf-8", errors="replace") as f:
            f.seek(log_start)
            tail = f.read()
        # Other writers may advance main during this push. Fetch a server snapshot and ask
        # whether the rejected commit entered its history, rather than requiring a quiet ref.
        snapshot_ref = "refs/kuma-vault-smoke/" + c.strip()
        try:
            self.git(nc, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin",
                     "refs/heads/main:" + snapshot_ref, quiet=True)
            _, server_main = self.git(nc, "rev-parse", snapshot_ref, quiet=True)
            contains, _ = self.git(nc, "merge-base", "--is-ancestor", c.strip(), server_main.strip(), check=False, quiet=True)
        finally:
            self.git(nc, "update-ref", "-d", snapshot_ref, quiet=True)
        absent = contains == 1  # an ancestry error is not proof of absence
        ok = rc != 0 and absent and re.search(pattern, tail) is not None
        return ok, {"path": path, "pushExit": rc, "rejectedCommitAbsent": absent,
                    "ancestryExit": contains, "patternSeen": re.search(pattern, tail) is not None}

    def launchd_restart_receipt(self, nc):
        label = "%s%s" % (self.mac.get("syncdLabelPrefix", "ai.kuma-vault.syncd."), self.srv["store"])
        uid = os.getuid()
        rec = {"label": label}
        _, dom = self.run(["launchctl", "print", "gui/%d" % uid], check=False, quiet=True)
        m = re.search(r"(?m)^\s*on-demand count = (\d+)", dom)
        rec["onDemandCount"] = m.group(1) if m else "absent"

        def daemon_pid():
            _, out = self.vault("sync", "status", "--json", "--repo", nc, check=False, quiet=True)
            try:
                return (json.loads(out).get("daemon") or {}).get("pid")
            except ValueError:
                return None
        old = daemon_pid()
        rec["oldPid"], rec["killedAt"] = old, now_iso()
        if not old:
            rec["ok"] = False
            rec["why"] = "no daemon pid"
            return rec
        os.kill(int(old), signal.SIGKILL)
        t0 = time.time()
        new = None
        while time.time() - t0 < self.cfg.get("smoke", {}).get("launchdWaitSeconds", 30):
            time.sleep(1)
            p = daemon_pid()
            if p and p != old and _alive(p):
                new = p
                break
        rec["newPid"], rec["seconds"] = new, round(time.time() - t0, 1)
        rc, _ = self.vault("sync", "status", "--repo", nc, check=False, quiet=True)
        rec["statusExit"] = rc
        rec["ok"] = bool(new) and rc == 0
        if not new:
            _, why = self.run(["launchctl", "print", "gui/%d/%s" % (uid, label)], check=False, quiet=True)
            rec["launchctlPrint"] = why[-3000:]
            m = re.search(r"pended nondemand spawn = (\S+)", why)
            rec["pendedReason"] = m.group(1) if m else None
            # recorded for the untangle verdict; the night goes on with the daemon kicked by hand (5.6 12)
            self.run(["launchctl", "kickstart", "gui/%d/%s" % (uid, label)], check=False)
            t1 = time.time()
            while time.time() - t1 < 30 and not new:
                time.sleep(1)
                p = daemon_pid()
                new = p if p and p != old and _alive(p) else None
            rec["kickstartPid"] = new
            rec["kickstartStatusExit"] = self.vault("sync", "status", "--repo", nc, check=False, quiet=True)[0]
        return rec

    def step_13(self):
        try:
            os.unlink(expand(self.mac["freezeFile"]))
        except FileNotFoundError:
            pass
        self.values()["freezeReleased"] = now_iso()
        self.save()
        _, o, _ = self.server("s13-cleanup")
        self.values()["server13"] = o
        self.save()

    def step_13b(self):
        rc, o, _ = self.server("s13b-backup", check=False)
        v = self.values()
        v["backup13b"] = o
        if rc != 0:
            v["c9Ready"] = False
            self.save()
            self.server("rollback-13b", check=False)
            raise StepFailed("13b first server backup failed: C9 must not start")
        v["c9Ready"] = True
        self.save()

    # --- undo (5.7) -----------------------------------------------------------------------

    def undo_10(self):
        v, m = self.values(), self.mac
        for path, target in (v.get("linksBefore") or {}).items():
            swap_symlink(expand(path), target)
        sf = expand(m["storesFile"])
        if "storesFileBefore" in v:
            if v["storesFileBefore"] is None:
                if os.path.exists(sf):
                    os.unlink(sf)
            else:
                tmp = sf + ".c8.tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    f.write(v["storesFileBefore"])
                os.replace(tmp, sf)

    def rollback(self, failed_step, outcome):
        """5.7: undo what ran, newest first. Never raises; every undo is logged and recorded.
        Returns the outcome to finish with: `outcome` (no-go or rolled-back) when every undo is
        done, rollback-incomplete when one failed — a run on that state tries the failed undos again."""
        st = self.state
        rb = st.setdefault("rollback", {"from": failed_step, "outcome": outcome, "startedAt": now_iso(), "steps": {}})
        self.step_log = os.path.join(self.work, "logs", "rollback.log")
        ran = [s for s in STEPS if st["steps"].get(s, {}).get("status") in ("running", "done", "failed", "no-go")]
        v = self.values()

        def undo(name, fn):
            if rb["steps"].get(name) == "done":
                return
            rb["steps"][name] = "running"
            self.save()
            try:
                fn()
                rb["steps"][name] = "done"
            except Exception as e:  # noqa: BLE001 — a rollback reports, it does not stop halfway
                rb["steps"][name] = "failed: %s" % e
                self.log("undo %s failed: %s" % (name, e))
            self.save()

        if "10" in ran:
            undo("10", self.undo_10)
        if "9" in ran:
            def u9():
                repo = expand(self.mac["repo"])
                if os.path.isdir(repo + ".pre-cutover") and not os.path.lexists(repo):
                    os.rename(repo + ".pre-cutover", repo)
            undo("9", u9)
        if "8" in ran and v.get("newCloneCreated"):
            undo("8-mac", lambda: shutil.rmtree(expand(self.mac["newClone"]), ignore_errors=False)
                 if os.path.lexists(expand(self.mac["newClone"])) else None)
        if "0" in ran:
            # past the prerequisites (server checked clean): the store id and the work directory
            # are this attempt's — row 2 of 5.7 takes them away
            def userver():
                chown = "1" if any(s in ran for s in ("7", "8")) else "0"
                self.server("rollback", {"CHOWN_BACK": chown})
            undo("server", userver)
        elif "pre" in ran:
            undo("server", lambda: self.server("nogo-cleanup"))
        if "3" in ran and self.cfg.get("rollback", {}).get("undoFreezeCommit") and v.get("HEAD_final"):
            def u3():
                repo = expand(self.mac["repo"])
                _, h = self.git(repo, "rev-parse", "HEAD")
                if h.strip() == v["HEAD_final"]:
                    self.git(repo, "reset", "-q", "--soft", "HEAD^")
            undo("3", u3)
        if "1" in ran:
            def u1():
                fz = expand(self.mac["freezeFile"])
                cur = read_json(fz)
                if cur and cur.get("id") == v.get("freezeId"):
                    os.unlink(fz)
            undo("1", u1)
        if "2" in ran and v.get("coreStopped") and not v.get("coreStarted"):
            undo("2", self.core_start)
        rb["endedAt"] = now_iso()
        rb["failed"] = [n for n, s in rb["steps"].items() if s != "done"]
        self.save()
        return "rollback-incomplete" if rb["failed"] else rb.get("outcome", outcome)

    # --- reports --------------------------------------------------------------------------

    def report(self):
        st = self.state
        name = "c8-attempt%s-%s" % (st["attempt"], st["outcome"])
        path = os.path.join(self.work, "reports", name + ".json")
        write_json_atomic(path, st)
        rb = st.get("rollback") or {}
        head = "# cutover driver: %s (attempt %s)" % (st["outcome"], st["attempt"])
        if st["outcome"] == "rollback-incomplete":
            head += " — undo failed: %s; a run on this state tries them again" % ", ".join(rb.get("failed", []))
        lines = [head, "",
                 "- started %s, ended %s" % (st.get("startedAt"), st.get("endedAt")),
                 "- reason: %s" % st.get("reason", "")]
        for s in STEPS:
            x = st["steps"].get(s)
            if x:
                lines.append("- step %s: %s (exit %s, %s → %s)" % (s, x.get("status"), x.get("rc"), x.get("startedAt"), x.get("endedAt")))
        if st.get("rollback"):
            lines.append("- rollback: %s" % json.dumps(st["rollback"]["steps"], ensure_ascii=False))
        v = st.get("values", {})
        for k in ("HEAD_final", "pointerCommit", "cutoverTip", "coreAlreadyStopped", "sessionsCutAtStop", "statusUnknown",
                  "c9Ready", "smoke"):
            if k in v:
                lines.append("- %s: %s" % (k, json.dumps(v[k], ensure_ascii=False)))
        md = os.path.join(self.work, "REPORT.md")
        with open(md, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        shutil.copy(md, os.path.join(self.work, "reports", name + ".md"))
        self.log("report %s" % path)
        notify = self.cfg.get("notify", {}).get("command")
        if notify and self.core_alive():
            self.run(notify, check=False, timeout=300, env={"C8_REPORT_FILE": md, "C8_REPORT_JSON": path, "C8_OUTCOME": st["outcome"]})
        elif notify:
            self.log("runtime is down: report left at %s" % md)
        return path

    # --- main loop ------------------------------------------------------------------------

    def begin(self):
        st = self.state
        if st and st.get("outcome") == "success":
            raise SystemExit("this cutover already succeeded (%s)" % self.state_path)
        if st and st.get("outcome") in ("halted",):
            raise SystemExit("halted after step 10: a person decides (5.7 row 3). state: %s" % self.state_path)
        if st and st.get("outcome") == "rollback-incomplete":
            # same attempt: the run goes back into the rollback, which skips the undos that are done
            st["outcome"] = None
            st.setdefault("rollbackRetries", []).append(now_iso())
        if st and st.get("outcome") in NEW_ATTEMPT_AFTER:
            os.replace(self.state_path, "%s.attempt%s" % (self.state_path, st["attempt"]))
            prev = st["attempt"]
            st = None
        else:
            prev = 0
        if not st:
            stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
            st = {"version": 1, "attempt": prev + 1, "startedAt": now_iso(), "outcome": None, "steps": {},
                  "values": {"freezeId": "c8-%s-%d" % (stamp, prev + 1)}}
        self.state = st
        self.save()

    def run_all(self, stop_after=None):
        self.begin()
        st = self.state
        if st.get("rollback") and not st.get("outcome"):
            self.log("resuming an interrupted or incomplete rollback")
            rb = st["rollback"]
            return self.finish(self.rollback(rb["from"], rb.get("outcome", "rolled-back")), st.get("reason", "rollback resumed"))
        caff = _caffeinate()
        try:
            for s in STEPS:
                x = st["steps"].get(s, {})
                if x.get("status") == "done":
                    continue
                self.step_log = os.path.join(self.work, "logs", "step-%s.log" % s)
                st["steps"][s] = {"status": "running", "startedAt": now_iso(), "rc": None,
                                  "reruns": x.get("reruns", -1) + 1}
                self.save()
                self.log("== step %s" % s)
                try:
                    getattr(self, "step_" + s)()
                except NoGo as e:
                    self.end_step(s, "no-go", 3)
                    st["reason"] = "; ".join(e.reasons)
                    self.log("NO-GO at %s: %s" % (s, st["reason"]))
                    return self.finish(self.rollback(s, "no-go"), st["reason"])
                except Exception as e:  # noqa: BLE001
                    self.end_step(s, "failed", 1, str(e))
                    st["reason"] = "step %s: %s" % (s, e)
                    self.log("FAILED at %s: %s" % (s, e))
                    if s in ("pre", "0", "1", "2") or STEPS.index(s) <= STEPS.index("10"):
                        return self.finish(self.rollback(s, "no-go" if s in ("pre", "0", "1", "2") else "rolled-back"),
                                           st["reason"])
                    if s == "13b":
                        return self.finish("success", "cut over; " + st["reason"])
                    if not self.values().get("coreStarted"):
                        self.core_start()
                    return self.finish("halted", st["reason"])
                self.end_step(s, "done", 0)
                if stop_after and s == stop_after:
                    self.log("stopped after %s (--stop-after)" % s)
                    return None
            return self.finish("success", "all steps done")
        finally:
            if caff:
                caff.terminate()

    def end_step(self, s, status, rc, error=None):
        x = self.state["steps"][s]
        x.update(status=status, rc=rc, endedAt=now_iso())
        if error:
            x["error"] = error[:2000]
        self.save()

    def finish(self, outcome, reason):
        self.state["outcome"] = outcome
        self.state["reason"] = reason
        self.state["endedAt"] = now_iso()
        self.save()
        self.report()
        self.log("OUTCOME %s — %s" % (outcome, reason))
        return outcome


PNG_1PX = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


def _alive(pid):
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
    except (ProcessLookupError, ValueError):
        return False
    except PermissionError:
        return True
    try:                                      # a zombie child is not alive
        r = os.waitpid(int(pid), os.WNOHANG)
        return r == (0, 0)
    except ChildProcessError:
        return True


def _caffeinate():
    if sys.platform != "darwin" or not shutil.which("caffeinate"):
        return None
    return subprocess.Popen(["caffeinate", "-dims", "-w", str(os.getpid())], stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def swap_symlink(path, target):
    """Atomic replace of a symlink: a new link next to it, rename(2) over the old one."""
    if os.path.islink(path) and os.readlink(path) == target:
        return
    if os.path.exists(path) and not os.path.islink(path):
        raise StepFailed("%s is not a symlink" % path)
    tmp = "%s.c8-new" % path
    if os.path.lexists(tmp):
        os.unlink(tmp)
    os.symlink(target, tmp)
    os.replace(tmp, path)


# --- launchd one-shot start ---------------------------------------------------------------

def plist_xml(label, argv, env, log):
    def esc(s):
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    args = "".join("    <string>%s</string>\n" % esc(a) for a in argv)
    envs = "".join("    <key>%s</key><string>%s</string>\n" % (esc(k), esc(v)) for k, v in env.items())
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
            '<plist version="1.0">\n<dict>\n'
            "  <key>Label</key><string>%s</string>\n"
            "  <key>ProgramArguments</key>\n  <array>\n%s  </array>\n"
            "  <key>EnvironmentVariables</key>\n  <dict>\n%s  </dict>\n"
            "  <key>StartCalendarInterval</key>\n  <dict>\n"
            "    <key>Month</key><integer>{M}</integer>\n    <key>Day</key><integer>{D}</integer>\n"
            "    <key>Hour</key><integer>{h}</integer>\n    <key>Minute</key><integer>{m}</integer>\n  </dict>\n"
            "  <key>AbandonProcessGroup</key><true/>\n"
            "  <key>StandardOutPath</key><string>%s</string>\n  <key>StandardErrorPath</key><string>%s</string>\n"
            "</dict>\n</plist>\n") % (esc(label), args, envs, esc(log), esc(log))


def launchd_paths(drv, label):
    return os.path.expanduser("~/Library/LaunchAgents/%s.plist" % label), os.path.join(drv.work, "logs", "launchd.log")


def cmd_launchd(drv, a):
    label = drv.cfg.get("launchdLabel", "ai.kuma-vault.cutover-driver")
    plist, log = launchd_paths(drv, label)
    if a.action == "uninstall":
        subprocess.run(["launchctl", "bootout", "gui/%d/%s" % (os.getuid(), label)], check=False)
        if os.path.exists(plist):
            os.unlink(plist)
        print("removed %s" % label)
        return 0
    at = dt.datetime.strptime(a.at, "%Y-%m-%dT%H:%M")
    me = os.path.abspath(__file__)
    if not me.startswith(drv.work.rstrip("/") + "/"):
        raise SystemExit("run `stage` first: launchd must start the copy in workDir, not %s" % me)
    argv = [sys.executable, me, "launch", "--config", drv.config_path, "--label", label, "--at", a.at,
            "--window-minutes", str(a.window_minutes)]
    env = {"PATH": drv.env.get("PATH", "/usr/bin:/bin"), "HOME": os.path.expanduser("~")}
    xml = plist_xml(label, argv, env, log).replace("{M}", str(at.month)).replace("{D}", str(at.day)) \
        .replace("{h}", str(at.hour)).replace("{m}", str(at.minute))
    if a.action == "render":
        sys.stdout.write(xml)
        return 0
    os.makedirs(os.path.dirname(plist), exist_ok=True)
    with open(plist, "w") as f:
        f.write(xml)
    subprocess.run(["plutil", "-lint", plist], check=True)
    subprocess.run(["launchctl", "bootout", "gui/%d/%s" % (os.getuid(), label)], check=False,
                   stderr=subprocess.DEVNULL)
    subprocess.run(["launchctl", "bootstrap", "gui/%d" % os.getuid(), plist], check=True)
    print("installed %s at %s → %s" % (label, a.at, plist))
    return 0


def cmd_launch(drv, a):
    """launchd entry: check the window, detach the run, drop the plist, unload the job."""
    at = dt.datetime.strptime(a.at, "%Y-%m-%dT%H:%M")
    plist, _ = launchd_paths(drv, a.label)
    late = (dt.datetime.now() - at).total_seconds() / 60
    if os.path.exists(plist):
        os.unlink(plist)
    outside = late < -1 or late > a.window_minutes
    outcome = drv.state.get("outcome") if drv.state else None
    if outside and (not drv.state or outcome in NEW_ATTEMPT_AFTER):
        drv.begin()
        drv.finish("missed-window", "launched at %s, window %s +%d min" % (now_iso(), a.at, a.window_minutes))
        child = None
    elif outside:
        # an unfinished attempt, or one that a person or a re-run has to finish (halted, rollback-incomplete)
        print("%s outside the window, attempt outcome %s: not started" % (now_iso(), outcome), flush=True)
        child = None
    else:
        log = open(os.path.join(drv.work, "logs", "run.out"), "a")
        child = subprocess.Popen([sys.executable, os.path.abspath(__file__), "run", "--config", drv.config_path],
                                 start_new_session=True, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        print("%s started driver pid %d" % (now_iso(), child.pid), flush=True)
    # unload the job; the driver runs in its own session and survives (AbandonProcessGroup)
    subprocess.Popen(["/bin/sh", "-c", "sleep 2; launchctl bootout gui/%d/%s" % (os.getuid(), a.label)],
                     start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return 0


def cmd_stage(drv, a):
    dest = os.path.join(drv.work, "driver")
    if os.path.realpath(HERE) == os.path.realpath(dest):
        raise SystemExit("already running from %s" % dest)
    if os.path.exists(dest):
        shutil.rmtree(dest)
    shutil.copytree(HERE, dest, ignore=shutil.ignore_patterns("__pycache__", "rehearsal"))
    cfg = os.path.join(drv.work, "c8.json")
    shutil.copy(drv.config_path, cfg)
    print("staged: %s/driver.py run --config %s" % (dest, cfg))
    print("launchd: %s/driver.py launchd install --config %s --at <YYYY-MM-DDTHH:MM>" % (dest, cfg))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--config", required=True)
    r.add_argument("--stop-after", choices=STEPS)
    for n in ("status", "stage"):
        sub.add_parser(n).add_argument("--config", required=True)
    l = sub.add_parser("launchd")
    l.add_argument("action", choices=["render", "install", "uninstall"])
    l.add_argument("--config", required=True)
    l.add_argument("--at")
    l.add_argument("--window-minutes", type=int, default=120)
    la = sub.add_parser("launch")
    for k in ("--config", "--label", "--at"):
        la.add_argument(k, required=True)
    la.add_argument("--window-minutes", type=int, default=120)
    a = ap.parse_args()
    drv = Driver(a.config)
    if a.cmd == "run":
        out = drv.run_all(a.stop_after)
        return EXIT.get(out, 1)
    if a.cmd == "status":
        print(json.dumps(drv.state, ensure_ascii=False, indent=2))
        return 0
    if a.cmd == "stage":
        return cmd_stage(drv, a)
    if a.cmd == "launchd":
        return cmd_launchd(drv, a)
    if a.cmd == "launch":
        return cmd_launch(drv, a)
    return 2


if __name__ == "__main__":
    sys.exit(main())
