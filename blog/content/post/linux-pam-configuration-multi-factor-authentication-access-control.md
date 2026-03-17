---
title: "Linux PAM Configuration: Multi-Factor Authentication and Access Control"
date: 2031-04-18T00:00:00-05:00
draft: false
tags: ["Linux", "PAM", "Security", "MFA", "Authentication", "LDAP", "SSH", "Kubernetes"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux PAM configuration covering the module stack architecture, pam_google_authenticator TOTP setup, pam_ldap for directory integration, pam_faillock for brute force protection, SSH PAM configuration for infrastructure access, and implementing a Kubernetes API server PAM webhook for cluster authentication."
more_link: "yes"
url: "/linux-pam-configuration-multi-factor-authentication-access-control/"
---

Linux Pluggable Authentication Modules (PAM) is the foundational authentication framework that governs access to every system service — from SSH login to sudo elevation to service authentication. A properly configured PAM stack enforces multi-factor authentication, integrates with directory services, protects against brute force attacks, and provides detailed audit trails. This guide covers PAM module stacks in depth, TOTP setup with pam_google_authenticator, LDAP integration, fail2ban-compatible lockout policies, and extending Kubernetes authentication via a PAM webhook.

<!--more-->

# Linux PAM Configuration: Multi-Factor Authentication and Access Control

## Section 1: PAM Architecture and Module Stack

### The Four Management Groups

PAM divides authentication into four distinct phases, each with its own configuration stack:

```
PAM Module Stack Architecture:

Service (e.g., sshd, sudo, login)
         │
         ▼
┌────────────────────────────────────────────────────────┐
│              PAM Configuration File                     │
│  (/etc/pam.d/sshd, /etc/pam.d/sudo, etc.)             │
├────────────────────────────────────────────────────────┤
│                                                        │
│  auth    required   pam_env.so                        │
│  auth    required   pam_nologin.so                    │
│  auth    required   pam_faillock.so preauth            │
│  auth    sufficient pam_unix.so                        │
│  auth    required   pam_google_authenticator.so        │
│  auth    required   pam_faillock.so authfail           │
│                                                        │
│  account required   pam_nologin.so                    │
│  account required   pam_unix.so                        │
│  account required   pam_access.so                     │
│                                                        │
│  password required  pam_pwquality.so                  │
│  password required  pam_unix.so                        │
│                                                        │
│  session required   pam_selinux.so open               │
│  session required   pam_limits.so                     │
│  session required   pam_unix.so                        │
│  session optional   pam_lastlog.so                    │
│  session optional   pam_motd.so                       │
│  session required   pam_selinux.so close              │
└────────────────────────────────────────────────────────┘
```

### Control Flags Explained

```
Control flags determine how module results affect the overall outcome:

required   - Must succeed. On failure, continues to next module but
             final result will be failure. (No early exit)
             USE: Critical checks that must always run (faillock)

requisite  - Must succeed. On failure, immediately returns failure.
             (Early exit on failure)
             USE: Checks where continuing is meaningless after failure

sufficient - If succeeds AND no prior required failures, immediately
             succeeds without running more modules.
             USE: Alternative authentication paths

optional   - Result doesn't affect final outcome unless it's the
             only module in the stack.
             USE: Side effects (session logging, MOTD display)

include    - Include another PAM file's stack at this position.
             USE: Sharing common configurations

substack   - Include another PAM file but limit scope of jumps.
             USE: Safer include for complex stacks
```

### Understanding the Return Value Matrix

```
Module Return Values:

PAM_SUCCESS          - Operation succeeded
PAM_AUTH_ERR         - Authentication failed (wrong password)
PAM_CRED_ERR         - Unable to set credentials
PAM_PERM_DENIED      - Permission denied (account locked, expired)
PAM_USER_UNKNOWN     - User not in authentication database
PAM_MAXTRIES         - Maximum authentication attempts exceeded
PAM_ACCT_EXPIRED     - Account has expired
PAM_IGNORE           - Module requests to be ignored (used with optional)
```

## Section 2: Core PAM Modules

### /etc/pam.d/system-auth (Base Configuration)

```
# /etc/pam.d/system-auth
# This file is included by many service-specific configs
# RHEL/CentOS/Rocky - Ubuntu uses /etc/pam.d/common-auth

auth        required      pam_env.so
auth        required      pam_faildelay.so delay=2000000  # 2 second fail delay
auth        required      pam_faillock.so preauth audit silent deny=5 unlock_time=900
auth        [default=1 ignore=ignore success=ok] pam_localuser.so
auth        [success=done ignore=ignore default=die] pam_unix.so nullok
auth        sufficient    pam_ldap.so
auth        [default=die] pam_faillock.so authfail audit
auth        required      pam_deny.so

account     required      pam_unix.so
account     sufficient    pam_localuser.so
account     sufficient    pam_succeed_if.so uid < 1000 quiet
account     [default=bad success=ok user_unknown=ignore] pam_ldap.so
account     required      pam_permit.so

password    requisite     pam_pwquality.so try_first_pass local_users_only retry=3 authtok_type=
password    sufficient    pam_unix.so sha512 shadow nullok try_first_pass use_authtok
password    sufficient    pam_ldap.so use_authtok
password    required      pam_deny.so

session     optional      pam_keyinit.so revoke
session     required      pam_limits.so
session     [success=1 default=ignore] pam_succeed_if.so service in crond quiet use_uid
session     required      pam_unix.so
session     optional      pam_ldap.so
session     optional      pam_systemd.so
```

## Section 3: pam_faillock - Brute Force Protection

```
# /etc/security/faillock.conf
# Global faillock configuration (RHEL 8+/Ubuntu 22.04+)

# Deny after 5 failures
deny = 5

# Unlock after 15 minutes (900 seconds)
# Set to 0 for permanent lockout (requires admin to unlock)
unlock_time = 900

# Count failures in this window (seconds)
fail_interval = 900

# Store lockout info here (one file per user)
dir = /run/faillock

# Enable auditing of lockout events
audit

# Log to syslog
syslog_format

# Silent mode: don't tell user why auth failed
# Prevents enumeration attacks
silent

# Even lock out root (if root is locked, only console access works)
# Comment this out if you need remote root access
even_deny_root

# Apply to local users only (not LDAP)
# local_users_only
```

```
# Integrate into auth stack
# /etc/pam.d/sshd or /etc/pam.d/common-auth

auth    required    pam_faillock.so preauth silent audit
# ... other auth modules ...
auth    [default=die] pam_faillock.so authfail audit
auth    sufficient  pam_faillock.so authsucc audit
```

```bash
# Managing faillock

# View all locked accounts
faillock

# View lockout status for specific user
faillock --user jenkins

# Reset lockout for a user (admin unlock)
faillock --user jenkins --reset

# View faillock entries
ls -la /run/faillock/

# Monitor failed attempts in real-time
journalctl -f _COMM=sshd | grep -i "fail\|invalid\|refused"
```

## Section 4: pam_pwquality - Password Policy Enforcement

```
# /etc/security/pwquality.conf
# Comprehensive password quality settings

# Minimum password length
minlen = 14

# Character class requirements (negative = at least this many classes)
# Positive = minimum count of that class
minclass = 3       # Must use at least 3 different character classes
dcredit = -1       # At least 1 digit
ucredit = -1       # At least 1 uppercase
lcredit = -1       # At least 1 lowercase
ocredit = -1       # At least 1 other (special) character

# Reject passwords with > N same consecutive characters
maxrepeat = 3

# Reject if sequence of same class chars > N
maxclasssrepeat = 4

# Reject if username appears in password
usercheck = 1

# Number of previous passwords to remember (requires PAM history)
# Works with pam_pwhistory module
remember = 12

# Check against cracklib dictionary
dictcheck = 1

# Additional custom dictionary
# dictpath = /usr/share/cracklib/pw_dict

# Reject if password contains account name
gecoscheck = 1

# Reject sequences (abc, 123, qwerty)
# Requires cracklib with sequence support
enforce_for_root
```

## Section 5: TOTP Multi-Factor Authentication with pam_google_authenticator

### Installation

```bash
# RHEL/CentOS/Rocky
sudo dnf install -y google-authenticator

# Ubuntu/Debian
sudo apt-get install -y libpam-google-authenticator

# Verify module location
ls -la /usr/lib64/security/pam_google_authenticator.so  # RHEL
ls -la /usr/lib/x86_64-linux-gnu/security/pam_google_authenticator.so  # Ubuntu
```

### User Enrollment

```bash
# Run as the user being enrolled
google-authenticator

# Interactive prompts:
# Do you want authentication tokens to be time-based (y/n)? y
# [Shows QR code for authenticator app]
# Your new secret key is: JBSWY3DPEHPK3PXP
# [Emergency scratch codes shown]
#
# Do you want me to update your "~/.google_authenticator" file (y/n)? y
# Do you want to disallow multiple uses of the same authentication token? y
# Do you want to allow extra tokens beyond the current time? n (use y for clock skew tolerance)
# Do you want to enable rate-limiting? y

# The file is stored at:
cat ~/.google_authenticator

# Non-interactive enrollment for automation
google-authenticator \
  --time-based \
  --disallow-reuse \
  --force \
  --rate-limit=3 \
  --rate-time=30 \
  --window-size=3 \
  --no-confirm \
  --qr-mode=NONE \
  --secret=/home/username/.google_authenticator

# Secure the file
chmod 400 ~/.google_authenticator
```

### PAM Configuration for TOTP SSH

```
# /etc/pam.d/sshd
# MFA: Password + TOTP

# Standard auth stack
auth    required    pam_env.so
auth    required    pam_nologin.so

# Faillock pre-check
auth    required    pam_faillock.so preauth audit silent

# First: verify UNIX password
auth    required    pam_unix.so try_first_pass

# Second: require TOTP (Google Authenticator)
# nullok: don't fail if user hasn't set up 2FA yet (use for migration period)
# Remove nullok once all users are enrolled
auth    required    pam_google_authenticator.so nullok
# auth    required    pam_google_authenticator.so  # Strict mode

# Faillock post-auth (on failure)
auth    [default=die] pam_faillock.so authfail audit

auth    required    pam_faillock.so authsucc

account required    pam_nologin.so
account required    pam_unix.so

password required   pam_pwquality.so try_first_pass local_users_only
password required   pam_unix.so sha512 shadow try_first_pass use_authtok

session required    pam_selinux.so close
session required    pam_loginuid.so
session required    pam_selinux.so open
session optional    pam_keyinit.so force revoke
session required    pam_limits.so
session required    pam_unix.so
session optional    pam_lastlog.so showfailed
```

### SSH Server Configuration for PAM

```
# /etc/ssh/sshd_config additions for PAM + MFA

# Enable PAM
UsePAM yes

# Require keyboard-interactive (allows PAM challenge-response for TOTP)
AuthenticationMethods keyboard-interactive
# Or for password + public key + TOTP:
# AuthenticationMethods publickey,keyboard-interactive

# Disable password authentication (use PAM keyboard-interactive instead)
PasswordAuthentication no

# Enable keyboard-interactive
ChallengeResponseAuthentication yes
KbdInteractiveAuthentication yes

# PAM integration settings
# These control what PAM does in each phase
```

### Graceful MFA Rollout Script

```bash
#!/bin/bash
# enroll-mfa.sh - Automate TOTP enrollment for a user
set -euo pipefail

USERNAME="${1:?Usage: $0 <username>}"
SECRET_FILE="/home/${USERNAME}/.google_authenticator"

if [[ -f "${SECRET_FILE}" ]]; then
  echo "User ${USERNAME} already has TOTP configured"
  exit 0
fi

# Generate secret as the user
sudo -u "${USERNAME}" google-authenticator \
  --time-based \
  --disallow-reuse \
  --force \
  --rate-limit=3 \
  --rate-time=30 \
  --window-size=3 \
  --no-confirm \
  --qr-mode=UTF8 \
  --secret="${SECRET_FILE}"

# Secure the file
chmod 400 "${SECRET_FILE}"
chown "${USERNAME}:${USERNAME}" "${SECRET_FILE}"

# Extract secret for display
SECRET=$(head -1 "${SECRET_FILE}")
echo "TOTP Setup for ${USERNAME}:"
echo "Secret: ${SECRET}"
echo "Add to Google Authenticator or Authy"
echo ""
echo "File: ${SECRET_FILE}"
```

## Section 6: LDAP Integration with pam_ldap

### Installing LDAP PAM Module

```bash
# Ubuntu/Debian
sudo apt-get install -y libpam-ldapd nslcd

# RHEL/CentOS (sssd is preferred, but pam_ldap works)
sudo dnf install -y nss-pam-ldapd

# Or use SSSD (recommended for production)
sudo dnf install -y sssd sssd-ldap sssd-tools
```

### SSSD Configuration (Recommended over pam_ldap)

```ini
# /etc/sssd/sssd.conf
[sssd]
domains = example.com
config_file_version = 2
services = nss, pam, sudo, ssh

[domain/example.com]
id_provider = ldap
auth_provider = ldap
chpass_provider = ldap

# LDAP server settings
ldap_uri = ldaps://ldap1.example.com:636,ldaps://ldap2.example.com:636
ldap_search_base = dc=example,dc=com
ldap_default_bind_dn = cn=sssd-reader,ou=service-accounts,dc=example,dc=com
ldap_default_authtok = <ldap-service-account-password>
ldap_tls_reqcert = demand
ldap_tls_cacert = /etc/ssl/certs/example-ca.crt

# User/group search
ldap_user_search_base = ou=users,dc=example,dc=com
ldap_group_search_base = ou=groups,dc=example,dc=com

# Attribute mapping
ldap_user_name = uid
ldap_user_uid_number = uidNumber
ldap_user_gid_number = gidNumber
ldap_user_home_directory = homeDirectory
ldap_user_shell = loginShell
ldap_user_principal = krbPrincipalName

# Group membership
ldap_group_member = member
ldap_group_type = 2  # RFC2307bis (uses 'member' attribute with DN values)

# SSH public key retrieval from LDAP
ldap_user_ssh_public_key = sshPublicKey

# Cache settings
cache_credentials = true
entry_cache_timeout = 3600
refresh_expired_interval = 600

# Performance
ldap_connection_expire_timeout = 1800
ldap_network_timeout = 10
ldap_opt_timeout = 10

# Access control - only allow members of specific groups
access_provider = ldap
ldap_access_filter = memberOf=cn=server-access,ou=groups,dc=example,dc=com
# Or allow specific group:
# ldap_access_filter = (&(objectClass=posixAccount)(memberOf=cn=sysadmins,ou=groups,dc=example,dc=com))

# Home directory creation
override_homedir = /home/%u
default_shell = /bin/bash
fallback_homedir = /home/%u

# sudo rules from LDAP
sudo_provider = ldap
ldap_sudo_search_base = ou=sudoers,dc=example,dc=com

[pam]
offline_credentials_expiration = 7
offline_failed_login_attempts = 3
offline_failed_login_delay = 5

[nss]
filter_groups = root
filter_users = root
```

### PAM Stack with SSSD

```
# /etc/pam.d/sshd with SSSD
auth    required      pam_env.so
auth    required      pam_faillock.so preauth
auth    sufficient    pam_sss.so forward_pass
auth    required      pam_unix.so try_first_pass
auth    [default=die] pam_faillock.so authfail
auth    sufficient    pam_faillock.so authsucc

account required      pam_unix.so
account required      pam_sss.so
account required      pam_localuser.so
account sufficient    pam_succeed_if.so uid < 1000 quiet

password requisite    pam_pwquality.so
password sufficient   pam_sss.so use_authtok
password required     pam_unix.so sha512 shadow try_first_pass use_authtok

session required      pam_mkhomedir.so umask=0077  # Create home if doesn't exist
session required      pam_limits.so
session required      pam_unix.so
session optional      pam_sss.so
```

## Section 7: pam_access - Source-Based Access Control

```
# /etc/security/access.conf
# Controls which users can login from which sources
# Format: +/- : users/groups : sources

# Deny ALL by default (last rule)
# Override with specific allows above

# Allow root from console only
+ : root : LOCAL

# Allow wheel group members from any source
+ : @wheel : ALL

# Allow sysadmins from corporate VPN range
+ : @sysadmins : 10.0.100.0/24

# Allow specific service accounts from localhost only
+ : jenkins nagios prometheus : LOCAL 127.0.0.1 ::1

# Allow users from specific domain or hostname
+ : @developers : .corp.example.com

# Emergency backdoor from management network
+ : @emergency-access : 10.99.0.0/24

# DENY EVERYONE ELSE
- : ALL : ALL
```

```
# Enable in PAM stack
# /etc/pam.d/sshd

account    required    pam_access.so  accessfile=/etc/security/access.conf
```

## Section 8: sudo PAM Integration

```
# /etc/pam.d/sudo
# Controls sudo authentication

auth    required    pam_env.so readenv=1
auth    required    pam_faillock.so preauth

# Allow timestamp token (sudo -v refreshes)
auth    sufficient  pam_timestamp.so

# Require password
auth    required    pam_unix.so try_first_pass

# Optionally require TOTP for sudo
# auth    required    pam_google_authenticator.so secret=/etc/google-mfa/%u/google_authenticator user=root

auth    [default=die] pam_faillock.so authfail
auth    sufficient  pam_faillock.so authsucc

account required    pam_unix.so
session required    pam_limits.so
session required    pam_unix.so
```

```
# /etc/sudoers (manage with visudo)
# Require password for all sudo (even for root)
Defaults    !nopasswd
Defaults    timestamp_timeout=5      # Re-authenticate after 5 minutes
Defaults    passwd_timeout=0         # No timeout on password prompt itself
Defaults    logfile=/var/log/sudo.log
Defaults    log_input                # Log stdin
Defaults    log_output               # Log stdout
Defaults    use_loginclass
Defaults    secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Sysadmins with full access
%wheel ALL=(ALL:ALL) ALL

# Operators with limited access
%operators ALL=(ALL) NOPASSWD: /usr/bin/systemctl status *, \
                     NOPASSWD: /usr/bin/journalctl *, \
                     /usr/bin/tail /var/log/*, \
                     /bin/cat /var/log/*

# Jenkins CI can restart services
jenkins ALL=(root) NOPASSWD: /usr/bin/systemctl restart myapp, \
                              /usr/bin/systemctl start myapp, \
                              /usr/bin/systemctl stop myapp
```

## Section 9: Kubernetes API Server PAM Webhook

A PAM webhook allows the Kubernetes API server to delegate authentication to a PAM-compatible service:

### Webhook Server Implementation

```go
package pamwebhook

import (
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "os/exec"
    "strings"

    authv1 "k8s.io/api/authentication/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// TokenReviewHandler handles Kubernetes TokenReview requests
// using PAM for authentication validation
type TokenReviewHandler struct {
    ldapBaseDN   string
    allowedGroups []string
}

func NewTokenReviewHandler(ldapBaseDN string, allowedGroups []string) *TokenReviewHandler {
    return &TokenReviewHandler{
        ldapBaseDN:    ldapBaseDN,
        allowedGroups: allowedGroups,
    }
}

// ServeHTTP handles the webhook POST request
func (h *TokenReviewHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
        return
    }

    var tokenReview authv1.TokenReview
    if err := json.NewDecoder(r.Body).Decode(&tokenReview); err != nil {
        http.Error(w, fmt.Sprintf("decoding request: %v", err), http.StatusBadRequest)
        return
    }

    // Parse token: format is "username:password:totp_code"
    // Or just "username:password" if no TOTP
    response := h.authenticate(tokenReview.Spec.Token)

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusOK)
    json.NewEncoder(w).Encode(response)
}

// authenticate validates the token against PAM
func (h *TokenReviewHandler) authenticate(token string) authv1.TokenReview {
    failure := authv1.TokenReview{
        TypeMeta: metav1.TypeMeta{
            APIVersion: "authentication.k8s.io/v1",
            Kind:       "TokenReview",
        },
        Status: authv1.TokenReviewStatus{
            Authenticated: false,
        },
    }

    // Token format: "username:password" or "username:password:totpcode"
    parts := strings.SplitN(token, ":", 3)
    if len(parts) < 2 {
        return failure
    }

    username := parts[0]
    password := parts[1]
    totpCode := ""
    if len(parts) == 3 {
        totpCode = parts[2]
    }

    // Validate against PAM using pamtester or custom PAM helper
    if !h.validateWithPAM(username, password, totpCode) {
        return failure
    }

    // Get user groups from LDAP/SSSD
    groups, err := h.getUserGroups(username)
    if err != nil {
        log.Printf("Error getting groups for %s: %v", username, err)
        return failure
    }

    // Map LDAP groups to Kubernetes groups
    k8sGroups := h.mapGroups(groups)
    k8sGroups = append(k8sGroups, "system:authenticated")

    return authv1.TokenReview{
        TypeMeta: metav1.TypeMeta{
            APIVersion: "authentication.k8s.io/v1",
            Kind:       "TokenReview",
        },
        Status: authv1.TokenReviewStatus{
            Authenticated: true,
            User: authv1.UserInfo{
                Username: username,
                UID:      username,
                Groups:   k8sGroups,
                Extra: map[string]authv1.ExtraValue{
                    "ldap-groups": groups,
                },
            },
        },
    }
}

// validateWithPAM calls the PAM helper to validate credentials
func (h *TokenReviewHandler) validateWithPAM(username, password, totp string) bool {
    // Use pamtester utility
    // pamtester tests PAM authentication for a service
    // Install: apt-get install pamtester OR dnf install pamtester
    cmd := exec.Command("pamtester", "sshd", username, "authenticate")
    cmd.Stdin = strings.NewReader(password + "\n" + totp + "\n")

    output, err := cmd.CombinedOutput()
    if err != nil {
        log.Printf("PAM authentication failed for %s: %v\nOutput: %s",
            username, err, output)
        return false
    }

    return true
}

// getUserGroups retrieves LDAP/SSSD group memberships
func (h *TokenReviewHandler) getUserGroups(username string) (authv1.ExtraValue, error) {
    // Use 'id' command which works with SSSD/LDAP
    cmd := exec.Command("id", "-Gn", username)
    output, err := cmd.Output()
    if err != nil {
        return nil, fmt.Errorf("getting groups: %w", err)
    }

    groups := strings.Fields(string(output))
    result := make(authv1.ExtraValue, len(groups))
    for i, g := range groups {
        result[i] = g
    }
    return result, nil
}

// mapGroups maps LDAP groups to Kubernetes groups
func (h *TokenReviewHandler) mapGroups(ldapGroups authv1.ExtraValue) []string {
    // Map LDAP group names to Kubernetes group names
    groupMap := map[string]string{
        "sysadmins":     "system:masters",
        "k8s-platform":  "platform-team",
        "k8s-dev":       "developers",
        "k8s-readonly":  "read-only-users",
    }

    k8sGroups := []string{}
    for _, ldapGroup := range ldapGroups {
        if k8sGroup, ok := groupMap[ldapGroup]; ok {
            k8sGroups = append(k8sGroups, k8sGroup)
        }
        // Also pass through the original LDAP group
        k8sGroups = append(k8sGroups, "ldap:"+ldapGroup)
    }
    return k8sGroups
}

func main() {
    handler := NewTokenReviewHandler(
        "dc=example,dc=com",
        []string{"sysadmins", "k8s-platform", "k8s-dev"},
    )

    // Serve with TLS (required for kube-apiserver)
    log.Println("Starting PAM webhook on :8443")
    if err := http.ListenAndServeTLS(
        ":8443",
        "/etc/pam-webhook/tls.crt",
        "/etc/pam-webhook/tls.key",
        handler,
    ); err != nil {
        log.Fatalf("Server error: %v", err)
    }
}
```

### Kubernetes API Server Configuration

```yaml
# kube-apiserver flags for webhook authentication
spec:
  containers:
  - name: kube-apiserver
    command:
    - kube-apiserver
    # ... existing flags ...
    - --authentication-token-webhook-config-file=/etc/kubernetes/pam-webhook.yaml
    - --authentication-token-webhook-cache-ttl=5m
    volumeMounts:
    - name: pam-webhook-config
      mountPath: /etc/kubernetes/pam-webhook.yaml
      readOnly: true
  volumes:
  - name: pam-webhook-config
    hostPath:
      path: /etc/kubernetes/pam-webhook.yaml
---
# /etc/kubernetes/pam-webhook.yaml
apiVersion: v1
kind: Config
clusters:
  - name: pam-webhook
    cluster:
      server: https://pam-webhook.kube-system.svc.cluster.local:8443
      certificate-authority: /etc/kubernetes/pki/pam-webhook-ca.crt
users:
  - name: kube-apiserver
    user:
      client-certificate: /etc/kubernetes/pki/apiserver-pam-webhook.crt
      client-key: /etc/kubernetes/pki/apiserver-pam-webhook.key
contexts:
  - context:
      cluster: pam-webhook
      user: kube-apiserver
    name: webhook
current-context: webhook
```

## Section 10: Monitoring PAM Events

```bash
# Monitor PAM events via systemd journal
journalctl -t pam -f

# Failed authentication attempts
journalctl -t sshd --since="1 hour ago" | grep "Failed"

# Successful authentications
journalctl -t sshd --since="1 hour ago" | grep "Accepted"

# Sudo usage
journalctl -t sudo --since="today"

# Account lockouts
journalctl -t pam_faillock --since="today" | grep "Consecutive failures"

# Failed TOTP attempts (check syslog)
grep "google_authenticator" /var/log/secure
grep "google_authenticator" /var/log/auth.log
```

```yaml
# Prometheus alerting for authentication failures
groups:
  - name: pam.auth
    rules:
      - alert: HighSSHAuthFailures
        expr: |
          rate(node_vmstat_pgfault[5m]) > 0
        for: 5m
        # This would use a custom exporter reading auth logs
        # In practice, use the systemd journal exporter or Filebeat
        labels:
          severity: warning
        annotations:
          summary: "High SSH authentication failure rate"
```

PAM provides the most comprehensive authentication framework available on Linux systems. By properly stacking modules in the correct order with appropriate control flags, organizations can enforce MFA, integrate directory services, protect against brute force attacks, and maintain detailed audit trails — all while remaining transparent to application code. The PAM webhook pattern extends this power to Kubernetes, enabling consistent authentication policies across both traditional Linux infrastructure and container orchestration platforms.
