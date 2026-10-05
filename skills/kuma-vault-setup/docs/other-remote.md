# Storage option 3 — a Linux server you already have

Use a server you already control (a VPS from any provider, a home server, a machine in your
office) as the vault's canonical copy. This computer keeps a fast local copy that a
background daemon syncs, exactly as in the [Oracle option](oracle.md). Only how you reach the
server differs.

Values in angle brackets are yours: `<server-name>`, `<tailnet>`, `<device>`,
`vault.example.com` (a domain name you own).

## The server must have

| Need | Why / how to check |
|---|---|
| Linux with systemd, x86_64 or arm64 | `vault serve` runs as a systemd service. `uname -m`, `systemctl --version` |
| SSH login with `sudo` | the installer creates a system user and a service |
| Disk for the vault **and** its large files, ideally a separate data disk mounted at `/data` | the vault's text is small; large files (images, audio, PDFs) dominate. A separate disk can be grown or moved without touching the OS; mount it by UUID in `/etc/fstab` |
| git and curl | `git --version`, `curl --version` (Ubuntu and Debian server images have both) |
| Outbound internet | the installer downloads Node and installs git-lfs and restic with apt |
| Always on | the server is the canonical copy; this computer only syncs to it |

This computer needs what [local.md](local.md#before-you-start) lists: git 2.38 or newer, Git
LFS, a git identity and `kuma-vault` on the PATH.

## Copy the engine to the server

Both paths below install the same engine this computer runs. On this computer (your agent
can run this for you; `kuma-vault` must be on the PATH, `realpath` comes with macOS 13 or
later):

```bash
ENGINE="$(dirname "$(dirname "$(realpath "$(command -v kuma-vault)")")")"
VERSION="$(node -p "require('$ENGINE/package.json').version")"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$ENGINE" -czf - bin src package.json \
  | ssh <user>@<server> "sudo mkdir -p /opt/kuma-vault/$VERSION && sudo tar --no-same-owner -xzf - -C /opt/kuma-vault/$VERSION"
```

`<server>` is the address you reach it by: the tailnet name (path A) or its public name or
IP (path B). The install below runs from `/opt/kuma-vault/<version>/` and points
`/opt/kuma-vault/current` at it.

## Pick how this computer reaches the server

| | A. Tailscale (recommended) | B. HTTPS + token |
|---|---|---|
| Public ports open on the server | none | 80 and 443 |
| Who can connect | devices you approve in your tailnet | anyone on the internet who has the token |
| You need | a free Tailscale account | a domain name pointing at the server, and its ports 80/443 reachable |
| Identity | your tailnet login | a per-device token |

Choose B only when Tailscale is not an option (for example a company network that blocks it).

## A. Over Tailscale

1. On the server ([install guide](https://tailscale.com/kb/1031/install-linux)):

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up --hostname=<server-name>      # open the printed URL and approve
   ```

   In the Tailscale admin console → Machines → the server → **Disable key expiry**
   ([key expiry](https://tailscale.com/kb/1028/key-expiry), checked 2026-10-03). Opening
   UDP 41641 inbound is optional and only speeds up direct connections
   ([firewall ports](https://tailscale.com/kb/1082/firewall-ports), checked 2026-10-03).
2. Check from this computer: `ssh <user>@<server-name>` works over the tailnet.
3. Close the server's public SSH port in your provider's firewall, if you can, and confirm
   from outside with `nc -vz -w 5 <public-ip> 22` (must fail). Keep a provider console or
   rescue login in case Tailscale ever stops.
4. Copy the engine (section above). Find this computer's Tailscale login, which becomes the
   store's owner: on the server, `tailscale whois $(tailscale ip -4 <this-computer's-tailnet-name>)`
   prints it under `User:` → `Name:`. Then on the server:

   ```bash
   sudo /opt/kuma-vault/<version>/bin/vault server install --store kuma-main-vault --owner <your-tailnet-login>
   ```

   It installs Node, git-lfs and restic, a `kuma-vault` system user, `/data/vaults/`, the
   empty store `kuma-main-vault`, the `vault serve` service (port 7741, tailnet address and
   loopback only) and a backup timer, and ends with `serve healthy: version …`.
5. On this computer:

   ```bash
   kuma-vault setup --storage remote --server http://<server-name>.<tailnet>.ts.net:7741
   ```

   Plain HTTP is intended: Tailscale's WireGuard tunnel already encrypts the traffic.

## B. Over HTTPS with a token

`vault serve` listens on loopback only. A reverse proxy on the same server terminates HTTPS
and forwards to it; every request except the health check must carry a token.

1. Point `vault.example.com` (A/AAAA record) at the server, and allow inbound TCP 80 and 443.
2. Copy the engine (section above), then on the server:

   ```bash
   sudo /opt/kuma-vault/<version>/bin/vault server install --auth token --store kuma-main-vault
   ```

   This writes `"auth": { "mode": "token" }` and `"listen": ["127.0.0.1:7741"]` to
   `/etc/kuma-vault/server.json` the first time (no Tailscale needed) and ends with
   `serve healthy: version …`. On a server whose `server.json` already exists, `--auth`
   must match it; install never rewrites that file.
   The token-mode install has not yet been run on a freshly built machine; the steps after
   it were run against a token-mode server, large files included.
3. Make a token for this computer and write it straight into a file here, without showing
   it on screen. On this computer:

   ```bash
   mkdir -p ~/.kuma
   (umask 077; ssh <user>@<server> sudo /opt/kuma-vault/current/bin/vault server token add \
     --id <this-computer> --store kuma-main-vault --role writer > ~/.kuma/kuma-main-vault.token)
   ```

   The server keeps only the token's sha256 and shows the value once. Copy it from that file
   into your password manager now, and into the vault's `_credentials` once setup is done.
   Never paste it into a chat or a log. A lost token is replaced with
   `vault server token rm --id <this-computer>` and a new `token add`.
4. Install [Caddy](https://caddyserver.com/docs/install) and give it this Caddyfile:

   ```
   vault.example.com {
   	reverse_proxy 127.0.0.1:7741
   }
   ```

   Caddy fetches and renews the certificate on its own when the domain's DNS points at the
   server, ports 80 and 443 are reachable, and its data directory is writable
   ([automatic HTTPS](https://caddyserver.com/docs/automatic-https), checked 2026-10-03).
5. On this computer:

   ```bash
   kuma-vault setup --storage remote --server https://vault.example.com --token-file ~/.kuma/kuma-main-vault.token
   ```

   Setup copies the token into the clone (`.git/kuma-vault/token`, mode 600), where git
   and the sync daemon read it. Once it is also in your password manager you can
   delete `~/.kuma/kuma-main-vault.token`.

   That file is the clone's only credential for this server. A keychain or other credential
   helper in your git config (macOS git uses the login keychain by default) is not asked for
   it and gets no copy of the token, so the background daemon never stops at a keychain
   prompt it cannot answer. A clone set up with an older kuma-vault gets the same rule when
   you run `kuma-vault sync install --repo ~/.kuma/vaults/kuma-main-vault` once.
6. Check: `curl -s https://vault.example.com/v1/health` answers, and a store path without
   the token is refused:
   `curl -s -o /dev/null -w '%{http_code}\n' 'https://vault.example.com/v1/stores/kuma-main-vault.git/info/refs?service=git-upload-pack'`
   prints `401`. Then make a small change in the vault, wait a few seconds, and run
   `kuma-vault sync status`: it shows `daemon pid …`, `ahead 0` and a fresh `last sync`. On
   macOS, `security find-internet-password -s vault.example.com` says the item could not be
   found: the token stayed out of the keychain.

## After either path

Setup checks the server's `/v1/health`, clones the empty store to
`~/.kuma/vaults/kuma-main-vault` (`vault clone`), writes the store's first commit with the
[storage policy](../../kuma-vault/docs/storage-policy.md) (this server is the only allowed
remote; pushes anywhere else are refused), registers the store, links `~/.kuma/vault` to it,
pushes, and starts the sync daemon on macOS (`vault sync status`). Every step and its undo:
[setup.md › Storage](../../../docs/setup.md#storage). An existing
`~/.kuma/vault` is handled as in [local.md](local.md#what-is-at-kumavault-now). A second
computer runs the same `setup` command (with its own token on path B): it clones what is
there and adds nothing.

## Removing a store

For a store you no longer use (an extra store, a test store). Not the one `~/.kuma/vault`
points at: that is your vault.

1. On each computer that has it, stop its sync daemon and unregister it. The local copy in
   `~/.kuma/vaults/<id>` stays; delete it yourself once you are sure.

   ```bash
   kuma-vault sync uninstall --repo ~/.kuma/vaults/<id>
   kuma-vault store rm <id>
   ```

2. On the server:

   ```bash
   sudo /opt/kuma-vault/current/bin/vault server store list
   sudo /opt/kuma-vault/current/bin/vault server store rm <id>
   ```

   This takes the store out of `/etc/kuma-vault/server.json` in one step, together with any
   token made only for it (a token that also covers other stores keeps them). Other stores
   and tokens are not touched. The running server notices within seconds; no restart is
   needed. An id the server does not have is refused.

3. The store's data stays in `/data/vaults/<id>`, so a mistake can be undone with
   `sudo /opt/kuma-vault/current/bin/vault server init-store <id> --owner <login>` (path A) or
   `init-store <id>` and a new `token add --store <id>` (path B): the history comes back, the
   access list and tokens are the ones you give it again.
   A list of rejected binary files set with `vault server set-reject` comes back empty too;
   give it again with
   `sudo /opt/kuma-vault/current/bin/vault server set-reject --store <id> --from <file>`, with the
   same flags as the first time (a `vault.config.json` given as `<file>` also needs
   `--tree-prefix <tree dir>`, e.g. `--tree-prefix vault`).
   Once you are sure, delete
   it with `sudo rm -rf /data/vaults/<id>`. To delete the data in step 2 already, type the id
   twice instead:

   ```bash
   sudo /opt/kuma-vault/current/bin/vault server store rm <id> --purge --confirm <id>
   ```

   Backups already taken of the store are not deleted; they expire by the backup's keep
   policy.

## Know before you rely on it

- **The server holds your vault in plain text, `_credentials` included**: anyone with root
  on that machine, or the provider's storage, can in principle read it
  ([storage policy](../../kuma-vault/docs/storage-policy.md#what-this-means-for-a-user)).
  Prefer a server only you administer.
- Turn on the server's nightly backup and restore drill:
  [server.md › Backup](../../../docs/server.md#backup).
- One server can hold several stores (work, family). On the server:
  `sudo /opt/kuma-vault/current/bin/vault server install --store <id> --owner <login>` (adds
  the store and gives it to the service user; path B: then `token add --store <id>`); on this
  computer:
  `kuma-vault setup --add-store <id> --storage remote --server <url>`. Each store has its own
  access list, but the server's administrator can still read every store's disk.
- Moving a `local` vault here later: [local.md](local.md#move-to-a-server-later).
