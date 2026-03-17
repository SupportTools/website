---
title: "Linux Kernel Lockdown: Secure Boot, Module Signing, and Integrity"
date: 2029-08-08T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "Kernel", "SecureBoot", "IMA", "TPM", "ModuleSigning"]
categories: ["Linux", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux kernel lockdown mode, IMA/EVM integrity measurement, module signing with x509 keys, the secure boot chain, and TPM-based attestation for containerized workloads."
more_link: "yes"
url: "/linux-kernel-lockdown-secure-boot-module-signing-integrity/"
---

Running untrusted code in kernel space is the fastest path to total system compromise. Linux provides a layered defense: Secure Boot prevents unsigned boot loaders, module signing prevents unsigned kernel extensions, IMA/EVM detect filesystem tampering at runtime, and kernel lockdown mode restricts what root can do even after login. This post walks through each layer in a production context, including TPM-based attestation for container environments.

<!--more-->

# Linux Kernel Lockdown: Secure Boot, Module Signing, and Integrity

## Section 1: The Linux Boot Integrity Chain

Before examining each component, understand how they chain together:

```
UEFI Secure Boot
    └── verifies bootloader signature (shim → grub2)
        └── verifies kernel signature
            └── kernel lockdown mode activates
                └── module signing enforced
                    └── IMA measures files at open/exec
                        └── EVM protects IMA xattrs
                            └── TPM PCRs record measurements
```

Each layer depends on the one above it. If Secure Boot is disabled, an attacker can replace the bootloader and bypass everything downstream. This is why the chain must be validated from the hardware root of trust.

### Checking Current Status

```bash
# Check Secure Boot state
mokutil --sb-state
# SecureBoot enabled

# Check kernel lockdown mode
cat /sys/kernel/security/lockdown
# none [integrity] confidentiality

# Check IMA status
cat /sys/kernel/security/ima/policy

# Check loaded modules signature enforcement
cat /proc/sys/kernel/modules_disabled
grep CONFIG_MODULE_SIG_FORCE /boot/config-$(uname -r)

# Check TPM presence
ls /dev/tpm* /dev/tpmrm*
tpm2_getcap properties-fixed 2>/dev/null | head -20
```

## Section 2: Kernel Lockdown Mode

Kernel lockdown is a Linux Security Module (LSM) introduced in kernel 5.4. It restricts what root can do to protect kernel integrity even after the system boots.

### Lockdown Levels

**none** — No restrictions. Default without Secure Boot.

**integrity** — Prevents modifications that could compromise kernel integrity:
- No `/dev/mem` or `/dev/kmem` access
- No kexec of unsigned kernels
- No hibernation (could leak kernel secrets)
- No raw MSR writes from userspace
- No ACPI table uploads
- PCI BAR access restricted

**confidentiality** — Everything in integrity, plus:
- No reading kernel memory via `/dev/mem`
- No BPF programs that could read kernel memory
- No perf tracing of kernel addresses

### Enabling Lockdown

```bash
# Enable integrity lockdown at runtime (requires CAP_SYS_ADMIN)
echo integrity > /sys/kernel/security/lockdown

# Cannot go from confidentiality back to integrity or none — one-way ratchet
echo confidentiality > /sys/kernel/security/lockdown

# Enable at boot via kernel command line
# Edit /etc/default/grub:
GRUB_CMDLINE_LINUX="lockdown=confidentiality"
update-grub

# Or via systemd-boot entry (/etc/kernel/cmdline):
echo "lockdown=confidentiality" >> /etc/kernel/cmdline
```

### Kernel Configuration for Lockdown

```bash
# Required kernel config options
grep -E 'CONFIG_SECURITY_LOCKDOWN|CONFIG_LSM' /boot/config-$(uname -r)
# CONFIG_SECURITY_LOCKDOWN_LSM=y
# CONFIG_SECURITY_LOCKDOWN_LSM_EARLY=y
# CONFIG_LSM="lockdown,yama,integrity,apparmor"

# Build kernel with lockdown support (for custom kernels)
cat >> .config << 'EOF'
CONFIG_SECURITY_LOCKDOWN_LSM=y
CONFIG_SECURITY_LOCKDOWN_LSM_EARLY=y
EOF
make olddefconfig
```

### What Lockdown Breaks

Be aware of these common breakages when enabling lockdown:

```bash
# 1. DKMS modules fail if not signed
dkms status
# nvidia, 525.89.02, 6.1.0-18-amd64, x86_64: installed (WARNING! Lockdown: unsigned module)

# 2. kexec-based fast reboots fail
kexec -l /boot/vmlinuz-current --initrd=/boot/initrd.img-current
# kexec_load failed: Operation not permitted

# 3. Hibernate fails
systemctl hibernate
# Failed to hibernate system via logind: Sleep verb 'hibernate' not supported

# 4. Some crash dump tools break
# makedumpfile requires /dev/mem access in some configurations
```

## Section 3: Module Signing

Kernel module signing uses asymmetric cryptography to verify that kernel modules were built by a trusted party and have not been tampered with.

### Generating Signing Keys

```bash
# Create a directory for signing infrastructure
mkdir -p /etc/kernel/signing-keys
cd /etc/kernel/signing-keys

# Generate a signing key pair (keep the private key offline in production)
openssl req -new -x509 -newkey rsa:4096 \
    -keyout kernel-signing-key.pem \
    -out kernel-signing-cert.pem \
    -days 3650 \
    -subj "/CN=Kernel Module Signing Key/O=support.tools/C=US" \
    -nodes

# Convert certificate to DER format for kernel enrollment
openssl x509 -in kernel-signing-cert.pem -out kernel-signing-cert.der -outform DER

# Set restrictive permissions
chmod 600 kernel-signing-key.pem
chmod 644 kernel-signing-cert.pem kernel-signing-cert.der
```

### Enrolling the Key in the Kernel's Trusted Keyring

```bash
# Method 1: Build the certificate into the kernel (most secure)
# Copy cert to kernel source directory
cp kernel-signing-cert.der /usr/src/linux-$(uname -r)/certs/
# Add to CONFIG_SYSTEM_TRUSTED_KEYS in kernel config

# Method 2: Enroll via mokutil (UEFI Machine Owner Key)
mokutil --import kernel-signing-cert.der
# Enter a one-time password — you will need this on the next boot
# After reboot, confirm enrollment in MOK Management screen

# Verify enrollment
keyctl list %:.builtin_trusted_keys
keyctl list %:.platform_trusted_keys
# Look for your CN= entry
```

### Signing a Kernel Module

```bash
# Sign a module with the generated key
/usr/src/linux-$(uname -r)/scripts/sign-file \
    sha512 \
    /etc/kernel/signing-keys/kernel-signing-key.pem \
    /etc/kernel/signing-keys/kernel-signing-cert.pem \
    /path/to/module.ko

# Verify the signature
modinfo /path/to/module.ko | grep -E 'signer|sig_key|sig_hashalgo'
# signer:         Kernel Module Signing Key
# sig_key:        <fingerprint>
# sig_hashalgo:   sha512

# Load the signed module
modprobe module_name
# or
insmod /path/to/module.ko
```

### Enforcing Module Signature Verification

```bash
# Current enforcement mode
cat /proc/sys/kernel/modules_disabled
# 0 = no enforcement, 1 = no new modules can load

# Kernel boot parameters for enforcement
# CONFIG_MODULE_SIG_FORCE=y  — compile-time enforcement (best)
# module.sig_enforce=1       — runtime enforcement via cmdline

# /etc/default/grub
GRUB_CMDLINE_LINUX="module.sig_enforce=1"

# Check if a module would be blocked
modinfo bad_module.ko | grep signature
# (no signature)
# With sig_enforce=1: insmod bad_module.ko → insmod: ERROR: could not insert module
```

### Automating DKMS Module Signing

```bash
# /etc/dkms/framework.conf — sign all DKMS modules automatically
cat >> /etc/dkms/framework.conf << 'EOF'
sign_tool="/etc/kernel/signing-scripts/sign-dkms-module"
EOF

# /etc/kernel/signing-scripts/sign-dkms-module
cat > /etc/kernel/signing-scripts/sign-dkms-module << 'EOF'
#!/bin/bash
set -euo pipefail
MODULE_PATH="$1"
/usr/src/linux-$(uname -r)/scripts/sign-file \
    sha512 \
    /etc/kernel/signing-keys/kernel-signing-key.pem \
    /etc/kernel/signing-keys/kernel-signing-cert.pem \
    "${MODULE_PATH}"
echo "Signed: ${MODULE_PATH}"
EOF
chmod +x /etc/kernel/signing-scripts/sign-dkms-module

# Rebuild and re-sign all DKMS modules
dkms autoinstall
```

## Section 4: IMA — Integrity Measurement Architecture

IMA measures (hashes) files when they are opened or executed, storing the measurements in a kernel-maintained log and optionally in TPM PCRs. This creates a tamper-evident audit trail.

### IMA Policy Modes

```
appraise  — verify file hash against stored xattr; block if mismatch
measure   — record hash to measurement log (no blocking)
audit     — write hash to kernel audit log
```

### Configuring IMA Policy

```bash
# View current IMA policy
cat /sys/kernel/security/ima/policy

# Default built-in policy (measure_pcr_idx=10)
# Measures: executables, shared libraries, kernel modules, firmware, IMA policy

# Custom IMA policy file /etc/ima/ima-policy
cat > /etc/ima/ima-policy << 'EOF'
# Measure all executed binaries
measure func=BPRM_CHECK mask=MAY_EXEC uid=0 pcr=10

# Measure shared library loads
measure func=FILE_MMAP mask=MAY_EXEC uid=0 pcr=10

# Measure kernel module loads
measure func=MODULE_CHECK pcr=11

# Appraise (verify) executables owned by root
appraise func=BPRM_CHECK appraise_type=imasig uid=0 fowner=0

# Measure configuration files
measure func=FILE_CHECK mask=MAY_READ path=/etc pcr=12
EOF

# Load the custom policy
echo /etc/ima/ima-policy > /sys/kernel/security/ima/policy
```

### Viewing IMA Measurement Log

```bash
# View the ASCII measurement log
cat /sys/kernel/security/ima/ascii_runtime_measurements
# PCR     Template Hash         FileHash  Filename
# 10 ...  sha256:abc123...      /bin/bash
# 10 ...  sha256:def456...      /lib/x86_64-linux-gnu/libc.so.6

# Count measurements
wc -l /sys/kernel/security/ima/ascii_runtime_measurements

# Binary log (for TPM validation)
cat /sys/kernel/security/ima/binary_runtime_measurements > /tmp/ima.bin

# Verify TPM PCR matches IMA log
tpm2_pcrread sha256:10
ima-inspect /tmp/ima.bin
```

### Setting File Hashes for Appraisal

```bash
# Install required tools
apt-get install ima-evm-utils

# Set IMA xattr on a file (run as root after boot with IMA in fix mode)
evmctl ima_hash -a sha256 /usr/bin/myapp

# Verify
getfattr -n security.ima /usr/bin/myapp

# Bulk hash all executables in a directory
find /usr/bin /usr/sbin -type f -executable | \
    xargs -P4 -I{} evmctl ima_hash -a sha256 {}

# Sign with IMA key (stronger than plain hash)
evmctl sign --imasig --key /etc/ima/ima-signing-key.pem \
    -a sha256 /usr/bin/myapp
```

## Section 5: EVM — Extended Verification Module

EVM protects IMA xattrs and other security-sensitive file metadata from offline tampering. It uses an HMAC or asymmetric signature over the combination of security xattrs.

### EVM Key Setup

```bash
# Generate EVM key
# Option 1: HMAC key (simpler, TPM-backed in production)
# The kernel generates a random EVM key on first boot if TPM is available
# Check:
keyctl show @u | grep evm

# Option 2: Asymmetric EVM key (more flexible)
openssl req -new -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
    -keyout /etc/keys/evm-signing-key.pem \
    -out /etc/keys/evm-signing-cert.pem \
    -days 3650 \
    -subj "/CN=EVM Signing Key/O=support.tools" \
    -nodes

# Load the EVM key into the kernel keyring
evmctl import /etc/keys/evm-signing-cert.pem %:.evm

# Enable EVM (requires restart or initramfs hook for persistence)
echo 1 > /sys/kernel/security/evm
```

### EVM Modes

```bash
# EVM modes via kernel boot parameter
# evm=fix       — allow setting xattrs (setup mode)
# evm=enforce   — block files with invalid EVM signatures
# evm=ignore    — disable EVM enforcement

# /etc/default/grub for production
GRUB_CMDLINE_LINUX="evm=enforce ima_appraise=enforce"
```

## Section 6: TPM Attestation for Containers

TPM (Trusted Platform Module) provides hardware-backed measurement storage. In a container environment, TPM measurements prove to a remote verifier that the host booted into a known-good state.

### Understanding PCR Banks

```bash
# Standard PCR allocation
# PCR 0: UEFI firmware code
# PCR 1: UEFI firmware data/config
# PCR 2: UEFI option ROMs
# PCR 3: UEFI option ROM data
# PCR 4: MBR/bootloader code
# PCR 5: MBR/bootloader data
# PCR 7: Secure Boot state
# PCR 8-9: grub2 measurements
# PCR 10: IMA measurements
# PCR 11: Kernel module measurements (custom IMA policy)
# PCR 12: Configuration file measurements (custom IMA policy)

# Read all PCR values
tpm2_pcrread sha256

# Read specific PCRs
tpm2_pcrread sha256:0,7,10
```

### TPM-Backed Secrets for Containers

```bash
# Seal a secret to specific PCR values
# The secret can only be unsealed if PCRs match (i.e., system is in known-good state)

# Step 1: Record expected PCR values (after clean boot on known-good system)
tpm2_pcrread sha256:0,7,10 -o /etc/tpm/expected-pcrs.out

# Step 2: Seal a secret (e.g., disk encryption key, container secret)
echo -n "my-container-secret" | \
    tpm2_create -C /etc/tpm/primary.ctx \
        -i - \
        -u /etc/tpm/sealed.pub \
        -r /etc/tpm/sealed.priv \
        -L sha256:0,7,10

# Step 3: Unseal at runtime (fails if PCRs have changed)
tpm2_unseal -c /etc/tpm/sealed.ctx -o /dev/stdout

# Integration with systemd-cryptenroll for LUKS
systemd-cryptenroll --tpm2-device=auto \
    --tpm2-pcrs=0+7+10 \
    /dev/sda3
```

### Remote Attestation Workflow

```bash
# TPM Quote — signed measurement report for remote verifier
tpm2_quote \
    --key-context /etc/tpm/attestation-key.ctx \
    --pcr-list sha256:0,7,10,11 \
    --message /tmp/nonce.bin \
    --signature /tmp/quote.sig \
    --pcr /tmp/quote.pcr

# Send quote to remote verifier
curl -X POST https://attestation.internal/verify \
    -H "Content-Type: application/json" \
    -d @/tmp/quote.json

# Remote verifier checks:
# 1. TPM signature is valid (key is from a real TPM)
# 2. PCR values match expected values for this host type
# 3. Nonce matches (prevents replay attacks)
# 4. IMA log is consistent with PCR 10
```

### Keylime: Automated TPM Attestation

```bash
# Install Keylime
apt-get install keylime keylime-agent

# Configure Keylime verifier
cat > /etc/keylime/verifier.conf << 'EOF'
[verifier]
ip = 0.0.0.0
port = 8881
tls_dir = /var/lib/keylime/cv_ca
ca_cert = cacert.crt
my_cert = server-cert.crt
private_key = server-private.pem
EOF

# Register a tenant (agent host)
keylime_tenant -c add \
    --uuid $(hostname) \
    --ip $(hostname -I | awk '{print $1}') \
    --allowlist /etc/keylime/allowlist.txt \
    --tpm_policy /etc/keylime/tpm_policy.json

# Monitor attestation status
keylime_tenant -c status --uuid $(hostname)
```

### Container Runtime Integration

```bash
# containerd with TPM-backed secrets via sealed-secrets
# /etc/containerd/config.toml

[plugins."io.containerd.grpc.v1.cri".containerd]
  snapshotter = "overlayfs"

# Use a TPM-sealed secret as the image pull secret
# Unseal at container startup via initContainer

# Kubernetes example: TPM attestation as admission webhook
cat > /tmp/tpm-attestation-webhook.yaml << 'EOF'
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionWebhook
metadata:
  name: tpm-attestation.security.example.com
webhooks:
  - name: tpm-attestation.security.example.com
    rules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        resources: ["pods"]
        operations: ["CREATE"]
    clientConfig:
      service:
        name: tpm-attestation-webhook
        namespace: security-system
        path: /validate
    failurePolicy: Fail
    admissionReviewVersions: ["v1"]
EOF
```

## Section 7: Secure Boot Chain Configuration

### UEFI Secure Boot Key Hierarchy

```
Platform Key (PK)  — owned by hardware vendor / enterprise IT
    └── Key Exchange Key (KEK) — intermediate CA
        └── Signature Database (db) — allowed boot binaries
        └── Forbidden Signature Database (dbx) — revoked binaries
```

### Enrolling Custom Keys

```bash
# Generate Platform Key
openssl req -new -x509 -newkey rsa:4096 \
    -keyout PK.key -out PK.crt \
    -days 3650 \
    -subj "/CN=Platform Key/O=support.tools" -nodes

# Generate Key Exchange Key
openssl req -new -x509 -newkey rsa:4096 \
    -keyout KEK.key -out KEK.crt \
    -days 3650 \
    -subj "/CN=Key Exchange Key/O=support.tools" -nodes

# Generate Database Key
openssl req -new -x509 -newkey rsa:4096 \
    -keyout db.key -out db.crt \
    -days 3650 \
    -subj "/CN=Signature Database Key/O=support.tools" -nodes

# Convert to EFI signature list format
cert-to-efi-sig-list -g $(uuidgen) PK.crt PK.esl
cert-to-efi-sig-list -g $(uuidgen) KEK.crt KEK.esl
cert-to-efi-sig-list -g $(uuidgen) db.crt db.esl

# Sign the signature lists
sign-efi-sig-list -k PK.key -c PK.crt PK PK.esl PK.auth
sign-efi-sig-list -k PK.key -c PK.crt KEK KEK.esl KEK.auth
sign-efi-sig-list -k KEK.key -c KEK.crt db db.esl db.auth

# Enroll keys (in UEFI Setup Mode)
efi-updatevar -f db.auth db
efi-updatevar -f KEK.auth KEK
efi-updatevar -f PK.auth PK  # This enables Secure Boot
```

### Signing a bootloader

```bash
# Sign grub2
sbsign --key db.key --cert db.crt \
    --output /boot/efi/EFI/debian/grubx64.efi \
    /boot/efi/EFI/debian/grubx64.efi

# Sign the kernel
sbsign --key db.key --cert db.crt \
    --output /boot/vmlinuz-$(uname -r)-signed \
    /boot/vmlinuz-$(uname -r)

# Verify signatures
sbverify --cert db.crt /boot/efi/EFI/debian/grubx64.efi
sbverify --cert db.crt /boot/vmlinuz-$(uname -r)-signed
```

## Section 8: Hardening Script for Production Systems

```bash
#!/bin/bash
# /usr/local/sbin/harden-kernel-integrity.sh
# Apply kernel integrity hardening. Run once after system setup.
set -euo pipefail

echo "=== Kernel Integrity Hardening ==="

# 1. Check Secure Boot
if ! mokutil --sb-state | grep -q "SecureBoot enabled"; then
    echo "WARNING: Secure Boot is not enabled. Enable it in UEFI settings."
fi

# 2. Enable kernel lockdown
if [ -w /sys/kernel/security/lockdown ]; then
    echo integrity > /sys/kernel/security/lockdown
    echo "Kernel lockdown: integrity mode enabled"
fi

# 3. Enable module signature enforcement
if [ "$(cat /proc/sys/kernel/modules_disabled)" = "0" ]; then
    sysctl -w kernel.modules_disabled=0  # Will be 1 after all needed modules loaded
    echo "module.sig_enforce=1" >> /etc/modprobe.d/sig-enforce.conf
fi

# 4. Enable IMA
if [ -d /sys/kernel/security/ima ]; then
    echo "IMA is enabled"
    cat /sys/kernel/security/ima/policy | head -5
fi

# 5. Disable kexec
sysctl -w kernel.kexec_load_disabled=1
echo "kernel.kexec_load_disabled = 1" >> /etc/sysctl.d/99-integrity.conf

# 6. Disable loading of unsigned kernel modules at runtime
echo "install cramfs /bin/true" >> /etc/modprobe.d/blacklist-unusual.conf
echo "install freevxfs /bin/true" >> /etc/modprobe.d/blacklist-unusual.conf
echo "install jffs2 /bin/true" >> /etc/modprobe.d/blacklist-unusual.conf
echo "install hfs /bin/true" >> /etc/modprobe.d/blacklist-unusual.conf
echo "install hfsplus /bin/true" >> /etc/modprobe.d/blacklist-unusual.conf
echo "install udf /bin/true" >> /etc/modprobe.d/blacklist-unusual.conf

# 7. Restrict dmesg to root
sysctl -w kernel.dmesg_restrict=1
echo "kernel.dmesg_restrict = 1" >> /etc/sysctl.d/99-integrity.conf

# 8. Restrict perf to root
sysctl -w kernel.perf_event_paranoid=3
echo "kernel.perf_event_paranoid = 3" >> /etc/sysctl.d/99-integrity.conf

echo "=== Hardening complete. Reboot to fully apply boot parameters. ==="
```

## Section 9: Monitoring and Alerting

```yaml
# Prometheus alerting rules for kernel integrity
# /etc/prometheus/rules/kernel-integrity.yml
groups:
  - name: kernel_integrity
    rules:
      - alert: SecureBootDisabled
        expr: node_secureboot_enabled == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Secure Boot is disabled on {{ $labels.instance }}"
          description: "Host {{ $labels.instance }} has Secure Boot disabled. Kernel integrity cannot be guaranteed."

      - alert: KernelLockdownNotEnabled
        expr: node_kernel_lockdown_mode == 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Kernel lockdown not enabled on {{ $labels.instance }}"

      - alert: UnsignedModuleLoaded
        expr: increase(node_kernel_unsigned_module_loads_total[5m]) > 0
        labels:
          severity: critical
        annotations:
          summary: "Unsigned kernel module loaded on {{ $labels.instance }}"
```

```bash
# Custom node_exporter textfile collector for Secure Boot status
cat > /usr/local/bin/secureboot-metrics.sh << 'EOF'
#!/bin/bash
SECURE_BOOT=$(mokutil --sb-state 2>/dev/null | grep -c "enabled" || echo 0)
LOCKDOWN=$(cat /sys/kernel/security/lockdown 2>/dev/null | grep -c "integrity\|confidentiality" || echo 0)

cat << METRICS
# HELP node_secureboot_enabled Secure Boot enforcement status
# TYPE node_secureboot_enabled gauge
node_secureboot_enabled ${SECURE_BOOT}
# HELP node_kernel_lockdown_mode Kernel lockdown mode (0=none, 1=enabled)
# TYPE node_kernel_lockdown_mode gauge
node_kernel_lockdown_mode ${LOCKDOWN}
METRICS
EOF
chmod +x /usr/local/bin/secureboot-metrics.sh

# Run via cron every 5 minutes
echo "*/5 * * * * root /usr/local/bin/secureboot-metrics.sh > /var/lib/node_exporter/textfile_collector/secureboot.prom" \
    > /etc/cron.d/secureboot-metrics
```

## Section 10: Production Checklist

- [ ] UEFI Secure Boot enabled and custom Platform Key enrolled
- [ ] Bootloader and kernel signed with enterprise-owned keys
- [ ] Kernel lockdown mode set to `integrity` (minimum) or `confidentiality`
- [ ] All kernel modules signed; `module.sig_enforce=1` in boot parameters
- [ ] DKMS signing hook configured for third-party modules (NVIDIA, etc.)
- [ ] IMA policy configured to measure executables, libraries, and kernel modules
- [ ] IMA appraisal enabled for root-owned executables
- [ ] EVM enabled in enforce mode with asymmetric keys
- [ ] TPM present and PCR values recorded for baseline attestation
- [ ] Keylime or equivalent attestation agent deployed on all nodes
- [ ] Prometheus alerts firing on Secure Boot disable, lockdown disable, unsigned modules
- [ ] Hardening script applied and tested after each kernel upgrade
- [ ] Incident response playbook for attestation failures documented

## Conclusion

Kernel integrity is not a single feature — it is a chain. Each link (Secure Boot, lockdown, module signing, IMA, EVM, TPM attestation) addresses a different attack vector, and the chain is only as strong as its weakest link. In a container environment, TPM-based attestation extends this chain to the orchestration layer, letting a remote verifier confirm not just that a kernel is intact but that the container runtime and pod admission policies have not been tampered with.

Start with Secure Boot and module signing (the lowest-risk changes), then layer in IMA measurement, then IMA appraisal. Enable lockdown last, as it is the most likely to break third-party software. Invest in monitoring early — silent integrity failures are worse than visible ones.
