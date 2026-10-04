# Storage option 2 — your own Oracle Cloud Always Free server

You build a small server in your own Oracle Cloud (OCI) account and the vault's canonical
copy lives there. This computer keeps a fast local copy (text, plus small pointers for large
files) that a background daemon syncs. Agents keep working when this computer is asleep or
off, and the server costs nothing as long as you stay inside the Always Free limits below.

Values in angle brackets are yours to fill in: `<server-name>` (any short host name, for
example `vault-server`), `<tailnet>` (your Tailscale tailnet name), `<your-ip>`,
`<public-ip>`, `<device>`.

## What you end up with

```
this computer ──(Tailscale, WireGuard-encrypted)──> <server-name>
  ~/.kuma/vault (local copy)                          Ampere A1: 2 OCPU, 12 GB RAM, Ubuntu 24.04 (Arm)
  sync daemon                                         /data = separate block volume (vault + large files)
                                                      vault serve on port 7741, tailnet only
                                                      no public TCP port open
```

Time: about an hour of hands-on work. Two steps can make you wait: the paid-account upgrade
(up to a day or two) and finding free Arm capacity (minutes to days, step 7).

## Official limits this guide relies on

All rows checked against Oracle's and Tailscale's documentation on **2026-10-03**. Limits
change: re-check the page before you rely on a number.

| Fact | Value | Source |
|---|---|---|
| Arm compute (`VM.Standard.A1.Flex`) | first 1,500 OCPU hours and 9,000 GB hours per month free, "equivalent to 2 OCPUs and 12 GB of memory" | [Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) |
| AMD micro (`VM.Standard.E2.1.Micro`) | up to two instances, 1 GB memory each | same page |
| Block storage | 200 GB total (boot volumes included) and five volume backups | same page |
| Minimum boot volume | 47 GB per instance, any shape; a custom size in the console starts at 50 GB | same page; [Creating an Instance](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/launchinginstance.htm) |
| Object storage | trial and paid accounts: 10 GB Standard + 10 GB Infrequent Access + 10 GB Archive; Always Free-only accounts: 20 GB combined | Always Free Resources |
| Outbound data | 10 TB per month | same page |
| Home region | Always Free compute exists only in your home region, and the home region cannot be changed after sign-up | [Free Tier](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm); [Sign Up](https://docs.oracle.com/en-us/iaas/Content/GSG/Tasks/signingup_topic-Sign_Up_for_Free_Oracle_Cloud_Promotion.htm) |
| A1 availability | A1 instances can be created in any availability domain "except South Korea North (Chuncheon)" | Always Free Resources |
| Idle reclaim | an Always Free instance may be reclaimed if over 7 days the 95th-percentile CPU, the network, and (A1 only) the memory utilization all stay under 20% | Always Free Resources |
| Out of host capacity | "a temporary lack of Always Free shapes in your home region": try another availability domain, wait and retry, or upgrade to Pay As You Go | Always Free Resources |
| Free trial | US$300 credit for up to 30 days; Always Free resources keep running after it ends | Free Tier |
| Paid account | "If you have a paid account, you will not be billed for any Always Free resources you are using." | [When the Promotion Expires](https://docs.oracle.com/en-us/iaas/Content/GSG/Tasks/signingup_topic-What_Happens_When_the_Promotion_Expires.htm) |
| Upgrade | card authorized for US$100 (reversed); the upgrade "can take a day or two" | [Managing Account Upgrades](https://docs.oracle.com/en-us/iaas/Content/Billing/Tasks/changingpaymentmethod.htm) |
| Console MFA | the default "Security Policy for OCI Console" sign-on policy requires every user to enroll in MFA | [Security Policy for OCI Console](https://docs.oracle.com/en-us/iaas/Content/Security/Reference/iam_security_topic-iam_mfa_identity_domains_signon_policy.htm) |
| Block volume mount | use the UUID plus `_netdev` and `nofail` in `/etc/fstab` | [fstab options](https://docs.oracle.com/en-us/iaas/Content/Block/References/fstaboptions.htm) |
| Volume resize | grows online, while attached; volumes never shrink | [Resizing Volumes](https://docs.oracle.com/en-us/iaas/Content/Block/Tasks/resizingavolume.htm) |
| Shape change | a running instance is rebooted when its shape changes | [Changing the Shape](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/resizinginstances.htm) |
| Tailscale direct port | UDP 41641; opening it is optional (traffic falls back to slower relays) | [Tailscale firewall ports](https://tailscale.com/kb/1082/firewall-ports) |
| Tailscale key expiry | 180 days by default; can be disabled per device | [Tailscale key expiry](https://tailscale.com/kb/1028/key-expiry) |

Not in Oracle's documentation (checked on the pages above, 2026-10-03): whether a Pay As You
Go account is exempt from idle reclaim. Many community reports say paid accounts are not
reclaimed, but Oracle publishes no such exception. This guide upgrades anyway, because a
vault server sits idle most of the time.

## Before you start

- A credit or debit card with a major network logo that does not need a PIN. Sign-up places
  a small temporary hold; you are not charged unless you upgrade.
- A phone number and an email address. Oracle allows one cloud account per email address.
- An authenticator app or a password manager that can hold a one-time-code secret.
- A free [Tailscale](https://tailscale.com) account, with Tailscale installed on this computer.
- On this computer, what [local.md](local.md#before-you-start) lists: git 2.38 or newer, Git
  LFS, a git identity and `kuma-vault` on the PATH.
- Somewhere safe for the new secrets (account password, MFA secret and bypass codes, SSH
  private key): a password manager while you build. Write each secret there **before** you
  use it. Once setup finishes (step 12), copy them into the vault's `_credentials` folder.

## Step by step

### 1. Sign up and choose the home region

Sign up at <https://www.oracle.com/cloud/free/>. The **home region** is permanent, and Always
Free compute only runs there.

- Pick the region closest to you **from the list the form offers you**. The list can leave
  out the region nearest to you; if it does, take the nearest region it offers. A server
  one country away adds a few tens of milliseconds, which you won't notice for a vault.
- Avoid South Korea North (Chuncheon) even if it is offered: Oracle states A1 cannot be
  created there.
- Large, popular regions often run out of free Arm capacity (community reports; Oracle
  publishes no figures). A slightly less popular region nearby can save days at step 7.

Trap: the email verification link expires after about 30 minutes. If the sign-up page says
its data is no longer available, start again from the email step.

### 2. Verify the card

Enter the card on the payment form. The form is an embedded payment frame from Oracle's
payment provider.

Trap: "Enter a valid card number" means the number really is wrong. Read it off the card
again; do not guess-correct digits.

After the card check, accept the agreement and wait for "Get Started" and then "Fully
Provisioned" emails. Expect them within about half an hour.

### 3. Turn on sign-in MFA

The first console sign-in forces MFA enrollment. Choose the mobile-app passcode (Oracle
Mobile Authenticator). Also generate **bypass codes** and keep them with the password.

- A standard TOTP authenticator app may work with offline passcode enrollment, but Oracle
  documents only its own app: if yours is rejected, use Oracle Mobile Authenticator.
- If an MFA secret is ever shown in a log or a shared screen, enroll a new device and delete
  the exposed one (My profile → Security).

### 4. Upgrade to Pay As You Go

Billing & Cost Management → Upgrade and Manage Payment → Pay As You Go → choose the account
type (Individual or Corporate) → accept the terms → **Upgrade your account**.

- Why: idle reclaim (see the limits table). Always Free resources stay free on a paid account.
- Trap: right after sign-up the page can be blocked by "account provisioning is in progress",
  or the Upgrade button can be hidden behind a cookie or theme overlay. Wait for the
  "Fully Provisioned" email and dismiss overlays before retrying.
- The upgrade finishes with an email saying your subscription has been updated. You can do
  steps 5–8 while you wait.
- **From now on anything outside the Always Free limits is billed.** Create a budget with an
  email alert at a small amount (Billing & Cost Management → Budgets;
  [Budgets](https://docs.oracle.com/en-us/iaas/Content/Billing/Concepts/budgetsoverview.htm)).

### 5. Make an SSH key

On this computer:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/<server-name>_ed25519 -C <server-name>
```

Copy the private key into your secret store right away. You upload only the `.pub` file.

### 6. Network

Let the instance form in step 7 create the network (**Create new virtual cloud network**,
with a **public subnet**), or create a VCN with an internet gateway, a public subnet and a
default route `0.0.0.0/0 → internet gateway` yourself. Any extra pieces a wizard adds (NAT or
service gateway, private subnet) are not used by this guide.

Then open the public subnet's **security list** and narrow SSH to your own address only (if
step 7 creates the network for you, do this right after the instance is created):

```bash
curl -s https://ifconfig.me          # prints <your-ip>
```

Ingress rule: TCP, destination port 22, source `<your-ip>/32`. Leave the ICMP rules alone.

Trap: if this computer's public address changes (for example you switch to a phone hotspot)
SSH stops working until you update the rule. Do steps 7–10 in one sitting; after step 10
the address no longer matters.

### 7. Create the Arm instance

Compute → Instances → Create instance:

| Field | Value |
|---|---|
| Image | Canonical Ubuntu 24.04, the aarch64 (Arm) build that the console offers for an A1 shape |
| Shape | Ampere → `VM.Standard.A1.Flex`, **2 OCPU, 12 GB memory** |
| Networking | the public subnet from step 6, assign a public IPv4 address |
| SSH key | upload `~/.ssh/<server-name>_ed25519.pub` |
| Boot volume | default (≈47 GB) or a custom 50 GB. It counts against the 200 GB block total |

**"Out of host capacity"** is common. In order of effort:

1. Try another availability domain, if your region has more than one.
2. Ask for **1 OCPU, 6 GB** first (smaller requests fit more often). Once it is running,
   stop it and change the shape to 2 OCPU, 12 GB (the instance's Edit page, or
   `oci compute instance update --shape-config`; a running instance is rebooted by the change).
3. Retry every ~90 seconds. With the [OCI CLI](https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm)
   configured, a loop does it for you (fill in your own OCIDs; check flags with
   `oci compute instance launch --help`):

   ```bash
   for i in $(seq 1 80); do
     oci compute instance launch \
       --availability-domain "<ad-name>" --compartment-id "<compartment-ocid>" \
       --shape VM.Standard.A1.Flex --shape-config '{"ocpus":1,"memoryInGBs":6}' \
       --image-id "<ubuntu-24.04-aarch64-image-ocid>" --subnet-id "<public-subnet-ocid>" \
       --assign-public-ip true --boot-volume-size-in-gbs 50 \
       --ssh-authorized-keys-file ~/.ssh/<server-name>_ed25519.pub \
       --display-name <server-name> && break
     sleep 90
   done
   ```

4. **Land temporarily on a free AMD micro.** Create a `VM.Standard.E2.1.Micro` (1 GB RAM, up
   to two are free). It is an AMD (x86_64) shape: choose the plain Ubuntu 24.04 image, not
   the aarch64 build. Put all data on the separate block volume from step 8, never on the
   micro's boot disk, and do steps 8–11 on the micro. Keep retrying A1. When A1 arrives:
   1. On the micro: `sudo systemctl stop kuma-vault-serve` and `sudo umount /data`. Detach
      the volume in the console and attach it to the A1. Mount it there as in step 8,
      **without `mkfs`**.
   2. Remove the micro from your tailnet (admin console → Machines → the micro → Remove)
      **before** the A1 joins with the same `<server-name>`. Otherwise MagicDNS gives the A1
      a suffixed name (`<server-name>-1`) and the address this computer uses no longer
      reaches it.
   3. Do steps 9–11 again on the A1. The install finds the stores already on `/data` and
      keeps them. `/etc/kuma-vault/server.json` lived on the micro's boot disk, so pass the
      same `--store` and `--owner` again (and add any tokens again).
   4. **Terminate the micro and delete its boot volume** — it still counts against the
      200 GB. Then grow the data volume by the space that freed (step 8, growing it later).

### 8. Add a separate data volume

Keep the vault on its own block volume, not on the boot disk: you can move it to another
instance, grow it, and rebuild the instance without touching data.

Size it so that all boot volumes plus this volume stay at or under **200 GB**. With one A1 on
a 50 GB boot volume that is 150 GB. Every extra instance takes ~50 GB away from data.

Storage → Block volumes → Create (in your home region) → attach to the instance
(paravirtualized). On the server (`ssh -i ~/.ssh/<server-name>_ed25519 ubuntu@<public-ip>`):

```bash
lsblk                                         # find the new, empty disk: /dev/<device>
sudo mkfs.ext4 -L vault-data /dev/<device>    # only on a NEW, empty volume
sudo mkdir -p /data
sudo blkid /dev/<device>                      # copy its UUID
echo 'UUID=<uuid> /data ext4 defaults,noatime,nofail,_netdev 0 2' | sudo tee -a /etc/fstab
sudo mount -a && df -h /data
```

Growing it later: edit the volume size in the console (it grows online), then
`sudo resize2fs /dev/<device>`. If the console shows rescan commands for your attachment
type, run them first. A volume cannot be shrunk.

### 9. Join your tailnet

Still over the public address (`ssh -i ~/.ssh/<server-name>_ed25519 ubuntu@<public-ip>`, the
same login you used in step 8), on the server
([install guide](https://tailscale.com/kb/1031/install-linux)):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --hostname=<server-name>      # open the printed URL and approve
```

- In the Tailscale admin console → Machines → the server → **Disable key expiry**. Otherwise
  the server drops off your tailnet after the expiry period.
- Optional, for faster direct connections: add a security-list ingress rule
  **UDP 41641 from `0.0.0.0/0`**. Without it Tailscale still works through its relays.
- From this computer, check: `ssh -i ~/.ssh/<server-name>_ed25519 ubuntu@<server-name>`
  (MagicDNS name; the tailnet IP also works). Point your `~/.ssh/config` entry at it.
- Optional hardening: a server you own is a normal tailnet member and can reach your other
  devices. Tagging it and restricting it with tailnet access rules is a tailnet policy change;
  do it if you share the tailnet with others.

### 10. Close every public TCP port

Delete the TCP 22 rule from the security list. What stays: ICMP and (optionally) UDP 41641.
Then confirm from this computer, over the public internet:

```bash
nc -vz -w 5 <public-ip> 22 80 443      # every port must fail (timeout or refused)
```

From now on you reach the server only through the tailnet.

### 11. Install the vault server

The server runs the same engine as this computer. Copy it over the tailnet exactly as in
[other-remote.md › Copy the engine to the server](other-remote.md#copy-the-engine-to-the-server),
with `ubuntu@<server-name>` as the target (add `-i ~/.ssh/<server-name>_ed25519` after `ssh`
unless your `~/.ssh/config` entry from step 9 already names the key).

Find the Tailscale login of this computer, which becomes the store's owner: on the server,
`tailscale whois $(tailscale ip -4 <this-computer's-tailnet-name>)` prints it under
`User:` → `Name:`. Then, on the server:

```bash
sudo /opt/kuma-vault/<version>/bin/vault server install --store kuma-main-vault --owner <your-tailnet-login>
```

It puts Node 22 at `/opt/node`, installs git-lfs and restic, creates a `kuma-vault` system
user and `/data/vaults/`, writes `/etc/kuma-vault/server.json` (port 7741 on the tailnet
address and loopback only), creates the empty store `kuma-main-vault`, and registers the
`vault serve` service and a backup timer with systemd. It ends with
`serve healthy: version …`. Running it again repairs what is missing and never rewrites
`server.json`. Details and upgrades: [server.md › Install](../../../docs/server.md#install).

### 12. Connect this computer

```bash
kuma-vault setup --storage oracle --server http://<server-name>.<tailnet>.ts.net:7741
```

Setup checks the server, clones the empty store, writes its first commit with this server as
the only allowed remote, links `~/.kuma/vault` to it and starts the sync daemon — the full list
is in [other-remote.md › After either path](other-remote.md#after-either-path). Plain HTTP is
intended here: Tailscale's WireGuard tunnel already encrypts the traffic.

### 13. Confirm the cost is zero

- Billing & Cost Management → **Cost analysis**: no charges.
- The console's **Limits, Quotas and Usage** page ([service limits](https://docs.oracle.com/en-us/iaas/Content/General/Concepts/servicelimits.htm)), service Block Volume: `total-free-storage-gb`
  is 200 and your usage is at or under it; `free-backup-count` is 5.
- Your budget alert from step 4 is active.

## Removing a store

Removing a store you no longer use is the same on every server:
[other-remote.md › Removing a store](other-remote.md#removing-a-store) (Tailscale path).

## Know before you rely on it

- **The server holds your vault in plain text, `_credentials` included**, and whoever
  operates the cloud can in principle read that disk
  ([storage policy](../../kuma-vault/docs/storage-policy.md#what-this-means-for-a-user)).
  Choose [local](local.md) if that is not acceptable.
- Turn on the server's nightly backup and restore drill:
  [server.md › Backup](../../../docs/server.md#backup).
- Stay inside the limits: one A1 at 2 OCPU/12 GB, block volumes (boot included) at or under
  200 GB, at most two micros. Anything more is billed on a Pay As You Go account.
- The home region and the account email cannot be changed later.
