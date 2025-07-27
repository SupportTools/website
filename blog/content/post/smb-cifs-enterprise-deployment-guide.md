---
title: "Enterprise SMB/CIFS Deployment Guide: Advanced Configuration, Security, and Performance Optimization"
date: 2025-03-04T10:00:00-05:00
draft: false
tags: ["SMB", "CIFS", "Samba", "File Sharing", "Network Storage", "Enterprise", "Linux", "Active Directory", "Security", "Performance"]
categories:
- Network Storage
- Enterprise Infrastructure
- Linux
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide for enterprise SMB/CIFS deployment covering advanced Samba configuration, Active Directory integration, security hardening, performance optimization, and high availability strategies"
more_link: "yes"
url: "/smb-cifs-enterprise-deployment-guide/"
---

Server Message Block (SMB) and Common Internet File System (CIFS) protocols provide enterprise-grade network file sharing capabilities across heterogeneous environments. This comprehensive guide covers advanced Samba deployment, Active Directory integration, security hardening, performance optimization, and high availability strategies for production enterprise environments.

<!--more-->

# [SMB/CIFS Protocol Overview](#smb-cifs-protocol-overview)

## Protocol Evolution and Features

### SMB Protocol Versions
- **SMB 1.0/CIFS**: Legacy protocol (deprecated due to security vulnerabilities)
- **SMB 2.0**: Improved performance, reduced chattiness, enhanced security
- **SMB 2.1**: Opportunistic locking improvements, large MTU support
- **SMB 3.0**: Encryption, multichannel, transparent failover
- **SMB 3.1.1**: Pre-authentication integrity, encryption improvements

### Enterprise Features
- **Multichannel**: Multiple network connections for performance and redundancy
- **Transparent Failover**: Automatic connection recovery during outages
- **End-to-end Encryption**: In-transit data protection
- **Opportunistic Locking**: Performance optimization through client-side caching
- **Distributed File System (DFS)**: Namespace aggregation and redundancy

## Architecture Components

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   SMB Client    │────│  Network Layer  │────│   SMB Server    │
│                 │    │   (TCP/445)     │    │   (Samba)       │
├─────────────────┤    ├─────────────────┤    ├─────────────────┤
│ Authentication  │    │   SMB Protocol  │    │ Share Management│
│ Authorization   │    │   Negotiation   │    │ User Management │
│ File Operations │    │   Encryption    │    │ Access Control  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

# [Client Configuration and Management](#client-configuration-management)

## Advanced Client Installation

### Package Installation and Dependencies

```bash
# Debian/Ubuntu systems
apt update && apt install -y \
    cifs-utils \
    smbclient \
    winbind \
    libnss-winbind \
    libpam-winbind \
    krb5-user \
    realmd

# RHEL/CentOS/Rocky Linux systems
dnf install -y \
    cifs-utils \
    samba-client \
    samba-winbind \
    krb5-workstation \
    realmd \
    oddjob-mkhomedir

# Verify installation and protocol support
smbclient --version
modinfo cifs
```

### Kerberos Configuration for Enterprise Authentication

```bash
# Configure Kerberos for Active Directory integration
cat > /etc/krb5.conf << 'EOF'
[libdefaults]
    default_realm = CORP.EXAMPLE.COM
    dns_lookup_realm = true
    dns_lookup_kdc = true
    ticket_lifetime = 24h
    renew_lifetime = 7d
    forwardable = true
    rdns = false
    default_ccache_name = KEYRING:persistent:%{uid}

[realms]
    CORP.EXAMPLE.COM = {
        kdc = dc1.corp.example.com
        kdc = dc2.corp.example.com
        admin_server = dc1.corp.example.com
        default_domain = corp.example.com
    }

[domain_realm]
    .corp.example.com = CORP.EXAMPLE.COM
    corp.example.com = CORP.EXAMPLE.COM
EOF
```

## Secure Mount Operations

### Credential Management

```bash
# Create secure credential store
mkdir -p /etc/cifs-credentials
chmod 700 /etc/cifs-credentials

# Domain authentication credentials
cat > /etc/cifs-credentials/domain-user.cred << 'EOF'
username=serviceaccount
password=SecurePassword123!
domain=CORP.EXAMPLE.COM
EOF

# Service account with restricted permissions
cat > /etc/cifs-credentials/backup-service.cred << 'EOF'
username=backup-svc
password=BackupServicePassword456!
domain=CORP.EXAMPLE.COM
workgroup=CORP
EOF

# Set restrictive permissions
chmod 600 /etc/cifs-credentials/*.cred
chown root:root /etc/cifs-credentials/*.cred
```

### Advanced Mount Options

```bash
# High-performance enterprise mount
mount -t cifs //fileserver.corp.example.com/data /mnt/enterprise-data \
    -o credentials=/etc/cifs-credentials/domain-user.cred,\
vers=3.1.1,\
sec=krb5i,\
cache=strict,\
multichannel,\
resilient,\
_netdev,\
uid=1000,\
gid=1000,\
file_mode=0664,\
dir_mode=0775,\
iocharset=utf8,\
rsize=1048576,\
wsize=1048576,\
echo_interval=60

# Encrypted mount for sensitive data
mount -t cifs //fileserver.corp.example.com/confidential /mnt/confidential \
    -o credentials=/etc/cifs-credentials/domain-user.cred,\
vers=3.1.1,\
sec=krb5p,\
encrypt,\
seal,\
cache=none,\
_netdev,\
uid=0,\
gid=0,\
file_mode=0600,\
dir_mode=0700
```

### Enterprise fstab Configuration

```bash
# /etc/fstab - Enterprise SMB mounts
# High-performance data shares
//fileserver.corp.example.com/data /mnt/data cifs credentials=/etc/cifs-credentials/domain-user.cred,vers=3.1.1,sec=krb5i,multichannel,resilient,_netdev,uid=1000,gid=1000,file_mode=0664,dir_mode=0775,noauto,x-systemd.automount,x-systemd.device-timeout=30 0 0

# Backup storage with encryption
//backup.corp.example.com/backups /mnt/backups cifs credentials=/etc/cifs-credentials/backup-service.cred,vers=3.1.1,sec=krb5p,encrypt,_netdev,uid=0,gid=0,file_mode=0600,dir_mode=0700,noauto,x-systemd.automount 0 0

# Home directories with user mapping
//homeserver.corp.example.com/homes /home/network cifs credentials=/etc/cifs-credentials/domain-user.cred,vers=3.1.1,sec=krb5i,multiuser,_netdev,file_mode=0600,dir_mode=0700,noauto,x-systemd.automount 0 0

# DFS root for namespace aggregation
//corp.example.com/dfs /mnt/dfs cifs credentials=/etc/cifs-credentials/domain-user.cred,vers=3.1.1,sec=krb5i,_netdev,noauto,x-systemd.automount 0 0
```

## Automated Mount Management

### Systemd Automount Configuration

```ini
# /etc/systemd/system/mnt-enterprise\x2ddata.automount
[Unit]
Description=Automount Enterprise Data Share
Requires=network-online.target
After=network-online.target

[Automount]
Where=/mnt/enterprise-data
TimeoutIdleSec=300
DirectoryMode=0755

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/mnt-enterprise\x2ddata.mount
[Unit]
Description=Enterprise Data SMB Share
Requires=network-online.target
After=network-online.target

[Mount]
What=//fileserver.corp.example.com/data
Where=/mnt/enterprise-data
Type=cifs
Options=credentials=/etc/cifs-credentials/domain-user.cred,vers=3.1.1,sec=krb5i,multichannel,resilient,uid=1000,gid=1000,file_mode=0664,dir_mode=0775

[Install]
WantedBy=multi-user.target
```

# [Enterprise Samba Server Deployment](#enterprise-samba-server-deployment)

## Advanced Installation and Configuration

### Comprehensive Package Installation

```bash
# Debian/Ubuntu enterprise installation
apt update && apt install -y \
    samba \
    samba-dsdb-modules \
    samba-vfs-modules \
    winbind \
    libpam-winbind \
    libnss-winbind \
    krb5-kdc \
    krb5-admin-server \
    slapd \
    ldap-utils \
    tdb-tools \
    ldb-tools \
    attr \
    acl

# RHEL/CentOS enterprise installation
dnf install -y \
    samba \
    samba-winbind \
    samba-winbind-clients \
    samba-common-tools \
    samba-vfs-iouring \
    krb5-server \
    krb5-libs \
    openldap-servers \
    openldap-clients \
    tdb-tools \
    attr \
    acl

# Enable extended attributes on filesystem
mount -o remount,user_xattr,acl /
```

### Enterprise Samba Configuration

```ini
# /etc/samba/smb.conf - Enterprise Configuration
[global]
    # Server identification
    workgroup = CORP
    realm = CORP.EXAMPLE.COM
    netbios name = FILESERVER01
    server string = Enterprise File Server %v
    
    # Protocol and security settings
    server min protocol = SMB2_10
    server max protocol = SMB3_11
    client min protocol = SMB2_10
    client max protocol = SMB3_11
    
    # Authentication and authorization
    security = ADS
    auth methods = winbind sam_ignoredomain
    winbind use default domain = yes
    winbind offline logon = yes
    winbind enum users = no
    winbind enum groups = no
    winbind cache time = 300
    winbind max clients = 200
    
    # Kerberos configuration
    kerberos method = secrets and keytab
    dedicated keytab file = /etc/krb5.keytab
    kerberos encryption types = strong
    
    # Performance optimization
    socket options = TCP_NODELAY IPTOS_LOWDELAY SO_RCVBUF=524288 SO_SNDBUF=524288
    read raw = yes
    write raw = yes
    max xmit = 65535
    dead time = 15
    getwd cache = yes
    
    # Advanced features
    enable core files = no
    kernel oplocks = yes
    kernel share modes = yes
    posix locking = yes
    strict locking = auto
    
    # VFS modules for enterprise features
    vfs objects = acl_xattr catia fruit streams_xattr
    
    # Logging and auditing
    log level = 1 auth_audit:3 auth_json_audit:3
    log file = /var/log/samba/log.%m
    max log size = 50000
    syslog = 1
    
    # Guest access restrictions
    restrict anonymous = 2
    null passwords = no
    obey pam restrictions = yes
    
    # Network and name resolution
    dns proxy = no
    wins support = no
    local master = no
    preferred master = no
    
    # File system permissions
    inherit permissions = yes
    inherit acls = yes
    inherit owner = yes
    create mask = 0664
    directory mask = 0775
    force create mode = 0
    force directory mode = 0
    
    # Extended attributes and ACLs
    ea support = yes
    store dos attributes = yes
    map acl inherit = yes
    map archive = no
    map hidden = no
    map readonly = no
    map system = no
    
    # Performance tuning
    aio read size = 16384
    aio write size = 16384
    aio write behind = true
    
    # SMB3 encryption
    smb encrypt = desired
    server smb encrypt = desired
```

## Active Directory Integration

### Domain Join Configuration

```bash
#!/bin/bash
# Enterprise Active Directory join script

set -euo pipefail

DOMAIN="CORP.EXAMPLE.COM"
DOMAIN_CONTROLLER="dc1.corp.example.com"
ADMIN_USER="administrator"
OU="OU=Linux Servers,OU=Servers,DC=corp,DC=example,DC=com"

# Configure DNS resolution
cat > /etc/systemd/resolved.conf << EOF
[Resolve]
DNS=192.168.1.10 192.168.1.11
Domains=corp.example.com
DNSSEC=false
Cache=yes
EOF

systemctl restart systemd-resolved

# Join domain with specific OU placement
echo "Joining domain: $DOMAIN"
realm join --membership-software=samba \
           --client-software=winbind \
           --server-software=active-directory \
           --computer-ou="$OU" \
           --user="$ADMIN_USER" \
           "$DOMAIN"

# Configure NSS for user resolution
sed -i 's/^passwd:.*/passwd: files winbind/' /etc/nsswitch.conf
sed -i 's/^group:.*/group: files winbind/' /etc/nsswitch.conf

# Configure PAM for authentication
pam-auth-update --enable winbind

# Test domain connectivity
echo "Testing domain connectivity..."
wbinfo --ping-dc
wbinfo --trusted-domains
wbinfo -u | head -5
wbinfo -g | head -5

# Start and enable services
systemctl enable winbind smbd nmbd
systemctl restart winbind smbd nmbd

echo "Domain join completed successfully"
```

### Advanced Share Configuration

```ini
# Enterprise share configurations

# Executive shared storage with encryption
[executive]
    comment = Executive Secure Storage
    path = /srv/samba/executive
    browseable = yes
    guest ok = no
    read only = no
    create mask = 0660
    directory mask = 0770
    valid users = @"CORP\Domain Admins" @"CORP\Executive Staff"
    admin users = @"CORP\Domain Admins"
    inherit acls = yes
    inherit permissions = yes
    vfs objects = acl_xattr audit streams_xattr
    smb encrypt = required
    audit:priority = notice
    audit:facility = local5
    audit:success = open opendir write unlink mkdir rmdir rename
    audit:failure = all

# Department collaboration space
[departments]
    comment = Department Collaboration Area
    path = /srv/samba/departments
    browseable = yes
    guest ok = no
    read only = no
    create mask = 0664
    directory mask = 0775
    valid users = @"CORP\Domain Users"
    write list = @"CORP\Department Leads"
    force group = "CORP\Department Users"
    inherit acls = yes
    inherit permissions = yes
    vfs objects = acl_xattr recycle
    recycle:repository = .recycle
    recycle:keeptree = yes
    recycle:versions = yes
    recycle:maxsize = 1073741824

# IT infrastructure and tools
[it-tools]
    comment = IT Tools and Software Repository
    path = /srv/samba/it-tools
    browseable = yes
    guest ok = no
    read only = yes
    write list = @"CORP\IT Administrators"
    valid users = @"CORP\Domain Users"
    admin users = @"CORP\IT Administrators"
    inherit acls = yes
    vfs objects = acl_xattr readonly
    
# Backup staging area
[backup-staging]
    comment = Backup Staging Area
    path = /srv/samba/backup-staging
    browseable = no
    guest ok = no
    read only = no
    create mask = 0600
    directory mask = 0700
    valid users = backup-service
    admin users = @"CORP\Backup Operators"
    inherit acls = yes
    hide dot files = yes
    delete readonly = yes
    
# Public read-only resources
[public-resources]
    comment = Public Company Resources
    path = /srv/samba/public
    browseable = yes
    guest ok = yes
    read only = yes
    create mask = 0644
    directory mask = 0755
    hosts allow = 192.168.1.0/24 10.0.0.0/8
    vfs objects = readonly
```

# [Security Hardening and Best Practices](#security-hardening-best-practices)

## Advanced Authentication Configuration

### Multi-Factor Authentication Integration

```bash
# Install and configure FreeRADIUS integration
apt install -y freeradius freeradius-utils libpam-radius-auth

# Configure PAM for RADIUS authentication
cat > /etc/pam.d/samba << 'EOF'
# Multi-factor authentication for Samba
auth    [success=1 default=ignore]  pam_radius_auth.so
auth    requisite                   pam_deny.so
auth    required                    pam_permit.so
account [success=1 new_authtok_reqd=done default=ignore]    pam_unix.so
account requisite                   pam_deny.so
account required                    pam_permit.so
EOF

# RADIUS client configuration
cat > /etc/pam_radius_auth.conf << 'EOF'
# RADIUS server configuration
radius.corp.example.com:1812    shared_secret_here    3
radius2.corp.example.com:1812   shared_secret_here    3
EOF

chmod 600 /etc/pam_radius_auth.conf
```

### Certificate-Based Authentication

```bash
# Generate certificate authority for SMB
mkdir -p /etc/samba/tls
cd /etc/samba/tls

# Create CA private key
openssl genrsa -aes256 -out ca-key.pem 4096

# Create CA certificate
openssl req -new -x509 -days 3650 -key ca-key.pem -sha256 -out ca.pem \
    -subj "/C=US/ST=State/L=City/O=Corporation/OU=IT Department/CN=SMB CA"

# Generate server private key
openssl genrsa -out server-key.pem 4096

# Create certificate signing request
openssl req -subj "/CN=fileserver.corp.example.com" -sha256 -new \
    -key server-key.pem -out server.csr

# Create extensions file
cat > server-extfile.cnf << 'EOF'
subjectAltName = DNS:fileserver.corp.example.com,DNS:fileserver,IP:192.168.1.100
extendedKeyUsage = serverAuth
EOF

# Sign server certificate
openssl x509 -req -days 365 -sha256 -in server.csr -CA ca.pem \
    -CAkey ca-key.pem -out server-cert.pem -extfile server-extfile.cnf -CAcreateserial

# Set permissions
chmod 400 server-key.pem ca-key.pem
chmod 444 server-cert.pem ca.pem
chown root:root *.pem

# Configure Samba to use certificates
cat >> /etc/samba/smb.conf << 'EOF'
    # TLS configuration
    tls enabled = yes
    tls keyfile = /etc/samba/tls/server-key.pem
    tls certfile = /etc/samba/tls/server-cert.pem
    tls cafile = /etc/samba/tls/ca.pem
    tls verify peer = ca_and_name_if_available
EOF
```

## Access Control and Auditing

### Fine-Grained Access Control

```python
#!/usr/bin/env python3
"""
Enterprise Samba Access Control Manager
"""

import subprocess
import json
import ldap3
from pathlib import Path
import logging

class SambaACLManager:
    def __init__(self, domain_controller="dc1.corp.example.com", 
                 base_dn="DC=corp,DC=example,DC=com"):
        self.dc = domain_controller
        self.base_dn = base_dn
        self.logger = logging.getLogger(__name__)
        
    def get_domain_groups(self):
        """Retrieve domain groups from Active Directory"""
        try:
            server = ldap3.Server(self.dc, use_ssl=True)
            conn = ldap3.Connection(server, auto_bind=True, 
                                  authentication=ldap3.NTLM,
                                  user="CORP\\service-account",
                                  password="ServicePassword123!")
            
            conn.search(self.base_dn, 
                       '(objectClass=group)',
                       attributes=['cn', 'distinguishedName', 'description'])
            
            groups = []
            for entry in conn.entries:
                groups.append({
                    'name': str(entry.cn),
                    'dn': str(entry.distinguishedName),
                    'description': str(entry.description) if entry.description else ''
                })
            
            return groups
            
        except Exception as e:
            self.logger.error(f"Failed to retrieve domain groups: {e}")
            return []
    
    def set_share_permissions(self, share_path, permissions_config):
        """Set comprehensive share permissions"""
        share_path = Path(share_path)
        
        if not share_path.exists():
            self.logger.error(f"Share path does not exist: {share_path}")
            return False
        
        try:
            # Set basic filesystem permissions
            subprocess.run(['chmod', '755', str(share_path)], check=True)
            
            # Clear existing ACLs
            subprocess.run(['setfacl', '-b', str(share_path)], check=True)
            
            # Set ACLs based on configuration
            for perm in permissions_config:
                group = perm['group']
                access = perm['access']  # 'read', 'write', 'full'
                recursive = perm.get('recursive', True)
                
                if access == 'read':
                    acl_perms = 'r-x'
                elif access == 'write':
                    acl_perms = 'rwx'
                elif access == 'full':
                    acl_perms = 'rwx'
                else:
                    continue
                
                # Set group ACL
                cmd = ['setfacl', '-m', f'g:{group}:{acl_perms}', str(share_path)]
                if recursive:
                    cmd.insert(1, '-R')
                
                subprocess.run(cmd, check=True)
                
                # Set default ACL for new files/directories
                if recursive:
                    subprocess.run(['setfacl', '-d', '-m', f'g:{group}:{acl_perms}', 
                                  str(share_path)], check=True)
            
            self.logger.info(f"Permissions set successfully for {share_path}")
            return True
            
        except Exception as e:
            self.logger.error(f"Failed to set permissions for {share_path}: {e}")
            return False
    
    def audit_share_access(self, share_path, days=7):
        """Audit share access from Samba logs"""
        try:
            # Parse Samba audit logs
            log_files = ['/var/log/samba/log.audit', '/var/log/samba/audit.log']
            
            access_events = []
            
            for log_file in log_files:
                if Path(log_file).exists():
                    with open(log_file, 'r') as f:
                        for line in f:
                            if share_path in line:
                                # Parse audit log entry
                                try:
                                    # Assuming JSON format audit logs
                                    event = json.loads(line)
                                    access_events.append({
                                        'timestamp': event.get('timestamp'),
                                        'user': event.get('user'),
                                        'action': event.get('action'),
                                        'path': event.get('path'),
                                        'result': event.get('result')
                                    })
                                except json.JSONDecodeError:
                                    # Handle non-JSON log format
                                    pass
            
            return access_events
            
        except Exception as e:
            self.logger.error(f"Failed to audit share access: {e}")
            return []
    
    def generate_access_report(self):
        """Generate comprehensive access report"""
        report = {
            'timestamp': subprocess.run(['date', '-Iseconds'], 
                                      capture_output=True, text=True).stdout.strip(),
            'shares': {},
            'domain_groups': self.get_domain_groups()
        }
        
        # Get all Samba shares
        try:
            result = subprocess.run(['smbclient', '-L', 'localhost', '-N'], 
                                  capture_output=True, text=True)
            
            shares = []
            for line in result.stdout.split('\n'):
                if line.strip().startswith('\\'):
                    share_name = line.split()[0].replace('\\\\localhost\\', '')
                    if share_name not in ['IPC$', 'print$']:
                        shares.append(share_name)
            
            # Analyze each share
            for share in shares:
                share_info = self.analyze_share(share)
                report['shares'][share] = share_info
            
        except Exception as e:
            self.logger.error(f"Failed to generate access report: {e}")
        
        return report
    
    def analyze_share(self, share_name):
        """Analyze individual share configuration and usage"""
        try:
            # Get share configuration from smb.conf
            result = subprocess.run(['testparm', '-s', '--section-name', share_name], 
                                  capture_output=True, text=True)
            
            share_config = {}
            for line in result.stdout.split('\n'):
                if '=' in line:
                    key, value = line.split('=', 1)
                    share_config[key.strip()] = value.strip()
            
            # Get filesystem permissions
            share_path = share_config.get('path', '')
            if share_path and Path(share_path).exists():
                acl_result = subprocess.run(['getfacl', share_path], 
                                          capture_output=True, text=True)
                
                return {
                    'config': share_config,
                    'filesystem_acl': acl_result.stdout,
                    'recent_access': self.audit_share_access(share_path)
                }
            
            return {'config': share_config}
            
        except Exception as e:
            self.logger.error(f"Failed to analyze share {share_name}: {e}")
            return {}

# Example usage and configuration
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    
    acl_manager = SambaACLManager()
    
    # Example permissions configuration
    permissions_config = [
        {
            'group': 'CORP\\Domain Users',
            'access': 'read',
            'recursive': True
        },
        {
            'group': 'CORP\\Department Leads',
            'access': 'write',
            'recursive': True
        },
        {
            'group': 'CORP\\IT Administrators',
            'access': 'full',
            'recursive': True
        }
    ]
    
    # Set permissions for department share
    acl_manager.set_share_permissions('/srv/samba/departments', permissions_config)
    
    # Generate access report
    access_report = acl_manager.generate_access_report()
    
    # Save report
    with open('/var/log/samba/access_report.json', 'w') as f:
        json.dump(access_report, f, indent=2)
```

# [Performance Optimization](#performance-optimization)

## Network and Protocol Tuning

### Advanced Network Configuration

```bash
#!/bin/bash
# SMB/CIFS Performance Optimization Script

# Kernel network parameters for SMB
cat > /etc/sysctl.d/99-smb-performance.conf << 'EOF'
# Network buffer sizes
net.core.rmem_default = 262144
net.core.rmem_max = 16777216
net.core.wmem_default = 262144
net.core.wmem_max = 16777216

# TCP settings for SMB
net.ipv4.tcp_rmem = 4096 65536 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
net.ipv4.tcp_congestion_control = bbr
net.ipv4.tcp_window_scaling = 1
net.ipv4.tcp_timestamps = 1
net.ipv4.tcp_sack = 1
net.ipv4.tcp_no_metrics_save = 1

# SMB multichannel support
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_keepalive_intvl = 15

# File system performance
vm.dirty_background_ratio = 5
vm.dirty_ratio = 10
vm.dirty_expire_centisecs = 3000
vm.dirty_writeback_centisecs = 500
EOF

sysctl -p /etc/sysctl.d/99-smb-performance.conf

# Network interface optimization
for interface in $(ip link show | grep -E '^[0-9]+:' | grep -v lo | cut -d: -f2 | tr -d ' '); do
    echo "Optimizing interface: $interface"
    
    # Enable multi-queue
    ethtool -L $interface combined 4 2>/dev/null || true
    
    # Increase ring buffer sizes
    ethtool -G $interface rx 4096 tx 4096 2>/dev/null || true
    
    # Enable hardware offloading
    ethtool -K $interface tso on gso on lro on gro on 2>/dev/null || true
    
    # Set interrupt coalescing
    ethtool -C $interface rx-usecs 50 tx-usecs 50 2>/dev/null || true
done
```

### Samba Performance Tuning

```ini
# High-performance Samba configuration additions
[global]
    # I/O optimization
    aio read size = 65536
    aio write size = 65536
    aio write behind = true
    use mmap = yes
    
    # Connection optimization
    max connections = 0
    deadtime = 15
    keepalive = 30
    socket options = TCP_NODELAY IPTOS_LOWDELAY SO_RCVBUF=131072 SO_SNDBUF=131072
    
    # Protocol optimization
    large readwrite = yes
    read raw = yes
    write raw = yes
    max xmit = 131072
    min receivefile size = 16384
    
    # SMB3 multichannel
    server multi channel support = yes
    
    # Opportunistic locking
    kernel oplocks = yes
    level2 oplocks = yes
    oplocks = yes
    
    # Directory and file caching
    getwd cache = yes
    stat cache = yes
    
    # Memory optimization
    max open files = 65536
    
    # Disable unnecessary features for performance
    load printers = no
    printing = bsd
    printcap name = /dev/null
    disable spoolss = yes
```

## Storage Optimization

### ZFS Integration for High Performance

```bash
#!/bin/bash
# ZFS setup for high-performance SMB storage

# Install ZFS
apt install -y zfsutils-linux

# Create high-performance ZFS pool
zpool create -o ashift=12 \
    -O compression=lz4 \
    -O atime=off \
    -O recordsize=128K \
    -O primarycache=all \
    -O secondarycache=all \
    -O logbias=throughput \
    tank mirror /dev/sdb /dev/sdc

# Create datasets for different share types
zfs create -o recordsize=64K tank/departments
zfs create -o recordsize=1M tank/backups
zfs create -o recordsize=4K tank/databases
zfs create -o recordsize=128K tank/general

# Set up SMB share directories
mkdir -p /tank/departments /tank/backups /tank/databases /tank/general

# Configure ZFS for SMB
zfs set sharesmb=on tank/departments
zfs set sharesmb=on tank/general

# Performance monitoring
cat > /usr/local/bin/zfs-smb-monitor << 'EOF'
#!/bin/bash
# ZFS SMB performance monitoring

echo "=== ZFS Pool Status ==="
zpool status tank

echo -e "\n=== ZFS Performance Statistics ==="
zpool iostat tank 1 1

echo -e "\n=== Arc Statistics ==="
cat /proc/spl/kstat/zfs/arcstats | grep -E "^(hits|misses|size)"

echo -e "\n=== SMB Connection Statistics ==="
smbstatus --shares
EOF

chmod +x /usr/local/bin/zfs-smb-monitor
```

# [Monitoring and Management](#monitoring-management)

## Comprehensive Monitoring System

### Prometheus Integration

```python
#!/usr/bin/env python3
"""
Samba Metrics Exporter for Prometheus
"""

from prometheus_client import start_http_server, Gauge, Counter, Info
import subprocess
import time
import json
import re
from pathlib import Path

class SambaMetricsExporter:
    def __init__(self, port=9363):
        self.port = port
        
        # Define metrics
        self.samba_up = Gauge('samba_up', 'Samba service status')
        self.winbind_up = Gauge('winbind_up', 'Winbind service status')
        
        self.active_connections = Gauge('samba_active_connections_total', 
                                      'Number of active SMB connections')
        self.locked_files = Gauge('samba_locked_files_total',
                                'Number of locked files')
        
        self.shares_available = Gauge('samba_shares_available',
                                    'Number of configured shares')
        self.share_connections = Gauge('samba_share_connections',
                                     'Active connections per share',
                                     ['share_name'])
        
        # Performance metrics
        self.bytes_read = Counter('samba_bytes_read_total',
                                'Total bytes read from shares')
        self.bytes_written = Counter('samba_bytes_written_total',
                                   'Total bytes written to shares')
        
        # Authentication metrics
        self.auth_success = Counter('samba_auth_success_total',
                                  'Successful authentications')
        self.auth_failure = Counter('samba_auth_failure_total',
                                  'Failed authentications')
        
        # Service information
        self.samba_info = Info('samba_info', 'Samba service information')
        
    def collect_service_status(self):
        """Collect service status metrics"""
        # Check Samba service
        try:
            result = subprocess.run(['systemctl', 'is-active', 'smbd'],
                                  capture_output=True, text=True)
            self.samba_up.set(1 if result.stdout.strip() == 'active' else 0)
        except:
            self.samba_up.set(0)
        
        # Check Winbind service
        try:
            result = subprocess.run(['systemctl', 'is-active', 'winbind'],
                                  capture_output=True, text=True)
            self.winbind_up.set(1 if result.stdout.strip() == 'active' else 0)
        except:
            self.winbind_up.set(0)
    
    def collect_connection_metrics(self):
        """Collect connection and session metrics"""
        try:
            # Get SMB status
            result = subprocess.run(['smbstatus', '--json'],
                                  capture_output=True, text=True)
            
            if result.returncode == 0:
                status_data = json.loads(result.stdout)
                
                # Active connections
                sessions = status_data.get('sessions', {})
                self.active_connections.set(len(sessions))
                
                # Locked files
                locks = status_data.get('locks', {})
                self.locked_files.set(len(locks))
                
                # Share connections
                shares = status_data.get('shares', {})
                self.shares_available.set(len(shares))
                
                # Count connections per share
                share_conn_count = {}
                for session_id, session in sessions.items():
                    share = session.get('service', 'unknown')
                    share_conn_count[share] = share_conn_count.get(share, 0) + 1
                
                # Clear existing share connection metrics
                for share, count in share_conn_count.items():
                    self.share_connections.labels(share_name=share).set(count)
                    
        except Exception as e:
            print(f"Error collecting connection metrics: {e}")
    
    def collect_performance_metrics(self):
        """Collect performance and throughput metrics"""
        try:
            # Parse Samba performance statistics
            # This would typically come from detailed logging or custom accounting
            
            # Example: Parse audit logs for byte counts
            log_file = '/var/log/samba/audit.log'
            if Path(log_file).exists():
                with open(log_file, 'r') as f:
                    # Read last 1000 lines
                    lines = f.readlines()[-1000:]
                    
                    read_bytes = 0
                    write_bytes = 0
                    
                    for line in lines:
                        try:
                            if 'bytes_read' in line:
                                match = re.search(r'bytes_read:(\d+)', line)
                                if match:
                                    read_bytes += int(match.group(1))
                            
                            if 'bytes_written' in line:
                                match = re.search(r'bytes_written:(\d+)', line)
                                if match:
                                    write_bytes += int(match.group(1))
                        except:
                            continue
                    
                    # Update counters (in a real implementation, you'd track deltas)
                    self.bytes_read._value._value = read_bytes
                    self.bytes_written._value._value = write_bytes
                    
        except Exception as e:
            print(f"Error collecting performance metrics: {e}")
    
    def collect_auth_metrics(self):
        """Collect authentication metrics from logs"""
        try:
            log_files = ['/var/log/samba/log.winbind', '/var/log/auth.log']
            
            auth_success_count = 0
            auth_failure_count = 0
            
            for log_file in log_files:
                if Path(log_file).exists():
                    with open(log_file, 'r') as f:
                        # Read recent entries
                        lines = f.readlines()[-500:]
                        
                        for line in lines:
                            if 'authentication for user' in line.lower():
                                if 'succeeded' in line.lower():
                                    auth_success_count += 1
                                elif 'failed' in line.lower():
                                    auth_failure_count += 1
            
            # Update counters
            self.auth_success._value._value = auth_success_count
            self.auth_failure._value._value = auth_failure_count
            
        except Exception as e:
            print(f"Error collecting auth metrics: {e}")
    
    def collect_samba_info(self):
        """Collect Samba version and configuration information"""
        try:
            # Get Samba version
            result = subprocess.run(['smbd', '--version'],
                                  capture_output=True, text=True)
            version = result.stdout.strip() if result.returncode == 0 else 'unknown'
            
            # Get configuration summary
            config_result = subprocess.run(['testparm', '-s'],
                                         capture_output=True, text=True)
            
            workgroup = 'unknown'
            security = 'unknown'
            
            if config_result.returncode == 0:
                for line in config_result.stdout.split('\n'):
                    if 'workgroup' in line:
                        workgroup = line.split('=')[1].strip()
                    elif 'security' in line:
                        security = line.split('=')[1].strip()
            
            self.samba_info.info({
                'version': version,
                'workgroup': workgroup,
                'security_mode': security,
                'config_file': '/etc/samba/smb.conf'
            })
            
        except Exception as e:
            print(f"Error collecting Samba info: {e}")
    
    def collect_all_metrics(self):
        """Collect all metrics"""
        self.collect_service_status()
        self.collect_connection_metrics()
        self.collect_performance_metrics()
        self.collect_auth_metrics()
        self.collect_samba_info()
    
    def start_server(self):
        """Start Prometheus metrics server"""
        start_http_server(self.port)
        print(f"Samba metrics server started on port {self.port}")
        
        while True:
            try:
                self.collect_all_metrics()
            except Exception as e:
                print(f"Error during metrics collection: {e}")
            
            time.sleep(30)

if __name__ == "__main__":
    exporter = SambaMetricsExporter()
    exporter.start_server()
```

## High Availability and Clustering

### CTDB Cluster Configuration

```bash
#!/bin/bash
# Samba CTDB cluster setup for high availability

# Install CTDB
apt install -y ctdb tdb-tools

# Create cluster configuration
mkdir -p /etc/ctdb

# Node configuration
cat > /etc/ctdb/nodes << 'EOF'
192.168.1.101
192.168.1.102
192.168.1.103
EOF

# Public addresses for failover
cat > /etc/ctdb/public_addresses << 'EOF'
192.168.1.100/24 eth0
192.168.1.110/24 eth0
192.168.1.120/24 eth0
EOF

# CTDB configuration
cat > /etc/ctdb/ctdbd.conf << 'EOF'
# CTDB configuration
CTDB_RECOVERY_LOCK="/shared/ctdb/recovery.lock"
CTDB_NODES="/etc/ctdb/nodes"
CTDB_PUBLIC_ADDRESSES="/etc/ctdb/public_addresses"
CTDB_SAMBA_SKIP_SHARE_CHECK="yes"
CTDB_SERVICE_SMB="smbd"
CTDB_SERVICE_NMB="nmbd"
CTDB_SERVICE_WINBIND="winbind"

# Logging
CTDB_LOGFILE="/var/log/ctdb/log.ctdb"
CTDB_DEBUGLEVEL="2"

# Performance tuning
CTDB_SET_MonitorInterval=15
CTDB_SET_RecoveryGracePeriod=120
CTDB_SET_RecoveryBanPeriod=300
EOF

# Shared storage configuration (assuming NFS or cluster filesystem)
cat > /etc/ctdb/events.d/01.reclock << 'EOF'
#!/bin/bash
# Recovery lock setup

case $1 in
    startup)
        mkdir -p /shared/ctdb
        touch /shared/ctdb/recovery.lock
        ;;
esac

exit 0
EOF

chmod +x /etc/ctdb/events.d/01.reclock

# Configure Samba for clustering
cat >> /etc/samba/smb.conf << 'EOF'
    # CTDB clustering
    clustering = yes
    idmap config * : backend = autorid
    idmap config * : range = 1000000-1999999
    winbind normalize names = yes
    winbind use default domain = yes
EOF

# Enable and start services
systemctl enable ctdb
systemctl start ctdb

# Verify cluster status
ctdb status
ctdb ip
```

This comprehensive SMB/CIFS enterprise deployment guide provides production-ready configurations, advanced security practices, performance optimization strategies, and high availability solutions for modern enterprise environments. The combination of Active Directory integration, comprehensive monitoring, and automated management ensures reliable and secure file sharing services across diverse organizational requirements.