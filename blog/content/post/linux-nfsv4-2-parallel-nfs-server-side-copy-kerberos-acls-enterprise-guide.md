---
title: "Linux NFSv4.2: Parallel NFS, Server-Side Copy, Sparse File Support, Kerberos Security, and NFSv4 ACLs"
date: 2032-01-06T00:00:00-05:00
draft: false
tags: ["Linux", "NFS", "NFSv4", "Kerberos", "Storage", "Network", "Security", "Enterprise Storage"]
categories:
- Linux
- Storage
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to NFSv4.2 features including pNFS parallel I/O, server-side copy, sparse file handling, Kerberos security integration, and NFSv4 ACL management."
more_link: "yes"
url: "/linux-nfsv4-2-parallel-nfs-server-side-copy-kerberos-acls-enterprise-guide/"
---

NFSv4.2, defined in RFC 7862, represents the most significant leap in NFS capabilities since the introduction of stateful sessions in NFSv4.0. Enterprise storage teams that continue to operate legacy NFSv3 mounts are leaving substantial performance, security, and operational improvements on the table. This guide covers the complete NFSv4.2 feature set with production deployment patterns: pNFS parallel I/O layouts, server-side copy (SSC) for zero-copy migrations, sparse file awareness for virtual machine images, Kerberos 5 security integration for encrypted and authenticated access, and the NFSv4 ACL model that finally brings POSIX semantics into alignment with enterprise access control requirements.

<!--more-->

# Linux NFSv4.2: Production Enterprise Guide

## NFSv4 Protocol Lineage

Understanding the feature availability matrix prevents deployment surprises:

| Version | RFC | Key Features |
|---------|-----|-------------|
| NFSv3 | 1813 | Stateless, UDP support, no security |
| NFSv4.0 | 3530 | Stateful, compound operations, UTF-8 names |
| NFSv4.1 | 5661 | Sessions, pNFS (parallel NFS), layout types |
| NFSv4.2 | 7862 | Server-side copy, sparse files, application I/O hints |

Kernel support: NFSv4.2 is fully supported from Linux kernel 4.9+. NFSv4.1 pNFS with file layout is available from 3.9+. Production deployment requires kernel 5.4+ (LTS) for stability.

## Kernel and Package Requirements

```bash
# Verify kernel NFSv4 support
grep -r 'CONFIG_NFS' /boot/config-$(uname -r) | grep -E 'NFS_V4|PNFS'
# Expected output:
# CONFIG_NFS_V4=m
# CONFIG_NFS_V4_1=y
# CONFIG_NFS_V4_2=y
# CONFIG_PNFS_FILE_LAYOUT=m
# CONFIG_PNFS_BLOCK_LAYOUT=m
# CONFIG_PNFS_FLEXFILE_LAYOUT=m

# Install NFS utilities (RHEL/Rocky)
dnf install -y nfs-utils nfs4-acl-tools krb5-workstation

# Install NFS utilities (Debian/Ubuntu)
apt-get install -y nfs-kernel-server nfs4-acl-tools krb5-user

# Verify nfs-utils version supports NFSv4.2
rpcinfo -p | grep nfs
nfsstat --version
```

## Part 1: Server Configuration for NFSv4.2

### /etc/exports Configuration

```bash
# /etc/exports — NFSv4.2 optimized

# Enable NFSv4 pseudo-filesystem root
/export    *(ro,fsid=0,no_subtree_check,sec=sys:krb5:krb5i:krb5p)

# Data share with Kerberos required, pNFS enabled
/export/data    10.0.0.0/8(rw,no_subtree_check,no_root_squash,\
                            sec=krb5p,\
                            pnfs,\
                            async,\
                            anonuid=65534,anongid=65534)

# Virtual machine images — sparse file aware
/export/vms    10.0.10.0/24(rw,no_subtree_check,no_root_squash,\
                             sec=krb5i,\
                             async,\
                             nohide)

# Backup target — server-side copy source
/export/backup    10.0.20.0/24(rw,no_subtree_check,root_squash,\
                                sec=krb5i,\
                                async)
```

### /etc/nfs.conf (Modern Configuration)

```ini
# /etc/nfs.conf — replaces /etc/sysconfig/nfs on modern systems

[nfsd]
# Number of NFS server threads — scale with CPU cores and concurrent clients
# Rule of thumb: (CPU cores × 4) to (CPU cores × 8), min 64
threads=128

# Enable NFSv4 only (disable v2/v3 if not needed)
vers2=n
vers3=n
vers4=y
vers4.0=y
vers4.1=y
vers4.2=y

# TCP only (disable UDP)
udp=n
tcp=y

# Port for NFS traffic (standard: 2049)
port=2049

# Grace period for client recovery after server restart
grace-time=90

# Lease duration for client state
lease-time=90

[mountd]
# Disable rpcbind dependency for NFSv4
port=20048
threads=8

[statd]
# For NFSv3 backward compatibility only
port=32765
outgoing-port=32766

[lockd]
# For NFSv3 backward compatibility only
port=32768
udp-port=32768

[nfsrahead]
# Read-ahead tuning
nfs=128
nfsv4=256

[exportd]
threads=8
```

### nfsd Service Configuration

```bash
# Start and enable NFS server services
systemctl enable --now nfs-server
systemctl enable --now rpcbind   # needed for NFSv3 compat
systemctl enable --now rpc-statd  # needed for NFSv3 compat

# Apply exports without full restart
exportfs -rv

# Verify active exports
exportfs -v

# Check which NFS versions are active
cat /proc/fs/nfsd/versions
# Expected: -2 -3 +4 +4.1 +4.2

# Set versions explicitly
echo "+4.2" > /proc/fs/nfsd/versions
echo "-3" > /proc/fs/nfsd/versions
```

### Firewall Configuration for NFSv4

```bash
# NFSv4 requires only TCP/2049 (unlike NFSv3's rpcbind complexity)
# firewalld
firewall-cmd --permanent --add-service=nfs
firewall-cmd --permanent --add-service=rpc-bind
firewall-cmd --permanent --add-service=mountd
firewall-cmd --reload

# Or with nftables directly
cat << 'EOF' > /etc/nftables.d/nfs.nft
table inet nfs {
    chain input {
        type filter hook input priority 0; policy drop;

        # Established connections
        ct state established,related accept

        # NFSv4 - only TCP 2049 needed
        tcp dport 2049 accept

        # NFSv3 portmap (only if needed)
        tcp dport 111 accept
        udp dport 111 accept

        # rpc.mountd (only if needed)
        tcp dport 20048 accept

        # Drop everything else
        drop
    }
}
EOF
nft -f /etc/nftables.d/nfs.nft
```

## Part 2: pNFS — Parallel NFS

### pNFS Architecture

pNFS (parallel NFS) decouples metadata operations from data I/O. The metadata server (MDS) grants clients "layouts" that describe where file data is physically stored, allowing clients to read/write directly to data servers (DS) in parallel, bypassing the MDS for actual I/O.

```
Traditional NFS:
Client → [all I/O] → NFS Server → Storage

pNFS Architecture:
Client → [metadata ops] → Metadata Server (MDS)
                              ↓
                         Layout Grant
                              ↓
Client → [parallel data I/O] → Data Server 1 (DS)
                             → Data Server 2 (DS)
                             → Data Server 3 (DS)
```

Three layout types are defined in NFSv4.1/4.2:

- **File layout** (most common): files striped across multiple NFS servers
- **Block layout**: direct access to block devices (iSCSI/FC)
- **Object layout**: direct access to object storage devices
- **Flex File** (RFC 8435): flexible file layout combining file and block

### pNFS File Layout Server Setup (with NFS Ganesha)

NFS Ganesha supports pNFS natively and is preferred over the kernel NFS server for pNFS deployments:

```bash
# Install NFS Ganesha
dnf install -y nfs-ganesha nfs-ganesha-vfs nfs-ganesha-mem

# Stop kernel NFS server
systemctl disable --now nfs-server
```

```ini
# /etc/ganesha/ganesha.conf — pNFS MDS + DS configuration

NFS_CORE_PARAM {
    Protocols = 4;
    NFS_Port = 2049;
    MNT_Port = 20048;
    NLM_Port = 32803;
    # Enable pNFS
    Enable_NLM = false;
    Enable_RQUOTA = false;
}

NFS_KRB5 {
    PrincipalName = nfs;
    KeytabPath = /etc/krb5.keytab;
    Active_krb5 = true;
}

PNFS {
    # This server is both MDS and DS
    # For separate DS: configure DS_List with remote server addresses
    Enabled = true;
}

EXPORT {
    Export_Id = 100;
    Path = /export/data;
    Pseudo = /data;
    Protocols = 4;
    Transports = TCP;
    Access_Type = RW;
    SecType = krb5p;
    Squash = no_root_squash;

    # Enable pNFS file layout
    FSAL {
        Name = VFS;
        # pNFS striping parameters
        pnfs_enabled = true;
        stripe_size = 65536;    # 64KB stripe unit
        stripe_count = 4;       # stripe across 4 DS
    }
}
```

### Client pNFS Configuration

```bash
# Mount with NFSv4.1 or 4.2 (pNFS requires 4.1+)
mount -t nfs4 \
    -o vers=4.2,proto=tcp,sec=krb5p,noresvport,rsize=1048576,wsize=1048576 \
    nfs-server.example.com:/data \
    /mnt/data

# Verify pNFS is active
cat /proc/self/mountinfo | grep nfs

# Check pNFS layout stats
nfsstat -m | grep -A 10 "pnfs"

# Monitor pNFS I/O
mountstats /mnt/data
# Look for "pNFS_io_bytes_read" and "pNFS_io_bytes_write"
```

### /etc/fstab for Persistent pNFS Mounts

```fstab
# /etc/fstab — NFSv4.2 pNFS entries

# High-performance data share
nfs-server.example.com:/data  /mnt/data  nfs4  \
    vers=4.2,proto=tcp,sec=krb5p,\
    rsize=1048576,wsize=1048576,\
    noresvport,\
    hard,timeo=600,retrans=3,\
    intr,\
    _netdev  0 0

# VM image storage (sparse file aware)
nfs-server.example.com:/vms  /mnt/vms  nfs4  \
    vers=4.2,proto=tcp,sec=krb5i,\
    rsize=524288,wsize=524288,\
    noresvport,\
    hard,timeo=300,retrans=2,\
    _netdev  0 0
```

## Part 3: Server-Side Copy (SSC)

### How SSC Works

NFSv4.2 Server-Side Copy (RFC 7862 §4) allows a client to instruct the server to copy file data between two files entirely on the server, without the data traversing the network to the client and back. This is critical for:

- VM disk migrations within a storage cluster
- Large dataset duplications for analytics pipelines
- Backup operations where source and destination share a server
- File tiering operations

Two variants:
- **Intra-server copy**: both source and destination are on the same NFS server (most efficient)
- **Inter-server copy**: source on one server, destination on another (server-to-server transfer)

### Triggering SSC from Linux

The `copy_file_range(2)` system call triggers SSC when both file descriptors refer to NFSv4.2 mounts:

```c
/* server_side_copy.c — example of explicit SSC via copy_file_range */
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <linux/fs.h>

int main(int argc, char *argv[]) {
    if (argc != 3) {
        fprintf(stderr, "Usage: %s <src> <dst>\n", argv[0]);
        return 1;
    }

    int src_fd = open(argv[1], O_RDONLY);
    if (src_fd < 0) { perror("open src"); return 1; }

    struct stat st;
    if (fstat(src_fd, &st) < 0) { perror("fstat"); return 1; }

    int dst_fd = open(argv[2], O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (dst_fd < 0) { perror("open dst"); return 1; }

    if (ftruncate(dst_fd, st.st_size) < 0) { perror("ftruncate"); return 1; }

    off_t off_src = 0, off_dst = 0;
    ssize_t copied;
    size_t remaining = (size_t)st.st_size;

    while (remaining > 0) {
        /* copy_file_range issues NFS4_OP_COPY on NFSv4.2 mounts */
        copied = copy_file_range(src_fd, &off_src, dst_fd, &off_dst,
                                 remaining, 0);
        if (copied < 0) {
            perror("copy_file_range");
            /* Fall back to read/write if SSC not supported */
            fprintf(stderr, "SSC not available, falling back to userspace copy\n");
            return 1;
        }
        if (copied == 0) break;
        remaining -= (size_t)copied;
    }

    close(src_fd);
    close(dst_fd);
    printf("Copied %zu bytes (server-side)\n", (size_t)st.st_size);
    return 0;
}
```

### Shell-Level SSC with cp and rsync

Modern `cp` uses `copy_file_range` automatically when available:

```bash
# cp automatically uses copy_file_range (SSC) when possible
# Verify with strace
strace -e trace=copy_file_range cp /mnt/nfs/large-file.vmdk /mnt/nfs/backup/large-file.vmdk

# rsync with --inplace uses copy_file_range for unchanged regions
rsync --inplace --partial --progress \
    /mnt/nfs/vms/server1.vmdk \
    /mnt/nfs/backup/server1.vmdk

# Check if SSC was used (kernel traces it)
grep copy_file_range /proc/$(pgrep cp)/syscall 2>/dev/null || true
```

### SSC Performance Measurement

```bash
#!/bin/bash
# benchmark-ssc.sh — compare SSC vs userspace copy

set -euo pipefail

SRC="/mnt/nfs/test-data/10G-testfile"
DST_SSC="/mnt/nfs/test-data/10G-copy-ssc"
DST_DD="/mnt/nfs/test-data/10G-copy-dd"

# Create source file
dd if=/dev/urandom of="$SRC" bs=1M count=10240 status=progress

# Warm caches
sync

# Method 1: copy_file_range (SSC)
echo "=== Server-Side Copy ==="
time cp "$SRC" "$DST_SSC"
sync

# Method 2: Traditional dd (client-side copy through network)
echo "=== Userspace Copy via dd ==="
time dd if="$SRC" of="$DST_DD" bs=1M status=progress

# Cleanup
rm -f "$DST_SSC" "$DST_DD"
```

Expected results on a 10GbE connected storage system:
- SSC: ~0.3s for 10GB (network not involved)
- dd: ~8-12s for 10GB (full network round-trip)

## Part 4: Sparse File Support

### NFSv4.2 Sparse File Operations

NFSv4.2 adds two operations for efficient sparse file handling:

- **SEEK** (`lseek` with `SEEK_DATA`/`SEEK_HOLE`): skip over holes without reading zeros
- **ALLOCATE/DEALLOCATE**: punch holes and pre-allocate space server-side

```bash
# Check sparse file support on mounted filesystem
python3 -c "
import os
import stat

# Create a sparse file
fd = os.open('/mnt/nfs/test-sparse', os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o644)
os.ftruncate(fd, 100 * 1024 * 1024)  # 100MB logical size
os.lseek(fd, 50 * 1024 * 1024, os.SEEK_SET)
os.write(fd, b'data at 50MB offset')
os.close(fd)

# Read back using SEEK_DATA/SEEK_HOLE
fd = os.open('/mnt/nfs/test-sparse', os.O_RDONLY)
import ctypes
SEEK_DATA = 3
SEEK_HOLE = 4

# Find first data extent
data_start = os.lseek(fd, 0, SEEK_DATA)
# Find end of data extent (start of next hole)
hole_start = os.lseek(fd, data_start, SEEK_HOLE)

print(f'Hole: 0 -> {data_start} bytes')
print(f'Data: {data_start} -> {hole_start} bytes')
print(f'Hole: {hole_start} -> EOF')

st = os.stat('/mnt/nfs/test-sparse')
print(f'Logical size: {st.st_size} bytes')
print(f'Physical size: {st.st_blocks * 512} bytes')
os.close(fd)
"
```

### VM Disk Sparse Copy with qemu-img

```bash
# Export a VM disk preserving sparseness over NFS
qemu-img convert \
    -f qcow2 \
    -O raw \
    -S 65536 \          # Treat regions smaller than 64KB as sparse
    --target-is-zero \   # Pre-zero assumption for NFS target
    /mnt/nfs/vms/server1.qcow2 \
    /mnt/nfs/backup/server1.raw

# Check sparse efficiency
ls -lsh /mnt/nfs/backup/server1.raw
# Shows logical vs physical size difference

# Re-sparsify an existing file using fallocate --punch-hole
# (requires server-side DEALLOCATE support via NFSv4.2)
fallocate -d /mnt/nfs/backup/server1.raw
```

## Part 5: Kerberos Security

### KDC and Service Principal Setup

```bash
# On the KDC (Key Distribution Center)
# Create service principal for the NFS server
kadmin.local -q "addprinc -randkey nfs/nfs-server.example.com@EXAMPLE.COM"
kadmin.local -q "ktadd -k /tmp/nfs-server.keytab nfs/nfs-server.example.com@EXAMPLE.COM"

# Transfer keytab to NFS server securely (never over plain text)
scp /tmp/nfs-server.keytab nfs-server.example.com:/etc/krb5.keytab
shred -u /tmp/nfs-server.keytab

# On the NFS server: set correct ownership
chown root:root /etc/krb5.keytab
chmod 0600 /etc/krb5.keytab

# Verify keytab
klist -kte /etc/krb5.keytab

# Add client principals (for each client host)
kadmin.local -q "addprinc -randkey nfs/client1.example.com@EXAMPLE.COM"
kadmin.local -q "ktadd -k /tmp/client1.keytab nfs/client1.example.com@EXAMPLE.COM"
```

### /etc/krb5.conf Configuration

```ini
# /etc/krb5.conf — deploy via Puppet/Ansible across all NFS clients and server

[libdefaults]
    default_realm = EXAMPLE.COM
    dns_lookup_realm = false
    dns_lookup_kdc = true
    ticket_lifetime = 24h
    renew_lifetime = 7d
    forwardable = true
    rdns = false
    # Require strong encryption
    default_tkt_enctypes = aes256-cts-hmac-sha1-96 aes128-cts-hmac-sha1-96
    default_tgs_enctypes = aes256-cts-hmac-sha1-96 aes128-cts-hmac-sha1-96
    permitted_enctypes = aes256-cts-hmac-sha1-96 aes128-cts-hmac-sha1-96

[realms]
    EXAMPLE.COM = {
        kdc = kdc1.example.com:88
        kdc = kdc2.example.com:88
        admin_server = kdc1.example.com:749
        default_domain = example.com
    }

[domain_realm]
    .example.com = EXAMPLE.COM
    example.com = EXAMPLE.COM

[logging]
    default = FILE:/var/log/krb5.log
    kdc = FILE:/var/log/krb5kdc.log
    admin_server = FILE:/var/log/kadmind.log
```

### gssproxy Configuration for NFS

`gssproxy` handles GSSAPI credential delegation for NFSv4 Kerberos:

```ini
# /etc/gssproxy/gssproxy.conf

[gssproxy]
    debug_level = 0

[service/nfs-client]
    mechs = krb5
    cred_store = ccache:FILE:/tmp/krb5cc_%U
    cred_store = keytab:/etc/krb5.keytab
    trusted = yes
    kernel_nfsd = yes
    euid = 0
```

```bash
# Enable and start gssproxy
systemctl enable --now gssproxy
systemctl enable --now rpc-gssd

# Verify GSSAPI is working
# On client: obtain a ticket and test mount
kinit user@EXAMPLE.COM
mount -t nfs4 -o vers=4.2,sec=krb5p \
    nfs-server.example.com:/data /mnt/data

# Verify security flavor in use
cat /proc/mounts | grep nfs | grep -o 'sec=[^,]*'
# Expected: sec=krb5p

# Check active GSSAPI contexts
rpc.gssd -v 2>&1 | tail -20
```

### Security Flavor Comparison

| Flavor | Authentication | Integrity | Privacy | Overhead |
|--------|----------------|-----------|---------|----------|
| `sys` | UID/GID (no auth) | None | None | Minimal |
| `krb5` | Kerberos | None | None | Low |
| `krb5i` | Kerberos | Per-RPC HMAC | None | Medium |
| `krb5p` | Kerberos | Per-RPC HMAC | Per-RPC encryption | High |

For production: use `krb5i` for most workloads (integrity without crypto overhead), `krb5p` only for sensitive data or compliance requirements.

### Automated Kerberos Ticket Renewal

```bash
# /etc/cron.d/krb5-renewal
# Renew NFS service tickets before expiry

SHELL=/bin/bash
PATH=/usr/sbin:/usr/bin

# Renew every 6 hours (ticket lifetime 24h, renewal 7d)
0 */6 * * * root kinit -R 2>/dev/null || kinit -kt /etc/krb5.keytab \
    nfs/$(hostname -f)@EXAMPLE.COM
```

Or use `sssd` for automatic ticket management:

```ini
# /etc/sssd/sssd.conf (relevant sections)
[sssd]
services = nss, pam, ssh
domains = EXAMPLE.COM

[domain/EXAMPLE.COM]
id_provider = ad
auth_provider = krb5
krb5_realm = EXAMPLE.COM
krb5_server = kdc1.example.com,kdc2.example.com
krb5_renewable_lifetime = 7d
krb5_lifetime = 24h
krb5_renew_interval = 3600
```

## Part 6: NFSv4 ACLs

### NFSv4 ACL Model vs POSIX

NFSv4 ACLs supersede the POSIX draft ACL model used by NFSv3 + ext4/xfs:

| Feature | POSIX ACLs | NFSv4 ACLs |
|---------|-----------|-----------|
| ACE types | Allow only | Allow, Deny, Audit, Alarm |
| Inheritance | None | Directory, file, recursive |
| Principal types | User, group, other | User, group, owner, group@, everyone@ |
| Mask | Required (confusing) | Not needed |
| Windows compat | Limited | Full |
| RFC | POSIX.1e (withdrawn) | RFC 7530/8881 |

### nfs4-acl-tools Usage

```bash
# Install nfs4-acl-tools
dnf install -y nfs4-acl-tools

# View NFSv4 ACL on a file
nfs4_getfacl /mnt/nfs/data/project1/

# Example output:
# A::OWNER@:rwaDxtTnNcCy
# A::GROUP@:rwaDxtTnNcy
# A::user:alice@example.com:rwaxtcy
# A::user:bob@example.com:rxtncy
# A:g:group:devteam@example.com:rwtxncy
# A::EVERYONE@:rxtncy

# Set a simple ACL
nfs4_setfacl -P \
    "A::user:alice@example.com:rwaDxtcy" \
    /mnt/nfs/data/project1/

# Add a deny ACE (explicit deny takes precedence over allow)
nfs4_setfacl -a "D::user:malicious@example.com:rwaDxtcy" \
    /mnt/nfs/data/project1/sensitive.conf

# Set inheritable ACL on directory
# New files/dirs inherit these ACEs
nfs4_setfacl -P \
    "A:fdi:GROUP@:rwaDxtcy" \
    /mnt/nfs/data/project1/
# f = file_inherit, d = dir_inherit, i = inherit_only
```

### ACE Permission Bits

```
Permission character → NFS4 permission bit:
r = NFS4_ACE_READ_DATA / NFS4_ACE_LIST_DIRECTORY
w = NFS4_ACE_WRITE_DATA / NFS4_ACE_ADD_FILE
a = NFS4_ACE_APPEND_DATA / NFS4_ACE_ADD_SUBDIRECTORY
x = NFS4_ACE_EXECUTE
d = NFS4_ACE_DELETE
D = NFS4_ACE_DELETE_CHILD
t = NFS4_ACE_READ_ATTRIBUTES
T = NFS4_ACE_WRITE_ATTRIBUTES
n = NFS4_ACE_READ_NAMED_ATTRS
N = NFS4_ACE_WRITE_NAMED_ATTRS
c = NFS4_ACE_READ_ACL
C = NFS4_ACE_WRITE_ACL
o = NFS4_ACE_WRITE_OWNER
y = NFS4_ACE_SYNCHRONIZE
```

### Bulk ACL Management Script

```bash
#!/bin/bash
# set-project-acls.sh — Apply standard project ACLs to NFS directories

set -euo pipefail

MOUNT_POINT="/mnt/nfs/data"
PROJECT_DIR="${1:?Usage: $0 <project-dir>}"
PROJECT_OWNER="${2:?Usage: $0 <project-dir> <owner-principal>}"
PROJECT_GROUP="${3:?Usage: $0 <project-dir> <owner-principal> <group-principal>}"

TARGET="${MOUNT_POINT}/${PROJECT_DIR}"

if [[ ! -d "$TARGET" ]]; then
    echo "ERROR: Directory does not exist: $TARGET"
    exit 1
fi

echo "Setting ACLs on $TARGET for owner=$PROJECT_OWNER group=$PROJECT_GROUP"

# Build ACL spec
ACL=$(cat << EOF
A::OWNER@:rwaDxtTnNcCy
A::GROUP@:rwaDxtTnNcy
A:fdi:user:${PROJECT_OWNER}@EXAMPLE.COM:rwaDxtTnNcCy
A:fdi:group:${PROJECT_GROUP}@EXAMPLE.COM:rwaDxtTnNcy
A::EVERYONE@:rxtncy
D::EVERYONE@:waDC
EOF
)

nfs4_setfacl -P "$ACL" "$TARGET"

# Verify
echo "ACL set successfully:"
nfs4_getfacl "$TARGET"
```

### idmapd Configuration for NFSv4 Principal Mapping

NFSv4 identifies users by name (`user@domain`), not UID. The `idmapd` daemon maps between kernel UIDs and NFSv4 principals:

```ini
# /etc/idmapd.conf

[General]
Verbosity = 0
Pipefs-Directory = /run/rpc_pipefs
Domain = example.com

[Mapping]
Nobody-User = nobody
Nobody-Group = nobody

[Translation]
# Use LDAP for name lookup (comment out to use /etc/passwd)
Method = nsswitch

[Static]
# Override specific mappings
# user@domain = local-uid
```

```bash
# Restart idmapd after config changes
systemctl restart nfs-idmapd

# Test mapping
nfsidmap -d user@example.com
nfsidmap -u 1000

# Check for mapping errors
journalctl -u nfs-idmapd -f
```

## Performance Tuning

### Read-Ahead and NFS Cache

```bash
# Increase NFS read-ahead (default 128 4K pages = 512KB)
# For large sequential reads (video, VM disks, backups)
echo 65536 > /sys/class/bdi/0:$(stat -c %d /mnt/nfs)/read_ahead_kb

# Or set via mount option (kernel 5.4+)
mount -o vers=4.2,rsize=1048576,wsize=1048576,noresvport \
    nfs-server:/data /mnt/data

# Monitor NFS cache hit rates
nfsstat -rc
# cache_hits / (cache_hits + cache_misses) = hit rate

# Per-mount stats
mountstats /mnt/data
```

### Server-Side TCP Tuning

```bash
# /etc/sysctl.d/90-nfs-server.conf

# Increase TCP buffer sizes for 10GbE/25GbE
net.core.rmem_max = 268435456
net.core.wmem_max = 268435456
net.ipv4.tcp_rmem = 4096 87380 268435456
net.ipv4.tcp_wmem = 4096 65536 268435456

# Enable TCP window scaling
net.ipv4.tcp_window_scaling = 1

# Increase connection backlog
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535

# NFS server memory limits
# Increase RPC input buffer for large compound operations
sunrpc.max_reqs = 256
sunrpc.min_reqs = 16
```

```bash
# Apply sysctl settings
sysctl --system

# Verify NFS server thread count under load
cat /proc/fs/nfsd/threads

# Adjust thread count live
echo 256 > /proc/fs/nfsd/threads
```

## Monitoring and Diagnostics

```bash
# NFS server statistics
nfsstat -s              # Server-side stats
nfsstat -c              # Client-side stats
nfsstat -n              # Include NFSv4
nfsstat -4              # NFSv4 specific

# Per-export statistics
cat /proc/net/rpc/nfsd

# Active NFS connections
ss -tnp sport = :2049

# GSSAPI debugging
rpcdebug -m rpc -s all   # Enable all RPC debug
rpcdebug -m nfs -s all   # Enable all NFS debug
# ... reproduce problem ...
rpcdebug -m rpc -c all   # Clear debug flags
rpcdebug -m nfs -c all

# Check for NFSv4 state issues
cat /proc/fs/nfsd/nfsv4clients
cat /proc/fs/nfsd/nfsv4layouts
cat /proc/fs/nfsd/nfsv4sessions
```

## Summary

NFSv4.2 brings enterprise storage capabilities that fundamentally change what's possible with NFS:

- **pNFS** enables parallel I/O across multiple storage nodes, eliminating the single-server bottleneck for bandwidth-intensive workloads.
- **Server-Side Copy** eliminates network round-trips for file duplication, making VM migrations and backup operations nearly instantaneous for data that stays on the same storage system.
- **Sparse file support** preserves holes across the wire, saving bandwidth and storage for VM disk images, database files, and container image layers.
- **Kerberos integration** with `krb5i`/`krb5p` provides cryptographic authentication and integrity protection, replacing the trivially-spoofable UID-based auth of NFSv3.
- **NFSv4 ACLs** align with enterprise access control requirements through inheritable deny/allow ACEs and named principals, replacing the POSIX draft ACL model.

The combination of these features makes NFSv4.2 a production-grade choice for enterprise storage requirements that previously required proprietary solutions.
