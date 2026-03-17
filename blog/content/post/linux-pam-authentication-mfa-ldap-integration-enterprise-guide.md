---
title: "Linux PAM Authentication: Multi-Factor Auth and LDAP Integration for Enterprise Systems"
date: 2030-10-07T00:00:00-05:00
draft: false
tags: ["Linux", "PAM", "Authentication", "LDAP", "MFA", "Security", "Active Directory"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise PAM guide covering PAM module configuration, LDAP/AD authentication with pam_ldap, Google Authenticator TOTP with pam_google_authenticator, sudo PAM integration, SSH PAM configuration, and auditing authentication events."
more_link: "yes"
url: "/linux-pam-authentication-mfa-ldap-integration-enterprise-guide/"
---

PAM (Pluggable Authentication Modules) is the authentication framework that sits between Linux system services and the actual credential verification logic. Every login on a Linux system — SSH, sudo, console, GUI — flows through PAM. Understanding PAM's configuration model enables centralized multi-factor authentication enforcement, LDAP integration, and comprehensive audit logging across your entire fleet from a small set of configuration files.

<!--more-->

## PAM Architecture

PAM separates the "what needs to authenticate" (applications) from "how authentication works" (modules). Applications call `libpam`, which reads per-service configuration files and invokes the appropriate modules in sequence.

### Module Types

| Type | Purpose |
|---|---|
| `auth` | Verify identity (passwords, tokens, certificates) |
| `account` | Check account validity (expired, locked, time restrictions) |
| `session` | Setup/teardown session resources (home dir, env vars, audit) |
| `password` | Handle password changes |

### Control Flags

| Flag | Behavior |
|---|---|
| `required` | Must succeed; failure continues evaluation but returns failure |
| `requisite` | Must succeed; failure immediately returns failure |
| `sufficient` | Success with no prior `required` failure is enough; skip rest |
| `optional` | Result ignored unless no other module sets a definitive result |
| `include` | Include another PAM config file |
| `substack` | Like include, but failures don't propagate up |

### Configuration File Locations

```bash
# Per-service configurations (preferred)
ls /etc/pam.d/

# Common services:
# /etc/pam.d/sshd         — SSH daemon
# /etc/pam.d/sudo         — sudo
# /etc/pam.d/login        — console login
# /etc/pam.d/common-auth  — shared auth stack (Debian/Ubuntu)
# /etc/pam.d/system-auth  — shared auth stack (RHEL/AlmaLinux)

# Single legacy file (rarely used in modern distributions)
# /etc/pam.conf
```

---

## LDAP/Active Directory Authentication with pam_ldap

Integrating Linux systems with Active Directory or OpenLDAP is a foundational enterprise requirement. The modern approach uses SSSD (System Security Services Daemon) with its PAM module, which provides caching and offline authentication.

### Installing SSSD

```bash
# Ubuntu/Debian
sudo apt-get install -y \
  sssd \
  sssd-ldap \
  sssd-tools \
  libpam-sss \
  libnss-sss \
  adcli \
  realmd \
  oddjob \
  oddjob-mkhomedir \
  packagekit \
  samba-common-bin

# RHEL/AlmaLinux
sudo dnf install -y \
  sssd \
  sssd-ldap \
  sssd-tools \
  oddjob \
  oddjob-mkhomedir \
  adcli \
  realmd \
  krb5-workstation \
  samba-common-tools
```

### Joining an Active Directory Domain

```bash
# Verify DNS resolves the domain
host example.com
nslookup -type=SRV _ldap._tcp.example.com

# Join the domain (requires domain admin credentials)
sudo realm join \
  --user=domain-admin \
  --computer-ou="OU=Linux Servers,OU=Computers,DC=example,DC=com" \
  example.com

# Verify domain membership
realm list
id domain-user@example.com
```

### SSSD Configuration

```ini
# /etc/sssd/sssd.conf
[sssd]
domains = example.com
config_file_version = 2
services = nss, pam, sudo, ssh

[domain/example.com]
ad_domain = example.com
krb5_realm = EXAMPLE.COM
realmd_tags = manages-system joined-with-adcli
cache_credentials = True
id_provider = ad
krb5_store_password_if_offline = True
default_shell = /bin/bash
ldap_id_mapping = True
use_fully_qualified_names = False
fallback_homedir = /home/%u
access_provider = ad

# Group-based access control
ad_access_filter = (memberOf=CN=linux-users,OU=Groups,DC=example,DC=com)

# Sudo integration
sudo_provider = ad
ldap_sudo_search_base = OU=SUDOers,DC=example,DC=com

# SSH public key lookup from LDAP
ldap_user_ssh_public_key = sshPublicKey

# Performance tuning
ldap_network_timeout = 3
ldap_opt_timeout = 3
dns_discovery_domain = example.com

# Offline cache TTL
offline_credentials_expiration = 7  # days
```

```bash
sudo chmod 600 /etc/sssd/sssd.conf
sudo systemctl enable --now sssd
sudo systemctl restart sssd

# Test LDAP connectivity
sudo sssctl domain-status example.com
id testuser

# Clear cache if needed
sudo sssctl cache-remove -o
```

### PAM Configuration for SSSD

```bash
# Ubuntu: enable PAM modules
sudo pam-auth-update --enable mkhomedir
sudo pam-auth-update --enable sss

# RHEL: authselect manages PAM files
sudo authselect select sssd with-mkhomedir --force

# View the resulting common-auth on Ubuntu
cat /etc/pam.d/common-auth
```

The resulting common-auth stack:

```
# /etc/pam.d/common-auth
auth    [success=2 default=ignore]  pam_sss.so     use_first_pass
auth    [success=1 default=ignore]  pam_unix.so    nullok_secure try_first_pass
auth    requisite                   pam_deny.so
auth    required                    pam_permit.so
auth    optional                    pam_cap.so
```

---

## Multi-Factor Authentication with pam_google_authenticator

TOTP (Time-based One-Time Passwords) add a second factor to SSH and sudo authentication.

### Installation

```bash
# Ubuntu/Debian
sudo apt-get install -y libpam-google-authenticator

# RHEL/AlmaLinux
sudo dnf install -y google-authenticator
```

### Per-User Setup

Each user must initialize their TOTP secret:

```bash
# Run as the target user
google-authenticator

# Interactive prompts:
# Do you want authentication tokens to be time-based (y/n): y
# [QR code displayed for authenticator app scanning]
# Your new secret key is: JBSWY3DPEHPK3PXP
# Your verification code is: 123456
# Your emergency scratch codes are:
#   12345678  87654321  ...

# Non-interactive setup (for automation)
google-authenticator \
  --time-based \
  --disallow-reuse \
  --force \
  --rate-limit=3 \
  --rate-time=30 \
  --window-size=3 \
  --quiet \
  --google-authenticator-file=/home/${USER}/.google_authenticator

# Distribute the QR code or secret to the user's authenticator app
# The .google_authenticator file must be mode 400, owned by the user
chmod 400 ~/.google_authenticator
```

### Automating with Ansible

```yaml
# tasks/mfa-setup.yaml
- name: Install google-authenticator
  package:
    name: "{{ 'libpam-google-authenticator' if ansible_os_family == 'Debian' else 'google-authenticator' }}"
    state: present

- name: Initialize TOTP for managed users
  become: true
  become_user: "{{ item }}"
  command: >
    google-authenticator
    --time-based
    --disallow-reuse
    --force
    --rate-limit=3
    --rate-time=30
    --window-size=3
    --quiet
    --google-authenticator-file={{ item_home }}/.google_authenticator
  args:
    creates: "{{ item_home }}/.google_authenticator"
  loop: "{{ mfa_users }}"
```

---

## SSH PAM Configuration for MFA

The goal: require LDAP password AND TOTP for SSH, but not for certificate-based authentication.

### /etc/ssh/sshd_config

```
# PAM authentication
UsePAM yes

# Keyboard-interactive allows PAM to prompt for multiple factors
ChallengeResponseAuthentication yes
KbdInteractiveAuthentication yes

# Password auth (PAM will handle this)
PasswordAuthentication no

# Public key auth bypasses PAM challenge (desired for automation)
PubkeyAuthentication yes

# Allow specific groups via LDAP group membership
AllowGroups linux-users ssh-admins

# Require MFA for all users except those using public keys
AuthenticationMethods publickey,keyboard-interactive:pam publickey
```

### /etc/pam.d/sshd

```
# /etc/pam.d/sshd - SSH authentication stack

# Standard auth stack (LDAP via SSSD)
@include common-auth

# TOTP: required for password-based logins,
# skipped if pam_unix/pam_sss already succeeded via key
auth    required    pam_google_authenticator.so    nullok secret=${HOME}/.google_authenticator

# Account checks
@include common-account

# Session setup
@include common-session

# Home directory creation for new LDAP users
session optional    pam_mkhomedir.so skel=/etc/skel umask=0077

# Audit
session required    pam_loginuid.so
session optional    pam_systemd.so
```

### Testing MFA SSH

```bash
# Test as a user with MFA configured
ssh -o PreferredAuthentications=keyboard-interactive testuser@server.example.com

# Expected prompts:
# Password:             ← LDAP/AD password
# Verification code:    ← TOTP code from authenticator app
```

---

## Sudo PAM Integration

Sudo uses its own PAM service file, allowing different authentication requirements for privilege escalation:

```
# /etc/pam.d/sudo

# Require MFA for ALL sudo sessions (no exceptions)
auth    required    pam_google_authenticator.so    secret=${HOME}/.google_authenticator

# Standard auth (LDAP password)
@include common-auth

# Account checks
@include common-account

# Session setup
@include common-session-noninteractive
```

To require MFA for sudo but allow caching for 15 minutes:

```
# /etc/sudoers.d/mfa-policy
Defaults  timestamp_timeout=15
Defaults  !tty_tickets
Defaults  !lecture
```

### Sudo with LDAP Group-Based Access

```bash
# /etc/sudoers.d/ldap-groups

# Members of the AD group 'linux-admins' get full sudo
%linux-admins   ALL=(ALL:ALL) ALL

# Members of 'app-operators' can restart specific services
%app-operators  ALL=(root) NOPASSWD: /bin/systemctl restart nginx, \
                                     /bin/systemctl restart php-fpm, \
                                     /bin/systemctl status *

# Members of 'db-operators' can run PostgreSQL maintenance
%db-operators   ALL=(postgres) NOPASSWD: /usr/bin/psql, \
                                          /usr/bin/pg_dump, \
                                          /usr/bin/vacuumdb
```

---

## Advanced PAM Scenarios

### Restricting Access by Time and Source

```
# /etc/pam.d/sshd-restricted
# Allow access only on weekdays, 08:00–18:00 from internal networks

auth    required    pam_access.so
account required    pam_time.so

# /etc/security/access.conf
# Deny all except from internal networks
+ : ALL : 10.0.0.0/8
+ : ALL : 192.168.0.0/16
- : ALL : ALL

# /etc/security/time.conf
# Service:TTY:Users:Time
# sshd access only weekdays 08:00-18:00 for non-admin users
sshd;*;!linux-admins;Al0800-1800
```

### Account Lockout with pam_tally2 / pam_faillock

```
# RHEL 9+ uses pam_faillock; older systems use pam_tally2

# /etc/pam.d/common-auth (Ubuntu with pam_faillock)
auth    required       pam_faillock.so    preauth silent audit deny=5 unlock_time=900
auth    [success=1 default=ignore]  pam_sss.so     use_first_pass
auth    [success=1 default=ignore]  pam_unix.so    nullok_secure
auth    [default=die]   pam_faillock.so    authfail audit deny=5 unlock_time=900
auth    sufficient      pam_faillock.so    authsucc audit deny=5 unlock_time=900
auth    requisite       pam_deny.so
auth    required        pam_permit.so

# /etc/security/faillock.conf
deny = 5
fail_interval = 900
unlock_time = 900
audit
silent
```

```bash
# Check locked accounts
faillock --user testuser

# Manually unlock
faillock --user testuser --reset

# View all locked accounts
awk -F: '{print $1}' /etc/shadow | while read user; do
    faillock --user "$user" 2>/dev/null | grep -q "V" && echo "$user is locked"
done
```

---

## Auditing Authentication Events

### Enabling pam_audit

```
# /etc/pam.d/sshd — add audit session module
session required    pam_loginuid.so
session optional    pam_audit.so
```

### journald Authentication Logs

```bash
# View all authentication events
journalctl -u sshd -u sudo --since "today" | grep -E "(Accepted|Failed|sudo)"

# Failed SSH attempts by IP
journalctl -u sshd --since "24h ago" | \
  grep "Failed password" | \
  awk '{print $11}' | \
  sort | uniq -c | sort -rn | head -20

# All sudo commands executed today
journalctl -u sudo --since "today" | \
  grep "COMMAND" | \
  awk -F'COMMAND=' '{print $2}' | \
  sort | uniq -c | sort -rn
```

### auditd Integration

```bash
# /etc/audit/rules.d/pam-auth.rules

# Log all sudo usage
-w /usr/bin/sudo -p x -k sudo_usage

# Log PAM configuration changes
-w /etc/pam.d/ -p wa -k pam_config_change
-w /etc/security/ -p wa -k security_config_change

# Log SSH configuration changes
-w /etc/ssh/sshd_config -p wa -k sshd_config_change

# Log authentication failures
-a always,exit -F arch=b64 -S open -F dir=/etc/shadow -F success=0 -k shadow_access_fail

# Reload audit rules
sudo augenrules --load
sudo systemctl restart auditd
```

```bash
# Query audit events
ausearch -k sudo_usage --start today | aureport -i

# Authentication failure report
aureport --auth --failed --start today

# Generate user activity report
aureport --login --start "last week" | head -30
```

### Centralized Auth Logging with rsyslog

```
# /etc/rsyslog.d/50-auth-forward.conf
:msg,contains,"PAM" @@siem.example.com:514
:msg,contains,"authentication failure" @@siem.example.com:514
:msg,contains,"Accepted" @@siem.example.com:514
:msg,contains,"Failed" @@siem.example.com:514
auth.*    @@siem.example.com:514
authpriv.* @@siem.example.com:514
```

---

## Troubleshooting PAM

```bash
# Test PAM configuration without affecting production services
# pam_tester is provided by libpam-runtime
pamtester sshd testuser authenticate

# Enable PAM debugging
# Add to the specific PAM service file being tested:
# auth sufficient pam_debug.so
# CAUTION: pam_debug logs credentials to syslog — only use in isolated test environments

# Monitor PAM calls in real time
# CAUTION: Contains sensitive data
sudo strace -e trace=open,read,write -p $(pgrep sshd) 2>&1 | \
  grep pam

# Check NSS/SSSD resolution
getent passwd testuser
getent group linux-admins
id testuser

# Test LDAP connectivity from SSSD perspective
sudo sssctl user-checks testuser
sudo sssctl domain-status example.com

# View SSSD logs
sudo journalctl -u sssd --since "1h ago"
sudo cat /var/log/sssd/sssd_example.com.log | tail -100
```

### Common Issues

```bash
# Issue: "Permission denied" despite correct credentials
# Check: group-based access filter
sudo sssctl user-checks testuser service=ssh action=auth

# Issue: Slow logins (30+ seconds)
# Check: DNS reverse lookup
grep "UseDNS" /etc/ssh/sshd_config
# Fix: UseDNS no

# Issue: MFA codes rejected
# Check: time synchronization
timedatectl status
systemctl status chronyd
chronyc tracking | grep "RMS offset"
# Fix: RMS offset should be < 1 second for TOTP

# Issue: New LDAP users get "Account disabled"
# Check: pam_mkhomedir is configured
grep mkhomedir /etc/pam.d/common-session

# Issue: sudo shows "Sorry, user X may not run sudo"
# Check: LDAP group membership
getent group linux-admins | grep testuser
sudo sssctl user-checks testuser service=sudo action=acct
```

A well-configured PAM stack — combining SSSD for centralized LDAP authentication, pam_google_authenticator for TOTP, pam_faillock for account protection, and auditd for comprehensive logging — provides an enterprise-grade authentication foundation that satisfies compliance requirements while remaining operationally manageable.
