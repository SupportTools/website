---
title: "The Modern Fresh-Server Checklist: Provisioning a Production Linux Host From Scratch"
date: 2032-04-29T09:00:00-05:00
draft: false
tags: ["Linux", "Server Hardening", "SSH", "nftables", "Ansible", "cloud-init", "fail2ban", "Prometheus", "System Administration", "Security", "Automation", "Backups"]
categories:
- Linux
- System Administration
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "An opinionated, reproducible checklist for provisioning a fresh production Linux server: SSH hardening, nftables, unattended-upgrades, fail2ban, time sync, swap, limits, node_exporter, log shipping, cloud-init, Ansible, TLS, and backups."
more_link: "yes"
url: "/fresh-server-provisioning-modern-checklist/"
---

Rebuilding the box that runs a blog is a deceptively small project that quietly turns into a tour of every decision a Linux host makes on your behalf. You start by upgrading the operating system, and three hours later you are arguing with yourself about swap sizing, firewall rulesets, and whether the new instance should even be a virtual machine at all. The personal version of that story ends with a working site. The production version ends with a checklist, because the only thing worse than provisioning a server by hand is provisioning the next forty of them by hand and getting each one subtly different. This guide turns the one-off rebuild into a repeatable, opinionated procedure that produces a hardened, observable, backed-up host every time.

<!--more-->

## Decide First Whether You Should Provision a Server at All

Before a single package is installed, the most valuable thing an engineer can do is question the premise. A long-lived, hand-maintained Linux host is a liability that has to be patched, monitored, backed up, and eventually rebuilt. For a large class of workloads, the right answer in 2032 is not "provision a server" but "ship a container to a platform that already solved provisioning."

Use this rough decision framework:

- **Run it on Kubernetes (or a managed PaaS) when** the workload is a stateless or near-stateless application, you already operate a cluster, the team is comfortable with declarative deployments, and you want rolling updates, autoscaling, and self-healing for free. A static blog served by a small Go binary, for example, belongs in a container behind an ingress, not on a pet VM.
- **Provision a dedicated host when** you need a single durable endpoint with a stable identity (a bastion, a self-hosted Git server, a database that is not yet worth running on an operator, a build runner with specialized hardware), when regulatory or latency constraints rule out shared platforms, or when the cluster itself has to run on something and that something is a node you are now building.

The irony is that the checklist below is exactly what good Kubernetes node images and cloud-init templates encode internally. Whether the destination is a hand-built bastion or a node pool, the same hardening primitives apply. The difference is who maintains them: a platform team baking a golden image, or you, once, in Ansible.

The rest of this guide assumes the answer was "yes, build the host," and that the host is a fresh Ubuntu 24.04 LTS or Debian 12 instance with nothing but a default cloud image and root or sudo access.

## Phase One: Establish a Trusted Way In Before You Touch Anything

The single most dangerous moment in a server's life is the window where you reconfigure the network access you are currently using. Lock yourself out of a cloud instance with no console and the box becomes a brick. Every step that follows is designed so that an existing, working session is never the only way back in.

### Create an Administrative User With sudo

Working as `root` over SSH is a habit worth breaking on day one. Create a named administrative user, give it passwordless `sudo` only if your automation requires it, and make all further work flow through that account.

```bash
# Create the admin user with a home directory and bash as the login shell.
adduser --gecos "" --disabled-password deploy

# Grant sudo by adding the user to the sudo group (Ubuntu/Debian).
usermod -aG sudo deploy

# Install the operator's public key. The key material below is an example
# ed25519 public key; replace it with your own from ~/.ssh/id_ed25519.pub.
install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
cat > /home/deploy/.ssh/authorized_keys <<'EOF'
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH8m1k0p2Qe9bXvN3rT6sUaWcZ7yL4dF1gH2jK3lM4n deploy@workstation
EOF
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 0600 /home/deploy/.ssh/authorized_keys
```

Decide deliberately about passwordless sudo. A bastion that humans log into interactively benefits from requiring a sudo password (it blunts a stolen-key attack). A host driven only by automation usually needs passwordless sudo so non-interactive runs do not hang. Encode the choice explicitly rather than relying on a distro default:

```bash
# Require a password for sudo on interactive hosts.
echo 'deploy ALL=(ALL) ALL' > /etc/sudoers.d/deploy

# OR, for automation-only hosts, allow passwordless sudo. Pick one.
# echo 'deploy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/deploy

# Always validate sudoers files with visudo's check mode before trusting them.
chmod 0440 /etc/sudoers.d/deploy
visudo -cf /etc/sudoers.d/deploy
```

### Harden the SSH Daemon

With key-based access confirmed for the new user **in a second terminal that you keep open**, tighten `sshd`. The goal is to disable password authentication, refuse direct root login, and reduce the daemon's attack surface. Write the policy as a drop-in under `/etc/ssh/sshd_config.d/` rather than editing the shipped `sshd_config`, which keeps your intent separate from the package's defaults and survives upgrades cleanly.

```bash
# Modern OpenSSH on Ubuntu/Debian reads drop-ins from sshd_config.d first.
cat > /etc/ssh/sshd_config.d/10-hardening.conf <<'EOF'
# Refuse interactive and direct root logins entirely.
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no

# Public-key authentication only.
PubkeyAuthentication yes
AuthenticationMethods publickey

# Trim the surface area.
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
PermitEmptyPasswords no
MaxAuthTries 3
LoginGraceTime 20

# Restrict logins to the accounts that should ever have shell access.
AllowUsers deploy
EOF
```

Always validate the configuration before reloading the daemon. A syntax error that takes `sshd` down with no console is a long evening.

```bash
# Validate syntax. Reload (not restart) so existing sessions survive.
sshd -t && systemctl reload ssh
```

Verify the new policy from a fresh connection while the original session stays open as a safety net:

```bash
# From your workstation, confirm key auth works and password auth is refused.
ssh -o PreferredAuthentications=publickey deploy@server.example.com 'echo ok'
ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no \
    deploy@server.example.com 'echo should-not-happen'   # expect: Permission denied
```

Only after the new connection succeeds should you close the original session.

## Phase Two: Lock Down the Network With nftables

`iptables` is legacy; modern distributions ship `nftables` as the kernel firewall framework, and that is what new hosts should use directly. The policy below sets a default-deny posture for inbound traffic, permits only loopback, established connections, ICMP, and the services this host actually exposes.

```bash
# Define a single, auditable ruleset. Adjust the tcp dport set to match the
# services this host serves. This example allows SSH (22), HTTP (80), HTTPS (443).
cat > /etc/nftables.conf <<'EOF'
#!/usr/sbin/nft -f

flush ruleset

table inet filter {
    chain input {
        type filter hook input priority 0; policy drop;

        # Accept loopback and already-established/related flows.
        iif "lo" accept
        ct state established,related accept

        # Drop obviously invalid packets early.
        ct state invalid drop

        # Allow ICMP/ICMPv6 for path MTU discovery and diagnostics.
        ip protocol icmp accept
        ip6 nexthdr icmpv6 accept

        # Permit the services this host exposes.
        tcp dport { 22, 80, 443 } accept

        # Everything else inbound is rejected with a clear signal.
        reject with icmpx type admin-prohibited
    }

    chain forward {
        type filter hook forward priority 0; policy drop;
    }

    chain output {
        type filter hook output priority 0; policy accept;
    }
}
EOF
```

Apply the ruleset, confirm it parses, and enable the service so it survives reboots:

```bash
# Parse-check the ruleset, then load and persist it.
nft -c -f /etc/nftables.conf
systemctl enable --now nftables
nft list ruleset                       # verify the live ruleset matches intent
```

Keep the firewall narrow. If a host only ever serves traffic behind a load balancer or a private network, drop ports `80` and `443` from the public input chain entirely and rely on a separate interface or source-address match. The fewer ports open to the internet, the smaller the surface that fail2ban, log review, and your future self have to watch.

## Phase Three: Keep the System Patched Automatically

A server that is not patched is a server that is slowly accumulating known vulnerabilities. On Debian and Ubuntu, `unattended-upgrades` applies security updates without human intervention. The decision to automate reboots depends on the role: a single-instance database should reboot in a controlled maintenance window, while a stateless web node behind a load balancer can reboot itself at 4 a.m.

```bash
# Install the tooling that drives automatic security patching.
apt-get update
apt-get install -y unattended-upgrades apt-listchanges
```

Configure which updates apply and whether automatic reboots are allowed:

```bash
# Enable security updates and, optionally, automatic reboots in a quiet window.
cat > /etc/apt/apt.conf.d/52unattended-upgrades-local <<'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};

// Clean up packages that are no longer required after an upgrade.
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";

// Reboot automatically only if a package requires it, in a fixed window.
// Leave this "false" for stateful hosts you reboot by hand.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";

// Email a report when something goes wrong (requires a working MTA).
Unattended-Upgrade::Mail "ops@support.tools";
Unattended-Upgrade::MailReport "on-change";
EOF
```

Turn on the periodic timers that actually run the updates and verify the configuration with a dry run:

```bash
# Enable the daily download/upgrade timers.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

# Dry-run the upgrade to confirm origins and config parse cleanly.
unattended-upgrade --dry-run --debug
```

## Phase Four: Add Brute-Force Protection With fail2ban

Even with password authentication disabled, the SSH port draws a constant stream of automated login attempts that pollute logs and waste cycles. `fail2ban` watches the log stream and temporarily bans source addresses that trip a threshold. On `systemd`-based hosts it reads the journal directly, which is more reliable than tailing a file.

```bash
# Install fail2ban; the systemd backend reads the journal natively.
apt-get install -y fail2ban
```

Define a local jail so package upgrades never clobber your policy:

```bash
# /etc/fail2ban/jail.local overrides the shipped jail.conf safely.
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
# Read events from the systemd journal rather than log files.
backend = systemd

# Ban for one hour after 5 failures within a 10-minute window.
bantime  = 1h
findtime = 10m
maxretry = 5

# Never ban the office egress or the monitoring host.
ignoreip = 127.0.0.1/8 ::1 203.0.113.10

[sshd]
enabled = true
EOF
```

Start the service and confirm the jail is active:

```bash
# Enable and inspect the jail. The status command shows current bans.
systemctl enable --now fail2ban
fail2ban-client status sshd
```

If the host sits entirely behind a VPN or a private network, fail2ban on the SSH port is largely redundant; spend the effort hardening whatever public-facing service the box actually runs instead.

## Phase Five: Get the Boring Foundations Right

These steps rarely make a checklist's highlight reel, yet a wrong answer on any of them produces an outage that is maddening to diagnose months later.

### Synchronize Time

Skewed clocks break TLS validation, distributed locks, log correlation, and authentication tokens. Modern systemd hosts ship `systemd-timesyncd`, which is sufficient for the vast majority of servers; reserve full `chrony` for hosts that are themselves time sources or have strict accuracy requirements.

```bash
# Point timesyncd at reliable NTP pools and enable it.
cat > /etc/systemd/timesyncd.conf <<'EOF'
[Time]
NTP=time.cloudflare.com 0.pool.ntp.org 1.pool.ntp.org
FallbackNTP=2.pool.ntp.org 3.pool.ntp.org
EOF

timedatectl set-ntp true
systemctl restart systemd-timesyncd
timedatectl show-timesync --all | grep -E 'NTPMessage|ServerName'
```

### Provision Swap Deliberately

Cloud images frequently ship with no swap at all, which means the kernel's out-of-memory killer is the only thing standing between a memory spike and a hard failure. A modest swap file plus a low `swappiness` gives the kernel room to reclaim cleanly without thrashing. Size it to a fraction of RAM for general-purpose hosts; databases and latency-sensitive services often want little or none, set by their own runbooks.

```bash
# Create a 2 GiB swap file with safe permissions and persist it in fstab.
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Prefer reclaiming page cache over swapping application memory.
cat > /etc/sysctl.d/60-swap.conf <<'EOF'
vm.swappiness = 10
vm.vfs_cache_pressure = 50
EOF
sysctl --system
```

### Raise System Limits for Network Services

A default `nofile` limit of 1024 open files is fine for a login shell and disastrous for a busy reverse proxy or database. Raise the limits in a way that applies to both interactive sessions and `systemd` units.

```bash
# PAM-based limits for interactive and SSH sessions.
cat > /etc/security/limits.d/90-nofile.conf <<'EOF'
*    soft  nofile  65535
*    hard  nofile  65535
root soft  nofile  65535
root hard  nofile  65535
EOF

# systemd services do not read limits.conf; set the default for units too.
mkdir -p /etc/systemd/system.conf.d
cat > /etc/systemd/system.conf.d/limits.conf <<'EOF'
[Manager]
DefaultLimitNOFILE=65535
EOF
systemctl daemon-reexec
```

### Apply Sensible Kernel Network Tuning

A small set of `sysctl` values closes off spoofing and reverse-path holes and lets the network stack absorb bursts. These are conservative defaults appropriate for a public-facing host.

```bash
# Baseline network hardening and capacity tuning.
cat > /etc/sysctl.d/60-network.conf <<'EOF'
# Reverse-path filtering to drop spoofed source addresses.
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# Ignore ICMP redirects and source-routed packets.
net.ipv4.conf.all.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv4.conf.all.accept_source_route = 0

# Enable SYN cookies and a larger backlog for connection bursts.
net.ipv4.tcp_syncookies = 1
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 4096
EOF
sysctl --system
```

## Phase Six: Make the Host Observable

A server you cannot see is a server you cannot operate. The minimum viable observability for a Linux host is a metrics exporter scraped by Prometheus and a path for logs to leave the box. Both should be installed before the host carries production traffic, not after the first incident.

### Install node_exporter for Metrics

`node_exporter` exposes CPU, memory, disk, filesystem, and network metrics on a single HTTP endpoint. Run it as an unprivileged system user, bound to the address your Prometheus server can reach, and never expose it to the public internet.

```bash
# Create a locked-down service account for the exporter.
useradd --system --no-create-home --shell /usr/sbin/nologin node_exporter

# Fetch and install the binary. Pin a known version for reproducibility.
NODE_EXPORTER_VERSION="1.8.2"
cd /tmp
curl -fsSLO "https://github.com/prometheus/node_exporter/releases/download/v${NODE_EXPORTER_VERSION}/node_exporter-${NODE_EXPORTER_VERSION}.linux-amd64.tar.gz"
tar xzf "node_exporter-${NODE_EXPORTER_VERSION}.linux-amd64.tar.gz"
install -o root -g root -m 0755 \
    "node_exporter-${NODE_EXPORTER_VERSION}.linux-amd64/node_exporter" \
    /usr/local/bin/node_exporter
```

Define a `systemd` unit that binds to the private interface only:

```bash
# Bind to the private/management IP so the exporter is never publicly reachable.
cat > /etc/systemd/system/node_exporter.service <<'EOF'
[Unit]
Description=Prometheus Node Exporter
After=network-online.target
Wants=network-online.target

[Service]
User=node_exporter
Group=node_exporter
ExecStart=/usr/local/bin/node_exporter \
    --web.listen-address=10.0.0.5:9100 \
    --collector.systemd \
    --collector.processes
Restart=on-failure
RestartSec=5
# Hardening: this service needs almost no privileges.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now node_exporter
curl -s http://10.0.0.5:9100/metrics | head -n 5
```

Remember that the nftables ruleset above did not open `9100`. That is correct: the exporter should be reachable only over the private network, so add a source-scoped rule for the Prometheus host rather than opening the port to the world.

```bash
# Allow only the Prometheus server to scrape the exporter over the private net.
nft add rule inet filter input ip saddr 10.0.0.20 tcp dport 9100 accept
```

### Ship Logs Off the Box

Logs that live only on the host disappear when the host does. The lightest-weight approach that pairs well with a Loki backend is Grafana's `promtail` or its successor agent; the principle is the same regardless of collector. Point it at the journal and forward to a central endpoint.

```yaml
# /etc/promtail/config.yml -- forward the systemd journal to a Loki endpoint.
server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /var/lib/promtail/positions.yaml

clients:
  - url: https://loki.support.tools/loki/api/v1/push

scrape_configs:
  - job_name: journal
    journal:
      max_age: 12h
      labels:
        job: systemd-journal
        host: web-01
    relabel_configs:
      - source_labels: ["__journal__systemd_unit"]
        target_label: unit
```

The collector itself runs as another hardened `systemd` unit. The important architectural point is that logs leave the box continuously, so a compromised or destroyed host still leaves an audit trail on a system the attacker does not control.

## Phase Seven: Terminate TLS Correctly

Any host that answers HTTPS needs certificates that renew themselves. For public endpoints, `certbot` or `acme.sh` against Let's Encrypt is the default; for internal services, an internal ACME-capable CA fills the same role. The non-negotiable requirement is automated renewal, because a certificate that expires at 2 a.m. on a Sunday is the most predictable outage in computing.

```bash
# Install certbot and request a certificate, letting it manage nginx config.
apt-get install -y certbot python3-certbot-nginx
certbot --nginx \
    -d blog.support.tools \
    --non-interactive --agree-tos \
    -m ops@support.tools \
    --redirect

# certbot installs a systemd timer for renewal. Confirm it is scheduled,
# then prove that renewal actually works with a dry run.
systemctl list-timers 'certbot*' --no-pager
certbot renew --dry-run
```

If TLS is terminated upstream at a CDN or load balancer (the same Cloudflare-style edge many small sites adopt), the origin host may only need an origin certificate or even plain HTTP on a private network. Decide where termination happens once, document it, and make sure exactly one component owns renewal so two systems do not fight over the same certificate.

## Phase Eight: Back Up Before You Need To

A host is not in production until its data has been backed up and a restore has been tested. The most common backup mistake is having backups nobody has ever restored from. `restic` is a strong default: it is a single binary, encrypts client-side, deduplicates, and targets object storage or SFTP.

```bash
# Install restic and stage repository credentials outside the shell history.
apt-get install -y restic

# Store the repository location and password in a root-only environment file.
install -d -m 0700 /etc/restic
cat > /etc/restic/env <<'EOF'
export RESTIC_REPOSITORY="s3:https://s3.us-east-1.amazonaws.com/support-tools-backups/web-01"
export RESTIC_PASSWORD="replace-with-a-long-random-passphrase"
export AWS_ACCESS_KEY_ID="AKIAEXAMPLEDONOTUSE"
export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMIexampleKEYdoNOTuse"
EOF
chmod 0600 /etc/restic/env

# Initialize the repository once.
set -a; . /etc/restic/env; set +a
restic snapshots >/dev/null 2>&1 || restic init
```

Drive backups from a `systemd` timer rather than `cron` so failures surface in the journal and integrate with the metrics you already collect:

```bash
# A backup service plus a daily timer, with pruning baked in.
cat > /etc/systemd/system/restic-backup.service <<'EOF'
[Unit]
Description=restic backup of critical paths
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/restic/env
ExecStart=/usr/bin/restic backup /etc /home /var/www --tag scheduled
ExecStartPost=/usr/bin/restic forget --prune \
    --keep-daily 7 --keep-weekly 4 --keep-monthly 6
EOF

cat > /etc/systemd/system/restic-backup.timer <<'EOF'
[Unit]
Description=Run restic backup daily

[Timer]
OnCalendar=*-*-* 02:30:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now restic-backup.timer
```

Then, on a schedule that is enforced and not aspirational, restore a snapshot into a scratch directory and verify the contents. A backup you have never restored is a hypothesis, not a backup.

```bash
# Periodic restore drill: restore the latest snapshot to a temp dir and check it.
set -a; . /etc/restic/env; set +a
restic restore latest --target /tmp/restore-test --include /etc/hostname
test -s /tmp/restore-test/etc/hostname && echo "restore OK" && rm -rf /tmp/restore-test
```

## Phase Nine: Make the Whole Thing Reproducible

Everything above was written as imperative shell so each decision is legible. In production, none of it should be run by hand twice. The two complementary tools for reproducibility are **cloud-init** for first-boot bootstrap and **Ansible** for ongoing configuration management. cloud-init runs once when the instance is created and gets the host into a known state; Ansible converges that state continuously and lets you change forty hosts at once.

### Bootstrap With cloud-init

cloud-init reads user data at first boot. A minimal bootstrap creates the admin user, installs the SSH key, disables password auth, and hands off to a configuration management run. Keeping the first-boot payload small avoids the trap of duplicating your entire Ansible logic in YAML.

```yaml
#cloud-config
# First-boot bootstrap: create the admin user and lock down SSH, then let
# Ansible (pulled in the runcmd below) do the heavy lifting.
users:
  - name: deploy
    groups: [sudo]
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ssh_authorized_keys:
      - "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH8m1k0p2Qe9bXvN3rT6sUaWcZ7yL4dF1gH2jK3lM4n deploy@workstation"

# Disable SSH password auth at the source so the host is never exposed.
ssh_pwauth: false

package_update: true
package_upgrade: true
packages:
  - git
  - python3
  - ansible

runcmd:
  - ["git", "clone", "https://git.support.tools/infra/server-baseline.git", "/opt/baseline"]
  - ["ansible-pull", "-U", "https://git.support.tools/infra/server-baseline.git", "-d", "/opt/baseline", "site.yml"]
```

### Converge With Ansible

The Ansible play encodes the same checklist declaratively. The fragment below shows the structure: each phase from this guide becomes a task or a role, and a single `ansible-playbook` run brings any number of hosts to the identical state. The value is not the first run; it is the hundredth, when you add a new sysctl value and one command rolls it out everywhere.

```yaml
---
# site.yml -- the fresh-server checklist as idempotent Ansible tasks.
- name: Baseline production host
  hosts: all
  become: true
  vars:
    admin_user: deploy
    allowed_tcp_ports: [22, 80, 443]
  tasks:
    - name: Ensure admin user exists with sudo
      ansible.builtin.user:
        name: "{{ admin_user }}"
        groups: sudo
        append: true
        shell: /bin/bash

    - name: Install hardened SSH drop-in
      ansible.builtin.copy:
        dest: /etc/ssh/sshd_config.d/10-hardening.conf
        mode: "0644"
        content: |
          PermitRootLogin no
          PasswordAuthentication no
          PubkeyAuthentication yes
          AllowUsers {{ admin_user }}
      notify: reload ssh

    - name: Install required baseline packages
      ansible.builtin.apt:
        name:
          - nftables
          - unattended-upgrades
          - fail2ban
          - restic
        state: present
        update_cache: true

    - name: Render nftables ruleset from template
      ansible.builtin.template:
        src: nftables.conf.j2
        dest: /etc/nftables.conf
        mode: "0644"
        validate: "nft -c -f %s"
      notify: reload nftables

  handlers:
    - name: reload ssh
      ansible.builtin.service:
        name: ssh
        state: reloaded

    - name: reload nftables
      ansible.builtin.service:
        name: nftables
        state: restarted
```

Note the `validate` clause on the nftables task: Ansible runs `nft -c -f` against the rendered file before installing it, so a templating mistake fails the play instead of locking you out. That same defensive instinct, validate before apply, is what separates a checklist that is safe to automate from one that is merely convenient.

## Verifying the Finished Host

Before declaring the server production-ready, run a final pass confirming each control is actually live. Automate this as a smoke test so every future host is graded against the same bar.

```bash
# A quick post-provision audit. Each line should report the hardened state.
echo "== SSH password auth (expect: no) ==";       sshd -T | grep -i passwordauthentication
echo "== Firewall default policy (expect: drop) =="; nft list chain inet filter input | grep policy
echo "== Unattended upgrades timer ==";             systemctl is-enabled apt-daily-upgrade.timer
echo "== fail2ban sshd jail ==";                    fail2ban-client status sshd | grep "Currently banned"
echo "== Time sync (expect: yes) ==";               timedatectl show -p NTPSynchronized --value
echo "== Swap present ==";                           swapon --show
echo "== node_exporter listening ==";               systemctl is-active node_exporter
echo "== Backup timer scheduled ==";                systemctl is-enabled restic-backup.timer
echo "== TLS renewal timer ==";                      systemctl list-timers 'certbot*' --no-pager | grep certbot
```

If any line reports the wrong state, the host is not done. Treat a failing audit line exactly like a failing test: fix the cause, not the symptom, and fold the fix back into the Ansible role so the next host inherits it.

## Conclusion

Provisioning a fresh server well is less about any single command and more about treating the host as a disposable, reproducible artifact rather than a hand-tuned pet. The personal "I rebuilt my blog's box" story becomes a production discipline the moment you can rebuild the box from nothing, identically, on demand.

Key takeaways:

- **Question the premise first.** For stateless workloads, a container on Kubernetes or a managed platform usually beats a hand-maintained VM. Build a host only when you genuinely need a durable, individual endpoint.
- **Secure the way in before changing the way in.** Create an admin user, install keys, harden SSH with a drop-in, and always validate with `sshd -t` and a second open session before reloading.
- **Default-deny the network.** Use nftables with an explicit allowlist, scope private services like `node_exporter` to the management network, and never open a port you do not serve.
- **Automate patching and brute-force defense.** `unattended-upgrades` and `fail2ban` are cheap, and both should be configured before the host takes traffic.
- **Get the unglamorous foundations right.** Time sync, deliberate swap, raised file limits, and sane sysctl values prevent the outages that are hardest to diagnose later.
- **Make the host observable and recoverable from day one.** Ship metrics with `node_exporter`, forward logs off the box, automate TLS renewal, and back up with `restic`, then prove a restore actually works.
- **Encode the entire checklist as code.** cloud-init bootstraps the first boot; Ansible converges every host continuously. Validate generated config before applying it, and grade every new host with the same smoke test.

The reward for doing this once, properly, is that the next forty servers cost almost nothing, and the one that inevitably catches fire can be replaced before anyone notices.
