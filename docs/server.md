# Server: `vault serve`

`vault serve` keeps the canonical copy of one or more vault stores on a server and lets
clients push, fetch and move large files over the tailnet. The client half (clone, sync
daemon) is separate.

The server code lives in `src/server/` and imports nothing from the compiler engine, so a
bare engine checkout with no `node_modules` can serve. This page is the reference; to build a
server step by step, follow [oracle.md](../skills/kuma-vault-setup/docs/oracle.md) or
[other-remote.md](../skills/kuma-vault-setup/docs/other-remote.md).

## Install

On the server, as root, from an engine checkout unpacked at `/opt/kuma-vault/<version>/` — from a
git checkout of the engine, or from the engine a client already runs:

```sh
git archive <tag> | ssh <server> 'sudo mkdir -p /opt/kuma-vault/<tag> && sudo tar --no-same-owner -x -C /opt/kuma-vault/<tag>'
# or, from the engine on a client:
ENGINE="$(dirname "$(dirname "$(realpath "$(command -v kuma-vault)")")")"
VERSION="$(node -p "require('$ENGINE/package.json').version")"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$ENGINE" -czf - bin src package.json \
  | ssh <server> "sudo mkdir -p /opt/kuma-vault/$VERSION && sudo tar --no-same-owner -xzf - -C /opt/kuma-vault/$VERSION"

ssh <server> sudo /opt/kuma-vault/<version>/bin/vault server install --store kuma-main-vault --owner you@example.com
```

`--no-same-owner` keeps the unpacked engine owned by root: the service and its hooks run it.
The server needs only `bin`, `src` and `package.json` (no `node_modules`); copying just those
keeps a checkout's `.git` and dev folders off the server. The store owner is a tailnet login
(`tailscale whois <client tailnet IP>` → `User:` → `Name:`). After install, `vault` is not on root's PATH: call `/opt/kuma-vault/current/bin/vault`.

`--auth token` (a server outside a tailnet, behind an HTTPS reverse proxy on the same machine)
makes the first `server.json` `auth.mode: "token"` listening on `127.0.0.1:7741` only, with no
Tailscale needed. On an existing `server.json`, `--auth` must match its mode; install never
rewrites the file. Clients then need a token per device:
`vault server token add --id <device> --store <id> --role writer` prints it once to stdout.
The token-mode install has not yet been run on a freshly built machine; serving, tokens,
clients and large-file uploads behind a TLS proxy have been (see
[Behind a reverse proxy](#behind-a-reverse-proxy)).

`vault server install` is idempotent. It:

1. puts the official Node 22 tarball at `/opt/node/<version>` (checked against
   `SHASUMS256.txt`) and points `/opt/node/current` at it. `KUMA_VAULT_NODE_VERSION` picks
   another one; its ICU must know Unicode 16.0 or later, or every `vault server` command
   (and so the receive hook) stops with an error (rule 2, "Code points" below);
2. installs `git-lfs` and `restic` with apt when missing;
3. creates the system user `kuma-vault` and `/data/vaults` (0750);
4. writes `/etc/kuma-vault/server.json` (0600, owner `kuma-vault`) the first time — listening
   on the tailnet IP and `127.0.0.1`, port 7741 (with `--auth token`: `127.0.0.1` only) — and
   only validates it afterwards;
5. adds and initializes each `--store` (bare `origin.git` with the receive settings and hooks,
   `lfs/objects`, `lfs/incoming`, `state/`) and gives its whole tree to `kuma-vault`;
6. points `/opt/kuma-vault/current` at this checkout;
7. writes, enables and restarts `kuma-vault-serve.service`, then checks health on loopback;
8. writes `kuma-vault-backup.service` and `.timer` and enables the timer when `server.json`
   has a `backup` block (see Backup).

Upgrade: unpack the new version next to the old one and run its `bin/vault server install`.

`sudo vault server init-store <id>` adds or repairs one store by the same rule as step 5: the
tree belongs to `kuma-vault`, which runs serve and the hooks. A store left to root (0750) would
be a 404 for serve. Run as anyone other than root or `kuma-vault`, it stops before creating
anything; without the `kuma-vault` user (no install yet) it stops too.

## Endpoints

| Path | Who |
|---|---|
| `GET /v1/health` | anyone who can reach it; store details only to their readers |
| `/v1/stores/<id>.git/info/refs`, `git-upload-pack` | reader |
| `/v1/stores/<id>.git/git-receive-pack` | writer |
| `POST /v1/stores/<id>.git/info/lfs/objects/batch` | reader (download), writer (upload) |
| `PUT` / `GET /v1/stores/<id>.git/info/lfs/objects/<oid>` | writer / reader |
| `POST /v1/stores/<id>.git/info/lfs/objects/verify` | writer |
| `GET /v1/stores/<id>/events?after=<seq>` | reader (long-poll, 25 s) |
| `GET /v1/stores/<id>/backup-status` | reader (`state/backup-status.json`, written by the backup job) |
| `GET /v1/stores/<id>/file?path=<tree path>&rev=<main\|sha>` | reader — one regular file, read from git objects (below) |

Clients use `http://<server>:7741/v1/stores/<id>.git` as the git remote. git-lfs derives the
LFS endpoint from it, so no `lfs.url` is needed. LFS locking is not served (501); set
`lfs.<url>.locksverify=false` in clones.

## Identity

- A token (`Authorization: Bearer <token>`, or HTTP Basic with the token as the password) is
  that token. An unknown token is a 401; there is no fallback to another identity.
- Otherwise a tailnet peer is identified with `tailscale whois` (login name, or
  `node:<name>` for a tagged device), cached per address for `auth.whoisCacheSeconds`.
- Requests from the server itself — loopback, any local interface address (which includes
  its own tailnet IPs) or a whois answer naming the server's own node — are never identified
  by whois, because whois would answer with the server owner's login and give that login to
  any local Linux user. They get `GET /v1/health` only; everything else needs a token.
- `auth.mode: "token"` (servers outside a tailnet, behind an HTTPS reverse proxy) turns
  whois off; every request needs a token.

### Behind a reverse proxy

The LFS batch answer hands the client absolute hrefs for upload, verify and download. They
carry the scheme and host the client used. When a TLS reverse proxy on the same machine (Caddy,
nginx) sits in front of serve, that is the proxy's `https://` address, not serve's plain port:
git-lfs that was told `http://` would send plain HTTP to the HTTPS port and fail with
"broken pipe".

- From loopback (`127.0.0.0/8`, `::1`), serve takes the scheme from `X-Forwarded-Proto` (`http`
  or `https`) and the host from `X-Forwarded-Host`, first value of a list. If the proxy sends
  no `X-Forwarded-Host`, `Host` stays. A value that is not a scheme or a `host[:port]` is a 400.
  It is never copied into an href.
- From any other address, `X-Forwarded-*` are ignored and the href is `http://<Host>`. Only a
  process on the server itself can set them, so the proxy must connect to serve on loopback.
- They never take part in identity. Identity comes from the socket address and the token
  only (above). A forwarded header cannot stand in for a token or change a whois answer.

Caddy's `reverse_proxy` sends both headers as it is. nginx needs
`proxy_set_header X-Forwarded-Proto $scheme;` and `proxy_set_header X-Forwarded-Host $host;`
(or `proxy_set_header Host $host;`).

A fixed `publicUrl` in `server.json` was the other option. It was not taken because one server
can serve a tailnet client on plain `http://<server>:7741` and an outside client through the
proxy at the same time, and a single URL would be wrong for one of them. A forged header can
also only steer the href of the request that carried it, so the client would send its own token
to a place it named itself. Tests: `src/server/serve-proxy.integration.test.mjs` (a git-lfs
push through an HTTPS proxy that rewrites `Host`, and forged headers from a non-loopback
address) and the "LFS href origin" units in `src/server/server-units.test.mjs`.

Store roles come from `owners` / `writers` / `readers` in `server.json`. Token roles are
`reader`, `writer` or `admin`. Only an `admin` token may push `refs/replace/*` (the cutover's
replace refs).

## Receive rules

`origin.git/hooks/pre-receive` runs `vault server receive-check`. It checks every commit the
push brings, not only the tip. The verdict goes back to the pusher as `remote:` lines; each
push is also logged to `state/receive-log.jsonl` (paths, sizes, oids — no content).

| # | Rule |
|---|---|
| 1 | Only `refs/heads/main`, fast-forward, never deleted. `refs/replace/*` with an admin token only |
| 2 | Every client can check the path out ("What a checkout can write" below): UTF-8, code points macOS knows, NFC, no two paths in one tree that macOS matches as one name (full case folding, files and directories), no empty, `.`, `..`, `.git` or `..namedfork` component, no symlinked `.gitmodules`, and within the length limits |
| 3 | Paths with an LFS extension (`src/server/lfs-paths.mjs`, compared in lower case) hold a canonical LFS pointer whose object is in the CAS with the same size. Empty files pass |
| 4 | Other blobs are at most `maxNonLfsBlobBytes` (32 MiB). Above `warnNonLfsBlobBytes` (10 MiB) they are accepted with a warning. Every object the push brings, whether a path names it or not, is held to the same cap |
| 5 | The data volume keeps `diskReserveGB` (8 GB) free. LFS uploads are refused with 507 below it as well |
| 6 | No `.fts/`, lock or temp paths (`junkPatterns`, default `DEFAULT_JUNK_PATTERNS`) |
| 7 | No binaries (LFS extension, or a NUL byte in the first 8000 bytes) in `binaries.reject` places, read from `server.json` and never from the pushed tree |

Pattern lists use gitignore syntax and match case-insensitively. Negation (`!`) is refused.

### What a checkout can write

Rule 2 refuses what the server would take in but no checkout could write. Such a push would
stop `tree/` from following and break every new clone. The clients are macOS (APFS,
case-insensitive and normalization-insensitive) and Linux (ext4, xfs, btrfs). Windows clients
are not a target. The code is `src/server/checkout-paths.mjs`.

Each axis was measured with a real `git clone` of one branch per case: on macOS 15.6.1 (APFS,
Apple git 2.39.5) and on the server (Linux, ext4, git 2.43.0). "Written" means the clone exits 0
with a clean `git status`. Tests: U = `src/server/checkout-paths.test.mjs`,
I = `src/server/serve.integration.test.mjs` (real pushes through `vault serve`).

| Axis | Case | macOS clone | Linux clone | Receive | Test |
|---|---|---|---|---|---|
| Encoding | a byte that is not UTF-8 (`caf\xE9`), an overlong form (`\xC0\xAF`), an encoded surrogate (`\xED\xA0\x80`) | fails: EILSEQ | written | rule 2: paths are decoded fatally | U "decodes UTF-8 fatally", I "every axis" |
| Code points | a noncharacter (U+FDD0, U+FFFE), an unassigned one (U+0378), a Unicode 17.0 addition (U+A7CE) | fails: EILSEQ | written | rule 2: Unicode 16.0 assigned code points only | U "refuses code points APFS does not know", I "every axis" |
| Code points | a Unicode 16.0 addition, private use, ASCII control characters (U+0001–U+001F), DEL, newline, tab | written | written | taken | U "takes what both clients write", I "every axis" |
| Normalization | an NFD name | written, `git status` dirty | written | rule 2: NFC | U "refuses NFD", I "case-only collisions and non-NFC" |
| Normalization | the NFC and NFD forms of one name | collide: one is lost | written | rule 2: NFC | U "folds the pairs" |
| Case | `A`/`a`, `ß`/`ss`, `ẞ`/`ss`, `ς`/`σ`, `ﬀ`/`ff`, `K` (Kelvin)/`k` | collide: one is lost | written | rule 2: one caseKey | U "gives one key to every pair APFS measured", I "every axis" |
| Case | a directory and a file one fold apart (`Dir/x`, `dir`) | collide, dirty | written | rule 2: keys cover directories | I "case-only collisions and non-NFC" |
| Case | a symlink and a directory one fold apart (`Lnk -> /tmp`, `lnk/x`) | dirty, no warning | written | rule 2: one caseKey | I "every axis" |
| Case | `ı`/`i`, a name with and without an ignorable code point (U+200C), `Ａ`/`A` | written apart | written | taken | U "keeps apart what APFS keeps apart", I "every axis" |
| Length | a 256-byte name | fails: ENAMETOOLONG | fails | rule 2 | U "counts lengths", I "names, paths and symlink targets" |
| Length | 86 Hangul syllables (258 bytes) | written | fails: ENAMETOOLONG | rule 2 | U "counts lengths", I "names, paths and symlink targets" |
| Length | a 1024-byte symlink target | fails: ENAMETOOLONG | written | rule 2 | I "names, paths and symlink targets" |
| Components | `.`, `..` | fails: invalid path | fails | fsck, then rule 2 | U "refuses empty, . and ..", I "every axis" |
| Components | an empty name | git refuses to pack it | (same) | fsck, then rule 2 | U "refuses empty, . and .." |
| Components | `.git`, `.GIT`, `.git.`, `git~1` | fails: invalid path | fails | fsck, then rule 2 | U "refuses empty, . and ..", I "a .git path component" |
| Components | `.g<U+200C>it` (HFS+ ignorable) | fails: invalid path | written | fsck, then rule 2 | U "refuses empty, . and ..", I "every axis" |
| Components | a symlinked `.gitmodules` | fails: invalid path | fails | fsck, then rule 2 | U "knows a .gitmodules", I "every axis" |
| Named fork | `d/..namedfork/rsrc`, `d/e/..namedfork/rsrc`, and `rsrc` as a directory (`d/..namedfork/rsrc/x`) | fails: ENOENT (the directory's resource fork) | written | rule 2 | U "refuses a ..namedfork component", I "every axis" |
| Named fork | `..namedfork/rsrc` at the top of the tree | written, but an absolute path to it reads the clone's fork: ENOENT | written | rule 2 | U "refuses a ..namedfork component" |
| Named fork | `d/..namedfork/data`, `d/..namedfork/other`, a file `d/..namedfork` | written | written | rule 2 (the whole component) | U "refuses a ..namedfork component" |
| Named fork | `..NAMEDFORK/rsrc`, `..namedfork/RSRC`, `..named<U+200C>fork/rsrc` | written | written | taken | U "refuses a ..namedfork component", I "every axis" |
| Windows names | `a:b`, `a\b`, `a.`, `a `, `CON`, `aux.md`, `<>\|?*"` | written | written | taken | U "takes what both clients write", I "every axis" |
| Symlinks | a symlinked `.gitattributes` | written (git ignores it as attributes) | written | taken | none (not a breaker) |
| Symlinks | target not UTF-8, or with an unassigned code point | written | written | taken | none (not a breaker) |
| Symlinks | empty target | written | fails: ENOENT | rule 3/4/7: not a link target | I "rules 3, 4, 7 hold for symlinks" |

Encoding. Git paths are bytes. The hook decodes each one as UTF-8 and refuses it when that
fails. A lossy decode would turn the bad byte into U+FFFD, which is NFC and would pass.

Code points. APFS refuses a name with a code point its Unicode version does not assign, and
noncharacters. macOS 15.6 and 26.2 both take Unicode 16.0 and refuse the 17.0 additions, so the
hook accepts Unicode 16.0 assigned code points less noncharacters. The table is generated from
the Unicode Character Database (`scripts/server/gen-unicode-tables.mjs`) into
`src/server/unicode-tables.mjs`. Raise the version only after every client Mac takes it.
NFC and the case key's NFD come from the runtime's ICU, not from the table, so the server
refuses to run on a Node whose `process.versions.unicode` is older than the table: an ICU that
does not know a 16.0 code point has no decomposition for it, takes an NFD name as NFC and gives
a pair APFS matches two keys. Normalization is stable for assigned code points, so a later
version agrees. The installed Node 22.23.3 has Unicode 17.0; Node 22.5 (ICU 75) has 15.1.

Named fork. macOS path lookup reads a path that ends in `/..namedfork/rsrc` as the resource
fork of the file before it (xnu `bsd/vfs/vfs_cache.c`, `_PATH_RSRCFORKSPEC`, compared byte for
byte). A directory has no resource fork, so the checkout fails. At the top of the tree git's
relative open still writes `..namedfork/rsrc`, but any tool that opens it by absolute path gets
the clone directory's fork. Rule 2 refuses the whole `..namedfork` component rather than the
spellings measured to break: the name has no other use, and the rule then does not depend on
how a client tool spells the path. Other spellings (`..NAMEDFORK`, `RSRC`) are ordinary names
to the kernel and are taken.

Special names. Besides `.` and `..`, the names macOS and Linux path lookup treat specially, and
the names the systems reserve, swept with a macOS and a Linux clone of each (all at the top of
the tree and under `vault/`):

| Name | Where it is special | macOS clone | Linux clone | Receive |
|---|---|---|---|---|
| `..namedfork` | macOS lookup, after any component | see the table above | written | refused (rule 2) |
| `.vol/<fs>/<id>`, `.nofollow/`, `.resolve/<n>/` | macOS lookup, only at the start of an absolute path (`/.vol/`; xnu `bsd/vfs/vfs_lookup.c`) | written | written | taken: a tree path is relative and a clone is never `/` |
| `.HFS+ Private Directory Data\r`, `␀␀␀␀HFS+ Private Data` | HFS+ hard-link stores at a volume root | written | written | taken: volume root only, and the clients are APFS |
| `.Trashes`, `.fseventsd`, `.Spotlight-V100`, `.DocumentRevisions-V100`, `.TemporaryItems`, `.MobileBackups`, `.PKInstallSandboxManager`, `.file`, `.VolumeIcon.icns`, `.metadata_never_index` | macOS, at a volume root | written | written | taken |
| `.DS_Store`, `Icon\r`, `.localized`, `._a.md` beside `a.md` | Finder metadata; AppleDouble (`._`) files only on volumes without extended attributes | written | written | taken |
| `dev/fd/0`, `dev/null`, `System/Volumes/Data/x`, `private/var/x` | macOS devices and firmlinks, absolute paths from `/` | written | written | taken: relative |
| `lost+found`, `proc/self`, `sys`, `dev/fd/1` | Linux, at a filesystem root or `/` | written | written | taken: relative |
| symlinked `.gitignore`, `.mailmap` | git does not follow them | written | written | taken |

Extended attributes reach a path only through `..namedfork/rsrc` (the resource fork
attribute); the others take `getxattr(2)` and friends, which a checkout never calls. Linux
reserves only `/` and NUL in a name; a git path holds neither.

Case. APFS matches names by canonical caseless matching: NFD, full case folding (CaseFolding
statuses C and F, not the Turkic T), NFD again. `caseKey` does the same with the Unicode 16.0
table. A lower-case compare misses `ß`/`ss`, `ς`/`σ` and `ﬀ`/`ff`. The test fixture
`apfs-name-matching.fixture.mjs` holds 1734 pairs measured on APFS: every pair that was one file
has one key, and every pair that was two files has two.

Lengths:

| Limit | Bytes | Why |
|---|---|---|
| One path component | 255 | ext4 `NAME_MAX`. APFS allows 255 characters, which is never fewer bytes |
| Whole path | 768 | macOS `PATH_MAX` is 1024 with the NUL; 768 leaves 255 bytes for the clone directory the path sits under. Linux allows 4095 |
| Symlink target | 1023 | macOS `symlink(2)` takes at most 1023 bytes; Linux 4095 |

Lengths are counted on the path as stored, which rule 2 already holds to NFC. APFS and Linux
keep a name as written, so the decomposed (NFD) form, which can be longer, never reaches a
disk. A push that deletes such a path is accepted.

Out of scope: Windows names (`:`, `\`, trailing dots and spaces, `CON`), which both clients
write. A case-sensitive APFS volume and a Linux case-folding directory match fewer names than
the hook refuses, so they need nothing more.

### Symlinks, fsck and post-receive

Rules 3, 4 and 7 apply to every tree entry that carries a blob: regular files and symlinks.
Gitlinks carry no blob and are left out. A symlink's blob is its link target, and git-lfs never
turns a symlink into a pointer, so a symlink passes only while it is a link target: 1 to
4096 bytes with no NUL. That holds at an LFS path as well. Any other symlink is refused under the
rule its path falls in: 3 at an LFS path, 7 in a reject place, 4 anywhere else. A link-target
symlink with an LFS extension in a reject place is still refused by rule 7. A link target over
1023 bytes is refused by rule 2.

The store also sets `receive.fsckObjects=true`. A pack with a tree that a checkout cannot write
(a `.git` component in any spelling git reads as one, `.`, `..` or an empty name, a symlinked
`.gitmodules`, a bad mode) is refused before the hooks run. Such a tree would stop `tree/` from
following and break every clone's checkout. Rule 2 refuses most of those paths on its own, so they
stay out even with fsck off: `.git` in any case, with trailing dots or spaces, as the short name
`git~1` or with code points HFS+ ignores, an empty name, `.`, `..`, and a symlinked `.gitmodules`.
Only fsck refuses the rest: the other NTFS spellings of `.git` (a stream suffix such as `.git:x`
or `git~1:x`, `git~1` followed by dots or spaces), the NTFS spellings of a symlinked
`.gitmodules` (`gitmod~1`, `.gitmodules.`) and bad modes. Keep `receive.fsckObjects` on.

`origin.git/hooks/post-receive` runs `vault server post-receive`: it appends
`{seq, ref, old, new, ts}` to `state/events.jsonl` and moves `tree/` (a detached linked
worktree, LFS pointers left as pointers) to the new `main`. The checkout writes files by the
umask, so it then tightens every `_credentials/` directory of `tree/` to 0600 files / 0700
directories (the rule of [sync.md](sync.md#credential-modes), same code). Before the checkout it
refreshes the tree's index: a chmod changes a file's ctime, and a forced checkout would rewrite
every such stat-dirty file by the umask, unchanged credentials included. A path it cannot tighten
is reported to the pusher on stderr and appended to `state/receive-log.jsonl`
(`event: "credential-modes"`, paths and modes only); the push itself is already in.

## Large-file store (CAS)

Uploads stream to `lfs/incoming/`, are hashed on the way in, must hash to the oid, are
fsynced and set to 0444, then renamed into `lfs/objects/<aa>/<bb>/<oid>`. An object that
fails the hash never lands. A `PUT` must carry `Content-Length` (git-lfs always sends one). A
chunked upload gets 411, because the disk reserve needs the size before the first byte and
the body is then cut off at exactly that length.

Each `PUT` reserves its `Content-Length` before it reads the body and gives it back when the
upload ends. It gets 507 unless the free space, less what uploads in flight have reserved and
less its own size, stays above `diskReserveGB`. So two uploads at once cannot both spend the
same free space. Until an upload ends, its bytes already on disk count twice (in free space and
in its reservation), so the error is toward refusing. An upload must bring 1 MiB (or the rest
of its body) in every minute, about 17 KiB/s. One that stalls, or trickles a byte at a time to
keep its socket open, is cut and its reservation goes back. The batch API's 507 check also subtracts the
reservations, but only a `PUT` reserves.

Objects uploaded by a push that the receive rules then refuse stay in the CAS (git-lfs uploads
before the refs are sent); v1 does not reclaim them.

`GET /v1/health` reports `growthAlert` when a store's CAS took in more than
`growthAlert.thresholdGB` (5 GB) over `growthAlert.windowDays` (7), measured from object
mtimes and rescanned every 10 minutes.

## The file API

`GET /v1/stores/<id>/file` reads one regular file of the tree declared at the repo root or under
`vault/`, from git objects of `origin.git` (`ls-tree` and blobs), never from the `tree/` checkout:
a pushed tree may hold symlinks, even ones pointing outside the store, and a filesystem read would
follow them. It refuses `_credentials/` and `_sync-conflicts/` at any depth in any case, `.git`
components, `..`, symlinks, gitlinks and directories, and serves only `main` or its ancestors.
The answer carries `X-Vault-Commit`, `X-Vault-Blob` and `X-Vault-Mode`.

There is no search index or search API: clients search their clone with `rg`. A store directory
left by an older server may still hold `<store>/index/` (`vault-fts.db`) and
`state/index.json` / `state/index.lock`; nothing reads them, and they can be deleted
(`state/events.jsonl` stays — the clients' sync daemons long-poll it).

## `server.json`

```json
{
  "version": 1,
  "listen": ["<tailnet-ip>:7741", "127.0.0.1:7741"],
  "dataDir": "/data/vaults",
  "diskReserveGB": 8,
  "diskWarnGB": 20,
  "maxNonLfsBlobBytes": 33554432,
  "warnNonLfsBlobBytes": 10485760,
  "growthAlert": { "windowDays": 7, "thresholdGB": 5 },
  "junkPatterns": null,
  "auth": { "mode": "tailscale", "tailscaleBin": "tailscale", "whoisCacheSeconds": 60, "selfAddresses": [] },
  "tokens": [{ "id": "laptop-writer", "sha256": "<sha256 of the token>", "role": "writer", "stores": ["kuma-main-vault"] }],
  "stores": {
    "kuma-main-vault": {
      "kind": "vault",
      "owners": ["you@example.com"],
      "writers": [],
      "readers": [],
      "binaries": { "reject": [] },
      "encryption": null
    }
  }
}
```

Unknown keys and wrong types are errors. serve re-reads the file within a second of a change;
a broken edit keeps the previous config running and shows up as `configError` in health.

Tokens: the file holds only each token's sha256. Record the value in the vault
`_credentials` before handing it out.

```sh
sudo vault server token add --id laptop-writer --store kuma-main-vault --role writer   # prints the value once
sudo vault server token list
sudo vault server token rm --id laptop-writer
sudo vault server set-reject --store kuma-main-vault --from vault/vault.config.json --tree-prefix vault
#   accepts ["glob", ...] | {"reject": [...]} | {"binaries": {"reject": [...]}}. A vault's list is
#   relative to its declared tree; rule 7 matches repo paths, so pass --tree-prefix <tree dir>.
sudo vault server init-store <id> --owner you@example.com
sudo vault server store list
sudo vault server store rm <id>                          # keeps the directory (--keep-data, the default)
sudo vault server store rm <id> --purge --confirm <id>   # also deletes the directory
```

### Removing a store

`vault server store rm <id>` takes the store out of `server.json` in one atomic write (the same
write path as `token rm`):

- the store entry and its access lists go;
- a token scoped only to this store goes; a token that also names other stores keeps them and
  loses this one; `*` tokens stay;
- `backup.stores` drops the id when it lists it (if that leaves it empty, backups cover no
  store; `vault server backup configure --all-stores` covers them all again);
- every other store and token stays as it was.

serve re-reads the file within seconds (on the next request or index pass); from then on the
store's URLs answer 404. An id that is not in `server.json` is refused and nothing is written.

The directory is kept by default: `vault server init-store <id> [--owner …]` brings the store
back with its history; its access lists, tokens and `binaries.reject` are whatever is given
again (`set-reject` puts the reject list back). `--purge --confirm <id>` (the id typed twice) also deletes it, and only when it lies
inside `dataDir`, holds an `origin.git` and no store that stays has the same directory, one
inside it or one around it (paths compared after resolving symlinks); otherwise it refuses
before changing anything. It deletes the directory it judged: when the store's path is a
symlink, the data the link points to goes, then the link.
Snapshots the backup already holds are not touched: they age out by the keep policy.

## Backup

`kuma-vault-backup.timer` runs `vault server backup nightly` every day at 04:30 Asia/Seoul
time (the schedule is fixed in `src/server/backup-units.mjs`). restic's prune takes an
exclusive lock, so every restic call here waits up to `backup.retryLock` for a lock held by
another client of the same repository. `vault server install` writes the service and
the timer and enables the timer only when `server.json` has a `backup` block.

`backup.host` is required in that block and has no default: it is the group forget, drill and
restore select by, so renaming the machine must not move it. `vault server backup configure`
writes it once — `--host <name>`, or this machine's hostname — and later runs keep it.

Per store, one restic snapshot with `--host <backup.host>` and `--tag <store id>` holding only
`origin.git`, `lfs/objects`, `state` and the config directory, minus the credential directory.
`tree/` is rebuilt from `origin.git`; `lfs/incoming/` holds only unverified
uploads. Then:

- **forget** keeps `backup.keep` (daily 14, weekly 8, monthly 12) and every snapshot tagged
  `backup.preCutover.tag`, selecting only `--host <backup.host> --tag <store>` — other hosts'
  groups in the same repository are never selected. The removals are computed first with
  `forget --dry-run`; if one of them is another host's, carries any tag other than the store id
  or is pre-cutover, nothing is forgotten and the run fails. Otherwise exactly those ids are
  forgotten, and the snapshot list before and after must differ by exactly them before prune
  runs. Prune follows when something was removed.
- **drill** restores `origin.git` and `state` from the latest snapshot into
  `<dataDir>/.backup-drill/`, resets the refs to `state/backup-refs.json`, runs `git fsck
  --full`, then compares `backup.drill.text` (50) text blobs and `backup.drill.cas` (50) CAS
  objects by sha256 with the live store (a CAS object must also hash to its name). File counts
  on disk are checked after every restore, so a restore that matched nothing fails. Each sample
  has a floor of min(asked, live count), the live count read from the store itself (text blobs
  of the recorded `main` in the live repository, CAS objects on disk): a CAS listing that comes
  back empty while the store holds objects (a changed `restic ls --json` format, a snapshot
  without `lfs/objects`), a line of that listing that is not JSON, a short sample, and a store
  with nothing to verify all fail the drill. `lastDrill.text` and `.cas` record `live`,
  `required`, `available`, `sampled` and `matched`.
- **pre-cutover retention** (once per run; for a store that moved here from an older backup
  set, whose last snapshots carry `backup.preCutover.tag`): when `backup.preCutover.clockStartedAt` is set and
  `retentionDays` (14) have passed since, the snapshots carrying the tag and taken before the
  clock started are forgotten by id (whatever their host) and the repository is pruned. Before
  the clock starts or before the deadline nothing is forgotten.

Results go to each store's `state/backup-status.json` (served at `/v1/stores/<id>/backup-status`):
`lastBackupAt` (start time of the last good snapshot — everything on disk before it is in it),
`lastResult`, `consecutiveOk`, the last 30 `runs`, `forget`, `lastDrill`, `preCutover`.

**Why a snapshot of a live bare repository restores whole.** Objects are only ever added while
the job reads the store: stores are set `receive.autogc=false` and `gc.auto=0`, and gc runs
inside the job before it writes `state/backup-refs.json` (the refs as they were before restic
started). Every recorded ref points at objects that were on disk before restic read the objects
directory. A push that lands mid-backup can leave a newer ref in the snapshot; restore resets
the refs to the recorded file.

Credentials: restic password and S3 keys are files in `backup.credentialsDir`
(`/etc/kuma-vault/credentials`, root 0700, files 0600): `restic-password`,
`s3-access-key-id`, `s3-secret-access-key`. The unit hands them to the service user with
`LoadCredential=`; restic gets the password as `RESTIC_PASSWORD_FILE` and the keys in its own
environment, never on a command line. Values live in the vault `_credentials` first (custody).

```sh
sudo vault server backup configure --repository s3:https://<endpoint>/<bucket> [--host <name>] [--stores <id,...>]
sudo /opt/kuma-vault/current/bin/vault server install          # enables the timer now that backup is configured
sudo systemctl start kuma-vault-backup.service                  # a run now; journalctl -u kuma-vault-backup
sudo vault server backup status [--store <id>]
sudo vault server backup unconfigure                            # drop the block; install again disables the timer
sudo vault server backup drill --store <id>                     # store-touching verbs re-run as the store owner via systemd-run
sudo vault server backup restore --store <id> --target <empty dir>          # full restore + refs reset + fsck
sudo vault server backup pre-cutover-clock --started-at <YYYY-MM-DD>        # start the retention clock (a date = 00:00 Asia/Seoul)
sudo vault server backup retention [--now <iso>]                            # the retention step alone
sudo vault server backup forget-path --host <old host> --path <old repo path> [--dry-run]
```

`forget-path` thins one host + path group to its pre-cutover snapshot (`--keep-tag`); it refuses
a group with no such snapshot, since keep-tag alone would then forget the whole group. Like
`forget`, it computes the removals with a dry run first and forgets nothing if one of them is
another host's, lacks the path or is pre-cutover; then it forgets exactly those ids.

Disaster recovery: `restore` into an empty directory, move `<target>/<store path>` into place,
`chown -R kuma-vault:kuma-vault`, run `vault server init-store <id>` (hooks, settings); the next
push recreates `tree/`.

### Retiring a client-side backup routine

A vault that was backed up from the client (for example with the `kuma-vault-remote-backup`
skill) before it moved to a server can stop that routine once the server's backups have
proven themselves. Two client commands judge when.

`vault backup sample --store <id> [--kind hourly|mac-backup]` appends the sync daemon's
`ahead`, `uncollected` and `ignoredOutside.lfsExt` to `~/.kuma-vault/sync/<id>.retire-samples.jsonl`.
`vault backup retire-check --store <id> --routine-enabled true|false` judges four conditions
(`src/backup/retirement.mjs`): the server's last 3 runs ok with a passing drill on
one of them whose text and CAS samples are both non-empty, at their floors and all matched (a
drill record without the floors does not count); an alert-path probe record (`<id>.alert-probe.json`: injected `uncollected`, red
chip, delivered owner message); 72 hourly samples all clean with `ahead` 0 at every client backup
(one a day); no sub-directory `.gitignore` with an active rule. It prints `action` —
`retire`, `keep-running`, `stay-retired`, or `reenable` (retired and `uncollected` red, i.e.
one or more paths for over an hour, for 6 more hours) — and appends it to
`<id>.retirement.jsonl`. Applying the action is the routine owner's script.

## Tests

`src/server/*.test.mjs` (needs git, git-lfs and restic). `backup.integration.test.mjs` runs
the nightly job, the forget range, `forget-path` and the retention clock against a restic
repository on local disk. The integration test starts serve on a free
loopback port with a scratch store and drives two clones through pushes, fetches, LFS
transfers, every receive rule and the token rules. `serve-proxy.integration.test.mjs` pushes an LFS file
through an HTTPS proxy on loopback and checks the forwarded-header boundary. `remote-store.integration.test.mjs` pushes
secrets, sync-conflict copies and outward symlinks and checks that no file answer carries them
and that no search API or index exists, then moves a local store with `vault migrate to-remote`. `scripts/server/serve-e2e.sh` checks an
installed instance from a second Linux user (run as root on the server).
`scripts/server/lfs-reserve-race.mjs` races two LFS uploads against a running serve. Both
tests use it. It declares large sizes but sends one byte per upload.
