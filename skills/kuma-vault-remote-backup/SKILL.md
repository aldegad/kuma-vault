---
name: kuma-vault-remote-backup
description: 'Set up and operate client-encrypted offsite backup for a kuma-vault knowledge repo (or any local-only git repo holding secrets) using restic to S3-compatible storage such as Cloudflare R2. Use when a vault/repo has no git remote by policy but needs disaster durability, when asked to back up the brain/vault to the cloud, to verify or restore a backup, or to decide where backup keys must live. Triggers (KR/EN): 볼트 백업, 브레인 백업, 원격 저장, 클라우드 백업, 암호화 백업, R2 백업, restic, 백업 복원, 백업 검증, 백업 키 어디에, back up the vault, encrypted offsite backup, restore the backup, remote storage guide.'
user-invocable: true
---

# kuma-vault-remote-backup — client-encrypted offsite backup

Backs up a vault that lives **only on this computer** (`local` storage mode) without giving it
a git remote: local git keeps the history, restic encrypts on this machine, and S3-compatible
storage receives ciphertext only. Secrets stay in the vault untouched, and a dead disk costs
nothing but the restore time.

**Which backup applies.** A server-backed vault (`oracle` or `remote` mode) is backed up by the
server's own nightly job, with an automatic restore drill — use
[server.md › Backup](../../docs/server.md#backup) instead. This skill is for a `local` store,
or for any other local-only git repository that holds secrets. After moving a local vault to a
server, the client routine below can be retired once the server's backups have proven
themselves ([server.md › Retiring a client-side backup routine](../../docs/server.md#retiring-a-client-side-backup-routine)).

## Why this combination

- **No git remote.** Even a private hosted repository puts the whole vault, secrets included,
  one leaked token or wrong visibility switch away from exposure. Stripping secrets before
  each commit would corrupt the single source of truth instead. The
  [storage policy](../kuma-vault/docs/storage-policy.md) therefore allows no public remote.
- **restic** chunks by content, deduplicates and encrypts on the client. Every snapshot is a
  full restore point, yet each run stores only the changed chunks (seconds for a second
  snapshot of a multi-GiB repo). It backs up the folder as files, `.git` included, so the git
  history comes back whole — restic does not need to know about git.
- **Cloudflare R2** charges nothing for egress, so a restore is free, and its free tier covers
  10 GB-month of Standard storage ([R2 pricing](https://developers.cloudflare.com/r2/pricing/),
  verified 2026-10-04). Any S3-compatible service works; only the endpoint changes.

## Set up

The commands use the macOS keychain (`security`). On Linux, use your secret store of choice
(`secret-tool`, `pass`) and keep the same rule: values go from the store into environment
variables, never into files, chat or logs.

1. **Bucket and token.** Create one bucket per repository and an S3 API token with Object
   Read & Write on **that bucket only**.
2. **Store the token in the keychain.** With `-w` as the last option, `security` prompts for
   the value, so it never appears on a command line, in shell history or in a log:

   ```bash
   security add-generic-password -s <repo>-restic-r2 -a access-key-id -w
   security add-generic-password -s <repo>-restic-r2 -a secret-access-key -w
   security add-generic-password -s <repo>-restic-r2 -a endpoint -w
   ```

3. **Create the restic password** and store it in the keychain
   (`-s <repo>-restic -a password`) and in the vault's `_credentials`, together with the
   recovery steps below.
4. **Initialise and take the first snapshot:**

   ```bash
   export AWS_ACCESS_KEY_ID=$(security find-generic-password -s <repo>-restic-r2 -a access-key-id -w)
   export AWS_SECRET_ACCESS_KEY=$(security find-generic-password -s <repo>-restic-r2 -a secret-access-key -w)
   export RESTIC_PASSWORD=$(security find-generic-password -s <repo>-restic -a password -w)
   EP=$(security find-generic-password -s <repo>-restic-r2 -a endpoint -w)
   restic -r "s3:$EP/<bucket>" init
   restic -r "s3:$EP/<bucket>" backup <repo-path> \
     --exclude "**/node_modules" --exclude "**/.venv" --exclude "**/__pycache__" \
     --exclude "/.fts" --exclude "**/*.log" --exclude ".DS_Store" --exclude "tmp/"
   ```

   Derived files (the `.fts/` search index, build output, caches) are left out: `vault sync`
   regenerates them.
5. **Run it nightly.** A small runner script reads the keychain, runs `backup`, then
   `forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune`, and prints
   `snapshots --latest 1`. Schedule it with cron or launchd and make a failure visible — a
   backup job that fails quietly is no backup.

## Where the keys live — break the circle

**A password stored only on the machine being backed up dies with that machine.** The copy
in the vault's `_credentials` is inside the encrypted backup: on the day of the disaster it
is a key locked in the safe it opens.

- **restic password:** keep **one copy off this machine** — a phone password manager, a file
  on another device, or paper. Without it the backup exists but cannot be opened. Avoid
  messengers: the message stays on their servers in plain text.
- **S3 token:** cheap to replace. The keychain alone is enough; after a disaster, issue a new
  token in the console.
- A restore needs all three: the ciphertext in the bucket, the off-machine password, and a
  token you can issue again.

## Verify — a snapshot id is not proof

A backup has worked only when a restore into **another directory** gives a working `git log`:

```bash
restic -r "s3:$EP/<bucket>" restore latest --target /tmp/verify --include "<repo-path>/.git"
git --git-dir=/tmp/verify/<repo-path>/.git log --oneline -3   # must show the latest commit
```

Restore with the password read from the keychain, so you also prove that copy opens the
repository. Comparing one file byte for byte with `cmp` makes the check stronger. Delete the
scratch directory afterwards.

## Restore after a disaster (on another machine)

1. Sign in to the storage console and issue a new token (Object Read, that bucket).
2. `RESTIC_PASSWORD=<off-machine copy> restic -r "s3:<endpoint>/<bucket>" restore latest --target ~/restore`
3. The restored folder's `.git` is intact: this is the original repository back, not a clone.
