---
title: "Backup sshd Before do-release-upgrade: Surviving Ubuntu Distro Upgrades Without Losing SSH"
date: 2032-04-21T09:00:00-05:00
draft: false
tags: ["Ubuntu", "SSH", "Linux", "do-release-upgrade", "System Administration", "OpenSSH", "Disaster Recovery", "dpkg", "Cloud", "Automation"]
categories:
- Linux
- System Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "A production runbook for preserving SSH access while running do-release-upgrade on Ubuntu, covering dpkg conf prompts, sshd_config drift, an alternate-port fallback daemon, console access, and lockout recovery."
more_link: "yes"
url: "/backup-sshd-before-do-release-upgrade-safe-ubuntu-upgrades/"
---

A distribution upgrade is one of the few operations that can sever the very channel you are using to perform it. When you run `do-release-upgrade` over SSH, the upgrade replaces the OpenSSH server package, rewrites or prompts on `/etc/ssh/sshd_config`, restarts the daemon, and changes security defaults all while your shell session depends on that daemon staying alive. On a server in the next rack you can walk over and plug in a crash cart. On a fleet of cloud instances spread across regions, a lost SSH session can mean a locked-out host with no obvious path back in. This guide is a production runbook for keeping a guaranteed way into the box before, during, and after the upgrade.

<!--more-->

## Why a Distro Upgrade Threatens SSH Access

A point upgrade (`apt upgrade`) replaces individual packages within the same release. A release upgrade (`do-release-upgrade`) swaps the entire userland: it points `apt` at a new release pocket, dist-upgrades thousands of packages, and runs maintainer scripts that can rewrite configuration files. The OpenSSH server is squarely in the blast radius, and several distinct failure modes converge during the run.

### The Daemon Restarts Mid-Upgrade

When the `openssh-server` package is upgraded, its `postinst` maintainer script restarts the service. The already-running `sshd` process you are connected through keeps your existing session alive in most cases, because established connections are handled by forked child processes. But there is a window where the listening parent is being replaced. If anything goes wrong during that window, the new daemon may fail to bind, fail to parse a modified config, or come up with a security policy that rejects your next login. Your current session might survive, but the moment it drops you may have no way to reconnect.

### dpkg Configuration Prompts on sshd_config

If you have ever hand-edited `/etc/ssh/sshd_config`, `dpkg` treats it as a **conffile** that you have modified. When the new package ships a different default version of that file, `dpkg` cannot silently overwrite your changes, so it stops and asks what to do:

```text
Configuration file '/etc/ssh/sshd_config'
 ==> Modified (by you or by a script) since installation.
 ==> Package distributor has shipped an updated version.
   What would you like to do about it?  Your options are:
    Y or I  : install the package maintainer's version
    N or O  : keep your currently-installed version
      D     : show the differences between the versions
      Z     : start a shell to examine the situation
 The default action is to keep your current version.
*** sshd_config (Y/I/N/O/D/Z) [default=N] ?
```

This prompt is dangerous in two opposite ways. If you accept the maintainer's version (`Y`), every customization you made including the `Port`, `AllowUsers`, `PermitRootLogin`, and `AllowGroups` directives is replaced by upstream defaults. If you keep your version (`N`), you may retain a directive that the new OpenSSH release has removed or renamed, causing the daemon to refuse to start on the next restart. During an unattended or scripted upgrade this prompt can also hang the entire process waiting for input that never comes.

### Changed Defaults Between OpenSSH Releases

Even if you accept upstream defaults, those defaults shift between releases. The two that lock people out most often:

- **`PermitRootLogin`** moved from `yes` to `prohibit-password` and is increasingly shipped commented out, leaving the compiled-in default. If your only account is `root` with a password, a new default can shut you out entirely.
- **`PasswordAuthentication`** has trended toward `no` in hardened and cloud images. If you rely on a password rather than a key, the upgraded daemon may reject you.

Newer OpenSSH releases have also removed legacy options and deprecated weak key exchange and cipher algorithms. A directive that was valid on the old release such as an obsolete `KexAlgorithms` entry or a removed option name becomes a fatal parse error after the upgrade, and the daemon exits instead of starting.

### Host Keys and Drop-In Config Fragments

Two more subtle issues round out the list. First, modern OpenSSH reads `/etc/ssh/sshd_config.d/*.conf` via an `Include` directive near the top of the main config. Cloud images frequently place `50-cloud-init.conf` there with directives like `PasswordAuthentication yes`. An `Include` processes the first matching value, so a drop-in can silently override what you set in the main file and the precedence can change across releases. Second, while host keys in `/etc/ssh/ssh_host_*` are normally preserved, a botched upgrade or a restore from the wrong backup can regenerate them, triggering the dreaded `REMOTE HOST IDENTIFICATION HAS CHANGED` warning on every client and breaking automation that pins host keys.

## Understanding dpkg Conffile Handling in Depth

The single most common way a release upgrade breaks SSH is a mishandled conffile prompt. Understanding exactly how `dpkg` decides what to do with `/etc/ssh/sshd_config` lets you make the right call deliberately instead of guessing under pressure.

### How dpkg Tracks Conffiles

A conffile is any file a package registers in its `conffiles` control list. `dpkg` stores the MD5 hash of the version it originally shipped. On every upgrade it compares three things: the hash of the file as originally shipped (the old default), the hash of the file currently on disk, and the hash of the new file the upgraded package wants to install. The decision tree is straightforward once you see it laid out:

- If you never edited the file, the on-disk hash matches the old default, and `dpkg` silently installs the new version. No prompt.
- If you edited the file but the new package ships the same default as before, your version is kept silently. No prompt.
- If you edited the file *and* the new package ships a different default, `dpkg` cannot reconcile the two and stops to ask. This is the prompt that hangs upgrades.

You can inspect which files `dpkg` considers conffiles and whether your copy has drifted from the shipped original.

```bash
# List every conffile the openssh-server package registers
dpkg-query --showformat='${Conffiles}\n' --show openssh-server

# Show whether your sshd_config differs from the originally shipped version.
# "obsolete" or a hash mismatch here means dpkg WILL prompt on upgrade.
dpkg-query --showformat='${Conffiles}\n' --show openssh-server \
  | grep sshd_config
```

The output pairs each path with the hash `dpkg` recorded. If the live file's actual hash differs from that recorded hash, you have a modified conffile and should expect a prompt.

### The Force Options Explained Precisely

Three `dpkg` force flags control conffile behavior, and their semantics are easy to confuse:

- `--force-confold`: keep the version currently on disk (your modified file). New package's version is written alongside as `sshd_config.dpkg-dist` for later review.
- `--force-confnew`: install the package maintainer's new version. Your file is preserved as `sshd_config.dpkg-old`.
- `--force-confdef`: let `dpkg` take the *default* action for the prompt. For a modified conffile the default is to keep your version, so `confdef` alone behaves like `confold` here. It matters most when combined with the others.

The combination most operators want for an unattended upgrade is `--force-confdef,confold`: take the default where one exists, and otherwise keep the existing file. This never silently clobbers a hardened `sshd_config`.

```bash
# Pass conffile policy through to dpkg for the whole upgrade run.
# confdef takes the default action; confold keeps your file when modified.
sudo apt-get -o Dpkg::Options::="--force-confdef" \
              -o Dpkg::Options::="--force-confold" \
              dist-upgrade
```

For `do-release-upgrade`, which wraps `apt`, the same policy is applied by exporting it through the apt configuration rather than as bare command-line flags, shown later in the "Driving the Upgrade Safely" section.

### Reconciling the .dpkg-dist File Afterward

Choosing `confold` is safe but incurs a debt: the maintainer's new defaults land in `sshd_config.dpkg-dist` and you must merge anything worth keeping. Find and diff these files after every upgrade.

```bash
# Find leftover conffile artifacts the upgrade dropped
sudo find /etc/ssh -name '*.dpkg-*' -print

# Diff the maintainer's new default against your kept version so you can
# cherry-pick new hardening defaults (e.g. updated Ciphers/KexAlgorithms)
sudo diff -u /etc/ssh/sshd_config /etc/ssh/sshd_config.dpkg-dist || true
```

### Using ucf for Three-Way Merges

Some packages manage their configuration through `ucf` (Update Configuration File), which performs a three-way merge between the original shipped file, your local edits, and the new upstream file, rather than the all-or-nothing choice plain `dpkg` offers. While `openssh-server` itself uses a plain conffile, related packages on the host may use `ucf`, and the same tooling can be applied manually to merge an `sshd_config` upgrade intelligently.

```bash
# Inspect ucf's registry of managed files and their hashes
sudo ucf --debug-conffiles 2>/dev/null || ucfq -w

# Manually drive a three-way-style merge: register the old shipped file as
# the historical baseline, then let ucf reconcile your version with the new one.
sudo ucf --three-way /etc/ssh/sshd_config.dpkg-dist /etc/ssh/sshd_config
```

When `ucf` detects a conflict it offers the same keep/replace/diff/merge menu, but the merge option launches a three-way diff so you can integrate new upstream defaults without discarding your customizations. For SSH specifically, the safest pattern remains: keep your file during the upgrade, then merge the `.dpkg-dist` deltas by hand once you have a verified shell.

## What Actually Changes Between OpenSSH Versions

Each Ubuntu LTS ships a markedly different OpenSSH. Jumping two LTS releases at once, the way many fleets do, can cross several years of upstream changes in a single transaction. Knowing the categories of change that bite during an upgrade lets you audit your config in advance.

### Defaults That Have Shifted

The defaults most likely to lock you out have moved in the hardening direction across releases:

- **`PermitRootLogin`** has trended from `yes` to `prohibit-password` (key-only root) and many images now ship it commented, deferring to the compiled-in `prohibit-password`. A host whose only credential is a root password is the classic lockout.
- **`PasswordAuthentication`** defaults to `yes` upstream, but cloud and hardened images increasingly set `no` via a drop-in. After an upgrade reshuffles which drop-in wins, a password-only login can stop working.
- **`PubkeyAcceptedAlgorithms`** (formerly `PubkeyAcceptedKeyTypes`) dropped `ssh-rsa` (RSA with SHA-1) from the default accepted set. A client offering only an old RSA key signed with SHA-1 is refused even though the key is in `authorized_keys`. The fix is a modern key type such as `ed25519`, or temporarily re-enabling the legacy algorithm.
- **`KexAlgorithms`, `Ciphers`, and `MACs`** have had weak algorithms (such as `diffie-hellman-group1-sha1`, `arcfour`, and CBC-mode ciphers) removed from defaults. A client or jump host pinned to a removed algorithm fails to negotiate.

```bash
# Audit the algorithms the CURRENT daemon will actually offer, so you can
# compare against what your clients and bastions require before upgrading.
sudo sshd -T | grep -Ei '^(ciphers|macs|kexalgorithms|pubkeyacceptedalgorithms|hostkeyalgorithms)\b'

# From a client, list the key types your private keys use. ed25519 is safe
# across every modern release; an "ssh-rsa" here is a future lockout risk.
for k in ~/.ssh/id_*; do [ -f "$k" ] && ssh-keygen -lf "$k"; done
```

### Renamed and Removed Directives

Beyond defaults, directives themselves get renamed or removed, and a removed directive is a *fatal* parse error that stops the daemon from starting:

- `PubkeyAcceptedKeyTypes` was renamed to `PubkeyAcceptedAlgorithms` (the old name still works as a deprecated alias for now, but relying on aliases is fragile).
- `HostbasedAcceptedKeyTypes` became `HostbasedAcceptedAlgorithms`.
- The standalone `Protocol` directive was removed years ago; a leftover `Protocol 2` line from an ancient config is a hard error on a modern daemon.
- `UsePrivilegeSeparation` was removed; privilege separation is now mandatory and unconditional.
- `ChallengeResponseAuthentication` was renamed to `KbdInteractiveAuthentication` (alias retained for now).

The practical defense is to test-parse your config against the *new* binary before you commit to the daemon restart. Because the upgrade installs the new `sshd` binary before restarting the service, you can run `sshd -t` against it during the post-upgrade window and catch a removed directive while your fallback session is still alive.

```bash
# After the new package is installed but BEFORE you rely on the restart,
# parse the existing config with the NEW binary. A non-zero exit names the
# exact offending line (e.g. "unsupported option" for a removed directive).
sudo /usr/sbin/sshd -t -f /etc/ssh/sshd_config; echo "exit=$?"
```

### Temporarily Re-enabling a Legacy Algorithm

When a client genuinely cannot be upgraded in time, you can re-admit a deprecated algorithm explicitly rather than leaving yourself locked out. Treat this as a stopgap with a removal date, not a permanent setting.

```bash
# Re-admit SHA-1 RSA public keys for legacy clients (stopgap only).
# The "+" syntax ADDS to the default set rather than replacing it.
sudo tee /etc/ssh/sshd_config.d/99-legacy-rsa.conf >/dev/null <<'EOF'
# TEMPORARY: legacy client compatibility, remove after client key rotation
PubkeyAcceptedAlgorithms +ssh-rsa
HostkeyAlgorithms +ssh-rsa
EOF

sudo sshd -t && sudo systemctl reload ssh
```

## Backing Up and Restoring Host Keys Safely

Host keys deserve their own treatment because getting them wrong breaks every client at once and silently undermines automation that pins fingerprints.

### Why Host Keys Must Be Preserved Verbatim

A host's identity to SSH clients is its public host key fingerprint, recorded in each client's `known_hosts`. If the keys in `/etc/ssh/ssh_host_*` change, every client sees `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED` and refuses to connect until the old entry is cleared. Configuration management tools, CI runners, and monitoring that pin host keys break the same way. A normal upgrade preserves the keys; the danger is rebuilding the host, restoring the wrong image, or a maintainer script regenerating keys after they were removed.

### Backing Up With Correct Permissions

Private host keys must remain mode `0600` and owned by `root`. A backup that loosens permissions is itself a vulnerability, and a restore that loosens them makes `sshd` refuse to load the key.

```bash
# Back up host keys into a tar that PRESERVES ownership and mode.
# --numeric-owner avoids surprises if uid/gid mapping differs on restore.
sudo tar --numeric-owner -czf /root/ssh-hostkeys-$(date +%F).tgz \
  -C /etc/ssh $(cd /etc/ssh && ls ssh_host_*)

# Record fingerprints separately so you can verify a restore matched exactly.
for k in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$k"; done \
  | sudo tee /root/ssh-hostkey-fingerprints-$(date +%F).txt
```

### Restoring and Re-verifying

On restore, extract in place, fix permissions defensively, and confirm fingerprints match the recorded baseline before restarting.

```bash
# Restore host keys, then enforce correct permissions explicitly.
sudo tar --numeric-owner -xzf /root/ssh-hostkeys-2032-04-21.tgz -C /etc/ssh
sudo chmod 0600 /etc/ssh/ssh_host_*_key
sudo chmod 0644 /etc/ssh/ssh_host_*_key.pub
sudo chown root:root /etc/ssh/ssh_host_*

# Verify the restored fingerprints match the baseline captured at backup time
for k in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$k"; done
sudo cat /root/ssh-hostkey-fingerprints-2032-04-21.txt

# Only restart once fingerprints are confirmed identical
sudo sshd -t && sudo systemctl restart ssh
```

If you ever do need to rotate host keys intentionally, do it as a planned change: distribute the new public keys to clients (or use an SSH certificate authority so clients trust the CA rather than individual keys) before flipping the daemon over.

## The Pre-Upgrade Safety Checklist

Before touching `do-release-upgrade`, establish multiple independent ways back into the host. The goal is that no single failure removes all of them.

### Step 1: Snapshot the Machine

If the host is a VM or a cloud instance, the cheapest insurance is a full snapshot. It turns a lockout from a disaster into an inconvenience.

```bash
# AWS EC2 - snapshot the root EBS volume before upgrading
aws ec2 create-snapshot \
  --volume-id vol-0a1b2c3d4e5f67890 \
  --description "pre-do-release-upgrade web01 $(date +%F)" \
  --tag-specifications 'ResourceType=snapshot,Tags=[{Key=purpose,Value=pre-upgrade}]'

# Proxmox - snapshot VM 142 including RAM is unnecessary; disk-only is enough
qm snapshot 142 pre-upgrade-$(date +%Y%m%d) \
  --description "Before do-release-upgrade to 24.04"
```

Verify the snapshot reaches a completed state before proceeding. A snapshot still in progress is not a restore point.

### Step 2: Back Up the SSH Configuration and Host Keys

Copy the entire SSH configuration tree, including drop-in fragments and host keys, to a timestamped directory. This lets you restore the exact pre-upgrade state if the upgrade rewrites something.

```bash
#!/usr/bin/env bash
# backup-sshd.sh - capture sshd config and host keys before a release upgrade
set -euo pipefail

# Timestamped backup location outside /etc so a botched /etc restore is safe
BACKUP_DIR="/root/ssh-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "${BACKUP_DIR}"

# Preserve permissions, ownership, and timestamps with cp -a
cp -a /etc/ssh/sshd_config "${BACKUP_DIR}/"
cp -a /etc/ssh/sshd_config.d "${BACKUP_DIR}/" 2>/dev/null || true
cp -a /etc/ssh/ssh_host_* "${BACKUP_DIR}/"

# Record the package version so you know exactly what shipped this config
dpkg -l openssh-server | tail -1 > "${BACKUP_DIR}/openssh-version.txt"

# Capture a checksum manifest to detect post-upgrade drift
( cd "${BACKUP_DIR}" && sha256sum sshd_config ssh_host_* > MANIFEST.sha256 )

echo "Backup written to ${BACKUP_DIR}"
ls -la "${BACKUP_DIR}"
```

The host keys matter as much as the config. If you ever need to rebuild the host or restore from the wrong image, dropping the original `ssh_host_*` files back into `/etc/ssh` keeps client `known_hosts` entries valid and avoids breaking key-pinned automation.

### Step 3: Validate the Current Config Parses Cleanly

Before any upgrade, confirm your running config is actually valid. The `-t` test mode parses the file and exits non-zero on error. The extended test mode (`-T`) dumps the fully resolved effective configuration, which is how you discover what a drop-in fragment is silently overriding.

```bash
# Validate syntax of the active configuration
sudo sshd -t && echo "sshd_config syntax OK"

# Dump the EFFECTIVE config after Include processing, then inspect the
# directives most likely to lock you out
sudo sshd -T | grep -Ei '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication|allowusers|allowgroups)\b'
```

Sample output from a host where a cloud-init drop-in has re-enabled password auth:

```text
port 22
permitrootlogin prohibit-password
pubkeyauthentication yes
passwordauthentication yes
```

If `sshd -T` reports `passwordauthentication yes` but your main `sshd_config` says `no`, a drop-in in `sshd_config.d` is winning. Knowing this now prevents a surprise after the upgrade reshuffles defaults.

### Step 4: Confirm a Non-root Account With Key Access and sudo

Never let `root` be your only way in. Confirm an unprivileged account exists, has your public key, and can escalate with `sudo`. This account is your primary login both during and after the upgrade.

```bash
# Confirm the account exists and has an authorized key
getent passwd deploy
sudo test -s /home/deploy/.ssh/authorized_keys && echo "deploy has authorized_keys"

# Confirm sudo works for the account (NOPASSWD or cached credential)
sudo -l -U deploy | grep -i 'may run'
```

## Pattern 1: Keep a Second Authenticated Session Open

The simplest fallback costs nothing: open a second SSH session to the host and leave it idle while you drive the upgrade from the first. The OpenSSH restart during the upgrade affects new connections, not established child processes, so an already-authenticated session usually survives the daemon swap. If the upgrade leaves the daemon broken, that surviving session is your lifeline to fix the config and restart the service before logging out.

Run the upgrade itself inside a terminal multiplexer so a dropped network connection does not kill the in-flight `dpkg` transaction. A half-finished `dpkg` run is far harder to recover from than a lost shell.

```bash
# Session A (the upgrade driver): start tmux so a network blip cannot
# abort the upgrade mid-transaction
tmux new-session -s upgrade

# Inside tmux, kick off the release upgrade
sudo do-release-upgrade

# Session B (the safety session): open a SECOND, separate SSH connection
# from your workstation and simply leave it sitting at a shell prompt.
ssh deploy@web01.example.com
# ...then do nothing here until the upgrade completes successfully.
```

There is an important caveat with multiplexers. Ubuntu's upgrader has a built-in safety net: when it detects it is running as a direct child of `sshd`, it starts a secondary `sshd` on port 1022 automatically. When you run the upgrade inside `tmux` or `screen`, the process re-parents to the init system, the upgrader no longer sees `sshd` as its parent, and that automatic fallback daemon is never started. You gain multiplexer resilience but lose the built-in port-1022 net. The remedy is to start your own fallback daemon explicitly, which is the next pattern and the most reliable single safeguard in this guide.

### A Concrete Two-Session Survival Workflow

The discipline that makes this reliable is sequencing: never start the upgrade until the survival session and the fallback are both proven. Walk it in order.

```bash
# --- Session A: the upgrade driver (run ON the host) ---
# Start a NAMED tmux session so you can re-attach after any disconnect.
tmux new-session -s upgrade

# Inside tmux, set a long history and enable logging of the pane to a file
# so you have a record of the upgrade prompts even if you get disconnected.
tmux set-option -g history-limit 50000

# Pipe the pane to a logfile for a durable transcript of the run
tmux pipe-pane -o 'cat >> /root/upgrade-$(date +%F).log'
```

If your laptop's network drops mid-upgrade, the `dpkg` transaction keeps running because it is owned by `tmux`, not your SSH connection. Reconnect and re-attach exactly where you left off.

```bash
# --- Recovery after a dropped connection ---
# Reconnect to the host, then re-attach to the still-running upgrade session.
ssh deploy@web01.example.com
tmux attach-session -t upgrade

# If "attach" reports the session is already attached (a stale client still
# holds it), forcibly detach the dead client and take over.
tmux attach-session -d -t upgrade
```

Keep `screen` as an equivalent if it is what the host already has installed; the principle is identical.

```bash
# screen equivalents for the same workflow
screen -S upgrade            # start a named session
screen -ls                   # list sessions after reconnecting
screen -d -r upgrade         # detach any stale client and re-attach
```

The non-negotiable rule: the survival session in Session B and the fallback daemon in Pattern 2 must both be verified *before* you type `do-release-upgrade` in Session A. Once the upgrade starts, the time to discover your fallback is broken has already passed.

## Pattern 2: Run a Fallback sshd on an Alternate Port

The most dependable safety mechanism is a completely independent `sshd` instance, started by hand before the upgrade, listening on a different port, using its own pid and log files. Because you launch it from your current shell rather than from systemd, the package upgrade does not touch it. While the primary daemon on port 22 is being replaced and possibly broken the fallback keeps running and answering.

### Open the Firewall for the Fallback Port

Pick a port and allow it through both the host firewall and any cloud security group. Port `2222` is a common choice; use whatever your network policy permits.

```bash
# UFW (host firewall on the instance)
sudo ufw allow 2222/tcp comment 'fallback sshd for release upgrade'

# nftables (if you manage rules directly instead of UFW)
sudo nft add rule inet filter input tcp dport 2222 accept

# AWS security group - authorize from your bastion/jump CIDR only
aws ec2 authorize-security-group-ingress \
  --group-id sg-0123456789abcdef0 \
  --protocol tcp --port 2222 \
  --cidr 203.0.113.10/32

# GCP firewall - allow the fallback port from the admin range, target by tag
gcloud compute firewall-rules create allow-ssh-fallback-2222 \
  --network default \
  --direction INGRESS --action ALLOW \
  --rules tcp:2222 \
  --source-ranges 203.0.113.10/32 \
  --target-tags ssh-fallback
```

Restrict the source to your administrative network. A second SSH port open to the world is a second front door for attackers. If your distro uses `firewalld` instead of UFW, the equivalent is a scoped rich rule.

```bash
# firewalld equivalent, scoped to a single admin source address
sudo firewall-cmd --permanent --add-rich-rule=\
'rule family="ipv4" source address="203.0.113.10/32" port port="2222" protocol="tcp" accept'
sudo firewall-cmd --reload
```

### Launch the Standalone Daemon

Start a fresh `sshd` directly. Use the absolute binary path, a dedicated port, a separate pid file, and a private log so it never collides with the package-managed instance.

```bash
# Start an independent sshd on port 2222 with its own pid and log files.
# -E sends the log to a file; -o overrides specific directives so the
# fallback works even if the main config later becomes unparseable.
sudo /usr/sbin/sshd \
  -p 2222 \
  -o PidFile=/run/sshd-fallback.pid \
  -o PermitRootLogin=prohibit-password \
  -o PasswordAuthentication=no \
  -E /var/log/sshd-fallback.log

# Confirm it is listening
sudo ss -tlnp 'sport = :2222'
```

Because this daemon was started before the upgrade and is not managed by systemd or dpkg, the OpenSSH package upgrade will not restart or stop it. It keeps serving on port 2222 throughout the transaction.

### A Persistent Fallback as a Separate systemd Unit

A hand-started daemon dies on reboot and leaves no audit trail. For planned fleet work, a dedicated systemd unit is cleaner: it survives reboots, restarts on failure, and uses an entirely separate config file so a broken main `sshd_config` cannot affect it. The trick is to give it its own config and its own unit name so the `openssh-server` package never touches it.

```ini
# /etc/ssh/sshd_fallback_config
# Minimal, self-contained config for the fallback daemon. It deliberately
# does NOT Include /etc/ssh/sshd_config.d so a broken drop-in cannot break it.
Port 2222
PermitRootLogin prohibit-password
PasswordAuthentication no
PubkeyAuthentication yes
PidFile /run/sshd-fallback.pid
# Reuse the existing host keys so clients see the same identity on 2222
HostKey /etc/ssh/ssh_host_ed25519_key
HostKey /etc/ssh/ssh_host_rsa_key
# Restrict to the recovery account only
AllowUsers deploy
```

```ini
# /etc/systemd/system/sshd-fallback.service
# A second, independently-managed sshd. Named differently from "ssh.service"
# so the openssh-server package's maintainer scripts never restart or mask it.
[Unit]
Description=Fallback SSH daemon on alternate port for upgrades
After=network-online.target
Wants=network-online.target

[Service]
# -D keeps sshd in the foreground so systemd can supervise it directly.
ExecStartPre=/usr/sbin/sshd -t -f /etc/ssh/sshd_fallback_config
ExecStart=/usr/sbin/sshd -D -f /etc/ssh/sshd_fallback_config
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```bash
# Validate the fallback config, then enable and start the supervised unit.
sudo sshd -t -f /etc/ssh/sshd_fallback_config && echo "fallback config OK"
sudo systemctl daemon-reload
sudo systemctl enable --now sshd-fallback.service
sudo systemctl status sshd-fallback.service --no-pager
```

Because the unit is named `sshd-fallback.service` rather than `ssh.service`, the `openssh-server` postinst restarts only the primary unit. The `ExecStartPre` test guarantees the unit refuses to start with a config it cannot parse, surfacing the problem immediately instead of silently leaving you without a fallback.

### Test the Fallback Before You Need It

A fallback you have not tested is not a fallback. From your workstation, log in over the alternate port and leave that session open as well.

```bash
# From your workstation - prove the fallback accepts your key BEFORE upgrading
ssh -p 2222 deploy@web01.example.com 'echo fallback-login-ok; hostname; uptime'
```

If that command returns `fallback-login-ok` along with the host details, you have a verified path into the machine that is independent of the package being upgraded. Only now should you start `do-release-upgrade`.

### Clean Up After a Successful Upgrade

Once the upgrade finishes and the package-managed daemon on port 22 is confirmed healthy, stop the fallback and close its port. Leaving a hand-started daemon and an open port behind is a security and audit liability.

```bash
# Stop the fallback daemon using its pid file (hand-started variant)
sudo kill "$(cat /run/sshd-fallback.pid)"

# If you used the systemd unit instead, disable and remove it entirely
sudo systemctl disable --now sshd-fallback.service
sudo rm -f /etc/systemd/system/sshd-fallback.service /etc/ssh/sshd_fallback_config
sudo systemctl daemon-reload

# Confirm nothing is still listening on the fallback port
sudo ss -tlnp 'sport = :2222' || echo "fallback port closed"

# Remove the firewall rule and the cloud security group rule
sudo ufw delete allow 2222/tcp
aws ec2 revoke-security-group-ingress \
  --group-id sg-0123456789abcdef0 \
  --protocol tcp --port 2222 --cidr 203.0.113.10/32

# GCP equivalent cleanup
gcloud compute firewall-rules delete allow-ssh-fallback-2222 --quiet
```

## Driving the Upgrade Safely

With backups taken and a fallback verified, run the upgrade itself with the configuration prompt under control.

### Pre-seed the Conffile Decision

Rather than be surprised by the interactive `sshd_config` prompt, decide in advance how `dpkg` should handle modified conffiles. The two relevant options are `--force-confold` (keep your existing file) and `--force-confdef` (let dpkg pick the default action, which keeps your file when you have modified it). For SSH, the safest combination during the upgrade is to keep your known-good config and reconcile it deliberately afterward.

The reliable way to apply this to a `do-release-upgrade` run is to drop the policy into an apt config snippet, because the upgrader spawns its own `apt`/`dpkg` invocations that do not inherit bare command-line flags. The snippet is read by every `dpkg` call the upgrade makes.

```bash
# Persist the conffile policy where every dpkg invocation will read it.
sudo tee /etc/apt/apt.conf.d/99-upgrade-conffile >/dev/null <<'EOF'
// Keep existing modified config files; take defaults for unmodified ones.
Dpkg::Options { "--force-confdef"; "--force-confold"; };
EOF
```

```bash
# Now run the release upgrade non-interactively. DEBIAN_FRONTEND prevents
# any remaining debconf prompts from blocking the unattended run.
sudo DEBIAN_FRONTEND=noninteractive \
  do-release-upgrade \
  -f DistUpgradeViewNonInteractive
```

```bash
# Remove the temporary policy snippet after the upgrade completes so it does
# not silently suppress conffile prompts on future routine updates.
sudo rm -f /etc/apt/apt.conf.d/99-upgrade-conffile
```

Keeping your config (`confold`) avoids losing your `Port`, `AllowUsers`, and other hardening directives during the run. The risk it introduces is that a now-removed directive could prevent a restart. That is exactly why the fallback daemon on port 2222 exists: it stays up even if the main daemon cannot restart, giving you a shell to fix the config.

### Watch Liveness Without Relying on SSH

During the upgrade, do not poll port 22 to judge whether the host is healthy. SSH is the thing under maintenance and will be intermittently unreachable; treating that as an outage leads to panicked, harmful intervention. Use signals that are independent of `sshd`.

```bash
# From your workstation - ICMP reachability (the host is still up)
ping -c 3 web01.example.com

# Application-layer liveness on a service that does NOT depend on sshd
curl -fsS -o /dev/null -w '%{http_code}\n' https://web01.example.com/healthz

# The fallback SSH port is your real "can I get in" check
ssh -p 2222 -o ConnectTimeout=5 deploy@web01.example.com 'echo alive'
```

A host that answers ICMP and serves its health endpoint is fine even if port 22 is momentarily closed. Reserve action for cases where the fallback port also stops responding.

## Post-Upgrade Reconciliation

After the upgrade reports success, do not log out yet. Reconcile the SSH configuration while you still have your safety session and the fallback daemon available.

### Diff the Active Config Against Your Backup

Compare what the upgrade left behind with the pre-upgrade backup, and verify the effective config still parses.

```bash
# Confirm the new package's daemon parses the current config
sudo sshd -t && echo "post-upgrade sshd_config OK"

# Diff the live config against the pre-upgrade backup
diff -u /root/ssh-backup-*/sshd_config /etc/ssh/sshd_config || true

# Re-check the effective directives that cause lockouts
sudo sshd -T | grep -Ei '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication|allowusers|allowgroups)\b'
```

If `sshd -t` fails, read the error: it names the offending line. A removed or renamed directive is the usual culprit. Comment it out or replace it with the current equivalent, then re-test before restarting.

### Verify Host Keys Are Unchanged

Confirm the host keys match the backup so clients do not see an identity change.

```bash
# Compare current host key fingerprints to the backed-up keys
for k in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$k"; done
for k in /root/ssh-backup-*/ssh_host_*_key.pub; do ssh-keygen -lf "$k"; done
```

The fingerprints should be identical. If they differ, restore the originals from your backup and restart the daemon so client `known_hosts` entries and any key-pinned automation keep working.

### Restart Cleanly and Prove a Fresh Login

Restart the package-managed daemon, then open a brand-new connection on port 22 from your workstation. Keep your safety session open until this succeeds.

```bash
# On the host - restart the managed daemon now that config is validated
sudo systemctl restart ssh
sudo systemctl status ssh --no-pager

# From your workstation - prove a FRESH connection on port 22 works.
# Only after this succeeds should you close the safety session and the fallback.
ssh deploy@web01.example.com 'echo port-22-login-ok; lsb_release -ds'
```

If that fresh login on port 22 succeeds, the upgrade is genuinely complete. Now tear down the fallback daemon and close its port using the cleanup commands from Pattern 2.

### A Post-Upgrade Validation Checklist

Run a single consolidated check before declaring the host done and tearing down safeguards. Scripting it makes the result auditable and repeatable across a fleet.

```bash
#!/usr/bin/env bash
# validate-ssh-post-upgrade.sh - run ON the host after a release upgrade.
# Exits non-zero on any failure so an orchestrator can gate fallback teardown.
set -uo pipefail
fail=0

echo "== 1. New OpenSSH version =="
dpkg -l openssh-server | tail -1

echo "== 2. Config parses with the NEW binary =="
if sudo sshd -t; then echo "  parse OK"; else echo "  PARSE FAILED"; fail=1; fi

echo "== 3. Effective lockout-critical directives =="
sudo sshd -T | grep -Ei \
  '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication|allowusers|allowgroups|pubkeyacceptedalgorithms)\b'

echo "== 4. Service is active and enabled =="
systemctl is-active ssh   >/dev/null && echo "  active"  || { echo "  NOT ACTIVE";  fail=1; }
systemctl is-enabled ssh  >/dev/null && echo "  enabled" || { echo "  NOT ENABLED"; fail=1; }

echo "== 5. Daemon is listening on the expected port =="
sudo ss -tlnp 'sport = :22' | grep -q sshd && echo "  listening :22" || { echo "  NOT LISTENING :22"; fail=1; }

echo "== 6. No leftover conffile artifacts to reconcile =="
sudo find /etc/ssh -name '*.dpkg-*' -print

echo "== 7. Host key fingerprints (compare to pre-upgrade baseline) =="
for k in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$k"; done

echo "== 8. Obsolete sources or leftover release pockets =="
grep -RIns -E 'jammy|focal|bionic' /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null \
  || echo "  no obviously stale release pockets"

if [ "$fail" -ne 0 ]; then echo "VALIDATION FAILED"; exit 1; fi
echo "VALIDATION PASSED"
```

The standout check is item 8: a release upgrade can leave stale entries pointing at the previous release, which causes confusing `apt` behavior later. A clean validation means you can safely stop the fallback daemon and remove its firewall rule.

## When SSH Is Already Broken: Recovery Paths

If you skipped the safeguards, or something went wrong despite them, you still have options that do not require SSH at all.

### Cloud Serial and Console Access

Every major cloud provider offers an out-of-band console that bypasses the network stack and `sshd` entirely. This is your way in when port 22 is dead.

```bash
# AWS EC2 Serial Console (Nitro instances) - connect to the serial port
aws ec2-instance-connect send-serial-console-ssh-public-key \
  --instance-id i-0123456789abcdef0 \
  --serial-port 0 \
  --ssh-public-key file://~/.ssh/id_ed25519.pub
ssh i-0123456789abcdef0.port0@serial-console.ec2-instance-connect.us-east-1.aws

# GCP - connect to the instance serial console
gcloud compute connect-to-serial-port web01 --zone us-central1-a
```

For the serial console to be useful, you need a working local account with a password (key auth does not apply on a serial line). Set or confirm such an account before you ever need it; a serial console that lands on a login prompt you cannot satisfy is no help.

On AWS, the EC2 Serial Console must be enabled at the account level and the instance must be a Nitro type; on GCP, interactive serial-port access must be enabled on the instance. Both are far easier to turn on *before* an incident.

```bash
# AWS - enable account-level serial console access (one-time, per region)
aws ec2 enable-serial-console-access

# GCP - enable interactive serial console on a specific instance
gcloud compute instances add-metadata web01 --zone us-central1-a \
  --metadata serial-port-enable=TRUE
```

Make sure a password-capable break-glass account exists so the serial login prompt is satisfiable. Bake this into the image rather than adding it during an incident.

```bash
# Set a strong password on the recovery account so serial-console login works.
# Do this proactively; you cannot do it once you are already locked out.
sudo passwd deploy
```

### Fixing the Config From the Console

Once you have a console shell, the repair is mechanical: restore the known-good config from your backup, validate it, and restart.

```bash
# Restore the pre-upgrade config and host keys from the backup
sudo cp -a /root/ssh-backup-*/sshd_config /etc/ssh/sshd_config
sudo cp -a /root/ssh-backup-*/ssh_host_* /etc/ssh/

# Validate, then restart the daemon
sudo sshd -t && sudo systemctl restart ssh
sudo systemctl status ssh --no-pager
```

If you have no backup, start a temporary daemon with explicit overrides so you can at least get a network login back, then fix the file at leisure.

```bash
# Emergency: bring SSH up on port 22 with safe explicit options,
# ignoring the broken config file via -o overrides.
sudo /usr/sbin/sshd -p 22 \
  -o PermitRootLogin=prohibit-password \
  -o PubkeyAuthentication=yes \
  -o PasswordAuthentication=no \
  -E /var/log/sshd-emergency.log
```

### A Symptom-to-Fix Troubleshooting Matrix

Most lockouts after an upgrade fall into a handful of recognizable patterns. Diagnose from the console or fallback session using the daemon's own diagnostics, then apply the matching fix.

```bash
# First, always look at WHY the daemon refused to start or reject you.
sudo journalctl -u ssh --no-pager -n 50
sudo sshd -t            # parse errors name the exact bad line
sudo sshd -T            # effective config after Include processing
```

The common failure signatures and their fixes:

- **`sshd: Unsupported option "<name>"` and the service is dead.** A directive was removed in the new release. Comment out or rename the offending line (see the renamed-directive list earlier), then `sshd -t` and restart.
- **`Permission denied (publickey)` on a key that used to work.** The new default dropped `ssh-rsa` (SHA-1). Either switch the client to an `ed25519` key or temporarily add `PubkeyAcceptedAlgorithms +ssh-rsa` via a drop-in.
- **`Permission denied (publickey)` for root specifically.** `PermitRootLogin` now defaults to `prohibit-password`. Log in as the non-root account and use `sudo`, or set `PermitRootLogin prohibit-password` and use a key.
- **Password login rejected though `sshd_config` says `PasswordAuthentication yes`.** A drop-in in `sshd_config.d` is overriding it. `sshd -T | grep passwordauthentication` reveals the effective value; fix the winning drop-in.
- **`no matching key exchange method found` or `no matching cipher`.** A removed weak algorithm. Either modernize the client/bastion or re-admit the algorithm with the `+` syntax as a stopgap.
- **`REMOTE HOST IDENTIFICATION HAS CHANGED` on every client.** Host keys changed. Restore the originals from your backup (see the host-key section), or distribute the new fingerprints if the change was intentional.
- **The upgrade hung with no output for a long time.** A conffile prompt is waiting on stdin inside a context with no terminal. Attach to the `tmux`/`screen` session, or in future pre-seed the `--force-confdef,confold` policy.

To diagnose an authentication rejection in detail without disturbing the running service, start a throwaway debug daemon on a spare port in non-detaching, verbose mode and connect to it.

```bash
# Run a verbose, foreground debug sshd on a scratch port. -ddd logs every
# step of authentication so you can see exactly why a key or password fails.
sudo /usr/sbin/sshd -ddd -p 2223 -o PidFile=/run/sshd-debug.pid 2>&1 | tee /root/sshd-debug.log
# In another session: ssh -p 2223 -v deploy@web01.example.com
```

The `-ddd` output names the precise reason for a rejection (wrong key type, file-permission problem on `authorized_keys`, disabled auth method), turning a guessing game into a one-line fix.

### Snapshot Rollback as the Last Resort

If the host is too damaged to repair in place, the snapshot from Step 1 is the escape hatch. Restoring it returns you to the exact pre-upgrade state, after which you can plan a more controlled retry.

```bash
# AWS - create a new volume from the pre-upgrade snapshot, then swap it
# in for the instance's root device after stopping the instance.
aws ec2 create-volume \
  --snapshot-id snap-0a1b2c3d4e5f67890 \
  --availability-zone us-east-1a \
  --volume-type gp3
```

## Doing This Across a Fleet

The patterns above scale from one host to hundreds with a few adjustments. The core idea remains constant: every host gets an independent, pre-verified fallback before its primary daemon is disturbed.

### Bake the Fallback Into cloud-init

For cloud instances, encode a non-root account and key into the image so a working login always exists regardless of how the upgrade rewrites `sshd_config`. This account becomes the fleet-wide recovery identity.

```yaml
#cloud-config
# Guarantee a key-based recovery account on every instance so a release
# upgrade that breaks sshd_config still leaves a working login.
users:
  - name: deploy
    groups: [sudo]
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ssh_authorized_keys:
      - "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID3xampleKeyReplaceWithRealKey deploy@ops"

# Pin SSH defaults via a drop-in so they are explicit and survive a
# maintainer config reshuffle, rather than relying on compiled defaults.
write_files:
  - path: /etc/ssh/sshd_config.d/10-fleet-policy.conf
    permissions: "0644"
    content: |
      PermitRootLogin prohibit-password
      PasswordAuthentication no
      PubkeyAuthentication yes
```

Setting these directives explicitly in a drop-in means the effective policy does not depend on whatever default a new OpenSSH release happens to ship.

### Orchestrate With Idempotent Automation

When running the upgrade across many hosts, drive each one through the same sequence: snapshot, back up config, start and verify a fallback, upgrade non-interactively, reconcile, and only then tear down the fallback. Run in small batches so a systemic problem stops at a handful of hosts instead of the whole fleet.

```bash
#!/usr/bin/env bash
# fleet-upgrade.sh - per-host wrapper run by your orchestrator (Ansible,
# SSM, etc.). Designed to be idempotent and to fail closed.
set -euo pipefail

HOST="$1"
FALLBACK_PORT="2222"

echo "[${HOST}] backing up sshd config"
ssh "deploy@${HOST}" 'sudo bash -s' < backup-sshd.sh

echo "[${HOST}] starting fallback sshd on ${FALLBACK_PORT}"
ssh "deploy@${HOST}" "sudo /usr/sbin/sshd -p ${FALLBACK_PORT} \
  -o PidFile=/run/sshd-fallback.pid \
  -o PasswordAuthentication=no -E /var/log/sshd-fallback.log"

echo "[${HOST}] verifying fallback before proceeding"
if ! ssh -p "${FALLBACK_PORT}" -o ConnectTimeout=5 "deploy@${HOST}" 'echo ok' | grep -q ok; then
  echo "[${HOST}] FALLBACK FAILED - aborting upgrade for this host" >&2
  exit 1
fi

echo "[${HOST}] running non-interactive release upgrade"
ssh "deploy@${HOST}" 'sudo DEBIAN_FRONTEND=noninteractive \
  do-release-upgrade -f DistUpgradeViewNonInteractive'
```

The critical line is the abort: if the fallback cannot be verified, the script refuses to start the upgrade on that host. That single guard is what turns a risky bulk operation into a safe one, because no host loses its primary daemon until it has a proven secondary way in.

### Automating the Pre-Flight as an Ansible Playbook

For a real fleet, encode the entire pre-flight as an Ansible playbook so every host is prepared identically and the run is gated on each safeguard succeeding. This playbook backs up the config and host keys, validates the current config, stands up the supervised fallback unit, and verifies the fallback port answers before any upgrade is even attempted. Run the upgrade itself as a separate, deliberately-gated play once the pre-flight passes across the batch.

```yaml
---
# ssh-preflight.yml - prepare a fleet for do-release-upgrade safely.
# Run with: ansible-playbook -i inventory ssh-preflight.yml --limit batch1
- name: SSH pre-flight before release upgrade
  hosts: upgrade_targets
  become: true
  serial: 5          # work in small batches so a systemic fault stops early
  any_errors_fatal: true   # abort the whole batch if any host fails a gate

  vars:
    fallback_port: 2222
    admin_cidr: "203.0.113.10/32"
    backup_root: "/root/ssh-backup-{{ ansible_date_time.iso8601_basic_short }}"

  tasks:
    - name: Create timestamped backup directory
      ansible.builtin.file:
        path: "{{ backup_root }}"
        state: directory
        mode: "0700"

    - name: Back up sshd_config, drop-ins, and host keys
      ansible.builtin.copy:
        src: "{{ item }}"
        dest: "{{ backup_root }}/"
        remote_src: true
        mode: preserve
      loop:
        - /etc/ssh/sshd_config
        - /etc/ssh/sshd_config.d
        - /etc/ssh/ssh_host_ed25519_key
        - /etc/ssh/ssh_host_ed25519_key.pub
        - /etc/ssh/ssh_host_rsa_key
        - /etc/ssh/ssh_host_rsa_key.pub

    - name: Validate the current sshd configuration parses
      ansible.builtin.command: sshd -t
      changed_when: false

    - name: Record the effective lockout-critical directives
      ansible.builtin.shell: >-
        sshd -T | grep -Ei
        '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication)\b'
      register: effective_config
      changed_when: false

    - name: Open the fallback port to the admin network (UFW)
      community.general.ufw:
        rule: allow
        port: "{{ fallback_port }}"
        proto: tcp
        from_ip: "{{ admin_cidr }}"

    - name: Install the self-contained fallback sshd config
      ansible.builtin.copy:
        dest: /etc/ssh/sshd_fallback_config
        mode: "0600"
        content: |
          Port {{ fallback_port }}
          PermitRootLogin prohibit-password
          PasswordAuthentication no
          PubkeyAuthentication yes
          PidFile /run/sshd-fallback.pid
          HostKey /etc/ssh/ssh_host_ed25519_key
          AllowUsers deploy

    - name: Validate the fallback config before enabling the unit
      ansible.builtin.command: sshd -t -f /etc/ssh/sshd_fallback_config
      changed_when: false

    - name: Install the fallback systemd unit
      ansible.builtin.copy:
        dest: /etc/systemd/system/sshd-fallback.service
        mode: "0644"
        content: |
          [Unit]
          Description=Fallback SSH daemon for release upgrade
          After=network-online.target
          Wants=network-online.target
          [Service]
          ExecStartPre=/usr/sbin/sshd -t -f /etc/ssh/sshd_fallback_config
          ExecStart=/usr/sbin/sshd -D -f /etc/ssh/sshd_fallback_config
          Restart=on-failure
          RestartSec=2
          [Install]
          WantedBy=multi-user.target

    - name: Enable and start the fallback daemon
      ansible.builtin.systemd:
        name: sshd-fallback.service
        daemon_reload: true
        enabled: true
        state: started

    - name: GATE - verify the fallback port actually answers
      ansible.builtin.wait_for:
        host: "{{ inventory_hostname }}"
        port: "{{ fallback_port }}"
        timeout: 10
        state: started
      delegate_to: localhost
      become: false
```

The two gates that matter are `any_errors_fatal` and the final `wait_for`: if a host cannot validate its config or its fallback port does not come up, the whole batch stops before a single `do-release-upgrade` runs. This is the fleet-scale version of the per-host abort, and it is what makes upgrading hundreds of machines a controlled operation rather than a gamble.

## Conclusion

A release upgrade is the rare operation that can amputate the limb you are standing on. The discipline that keeps you safe is layered, independent redundancy: never let a single failure remove every path into the machine.

Key takeaways:

- **A distro upgrade replaces, prompts on, and restarts `sshd`.** Expect `dpkg` conffile prompts on `/etc/ssh/sshd_config`, changed defaults for `PermitRootLogin` and `PasswordAuthentication`, and removed directives that can stop the daemon from restarting.
- **Decide the conffile policy deliberately.** Understand the `dpkg` decision tree, prefer `--force-confdef,confold` to keep your hardened config during the run, and reconcile the resulting `.dpkg-dist` file (or use a `ucf` three-way merge) afterward.
- **Audit OpenSSH version deltas before you jump.** Renamed directives (`PubkeyAcceptedKeyTypes` to `PubkeyAcceptedAlgorithms`), removed options (`Protocol`, `UsePrivilegeSeparation`), and dropped algorithms (`ssh-rsa` SHA-1, weak KEX/ciphers) are the usual lockout causes; parse the config with the new binary before trusting the restart.
- **Snapshot first.** On any VM or cloud instance, a verified pre-upgrade snapshot turns a lockout from a disaster into an inconvenience.
- **Back up the config and host keys to a timestamped directory** with a checksum manifest and preserved `0600` permissions, so you can restore the exact pre-upgrade state and keep client `known_hosts` entries valid.
- **Run the upgrade in `tmux` or `screen`** so a dropped connection cannot abort an in-flight `dpkg` transaction but remember that doing so disables Ubuntu's automatic port-1022 fallback, so re-attach with `-d` after a reconnect.
- **Start and verify your own fallback `sshd` on an alternate port** before upgrading, ideally as a separately-named systemd unit with its own self-contained config. Because it is not the package-managed `ssh.service`, it survives the upgrade and gives you a shell even if the primary daemon breaks.
- **Judge liveness with ICMP and HTTP, not port 22.** SSH is the thing under maintenance; treating its brief absence as an outage causes harmful intervention.
- **Reconcile before logging out.** Run the consolidated validation script (`sshd -t`, effective-config check, service state, host-key fingerprints, stale-pocket scan), then prove a fresh port-22 login before tearing down the fallback.
- **Keep a console fallback for when SSH is already dead.** Cloud serial consoles bypass the network stack entirely, but only help if you enabled them in advance and a password-capable local account exists. Use a verbose `sshd -ddd` debug daemon to diagnose stubborn auth rejections.
- **Scale the same pattern across fleets** with cloud-init recovery accounts, explicit `sshd_config.d` drop-ins, and an Ansible pre-flight that uses `any_errors_fatal` plus a fallback-port gate to abort before any host loses its primary daemon.
