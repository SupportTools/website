---
title: "Two Doors In: Vault SSH Certificates for the Network, a Console-Only Root Account for Everything Else"
date: 2026-12-25T09:00:00-06:00
draft: false
tags: ["Vault", "SSH", "Ansible", "PAM", "iDRAC", "Serial Console", "Linux Security"]
categories:
- Security
- Linux
- Automation
author: "Matthew Mattox - mmattox@support.tools"
description: "An Ansible-managed Linux access model with two accounts: one uses a short-lived Vault SSH CA certificate for remote access and a per-host Vault password for sudo, while the other has root privileges but is denied SSH access and reserved for a physical or iDRAC serial console."
more_link: "yes"
url: "/vault-ssh-ca-console-only-root-account-idrac-serial-ansible/"
---

Most fleets end up with one of two bad access models. Either a single long-lived SSH key is authorized for root on every host (and gets copied somewhere it should not be), or root is locked everywhere and the only recovery path when the network dies is rebooting into single-user mode through a virtual console. It is common to have both at once: an old workstation key on dozens of hosts, and a console audit that finds **no server can actually be logged into over its out-of-band serial console**. When a node loses its network, the only way back in is a BIOS job, a power cycle and the GRUB editor.

The fix is to separate normal remote access from the recovery path. One account, called `sre` in this post, can enter over the network only with a short-lived certificate signed by a Vault SSH CA; becoming root additionally requires a random per-host password that lives in Vault. Unless local PAM policy separately denies it, that password can also authenticate `sre` at a physical console. The other account, `console-admin`, has full root privileges but cannot log in over SSH: it is reserved for a console, which on Dell servers means the iDRAC serial-over-LAN session. Every sshd and PAM change is applied by Ansible, proven with a fresh root login, and rolled back automatically if that login fails. This post walks through the design, the configuration, and the two bugs a single-server pilot caught before the rollout touched anything else.

<!--more-->

## The Access Model at a Glance

| Account | How it logs in | Privilege | Credential |
|---|---|---|---|
| `sre` | SSH requires a Vault SSH CA user certificate; SSH never offers password authentication. Local console login remains possible unless separately denied by PAM. | `sudo` asks for a password | Random, generated per host, stored only in Vault |
| `console-admin` | Local or serial console. SSH is denied; `su` from an SSH pseudo-terminal is denied. | `sudo` without a password | Strong password stored in Vault |
| `root` | Console only for password logins | root | Strong password stored in Vault |

All account names, Vault mounts and role names in this post are examples. Pick your own.

The asymmetry is deliberate. Remote login requires a certificate that expires in hours, while privilege escalation requires a separate password that is different on every host. This is not multi-factor authentication for SSH itself: the password is an additional control for becoming root after login. The console is reachable only after authenticating to the BMC, so the console account gets the fastest possible path to root, because the moment you need it is usually the middle of an outage, typing through a laggy serial session.

Three properties hold for every secret in the design:

1. **Vault is the only persistent system that stores a password in plaintext.** During creation the plaintext exists transiently in the controller process and `jq` environment before being written to Vault. Each Vault entry holds `username`, `password` (for a human to read) and `sha512_crypt` (what goes into `/etc/shadow`). Hosts only ever receive the hash.
2. **No plaintext in Ansible variables, command lines or logs.** Generated passwords are created, hashed and written to Vault inside a single shell on the controller.
3. **A rerun can never rotate a password that is in use.** Generated secrets are written with check-and-set `cas=0`, which only succeeds if the path has never existed.

## Door One: sre, Certificate-Only SSH

### The Vault side

The SSH user CA is a Vault SSH secrets engine (mounted here at `ssh-client-ca/`) with an ed25519 signing key generated inside Vault, so the private key never leaves it. Host certificates come from a second, separate mount (`ssh-hosts/`), so a misused host role can never mint user certificates. Each principal set gets its own role. A dedicated role for the network account means adding it changes nothing about any existing certificates:

```bash
vault secrets enable -path=ssh-client-ca ssh
vault write ssh-client-ca/config/ca generate_signing_key=true key_type=ed25519

vault write ssh-client-ca/roles/admin-role - <<'JSON'
{
  "key_type": "ca",
  "algorithm_signer": "default",
  "allow_user_certificates": true,
  "allow_host_certificates": false,
  "allowed_users": "sre",
  "default_user": "sre",
  "allow_user_key_ids": false,
  "key_id_format": "{{token_display_name}}-{{role_name}}-{{public_key_hash}}",
  "allowed_extensions": "permit-pty,permit-port-forwarding",
  "default_extensions": {"permit-pty": ""},
  "ttl": "12h",
  "max_ttl": "16h",
  "not_before_duration": "30s"
}
JSON
```

Two settings matter more than they look:

- **`allow_user_key_ids: false` plus `key_id_format`**: the caller cannot choose the certificate's key ID. Vault stamps it with the caller's token display name, the role and a hash of the public key, and sshd logs that key ID on every login. That gives a direct line from a host's `auth.log` back to a specific Vault login.
- **`not_before_duration`**: backdates the certificate slightly so a few seconds of clock skew between the controller and a host does not produce "certificate is not yet valid".

The policy attached to your human login needs `update` on the sign path. Signing is a write, so `read` is not enough:

```hcl
path "ssh-client-ca/sign/admin-role" {
  capabilities = ["update"]
}
```

### The host side

Hosts trust the CA through `TrustedUserCAKeys` and map certificate principals to local accounts through `AuthorizedPrincipalsFile`. The principals file for `sre` contains exactly one line:

```bash
# /etc/ssh/auth_principals/sre
sre
```

The accounts role then writes its own sshd drop-in. The `Match` block forces public-key authentication for `sre`, so a password is never even offered:

```text
# /etc/ssh/sshd_config.d/20-access-model.conf
# Managed by Ansible.
TrustedUserCAKeys /etc/ssh/trusted_user_ca_keys.pub
AuthorizedPrincipalsFile /etc/ssh/auth_principals/%u
# console-admin is a console account: never over SSH (pam_access denies it too).
DenyUsers console-admin
# sre: Vault SSH CA certificate only, never a password.
Match User sre
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AuthenticationMethods publickey
```

Two sshd behaviors make this safe to drop into a directory that other roles also write to, and both should be verified with `sshd -T` rather than assumed:

- `DenyUsers` **accumulates** across included files, so this line coexists with any other role's `DenyUsers` instead of replacing it.
- A `Match` block **ends at the end of its Include file**. It cannot leak into the drop-ins that sort after it. The role still asserts this on every host (more on that below), because "verified once on one OpenSSH version" is not the same as "true on every host".

### Using it

The network account gets its own key, separate from any daily key, because OpenSSH looks for `<key>-cert.pub` next to the key file:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_sre -C sre

vault write -field=signed_key ssh-client-ca/sign/admin-role \
    public_key=@"$HOME"/.ssh/id_ed25519_sre.pub \
    valid_principals=sre \
    > ~/.ssh/id_ed25519_sre-cert.pub

ssh-keygen -L -f ~/.ssh/id_ed25519_sre-cert.pub | sed -n '1,12p'
```

The `ssh-keygen -L` output should show `Type: ssh-ed25519-cert-v01@openssh.com user certificate`, the Vault-generated `Key ID`, `Principals: sre`, and a validity window of about 12 hours.

If your `~/.ssh/config` already offers other identities or certificates, ssh may present the wrong one first and sshd will log `Certificate does not contain an authorized principal`. Pin the identity explicitly while testing:

```bash
ssh -F /dev/null -o IdentitiesOnly=yes \
    -i ~/.ssh/id_ed25519_sre \
    -o CertificateFile=~/.ssh/id_ed25519_sre-cert.pub \
    sre@host.example.com
```

### sudo needs a second factor

A stolen certificate is bad, but it expires within hours and only grants an unprivileged shell. Getting root also requires the per-host password, which the attacker would have to pull from Vault separately. The sudoers drop-in is the entire sudo policy for both accounts; neither is a member of the `sudo` group:

```text
# /etc/sudoers.d/50-access-model  (validated with visudo -cf before install)
# console-admin can only log in at a console, where it just typed its password.
console-admin ALL=(ALL:ALL) NOPASSWD: ALL
# sre logs in with a Vault SSH CA certificate; sudo always asks for its own per-host password.
sre ALL=(ALL:ALL) ALL
```

### Generating per-host passwords without ever seeing them

The `sre` password for each host is created the first time the play runs against that host. The generation step runs on the controller in one shell, so the plaintext never becomes an Ansible variable, never appears on a command line, and is never logged:

```yaml
- name: "Vault {{ acct_path }}: generate (random, cas=0)"
  ansible.builtin.shell: |
    set -euo pipefail
    pw="$(openssl rand -hex "$PW_BYTES")"
    hash="$(printf '%s' "$pw" | openssl passwd -6 -stdin)"
    case "$hash" in '$6$'*) ;; *) echo "no sha512-crypt hash" >&2; exit 3 ;; esac
    json="$(PW="$pw" H="$hash" U="$ACCT_USER" \
      jq -nc '{username: env.U, password: env.PW, sha512_crypt: env.H}')"
    unset pw
    [ -n "$json" ]
    printf '%s' "$json" | vault kv put -cas=0 -mount="$ACCT_MOUNT" "$ACCT_PATH" - >/dev/null
  args:
    executable: /bin/bash
  environment:
    ACCT_USER: "{{ acct_user }}"
    ACCT_MOUNT: "{{ vault_kv_mount }}"
    ACCT_PATH: "{{ acct_path }}"
    PW_BYTES: "{{ password_bytes }}"
  delegate_to: localhost
  become: false
  no_log: true
  when: secret_absent and not ansible_check_mode
```

Details worth copying:

- **`jq` reads the password from the environment**, not from argv, so it never shows up in `ps`.
- **The payload is checked before it reaches Vault.** Piping an empty string into `vault kv put` from a failed upstream command will happily write an empty secret. The `[ -n "$json" ]` guard and `pipefail` stop that.
- **`-cas=0`** makes the write succeed only if the path has never existed. A second run, a parallel run, or a run after a partial failure can never replace a password that is already set on a host.
- The play then reads the entry back and asserts `username` matches and `sha512_crypt` starts with `$6$` before using it. Only the hash travels to the host, through the `ansible.builtin.user` module's `password` parameter with `no_log: true`.

## Door Two: console-admin, Root That Cannot Use the Network

`console-admin` is a full root account with three independent locks on the network path.

### Lock 1: sshd DenyUsers

The `DenyUsers console-admin` line shown above. sshd rejects the login before authentication and logs that the user is `not allowed because listed in DenyUsers`.

### Lock 2: pam_access for sshd and su

`pam_access` goes into the account stack of both `/etc/pam.d/sshd` and `/etc/pam.d/su`, with a single rule in `/etc/security/access.conf` that denies the account everywhere except console devices. A minimal example:

```text
# BEGIN ANSIBLE access-model
# console-admin: console logins only. sshd/su see a remote host or a pts here, never a console tty.
-:console-admin:ALL EXCEPT tty1 ttyS0
# END ANSIBLE access-model
```

```text
# /etc/pam.d/sshd and /etc/pam.d/su, before @include common-account
account    required     pam_access.so
```

Extend the `EXCEPT` list with whatever console devices your hardware actually uses (other virtual terminals, a second UART, a hypervisor console). For sshd, the origin pam_access evaluates is the client's address. For `su`, it is a pseudo-terminal such as `pts/3`. Neither will ever match a console device name, so both are refused. Including `su` matters: without it, anyone with an unprivileged SSH session who learned the console password could `su - console-admin` and be root. With it, `su` fails with `pam_access(su-l:account): access denied`.

The console path keeps working because `login`, which getty runs, does not load pam_access on Ubuntu. That also means a console with an unexpected tty name still works; the allow list only exists to keep the deny rule readable.

There is a real trap in enabling pam_access on an existing host. Once the module is in the sshd stack, **every** rule in `access.conf` starts being enforced for SSH, including rules someone wrote years ago that never mattered because nothing loaded the module. One stale `-:ALL:ALL` line and root is locked out over SSH. The role refuses to proceed if `access.conf` contains any rule outside its own managed block:

```yaml
- name: access.conf has no rules besides ours
  vars:
    _txt: "{{ (prev_access_conf | b64decode)
              | regex_replace('(?s)# BEGIN ANSIBLE access-model.*?# END ANSIBLE access-model[^\\n]*\\n?', '') }}"
    _rules: "{{ _txt.split('\n') | map('trim') | reject('match', '^(#|$)') | list }}"
  ansible.builtin.assert:
    that: _rules | length == 0
    fail_msg: "access.conf has rules this role did not write ({{ _rules }}). Review them first."
```

### Lock 3: no keys

`console-admin` has no `authorized_keys` (the role deletes the file if it exists), and no Vault SSH role issues a principal that maps to it.

### Why the console account does not need a sudo password

An account that can only exist in a session where its password was typed at a console a few seconds ago gains nothing from being asked for the same password again. It does lose time: retyping a strong password through an iDRAC serial session during an outage is slow and error-prone. `NOPASSWD` is the default, with a variable to turn it off for anyone who disagrees.

### Root

Root gets a strong password stored in Vault, set from its `sha512_crypt` field like the other accounts, and is used only at the console. Password authentication over SSH stays off for root; any existing key or certificate access to root is a separate decision this role does not change.

## Reaching the Console: iDRAC Serial-over-LAN

A console-only account is only as good as the console. On Dell PowerEdge servers, the iDRAC exposes a serial-over-LAN session:

```bash
ssh admin@idrac.example.com
racadm console com2
```

After connecting, wait 10 to 15 seconds and press Enter; the session attaches silently. A common finding is that this session shows **nothing**, and the usual reason is a UART mapping mismatch between the BIOS and the OS.

### Which Linux tty is the SOL device?

`console com2` connects to the iDRAC's "Serial Device 2". Which Linux UART that is depends on the BIOS attribute `BIOS.SerialCommSettings.SerialPortAddress`. On Dell PowerEdge BIOSes:

| `SerialPortAddress` | SOL device is | Linux tty |
|---|---|---|
| `Serial1Com2Serial2Com1` | COM1 | `ttyS0` |
| `Serial1Com1Serial2Com2` | COM2 | `ttyS1` |

Installers and older playbooks often hard-code one of these, and if it is the wrong one, the getty and kernel console end up on a UART that SOL cannot see. Do not trust a table for this; prove it on your hardware. Open `racadm console com2` in one terminal, then from a root shell on the host:

```bash
echo "marker-ttyS0" > /dev/ttyS0
echo "marker-ttyS1" > /dev/ttyS1
```

Only one marker appears in the SOL session. That is your console tty. The examples below assume it is `ttyS0`.

### The fix has three layers

Pick one standard and apply it everywhere. Leaving the BIOS port mapping alone and moving the OS to whichever tty SOL already carries avoids a remapping job on every host.

**1. Getty on the SOL UART, now.** The role enables `serial-getty@ttyS0` and stops any getty on the wrong UART (disabling it only where it is really enabled in `/etc`, since a getty started from the kernel command line shows up as `enabled-runtime` and disappears on its own after the next boot). This takes effect immediately, without a reboot.

**2. Kernel console and GRUB, at the next reboot.** A drop-in in `/etc/default/grub.d/` is sourced by `grub-mkconfig` after `/etc/default/grub`, so it can strip whatever `console=` arguments the installer left behind and append the correct ones. The serial console goes last so it becomes `/dev/console`:

```bash
# /etc/default/grub.d/60-serial-console.cfg
GRUB_CMDLINE_LINUX_DEFAULT="$(printf '%s' "$GRUB_CMDLINE_LINUX_DEFAULT" | sed -E 's/(^| )console=[^ ]*//g')"
GRUB_CMDLINE_LINUX="$(printf '%s' "$GRUB_CMDLINE_LINUX" | sed -E 's/(^| )console=[^ ]*//g') console=tty0 console=ttyS0,115200n8"
GRUB_TERMINAL="console serial"
GRUB_SERIAL_COMMAND="serial --unit=0 --speed=115200"
```

After `update-grub`, the role greps every `linux` line in `/boot/grub/grub.cfg` and asserts each one carries `console=tty0 console=ttyS0,115200n8` and none still names the old tty. If not, it restores the previous drop-in, regenerates `grub.cfg` and fails the host. A broken `grub.cfg` is not something to discover at the next reboot.

**3. BIOS console redirection, staged for the next reboot.** For POST and the GRUB menu to appear on SOL, the BIOS itself must redirect to the SOL UART (`SerialComm=OnConRedirCom1` when SOL is COM1) with `FailSafeBaud=115200`, matching the OS speed. A small Python helper drives racadm over SSH and only **stages** the change:

```bash
racadm jobqueue view
racadm set BIOS.SerialCommSettings.SerialComm OnConRedirCom1
racadm set BIOS.SerialCommSettings.FailSafeBaud 115200
racadm jobqueue create BIOS.Setup.1-1
```

Note what is missing from that last line: `-r pwrcycle -s TIME_NOW`. Without a reboot flag, the job sits in `Scheduled` and the BIOS applies it during the host's next reboot, which can then be a normal patch window instead of an unplanned power cycle. The helper adds several guards around those four commands:

- **Pending "Apply Update From Repo" jobs block new BIOS configuration jobs** on iDRAC7. The helper deletes them one at a time (a batch delete is rejected while other jobs are listed).
- **Any other pending Lifecycle Controller job is a refusal.** It would ride the same reboot, and nobody reviewed it.
- **An already scheduled BIOS job is a refusal**, because BIOS attributes cannot be set while one is pending.
- **A `SerialPortAddress` other than the chosen standard is a refusal** unless the host explicitly opts in to having the port mapping fixed in the same job.
- After staging, it reads the attributes back and requires the new values to appear as pending values, and the job to be `Scheduled`.

The playbook that wraps it runs `serial: 1`, refuses to run without `--limit`, and supports `--check`, which reports the planned changes (for example `SerialComm OnNoConRedir -> OnConRedirCom1`) without touching anything.

## Every sshd and PAM Change Proves Itself

Editing sshd and PAM on a remote host is the classic way to lock yourself out. The accounts role never trusts its own writes. The whole change runs inside an Ansible `block` with a `rescue` that restores the previous files over the still-open connection.

**Before writing anything**, the role saves the current contents of every file it might touch (its sshd drop-in, an optional global no-passwords drop-in, `pam.d/sshd`, `pam.d/su` and `access.conf`) and captures root's effective sshd configuration:

```bash
sshd -T -C user=root,host=check,addr=192.0.2.1
```

**After writing**, it runs `sshd -t`, then evaluates the effective configuration again for both `root` and `sre`, and asserts:

```yaml
- name: console account denied, sre publickey only, root otherwise unchanged
  vars:
    _root: "{{ sshd_after.results[0].stdout_lines }}"
    _sre: "{{ sshd_after.results[1].stdout_lines }}"
    _ours: '^(denyusers|trustedusercakeys|authorizedprincipalsfile|passwordauthentication|kbdinteractiveauthentication) '
  ansible.builtin.assert:
    that:
      - ("denyusers " ~ console_user) in _root
      - "'passwordauthentication no' in _sre"
      - "'kbdinteractiveauthentication no' in _sre"
      - "'authenticationmethods publickey' in _sre"
      - (_root | reject('match', _ours) | list) == (sshd_root_before.stdout_lines | reject('match', _ours) | list)
```

The last assertion is the important one. Filtering out only the directives this role is allowed to change, root's effective configuration must be byte-for-byte identical to what it was before. If a `Match` block ever leaked out of its file on some OpenSSH build, this catches it before sshd reloads.

**Then it reloads sshd** (existing sessions survive a reload) **and proves a brand new root login works**, from the controller:

```yaml
- name: Prove a FRESH root login still works
  ansible.builtin.command:
    argv: [ssh, -o, ControlPath=none, -o, BatchMode=yes, -o, ConnectTimeout=10,
           "root@{{ ansible_host | default(inventory_hostname) }}", "true"]
  delegate_to: localhost
  become: false
  changed_when: false
  register: login_proof
  retries: 3
  delay: 20
  until: login_proof.rc == 0
```

`ControlPath=none` is essential. Ansible typically reuses a multiplexed SSH connection, and a login that rides an existing control socket proves nothing about whether sshd will accept a new one. The retries exist because OpenSSH 9.8 and later apply `PerSourcePenalties`: a burst of connections from the controller can earn a short penalty that looks exactly like a lockout. A genuine lockout fails all three attempts.

**If any step fails**, the `rescue` section writes the saved files back, removes any file that did not exist before, runs `sshd -t && systemctl reload ssh`, and fails the host with a message saying what was restored. Combined with `serial: 1`, a bad change stops at one host with that host back in its previous state.

Turning off password authentication entirely for hosts that still allow it is a separate, later step. It requires that the CA is effective in `sshd -T` and an explicit per-host acknowledgement variable whose value must equal the hostname, given only after a certificate login to that host has been proven. Typing a hostname is a small cost; it turns "I meant to run this on one host" into something the play can check.

## The Pilot: One Server, Two Bugs

The rollout started on a single Dell server that still had an older break-glass console account as a fallback. The order was: stage the BIOS job, run the accounts play in `--check --diff`, run it for real, then run the SSH access role to write the principals file.

### Bug 1: useradd rejects a colon in GECOS

The first real run failed creating the console account. The comment field had been written in a `label: value` style, something like:

```yaml
comment: "Managed by Ansible - console only - Vault: <path>"
```

`useradd` refuses it:

```text
useradd: invalid comment 'Managed by Ansible - console only - Vault: ...'
```

The GECOS field lives inside `/etc/passwd`, where `:` is the field separator, so shadow-utils rejects any comment containing one. A comma is also off limits in practice, since it separates GECOS subfields. The fix was to drop the colon, and the task now carries a comment saying why.

What made this a non-event was ordering. The account tasks run before any sshd or PAM change, so nothing on the host had been touched. The only side effect was the freshly generated `sre` password already written to Vault, and because generation uses `cas=0` and the next run reads the existing entry instead of generating a new one, the rerun simply used it.

There is a second reason the GECOS matters: the role uses a fixed prefix in it as an ownership marker. Before managing either account, it checks that any existing account with that name carries the marker, and refuses to take over a same-named account someone else created.

### Bug 2: the Vault role did not exist

With accounts in place, signing a certificate for the network account failed. The Vault setup script had grown the new role and the matching sign line in the login policy, but the last time anyone had actually run the script predated both. The repository said the role existed; Vault did not. Running the idempotent setup script again created the role and policy line exactly as written, and the certificate login worked.

The lesson generalizes beyond Vault. "It is in the config-as-code repo" and "it exists in the system" are different claims, and a pilot is the cheapest place to find out which one you have. An idempotent setup script that never regenerates existing CA keys is what made re-running it a safe, boring fix.

### What the pilot proved

On that host, after the fixes, each of these was demonstrated rather than inferred:

| Check | Result |
|---|---|
| `sre` with a Vault certificate | Logs in; sshd logs the Vault-generated key ID |
| `sudo -i` as `sre` | Asks for the per-host password; a wrong one is refused |
| `ssh -o PubkeyAuthentication=no sre@host` | Refused with no password prompt |
| `ssh console-admin@host` | Refused, `listed in DenyUsers` |
| `su - console-admin` from an SSH root session | Refused, `pam_access(su-l:account): access denied` |
| iDRAC SOL `racadm console com2` | `console-admin` logs in on the serial tty; `sudo -n id -un` prints `root` |
| Fresh `ssh root@host` | Still works |
| Second run of every play | `changed=0` |

One result was a pleasant surprise: the SOL login worked **before** the staged BIOS job had applied. The UART reaches the iDRAC regardless of the BIOS redirection setting; what the BIOS job adds is POST and GRUB output on the same session. That means the getty half of the fix delivers a working console login immediately, and the reboot only makes the console useful earlier in the boot.

Only after all of that did the old break-glass account come off that host, through another acknowledged, per-host flag.

## Verification Checklist for Your Own Rollout

Run these per host before moving to the next one:

```bash
# Network path: certificate works, password does not
ssh -tt -F /dev/null -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519_sre \
    -o CertificateFile=~/.ssh/id_ed25519_sre-cert.pub sre@host 'sudo -k; sudo -v && echo SUDO-OK'
ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive sre@host
#   expect: Permission denied (publickey) with no password prompt

# Console account is unreachable from the network
ssh console-admin@host                     # expect: refused
ssh root@host 'su - console-admin -c true' # expect: refused, auth log shows pam_access denied

# Effective sshd configuration on the host
sudo sshd -T -C user=sre,host=x,addr=192.0.2.1 | grep -E '^(authenticationmethods|passwordauthentication|trustedusercakeys)'
sudo sshd -T -C user=root,host=x,addr=192.0.2.1 | grep '^denyusers'

# Serial console after the next reboot
cat /proc/cmdline            # ends in console=ttyS0,115200n8
systemctl is-active serial-getty@ttyS0
```

Then open `racadm console com2`, log in as the console account, and run `sudo -i`. A console you have not logged into is a console you do not have.

## Operational Considerations

**Vault outages.** sshd validates certificates offline against the pinned CA public key; there is no call to Vault at login time. Certificates already issued keep working until they expire, so a Vault outage gives up to 12 hours of normal network access. After that, the network account is unavailable until Vault recovers, which is exactly when the console account and the iDRAC console matter. The console path has no dependency on Vault at login time either: the password hash is already in `/etc/shadow`. The password itself must still be retrievable when Vault is down, so keep an encrypted offline copy of the console credentials.

**Monitor the CA, not just the hosts.** A quiet signing failure only shows up hours later as a lockout, when the last certificate expires. A scheduled job that signs a throwaway key against a dedicated role whose only principal maps to no account, and alerts when that fails, turns a silent CA outage into a page.

**Rotation.** Console passwords are rotated by writing a new value to Vault and rerunning the play; the per-host generated passwords are rotated by deleting the Vault entry for that host and rerunning, which generates a fresh one under `cas=0`.

**Rollout order.** Canary first, then one host per class (a bare-metal server, a VM, an ARM board, a cloud instance), then the rest with `serial: 1`. Nodes that host quorum members (etcd, Vault raft) go one at a time with the cluster healthy, and their staged BIOS jobs must not all land in the same reboot window. Nothing in the play removes an existing login path except an old break-glass account, and that only with an explicit per-host acknowledgement.

**Appliances are out of scope for an `/etc/passwd`-based role.** Storage and firewall appliances that keep users in their own databases overwrite local edits, so they need an API-driven implementation of the same model.

## Conclusion

Splitting access into a network account and a console account removes the tension that usually forces a compromise. The network account can be as strict as you like (short-lived certificates, no passwords over SSH, a second factor for root) because it is never the recovery path. The console account can be fast and simple because the network cannot reach it at all, enforced three times over by sshd, PAM and the absence of keys. The parts that make it safe to roll out are less glamorous: hashes instead of plaintext, `cas=0` so reruns cannot rotate live passwords, effective-config assertions instead of trusting file contents, a fresh login with `ControlPath=none` as the final gate, and a one-host pilot that is allowed to fail. On the pilot it failed twice, on a colon and on a missing Vault role, and both times the host was never at risk.
