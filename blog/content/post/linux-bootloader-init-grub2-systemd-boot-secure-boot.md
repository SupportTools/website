---
title: "Linux Bootloader and Init: GRUB2, systemd-boot, systemd-nspawn, and Secure Boot"
date: 2030-04-17T00:00:00-05:00
draft: false
tags: ["Linux", "GRUB2", "systemd-boot", "Secure Boot", "systemd-nspawn", "TPM", "Boot"]
categories: ["Linux", "Systems Administration"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Linux boot infrastructure: GRUB2 configuration and rescue, Unified Kernel Image with systemd-boot, Secure Boot signing with sbsign, systemd-nspawn containers, and TPM-based measured boot with PCR policies."
more_link: "yes"
url: "/linux-bootloader-init-grub2-systemd-boot-secure-boot/"
---

The Linux boot process is a chain of trust. From the moment the CPU fetches its first instruction from firmware through the loading of `init`, every component either validates the next or passes control without verification. Modern enterprises require both: they need the flexibility to manage boot configuration across diverse hardware while ensuring that only signed, verified software runs in production. This guide covers GRUB2 for legacy and UEFI systems, the Unified Kernel Image (UKI) format with systemd-boot, Secure Boot signing chains, systemd-nspawn for lightweight container isolation, and TPM-based measured boot for hardware-attested system integrity.

<!--more-->

## The Linux Boot Sequence

Understanding the boot sequence is prerequisite to modifying any part of it:

```
Power on
    |
    v
UEFI/BIOS firmware
    |-- POST (Power-On Self Test)
    |-- Enumerate hardware
    |-- Find bootable device (EFI System Partition or MBR)
    |
    v
Bootloader (GRUB2 or systemd-boot)
    |-- Load kernel image
    |-- Load initramfs
    |-- Pass kernel command line
    |
    v
Kernel initialization
    |-- Decompress itself
    |-- Initialize memory management, CPU, devices
    |-- Mount initramfs as root
    |
    v
initramfs (/init or systemd in initrd)
    |-- Load modules for root device
    |-- Decrypt/assemble RAID/LVM if needed
    |-- Mount real root filesystem
    |-- Pivot_root or switch_root
    |
    v
/sbin/init (PID 1) = systemd
    |-- Read /etc/systemd/system/default.target
    |-- Activate all required units
    |
    v
Login prompt / services running
```

## GRUB2 Configuration

GRUB2 (GRand Unified Bootloader version 2) is the most widely deployed Linux bootloader. It supports UEFI and legacy BIOS, and can boot Linux, Windows, and other operating systems.

### GRUB2 File Layout

```bash
# UEFI systems
ls /boot/efi/EFI/
# ubuntu/  debian/  BOOT/

ls /boot/efi/EFI/ubuntu/
# grub.cfg  grubx64.efi  shimx64.efi  mmx64.efi

# GRUB configuration
ls /boot/grub/
# grub.cfg        - generated (do not edit directly)
# grubenv         - GRUB environment block
# fonts/          - GRUB fonts
# i386-pc/        - BIOS modules
# x86_64-efi/     - UEFI modules

# Configuration sources (edit these)
ls /etc/grub.d/
# 00_header    05_debian_theme  10_linux  20_linux_xen
# 30_os-prober 40_custom        41_custom

# GRUB defaults
cat /etc/default/grub
```

### /etc/default/grub Configuration

```bash
# /etc/default/grub - main configuration file

# Default boot entry (0-indexed or name)
GRUB_DEFAULT=0

# Seconds to wait before booting default (set to 0 for headless servers)
GRUB_TIMEOUT=5
GRUB_TIMEOUT_STYLE=menu   # hidden|countdown|menu

# Kernel command line parameters (added to all entries)
GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"
GRUB_CMDLINE_LINUX=""

# Kernel parameters for production servers:
# GRUB_CMDLINE_LINUX="console=ttyS0,115200n8 console=tty0 \
#   transparent_hugepage=madvise \
#   numa=off \
#   intel_idle.max_cstate=1 \
#   processor.max_cstate=1 \
#   nohz_full=1-$(nproc --ignore=1) \
#   rcu_nocbs=1-$(nproc --ignore=1) \
#   isolcpus=1-$(nproc --ignore=1) \
#   mitigations=off"

# Enable serial console (for remote management/VMs)
GRUB_TERMINAL="console serial"
GRUB_SERIAL_COMMAND="serial --speed=115200 --unit=0 --word=8 --parity=no --stop=1"

# Recovery mode
GRUB_DISABLE_RECOVERY="false"

# OS prober (disable on hypervisors to avoid detecting VMs as OSes)
GRUB_DISABLE_OS_PROBER="true"

# After editing, always regenerate:
# sudo update-grub   (Debian/Ubuntu)
# sudo grub2-mkconfig -o /boot/grub2/grub.cfg  (RHEL/Fedora)
```

### Custom GRUB2 Menu Entry

```bash
# /etc/grub.d/40_custom - add custom boot entries

#!/bin/sh
exec tail -n +3 $0

# Custom entry with debug kernel
menuentry "Linux 6.8.0 (Debug Mode)" --class linux {
    load_video
    set gfxpayload=keep
    insmod gzio
    insmod part_gpt
    insmod ext2
    set root='hd0,gpt2'
    linux   /boot/vmlinuz-6.8.0-generic \
            root=UUID=<your-root-uuid> \
            ro \
            console=ttyS0,115200n8 \
            loglevel=7 \
            debug \
            nokaslr \
            nosmp \
            earlycon=ttyS0,115200
    initrd  /boot/initrd.img-6.8.0-generic
}

# Entry for netboot
menuentry "Netboot PXE" {
    insmod pxe
    pxe_default_server 10.0.0.1
    if pxe_retrieve_config; then
        pxe_boot
    fi
}
```

### GRUB2 Rescue Shell

When GRUB fails to boot, it drops to the rescue shell. Knowing how to use it is essential for disaster recovery:

```bash
# GRUB rescue shell prompt: grub rescue>
# Normal GRUB shell prompt: grub>

# List available disks and partitions
grub rescue> ls
# (hd0) (hd0,gpt1) (hd0,gpt2) (hd0,gpt3)

# List files in a partition
grub rescue> ls (hd0,gpt2)/
# boot/ etc/ home/ var/ ...

# If grub files are missing, load them manually
grub rescue> set prefix=(hd0,gpt2)/boot/grub
grub rescue> set root=(hd0,gpt2)
grub rescue> insmod normal
grub rescue> normal

# In normal GRUB shell, boot manually:
grub> set root=(hd0,gpt2)
grub> linux /boot/vmlinuz-6.8.0-generic root=/dev/sda2 ro
grub> initrd /boot/initrd.img-6.8.0-generic
grub> boot

# After successful boot, reinstall GRUB
sudo grub-install /dev/sda       # BIOS
sudo grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=ubuntu  # UEFI
sudo update-grub
```

### GRUB2 Environment Block

The GRUB environment block (`/boot/grub/grubenv`) provides persistent storage across reboots, commonly used for boot counting:

```bash
# Read the environment block
sudo grub-editenv /boot/grub/grubenv list

# Set variables
sudo grub-editenv /boot/grub/grubenv set boot_success=0
sudo grub-editenv /boot/grub/grubenv set boot_indeterminate=0

# Check with grub-editenv
sudo grub-editenv - list
# boot_success=1

# Implement boot counting in /etc/grub.d/99_bootcount:
cat << 'GRUBSCRIPT'
if [ "${boot_success}" = "1" ]; then
    set saved_entry="${default}"
    save_env saved_entry
    set boot_indeterminate=0
else
    if [ "${boot_indeterminate}" = "1" ]; then
        set default="${saved_entry}"
        set boot_indeterminate=0
    else
        set boot_indeterminate=1
    fi
fi
save_env boot_indeterminate
GRUBSCRIPT
```

## systemd-boot (bootctl)

systemd-boot (formerly gummiboot) is a minimal UEFI bootloader that reads configuration from the EFI System Partition. It is simpler than GRUB2, supports only UEFI, and integrates naturally with systemd's boot infrastructure.

### Installing systemd-boot

```bash
# Check if UEFI is available
ls /sys/firmware/efi && echo "UEFI system" || echo "BIOS system"

# Install systemd-boot to EFI
sudo bootctl install
# This creates:
# /boot/efi/EFI/systemd/systemd-bootx64.efi
# /boot/efi/EFI/BOOT/BOOTX64.EFI (fallback)
# /boot/efi/loader/loader.conf    (main config)
# /boot/efi/loader/entries/       (boot entries)

# Verify installation
bootctl status
```

### loader.conf Configuration

```ini
# /boot/efi/loader/loader.conf

# Default entry (glob pattern or specific file)
default @saved        # use last successfully booted entry
# default linux-*.conf  # glob match

# Timeout in seconds (0 = boot immediately, -1 = menu always)
timeout 3

# Console resolution
console-mode max      # auto|keep|max|<number>

# Editor for kernel parameters (disable for security in production)
editor no

# Auto-enroll keys from /boot/efi/loader/keys/ for Secure Boot
# Requires manual enrollment: secureboot-keys
secure-boot-enroll if-safe
```

### Boot Entry Format

```ini
# /boot/efi/loader/entries/linux-6.8.0.conf

title   Linux 6.8.0 Production
linux   /vmlinuz-6.8.0-generic
initrd  /initrd.img-6.8.0-generic
options root=UUID=<your-root-uuid> rw quiet splash \
        console=ttyS0,115200n8 \
        transparent_hugepage=madvise

# Version used for sorting (higher = preferred)
version 6.8.0

# Machine ID for uniqueness
machine-id <your-machine-id>

# Sort by version (not filename) when using default @saved
sort-key 6.8.0
```

### bootctl Commands

```bash
# Show current boot status
bootctl status

# List available entries
bootctl list

# Set default entry
bootctl set-default linux-6.8.0.conf

# Set one-time boot entry
bootctl set-oneshot recovery.conf

# Update systemd-boot itself
sudo bootctl update

# Show firmware entries
bootctl --firmware-setup
```

## Unified Kernel Image (UKI)

A UKI is a single UEFI executable that bundles the kernel, initramfs, kernel command line, and OS release information. It enables Secure Boot signing of the entire boot chain in one signature operation and prevents tampering with individual components.

### UKI Structure

```
Unified Kernel Image (.efi)
+---------------------+
| UEFI PE/COFF header |
+---------------------+
| .osrel section      |  /etc/os-release content
| .cmdline section    |  Kernel command line (baked in)
| .dtb section        |  Device tree blob (ARM/RISC-V)
| .uname section      |  Kernel version string
| .splash section     |  Boot splash image
| .linux section      |  Kernel image (vmlinuz)
| .initrd section     |  initramfs cpio archive
+---------------------+
| UEFI signature      |  Authenticode/PKCS7 signature
+---------------------+
```

### Building a UKI with ukify

```bash
# Install systemd tools
apt-get install -y systemd-ukify binutils

# Build a UKI
ukify build \
    --linux /boot/vmlinuz-6.8.0-generic \
    --initrd /boot/initrd.img-6.8.0-generic \
    --cmdline "root=UUID=<your-root-uuid> rw quiet splash" \
    --os-release @/etc/os-release \
    --uname $(uname -r) \
    --output /boot/efi/EFI/Linux/linux-6.8.0.efi

# Install the UKI for systemd-boot (auto-detected from /EFI/Linux/)
ls /boot/efi/EFI/Linux/
# linux-6.8.0.efi

# systemd-boot automatically discovers UKIs in /EFI/Linux/
bootctl list
```

### Building a UKI Manually with objcopy

```bash
#!/usr/bin/env bash
# build-uki.sh - Build Unified Kernel Image manually

set -euo pipefail

KERNEL=/boot/vmlinuz-$(uname -r)
INITRD=/boot/initrd.img-$(uname -r)
CMDLINE="root=UUID=$(findmnt -n -o UUID /) rw quiet"
OUTPUT=/boot/efi/EFI/Linux/linux-$(uname -r).efi
STUB=/usr/lib/systemd/boot/efi/linuxx64.efi.stub  # systemd EFI stub

# Write kernel command line to temp file
TMPDIR=$(mktemp -d)
trap "rm -rf ${TMPDIR}" EXIT

echo -n "${CMDLINE}" > "${TMPDIR}/cmdline.txt"
cp /etc/os-release "${TMPDIR}/os-release"

# Compute section offsets (must be page-aligned)
ALIGN=4096

get_size() {
    stat -c %s "$1"
}

OSREL_SIZE=$(get_size "${TMPDIR}/os-release")
CMDLINE_SIZE=$(get_size "${TMPDIR}/cmdline.txt")
LINUX_SIZE=$(get_size "${KERNEL}")
INITRD_SIZE=$(get_size "${INITRD}")

# Build the UKI using objcopy
objcopy \
    --add-section .osrel="${TMPDIR}/os-release"         --change-section-vma .osrel=0x20000 \
    --add-section .cmdline="${TMPDIR}/cmdline.txt"      --change-section-vma .cmdline=0x30000 \
    --add-section .linux="${KERNEL}"                    --change-section-vma .linux=0x2000000 \
    --add-section .initrd="${INITRD}"                   --change-section-vma .initrd=0x3000000 \
    "${STUB}" \
    "${OUTPUT}"

echo "UKI built: ${OUTPUT} ($(du -h ${OUTPUT} | cut -f1))"
```

## Secure Boot Signing

Secure Boot ensures only signed code runs before the kernel takes control. The chain of trust is:

```
UEFI Platform Key (PK)        - manufacturer root key
    |
    v
Key Exchange Key (KEK)         - Microsoft or vendor key
    |
    v
Signature Database (db)        - allowed signatures
    |-- Microsoft CA cert
    |-- Your custom signing cert
    |
Forbidden Signatures (dbx)     - revoked keys/hashes
```

### Creating Your Own Secure Boot Keys

```bash
# Install signing tools
apt-get install -y sbsigntools efitools openssl

# Create output directory
mkdir -p /etc/secureboot/keys
cd /etc/secureboot/keys

# Generate Platform Key (PK) - root of trust
openssl req -new -x509 -newkey rsa:4096 -nodes \
    -subj "/CN=Platform Key/O=My Organization" \
    -keyout PK.key -out PK.crt \
    -days 3650

# Generate Key Exchange Key (KEK)
openssl req -new -x509 -newkey rsa:4096 -nodes \
    -subj "/CN=Key Exchange Key/O=My Organization" \
    -keyout KEK.key -out KEK.crt \
    -days 3650

# Generate Database Key (db) - used for signing
openssl req -new -x509 -newkey rsa:4096 -nodes \
    -subj "/CN=Signing Key/O=My Organization" \
    -keyout db.key -out db.crt \
    -days 3650

# Convert certificates to EFI signature list format
cert-to-efi-sig-list -g "$(uuidgen)" PK.crt PK.esl
cert-to-efi-sig-list -g "$(uuidgen)" KEK.crt KEK.esl
cert-to-efi-sig-list -g "$(uuidgen)" db.crt db.esl

# Create signed auth files for enrollment
sign-efi-sig-list -k PK.key -c PK.crt PK PK.esl PK.auth
sign-efi-sig-list -k PK.key -c PK.crt KEK KEK.esl KEK.auth
sign-efi-sig-list -k KEK.key -c KEK.crt db db.esl db.auth

echo "Keys created in /etc/secureboot/keys/"
ls -la /etc/secureboot/keys/
```

### Signing a Kernel or UKI

```bash
# Sign the bootloader (shim or systemd-boot)
sbsign \
    --key /etc/secureboot/keys/db.key \
    --cert /etc/secureboot/keys/db.crt \
    --output /boot/efi/EFI/systemd/systemd-bootx64.efi.signed \
    /boot/efi/EFI/systemd/systemd-bootx64.efi

# Sign a UKI
sbsign \
    --key /etc/secureboot/keys/db.key \
    --cert /etc/secureboot/keys/db.crt \
    --output /boot/efi/EFI/Linux/linux-6.8.0-signed.efi \
    /boot/efi/EFI/Linux/linux-6.8.0.efi

# Verify signature
sbverify --cert /etc/secureboot/keys/db.crt \
    /boot/efi/EFI/Linux/linux-6.8.0-signed.efi

# Sign kernel directly (if not using UKI)
sbsign \
    --key /etc/secureboot/keys/db.key \
    --cert /etc/secureboot/keys/db.crt \
    --output /boot/vmlinuz-6.8.0-signed \
    /boot/vmlinuz-6.8.0-generic
```

### Automating Kernel Signing with a dpkg/kernel Hook

```bash
# /etc/kernel/postinst.d/sign-kernel - auto-sign new kernels
cat << 'HOOK' | sudo tee /etc/kernel/postinst.d/sign-kernel
#!/bin/bash
# Auto-sign new kernels for Secure Boot
KERNEL_VERSION="${1}"
KERNEL_IMAGE="/boot/vmlinuz-${KERNEL_VERSION}"

if [ ! -f "${KERNEL_IMAGE}" ]; then
    echo "Kernel image not found: ${KERNEL_IMAGE}"
    exit 1
fi

# Sign the kernel
sbsign \
    --key /etc/secureboot/keys/db.key \
    --cert /etc/secureboot/keys/db.crt \
    --output "${KERNEL_IMAGE}.signed" \
    "${KERNEL_IMAGE}"

mv "${KERNEL_IMAGE}.signed" "${KERNEL_IMAGE}"
echo "Signed kernel: ${KERNEL_IMAGE}"

# Rebuild UKI if ukify is available
if command -v ukify >/dev/null 2>&1; then
    ukify build \
        --linux "${KERNEL_IMAGE}" \
        --initrd "/boot/initrd.img-${KERNEL_VERSION}" \
        --cmdline "$(cat /proc/cmdline)" \
        --output "/boot/efi/EFI/Linux/linux-${KERNEL_VERSION}.efi"
    
    sbsign \
        --key /etc/secureboot/keys/db.key \
        --cert /etc/secureboot/keys/db.crt \
        --output "/boot/efi/EFI/Linux/linux-${KERNEL_VERSION}.efi" \
        "/boot/efi/EFI/Linux/linux-${KERNEL_VERSION}.efi"
    
    echo "Built and signed UKI: linux-${KERNEL_VERSION}.efi"
fi
HOOK

chmod +x /etc/kernel/postinst.d/sign-kernel
```

## systemd-nspawn: Lightweight Containers

systemd-nspawn is a container manager built into systemd. Unlike Docker, it does not require a daemon, uses standard Linux namespaces, and integrates directly with systemd's unit system. It is ideal for distribution testing, build environments, and sandboxed services.

### Basic systemd-nspawn Usage

```bash
# Bootstrap a Debian container
apt-get install -y debootstrap systemd-container

# Create a minimal Debian bookworm container
sudo debootstrap bookworm /var/lib/machines/debian-test \
    http://deb.debian.org/debian

# Boot the container
sudo systemd-nspawn -D /var/lib/machines/debian-test --boot

# Or run a single command
sudo systemd-nspawn -D /var/lib/machines/debian-test \
    /bin/bash -c "apt-get update && apt-get install -y nginx"

# Run with networking
sudo systemd-nspawn -D /var/lib/machines/debian-test \
    --network-veth \
    --resolv-conf=replace-stub \
    --boot
```

### systemd-nspawn as a Service (machinectl)

```bash
# Register and manage containers with machinectl
sudo machinectl enable debian-test    # enable auto-start
sudo machinectl start debian-test     # start the container
sudo machinectl status debian-test    # check status
sudo machinectl login debian-test     # get a console
sudo machinectl shell debian-test     # open a shell

# List running containers
machinectl list

# Transfer files into/out of containers
machinectl copy-to debian-test /etc/myapp.conf /etc/myapp.conf
machinectl copy-from debian-test /var/log/app.log ./app.log
```

### Container Configuration Files

```ini
# /etc/systemd/nspawn/myapp.nspawn

[Exec]
# Boot as full init system
Boot=yes

# Run as specific user
User=appuser

# Environment variables
Environment=APP_ENV=production
Environment=DATABASE_URL=postgresql://localhost:5432/myapp

[Files]
# Bind-mount data directory
BindReadOnly=/etc/ssl/certs
Bind=/var/data/myapp:/data

# Read-only overlay
OverlayReadOnly=/usr

[Network]
# Private network with veth pair
VirtualEthernet=yes
# Map container port to host port
Port=tcp:8080:8080
# Connect to a bridge for multi-container networking
Bridge=br0
```

```bash
# /etc/systemd/system/systemd-nspawn@myapp.service
# This is the template unit for nspawn containers
# Enable and start with:
sudo systemctl enable systemd-nspawn@myapp
sudo systemctl start systemd-nspawn@myapp
```

### Build Container Pattern

```bash
#!/usr/bin/env bash
# build-in-container.sh - Build software in an isolated nspawn container

set -euo pipefail

CONTAINER_NAME="build-$(date +%Y%m%d-%H%M%S)"
BUILD_DIR="${1:?Usage: $0 <source-dir>}"
OUTPUT_DIR="${2:-$(pwd)/artifacts}"

# Create ephemeral build container
sudo debootstrap bookworm "/tmp/${CONTAINER_NAME}" \
    http://deb.debian.org/debian 2>/dev/null

# Install build dependencies
sudo systemd-nspawn -D "/tmp/${CONTAINER_NAME}" \
    apt-get install -y --no-install-recommends \
    build-essential golang-go git ca-certificates

# Copy source into container
sudo cp -r "${BUILD_DIR}" "/tmp/${CONTAINER_NAME}/src"

# Run the build
sudo systemd-nspawn -D "/tmp/${CONTAINER_NAME}" \
    --setenv=GOPATH=/go \
    --setenv=CGO_ENABLED=0 \
    /bin/bash -c "cd /src && go build -o /artifacts/app ./..."

# Extract artifacts
mkdir -p "${OUTPUT_DIR}"
sudo cp "/tmp/${CONTAINER_NAME}/artifacts/"* "${OUTPUT_DIR}/"
sudo chown -R $(id -u):$(id -g) "${OUTPUT_DIR}"

# Clean up
sudo rm -rf "/tmp/${CONTAINER_NAME}"

echo "Build complete. Artifacts in ${OUTPUT_DIR}/"
```

## TPM-Based Measured Boot

Trusted Platform Module (TPM) chips record measurements (hashes) of each component in the boot chain into Platform Configuration Registers (PCRs). This enables attestation (proving what software ran) and sealing (storing secrets accessible only when specific software runs).

### PCR Layout

```
PCR 0:  Firmware (UEFI) executable code
PCR 1:  Firmware configuration
PCR 2:  Option ROM code
PCR 3:  Option ROM configuration
PCR 4:  IPL (bootloader) code - GRUB/systemd-boot
PCR 5:  IPL configuration
PCR 6:  State transitions / wake events
PCR 7:  Secure Boot state and certificates
PCR 8:  GRUB command line / kernel command line (if using GRUB-TPM)
PCR 9:  GRUB module list
PCR 10: IMA (Integrity Measurement Architecture)
PCR 11: systemd EFI stub measurements
PCR 12: Kernel command line (in UKI)
PCR 13: systemd boot extensions
PCR 14: MOK (Machine Owner Key) certificates
PCR 15: Scratch register (available for userspace)
```

### Reading PCR Values

```bash
# Check TPM availability
ls /dev/tpm* /dev/tpmrm*
# /dev/tpm0   /dev/tpmrm0

# Install TPM tools
apt-get install -y tpm2-tools

# Read all PCR values
tpm2_pcrread

# Read specific PCRs
tpm2_pcrread sha256:0,4,7,11,12

# Check if PCR values match expected (for attestation)
tpm2_pcrread sha256:7 | grep -A1 "7:"
```

### Sealing a Secret to PCR Values

```bash
# Seal a disk encryption key to specific PCR values
# The key is only accessible when the exact same software runs

# Create a policy that requires PCR 7 (Secure Boot) and PCR 11 (kernel)
tpm2_startauthsession --policy-session -S session.ctx

tpm2_policypcr \
    --pcr-list="sha256:7,11" \
    -S session.ctx \
    -L policy.dat

tpm2_flushcontext session.ctx

# Create the key object bound to this policy
tpm2_createprimary -C o -g sha256 -G rsa -c primary.ctx

# Seal the secret (e.g., LUKS passphrase)
echo -n "my-disk-encryption-passphrase" > secret.txt

tpm2_create \
    --parent-context=primary.ctx \
    --policy=policy.dat \
    --attributes="fixedtpm|fixedparent" \
    --sealing-input=secret.txt \
    --public=sealed.pub \
    --private=sealed.priv

# Store sealed object in TPM NVRAM
tpm2_load -C primary.ctx \
    --public=sealed.pub \
    --private=sealed.priv \
    --name=sealed.name \
    -c sealed.ctx

# Retrieve the secret (only works when PCRs match the policy)
tpm2_startauthsession --policy-session -S unseal-session.ctx

tpm2_policypcr \
    --pcr-list="sha256:7,11" \
    -S unseal-session.ctx

tpm2_unseal \
    -c sealed.ctx \
    -p session:unseal-session.ctx

tpm2_flushcontext unseal-session.ctx
```

### systemd-cryptenroll for LUKS + TPM

systemd-cryptenroll provides a high-level interface for binding LUKS volumes to the TPM:

```bash
# Enroll LUKS volume with TPM2 and PCR policy
# PCR 7: Secure Boot state
# PCR 11: systemd EFI stub
# PCR 12: Kernel command line (baked into UKI)
systemd-cryptenroll \
    --tpm2-device=auto \
    --tpm2-pcrs=7+11+12 \
    /dev/sda3  # LUKS device

# With recovery PIN as fallback
systemd-cryptenroll \
    --tpm2-device=auto \
    --tpm2-pcrs=7+11+12 \
    --tpm2-with-pin=yes \
    /dev/sda3

# List enrolled keys
systemd-cryptenroll /dev/sda3

# Enable automatic unlock in /etc/crypttab
# /dev/sda3: cryptroot UUID=<luks-uuid> none \
#   tpm2-device=auto,tpm2-pcrs=7+11+12

# Update PCR policy when kernel changes
# (run after updating the UKI and re-signing)
systemd-cryptenroll \
    --wipe-slot=tpm2 \
    --tpm2-device=auto \
    --tpm2-pcrs=7+11+12 \
    /dev/sda3
```

### Remote Attestation Workflow

```bash
# Remote attestation: prove to a remote server that this machine
# is running known-good software

# 1. Get the TPM's endorsement key certificate
tpm2_getekcertificate -o ek.crt

# 2. Create attestation key (AK)
tpm2_createek -c ek.ctx -G rsa -u ek.pub
tpm2_createak -C ek.ctx -c ak.ctx -u ak.pub -n ak.name

# 3. Get a quote (signed PCR values)
tpm2_quote \
    --key-context=ak.ctx \
    --pcr-list="sha256:0,1,4,7,11,12" \
    --message=quote.message \
    --signature=quote.signature \
    --pcrs=quote.pcrs \
    --hash-algorithm=sha256

# 4. Send ek.pub, ak.pub, quote.message, quote.signature, quote.pcrs
#    to the attestation server for verification

# 5. Attestation server verifies:
#    - AK was created under a valid EK (privacy CA)
#    - Quote signature is valid
#    - PCR values match the golden reference
#    - Returns a token if all checks pass
```

## Key Takeaways

The Linux boot stack has evolved significantly: GRUB2 remains dominant for its flexibility and broad hardware support, while systemd-boot with UKI provides a cleaner model for UEFI-only systems that want tight Secure Boot integration.

**GRUB2** is the right choice when you need: multi-OS booting, BIOS compatibility, complex pre-boot scripting, or PXE boot. The environment block enables boot counting and A/B update schemes.

**systemd-boot with UKI** is the right choice when you need: maximum Secure Boot integrity (single signed artifact), minimal attack surface, or automated provisioning systems. Baking the kernel command line into the UKI prevents runtime tampering.

**Secure Boot** is meaningless without a complete chain of trust. Self-signed keys that you own and manage are more secure than relying on Microsoft's signing service, but require more operational overhead. The `sbsign` / `ukify` workflow described here is production-ready for managed fleets.

**systemd-nspawn** fills the niche between a chroot and a full container runtime. It is ideal for build isolation, distribution testing, and sandboxed services that need systemd-unit integration without the complexity of a container orchestrator.

**TPM measured boot** + `systemd-cryptenroll` enables encrypted root filesystems that automatically unlock only when the correct firmware, bootloader, kernel, and command line are present — without requiring a network call to a key server. This is the strongest available protection against offline disk attacks.
