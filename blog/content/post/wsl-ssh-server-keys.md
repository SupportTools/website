---
title: "Fix sshd: no hostkeys available -- exiting (WSL, Ubuntu)"
date: 2024-06-30T23:18:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["wsl", "ssh", "sshd", "OpenSSH", "Ubuntu"]
categories:
- Windows
- SSH
- Linux
author: "Matthew Mattox - mmattox@support.tools"
description: "sshd exits with 'no hostkeys available' when /etc/ssh has no usable host keys. Run sudo ssh-keygen -A, then start ssh. Fixes for WSL, Ubuntu and Docker."
more_link: "yes"
quick_fix: |
  `sshd: no hostkeys available -- exiting.` means sshd found no host key it could load in `/etc/ssh`. Generate the missing keys and start the server again:
  `sudo ssh-keygen -A && sudo service ssh start` (or `sudo systemctl restart ssh` when systemd is running).
  If the keys already exist, fix their permissions with `sudo chmod 600 /etc/ssh/ssh_host_*_key`.
---

`sshd: no hostkeys available -- exiting.` is printed when the OpenSSH server starts and cannot load a single host key from `/etc/ssh`. The fix is one command, `sudo ssh-keygen -A`, which creates every missing host key type. This guide shows the exact output before and after, why WSL and container images ship without keys, the other two causes that print the same line (bad permissions and a wrong `HostKey` path), and what clients see after the keys change.

<!--more-->

## The error

On WSL without systemd, starting the server with the SysV init script looks like this:

```text
$ sudo service ssh start
 * Starting OpenBSD Secure Shell server sshd
 sshd: no hostkeys available -- exiting. [fail]
```

With systemd (a normal Ubuntu server, or WSL with systemd enabled) the unit fails instead, because `ssh.service` runs `sshd -t` as `ExecStartPre`:

```text
$ sudo systemctl restart ssh
Job for ssh.service failed because the control process exited with error code.
$ sudo journalctl -u ssh -n 5 --no-pager
... sshd[812]: sshd: no hostkeys available -- exiting.
... systemd[1]: ssh.service: Control process exited, code=exited, status=1/FAILURE
```

You can reproduce the check yourself at any time, without starting anything:

```bash
sudo /usr/sbin/sshd -t
```

`sshd -t` validates the configuration and the host keys, then exits. No output and exit code 0 means sshd will start.

## Fix: generate the missing host keys

```bash
sudo ssh-keygen -A
```

Expected output when keys were missing:

```text
ssh-keygen: generating new host keys: RSA ECDSA ED25519
```

`-A` creates every default host key type that does not exist yet, with the default paths and an empty passphrase. It never overwrites a key that is already there, so it is safe to run again: on a host that already has all three keys it prints nothing.

Confirm the files exist and sshd accepts them, then start the server:

```bash
ls -l /etc/ssh/ssh_host_*
sudo /usr/sbin/sshd -t && echo "config OK"
sudo service ssh start          # WSL without systemd
sudo systemctl restart ssh      # systemd hosts, including WSL with systemd=true
```

You should see six files: `ssh_host_rsa_key`, `ssh_host_ecdsa_key`, `ssh_host_ed25519_key` and their `.pub` files. The private keys must be mode `600` and owned by root.

On Debian and Ubuntu there is a package-level alternative that does the same thing through the `openssh-server` maintainer script:

```bash
sudo dpkg-reconfigure openssh-server
```

It prints `Creating SSH2 ED25519 key; this may take some time ...` for each missing type and then tries to restart the service.

## Why sshd has no host keys

Host keys identify the server, so they must be unique per machine. Anything that is built once and copied many times deliberately ships without them, and something at first boot is supposed to create them. When that first-boot step never runs, sshd has nothing to load.

- **WSL distributions.** The distro is unpacked from a root filesystem image, and `openssh-server` is often installed later or was installed in the image with its keys removed. Without systemd and cloud-init, nothing generates keys on first start.
- **Docker and other container images.** Base images remove `/etc/ssh/ssh_host_*` so two containers never share a key. Installing `openssh-server` in a `Dockerfile` and then deleting or not copying the keys gives the same error at `CMD ["/usr/sbin/sshd", "-D"]`.
- **Golden images and clones.** VM templates are commonly "sealed" by deleting host keys; cloud-init or a first-boot script normally recreates them. Clones made without that step fail.
- **Someone deleted or rotated the keys** and did not regenerate them, or restored `/etc/ssh` from a backup without the private keys.

## Same error, different cause: permissions or HostKey path

If `ls /etc/ssh/ssh_host_*` shows the keys but sshd still exits, run `sshd -t` and read the lines above the error.

**Private keys readable by others.** sshd refuses any private host key that group or other can read:

```text
$ sudo /usr/sbin/sshd -t
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
Permissions 0644 for '/etc/ssh/ssh_host_ed25519_key' are too open.
It is required that your private key files are NOT accessible by others.
This private key will be ignored.
sshd: no hostkeys available -- exiting.
```

Fix the mode and owner:

```bash
sudo chown root:root /etc/ssh/ssh_host_*
sudo chmod 600 /etc/ssh/ssh_host_*_key
sudo chmod 644 /etc/ssh/ssh_host_*_key.pub
```

This happens most often after copying keys from a Windows path (`/mnt/c/...`) in WSL, because DrvFs files appear with permissive modes unless the mount uses the `metadata` option.

**`HostKey` points at files that do not exist.** If `sshd_config` or a drop-in under `/etc/ssh/sshd_config.d/` sets `HostKey`, sshd loads only those paths. Print what sshd will actually use:

```bash
sudo /usr/sbin/sshd -T | grep -i '^hostkey '
```

```text
hostkey /etc/ssh/ssh_host_rsa_key
hostkey /etc/ssh/ssh_host_ecdsa_key
hostkey /etc/ssh/ssh_host_ed25519_key
```

Every path listed must exist. Either generate a key at that custom path (`sudo ssh-keygen -t ed25519 -f /path/to/key -N ''`) or remove the custom `HostKey` line.

## Fix checklist

1. Run `sudo /usr/sbin/sshd -t` and read every line it prints.
2. No keys in `/etc/ssh`: run `sudo ssh-keygen -A`.
3. Keys present but "UNPROTECTED PRIVATE KEY FILE": `chmod 600` the private keys, owner `root:root`.
4. Custom `HostKey` lines: check `sshd -T | grep -i '^hostkey '` and make each path exist.
5. Run `sshd -t` again until it prints nothing, then start or restart the service.
6. Connect once from a client and accept the new host key fingerprint (see the FAQ below).

## WSL notes

- **With or without systemd.** Check whether WSL booted systemd with `ps -p 1 -o comm=`. If it prints `systemd`, use `systemctl`. If not, use `sudo service ssh start`, which does not survive a `wsl --shutdown`. To get systemd, add this to `/etc/wsl.conf` inside the distro and run `wsl --shutdown` from Windows:

  ```ini
  [boot]
  systemd=true
  ```

- **Privilege separation directory.** Running `/usr/sbin/sshd` directly (not through `service` or systemd) can fail with `Missing privilege separation directory: /run/sshd`. Create it with `sudo mkdir -p /run/sshd`; the init script and the systemd unit normally do this for you.
- **Port 22 already in use.** If the Windows OpenSSH Server service is also running, pick a different `Port` for the WSL sshd or stop the Windows service.
- **Reaching WSL from another machine.** In the default NAT networking mode, WSL is only reachable from the Windows host. Either set `networkingMode=mirrored` under `[wsl2]` in `%UserProfile%\.wslconfig` (Windows 11 22H2 and later), or forward a port with `netsh interface portproxy` and allow it in Windows Firewall.

## Ubuntu and distro differences

| System | OpenSSH | How keys are normally created | Notes |
|---|---|---|---|
| Ubuntu 24.04 LTS | 9.6p1 | `openssh-server` postinst at install | `ssh.socket` is enabled by default; `ssh.service` runs `sshd -t` before starting |
| Ubuntu 26.04 LTS | 10.2p1 | `openssh-server` postinst at install | Same unit layout as 24.04; DSA keys no longer exist in OpenSSH 10 |
| Debian 12 and 13 | 9.2p1, 10.0p1 | postinst, or `dpkg-reconfigure openssh-server` | Same fix |
| Fedora, RHEL, Rocky | varies | `sshd-keygen@.service` at boot, per key type | `sudo ssh-keygen -A` also works |
| Alpine | varies | not created by `apk add openssh-server` | In containers, run `ssh-keygen -A` in the entrypoint |

On Ubuntu 24.04 and 26.04 socket activation means `ssh.socket` can be listening while every connection is reset because `ssh.service` fails its `sshd -t` check. Look at `journalctl -u ssh`, not only at `systemctl status ssh.socket`. If you also change `Port` in `sshd_config`, run `sudo systemctl daemon-reload` and `sudo systemctl restart ssh.socket` so the socket picks up the new port.

## Containers: generate keys at start, not at build

Running `ssh-keygen -A` in a `Dockerfile` bakes one set of host keys into the image, so every container started from it has the same identity. Generate them when the container starts instead:

```dockerfile
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server \
 && rm -f /etc/ssh/ssh_host_* && mkdir -p /run/sshd
CMD ["/bin/sh", "-c", "ssh-keygen -A && exec /usr/sbin/sshd -D -e"]
```

If the container must keep a stable identity across restarts, mount the host keys from a volume or a Kubernetes Secret with mode `0600`.

## FAQ

### Is it safe to run `ssh-keygen -A` on a server that already works?

Yes. It only creates key types that are missing and leaves existing keys untouched, so clients keep seeing the same fingerprints.

### Clients now say "REMOTE HOST IDENTIFICATION HAS CHANGED!" What do I do?

That is expected after new host keys are generated: the client remembers the old key in `~/.ssh/known_hosts`. Verify the new fingerprint on the server with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, then remove the stale entry on the client with `ssh-keygen -R hostname` (and `ssh-keygen -R '[localhost]:2222'` for a non-standard port) and connect again.

### Why do my WSL host keys disappear?

They should not. Keys live in the distro's ext4 virtual disk and survive `wsl --shutdown` and reboots. If they vanish, the distro was reset, unregistered and reimported, or a script is recreating `/etc/ssh`. Check `ls -l --time-style=full-iso /etc/ssh/ssh_host_*` to see when they were written.

### Can I copy host keys from my old machine?

You can, when you want the new machine to keep the same identity (for example a rebuilt server with the same name). Copy all six files, then set owner `root:root`, mode `600` on private keys and `644` on `.pub` files. Never reuse one set of keys across many different machines.

### Do I still need a DSA host key?

No. OpenSSH 9.8 disabled DSA by default and OpenSSH 10.0 removed it, so `ssh-keygen -A` only creates RSA, ECDSA and Ed25519 keys. If an old client cannot connect after that, see [SSH no matching host key type found: their offer ssh-dss](/post/ssh-returns-no-matching-host-key-type-found-their-offer-ssh-dss/).

## Related guides

- [SSH no matching host key type found: their offer ssh-dss](/post/ssh-returns-no-matching-host-key-type-found-their-offer-ssh-dss/)
- [SSH Public Key Authentication Setup Guide](/ssh-public-key-authentication-setup-guide-2025/)
- [How to Access a Protected Server Using a Jumpbox](/post/using-a-ssh-jumpbox/)
- [Automatic ssh-add: Simplify SSH Key Management](/automatic-ssh-add/)
