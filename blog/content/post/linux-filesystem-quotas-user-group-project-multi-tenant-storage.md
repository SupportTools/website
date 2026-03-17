---
title: "Linux Filesystem Quotas: User, Group, and Project Quotas for Multi-Tenant Storage"
date: 2031-02-01T00:00:00-05:00
draft: false
tags: ["Linux", "Filesystem", "Quotas", "XFS", "ext4", "Kubernetes", "Multi-Tenant", "Storage"]
categories:
- Linux
- Storage
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Linux filesystem quotas: configuring ext4 and XFS user/group/project quotas, repquota tools, Kubernetes storage limits via LimitRange and ResourceQuota, and enforcing per-namespace storage constraints."
more_link: "yes"
url: "/linux-filesystem-quotas-user-group-project-multi-tenant-storage/"
---

Multi-tenant Linux systems and Kubernetes clusters face a common challenge: a single runaway process or misconfigured application can consume all available disk space, causing cascading failures across every co-located workload. Linux filesystem quotas provide the kernel-level enforcement mechanism to prevent this. Combined with Kubernetes ResourceQuota and LimitRange objects, you can enforce storage boundaries from the block device up through the container layer.

<!--more-->

# Linux Filesystem Quotas: User, Group, and Project Quotas for Multi-Tenant Storage

## Section 1: Quota Concepts and Filesystem Support

Linux quotas operate at three scopes:

- **User quotas** — limits applied per UID across an entire filesystem
- **Group quotas** — limits applied per GID across an entire filesystem
- **Project quotas** — limits applied to a directory tree regardless of file ownership

Project quotas are the most useful for multi-tenant systems because they map naturally to tenant directories, containers, and namespaces.

### Quota Limits

Each quota has two types of limits:

- **Soft limit** — the threshold a user/group/project may temporarily exceed. Exceeding triggers the grace period timer (default: 7 days)
- **Hard limit** — the absolute maximum that cannot be exceeded under any circumstances

For block storage:
- Limits are in kilobytes (1k blocks) or expressed in K/M/G suffixes
- Inode limits restrict the number of files/directories independently of space

### Filesystem Support Matrix

| Filesystem | User Quotas | Group Quotas | Project Quotas |
|---|---|---|---|
| ext4 | Yes | Yes | Yes (kernel 4.4+) |
| XFS | Yes | Yes | Yes (native) |
| Btrfs | Via quotagroups | Via quotagroups | Via subvolumes |
| tmpfs | No | No | No |
| NFS | Server-side only | Server-side only | Server-side only |

XFS has the most mature project quota implementation and is the recommended filesystem for multi-tenant storage on enterprise Linux systems.

## Section 2: ext4 Quota Configuration

### Enabling Quotas on an ext4 Filesystem

```bash
# Check current mount options
mount | grep /data
# /dev/sdb1 on /data type ext4 (rw,relatime)

# Option 1: Enable via tune2fs (requires unmount or remount)
# Enable quota feature in the filesystem superblock
tune2fs -O quota /dev/sdb1
tune2fs -E quotatype=usrquota:grpquota:prjquota /dev/sdb1

# Verify features are set
tune2fs -l /dev/sdb1 | grep "Filesystem features"
# Filesystem features:      has_journal ext_attr resize_inode dir_index
#                           filetype extent 64bit flex_bg sparse_super
#                           large_file huge_file dir_nlink extra_isize
#                           metadata_csum quota

# Option 2: Mount with quota options in /etc/fstab
# /etc/fstab
# UUID=abc123 /data ext4 defaults,usrquota,grpquota,prjquota 0 2

# Remount to activate
mount -o remount,usrquota,grpquota,prjquota /data

# Initialize quota database files
quotacheck -cugm /data
# Creates /data/aquota.user, /data/aquota.group

# For project quotas on ext4 (requires separate project tracking files)
quotacheck -cP /data
# Creates /data/aquota.project
```

### Configuring Quota Files for Project Quotas on ext4

Project quotas require two system-wide configuration files:

```bash
# /etc/projid — maps project names to project IDs
# Format: projectname:projectid
cat /etc/projid
# tenant-alpha:100
# tenant-beta:101
# tenant-gamma:102
# ci-builds:200

# /etc/projects — maps project IDs to directory trees
# Format: projectid:directory
cat /etc/projects
# 100:/data/tenants/alpha
# 101:/data/tenants/beta
# 102:/data/tenants/gamma
# 200:/data/ci/builds

# Associate directories with project IDs
repquota -s /data   # Verify before setting limits

# Set project quota (project ID 100, soft=8G, hard=10G, inode soft=100k, hard=200k)
setquota -P 100 8388608 10485760 100000 200000 /data
# Arguments: project_id soft_kbytes hard_kbytes soft_inodes hard_inodes filesystem
```

### Enabling and Starting Quota Accounting

```bash
# Turn on quota enforcement
quotaon -ugP /data

# Verify quotas are active
quotaon --print-state /data
# /data [/dev/sdb1]: user quotas are on
# /data [/dev/sdb1]: group quotas are on
# /data [/dev/sdb1]: project quotas are on

# Check quota status via /proc
cat /proc/mounts | grep /data
# /dev/sdb1 /data ext4 rw,relatime,quota,usrquota,grpquota 0 0
```

### Setting User and Group Quotas on ext4

```bash
# Set quota for a specific user (uid=1001, user=appuser)
# edquota opens $EDITOR with the quota record — suitable for interactive use
edquota -u appuser

# Non-interactive: setquota for scripting
# setquota username soft_blocks hard_blocks soft_inodes hard_inodes filesystem
setquota -u appuser 5242880 10485760 50000 100000 /data
# 5GB soft, 10GB hard, 50k soft inodes, 100k hard inodes

# Set quota for a group
setquota -g developers 52428800 104857600 500000 1000000 /data
# 50GB soft, 100GB hard for the developers group

# Copy quota settings from one user to another
edquota -p templateuser newuser1 newuser2 newuser3

# Set grace periods (7 days = 604800 seconds)
edquota -t   # Interactive
setquota -t 604800 604800 /data  # 7 days for block and inode grace
```

## Section 3: XFS Quota Configuration

XFS is the preferred filesystem for enterprise quota management due to its native project quota support and superior performance under quota-enabled workloads.

### XFS Mount Options

```bash
# /etc/fstab for XFS with all quota types
# UUID=def456 /data xfs defaults,uquota,gquota,pquota 0 2
# Note: pquota enables project quotas and implies prjquota

# Mount option aliases:
# uquota or usrquota — user quotas
# gquota or grpquota — group quotas
# pquota or prjquota — project quotas (prjquota is enforcing, pquota also enables accounting)

# Verify quotas are enabled after mount
xfs_quota -x -c "state" /data
# User quota state on /data (/dev/sdc1)
#   Accounting: ON
#   Enforcement: ON
#   Inode: #131 (2 blocks, 2 extents)
# Group quota state on /data (/dev/sdc1)
#   Accounting: ON
#   Enforcement: ON
#   Inode: #132 (2 blocks, 2 extents)
# Project quota state on /data (/dev/sdc1)
#   Accounting: ON
#   Enforcement: ON
#   Inode: #133 (2 blocks, 2 extents)
```

### XFS Project Quota Management

```bash
# Create project directory structure
mkdir -p /data/tenants/{alpha,beta,gamma}
mkdir -p /data/ci/builds

# Set up /etc/projects and /etc/projid
cat > /etc/projects <<EOF
100:/data/tenants/alpha
101:/data/tenants/beta
102:/data/tenants/gamma
200:/data/ci/builds
EOF

cat > /etc/projid <<EOF
alpha:100
beta:101
gamma:102
ci-builds:200
EOF

# Initialize project IDs on the filesystem
xfs_quota -x -c "project -s alpha" /data
xfs_quota -x -c "project -s beta" /data
xfs_quota -x -c "project -s gamma" /data
xfs_quota -x -c "project -s ci-builds" /data

# Verify project setup
xfs_quota -x -c "project -c alpha" /data
# Setting up project alpha (id=100)
# Checking project alpha (id=100)
# Inode 524288 (/data/tenants/alpha) is part of project 100

# Set XFS project quotas
# xfs_quota -x -c "limit [-u|-g|-p] bsoft=N bhard=N isoft=N ihard=N <name>" <mount>
xfs_quota -x -c "limit -p bsoft=8g bhard=10g isoft=100k ihard=200k alpha" /data
xfs_quota -x -c "limit -p bsoft=8g bhard=10g isoft=100k ihard=200k beta" /data
xfs_quota -x -c "limit -p bsoft=50g bhard=60g isoft=500k ihard=1000k gamma" /data
xfs_quota -x -c "limit -p bsoft=20g bhard=25g isoft=200k ihard=500k ci-builds" /data

# Set grace period for XFS
xfs_quota -x -c "timer -p 7days" /data
```

### Bulk XFS Quota Configuration Script

```bash
#!/bin/bash
# configure-xfs-project-quotas.sh

set -euo pipefail

FILESYSTEM="/data"
PROJECTS_FILE="/etc/projects"
PROJID_FILE="/etc/projid"

# Quota definitions: "project_name:project_id:soft_gb:hard_gb:soft_k_inodes:hard_k_inodes:path"
QUOTA_CONFIG=(
    "alpha:100:8:10:100:200:/data/tenants/alpha"
    "beta:101:8:10:100:200:/data/tenants/beta"
    "gamma:102:50:60:500:1000:/data/tenants/gamma"
    "ci-builds:200:20:25:200:500:/data/ci/builds"
    "logging:300:100:120:1000:2000:/data/logs"
)

# Generate config files
> "$PROJECTS_FILE"
> "$PROJID_FILE"

for entry in "${QUOTA_CONFIG[@]}"; do
    IFS=':' read -r name id soft_gb hard_gb soft_k_inodes hard_k_inodes path <<< "$entry"

    # Create directory if it doesn't exist
    mkdir -p "$path"

    # Append to config files
    echo "${id}:${path}" >> "$PROJECTS_FILE"
    echo "${name}:${id}" >> "$PROJID_FILE"

    echo "Configured project: ${name} (id=${id}) -> ${path}"
done

# Initialize all projects on the filesystem
echo "Initializing projects on ${FILESYSTEM}..."
while IFS=':' read -r name id; do
    xfs_quota -x -c "project -s ${name}" "$FILESYSTEM" 2>/dev/null || true
done < "$PROJID_FILE"

# Apply quota limits
echo "Applying quota limits..."
for entry in "${QUOTA_CONFIG[@]}"; do
    IFS=':' read -r name id soft_gb hard_gb soft_k_inodes hard_k_inodes path <<< "$entry"

    soft_blocks="${soft_gb}g"
    hard_blocks="${hard_gb}g"
    soft_inodes="${soft_k_inodes}k"
    hard_inodes="${hard_k_inodes}k"

    xfs_quota -x -c \
        "limit -p bsoft=${soft_blocks} bhard=${hard_blocks} isoft=${soft_inodes} ihard=${hard_inodes} ${name}" \
        "$FILESYSTEM"

    echo "Applied: ${name} -> blocks: ${soft_blocks}/${hard_blocks}, inodes: ${soft_inodes}/${hard_inodes}"
done

echo "Done. Verifying quota report..."
xfs_quota -x -c "report -p -h" "$FILESYSTEM"
```

## Section 4: Quota Reporting Tools

### repquota — Filesystem Quota Summary

```bash
# Show user quotas for /data
repquota -u /data
# *** Report for user quotas on device /dev/sdb1
# Block grace time: 7days; Inode grace time: 7days
#                         Block limits               File limits
# User            used    soft    hard  grace    used  soft  hard  grace
# ----------------------------------------------------------------------
# root      --   4096       0       0          1000     0     0
# appuser   +-  9663488 8388608 10485760  6days  45000 50000 100000
# devops    --   102400       0       0             500     0     0

# Show group quotas
repquota -g /data

# Show project quotas
repquota -P /data

# Human-readable output (-s flag)
repquota -s /data
# User            used   soft   hard  grace    used  soft  hard  grace
# appuser   +-   9.2G   8.0G  10.0G  6days   45.0k 50.0k  100k

# All quota types in one report
repquota -augP /data
```

### xfs_quota Report Commands

```bash
# Interactive XFS quota reporting
xfs_quota -c "report -h" /data

# Project quota report with human-readable sizes
xfs_quota -c "report -p -h" /data
# Project quota on /data (/dev/sdc1)
#                         Blocks
# Project ID   Used   Soft   Hard Warn/Grace
# ----------- ----------------------------------
# #100       7.2G    8G    10G  00 [--------]
# #101       8.9G    8G    10G  00 [6 days  ]
# #102      45.1G   50G    60G  00 [--------]

# Quota statistics for a specific project
xfs_quota -c "quota -p alpha" /data

# Batch reporting with field-separated output for parsing
xfs_quota -x -c "report -p -N" /data | \
  awk 'NR>1 {printf "project=%s used=%s soft=%s hard=%s\n", $1,$2,$3,$4}'
```

### Monitoring Quota Usage with a Cron Job

```bash
#!/bin/bash
# /usr/local/bin/quota-monitor.sh
# Run via cron: */5 * * * * /usr/local/bin/quota-monitor.sh

set -euo pipefail

FILESYSTEM="/data"
ALERT_THRESHOLD=90  # Alert when usage > 90% of hard limit
PROM_PUSHGATEWAY="${PROM_PUSHGATEWAY:-http://pushgateway.monitoring.svc:9091}"

push_metric() {
    local project=$1
    local used_bytes=$2
    local hard_bytes=$3
    local pct=$4

    cat <<EOF | curl --silent --data-binary @- "${PROM_PUSHGATEWAY}/metrics/job/quota_monitor"
# HELP filesystem_quota_used_bytes Filesystem quota used bytes by project
# TYPE filesystem_quota_used_bytes gauge
filesystem_quota_used_bytes{project="${project}",filesystem="${FILESYSTEM}"} ${used_bytes}
# HELP filesystem_quota_hard_bytes Filesystem quota hard limit bytes by project
# TYPE filesystem_quota_hard_bytes gauge
filesystem_quota_hard_bytes{project="${project}",filesystem="${FILESYSTEM}"} ${hard_bytes}
# HELP filesystem_quota_usage_percent Filesystem quota usage percentage by project
# TYPE filesystem_quota_usage_percent gauge
filesystem_quota_usage_percent{project="${project}",filesystem="${FILESYSTEM}"} ${pct}
EOF
}

# Parse xfs_quota report
xfs_quota -x -c "report -p -N" "$FILESYSTEM" | \
while read -r project_id used_1k soft_1k hard_1k warns grace_time; do
    # Skip header and zero-limit entries
    [[ "$project_id" =~ ^# ]] || continue
    [[ "$hard_1k" == "0" ]] && continue

    project_name=$(grep ":${project_id#\#}$" /etc/projid | cut -d: -f1)
    [[ -z "$project_name" ]] && project_name="project_${project_id#\#}"

    used_bytes=$((used_1k * 1024))
    hard_bytes=$((hard_1k * 1024))
    pct=0
    [[ "$hard_bytes" -gt 0 ]] && pct=$(( (used_bytes * 100) / hard_bytes ))

    push_metric "$project_name" "$used_bytes" "$hard_bytes" "$pct"

    if [[ "$pct" -ge "$ALERT_THRESHOLD" ]]; then
        echo "ALERT: Project ${project_name} at ${pct}% quota utilization (${used_1k}K / ${hard_1k}K)" >&2
        logger -t quota-monitor "QUOTA ALERT: ${project_name} ${pct}% full (${used_1k}K/${hard_1k}K)"
    fi
done
```

## Section 5: Kubernetes Storage Quotas via ResourceQuota

Kubernetes ResourceQuota enforces storage limits at the namespace level, complementing filesystem-level quotas.

### ResourceQuota for Storage

```yaml
# resourcequota-production.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: storage-quota
  namespace: production
spec:
  hard:
    # Total persistent storage claimed in this namespace
    requests.storage: "500Gi"

    # Limit by StorageClass
    gold.storageclass.storage.k8s.io/requests.storage: "100Gi"
    silver.storageclass.storage.k8s.io/requests.storage: "200Gi"
    bronze.storageclass.storage.k8s.io/requests.storage: "200Gi"

    # Limit number of PVCs
    persistentvolumeclaims: "20"
    gold.storageclass.storage.k8s.io/persistentvolumeclaims: "5"

    # CPU and memory (include for completeness)
    requests.cpu: "20"
    requests.memory: "40Gi"
    limits.cpu: "40"
    limits.memory: "80Gi"

    # Object count limits
    pods: "100"
    services: "20"
    secrets: "50"
    configmaps: "50"
```

### LimitRange for Default PVC Sizes

```yaml
# limitrange-storage.yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: storage-limits
  namespace: production
spec:
  limits:
    # Per-PVC limits
    - type: PersistentVolumeClaim
      max:
        storage: "50Gi"     # Maximum single PVC size
      min:
        storage: "1Gi"      # Minimum single PVC size
      default:
        storage: "5Gi"      # Default if no request specified
      defaultRequest:
        storage: "5Gi"

    # Per-container resource limits
    - type: Container
      max:
        cpu: "4"
        memory: "8Gi"
      min:
        cpu: "50m"
        memory: "64Mi"
      default:
        cpu: "500m"
        memory: "512Mi"
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
```

### Namespace-per-Tenant Storage Isolation

```yaml
# Full tenant namespace setup
---
apiVersion: v1
kind: Namespace
metadata:
  name: tenant-alpha
  labels:
    tenant: alpha
    environment: production
    quota-tier: standard

---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tenant-storage-quota
  namespace: tenant-alpha
spec:
  hard:
    requests.storage: "50Gi"
    persistentvolumeclaims: "10"
    pods: "50"
    requests.cpu: "10"
    requests.memory: "20Gi"
    limits.cpu: "20"
    limits.memory: "40Gi"

---
apiVersion: v1
kind: LimitRange
metadata:
  name: tenant-default-limits
  namespace: tenant-alpha
spec:
  limits:
    - type: PersistentVolumeClaim
      max:
        storage: "10Gi"
      min:
        storage: "100Mi"
    - type: Container
      default:
        cpu: "200m"
        memory: "256Mi"
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
      max:
        cpu: "2"
        memory: "4Gi"
```

### Enforcing Storage Quotas with Admission Webhooks

For more fine-grained control than ResourceQuota provides, use an OPA Gatekeeper constraint:

```yaml
# constraint-template: max-pvc-size-by-tier
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8spvcsizeconstraint
spec:
  crd:
    spec:
      names:
        kind: K8sPVCSizeConstraint
      validation:
        openAPIV3Schema:
          type: object
          properties:
            maxSize:
              type: string
              description: "Maximum PVC size (e.g. 10Gi)"
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8spvcsizeconstraint

        import future.keywords.if

        violation[{"msg": msg}] if {
          input.review.kind.kind == "PersistentVolumeClaim"
          request := input.review.object.spec.resources.requests.storage
          max := input.parameters.maxSize

          request_bytes := parse_bytes(request)
          max_bytes := parse_bytes(max)

          request_bytes > max_bytes

          msg := sprintf("PVC storage request %v exceeds maximum allowed %v", [request, max])
        }

        parse_bytes(s) := bytes if {
          endswith(s, "Gi")
          n := to_number(trim_suffix(s, "Gi"))
          bytes := n * 1024 * 1024 * 1024
        }

        parse_bytes(s) := bytes if {
          endswith(s, "Mi")
          n := to_number(trim_suffix(s, "Mi"))
          bytes := n * 1024 * 1024
        }

        parse_bytes(s) := bytes if {
          endswith(s, "Ti")
          n := to_number(trim_suffix(s, "Ti"))
          bytes := n * 1024 * 1024 * 1024 * 1024
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sPVCSizeConstraint
metadata:
  name: pvc-max-size-standard-tier
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["PersistentVolumeClaim"]
    namespaceSelector:
      matchLabels:
        quota-tier: standard
  parameters:
    maxSize: "10Gi"
```

## Section 6: Container Storage Quotas via ephemeral-storage

Kubernetes allows setting ephemeral storage limits on containers, which applies to the container's writable layer, logs, and emptyDir volumes:

```yaml
# pod with ephemeral storage limits
apiVersion: v1
kind: Pod
metadata:
  name: quota-aware-pod
  namespace: production
spec:
  containers:
    - name: app
      image: myapp:latest
      resources:
        requests:
          ephemeral-storage: "1Gi"
        limits:
          ephemeral-storage: "5Gi"
          cpu: "500m"
          memory: "512Mi"
  # emptyDir with size limit
  volumes:
    - name: scratch
      emptyDir:
        sizeLimit: 2Gi  # Enforced by kubelet
```

### ResourceQuota for Ephemeral Storage

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: ephemeral-storage-quota
  namespace: production
spec:
  hard:
    requests.ephemeral-storage: "100Gi"
    limits.ephemeral-storage: "200Gi"
```

## Section 7: XFS Quota Integration with Kubernetes Local Storage

When using Kubernetes local persistent volumes backed by XFS, you can leverage XFS project quotas for per-volume enforcement:

### Local Volume Provisioner with XFS Project Quotas

```yaml
# local-storage-storageclass.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-xfs
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
```

```bash
# Pre-provision script: create XFS project quota directories for local PVs
#!/bin/bash
# provision-local-pv.sh

set -euo pipefail

NODE_STORAGE_ROOT="/mnt/disks"
NEXT_PROJECT_ID=1000

provision_volume() {
    local volume_name=$1
    local size_gb=$2

    local volume_path="${NODE_STORAGE_ROOT}/${volume_name}"
    local project_id=$((NEXT_PROJECT_ID++))

    # Create directory
    mkdir -p "$volume_path"

    # Register project
    echo "${project_id}:${volume_path}" >> /etc/projects
    echo "${volume_name}:${project_id}" >> /etc/projid

    # Initialize and set quota
    xfs_quota -x -c "project -s ${volume_name}" /mnt/disks
    xfs_quota -x -c "limit -p bhard=${size_gb}g ihard=100k ${volume_name}" /mnt/disks

    echo "Provisioned ${volume_path} with ${size_gb}G project quota (id=${project_id})"
}

# Usage
provision_volume "pv-tenant-alpha-01" 10
provision_volume "pv-tenant-beta-01" 10
provision_volume "pv-ci-builds-01" 25
```

```yaml
# Corresponding PersistentVolume
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-tenant-alpha-01
spec:
  capacity:
    storage: 10Gi
  accessModes: [ReadWriteOnce]
  persistentVolumeReclaimPolicy: Delete
  storageClassName: local-xfs
  local:
    path: /mnt/disks/pv-tenant-alpha-01
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values: [node-01]
```

## Section 8: Quota Automation and Self-Service

### Quota Request Workflow with Annotations

```yaml
# quota-request-configmap.yaml — tenant quota request system
apiVersion: v1
kind: ConfigMap
metadata:
  name: quota-request
  namespace: tenant-alpha
  annotations:
    # Operators read these and apply quota adjustments
    quota.company.com/requested-storage: "100Gi"
    quota.company.com/requested-pods: "100"
    quota.company.com/justification: "Q2 2031 capacity expansion for new service deployment"
    quota.company.com/requested-by: "platform-team@company.com"
    quota.company.com/approved-by: ""    # Operator fills this in
    quota.company.com/ticket: "INFRA-4521"
```

### Automated Quota Reporting Script

```bash
#!/bin/bash
# k8s-quota-report.sh — generate namespace storage usage report

set -euo pipefail

OUTPUT_FORMAT="${1:-table}"

echo "=== Kubernetes Namespace Storage Quota Report ==="
echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

case "$OUTPUT_FORMAT" in
  json)
    kubectl get resourcequota --all-namespaces -o json | \
      jq '[.items[] | {
        namespace: .metadata.namespace,
        name: .metadata.name,
        storage: {
          requested: (.spec.hard["requests.storage"] // "unlimited"),
          used: (.status.used["requests.storage"] // "0"),
          pvcs_hard: (.spec.hard.persistentvolumeclaims // "unlimited"),
          pvcs_used: (.status.used.persistentvolumeclaims // "0")
        },
        compute: {
          cpu_hard: (.spec.hard["requests.cpu"] // "unlimited"),
          cpu_used: (.status.used["requests.cpu"] // "0"),
          memory_hard: (.spec.hard["requests.memory"] // "unlimited"),
          memory_used: (.status.used["requests.memory"] // "0")
        }
      }]'
    ;;
  table)
    printf "%-30s %-15s %-15s %-8s %-8s\n" \
      "NAMESPACE" "STORAGE_USED" "STORAGE_LIMIT" "PVCS" "PVCS_MAX"
    printf "%-30s %-15s %-15s %-8s %-8s\n" \
      "---" "---" "---" "---" "---"

    kubectl get resourcequota --all-namespaces -o json | \
      jq -r '.items[] | [
        .metadata.namespace,
        (.status.used["requests.storage"] // "0"),
        (.spec.hard["requests.storage"] // "unlimited"),
        (.status.used.persistentvolumeclaims // "0"),
        (.spec.hard.persistentvolumeclaims // "unlimited")
      ] | @tsv' | \
      sort | \
      while IFS=$'\t' read -r ns storage_used storage_hard pvcs pvcs_max; do
        printf "%-30s %-15s %-15s %-8s %-8s\n" \
          "$ns" "$storage_used" "$storage_hard" "$pvcs" "$pvcs_max"
      done
    ;;
esac
```

## Section 9: Troubleshooting Quota Issues

### Disk Full Despite Quota Not Reached

```bash
# Scenario: writes failing with "No space left on device" but quota shows capacity

# Check actual filesystem usage vs quota database
df -h /data
# /dev/sdc1 100G 95G 5G 95% /data

# The filesystem itself is full — quotas only restrict per-tenant, not total capacity
# Solution: quota sum must be less than total filesystem capacity

# Audit total allocated quota vs filesystem size
xfs_quota -x -c "report -p -N" /data | \
  awk 'NR>1 && $4 > 0 {sum += $4} END {printf "Total hard limit: %dG\n", sum/1024/1024}'

# Check for files outside project quota directories
du -sh /data/*
# Large directories not covered by project quotas contribute to filesystem fill
```

### Grace Period Confusion

```bash
# User at soft limit, hitting grace period warnings
# Check grace period expiry
repquota -u /data | grep -v "^#" | awk '$3 > 0 && $3 < $4 {print $1, "over soft limit"}'

# Reset grace period for a user (after they've cleaned up)
edquota -T appuser  # Opens interactive editor to reset timer
# Or programmatically
setquota -T appuser 0 0 /data  # Reset timers to 0 (restarts grace period)
```

### Quota Database Corruption Recovery

```bash
# Symptoms: quotacheck errors, repquota shows inconsistent data

# Unmount filesystem (or use -F flag for forced check on live FS)
umount /data

# Rebuild quota database from scratch
quotacheck -uvgmf /data    # -f forces rebuild even if quota files exist

# For XFS, quota data is stored in the filesystem metadata, not separate files
# Repair with xfs_repair (requires unmount)
xfs_repair /dev/sdc1

# Remount and verify
mount /data
repquota -P /data
```

### Kubernetes PVC Stuck in Pending Due to Storage Quota

```bash
# Symptom: PVC stuck in Pending with quota exceeded message
kubectl describe pvc my-pvc -n production
# Events:
#   Warning  ProvisioningFailed  ...  exceeded quota: storage-quota,
#            requested: requests.storage=20Gi,
#            used: requests.storage=490Gi,
#            limited: requests.storage=500Gi

# Check current usage
kubectl describe resourcequota storage-quota -n production

# Temporary: increase quota limit
kubectl patch resourcequota storage-quota -n production \
  --type='json' \
  -p='[{"op":"replace","path":"/spec/hard/requests.storage","value":"600Gi"}]'

# Long-term: clean up unused PVCs
kubectl get pvc -n production | grep Terminating
kubectl get pvc -n production -o json | \
  jq -r '.items[] | select(.status.phase == "Bound") |
  "\(.metadata.name) \(.spec.resources.requests.storage)"' | \
  sort -k2 -h
```

## Section 10: Quota Enforcement Matrix

A reference table for which quota mechanism to use in each scenario:

| Scenario | Mechanism |
|---|---|
| Limit individual Linux user disk usage | User quota (ext4/XFS) |
| Limit team/department shared storage | Group quota (ext4/XFS) |
| Limit a directory tree (tenant dir) | Project quota (XFS preferred) |
| Limit container writable layer | `limits.ephemeral-storage` |
| Limit total namespace storage | `ResourceQuota.requests.storage` |
| Limit individual PVC size | `LimitRange` + Gatekeeper |
| Limit PVC count per namespace | `ResourceQuota.persistentvolumeclaims` |
| Enforce minimum PVC size | `LimitRange.min.storage` |
| Limit per-StorageClass allocation | `ResourceQuota.<sc>.requests.storage` |

Combining kernel-level project quotas on the underlying filesystem with Kubernetes ResourceQuota and LimitRange creates defense-in-depth storage governance that protects against both accidental misuse and deliberate resource exhaustion in multi-tenant environments.
