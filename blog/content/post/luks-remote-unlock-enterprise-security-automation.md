---
title: "Enterprise LUKS Remote Unlock and Full Disk Encryption: Advanced Security Automation and Remote Management for Production Systems"
date: 2025-04-29T10:00:00-05:00
draft: false
tags: ["LUKS", "Full Disk Encryption", "Remote Unlock", "Dropbear", "Security", "Enterprise", "Linux", "Cryptography", "SSH", "Automation"]
categories:
- Security
- Enterprise Infrastructure
- Linux Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to enterprise LUKS implementation, remote unlock automation, advanced security configurations, and production-grade full disk encryption management for critical infrastructure"
more_link: "yes"
url: "/luks-remote-unlock-enterprise-security-automation/"
---

Enterprise full disk encryption with LUKS (Linux Unified Key Setup) requires sophisticated remote unlock capabilities, automated key management, and robust security frameworks for production environments. This comprehensive guide covers advanced LUKS implementations, enterprise-grade remote unlock systems, high availability configurations, and automated security management for critical infrastructure deployments.

<!--more-->

# [Enterprise LUKS Architecture Overview](#enterprise-luks-architecture-overview)

## Full Disk Encryption Framework Design

Enterprise LUKS deployments demand comprehensive security architectures that balance protection, accessibility, and operational requirements across distributed infrastructure environments.

### Enterprise Encryption Strategy Matrix

```
┌─────────────────────────────────────────────────────────────────┐
│                Enterprise Encryption Architecture               │
├─────────────────┬─────────────────┬─────────────────┬───────────┤
│  Data at Rest   │  Key Management │  Remote Access  │ Compliance│
├─────────────────┼─────────────────┼─────────────────┼───────────┤
│ ┌─────────────┐ │ ┌─────────────┐ │ ┌─────────────┐ │ ┌───────┐ │
│ │ LUKS/dm-    │ │ │ HSM/TPM     │ │ │ Dropbear    │ │ │ FIPS  │ │
│ │ crypt       │ │ │ Integration │ │ │ SSH Bridge  │ │ │ 140-2 │ │
│ │ + XTS-AES   │ │ │ + Vault     │ │ │ + Network   │ │ │ SOC 2 │ │
│ └─────────────┘ │ └─────────────┘ │ └─────────────┘ │ └───────┘ │
│                 │                 │                 │           │
│ • Multi-layer   │ • Automated     │ • Zero-touch    │ • Audit   │
│ • Performance   │ • Rotation      │ • HA unlock     │ • Reports │
│ • Recovery      │ • Escrow        │ • Monitoring    │ • Logging │
└─────────────────┴─────────────────┴─────────────────┴───────────┘
```

### LUKS Security Deployment Models

| Model | Use Case | Security Level | Complexity | Recovery Time |
|-------|----------|----------------|------------|---------------|
| **Standard Remote** | Basic servers | Medium | Low | 5-15 minutes |
| **HA Multi-Key** | Critical systems | High | Medium | 2-5 minutes |
| **HSM-Integrated** | Financial/healthcare | Very High | High | 1-3 minutes |
| **Zero-Touch** | Cloud/container | High | Very High | 30 seconds |

## Advanced LUKS Configuration Framework

### Enterprise LUKS Setup and Management System

```python
#!/usr/bin/env python3
"""
Enterprise LUKS Management and Automation Framework
"""

import subprocess
import json
import logging
import secrets
import hashlib
import time
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, asdict
from pathlib import Path
import cryptography.fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
import base64

@dataclass
class LUKSDevice:
    device_path: str
    mount_point: str
    mapper_name: str
    key_slot: int
    cipher: str = "aes-xts-plain64"
    key_size: int = 512
    hash_algorithm: str = "sha256"
    iteration_time: int = 2000
    backup_header_path: Optional[str] = None
    auto_unlock: bool = False
    remote_unlock: bool = False

@dataclass
class RemoteUnlockConfig:
    dropbear_port: int = 2222
    authorized_keys_path: str = "/etc/dropbear-initramfs/authorized_keys"
    network_config: Dict = None
    timeout_seconds: int = 300
    max_attempts: int = 3
    monitoring_enabled: bool = True

class LUKSManager:
    def __init__(self, config_file: str = "/etc/luks/enterprise.conf"):
        self.config_file = Path(config_file)
        self.devices: Dict[str, LUKSDevice] = {}
        self.remote_config: Optional[RemoteUnlockConfig] = None
        self.logger = self._setup_logging()
        
        # Key management
        self.key_store_path = Path("/etc/luks/keystore")
        self.backup_path = Path("/etc/luks/backups")
        
        self._ensure_directories()
        self._load_configuration()
    
    def _setup_logging(self) -> logging.Logger:
        """Setup comprehensive logging"""
        logger = logging.getLogger(__name__)
        logger.setLevel(logging.INFO)
        
        # File handler
        file_handler = logging.FileHandler('/var/log/luks-enterprise.log')
        file_formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        file_handler.setFormatter(file_formatter)
        
        # Console handler
        console_handler = logging.StreamHandler()
        console_formatter = logging.Formatter('%(levelname)s: %(message)s')
        console_handler.setFormatter(console_formatter)
        
        logger.addHandler(file_handler)
        logger.addHandler(console_handler)
        
        return logger
    
    def _ensure_directories(self) -> None:
        """Create necessary directories with proper permissions"""
        for directory in [self.config_file.parent, self.key_store_path, self.backup_path]:
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    
    def _load_configuration(self) -> None:
        """Load LUKS configuration from file"""
        if self.config_file.exists():
            try:
                with open(self.config_file, 'r') as f:
                    config = json.load(f)
                
                # Load devices
                for device_name, device_data in config.get('devices', {}).items():
                    self.devices[device_name] = LUKSDevice(**device_data)
                
                # Load remote unlock configuration
                if 'remote_unlock' in config:
                    self.remote_config = RemoteUnlockConfig(**config['remote_unlock'])
                
                self.logger.info(f"Loaded configuration for {len(self.devices)} LUKS devices")
                
            except Exception as e:
                self.logger.error(f"Failed to load configuration: {e}")
    
    def save_configuration(self) -> None:
        """Save current configuration to file"""
        config = {
            'devices': {name: asdict(device) for name, device in self.devices.items()},
            'remote_unlock': asdict(self.remote_config) if self.remote_config else None
        }
        
        with open(self.config_file, 'w') as f:
            json.dump(config, f, indent=2)
        
        # Secure the configuration file
        self.config_file.chmod(0o600)
        self.logger.info("Configuration saved")
    
    def generate_secure_key(self, length: int = 32) -> bytes:
        """Generate cryptographically secure key"""
        return secrets.token_bytes(length)
    
    def derive_key_from_password(self, password: str, salt: bytes) -> bytes:
        """Derive encryption key from password using PBKDF2"""
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=100000,
        )
        return kdf.derive(password.encode())
    
    def encrypt_key(self, key: bytes, password: str) -> Tuple[bytes, bytes]:
        """Encrypt key with password"""
        salt = secrets.token_bytes(16)
        derived_key = self.derive_key_from_password(password, salt)
        
        f = cryptography.fernet.Fernet(base64.urlsafe_b64encode(derived_key))
        encrypted_key = f.encrypt(key)
        
        return encrypted_key, salt
    
    def decrypt_key(self, encrypted_key: bytes, password: str, salt: bytes) -> bytes:
        """Decrypt key with password"""
        derived_key = self.derive_key_from_password(password, salt)
        
        f = cryptography.fernet.Fernet(base64.urlsafe_b64encode(derived_key))
        return f.decrypt(encrypted_key)
    
    def create_luks_device(self, device_name: str, device_path: str, 
                          mount_point: str, password: str,
                          cipher: str = "aes-xts-plain64") -> bool:
        """Create and format LUKS device"""
        try:
            self.logger.info(f"Creating LUKS device {device_name} on {device_path}")
            
            # Generate secure key
            key = self.generate_secure_key()
            key_file = self.key_store_path / f"{device_name}.key"
            
            # Encrypt and store key
            encrypted_key, salt = self.encrypt_key(key, password)
            key_data = {
                'encrypted_key': base64.b64encode(encrypted_key).decode(),
                'salt': base64.b64encode(salt).decode(),
                'created': time.time()
            }
            
            with open(key_file, 'w') as f:
                json.dump(key_data, f)
            key_file.chmod(0o600)
            
            # Create temporary key file for LUKS formatting
            temp_key_file = f"/tmp/luks_key_{device_name}"
            with open(temp_key_file, 'wb') as f:
                f.write(key)
            Path(temp_key_file).chmod(0o600)
            
            try:
                # Format LUKS device
                cmd = [
                    'cryptsetup', 'luksFormat',
                    '--type', 'luks2',
                    '--cipher', cipher,
                    '--key-size', '512',
                    '--hash', 'sha256',
                    '--iter-time', '2000',
                    '--use-random',
                    '--key-file', temp_key_file,
                    device_path
                ]
                
                result = subprocess.run(cmd, capture_output=True, text=True)
                if result.returncode != 0:
                    raise subprocess.CalledProcessError(result.returncode, cmd, result.stderr)
                
                # Backup LUKS header
                backup_file = self.backup_path / f"{device_name}_header.img"
                subprocess.run([
                    'cryptsetup', 'luksHeaderBackup', device_path,
                    '--header-backup-file', str(backup_file)
                ], check=True)
                
                # Create device configuration
                mapper_name = f"luks_{device_name}"
                luks_device = LUKSDevice(
                    device_path=device_path,
                    mount_point=mount_point,
                    mapper_name=mapper_name,
                    key_slot=0,
                    cipher=cipher,
                    backup_header_path=str(backup_file)
                )
                
                self.devices[device_name] = luks_device
                self.save_configuration()
                
                self.logger.info(f"LUKS device {device_name} created successfully")
                return True
                
            finally:
                # Clean up temporary key file
                Path(temp_key_file).unlink(missing_ok=True)
                
        except Exception as e:
            self.logger.error(f"Failed to create LUKS device {device_name}: {e}")
            return False
    
    def unlock_device(self, device_name: str, password: str) -> bool:
        """Unlock LUKS device"""
        if device_name not in self.devices:
            self.logger.error(f"Device {device_name} not found")
            return False
        
        device = self.devices[device_name]
        
        try:
            # Load and decrypt key
            key_file = self.key_store_path / f"{device_name}.key"
            if not key_file.exists():
                self.logger.error(f"Key file for {device_name} not found")
                return False
            
            with open(key_file, 'r') as f:
                key_data = json.load(f)
            
            encrypted_key = base64.b64decode(key_data['encrypted_key'])
            salt = base64.b64decode(key_data['salt'])
            
            key = self.decrypt_key(encrypted_key, password, salt)
            
            # Create temporary key file
            temp_key_file = f"/tmp/luks_unlock_{device_name}"
            with open(temp_key_file, 'wb') as f:
                f.write(key)
            Path(temp_key_file).chmod(0o600)
            
            try:
                # Unlock device
                cmd = [
                    'cryptsetup', 'luksOpen',
                    device.device_path,
                    device.mapper_name,
                    '--key-file', temp_key_file
                ]
                
                result = subprocess.run(cmd, capture_output=True, text=True)
                if result.returncode != 0:
                    raise subprocess.CalledProcessError(result.returncode, cmd, result.stderr)
                
                self.logger.info(f"LUKS device {device_name} unlocked successfully")
                return True
                
            finally:
                # Clean up temporary key file
                Path(temp_key_file).unlink(missing_ok=True)
                
        except Exception as e:
            self.logger.error(f"Failed to unlock LUKS device {device_name}: {e}")
            return False
    
    def lock_device(self, device_name: str) -> bool:
        """Lock LUKS device"""
        if device_name not in self.devices:
            self.logger.error(f"Device {device_name} not found")
            return False
        
        device = self.devices[device_name]
        
        try:
            # Check if device is mounted and unmount if necessary
            result = subprocess.run(['findmnt', '-n', device.mount_point], 
                                  capture_output=True, text=True)
            if result.returncode == 0:
                subprocess.run(['umount', device.mount_point], check=True)
            
            # Close LUKS device
            subprocess.run(['cryptsetup', 'luksClose', device.mapper_name], check=True)
            
            self.logger.info(f"LUKS device {device_name} locked successfully")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to lock LUKS device {device_name}: {e}")
            return False
    
    def add_key_slot(self, device_name: str, existing_password: str, 
                     new_password: str, slot: Optional[int] = None) -> bool:
        """Add new key slot to LUKS device"""
        if device_name not in self.devices:
            return False
        
        device = self.devices[device_name]
        
        try:
            # Load existing key
            key_file = self.key_store_path / f"{device_name}.key"
            with open(key_file, 'r') as f:
                key_data = json.load(f)
            
            encrypted_key = base64.b64decode(key_data['encrypted_key'])
            salt = base64.b64decode(key_data['salt'])
            existing_key = self.decrypt_key(encrypted_key, existing_password, salt)
            
            # Generate new key
            new_key = self.generate_secure_key()
            
            # Create temporary key files
            existing_key_file = f"/tmp/luks_existing_{device_name}"
            new_key_file = f"/tmp/luks_new_{device_name}"
            
            with open(existing_key_file, 'wb') as f:
                f.write(existing_key)
            with open(new_key_file, 'wb') as f:
                f.write(new_key)
            
            Path(existing_key_file).chmod(0o600)
            Path(new_key_file).chmod(0o600)
            
            try:
                # Add key slot
                cmd = ['cryptsetup', 'luksAddKey', device.device_path, 
                      new_key_file, '--key-file', existing_key_file]
                
                if slot is not None:
                    cmd.extend(['--key-slot', str(slot)])
                
                subprocess.run(cmd, check=True)
                
                # Store new key
                new_encrypted_key, new_salt = self.encrypt_key(new_key, new_password)
                new_key_data = {
                    'encrypted_key': base64.b64encode(new_encrypted_key).decode(),
                    'salt': base64.b64encode(new_salt).decode(),
                    'created': time.time(),
                    'slot': slot
                }
                
                new_key_file_path = self.key_store_path / f"{device_name}_slot_{slot or 'auto'}.key"
                with open(new_key_file_path, 'w') as f:
                    json.dump(new_key_data, f)
                new_key_file_path.chmod(0o600)
                
                self.logger.info(f"Added key slot for device {device_name}")
                return True
                
            finally:
                # Clean up temporary files
                Path(existing_key_file).unlink(missing_ok=True)
                Path(new_key_file).unlink(missing_ok=True)
                
        except Exception as e:
            self.logger.error(f"Failed to add key slot for device {device_name}: {e}")
            return False
    
    def rotate_keys(self, device_name: str, old_password: str, new_password: str) -> bool:
        """Rotate encryption keys for device"""
        try:
            # Add new key in next available slot
            if not self.add_key_slot(device_name, old_password, new_password):
                return False
            
            # Remove old key (slot 0)
            device = self.devices[device_name]
            
            # Create new key file
            key_file = self.key_store_path / f"{device_name}.key"
            with open(key_file, 'r') as f:
                key_data = json.load(f)
            
            encrypted_key = base64.b64decode(key_data['encrypted_key'])
            salt = base64.b64decode(key_data['salt'])
            new_key = self.decrypt_key(encrypted_key, new_password, salt)
            
            new_key_file = f"/tmp/luks_rotate_{device_name}"
            with open(new_key_file, 'wb') as f:
                f.write(new_key)
            Path(new_key_file).chmod(0o600)
            
            try:
                # Remove old key slot
                subprocess.run([
                    'cryptsetup', 'luksRemoveKey', device.device_path,
                    '--key-file', new_key_file, '--key-slot', '0'
                ], check=True)
                
                self.logger.info(f"Key rotation completed for device {device_name}")
                return True
                
            finally:
                Path(new_key_file).unlink(missing_ok=True)
                
        except Exception as e:
            self.logger.error(f"Failed to rotate keys for device {device_name}: {e}")
            return False
    
    def backup_luks_header(self, device_name: str) -> Optional[str]:
        """Backup LUKS header"""
        if device_name not in self.devices:
            return None
        
        device = self.devices[device_name]
        backup_file = self.backup_path / f"{device_name}_header_{int(time.time())}.img"
        
        try:
            subprocess.run([
                'cryptsetup', 'luksHeaderBackup', device.device_path,
                '--header-backup-file', str(backup_file)
            ], check=True)
            
            self.logger.info(f"LUKS header backed up to {backup_file}")
            return str(backup_file)
            
        except Exception as e:
            self.logger.error(f"Failed to backup LUKS header for {device_name}: {e}")
            return None
    
    def get_device_status(self, device_name: str) -> Dict:
        """Get comprehensive device status"""
        if device_name not in self.devices:
            return {"error": "Device not found"}
        
        device = self.devices[device_name]
        status = {
            "device_name": device_name,
            "device_path": device.device_path,
            "mapper_name": device.mapper_name,
            "cipher": device.cipher,
            "unlocked": False,
            "mounted": False,
            "key_slots": []
        }
        
        try:
            # Check if device is unlocked
            result = subprocess.run(['cryptsetup', 'status', device.mapper_name], 
                                  capture_output=True, text=True)
            status["unlocked"] = result.returncode == 0
            
            # Check if mounted
            if status["unlocked"]:
                result = subprocess.run(['findmnt', '-n', device.mount_point], 
                                      capture_output=True, text=True)
                status["mounted"] = result.returncode == 0
            
            # Get key slot information
            result = subprocess.run(['cryptsetup', 'luksDump', device.device_path], 
                                  capture_output=True, text=True)
            if result.returncode == 0:
                for line in result.stdout.split('\n'):
                    if 'Key Slot' in line and 'ENABLED' in line:
                        slot_num = line.split(':')[0].split()[-1]
                        status["key_slots"].append(int(slot_num))
            
        except Exception as e:
            status["error"] = str(e)
        
        return status

# Example enterprise usage
def setup_enterprise_luks():
    """Example enterprise LUKS setup"""
    manager = LUKSManager()
    
    # Configure remote unlock
    remote_config = RemoteUnlockConfig(
        dropbear_port=2222,
        network_config={
            "ipv4": "192.168.1.100/24",
            "gateway": "192.168.1.1",
            "ipv6": "2001:db8::100/64",
            "ipv6_gateway": "2001:db8::1"
        },
        timeout_seconds=300,
        monitoring_enabled=True
    )
    
    manager.remote_config = remote_config
    manager.save_configuration()
    
    return manager

if __name__ == "__main__":
    # Demonstration
    manager = setup_enterprise_luks()
    
    # Example device creation (commented out for safety)
    # manager.create_luks_device("data", "/dev/sdb1", "/mnt/secure", "secure_password")
    
    print("Enterprise LUKS Manager initialized")
    for device_name in manager.devices:
        status = manager.get_device_status(device_name)
        print(f"Device {device_name}: {status}")
```

# [Enterprise Remote Unlock Infrastructure](#enterprise-remote-unlock-infrastructure)

## Advanced Dropbear SSH Configuration

### Production Remote Unlock System

```bash
#!/bin/bash
# Enterprise LUKS Remote Unlock Infrastructure Deployment

set -euo pipefail

# Configuration
ENTERPRISE_CONFIG="/etc/luks/enterprise-remote.conf"
SSH_KEYS_DIR="/etc/luks/ssh-keys"
DROPBEAR_CONFIG="/etc/dropbear-initramfs/config"
INITRAMFS_CONFIG="/etc/initramfs-tools/initramfs.conf"
GRUB_CONFIG="/etc/default/grub"
LOG_DIR="/var/log/luks-remote"

# Network configuration
DROPBEAR_PORT="${DROPBEAR_PORT:-2222}"
BACKUP_PORT="${BACKUP_PORT:-2223}"
MANAGEMENT_NETWORK="${MANAGEMENT_NETWORK:-192.168.100.0/24}"
IPV6_ENABLED="${IPV6_ENABLED:-true}"

# Security settings
MAX_AUTH_TRIES="${MAX_AUTH_TRIES:-3}"
LOGIN_TIMEOUT="${LOGIN_TIMEOUT:-300}"
IDLE_TIMEOUT="${IDLE_TIMEOUT:-600}"
KEY_ROTATION_DAYS="${KEY_ROTATION_DAYS:-90}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Logging
log() { echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $*" | tee -a "$LOG_DIR/deployment.log"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*" | tee -a "$LOG_DIR/deployment.log"; }
error() { echo -e "${RED}[ERROR]${NC} $*" | tee -a "$LOG_DIR/deployment.log"; exit 1; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $*" | tee -a "$LOG_DIR/deployment.log"; }

# Setup environment
setup_environment() {
    log "Setting up enterprise remote unlock environment..."
    
    mkdir -p "$LOG_DIR" "$SSH_KEYS_DIR" "$(dirname "$ENTERPRISE_CONFIG")"
    chmod 700 "$SSH_KEYS_DIR"
    chmod 755 "$LOG_DIR"
    
    # Install required packages
    if command -v apt >/dev/null 2>&1; then
        apt update
        apt install -y dropbear-initramfs cryptsetup busybox openssh-client
    elif command -v yum >/dev/null 2>&1; then
        yum install -y cryptsetup openssh-clients
        warn "dropbear-initramfs not available on RHEL-based systems"
    fi
    
    success "Environment setup completed"
}

# Generate enterprise SSH key infrastructure
setup_ssh_infrastructure() {
    log "Setting up SSH key infrastructure..."
    
    # Create SSH key for remote unlock
    local unlock_key="$SSH_KEYS_DIR/luks_unlock_rsa"
    if [[ ! -f "$unlock_key" ]]; then
        ssh-keygen -t rsa -b 4096 -f "$unlock_key" -N "" -C "luks-unlock-$(hostname)"
        chmod 600 "$unlock_key"
        chmod 644 "$unlock_key.pub"
        
        log "Generated LUKS unlock SSH key"
    fi
    
    # Create backup key
    local backup_key="$SSH_KEYS_DIR/luks_backup_rsa"
    if [[ ! -f "$backup_key" ]]; then
        ssh-keygen -t rsa -b 4096 -f "$backup_key" -N "" -C "luks-backup-$(hostname)"
        chmod 600 "$backup_key"
        chmod 644 "$backup_key.pub"
        
        log "Generated LUKS backup SSH key"
    fi
    
    # Create emergency access key
    local emergency_key="$SSH_KEYS_DIR/luks_emergency_rsa"
    if [[ ! -f "$emergency_key" ]]; then
        ssh-keygen -t rsa -b 4096 -f "$emergency_key" -N "" -C "luks-emergency-$(hostname)"
        chmod 600 "$emergency_key"
        chmod 644 "$emergency_key.pub"
        
        log "Generated LUKS emergency SSH key"
    fi
    
    success "SSH infrastructure setup completed"
}

# Configure advanced dropbear settings
configure_dropbear() {
    log "Configuring enterprise dropbear settings..."
    
    # Backup original configuration
    if [[ -f "$DROPBEAR_CONFIG" ]]; then
        cp "$DROPBEAR_CONFIG" "$DROPBEAR_CONFIG.backup.$(date +%Y%m%d_%H%M%S)"
    fi
    
    # Create advanced dropbear configuration
    cat > "$DROPBEAR_CONFIG" << EOF
# Enterprise Dropbear Configuration
# Generated: $(date)

# Primary SSH port
DROPBEAR_OPTIONS="-I $IDLE_TIMEOUT -j -k -p $DROPBEAR_PORT -s -c cryptroot-unlock"

# Backup SSH port (different configuration)
DROPBEAR_OPTIONS2="-I $IDLE_TIMEOUT -j -k -p $BACKUP_PORT -s"

# Security settings
DROPBEAR_RECEIVE_WINDOW=65536
DROPBEAR_TRANSMIT_WINDOW=65536

# Logging and monitoring
DROPBEAR_EXTRA_ARGS="-F -E"
EOF

    # Configure authorized keys with restrictions
    local auth_keys="/etc/dropbear-initramfs/authorized_keys"
    
    cat > "$auth_keys" << EOF
# Enterprise LUKS Remote Unlock Authorized Keys
# Generated: $(date)

# Primary unlock key (restricted to cryptroot-unlock command)
command="cryptroot-unlock",no-port-forwarding,no-agent-forwarding,no-x11-forwarding $(cat "$SSH_KEYS_DIR/luks_unlock_rsa.pub")

# Backup key (restricted shell access)
command="/bin/sh",no-port-forwarding,no-agent-forwarding,no-x11-forwarding $(cat "$SSH_KEYS_DIR/luks_backup_rsa.pub")

# Emergency key (full access with source restrictions)
from="$MANAGEMENT_NETWORK",no-port-forwarding,no-agent-forwarding,no-x11-forwarding $(cat "$SSH_KEYS_DIR/luks_emergency_rsa.pub")
EOF

    chmod 600 "$auth_keys"
    
    success "Dropbear configuration completed"
}

# Configure advanced networking
configure_networking() {
    log "Configuring enterprise networking for remote unlock..."
    
    # IPv4 configuration
    local ipv4_config=""
    if [[ -n "${STATIC_IPV4:-}" ]]; then
        ipv4_config="IP=${STATIC_IPV4}::${IPV4_GATEWAY:-}:${IPV4_NETMASK:-255.255.255.0}:$(hostname)"
    fi
    
    # IPv6 configuration
    local ipv6_config=""
    if [[ "$IPV6_ENABLED" == "true" && -n "${STATIC_IPV6:-}" ]]; then
        ipv6_config="ipv6=addr=${STATIC_IPV6},gw=${IPV6_GATEWAY:-},iface=${NETWORK_INTERFACE:-eth0}"
    fi
    
    # Update initramfs configuration
    cat >> "$INITRAMFS_CONFIG" << EOF

# Enterprise LUKS Remote Unlock Network Configuration
# Generated: $(date)

# IPv4 Configuration
$ipv4_config

# Network interface
DEVICE=$NETWORK_INTERFACE

# DNS servers
NFSROOT=auto

# Boot timeout
BOOT=local
EOF

    # Configure GRUB for IPv6 if enabled
    if [[ "$IPV6_ENABLED" == "true" && -n "${STATIC_IPV6:-}" ]]; then
        update_grub_ipv6_config
    fi
    
    success "Network configuration completed"
}

# Update GRUB configuration for IPv6
update_grub_ipv6_config() {
    log "Updating GRUB configuration for IPv6..."
    
    # Backup GRUB configuration
    cp "$GRUB_CONFIG" "$GRUB_CONFIG.backup.$(date +%Y%m%d_%H%M%S)"
    
    # Add IPv6 configuration to GRUB command line
    local ipv6_params="ipv6=addr=${STATIC_IPV6},gw=${IPV6_GATEWAY:-},iface=${NETWORK_INTERFACE:-eth0},forwarding=0,accept_ra=0"
    
    if grep -q "GRUB_CMDLINE_LINUX=" "$GRUB_CONFIG"; then
        sed -i "s/GRUB_CMDLINE_LINUX=\"/GRUB_CMDLINE_LINUX=\"$ipv6_params /" "$GRUB_CONFIG"
    else
        echo "GRUB_CMDLINE_LINUX=\"$ipv6_params\"" >> "$GRUB_CONFIG"
    fi
    
    # Install IPv6 initramfs scripts
    install_ipv6_scripts
    
    success "GRUB IPv6 configuration updated"
}

# Install IPv6 initramfs scripts
install_ipv6_scripts() {
    log "Installing IPv6 initramfs scripts..."
    
    # Create IPv6 hook script
    cat > "/etc/initramfs-tools/hooks/ipv6" << 'EOF'
#!/bin/sh
# IPv6 Support Hook for initramfs

PREREQ=""

prereqs() {
    echo "$PREREQ"
}

case $1 in
prereqs)
    prereqs
    exit 0
    ;;
esac

. /usr/share/initramfs-tools/hook-functions

# Copy IPv6 modules
copy_modules_dir kernel/net/ipv6

# Copy IPv6 utilities
copy_exec /sbin/ip
copy_exec /bin/ping6

exit 0
EOF

    # Create IPv6 init script
    cat > "/etc/initramfs-tools/scripts/init-premount/ipv6" << 'EOF'
#!/bin/sh

PREREQ=""

prereqs() {
    echo "$PREREQ"
}

case $1 in
prereqs)
    prereqs
    exit 0
    ;;
esac

# Parse IPv6 parameters from kernel command line
for x in $(cat /proc/cmdline); do
    case $x in
    ipv6=*)
        IPV6_CONFIG="${x#ipv6=}"
        ;;
    esac
done

if [ -n "$IPV6_CONFIG" ]; then
    # Load IPv6 module
    modprobe ipv6
    
    # Parse configuration
    OLDIFS="$IFS"
    IFS=","
    for param in $IPV6_CONFIG; do
        case $param in
        addr=*)
            IPV6_ADDR="${param#addr=}"
            ;;
        gw=*)
            IPV6_GW="${param#gw=}"
            ;;
        iface=*)
            IPV6_IFACE="${param#iface=}"
            ;;
        esac
    done
    IFS="$OLDIFS"
    
    # Configure IPv6
    if [ -n "$IPV6_ADDR" ] && [ -n "$IPV6_IFACE" ]; then
        ip link set "$IPV6_IFACE" up
        ip -6 addr add "$IPV6_ADDR" dev "$IPV6_IFACE"
        
        if [ -n "$IPV6_GW" ]; then
            ip -6 route add default via "$IPV6_GW" dev "$IPV6_IFACE"
        fi
        
        echo "IPv6 configured: $IPV6_ADDR on $IPV6_IFACE"
    fi
fi
EOF

    chmod +x "/etc/initramfs-tools/hooks/ipv6"
    chmod +x "/etc/initramfs-tools/scripts/init-premount/ipv6"
    
    success "IPv6 scripts installed"
}

# Create advanced monitoring system
setup_monitoring() {
    log "Setting up remote unlock monitoring..."
    
    # Create monitoring script
    cat > "/usr/local/bin/luks-remote-monitor.sh" << 'EOF'
#!/bin/bash
# Enterprise LUKS Remote Unlock Monitoring

METRICS_FILE="/var/log/luks-remote/metrics.log"
ALERT_SCRIPT="/usr/local/bin/luks-alert.sh"

log_metric() {
    echo "$(date '+%Y-%m-%d %H:%M:%S'),$*" >> "$METRICS_FILE"
}

check_dropbear_status() {
    # Check if dropbear is configured
    if [[ -f "/etc/dropbear-initramfs/config" ]]; then
        echo "DROPBEAR_CONFIG,OK"
        log_metric "dropbear_config,ok"
    else
        echo "DROPBEAR_CONFIG,ERROR"
        log_metric "dropbear_config,error"
        return 1
    fi
    
    # Check authorized keys
    if [[ -f "/etc/dropbear-initramfs/authorized_keys" ]]; then
        local key_count=$(grep -c "ssh-rsa\|ssh-ed25519" "/etc/dropbear-initramfs/authorized_keys" 2>/dev/null || echo "0")
        echo "SSH_KEYS,$key_count"
        log_metric "ssh_keys,$key_count"
        
        if [[ $key_count -eq 0 ]]; then
            return 1
        fi
    else
        echo "SSH_KEYS,ERROR"
        log_metric "ssh_keys,error"
        return 1
    fi
    
    return 0
}

check_luks_devices() {
    local device_count=0
    local unlocked_count=0
    
    # Count LUKS devices
    for device in $(blkid | grep crypto_LUKS | cut -d: -f1); do
        ((device_count++))
        
        # Check if device is unlocked
        local mapper_name=$(basename "$device")
        if cryptsetup status "luks_$mapper_name" >/dev/null 2>&1; then
            ((unlocked_count++))
        fi
    done
    
    echo "LUKS_DEVICES,$device_count"
    echo "LUKS_UNLOCKED,$unlocked_count"
    log_metric "luks_devices,$device_count"
    log_metric "luks_unlocked,$unlocked_count"
    
    return 0
}

check_network_config() {
    # Check initramfs network configuration
    if grep -q "IP=" "/etc/initramfs-tools/initramfs.conf" 2>/dev/null; then
        echo "NETWORK_CONFIG,OK"
        log_metric "network_config,ok"
    else
        echo "NETWORK_CONFIG,DHCP"
        log_metric "network_config,dhcp"
    fi
    
    # Check IPv6 configuration
    if [[ -f "/etc/initramfs-tools/scripts/init-premount/ipv6" ]]; then
        echo "IPV6_CONFIG,OK"
        log_metric "ipv6_config,ok"
    else
        echo "IPV6_CONFIG,NONE"
        log_metric "ipv6_config,none"
    fi
    
    return 0
}

check_key_rotation() {
    local key_dir="/etc/luks/ssh-keys"
    local needs_rotation=false
    
    if [[ -d "$key_dir" ]]; then
        for key_file in "$key_dir"/*.pub; do
            if [[ -f "$key_file" ]]; then
                local age_days=$(( ($(date +%s) - $(stat -c %Y "$key_file")) / 86400 ))
                
                if [[ $age_days -gt ${KEY_ROTATION_DAYS:-90} ]]; then
                    needs_rotation=true
                    break
                fi
            fi
        done
    fi
    
    if [[ "$needs_rotation" == "true" ]]; then
        echo "KEY_ROTATION,NEEDED"
        log_metric "key_rotation,needed"
        return 1
    else
        echo "KEY_ROTATION,OK"
        log_metric "key_rotation,ok"
        return 0
    fi
}

# Main monitoring execution
failed_checks=0

if ! check_dropbear_status; then
    ((failed_checks++))
fi

check_luks_devices
check_network_config

if ! check_key_rotation; then
    ((failed_checks++))
fi

# Generate alert if multiple failures
if [[ $failed_checks -gt 1 ]]; then
    if [[ -x "$ALERT_SCRIPT" ]]; then
        "$ALERT_SCRIPT" "CRITICAL" "Multiple LUKS remote unlock failures detected"
    fi
    logger -p crit "LUKS Remote Unlock: Multiple system failures detected"
fi

exit $failed_checks
EOF

    chmod +x "/usr/local/bin/luks-remote-monitor.sh"
    
    # Create alert script
    cat > "/usr/local/bin/luks-alert.sh" << 'EOF'
#!/bin/bash
# LUKS Remote Unlock Alert Handler

SEVERITY="$1"
MESSAGE="$2"

# Log to syslog
logger -p daemon."$(echo "$SEVERITY" | tr '[:upper:]' '[:lower:]')" "LUKS Remote Unlock [$SEVERITY]: $MESSAGE"

# Send email if configured
if [[ -n "${ALERT_EMAIL:-}" ]] && command -v mail >/dev/null 2>&1; then
    echo "$MESSAGE" | mail -s "LUKS Alert [$SEVERITY]" "$ALERT_EMAIL"
fi

# Send to monitoring system (customize as needed)
if [[ -n "${MONITORING_WEBHOOK:-}" ]]; then
    curl -X POST -H "Content-Type: application/json" \
        -d "{\"severity\":\"$SEVERITY\",\"message\":\"$MESSAGE\",\"timestamp\":\"$(date -Iseconds)\"}" \
        "$MONITORING_WEBHOOK" 2>/dev/null || true
fi
EOF

    chmod +x "/usr/local/bin/luks-alert.sh"
    
    # Create systemd timer
    cat > "/etc/systemd/system/luks-remote-monitor.service" << EOF
[Unit]
Description=LUKS Remote Unlock Monitoring
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/luks-remote-monitor.sh
User=root
StandardOutput=journal
StandardError=journal
EOF

    cat > "/etc/systemd/system/luks-remote-monitor.timer" << EOF
[Unit]
Description=Run LUKS remote unlock monitoring every 10 minutes
Requires=luks-remote-monitor.service

[Timer]
OnCalendar=*:*/10:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

    systemctl daemon-reload
    systemctl enable luks-remote-monitor.timer
    systemctl start luks-remote-monitor.timer
    
    success "Monitoring system setup completed"
}

# Create emergency recovery procedures
create_recovery_procedures() {
    log "Creating emergency recovery procedures..."
    
    local recovery_dir="/etc/luks/recovery"
    mkdir -p "$recovery_dir"
    chmod 700 "$recovery_dir"
    
    # Create recovery documentation
    cat > "$recovery_dir/EMERGENCY_PROCEDURES.md" << 'EOF'
# LUKS Remote Unlock Emergency Recovery Procedures

## Connection Issues

### Cannot Connect to Dropbear SSH
1. Verify network connectivity to the server
2. Check if server is powered on and booting
3. Try backup SSH port (default 2223)
4. Use emergency SSH key if primary key fails
5. Check firewall rules on network equipment

### Permission Denied Errors
1. Verify SSH key is correct and matches authorized_keys
2. Try using RSA algorithm flag: `ssh -o PubkeyAcceptedAlgorithms=+ssh-rsa`
3. Use backup or emergency SSH key
4. Check key file permissions (should be 600)

### Network Configuration Issues
1. Try DHCP if static IP fails
2. Verify IPv6 configuration if using IPv6
3. Check network interface name in configuration
4. Verify gateway and DNS settings

## LUKS Issues

### Cannot Unlock Device
1. Verify correct passphrase/key
2. Check LUKS header integrity: `cryptsetup luksDump /dev/sdX`
3. Try different key slot if available
4. Restore from header backup if corrupted

### Device Not Found
1. Check device path and partition layout
2. Verify initramfs includes correct drivers
3. Check for hardware failures
4. Review boot logs for device recognition

## Recovery Commands

### Emergency Unlock
```bash
# Connect to dropbear
ssh -o PubkeyAcceptedAlgorithms=+ssh-rsa -p 2222 root@server-ip

# Manual unlock (if cryptroot-unlock fails)
cryptsetup luksOpen /dev/sdX1 luks_root
exit
```

### Header Recovery
```bash
# Restore header from backup
cryptsetup luksHeaderRestore /dev/sdX --header-backup-file /path/to/header.img
```

### Network Recovery
```bash
# Manual IP configuration in initramfs
ip addr add 192.168.1.100/24 dev eth0
ip route add default via 192.168.1.1
```

## Contact Information
- Primary Admin: [ADMIN_EMAIL]
- Backup Admin: [BACKUP_EMAIL]
- Emergency Contact: [EMERGENCY_PHONE]
EOF

    # Create quick reference card
    cat > "$recovery_dir/QUICK_REFERENCE.txt" << EOF
LUKS Remote Unlock Quick Reference
=================================

SSH Connection:
ssh -o PubkeyAcceptedAlgorithms=+ssh-rsa -p 2222 root@[SERVER_IP]

Backup Port:
ssh -o PubkeyAcceptedAlgorithms=+ssh-rsa -p 2223 root@[SERVER_IP]

Unlock Command:
cryptroot-unlock

Manual Unlock:
cryptsetup luksOpen /dev/[DEVICE] [MAPPER_NAME]

Emergency Keys Location:
/etc/luks/ssh-keys/

Configuration Files:
- /etc/dropbear-initramfs/config
- /etc/dropbear-initramfs/authorized_keys
- /etc/initramfs-tools/initramfs.conf
- /etc/default/grub

Recovery Scripts:
/etc/luks/recovery/
EOF

    success "Emergency recovery procedures created"
}

# Test remote unlock functionality
test_remote_unlock() {
    log "Testing remote unlock functionality..."
    
    # Check dropbear configuration
    if [[ ! -f "$DROPBEAR_CONFIG" ]]; then
        error "Dropbear configuration not found"
    fi
    
    # Check authorized keys
    if [[ ! -f "/etc/dropbear-initramfs/authorized_keys" ]]; then
        error "Dropbear authorized_keys file not found"
    fi
    
    # Validate SSH keys
    local key_count=0
    for key_file in "$SSH_KEYS_DIR"/*.pub; do
        if [[ -f "$key_file" ]]; then
            if ssh-keygen -l -f "$key_file" >/dev/null 2>&1; then
                ((key_count++))
                success "SSH key validation passed: $(basename "$key_file")"
            else
                warn "SSH key validation failed: $(basename "$key_file")"
            fi
        fi
    done
    
    if [[ $key_count -eq 0 ]]; then
        error "No valid SSH keys found"
    fi
    
    # Check network configuration
    if grep -q "IP=" "$INITRAMFS_CONFIG" 2>/dev/null; then
        success "Static IP configuration found"
    else
        warn "No static IP configuration (will use DHCP)"
    fi
    
    # Check IPv6 scripts
    if [[ -f "/etc/initramfs-tools/scripts/init-premount/ipv6" ]]; then
        success "IPv6 configuration scripts installed"
    else
        warn "IPv6 scripts not installed"
    fi
    
    success "Remote unlock functionality tests completed"
}

# Update initramfs and GRUB
update_boot_configuration() {
    log "Updating boot configuration..."
    
    # Update initramfs
    update-initramfs -u
    
    # Update GRUB
    update-grub
    
    success "Boot configuration updated"
}

# Generate deployment report
generate_deployment_report() {
    local report_file="$LOG_DIR/deployment_report_$(date +%Y%m%d_%H%M%S).txt"
    
    log "Generating deployment report..."
    
    {
        echo "ENTERPRISE LUKS REMOTE UNLOCK DEPLOYMENT REPORT"
        echo "=============================================="
        echo "Generated: $(date)"
        echo "Hostname: $(hostname)"
        echo ""
        
        echo "Configuration Summary:"
        echo "====================="
        echo "Dropbear Port: $DROPBEAR_PORT"
        echo "Backup Port: $BACKUP_PORT"
        echo "IPv6 Enabled: $IPV6_ENABLED"
        echo "Management Network: $MANAGEMENT_NETWORK"
        echo "Key Rotation Days: $KEY_ROTATION_DAYS"
        echo ""
        
        echo "SSH Keys Generated:"
        echo "=================="
        for key_file in "$SSH_KEYS_DIR"/*.pub; do
            if [[ -f "$key_file" ]]; then
                echo "$(basename "$key_file"): $(ssh-keygen -l -f "$key_file" 2>/dev/null || echo 'Invalid')"
            fi
        done
        echo ""
        
        echo "Network Configuration:"
        echo "====================="
        if [[ -n "${STATIC_IPV4:-}" ]]; then
            echo "IPv4: $STATIC_IPV4"
        else
            echo "IPv4: DHCP"
        fi
        
        if [[ "$IPV6_ENABLED" == "true" && -n "${STATIC_IPV6:-}" ]]; then
            echo "IPv6: $STATIC_IPV6"
        else
            echo "IPv6: Not configured"
        fi
        echo ""
        
        echo "Files Created:"
        echo "============="
        echo "- $DROPBEAR_CONFIG"
        echo "- /etc/dropbear-initramfs/authorized_keys"
        echo "- SSH keys in $SSH_KEYS_DIR"
        echo "- Monitoring scripts in /usr/local/bin/"
        echo "- Recovery procedures in /etc/luks/recovery/"
        echo ""
        
        echo "Next Steps:"
        echo "==========="
        echo "1. Reboot the system to test remote unlock"
        echo "2. Verify SSH connectivity during boot"
        echo "3. Test LUKS unlock procedure"
        echo "4. Configure monitoring alerts"
        echo "5. Train operations staff on procedures"
        
    } > "$report_file"
    
    cat "$report_file"
    success "Deployment report generated: $report_file"
}

# Main deployment function
main() {
    case "${1:-deploy}" in
        "deploy")
            log "Starting enterprise LUKS remote unlock deployment..."
            setup_environment
            setup_ssh_infrastructure
            configure_dropbear
            configure_networking
            setup_monitoring
            create_recovery_procedures
            test_remote_unlock
            update_boot_configuration
            generate_deployment_report
            success "Enterprise LUKS remote unlock deployment completed!"
            ;;
        "test")
            test_remote_unlock
            ;;
        "monitor")
            /usr/local/bin/luks-remote-monitor.sh
            ;;
        "recover")
            cat "/etc/luks/recovery/QUICK_REFERENCE.txt"
            ;;
        *)
            echo "Usage: $0 {deploy|test|monitor|recover}"
            echo ""
            echo "Commands:"
            echo "  deploy  - Complete enterprise deployment"
            echo "  test    - Test configuration"
            echo "  monitor - Run monitoring check"
            echo "  recover - Show recovery procedures"
            exit 1
            ;;
    esac
}

# Check for root privileges
if [[ $EUID -ne 0 ]]; then
    error "This script must be run as root"
fi

main "$@"
```

# [High Availability and Automated Management](#high-availability-automated-management)

## Enterprise Key Management and Rotation

### Advanced Key Lifecycle Management System

```python
#!/usr/bin/env python3
"""
Enterprise LUKS Key Management and Rotation Framework
"""

import subprocess
import json
import time
import threading
import schedule
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, asdict
from pathlib import Path
import logging
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import requests

@dataclass
class KeyRotationPolicy:
    rotation_interval_days: int = 90
    warning_days_before: int = 7
    max_key_age_days: int = 365
    require_dual_approval: bool = True
    backup_old_keys: bool = True
    notify_on_rotation: bool = True

@dataclass
class KeyMetadata:
    created_date: float
    last_used: float
    slot_number: int
    purpose: str
    creator: str
    approval_required: bool = False
    scheduled_rotation: Optional[float] = None

class EnterpriseKeyManager:
    def __init__(self, config_file: str = "/etc/luks/key-management.json"):
        self.config_file = Path(config_file)
        self.devices: Dict[str, Dict] = {}
        self.rotation_policies: Dict[str, KeyRotationPolicy] = {}
        self.key_metadata: Dict[str, Dict[int, KeyMetadata]] = {}
        
        self.logger = self._setup_logging()
        self.notification_handlers = []
        
        self._load_configuration()
        self._setup_scheduler()
    
    def _setup_logging(self) -> logging.Logger:
        """Setup comprehensive logging"""
        logger = logging.getLogger(__name__)
        logger.setLevel(logging.INFO)
        
        # File handler with rotation
        file_handler = logging.handlers.RotatingFileHandler(
            '/var/log/luks-key-management.log', 
            maxBytes=10*1024*1024, 
            backupCount=5
        )
        file_formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        file_handler.setFormatter(file_formatter)
        
        # Syslog handler for important events
        syslog_handler = logging.handlers.SysLogHandler()
        syslog_formatter = logging.Formatter(
            'LUKS-KeyMgmt[%(process)d]: %(levelname)s - %(message)s'
        )
        syslog_handler.setFormatter(syslog_formatter)
        
        logger.addHandler(file_handler)
        logger.addHandler(syslog_handler)
        
        return logger
    
    def _load_configuration(self) -> None:
        """Load key management configuration"""
        if self.config_file.exists():
            try:
                with open(self.config_file, 'r') as f:
                    config = json.load(f)
                
                self.devices = config.get('devices', {})
                
                # Load rotation policies
                for device, policy_data in config.get('rotation_policies', {}).items():
                    self.rotation_policies[device] = KeyRotationPolicy(**policy_data)
                
                # Load key metadata
                for device, metadata in config.get('key_metadata', {}).items():
                    self.key_metadata[device] = {}
                    for slot_str, meta_data in metadata.items():
                        slot = int(slot_str)
                        self.key_metadata[device][slot] = KeyMetadata(**meta_data)
                
                self.logger.info(f"Loaded configuration for {len(self.devices)} devices")
                
            except Exception as e:
                self.logger.error(f"Failed to load configuration: {e}")
    
    def save_configuration(self) -> None:
        """Save current configuration"""
        config = {
            'devices': self.devices,
            'rotation_policies': {
                device: asdict(policy) 
                for device, policy in self.rotation_policies.items()
            },
            'key_metadata': {
                device: {
                    str(slot): asdict(metadata)
                    for slot, metadata in device_metadata.items()
                }
                for device, device_metadata in self.key_metadata.items()
            }
        }
        
        with open(self.config_file, 'w') as f:
            json.dump(config, f, indent=2)
        
        self.config_file.chmod(0o600)
        self.logger.info("Configuration saved")
    
    def add_device(self, device_name: str, device_path: str, 
                   policy: Optional[KeyRotationPolicy] = None) -> None:
        """Add device to key management"""
        self.devices[device_name] = {
            'device_path': device_path,
            'added_date': time.time()
        }
        
        if policy:
            self.rotation_policies[device_name] = policy
        else:
            self.rotation_policies[device_name] = KeyRotationPolicy()
        
        self.key_metadata[device_name] = {}
        
        # Scan existing key slots
        self._scan_existing_keys(device_name)
        
        self.save_configuration()
        self.logger.info(f"Added device {device_name} to key management")
    
    def _scan_existing_keys(self, device_name: str) -> None:
        """Scan and catalog existing LUKS key slots"""
        if device_name not in self.devices:
            return
        
        device_path = self.devices[device_name]['device_path']
        
        try:
            # Get LUKS dump information
            result = subprocess.run(['cryptsetup', 'luksDump', device_path], 
                                  capture_output=True, text=True)
            
            if result.returncode == 0:
                lines = result.stdout.split('\n')
                current_slot = None
                
                for line in lines:
                    if 'Key Slot' in line and 'ENABLED' in line:
                        slot_match = line.split(':')[0].strip()
                        if slot_match.startswith('Key Slot '):
                            slot_num = int(slot_match.split()[-1])
                            
                            # Create metadata for existing key if not present
                            if slot_num not in self.key_metadata[device_name]:
                                self.key_metadata[device_name][slot_num] = KeyMetadata(
                                    created_date=time.time(),
                                    last_used=time.time(),
                                    slot_number=slot_num,
                                    purpose="existing",
                                    creator="system-scan"
                                )
                
                self.logger.info(f"Scanned {len(self.key_metadata[device_name])} key slots for {device_name}")
                
        except Exception as e:
            self.logger.error(f"Failed to scan keys for {device_name}: {e}")
    
    def check_key_rotation_needed(self, device_name: str) -> List[int]:
        """Check which key slots need rotation"""
        if device_name not in self.rotation_policies:
            return []
        
        policy = self.rotation_policies[device_name]
        current_time = time.time()
        slots_needing_rotation = []
        
        for slot, metadata in self.key_metadata.get(device_name, {}).items():
            key_age_days = (current_time - metadata.created_date) / 86400
            
            if key_age_days >= policy.rotation_interval_days:
                slots_needing_rotation.append(slot)
                self.logger.warning(f"Key slot {slot} for {device_name} needs rotation (age: {key_age_days:.1f} days)")
        
        return slots_needing_rotation
    
    def schedule_key_rotation(self, device_name: str, slot: int, 
                             scheduled_time: Optional[float] = None) -> bool:
        """Schedule key rotation for specific slot"""
        if scheduled_time is None:
            scheduled_time = time.time() + 3600  # Default: 1 hour from now
        
        if device_name in self.key_metadata and slot in self.key_metadata[device_name]:
            self.key_metadata[device_name][slot].scheduled_rotation = scheduled_time
            self.save_configuration()
            
            self.logger.info(f"Scheduled key rotation for {device_name} slot {slot} at {time.ctime(scheduled_time)}")
            return True
        
        return False
    
    def rotate_key(self, device_name: str, slot: int, old_password: str, 
                   new_password: str, creator: str = "automated") -> bool:
        """Rotate key in specific slot"""
        if device_name not in self.devices:
            self.logger.error(f"Device {device_name} not found")
            return False
        
        device_path = self.devices[device_name]['device_path']
        
        try:
            # Backup old key if policy requires
            policy = self.rotation_policies.get(device_name, KeyRotationPolicy())
            if policy.backup_old_keys:
                self._backup_key_slot(device_name, slot)
            
            # Remove old key
            old_key_file = f"/tmp/luks_old_{device_name}_{slot}"
            with open(old_key_file, 'w') as f:
                f.write(old_password)
            Path(old_key_file).chmod(0o600)
            
            try:
                subprocess.run(['cryptsetup', 'luksRemoveKey', device_path, 
                              '--key-file', old_key_file, '--key-slot', str(slot)], 
                             check=True)
                
                # Add new key
                new_key_file = f"/tmp/luks_new_{device_name}_{slot}"
                with open(new_key_file, 'w') as f:
                    f.write(new_password)
                Path(new_key_file).chmod(0o600)
                
                # Use another key slot for authentication
                auth_slots = [s for s in self.key_metadata.get(device_name, {}).keys() if s != slot]
                if not auth_slots:
                    raise ValueError("No other key slots available for authentication")
                
                # For simplicity, this assumes you have the master password
                # In practice, you'd need a secure way to authenticate
                subprocess.run(['cryptsetup', 'luksAddKey', device_path, 
                              new_key_file, '--key-slot', str(slot)], 
                             input=old_password, text=True, check=True)
                
                # Update metadata
                self.key_metadata[device_name][slot] = KeyMetadata(
                    created_date=time.time(),
                    last_used=time.time(),
                    slot_number=slot,
                    purpose="rotated",
                    creator=creator,
                    scheduled_rotation=None
                )
                
                self.save_configuration()
                
                # Send notification
                if policy.notify_on_rotation:
                    self._notify_key_rotation(device_name, slot, creator)
                
                self.logger.info(f"Successfully rotated key for {device_name} slot {slot}")
                return True
                
            finally:
                # Clean up temporary files
                Path(old_key_file).unlink(missing_ok=True)
                Path(new_key_file).unlink(missing_ok=True)
                
        except Exception as e:
            self.logger.error(f"Failed to rotate key for {device_name} slot {slot}: {e}")
            return False
    
    def _backup_key_slot(self, device_name: str, slot: int) -> bool:
        """Backup key slot information"""
        try:
            backup_dir = Path(f"/etc/luks/backups/{device_name}")
            backup_dir.mkdir(parents=True, exist_ok=True)
            backup_dir.chmod(0o700)
            
            # Backup key metadata
            if device_name in self.key_metadata and slot in self.key_metadata[device_name]:
                metadata = self.key_metadata[device_name][slot]
                backup_file = backup_dir / f"slot_{slot}_metadata_{int(time.time())}.json"
                
                with open(backup_file, 'w') as f:
                    json.dump(asdict(metadata), f, indent=2)
                backup_file.chmod(0o600)
            
            self.logger.info(f"Backed up key slot {slot} for {device_name}")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to backup key slot {slot} for {device_name}: {e}")
            return False
    
    def _notify_key_rotation(self, device_name: str, slot: int, creator: str) -> None:
        """Send notification about key rotation"""
        message = f"LUKS key rotation completed for device {device_name}, slot {slot} by {creator}"
        
        # Log to syslog
        self.logger.warning(message)
        
        # Send email notifications
        for handler in self.notification_handlers:
            try:
                handler(device_name, slot, creator, message)
            except Exception as e:
                self.logger.error(f"Notification handler failed: {e}")
    
    def add_notification_handler(self, handler_func) -> None:
        """Add notification handler function"""
        self.notification_handlers.append(handler_func)
    
    def _setup_scheduler(self) -> None:
        """Setup automated key rotation scheduler"""
        def check_all_devices():
            for device_name in self.devices:
                slots_needing_rotation = self.check_key_rotation_needed(device_name)
                
                for slot in slots_needing_rotation:
                    metadata = self.key_metadata[device_name][slot]
                    policy = self.rotation_policies[device_name]
                    
                    # Check if rotation is already scheduled
                    if metadata.scheduled_rotation is None:
                        # Schedule rotation for next maintenance window (example: 2 AM)
                        next_rotation = time.time() + 86400  # Tomorrow
                        self.schedule_key_rotation(device_name, slot, next_rotation)
                        
                        # Send warning notification
                        warning_message = f"Key rotation scheduled for {device_name} slot {slot}"
                        self.logger.warning(warning_message)
        
        def process_scheduled_rotations():
            current_time = time.time()
            
            for device_name, device_metadata in self.key_metadata.items():
                for slot, metadata in device_metadata.items():
                    if (metadata.scheduled_rotation and 
                        metadata.scheduled_rotation <= current_time):
                        
                        policy = self.rotation_policies.get(device_name, KeyRotationPolicy())
                        
                        if policy.require_dual_approval:
                            self.logger.warning(f"Key rotation for {device_name} slot {slot} requires manual approval")
                            # In practice, you'd implement an approval workflow
                        else:
                            # Auto-rotate with generated password
                            new_password = self._generate_secure_password()
                            if self.rotate_key(device_name, slot, "current_password", new_password, "automated"):
                                self.logger.info(f"Automated key rotation completed for {device_name} slot {slot}")
        
        # Schedule daily checks
        schedule.every().day.at("01:00").do(check_all_devices)
        schedule.every().hour.do(process_scheduled_rotations)
        
        # Start scheduler thread
        def run_scheduler():
            while True:
                schedule.run_pending()
                time.sleep(60)
        
        scheduler_thread = threading.Thread(target=run_scheduler, daemon=True)
        scheduler_thread.start()
        
        self.logger.info("Key rotation scheduler started")
    
    def _generate_secure_password(self, length: int = 32) -> str:
        """Generate secure password for key rotation"""
        import secrets
        import string
        
        alphabet = string.ascii_letters + string.digits + "!@#$%^&*"
        return ''.join(secrets.choice(alphabet) for _ in range(length))
    
    def generate_key_management_report(self) -> str:
        """Generate comprehensive key management report"""
        report = []
        report.append("ENTERPRISE LUKS KEY MANAGEMENT REPORT")
        report.append("=" * 50)
        report.append(f"Generated: {time.ctime()}")
        report.append("")
        
        for device_name, device_info in self.devices.items():
            report.append(f"Device: {device_name}")
            report.append(f"Path: {device_info['device_path']}")
            
            policy = self.rotation_policies.get(device_name, KeyRotationPolicy())
            report.append(f"Rotation Interval: {policy.rotation_interval_days} days")
            
            device_metadata = self.key_metadata.get(device_name, {})
            report.append(f"Key Slots: {len(device_metadata)}")
            
            for slot, metadata in device_metadata.items():
                age_days = (time.time() - metadata.created_date) / 86400
                status = "OK"
                
                if age_days >= policy.rotation_interval_days:
                    status = "NEEDS ROTATION"
                elif age_days >= (policy.rotation_interval_days - policy.warning_days_before):
                    status = "WARNING"
                
                report.append(f"  Slot {slot}: {metadata.purpose} by {metadata.creator} "
                             f"({age_days:.1f} days) - {status}")
                
                if metadata.scheduled_rotation:
                    report.append(f"    Scheduled rotation: {time.ctime(metadata.scheduled_rotation)}")
            
            report.append("")
        
        return "\n".join(report)

# Email notification handler
def email_notification_handler(smtp_server: str, smtp_port: int, 
                             username: str, password: str, 
                             recipients: List[str]):
    """Create email notification handler"""
    def handler(device_name: str, slot: int, creator: str, message: str):
        msg = MIMEMultipart()
        msg['From'] = username
        msg['To'] = ', '.join(recipients)
        msg['Subject'] = f"LUKS Key Rotation - {device_name}"
        
        body = f"""
LUKS Key Rotation Notification

Device: {device_name}
Key Slot: {slot}
Rotated By: {creator}
Timestamp: {time.ctime()}

Message: {message}

This is an automated notification from the Enterprise LUKS Key Management System.
"""
        
        msg.attach(MIMEText(body, 'plain'))
        
        with smtplib.SMTP(smtp_server, smtp_port) as server:
            server.starttls()
            server.login(username, password)
            server.send_message(msg)
    
    return handler

# Webhook notification handler
def webhook_notification_handler(webhook_url: str, auth_token: Optional[str] = None):
    """Create webhook notification handler"""
    def handler(device_name: str, slot: int, creator: str, message: str):
        payload = {
            'device_name': device_name,
            'key_slot': slot,
            'creator': creator,
            'message': message,
            'timestamp': time.time()
        }
        
        headers = {'Content-Type': 'application/json'}
        if auth_token:
            headers['Authorization'] = f'Bearer {auth_token}'
        
        requests.post(webhook_url, json=payload, headers=headers, timeout=10)
    
    return handler

# Example usage
def setup_enterprise_key_management():
    """Example enterprise key management setup"""
    key_manager = EnterpriseKeyManager()
    
    # Add devices
    key_manager.add_device(
        "root_disk", 
        "/dev/sda1", 
        KeyRotationPolicy(
            rotation_interval_days=60,
            warning_days_before=7,
            require_dual_approval=True
        )
    )
    
    key_manager.add_device(
        "data_disk", 
        "/dev/sdb1", 
        KeyRotationPolicy(
            rotation_interval_days=90,
            warning_days_before=14,
            require_dual_approval=False
        )
    )
    
    # Add notification handlers
    email_handler = email_notification_handler(
        "smtp.company.com", 587,
        "luks-alerts@company.com", "password",
        ["admin@company.com", "security@company.com"]
    )
    key_manager.add_notification_handler(email_handler)
    
    webhook_handler = webhook_notification_handler(
        "https://monitoring.company.com/webhooks/luks-alerts",
        "auth_token_here"
    )
    key_manager.add_notification_handler(webhook_handler)
    
    return key_manager

if __name__ == "__main__":
    # Demonstration
    key_manager = setup_enterprise_key_management()
    
    print("Enterprise Key Management System initialized")
    print(key_manager.generate_key_management_report())
```

This comprehensive enterprise LUKS guide provides production-ready frameworks for full disk encryption, remote unlock automation, and advanced key management. The included tools support high availability deployments, automated security operations, and enterprise-grade compliance requirements essential for protecting critical infrastructure in modern data center environments.