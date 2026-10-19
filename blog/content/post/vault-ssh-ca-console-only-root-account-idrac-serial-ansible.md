---
title: "Two Doors In: Vault SSH Certificates for the Network, a Console-Only Root Account for Everything Else"
date: 2026-10-21T09:00:00-05:00
draft: false
tags: ["Vault", "SSH", "Ansible", "PAM", "iDRAC", "Serial Console", "Linux Security"]
categories:
- Security
- Linux
- Automation
author: "Matthew Mattox - mmattox@support.tools"
description: "An Ansible-managed Linux access model with two accounts: ops logs in over SSH only with a short-lived Vault SSH CA certificate and needs a per-host Vault password for sudo, while ops-console is root but can only log in at a physical or iDRAC serial console. Includes the sshd, PAM, GRUB and racadm configuration, the self-verifying rollback pattern, and what a one-server pilot caught."
more_link: "yes"
url: "/vault-ssh-ca-console-only-root-account-idrac-serial-ansible/"
---

Most fleets end up with one of two bad access models. Either a single long-lived SSH key is authorized for root on every host (and gets copied somewhere it should not be), or root is locked everywhere and the only recovery path when the network dies is rebooting into single-user mode through a virtual console. The lab described here had both at once: a years-old workstation key on dozens of hosts, and a console audit that found **no server could be logged into over its out-of-band serial console at all**. When a node lost its network, the only way back in was a BIOS job, a power cycle and the GRUB editor.

The fix was to split access into two doors that never overlap. One account, `ops`, comes in over the network and can only do so with a short-lived certificate signed by a Vault SSH CA; becoming root additionally requires a random per-host password that lives in Vault. The other account, `ops-console`, has full root but physically cannot log in over SSH: it works only at a console, which on Dell servers means the iDRAC serial-over-LAN session. Root shares the console password. Every sshd and PAM change is applied by Ansible, proven with a fresh root login, and rolled back automatically if that login fails. This post walks through the design, the exact configuration, and the two bugs a single-server pilot caught before the rollout touched anything else.

<!--more-->

## The Access Model at a Glance

| Account | How it logs in | Privilege | Credential |
|---|---|---|---|
| `ops` | SSH only, with a Vault SSH CA user certificate (principal `ops`). Never a password over SSH. | `sudo` asks for a password | Random, generated per host, stored only in Vault |
| `ops-console` | Local console, serial console (iDRAC SOL on `ttyS0`, VM serial, Pi UART). Never SSH, never `su`. | `sudo` without a password | One operator-chosen value, stored in Vault |
| `root` | Console (plus whatever key or certificate SSH access already existed) | root | The same password as `ops-console` |

The asymmetry is deliberate. The network is where attackers live, so the network account gets two factors: a certificate that expires in hours and a password that is different on every host. The console is reachable only after authenticating to the BMC, so the console account gets the fastest possible path to root, because the moment you need it is usually the middle of an outage, typing through a laggy serial session.

Three properties hold for every secret in the design:

1. **Vault is the only place a password exists in plaintext.** Each Vault entry holds `username`, `password` (for a human to read) and `sha512_crypt` (what goes into `/etc/shadow`). Hosts only ever receive the hash.
2. **No plaintext in Ansible variables, command lines or logs.** Generated passwords are created, hashed and written to Vault inside a single shell on the controller.
3. **A rerun can never rotate a password that is in use.** Generated secrets are written with check-and-set `cas=0`, which only succeeds if the path has never existed.

## Door One: ops, Certificate-Only SSH

### The Vault side

The SSH user CA is a Vault SSH secrets engine with an ed25519 signing key generated inside Vault, so the private key never leaves it. Each principal set gets its own role. The `ops` role is separate from the daily operator role so that adding it changed nothing about existing certificates:

```bash
vault write ssh-user-ca/roles/ops - <<'JSON'
{
  "key_type": "ca",
  "algorithm_signer": "default",
  "allow_user_certificates": true,
  "allow_host_certificates": false,
  "allowed_users": "ops",
  "default_user": "ops",
  "allow_user_key_ids": false,
  "key_id_format": "vault-{{token_display_name}}-{{role_name}}-{{public_key_hash}}",
  "allowed_extensions": "permit-pty,permit-port-forwarding",
  "default_extensions": {"permit-pty": ""},
  "ttl": "12h",
  "max_ttl": "16h",
  "not_before_duration": "30s"
}
JSON
```

Two settings matter more than they look:

- **`allow_user_key_ids: false` plus `key_id_format`**: the caller cannot choose the certificate's key ID. Vault stamps it with the Vault identity, the role and a hash of the public key, and sshd logs that key ID on every login. That gives a direct line from a host's `auth.log` back to a specific Vault login.
- **`not_before_duration`**: backdates the certificate slightly so a few seconds of clock skew between the controller and a host does not produce "certificate is not yet valid".

The human login policy needs `update` on `ssh-user-ca/sign/ops`. Signing is a write, so `read` is not enough.

### The host side

Hosts trust the CA through `TrustedUserCAKeys` and map certificate principals to local accounts through `AuthorizedPrincipalsFile`. The `ops` principal file contains exactly one line:

```bash
# /etc/ssh/ssh_access/principals/ops
ops
```

The accounts role then writes its own sshd drop-in. The `Match` block forces public-key authentication for `ops`, so a password is never even offered:

```text
# /etc/ssh/sshd_config.d/15-accounts.conf
# Managed by Ansible.
# ops-console is a console account: never over SSH (pam_access denies it too).
DenyUsers ops-console
# ops: Vault SSH CA certificate only, never a password.
Match User ops
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AuthenticationMethods publickey
```

Two sshd behaviors make this safe to drop into a directory that other roles also write to, and both were verified with `sshd -T` rather than assumed:

- `DenyUsers` **accumulates** across included files, so this line coexists with any other role's `DenyUsers` instead of replacing it.
- A `Match` block **ends at the end of its Include file**. It cannot leak into the drop-ins that sort after it. The role still asserts this on every host (more on that below), because "verified once on one OpenSSH version" is not the same as "true on every host".

### Using it

`ops` gets its own key, separate from the daily operator key, because OpenSSH looks for `<key>-cert.pub` next to the key file:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_ops -C ops

vault write -field=signed_key ssh-user-ca/sign/ops \
    public_key=@$HOME/.ssh/id_ed25519_ops.pub \
    valid_principals=ops \
    > ~/.ssh/id_ed25519_ops-cert.pub

ssh-keygen -L -f ~/.ssh/id_ed25519_ops-cert.pub | sed -n '1,12p'
```

The `ssh-keygen -L` output should show `Type: ssh-ed25519-cert-v01@openssh.com user certificate`, a `Key ID` starting with `vault-`, `Principals: ops`, and a validity window of about 12 hours.

If your `~/.ssh/config` already offers other identities or certificates, ssh may present the wrong one first and sshd will log `Certificate does not contain an authorized principal`. Pin the identity explicitly while testing:

```bash
ssh -F /dev/null -o IdentitiesOnly=yes \
    -i ~/.ssh/id_ed25519_ops \
    -o CertificateFile=~/.ssh/id_ed25519_ops-cert.pub \
    ops@host.example.com
```

### sudo needs a second factor

A stolen certificate is bad, but it expires within hours and only grants an unprivileged shell. Getting root also requires the per-host password, which the attacker would have to pull from Vault separately. The sudoers drop-in is the entire sudo policy for both accounts; neither is a member of the `sudo` group:

```text
# /etc/sudoers.d/50-ops-accounts  (validated with visudo -cf before install)
# ops-console can only log in at a console, where it just typed its password.
ops-console ALL=(ALL:ALL) NOPASSWD: ALL
# ops logs in with a Vault SSH CA certificate; sudo always asks for its own per-host password.
ops ALL=(ALL:ALL) ALL
```

### Generating per-host passwords without ever seeing them

The `ops` password for each host is created the first time the play runs against that host. The generation step runs on the controller in one shell, so the plaintext never becomes an Ansible variable, never appears on a command line, and is never logged:

```yaml
- name: "Vault {{ _acct_path }}: generate (random, cas=0)"
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
    ACCT_USER: "{{ _acct_user }}"
    ACCT_MOUNT: "{{ vault_kv_mount }}"
    ACCT_PATH: "{{ _acct_path }}"
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

## Door Two: ops-console, Root That Cannot Use the Network

`ops-console` is a full root account with three independent locks on the network path.

### Lock 1: sshd DenyUsers

The `DenyUsers ops-console` line shown above. sshd rejects the login before authentication and logs `User ops-console from ... not allowed because listed in DenyUsers`.

### Lock 2: pam_access for sshd and su

`pam_access` goes into the account stack of both `/etc/pam.d/sshd` and `/etc/pam.d/su`, with a single rule in `/etc/security/access.conf`:

```text
# BEGIN ANSIBLE accounts
# ops-console: console logins only. sshd/su see a remote host or a pts here, never one of these.
-:ops-console:ALL EXCEPT console tty1 tty2 tty3 tty4 tty5 tty6 ttyS0 ttyS1 ttyAMA0 hvc0
# END ANSIBLE accounts
```

```text
# /etc/pam.d/sshd and /etc/pam.d/su, before @include common-account
account    required     pam_access.so
```

For sshd, the origin pam_access evaluates is the client's address. For `su`, it is a pseudo-terminal such as `pts/3`. Neither will ever match a console device name, so both are refused. Including `su` matters: the console password is shared fleet-wide, so without this, anyone with an unprivileged SSH session on any host who learned that password could `su - ops-console` and be root. With it, `su` fails with `pam_access(su-l:account): access denied`.

The console path keeps working because `login`, which getty runs, does not load pam_access on Ubuntu. That also means a console with an unexpected tty name still works; the allow list only exists to keep the deny rule readable.

There is a real trap in enabling pam_access on an existing host. Once the module is in the sshd stack, **every** rule in `access.conf` starts being enforced for SSH, including rules someone wrote years ago that never mattered because nothing loaded the module. One stale `-:ALL:ALL` line and root is locked out over SSH. The role refuses to proceed if `access.conf` contains any rule outside its own managed block:

```yaml
- name: access.conf has no rules besides ours
  vars:
    _txt: "{{ (prev_access_conf | b64decode)
              | regex_replace('(?s)# BEGIN ANSIBLE accounts.*?# END ANSIBLE accounts[^\\n]*\\n?', '') }}"
    _rules: "{{ _txt.split('\n') | map('trim') | reject('match', '^(#|$)') | list }}"
  ansible.builtin.assert:
    that: _rules | length == 0
    fail_msg: "access.conf has rules this role did not write ({{ _rules }}). Review them first."
```

### Lock 3: no keys

`ops-console` has no `authorized_keys` (the role deletes the file if it exists), and no Vault SSH role issues the principal `ops-console`.

### Why the console account does not need a sudo password

An account that can only exist in a session where its password was typed at a console a few seconds ago gains nothing from being asked for the same password again. It does lose time: retyping a strong password through an iDRAC serial session during an outage is slow and error-prone. `NOPASSWD` is the default, with a variable to turn it off for anyone who disagrees.

### Root shares the console password

Root's password is set from the same Vault read as `ops-console`'s, using the same `sha512_crypt` value. There is one source, so the two cannot drift, and there are no per-host root secrets to track, rotate or back up. The trade-off is explicit: anyone who has the console password has root at any console in the fleet. That is acceptable here because reaching a console already requires BMC credentials or physical access, and the alternative (a different root password per host) is exactly the kind of secret sprawl that ends with someone writing them down.

## Reaching the Console: iDRAC Serial-over-LAN

A console-only account is only as good as the console. On Dell PowerEdge servers, the iDRAC exposes a serial-over-LAN session:

```bash
ssh admin@idrac.example.com
racadm console com2
```

After connecting, wait 10 to 15 seconds and press Enter; the session attaches silently. The fleet audit that started this project found that this session showed **nothing** on every server, and the reason was a UART mapping mismatch that is easy to get wrong.

### Which Linux tty is the SOL device?

`console com2` connects to the iDRAC's "Serial Device 2". Which Linux UART that is depends on the BIOS attribute `BIOS.SerialCommSettings.SerialPortAddress`:

| `SerialPortAddress` | SOL device is | Linux tty |
|---|---|---|
| `Serial1Com2Serial2Com1` | COM1 | `ttyS0` |
| `Serial1Com1Serial2Com2` (Dell factory default) | COM2 | `ttyS1` |

Every server here had `Serial1Com2Serial2Com1`, so SOL carried `ttyS0`. The network installer, however, had been configuring `console=ttyS1,115200n8` and a getty on `ttyS1`, which SOL cannot see. Do not trust a table for this; prove it. Open `racadm console com2` in one terminal, then from a root shell on the host:

```bash
echo "marker-ttyS0" > /dev/ttyS0
echo "marker-ttyS1" > /dev/ttyS1
```

Only one marker appears in the SOL session. That is your console tty.

### The fix has three layers

The standard chosen was to leave the BIOS port mapping alone (no remapping job on every host) and move the OS to `ttyS0`.

**1. Getty on the SOL UART, now.** The role enables `serial-getty@ttyS0` and stops the old `serial-getty@ttyS1` (disabling it only where it is really enabled in `/etc`, since a getty started from the kernel command line shows up as `enabled-runtime` and disappears on its own after the next boot). This takes effect immediately, without a reboot.

**2. Kernel console and GRUB, at the next reboot.** A drop-in in `/etc/default/grub.d/` is sourced by `grub-mkconfig` after `/etc/default/grub`, so it can strip whatever `console=` arguments the installer left behind and append the correct ones. The serial console goes last so it becomes `/dev/console`:

```bash
# /etc/default/grub.d/60-serial-console.cfg
GRUB_CMDLINE_LINUX_DEFAULT="$(printf '%s' "$GRUB_CMDLINE_LINUX_DEFAULT" | sed -E 's/(^| )console=[^ ]*//g')"
GRUB_CMDLINE_LINUX="$(printf '%s' "$GRUB_CMDLINE_LINUX" | sed -E 's/(^| )console=[^ ]*//g') console=tty0 console=ttyS0,115200n8"
GRUB_TERMINAL="console serial"
GRUB_SERIAL_COMMAND="serial --unit=0 --speed=115200"
```

After `update-grub`, the role greps every `linux` line in `/boot/grub/grub.cfg` and asserts each one carries `console=tty0 console=ttyS0,115200n8` and none still names `ttyS1`. If not, it restores the previous drop-in, regenerates `grub.cfg` and fails the host. A broken `grub.cfg` is not something to discover at the next reboot.

**3. BIOS console redirection, staged for the next reboot.** For POST and the GRUB menu to appear on SOL, the BIOS itself must redirect to the SOL UART: `SerialComm=OnConRedirCom1` and `FailSafeBaud=115200`, matching the OS speed. A small Python helper drives racadm over SSH and only **stages** the change:

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
- **A non-standard `SerialPortAddress` is a refusal** unless the host explicitly opts in to having the port mapping fixed in the same job.
- After staging, it reads the attributes back and requires the new values to appear as pending values, and the job to be `Scheduled`.

The playbook that wraps it runs `serial: 1`, refuses to run without `--limit`, and supports `--check`, which reports the planned changes (for example `SerialComm OnNoConRedir -> OnConRedirCom1`) without touching anything.

## Every sshd and PAM Change Proves Itself

Editing sshd and PAM on a remote host is the classic way to lock yourself out. The accounts role never trusts its own writes. The whole change runs inside an Ansible `block` with a `rescue` that restores the previous files over the still-open connection.

**Before writing anything**, the role saves the current contents of every file it might touch (`15-accounts.conf`, the optional `10-no-passwords.conf`, `pam.d/sshd`, `pam.d/su` and `access.conf`) and captures root's effective sshd configuration:

```bash
sshd -T -C user=root,host=accounts-check,addr=192.0.2.1
```

**After writing**, it runs `sshd -t`, then evaluates the effective configuration again for both `root` and `ops`, and asserts:

```yaml
- name: ops-console denied, ops publickey only, root otherwise unchanged
  vars:
    _root: "{{ accounts_after.results[0].stdout_lines }}"
    _ops: "{{ accounts_after.results[1].stdout_lines }}"
    _ours: '^(denyusers|trustedusercakeys|authorizedprincipalsfile|passwordauthentication|kbdinteractiveauthentication) '
  ansible.builtin.assert:
    that:
      - ("denyusers " ~ accounts_console_user) in _root
      - "'passwordauthentication no' in _ops"
      - "'kbdinteractiveauthentication no' in _ops"
      - "'authenticationmethods publickey' in _ops"
      - (_root | reject('match', _ours) | list) == (accounts_root_before.stdout_lines | reject('match', _ours) | list)
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
  register: accounts_proof
  retries: 3
  delay: 20
  until: accounts_proof.rc == 0
```

`ControlPath=none` is essential. Ansible typically reuses a multiplexed SSH connection, and a login that rides an existing control socket proves nothing about whether sshd will accept a new one. The retries exist because OpenSSH 9.8 and later apply `PerSourcePenalties`: a burst of connections from the controller can earn a short penalty that looks exactly like a lockout. A genuine lockout fails all three attempts.

**If any step fails**, the `rescue` section writes the saved files back, removes any file that did not exist before, runs `sshd -t && systemctl reload ssh`, and fails the host with a message saying what was restored. Combined with `serial: 1`, a bad change stops at one host with that host back in its previous state.

Turning off password authentication entirely for hosts that still allow it is a separate, later step. It requires that the CA is effective in `sshd -T` and an explicit per-host acknowledgement variable whose value must equal the hostname, given only after a certificate login to that host has been proven. Typing a hostname is a small cost; it turns "I meant to run this on one host" into something the play can check.

## The Pilot: One R720, Two Bugs

The rollout started on a single R720 that still had the old break-glass console account as a fallback. The order was: stage the BIOS job, run the accounts play in `--check --diff`, run it for real, then run the SSH access role to write the `ops` principal file.

### Bug 1: useradd rejects a colon in GECOS

The first real run failed creating `ops-console`. The comment field had been written in a `label: value` style, something like:

```yaml
comment: "Managed by Ansible accounts - console only - Vault: <path>"
```

`useradd` refuses it:

```text
useradd: invalid comment 'Managed by Ansible accounts - console only - Vault: ...'
```

The GECOS field lives inside `/etc/passwd`, where `:` is the field separator, so shadow-utils rejects any comment containing one. A comma is also off limits in practice, since it separates GECOS subfields. The fix was to drop the colon, and the task now carries a comment saying why.

What made this a non-event was ordering. The account tasks run before any sshd or PAM change, so nothing on the host had been touched. The only side effect was the freshly generated `ops` password already written to Vault, and because generation uses `cas=0` and the next run reads the existing entry instead of generating a new one, the rerun simply used it.

There is a second reason the GECOS matters: the role uses it as an ownership marker. Before managing `ops` or `ops-console`, it checks that any existing account with that name has a GECOS starting with `Managed by Ansible accounts`, and refuses to take over a same-named account someone else created.

### Bug 2: the Vault role did not exist

With accounts in place, signing an `ops` certificate failed. The Vault setup script had grown the `ops` role and the matching `sign/ops` line in the admin policy, but the last time anyone had actually run the script predated both. The repository said the role existed; Vault did not. Running the idempotent setup script again created the role and policy line exactly as written, and the certificate login worked.

The lesson generalizes beyond Vault. "It is in the config-as-code repo" and "it exists in the system" are different claims, and a pilot is the cheapest place to find out which one you have. An idempotent setup script that never regenerates existing CA keys is what made re-running it a safe, boring fix.

### What the pilot proved

On that host, after the fixes, each of these was demonstrated rather than inferred:

| Check | Result |
|---|---|
| `ops` with a Vault `ops` certificate | Logs in; sshd logs a key ID beginning `vault-` |
| `sudo -i` as `ops` | Asks for the per-host password; a wrong one is refused |
| `ssh -o PubkeyAuthentication=no ops@host` | Refused with no password prompt |
| `ssh ops-console@host` | Refused, `listed in DenyUsers` |
| `su - ops-console` from an SSH root session | Refused, `pam_access(su-l:account): access denied` |
| iDRAC SOL `racadm console com2` | `ops-console` logs in on `/dev/ttyS0`; `sudo -n id -un` prints `root` |
| Fresh `ssh root@host` | Still works |
| Second run of every play | `changed=0` |

One result was a pleasant surprise: the SOL login worked **before** the staged BIOS job had applied. The UART reaches the iDRAC regardless of the BIOS redirection setting; what the BIOS job adds is POST and GRUB output on the same session. That means the getty half of the fix delivers a working console login immediately, and the reboot only makes the console useful earlier in the boot.

Only after all of that did the old break-glass account come off that host, through another acknowledged, per-host flag.

## Verification Checklist for Your Own Rollout

Run these per host before moving to the next one:

```bash
# Network path: certificate works, password does not
ssh -F /dev/null -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519_ops \
    -o CertificateFile=~/.ssh/id_ed25519_ops-cert.pub ops@host 'sudo -k; sudo -v && echo SUDO-OK'
ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive ops@host
#   expect: Permission denied (publickey) with no password prompt

# Console account is unreachable from the network
ssh ops-console@host                     # expect: refused
ssh root@host 'su - ops-console -c true' # expect: refused, auth log shows pam_access denied

# Effective sshd configuration on the host
sudo sshd -T -C user=ops,host=x,addr=192.0.2.1 | grep -E '^(authenticationmethods|passwordauthentication|trustedusercakeys)'
sudo sshd -T -C user=root,host=x,addr=192.0.2.1 | grep '^denyusers'

# Serial console after the next reboot
cat /proc/cmdline            # ends in console=ttyS0,115200n8
systemctl is-active serial-getty@ttyS0
```

Then open `racadm console com2`, log in as `ops-console`, and run `sudo -i`. A console you have not logged into is a console you do not have.

## Operational Considerations

**Vault outages.** sshd validates certificates offline against the pinned CA public key; there is no call to Vault at login time. Certificates already issued keep working until they expire, so a Vault outage gives up to 12 hours of normal network access. After that, `ops` is unavailable until Vault recovers, which is exactly when `ops-console` and the iDRAC console matter. The console path has no dependency on Vault at login time either: the password hash is already in `/etc/shadow`. The password itself must still be retrievable when Vault is down, so keep an encrypted offline copy of the console credential.

**Monitor the CA, not just the hosts.** A quiet signing failure only shows up hours later as a lockout, when the last certificate expires. A scheduled job that signs a throwaway key against a role whose only principal maps to no account, and alerts when that fails, turns a silent CA outage into a page.

**Blast radius of the shared console password.** It is a single fleet-wide secret, so treat any suspected exposure as fleet-wide: rotate it in Vault and rerun the play everywhere. Because both `ops-console` and root take their hash from the same read, one rotation updates both.

**Rollout order.** Canary first, then one host per class (a bare-metal server, a VM, a Raspberry Pi, a cloud droplet), then the rest with `serial: 1`. Nodes that host quorum members (etcd, Vault raft) go one at a time with the cluster healthy, and their staged BIOS jobs must not all land in the same reboot window. Nothing in the play removes an existing login path except the old break-glass account, and that only with an explicit per-host acknowledgement.

**Appliances are out of scope for the Ansible role.** TrueNAS keeps users in its middleware database and pfSense keeps them in `config.xml`; editing `/etc/passwd` on either is overwritten. Both need their own API-driven implementation of the same model.

## Conclusion

Splitting access into a network account and a console account removes the tension that usually forces a compromise. The network account can be as strict as you like (short-lived certificates, no passwords over SSH, a second factor for root) because it is never the recovery path. The console account can be fast and simple because the network cannot reach it at all, enforced three times over by sshd, PAM and the absence of keys. The parts that make it safe to roll out are less glamorous: hashes instead of plaintext, `cas=0` so reruns cannot rotate live passwords, effective-config assertions instead of trusting file contents, a fresh login with `ControlPath=none` as the final gate, and a one-host pilot that is allowed to fail. On the pilot it failed twice, on a colon and on a missing Vault role, and both times the host was never at risk.
