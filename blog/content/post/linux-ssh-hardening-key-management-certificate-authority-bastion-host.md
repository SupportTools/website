---
title: "Linux SSH Hardening: Key Management, Certificate Authority, and Bastion Host Configuration"
date: 2031-09-11T00:00:00-05:00
draft: false
tags: ["Linux", "SSH", "Security", "Hardening", "PKI", "Bastion Host", "Infrastructure"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive SSH hardening guide covering key management best practices, building an internal SSH Certificate Authority, bastion host architecture, and audit logging for enterprise environments."
more_link: "yes"
url: "/linux-ssh-hardening-key-management-certificate-authority-bastion-host/"
---

SSH is the most critical administrative protocol in Linux infrastructure. A poorly secured SSH configuration is also one of the most common attack surfaces — brute-forced passwords, stolen private keys, weak algorithms, and overly permissive authorized_keys files account for a significant portion of Linux server compromises. Yet most organizations have not implemented the most effective defense: SSH Certificate Authorities, which eliminate long-lived key distribution entirely.

This guide covers the full spectrum of SSH hardening: server configuration, key management at scale, building an SSH CA, bastion host architecture with ProxyJump, and audit logging for compliance.

<!--more-->

# Linux SSH Hardening: Production Configuration

## Server Configuration Hardening

The OpenSSH server configuration lives in `/etc/ssh/sshd_config`. A hardened production configuration eliminates weak algorithms, restricts authentication methods, and limits the attack surface.

### Complete Hardened sshd_config

```bash
# /etc/ssh/sshd_config
# Generated for production server hardening
# Last updated: review quarterly

#######################
# Network and Protocol
#######################
Port 22
AddressFamily inet
ListenAddress 0.0.0.0

# Protocol version (SSH2 only; SSH1 is deprecated and vulnerable)
Protocol 2

#######################
# Authentication
#######################
# Disable password authentication - keys or certificates only
PasswordAuthentication no
PermitEmptyPasswords no
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no

# Disable root login entirely
PermitRootLogin no

# Allow only specific groups (defense in depth)
AllowGroups ssh-users ssh-admins

# Maximum authentication attempts before disconnect
MaxAuthTries 3

# Disconnect unauthenticated sessions quickly
LoginGraceTime 30s

# Disable PAM for authentication (use only for account/session management)
UsePAM yes
# UsePAM yes is required for account checking (expiry, lockout)

# Disable hostbased authentication
HostbasedAuthentication no
IgnoreUserKnownHosts yes
IgnoreRhosts yes

#######################
# Cryptographic Algorithms
#######################
# Key exchange algorithms (only modern, secure algorithms)
# ECDH > DH > prefer Curve25519 and P-256
KexAlgorithms curve25519-sha256,curve25519-sha256@libssh.org,ecdh-sha2-nistp256,ecdh-sha2-nistp384,diffie-hellman-group16-sha512,diffie-hellman-group18-sha512

# Host key algorithms (ed25519 first, then ECDSA, no RSA below 4096)
HostKeyAlgorithms ssh-ed25519,ssh-ed25519-cert-v01@openssh.com,sk-ssh-ed25519@openssh.com,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384

# Ciphers (AES-GCM and ChaCha20 only)
Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com,aes256-ctr,aes192-ctr,aes128-ctr

# MACs (only ETM - Encrypt-then-MAC)
MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com,umac-128-etm@openssh.com

#######################
# Session and Features
#######################
# Disable X11 forwarding (rarely needed in production)
X11Forwarding no

# Disable agent forwarding on servers (enable on bastion only)
AllowAgentForwarding no

# Disable TCP forwarding unless explicitly needed
AllowTcpForwarding no
GatewayPorts no

# Disable compression (small security risk, negligible benefit on modern networks)
Compression no

# Keepalive to detect stale connections
ClientAliveInterval 300
ClientAliveCountMax 2
TCPKeepAlive no  # Use SSH-level keepalive, not TCP

# Limit maximum sessions per connection
MaxSessions 4

# Limit concurrent unauthenticated connections
MaxStartups 10:30:60

#######################
# Logging
#######################
SyslogFacility AUTH
LogLevel VERBOSE  # Logs accepted/rejected keys and source IPs

# Print last login information
PrintLastLog yes
PrintMotd yes

#######################
# SFTP Subsystem
#######################
# Chroot SFTP users to their home directory
Subsystem sftp internal-sftp

Match Group sftp-only
    ChrootDirectory /data/sftp/%u
    ForceCommand internal-sftp -l VERBOSE
    AllowTcpForwarding no
    X11Forwarding no
    AllowAgentForwarding no
```

### Generating Strong Host Keys

```bash
# Remove weak RSA host key if present
rm /etc/ssh/ssh_host_rsa_key*
rm /etc/ssh/ssh_host_dsa_key*
rm /etc/ssh/ssh_host_ecdsa_key*

# Generate ed25519 host key (preferred)
ssh-keygen -t ed25519 -f /etc/ssh/ssh_host_ed25519_key -N "" -C "$(hostname)-$(date +%Y%m%d)"

# Set correct permissions
chmod 600 /etc/ssh/ssh_host_ed25519_key
chmod 644 /etc/ssh/ssh_host_ed25519_key.pub

# If ECDSA is required for compatibility
ssh-keygen -t ecdsa -b 521 -f /etc/ssh/ssh_host_ecdsa_key -N ""

# In sshd_config, list only these host keys:
echo "HostKey /etc/ssh/ssh_host_ed25519_key" >> /etc/ssh/sshd_config

# Validate config before restart
sshd -t

# Restart
systemctl restart sshd
```

### DH Parameter Regeneration

```bash
# Regenerate DH moduli to remove weak parameters
# This removes all groups smaller than 3072 bits
awk '$5 >= 3071' /etc/ssh/moduli > /etc/ssh/moduli.safe
mv /etc/ssh/moduli.safe /etc/ssh/moduli

# Or generate fresh moduli (takes 30+ minutes)
ssh-keygen -G /tmp/moduli.candidates -b 4096
ssh-keygen -T /etc/ssh/moduli -f /tmp/moduli.candidates
```

## SSH Key Management at Scale

### Key Distribution Challenges

Ad-hoc `authorized_keys` management does not scale:
- When an employee leaves, their key may remain in hundreds of servers
- No expiration: keys granted years ago remain valid indefinitely
- Audit trail: it is often unclear who added which key and why
- Duplication: the same key may be in multiple users' home directories

### Using Ansible for Centralized Key Management

```yaml
# ansible/roles/ssh_keys/tasks/main.yml
---
- name: Ensure .ssh directory exists for each user
  file:
    path: "/home/{{ item.username }}/.ssh"
    state: directory
    owner: "{{ item.username }}"
    group: "{{ item.username }}"
    mode: "0700"
  loop: "{{ ssh_users }}"

- name: Deploy authorized keys from centralized list
  authorized_key:
    user: "{{ item.username }}"
    state: present
    key: "{{ item.public_key }}"
    key_options: "{{ item.options | default('') }}"
    comment: "{{ item.email }} - managed by Ansible"
    exclusive: true  # Remove keys not in this list
  loop: "{{ ssh_users }}"
  when: item.state | default('present') == 'present'

# ansible/group_vars/all/ssh_users.yml
ssh_users:
  - username: alice
    email: alice@example.com
    public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE... alice@example.com"
    state: present
  - username: bob
    email: bob@example.com
    public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB... bob@example.com"
    state: absent  # Revoked - will be removed from all servers
```

### Key Options for Fine-Grained Control

```bash
# /home/deploy/.ssh/authorized_keys

# Restrict key to specific command (deployment key)
command="/opt/scripts/deploy.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG... deploy@ci

# Restrict key to specific source IPs
from="10.0.1.5,10.0.1.6",no-pty ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH... monitoring@server

# Restrict to specific time window (using a wrapper script)
command="/opt/scripts/time-restricted-shell.sh",no-agent-forwarding ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ... contractor@temp
```

## SSH Certificate Authority

The most effective SSH security improvement for organizations with more than 10 servers is an SSH Certificate Authority. Instead of distributing user public keys to servers, you:

1. Maintain a CA key pair
2. Sign user public keys, creating certificates with embedded expiration dates
3. Configure servers to trust the CA's public key
4. Issue short-lived (8-24 hour) certificates that automatically expire

This eliminates key distribution entirely and provides automatic revocation via expiration.

### Setting Up the SSH CA

```bash
# Create a dedicated CA directory with strict permissions
mkdir -p /etc/ssh-ca/keys
chmod 700 /etc/ssh-ca /etc/ssh-ca/keys

# Generate the CA key pair for signing user certificates
# Store the private key in a HSM or Vault in production
ssh-keygen -t ed25519 -f /etc/ssh-ca/keys/user-ca \
  -C "SSH User CA - $(date +%Y%m%d)" \
  -N ""  # In production, use a strong passphrase or HSM

# Generate a separate CA for host certificates
ssh-keygen -t ed25519 -f /etc/ssh-ca/keys/host-ca \
  -C "SSH Host CA - $(date +%Y%m%d)" \
  -N ""

# Protect private keys
chmod 400 /etc/ssh-ca/keys/user-ca /etc/ssh-ca/keys/host-ca
chmod 444 /etc/ssh-ca/keys/user-ca.pub /etc/ssh-ca/keys/host-ca.pub
```

### Configuring Servers to Trust the CA

On every server, configure sshd to trust the user CA:

```bash
# Copy the CA public key to the server
scp /etc/ssh-ca/keys/user-ca.pub server:/etc/ssh/user-ca.pub

# In /etc/ssh/sshd_config, add:
echo "TrustedUserCAKeys /etc/ssh/user-ca.pub" >> /etc/ssh/sshd_config

# Optionally restrict which principals (usernames) a certificate can authenticate
# AuthorizedPrincipalsFile /etc/ssh/auth_principals/%u

systemctl reload sshd
```

### Issuing User Certificates

```bash
#!/bin/bash
# issue-cert.sh — Issue a short-lived user certificate

USERNAME="${1:?username required}"
PUBLIC_KEY_PATH="${2:?public key path required}"
VALID_HOURS="${3:-8}"  # Default 8-hour validity

# Validate inputs
if [ ! -f "$PUBLIC_KEY_PATH" ]; then
    echo "Error: public key file not found: $PUBLIC_KEY_PATH" >&2
    exit 1
fi

CERT_PATH="${PUBLIC_KEY_PATH%.pub}-cert.pub"
SERIAL=$(date +%s)

# Issue certificate
ssh-keygen \
    -s /etc/ssh-ca/keys/user-ca \
    -I "${USERNAME}@$(hostname)-${SERIAL}" \
    -n "$USERNAME" \
    -V "+${VALID_HOURS}h" \
    -z "$SERIAL" \
    -O permit-pty \
    -O permit-user-rc \
    "$PUBLIC_KEY_PATH"

echo "Certificate issued: $CERT_PATH"
echo "Valid for: ${VALID_HOURS} hours"
echo "Serial: $SERIAL"

# Log the issuance
logger -t ssh-ca "Issued certificate for $USERNAME, serial $SERIAL, valid ${VALID_HOURS}h, key $PUBLIC_KEY_PATH"
```

### Automated Certificate Issuance with Vault

HashiCorp Vault's SSH secrets engine automates certificate issuance:

```bash
# Enable SSH secrets engine
vault secrets enable ssh

# Configure Vault as SSH CA
vault write ssh/config/ca \
    generate_signing_key=true

# Create a role for developers
vault write ssh/roles/developer \
    key_type=ca \
    allow_user_certificates=true \
    allowed_users="{{identity.entity.aliases.auth_ldap_..name}}" \
    ttl=8h \
    max_ttl=24h \
    allowed_extensions="permit-pty,permit-user-rc" \
    default_extensions='{"permit-pty":"","permit-user-rc":""}' \
    allow_user_key_ids=false \
    key_id_format="{{token_display_name}}-{{serial_number}}"

# Users get a certificate with:
vault ssh -role=developer -mode=ca \
    -valid-principals=alice \
    -mount-point=ssh \
    alice@server.example.com
```

### Configuring Host Certificates

Host certificates let clients verify server identity without `~/.ssh/known_hosts` management:

```bash
# Sign the server's host key
ssh-keygen \
    -s /etc/ssh-ca/keys/host-ca \
    -I "$(hostname).example.com" \
    -h \
    -n "$(hostname),$(hostname).example.com,$(hostname -I | tr ' ' ',')" \
    -V "+52w" \
    /etc/ssh/ssh_host_ed25519_key.pub

# In sshd_config on the server:
# HostCertificate /etc/ssh/ssh_host_ed25519_key-cert.pub

# On clients, add to ~/.ssh/known_hosts or /etc/ssh/ssh_known_hosts:
# @cert-authority *.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... # Host CA
```

```bash
# Clients: configure to trust the host CA
cat >> ~/.ssh/known_hosts << 'EOF'
@cert-authority *.example.com ssh-ed25519 <host-ca-public-key-here>
EOF

# Or globally:
cat >> /etc/ssh/ssh_known_hosts << 'EOF'
@cert-authority *.internal.example.com ssh-ed25519 <host-ca-public-key-here>
EOF
```

## Bastion Host Architecture

A bastion (jump) host is the single, hardened entry point to your private network. All SSH sessions pass through it, providing a choke point for access control and audit logging.

### Bastion Host Configuration

The bastion has a more permissive sshd_config than backend servers, but with aggressive audit logging:

```bash
# /etc/ssh/sshd_config on the BASTION HOST
Port 22

# On bastion: allow agent forwarding (needed for jump connections)
AllowAgentForwarding yes

# Allow TCP forwarding for ProxyJump
AllowTcpForwarding yes

# Enable verbose logging for complete audit trail
LogLevel VERBOSE

# Use syslog with a dedicated facility for centralized log shipping
SyslogFacility AUTHPRIV

# Force a banner to satisfy compliance requirements
Banner /etc/ssh/banner.txt

# Restrict to specific source networks via AllowUsers + from=""
# Or use firewall rules (preferred)

# Rest of hardened config same as backend servers
PasswordAuthentication no
PermitRootLogin no
MaxAuthTries 3
KexAlgorithms curve25519-sha256,ecdh-sha2-nistp256
Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com
MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com
```

### Client ProxyJump Configuration

```bash
# ~/.ssh/config
# Global defaults
Host *
    ServerAliveInterval 60
    ServerAliveCountMax 3
    HashKnownHosts yes
    IdentitiesOnly yes
    AddKeysToAgent yes
    # Use certificate if available, fall back to key
    CertificateFile ~/.ssh/id_ed25519-cert.pub
    IdentityFile ~/.ssh/id_ed25519

# Bastion host
Host bastion.example.com
    User admin
    IdentityFile ~/.ssh/id_ed25519
    Port 22
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 10m

# All internal servers jump through bastion
Host *.internal.example.com
    ProxyJump bastion.example.com
    User admin
    IdentityFile ~/.ssh/id_ed25519

# Production database servers - require explicit confirmation
Host db-*.prod.example.com
    ProxyJump bastion.example.com
    User dba
    IdentityFile ~/.ssh/id_ed25519-prod
    # Comment: requires the prod SSH certificate
```

### Connection Multiplexing

ControlMaster dramatically reduces latency for multiple connections through the bastion:

```bash
# First connection establishes the master
ssh bastion.example.com

# Subsequent connections reuse the master socket (instant connection)
ssh bastion.example.com "hostname"  # No new TLS handshake

# Check active master connections
ls -la ~/.ssh/cm-*

# Close master manually
ssh -O exit bastion.example.com
```

### Forced Command for Bastion Logging

To log all commands run through the bastion, use a wrapper shell:

```bash
# /opt/ssh-bastion/wrapper.sh
#!/bin/bash

# Log every session
SESSION_LOG="/var/log/ssh-sessions/$(date +%Y%m%d)/${USER}_$(date +%H%M%S)_$$.log"
mkdir -p "$(dirname "$SESSION_LOG")"

# Log session metadata
echo "=== SSH Session ===" > "$SESSION_LOG"
echo "User: $USER" >> "$SESSION_LOG"
echo "Source: $SSH_CLIENT" >> "$SESSION_LOG"
echo "Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$SESSION_LOG"
echo "====================" >> "$SESSION_LOG"

# Log all commands using script
exec /usr/bin/script -q -f -c "/bin/bash -i" "$SESSION_LOG"
```

```bash
# In sshd_config on bastion:
ForceCommand /opt/ssh-bastion/wrapper.sh
```

### Bastion with MFA Using PAM

For environments requiring MFA on the bastion:

```bash
# Install Google Authenticator PAM module
apt-get install libpam-google-authenticator

# Configure PAM for sshd
# /etc/pam.d/sshd
auth required pam_google_authenticator.so nullok

# In sshd_config on bastion:
ChallengeResponseAuthentication yes
AuthenticationMethods publickey,keyboard-interactive
# Requires BOTH a valid SSH key AND TOTP code
```

## Certificate Revocation

SSH certificates expire automatically, which is the primary revocation mechanism. For emergency revocation before expiration, OpenSSH 7.0+ supports revocation lists:

```bash
# Create a key revocation list (KRL)
ssh-keygen -k -f /etc/ssh/revoked_keys

# Add a compromised key to the KRL
ssh-keygen -k -u -f /etc/ssh/revoked_keys /tmp/compromised_key.pub

# Add a compromised certificate serial number
ssh-keygen -k -u -f /etc/ssh/revoked_keys -z 1234567890

# In sshd_config:
echo "RevokedKeys /etc/ssh/revoked_keys" >> /etc/ssh/sshd_config
systemctl reload sshd

# Distribute the KRL to all servers via Ansible
ansible all -m copy -a "src=/etc/ssh/revoked_keys dest=/etc/ssh/revoked_keys mode=0644"
ansible all -m service -a "name=sshd state=reloaded"
```

## Audit Logging and Monitoring

### Centralized SSH Log Shipping

```yaml
# fluent-bit: ship SSH auth logs to centralized SIEM
[INPUT]
    Name   tail
    Path   /var/log/auth.log
    Tag    ssh.auth
    Parser sshd

[FILTER]
    Name   grep
    Match  ssh.auth
    Regex  log sshd

[OUTPUT]
    Name   opensearch
    Match  ssh.auth
    Host   opensearch.logging.svc.cluster.local
    Port   9200
    Index  ssh-audit-%Y.%m.%d
    tls    On
```

### Alerting on Suspicious SSH Activity

```bash
#!/bin/bash
# detect-ssh-anomalies.sh — run from cron every 5 minutes

THRESHOLD=10
LOG=/var/log/auth.log
ALERT_EMAIL="security@example.com"

# Failed login attempts by source IP
awk '/sshd.*Failed password/ {print $NF}' "$LOG" | \
    sort | uniq -c | sort -rn | \
    awk -v threshold="$THRESHOLD" '$1 >= threshold {print $2, $1, "failures"}' | \
    while read ip count rest; do
        echo "ALERT: $ip had $count SSH login failures in last 5 minutes" | \
            mail -s "SSH Brute Force Alert: $ip" "$ALERT_EMAIL"
        # Also add to fail2ban
        fail2ban-client set sshd banip "$ip"
    done

# Alert on root login attempts (should never succeed with PermitRootLogin no)
grep "$(date '+%b %e %H:%M' -d '5 minutes ago')" "$LOG" | \
    grep "sshd.*root" | \
    while read -r line; do
        echo "ALERT: Root SSH attempt: $line" | \
            mail -s "Root SSH Attempt" "$ALERT_EMAIL"
    done
```

### Prometheus Alert for SSH Metrics

```yaml
# Prometheus rules for SSH monitoring
groups:
  - name: ssh_security
    rules:
      - alert: HighSSHAuthFailureRate
        expr: |
          rate(node_auth_failures_total{service="sshd"}[5m]) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High SSH authentication failure rate on {{ $labels.instance }}"
          description: "SSH failure rate is {{ $value | humanize }} failures/sec"

      - alert: SSHAuthFailureSpike
        expr: |
          rate(node_auth_failures_total{service="sshd"}[1m]) > 2
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "SSH brute force attack suspected on {{ $labels.instance }}"
```

## SSH Audit with ssh-audit

Run regular SSH configuration audits:

```bash
# Install ssh-audit
pip3 install ssh-audit

# Audit server configuration
ssh-audit hostname.example.com

# Audit client configuration
ssh-audit -c

# Generate a policy for consistent baseline
ssh-audit --make-policy=company-baseline.txt hostname.example.com
ssh-audit --policy=company-baseline.txt next-server.example.com

# Scan a whole network segment
for host in 10.0.1.{1..254}; do
    ssh-audit "$host" 2>/dev/null | grep -E "(fail|warn)" && echo "Issues on $host"
done
```

## Summary

A complete SSH security posture requires layering multiple controls:

1. **Algorithm hardening**: Remove weak algorithms, use only modern ECDH, ed25519/ECDSA host keys, AES-GCM and ChaCha20 ciphers
2. **Authentication**: Disable passwords entirely, use SSH keys with a transition path to certificates
3. **SSH CA**: Issue short-lived certificates instead of distributing individual keys. This is the single most impactful control for teams with more than 10 servers
4. **Bastion host**: Funnel all SSH access through a single hardened host with forced-command logging
5. **Centralized key management**: Use Ansible or a dedicated tool to ensure authorized_keys files match a canonical source of truth
6. **Monitoring**: Ship auth logs to a SIEM, alert on brute force patterns, audit SSH configuration regularly

The combination of certificate-based authentication with 8-hour TTLs and a bastion with forced-command logging makes it virtually impossible for attackers to leverage stolen credentials — the certificates expire before they can be used, and every session is logged.
