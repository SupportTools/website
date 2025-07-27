---
title: "Complete Guide to GPG/PGP Encryption: Implementation, Security, and Enterprise Best Practices"
date: 2025-02-11T10:00:00-05:00
draft: false
tags: ["GPG", "PGP", "Encryption", "Security", "Cryptography", "OpenPGP", "GnuPG", "Digital Signatures", "Key Management", "Linux"]
categories:
- Security
- Cryptography
- Linux
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive technical guide to GPG/PGP encryption covering key generation, message encryption/decryption, digital signatures, enterprise implementation, and advanced security practices"
more_link: "yes"
url: "/gpg-pgp-encryption-comprehensive-guide/"
---

GNU Privacy Guard (GPG) represents the gold standard for asymmetric encryption and digital signature implementation in modern computing environments. This comprehensive guide covers GPG fundamentals, practical implementation strategies, enterprise deployment considerations, and advanced cryptographic security practices for systems administrators and security professionals.

<!--more-->

# [Understanding GPG/PGP Cryptography](#understanding-gpg-pgp-cryptography)

## Cryptographic Foundation

GPG implements the OpenPGP standard (RFC 4880), utilizing asymmetric cryptography principles where each user maintains a mathematically related key pair:

### Public Key Infrastructure
- **Public Key**: Used for encryption and signature verification (freely distributable)
- **Private Key**: Used for decryption and message signing (must remain confidential)
- **Key Fingerprint**: SHA-1 hash providing unique key identification
- **User ID**: Human-readable identification typically containing name and email

### Cryptographic Algorithms

GPG supports multiple cipher suites:
```bash
# Display supported algorithms
gpg --version

# Common configurations:
# RSA: 2048-bit (minimum), 4096-bit (recommended), 8192-bit (maximum security)
# ECC: Curve25519, NIST P-256, NIST P-384, NIST P-521
# Symmetric: AES-256, AES-192, AES-128, ChaCha20
# Hash: SHA-256, SHA-512, SHA-1 (deprecated)
```

## Installation and Environment Setup

### Linux Distribution Installation
```bash
# Debian/Ubuntu
sudo apt update && sudo apt install gnupg2

# RHEL/CentOS/Rocky Linux
sudo dnf install gnupg2

# Arch Linux
sudo pacman -S gnupg

# Verify installation
gpg --version
```

### macOS Installation
```bash
# Homebrew installation
brew install gnupg

# MacPorts installation
sudo port install gnupg2

# Verify GPG suite installation
gpg --version
which gpg
```

### Windows Installation
- Download from: https://www.gnupg.org/download/
- Kleopatra GUI: Included with Gpg4win package
- Command-line tools: Available through WSL or native Windows build

# [Key Generation and Management](#key-generation-management)

## Advanced Key Generation

### Standard Key Generation
```bash
# Interactive key generation
gpg --generate-key

# Full control key generation
gpg --full-generate-key
```

### Batch Key Generation for Automation
```bash
# Create batch configuration file
cat > key-gen-config.txt << EOF
%echo Generating enterprise GPG key
Key-Type: RSA
Key-Length: 4096
Subkey-Type: RSA
Subkey-Length: 4096
Name-Real: Enterprise Security
Name-Comment: Automated key generation
Name-Email: security@example.com
Expire-Date: 2y
Passphrase: $(openssl rand -base64 32)
%commit
%echo Key generation complete
EOF

# Generate key in batch mode
gpg --batch --generate-key key-gen-config.txt
```

### Expert Key Generation with Custom Parameters
```bash
# Expert mode with ECC curves
gpg --expert --full-generate-key

# Generate Ed25519 signing key with Curve25519 encryption subkey
gpg --quick-generate-key "security@example.com" ed25519 sign 2y
gpg --quick-add-key $(gpg --list-secret-keys --with-colons security@example.com | awk -F: '/^fpr:/ {print $10}') cv25519 encrypt 2y
```

## Key Export and Import Operations

### Public Key Distribution
```bash
# Export ASCII-armored public key
gpg --armor --export security@example.com > public-key.asc

# Export binary public key
gpg --export security@example.com > public-key.gpg

# Export specific subkey
gpg --armor --export-subkeys security@example.com > subkeys.asc

# Verify exported key content
gpg --show-keys public-key.asc
```

### Private Key Backup and Recovery
```bash
# Export private key (CRITICAL SECURITY OPERATION)
gpg --armor --export-secret-keys security@example.com > private-key-SECURE.asc

# Export private subkeys only
gpg --armor --export-secret-subkeys security@example.com > private-subkeys.asc

# Import private key
gpg --import private-key-SECURE.asc

# Secure deletion of temporary files
shred -vfz -n 3 private-key-SECURE.asc
```

## Keyserver Operations and Management

### Modern Keyserver Configuration
```bash
# Configure reliable keyserver
mkdir -p ~/.gnupg
cat > ~/.gnupg/dirmngr.conf << EOF
# Primary keyserver (modern, privacy-focused)
keyserver hkps://keys.openpgp.org

# Backup keyservers
keyserver hkps://keyserver.ubuntu.com
keyserver hkps://pgp.mit.edu

# Security settings
keyserver-options timeout=10
keyserver-options import-clean
keyserver-options export-clean
EOF

# Restart dirmngr daemon
gpgconf --kill dirmngr
```

### Key Distribution and Retrieval
```bash
# Upload public key to keyserver
gpg --send-keys KEYID

# Retrieve key by ID
gpg --recv-keys 288DD1632F6E8951

# Search for keys by email (exact match)
gpg --search-keys security@example.com

# Search on specific keyserver
gpg --keyserver hkps://keyserver.ubuntu.com --search-keys "example.com"

# Refresh all keys from keyserver
gpg --refresh-keys
```

### Advanced Key Verification
```bash
# Display key fingerprint
gpg --fingerprint security@example.com

# Show key details with validity
gpg --list-keys --with-colons security@example.com

# Check key signatures
gpg --list-sigs security@example.com

# Verify key against multiple sources
gpg --check-sigs security@example.com
```

# [Message Encryption and Decryption](#message-encryption-decryption)

## Symmetric vs Asymmetric Encryption

### Asymmetric Encryption (Standard GPG)
```bash
# Encrypt file for specific recipient
gpg --armor --encrypt --recipient security@example.com confidential.txt

# Encrypt for multiple recipients
gpg --armor --encrypt \
    --recipient alice@example.com \
    --recipient bob@example.com \
    --recipient security@example.com \
    sensitive-data.txt

# Encrypt and sign simultaneously
gpg --armor --encrypt --sign \
    --recipient security@example.com \
    --local-user sender@example.com \
    important-document.txt
```

### Symmetric Encryption for Personal Use
```bash
# Symmetric encryption with passphrase
gpg --symmetric --armor --cipher-algo AES256 personal-file.txt

# Symmetric encryption with custom compression
gpg --symmetric --armor \
    --cipher-algo AES256 \
    --compress-algo 2 \
    --compress-level 9 \
    large-backup.tar
```

## Advanced Encryption Techniques

### Stream Encryption for Large Files
```bash
# Encrypt large files efficiently
gpg --armor --encrypt --recipient security@example.com \
    --compress-algo 2 --compress-level 6 \
    < large-database-dump.sql > encrypted-dump.sql.asc

# Pipeline encryption
tar -czf - /important/directory | \
gpg --armor --encrypt --recipient security@example.com \
    > encrypted-backup.tar.gz.asc
```

### Batch Encryption Operations
```bash
#!/bin/bash
# Batch encryption script

RECIPIENT="security@example.com"
SOURCE_DIR="/path/to/sensitive/files"
ENCRYPTED_DIR="/path/to/encrypted/output"

mkdir -p "$ENCRYPTED_DIR"

find "$SOURCE_DIR" -type f -name "*.txt" | while read -r file; do
    basename=$(basename "$file")
    gpg --armor --encrypt --recipient "$RECIPIENT" \
        --output "$ENCRYPTED_DIR/${basename}.asc" \
        "$file"
    echo "Encrypted: $basename"
done
```

## Decryption and Verification

### Standard Decryption Operations
```bash
# Decrypt to stdout
gpg --decrypt encrypted-file.asc

# Decrypt to specific file
gpg --decrypt encrypted-file.asc > decrypted-output.txt

# Decrypt with output specification
gpg --output decrypted-file.txt --decrypt encrypted-file.asc

# Batch decryption with verification
gpg --decrypt-files *.asc
```

### Advanced Decryption with Logging
```bash
# Decrypt with detailed logging
gpg --verbose --decrypt \
    --logger-file decryption.log \
    --status-file status.log \
    encrypted-file.asc

# Decrypt with passphrase from file (automation)
echo "passphrase" | gpg --batch --yes \
    --passphrase-fd 0 \
    --decrypt encrypted-file.asc
```

# [Digital Signatures and Verification](#digital-signatures-verification)

## Signature Types and Use Cases

### Clear-text Signatures
```bash
# Create clear-text signature
gpg --clear-sign --local-user security@example.com message.txt

# Verify clear-text signature
gpg --verify message.txt.asc

# Extract original text from clear-signed message
gpg --output original.txt --decrypt message.txt.asc
```

### Detached Signatures
```bash
# Create detached signature
gpg --detach-sign --armor --local-user security@example.com software-release.tar.gz

# Verify detached signature (auto-detect original file)
gpg --verify software-release.tar.gz.asc

# Verify with explicit file specification
gpg --verify software-release.tar.gz.asc software-release.tar.gz

# Create signature with specific hash algorithm
gpg --detach-sign --armor --digest-algo SHA512 \
    --local-user security@example.com \
    critical-update.bin
```

## Enterprise Signature Workflows

### Code Signing Automation
```bash
#!/bin/bash
# Automated code signing script

SIGNING_KEY="code-signing@example.com"
BUILD_DIR="/path/to/build/artifacts"
SIGNATURE_DIR="/path/to/signatures"

mkdir -p "$SIGNATURE_DIR"

# Sign all binary artifacts
find "$BUILD_DIR" -type f \( -name "*.exe" -o -name "*.bin" -o -name "*.tar.gz" \) | while read -r artifact; do
    basename=$(basename "$artifact")
    
    # Create detached signature
    gpg --detach-sign --armor \
        --local-user "$SIGNING_KEY" \
        --output "$SIGNATURE_DIR/${basename}.sig" \
        "$artifact"
    
    # Create SHA256 checksum
    sha256sum "$artifact" > "$SIGNATURE_DIR/${basename}.sha256"
    
    # Sign the checksum file
    gpg --clear-sign --local-user "$SIGNING_KEY" \
        "$SIGNATURE_DIR/${basename}.sha256"
    
    echo "Signed: $basename"
done
```

### Multi-signature Verification
```bash
#!/bin/bash
# Multi-signature verification script

verify_signatures() {
    local file="$1"
    local required_sigs=("security@example.com" "admin@example.com" "release@example.com")
    local valid_sigs=0
    
    for signer in "${required_sigs[@]}"; do
        if gpg --verify "${file}.sig" "$file" 2>&1 | grep -q "$signer"; then
            ((valid_sigs++))
            echo "✓ Valid signature from: $signer"
        else
            echo "✗ Missing or invalid signature from: $signer"
        fi
    done
    
    if [[ $valid_sigs -eq ${#required_sigs[@]} ]]; then
        echo "✓ All required signatures verified"
        return 0
    else
        echo "✗ Signature verification failed ($valid_sigs/${#required_sigs[@]})"
        return 1
    fi
}

# Usage
verify_signatures "critical-release.tar.gz"
```

# [Trust Management and Web of Trust](#trust-management-web-of-trust)

## Trust Levels and Policies

### Understanding Trust Levels
```bash
# Display trust levels
gpg --list-keys --with-colons | grep "^pub" | cut -d: -f2,10

# Trust levels:
# 1 = Unknown (no trust assigned)
# 2 = Invalid (explicitly distrusted)
# 3 = Never (never trust this key)
# 4 = Marginal (some trust)
# 5 = Full (complete trust)
# 6 = Ultimate (your own keys)
```

### Key Signing and Trust Assignment
```bash
# Sign a key locally (non-exportable signature)
gpg --lsign-key user@example.com

# Sign a key for public verification (exportable signature)
gpg --sign-key user@example.com

# Edit key trust level
gpg --edit-key user@example.com
# Commands within edit mode:
# trust (set trust level)
# sign (sign the key)
# save (save changes)
```

### Enterprise Trust Configuration
```bash
# Set automatic trust for organizational keys
cat > ~/.gnupg/auto-trust-config << EOF
# Automatically trust keys from verified sources
auto-key-locate cert pka ldap keyserver
auto-key-retrieve
trust-model tofu+pgp
EOF

# Configure organizational keyring
gpg --import /etc/gnupg/organization-keys.gpg
gpg --edit-key organization@example.com trust quit
```

## Certificate Authority Integration

### LDAP Key Distribution
```bash
# Configure LDAP keyserver for corporate environment
cat >> ~/.gnupg/dirmngr.conf << EOF
# Corporate LDAP keyserver
ldapserver ldap://keys.corp.example.com:389
ldap-timeout 30
ldap-wrapper-program /usr/bin/ldap-wrapper
EOF

# Retrieve keys from LDAP
gpg --auto-key-locate ldap --search-keys user@corp.example.com
```

# [Enterprise Security Implementation](#enterprise-security-implementation)

## Automated Key Management

### Centralized Key Distribution
```python
#!/usr/bin/env python3
"""
Enterprise GPG Key Management System
"""

import gnupg
import subprocess
import json
import logging
from pathlib import Path
from typing import List, Dict, Optional

class EnterpriseGPGManager:
    def __init__(self, gnupg_home: str = "~/.gnupg"):
        self.gpg = gnupg.GPG(gnupghome=gnupg_home)
        self.logger = logging.getLogger(__name__)
        
    def generate_employee_key(self, name: str, email: str, department: str) -> Dict:
        """Generate standardized employee GPG key"""
        key_config = {
            'Key-Type': 'RSA',
            'Key-Length': '4096',
            'Subkey-Type': 'RSA',
            'Subkey-Length': '4096',
            'Name-Real': name,
            'Name-Comment': f'{department} - {email.split("@")[0]}',
            'Name-Email': email,
            'Expire-Date': '2y',
            'Preferences': 'SHA512 SHA384 SHA256 AES256 AES192 AES ZLIB BZIP2 ZIP Uncompressed'
        }
        
        result = self.gpg.gen_key(self.gpg.gen_key_input(**key_config))
        
        if result.fingerprint:
            self.logger.info(f"Generated key for {email}: {result.fingerprint}")
            return {
                'fingerprint': result.fingerprint,
                'email': email,
                'name': name,
                'department': department
            }
        else:
            raise Exception(f"Key generation failed for {email}")
    
    def distribute_public_key(self, fingerprint: str, keyservers: List[str]) -> bool:
        """Distribute public key to multiple keyservers"""
        success_count = 0
        
        for keyserver in keyservers:
            try:
                result = subprocess.run([
                    'gpg', '--keyserver', keyserver, '--send-keys', fingerprint
                ], capture_output=True, text=True, timeout=30)
                
                if result.returncode == 0:
                    success_count += 1
                    self.logger.info(f"Successfully uploaded {fingerprint} to {keyserver}")
                else:
                    self.logger.error(f"Failed to upload to {keyserver}: {result.stderr}")
                    
            except subprocess.TimeoutExpired:
                self.logger.error(f"Timeout uploading to {keyserver}")
        
        return success_count > 0
    
    def backup_private_keys(self, backup_dir: str, encryption_recipient: str) -> None:
        """Secure backup of private keys"""
        backup_path = Path(backup_dir)
        backup_path.mkdir(parents=True, exist_ok=True)
        
        secret_keys = self.gpg.list_keys(True)
        
        for key in secret_keys:
            fingerprint = key['fingerprint']
            email = key['uids'][0]
            
            # Export private key
            private_key = self.gpg.export_keys(fingerprint, True, armor=True)
            
            # Encrypt backup with organizational key
            encrypted_backup = self.gpg.encrypt(
                private_key, 
                recipients=[encryption_recipient],
                armor=True
            )
            
            backup_file = backup_path / f"{fingerprint}-private.asc"
            backup_file.write_text(str(encrypted_backup))
            
            self.logger.info(f"Backed up private key for {email}")

# Configuration management
class GPGConfigManager:
    @staticmethod
    def deploy_enterprise_config(config_dir: str = "~/.gnupg") -> None:
        """Deploy standardized GPG configuration"""
        config_path = Path(config_dir).expanduser()
        config_path.mkdir(mode=0o700, exist_ok=True)
        
        # GPG configuration
        gpg_conf = config_path / "gpg.conf"
        gpg_conf.write_text("""
# Enterprise GPG Configuration
default-key security@example.com
keyserver hkps://keys.openpgp.org
keyserver-options timeout=10
keyserver-options import-clean
keyserver-options export-clean

# Cryptographic preferences
personal-cipher-preferences AES256 AES192 AES
personal-digest-preferences SHA512 SHA384 SHA256
personal-compress-preferences ZLIB BZIP2 ZIP Uncompressed
default-preference-list SHA512 SHA384 SHA256 AES256 AES192 AES ZLIB BZIP2 ZIP Uncompressed

# Security settings
require-cross-certification
no-emit-version
no-comments
use-agent
pinentry-mode loopback

# Display options
list-options show-uid-validity
verify-options show-uid-validity
with-fingerprint
with-key-origin
""")
        
        # dirmngr configuration
        dirmngr_conf = config_path / "dirmngr.conf"
        dirmngr_conf.write_text("""
# Enterprise dirmngr Configuration
keyserver hkps://keys.openpgp.org
keyserver hkps://keyserver.ubuntu.com

# Corporate keyserver (if available)
# ldapserver ldap://keys.corp.example.com:389

# Security settings
honor-http-proxy
disable-http
""")
        
        # Set appropriate permissions
        gpg_conf.chmod(0o600)
        dirmngr_conf.chmod(0o600)

# Example usage
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    
    # Initialize enterprise GPG manager
    gpg_manager = EnterpriseGPGManager()
    
    # Deploy configuration
    GPGConfigManager.deploy_enterprise_config()
    
    # Generate employee key
    employee_key = gpg_manager.generate_employee_key(
        "John Doe",
        "john.doe@example.com",
        "IT Security"
    )
    
    # Distribute to keyservers
    keyservers = [
        "hkps://keys.openpgp.org",
        "hkps://keyserver.ubuntu.com"
    ]
    
    gpg_manager.distribute_public_key(
        employee_key['fingerprint'],
        keyservers
    )
    
    # Backup private keys
    gpg_manager.backup_private_keys(
        "/secure/gpg-backups",
        "backup@example.com"
    )
```

## Secure Communication Protocols

### Email Integration with GPG
```bash
# Configure Mutt with GPG
cat > ~/.muttrc << EOF
# GPG Configuration
set pgp_default_key = "security@example.com"
set pgp_sign_as = "security@example.com"
set pgp_timeout = 300
set pgp_use_gpg_agent = yes
set pgp_autosign = yes
set pgp_autoencrypt = yes
set pgp_replysign = yes
set pgp_replyencrypt = yes

# Key bindings
bind compose p pgp-menu
macro compose Y pfy "send mail without GPG"
EOF

# Thunderbird integration (Enigmail successor)
# Install Thunderbird with built-in OpenPGP support
# Configure via: Account Settings > End-to-End Encryption
```

### Git Commit Signing
```bash
# Configure Git for commit signing
git config --global user.signingkey security@example.com
git config --global commit.gpgsign true
git config --global tag.gpgsign true

# Sign individual commit
git commit -S -m "Signed commit message"

# Verify signed commits
git log --show-signature

# Configure Git hooks for mandatory signing
cat > .git/hooks/pre-commit << 'EOF'
#!/bin/bash
# Ensure all commits are GPG signed

if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
    # Initial commit
    exit 0
fi

# Check if commit is signed
if ! git cat-file commit HEAD | grep -q "gpgsig"; then
    echo "Error: Commit must be GPG signed"
    echo "Use: git commit -S"
    exit 1
fi
EOF

chmod +x .git/hooks/pre-commit
```

## Infrastructure Automation

### Ansible GPG Integration
```yaml
---
# Ansible playbook for GPG deployment
- name: Deploy Enterprise GPG Configuration
  hosts: all
  become: yes
  vars:
    gpg_admin_key: "security@example.com"
    
  tasks:
    - name: Install GPG packages
      package:
        name:
          - gnupg2
          - pinentry-curses
        state: present
    
    - name: Create GPG directory for users
      file:
        path: "/home/{{ item }}/.gnupg"
        state: directory
        mode: '0700'
        owner: "{{ item }}"
        group: "{{ item }}"
      loop: "{{ ansible_users }}"
    
    - name: Deploy GPG configuration
      template:
        src: gpg.conf.j2
        dest: "/home/{{ item }}/.gnupg/gpg.conf"
        mode: '0600'
        owner: "{{ item }}"
        group: "{{ item }}"
      loop: "{{ ansible_users }}"
    
    - name: Import organizational public keys
      shell: |
        sudo -u {{ item }} gpg --import /etc/gpg/org-keys.asc
      loop: "{{ ansible_users }}"
    
    - name: Trust organizational keys
      shell: |
        echo "5" | sudo -u {{ item }} gpg --command-fd 0 --edit-key "{{ gpg_admin_key }}" trust quit
      loop: "{{ ansible_users }}"
```

# [Advanced Security Practices](#advanced-security-practices)

## Hardware Security Modules (HSM)

### YubiKey Integration
```bash
# Install YubiKey tools
sudo apt install yubikey-manager scdaemon

# Generate keys on YubiKey
gpg --card-edit
# Commands:
# admin
# generate (generate keys on card)
# quit

# Move existing keys to YubiKey
gpg --edit-key security@example.com
# Commands:
# keytocard (move primary key)
# key 1 (select subkey)
# keytocard (move subkey)
# save

# Backup encryption key before moving to card
gpg --armor --export-secret-subkeys security@example.com > backup-subkeys.asc
```

### Smart Card Configuration
```bash
# Configure smart card parameters
gpg --card-edit
# Available commands:
# admin - enable admin commands
# passwd - change PIN/Admin PIN
# name - set cardholder name
# url - set URL for public key retrieval
# forcesig - require PIN for each signature
```

## Air-Gapped Key Generation

### Offline Key Ceremony
```bash
#!/bin/bash
# Secure offline key generation script

set -euo pipefail

# Ensure we're on an air-gapped system
if ping -c 1 8.8.8.8 &> /dev/null; then
    echo "ERROR: Network connectivity detected. Disconnect before proceeding."
    exit 1
fi

# Secure random number generation
echo "Generating entropy..."
dd if=/dev/urandom of=/tmp/entropy bs=4096 count=1024
cat /tmp/entropy > /dev/random

# Create temporary GPG home
TEMP_GNUPG=$(mktemp -d)
chmod 700 "$TEMP_GNUPG"
export GNUPGHOME="$TEMP_GNUPG"

# Generate master key
gpg --batch --generate-key << EOF
%echo Generating master key
Key-Type: RSA
Key-Length: 4096
Name-Real: Critical Infrastructure Master Key
Name-Email: master@example.com
Expire-Date: 5y
Passphrase: $(head -c 32 /dev/urandom | base64)
%commit
%echo Master key generation complete
EOF

# Generate subkeys
MASTER_FPR=$(gpg --list-secret-keys --with-colons | awk -F: '/^fpr:/ {print $10}')

# Signing subkey
gpg --quick-add-key "$MASTER_FPR" rsa4096 sign 2y

# Encryption subkey
gpg --quick-add-key "$MASTER_FPR" rsa4096 encrypt 2y

# Authentication subkey
gpg --quick-add-key "$MASTER_FPR" rsa4096 auth 2y

echo "Key ceremony completed. Secure backup required."
```

## Cryptographic Best Practices

### Algorithm Selection
```bash
# Modern cryptographic preferences
cat > ~/.gnupg/gpg.conf << EOF
# Cipher preferences (strongest first)
personal-cipher-preferences AES256 AES192 AES CAMELLIA256 CAMELLIA192 CAMELLIA128

# Digest preferences (strongest first)
personal-digest-preferences SHA512 SHA384 SHA256 SHA224

# Compression preferences
personal-compress-preferences ZLIB BZIP2 ZIP Uncompressed

# Default algorithms for new keys
default-preference-list SHA512 SHA384 SHA256 SHA224 AES256 AES192 AES CAMELLIA256 CAMELLIA192 CAMELLIA128 ZLIB BZIP2 ZIP Uncompressed

# Disable weak algorithms
weak-digest SHA1
EOF
```

### Key Rotation Procedures
```bash
#!/bin/bash
# Automated key rotation script

OLD_KEY="old-key@example.com"
NEW_KEY="new-key@example.com"
KEYSERVERS=("keys.openpgp.org" "keyserver.ubuntu.com")

# Generate new key
echo "Generating new key..."
gpg --quick-generate-key "$NEW_KEY" rsa4096 encrypt,sign 2y

# Cross-sign keys
echo "Cross-signing keys..."
gpg --default-key "$OLD_KEY" --sign-key "$NEW_KEY"
gpg --default-key "$NEW_KEY" --sign-key "$OLD_KEY"

# Create transition statement
cat > transition-statement.txt << EOF
I am transitioning my GPG key from:

Old key: $(gpg --fingerprint "$OLD_KEY" | grep fingerprint | sed 's/.*= //')
New key: $(gpg --fingerprint "$NEW_KEY" | grep fingerprint | sed 's/.*= //')

The old key will remain valid for 90 days for verification purposes.
Please update your keyring and use the new key for future communications.

Transition date: $(date -u)
EOF

# Sign transition statement
gpg --clear-sign --local-user "$OLD_KEY" transition-statement.txt
gpg --detach-sign --local-user "$NEW_KEY" transition-statement.txt.asc

# Upload new key to keyservers
for keyserver in "${KEYSERVERS[@]}"; do
    gpg --keyserver "hkps://$keyserver" --send-keys "$NEW_KEY"
done

echo "Key rotation completed. Distribute transition statement."
```

# [Compliance and Auditing](#compliance-auditing)

## Regulatory Compliance

### FIPS 140-2 Compliance
```bash
# FIPS-compliant GPG configuration
cat > ~/.gnupg/fips-gpg.conf << EOF
# FIPS 140-2 compliant configuration
personal-cipher-preferences AES256 AES192 AES
personal-digest-preferences SHA256 SHA384 SHA512
personal-compress-preferences ZLIB BZIP2 ZIP Uncompressed

# Disable non-FIPS algorithms
disable-cipher-algo CAST5
disable-cipher-algo BLOWFISH
disable-cipher-algo TWOFISH
disable-pubkey-algo DSA
disable-digest-algo MD5
disable-digest-algo SHA1
EOF
```

### SOC 2 Key Management Controls
```python
#!/usr/bin/env python3
"""
SOC 2 Compliance Monitoring for GPG Key Management
"""

import subprocess
import json
import datetime
from typing import Dict, List

class SOC2GPGAuditor:
    def __init__(self):
        self.audit_log = []
        
    def check_key_expiration(self) -> Dict:
        """Monitor key expiration for SOC 2 compliance"""
        result = subprocess.run(['gpg', '--list-keys', '--with-colons'], 
                              capture_output=True, text=True)
        
        keys_expiring = []
        current_date = datetime.datetime.now()
        
        for line in result.stdout.split('\n'):
            if line.startswith('pub:'):
                fields = line.split(':')
                if len(fields) > 6 and fields[6]:
                    exp_date = datetime.datetime.fromtimestamp(int(fields[6]))
                    days_to_expire = (exp_date - current_date).days
                    
                    if days_to_expire <= 30:
                        keys_expiring.append({
                            'key_id': fields[4],
                            'expiration': exp_date.isoformat(),
                            'days_remaining': days_to_expire
                        })
        
        audit_entry = {
            'timestamp': current_date.isoformat(),
            'check_type': 'key_expiration',
            'keys_expiring': keys_expiring,
            'compliance_status': 'WARNING' if keys_expiring else 'PASS'
        }
        
        self.audit_log.append(audit_entry)
        return audit_entry
    
    def verify_key_strengths(self) -> Dict:
        """Verify cryptographic strength compliance"""
        result = subprocess.run(['gpg', '--list-keys', '--with-colons'], 
                              capture_output=True, text=True)
        
        weak_keys = []
        
        for line in result.stdout.split('\n'):
            if line.startswith('pub:'):
                fields = line.split(':')
                key_length = int(fields[2]) if fields[2] else 0
                algorithm = fields[3]
                
                # Check for minimum key strength
                if algorithm == '1' and key_length < 2048:  # RSA
                    weak_keys.append({
                        'key_id': fields[4],
                        'algorithm': 'RSA',
                        'length': key_length,
                        'minimum_required': 2048
                    })
        
        audit_entry = {
            'timestamp': datetime.datetime.now().isoformat(),
            'check_type': 'key_strength',
            'weak_keys': weak_keys,
            'compliance_status': 'FAIL' if weak_keys else 'PASS'
        }
        
        self.audit_log.append(audit_entry)
        return audit_entry
    
    def generate_compliance_report(self) -> str:
        """Generate comprehensive compliance report"""
        report = {
            'report_date': datetime.datetime.now().isoformat(),
            'auditor': 'SOC2GPGAuditor',
            'checks_performed': len(self.audit_log),
            'audit_log': self.audit_log
        }
        
        return json.dumps(report, indent=2)

# Example usage
if __name__ == "__main__":
    auditor = SOC2GPGAuditor()
    
    # Perform compliance checks
    expiration_check = auditor.check_key_expiration()
    strength_check = auditor.verify_key_strengths()
    
    # Generate report
    compliance_report = auditor.generate_compliance_report()
    
    # Save report
    with open(f"gpg_compliance_report_{datetime.datetime.now().strftime('%Y%m%d')}.json", 'w') as f:
        f.write(compliance_report)
```

## Incident Response Procedures

### Key Compromise Response
```bash
#!/bin/bash
# GPG Key Compromise Response Script

COMPROMISED_KEY="$1"
EMERGENCY_CONTACT="security@example.com"

if [[ -z "$COMPROMISED_KEY" ]]; then
    echo "Usage: $0 <compromised-key-id>"
    exit 1
fi

echo "INCIDENT: GPG Key Compromise Response Initiated"
echo "Compromised Key: $COMPROMISED_KEY"
echo "Timestamp: $(date -u)"

# 1. Revoke the compromised key
echo "Step 1: Generating revocation certificate..."
gpg --output "revoke-${COMPROMISED_KEY}.asc" \
    --gen-revoke "$COMPROMISED_KEY"

# 2. Import and publish revocation
echo "Step 2: Publishing revocation certificate..."
gpg --import "revoke-${COMPROMISED_KEY}.asc"
gpg --send-keys "$COMPROMISED_KEY"

# 3. Generate incident report
cat > "incident-report-${COMPROMISED_KEY}.txt" << EOF
GPG KEY COMPROMISE INCIDENT REPORT

Incident ID: GPG-$(date +%Y%m%d-%H%M%S)
Date/Time: $(date -u)
Compromised Key: $COMPROMISED_KEY
Response Action: Key revoked and revocation published

Key Details:
$(gpg --list-key "$COMPROMISED_KEY")

Response Actions Taken:
1. Revocation certificate generated
2. Key revoked in local keyring
3. Revocation published to keyservers
4. Incident report generated

Next Steps Required:
1. Notify all users of key compromise
2. Generate replacement key if needed
3. Update any automated systems using this key
4. Review access logs for unauthorized usage
EOF

# 4. Notify security team
echo "Step 3: Notifying security team..."
gpg --encrypt --armor --recipient "$EMERGENCY_CONTACT" \
    --output "incident-report-${COMPROMISED_KEY}.asc" \
    "incident-report-${COMPROMISED_KEY}.txt"

echo "Key compromise response completed."
echo "Incident report: incident-report-${COMPROMISED_KEY}.txt"
echo "Encrypted report: incident-report-${COMPROMISED_KEY}.asc"
```

This comprehensive guide provides enterprise-grade GPG implementation strategies, ensuring robust cryptographic security for modern infrastructure environments. Regular training, proper key management, and adherence to security best practices ensure effective protection of sensitive communications and data integrity.